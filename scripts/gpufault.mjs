#!/usr/bin/env node
// Forces each WebGPU failure path and checks the game ends up running on WebGL2 (build first).
//
//   node scripts/gpufault.mjs [--faults none,init,probe,shader,validation,lost] [--out shots/fault]
//                             [--params "autostart=1&seed=1&autopilot=1&mute=1"] [--auto]
//
// Each case runs in a fresh browser (SwiftShader WebGPU flags) with `window.__waymanGpuFault` set
// before boot (see src/view/gpuFallback.ts), waits for the game (across the fallback reload, if
// any), advances 2 s, screenshots, and prints the backend, the fallback reason and the stored flag.
// The URL carries renderer=webgpu (the opt-in path; the fallback reload drops it). --auto leaves the
// choice to the game instead (WebGL2 by default, so only the 'none' case is then meaningful).
// Exits non-zero when a case does not end on the expected backend or has page errors.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'];

const args = { faults: 'none,init,probe,shader,validation,lost', out: 'shots/fault', params: 'autostart=1&seed=1&autopilot=1&mute=1', explicit: true };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  if (k === 'auto') args.explicit = false;
  else if (k in args) args[k] = argv[++i];
  else throw new Error(`unknown option --${k}`);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const dist = join(ROOT, 'dist');
const server = createServer((req, res) => {
  let file = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
mkdirSync(args.out, { recursive: true });

const results = [];
let failed = false;
for (const fault of args.faults.split(',')) {
  const browser = await chromium.launch({ args: WEBGPU_FLAGS });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const r = { fault, navigations: 0, warnings: [], pageErrors: [] };
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') r.warnings.push(`${m.type()}: ${m.text().split('\n')[0].slice(0, 200)}`); });
  page.on('pageerror', (e) => r.pageErrors.push(e.message));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) r.navigations++; });
  if (fault !== 'none') await page.addInitScript((f) => { window.__waymanGpuFault = f; }, fault);
  try {
    await page.goto(`${base}?${args.params}${args.explicit ? '&renderer=webgpu' : ''}`);
    // The fallback reloads the page: poll until a game exists and has stayed put for a moment.
    const t0 = Date.now();
    let stable = 0;
    while (Date.now() - t0 < 180000) {
      let ok = false;
      try {
        ok = await page.evaluate(async () => {
          if (!window.__wayman?.game) return false;
          await window.__wayman.ready;
          return true;
        });
      } catch { ok = false; } // context destroyed by the reload
      stable = ok ? stable + 1 : 0;
      if (stable >= 3) break;
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => { window.__wayman.game.stage.app.ticker.stop(); window.__wayman.advance(2); });
    Object.assign(r, await page.evaluate(() => {
      const st = window.__wayman.game.stage;
      let session = null, persistent = null;
      try { session = sessionStorage.getItem('wayman.webgpu.failed'); persistent = localStorage.getItem('wayman.webgpu.failed'); } catch { /* ignore */ }
      return { backend: st.backend, fallbackReason: st.fallbackReason, url: location.search, session, persistent, s: +window.__wayman.state().player.s.toFixed(1), hookErrors: window.__wayman.errors.slice() };
    }));
    r.shot = join(args.out, `fault-${fault}${args.explicit ? '' : '-auto'}.png`);
    // Read the canvas back in the same task as a render: under these Chromium flags a WebGL page
    // never completes a compositor screenshot (sandbox artefact; plain WebGL launches are fine).
    const png = await page.evaluate(() => {
      const st = window.__wayman.game.stage;
      st.render();
      return st.app.canvas.toDataURL('image/png');
    });
    writeFileSync(r.shot, Buffer.from(png.split(',')[1], 'base64'));
  } catch (e) {
    r.error = String(e && e.message || e).split('\n')[0];
  }
  r.expected = fault === 'none' && args.explicit ? 'webgpu' : 'webgl';
  r.ok = !r.error && r.backend === r.expected && !r.pageErrors.length && !(r.hookErrors?.length);
  if (!r.ok) failed = true;
  r.warnings = r.warnings.slice(0, 6);
  results.push(r);
  await browser.close();
}
server.close();
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
