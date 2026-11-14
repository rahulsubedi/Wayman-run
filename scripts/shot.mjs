#!/usr/bin/env node
// Playwright screenshot / boot-check utility for Wayman Run.
//
// Usage (build first: `npm run build`):
//   node scripts/shot.mjs [options]
//
//   --out <file.png>        screenshot path (default shots/shot.png)
//   --params "<query>"      URL query, e.g. "autostart=1&seed=1&autopilot=1&mute=1"
//   --advance <seconds>     call __wayman.advance(seconds) before the screenshot
//   --seq "<s>=<file>,..."  several shots in ONE page: advance s seconds (cumulative), shoot file,
//                           e.g. --seq "5=shots/a.png,25=shots/b.png"
//   --url <base>            use a running server (e.g. http://localhost:4173/ from `npm run preview`);
//                           default: serve ./dist with a built-in static server on a free port
//   --width <px> --height <px>   viewport (default 1280x720)
//   --renderer webgl|webgpu       adds renderer=... to the query (default: let the game choose)
//   --webgpu                launch Chromium with the SwiftShader WebGPU flags and add renderer=webgpu
//                           (the summary's `backend` field shows what the game actually runs on)
//   --timeout <ms>          wait for __wayman.ready (default 60000)
//
// Prints a JSON summary (sim state after each shot) and every console error / page error.
// Exits non-zero on page errors, console errors, entries in __wayman.errors, or a boot timeout.
// Software WebGL here renders ~100 ms/frame: never wait for real-time play, use --advance.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Headless WebGPU here needs ALL of these (a subset crashes the page or yields no adapter).
export const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'];

function parseArgs(argv) {
  const o = { out: 'shots/shot.png', params: '', advance: 0, seq: '', url: '', width: 1280, height: 720, renderer: '', timeout: 60000, webgpu: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'webgpu') { o.webgpu = true; if (!o.renderer) o.renderer = 'webgpu'; continue; }
    const v = argv[i + 1];
    if (!(k in o)) throw new Error(`unknown option --${k}`);
    o[k] = typeof o[k] === 'number' ? Number(v) : v;
    i++;
  }
  return o;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

function serveDist() {
  const dist = join(ROOT, 'dist');
  if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ not found: run `npm run build` first');
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(dist, path));
    if (!file.startsWith(dist)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let server = null;
  let base = o.url;
  if (!base) ({ server, url: base } = await serveDist());

  const query = [o.params, o.renderer ? `renderer=${o.renderer}` : ''].filter(Boolean).join('&');
  const url = base + (query ? `?${query}` : '');
  const shots = o.seq
    ? o.seq.split(',').map((p) => { const [s, f] = p.split('='); return { advance: Number(s), out: f }; })
    : [{ advance: o.advance, out: o.out }];

  const browser = await chromium.launch(o.webgpu ? { args: WEBGPU_FLAGS } : undefined);
  const page = await browser.newPage({ viewport: { width: o.width, height: o.height } });
  const consoleErrors = [];
  const pageErrors = [];
  const consoleWarnings = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    else if (m.type() === 'warning') consoleWarnings.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.stack || e.message));

  const summary = { url, shots: [] };
  let failed = false;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: o.timeout });
    await page.evaluate(() => window.__wayman.ready);
    summary.backend = await page.evaluate(() => {
      const st = window.__wayman.game?.stage;
      return st ? st.backend : document.querySelector('canvas') ? 'unknown' : 'no-canvas';
    });
    if (o.renderer && summary.backend !== o.renderer) summary.backendMismatch = `asked for ${o.renderer}, running ${summary.backend}`;
    for (const shot of shots) {
      const t0 = Date.now();
      if (shot.advance > 0) await page.evaluate((s) => window.__wayman.advance(s), shot.advance);
      // Two animation frames so the DOM overlay and the canvas are both up to date.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      mkdirSync(dirname(resolve(shot.out)), { recursive: true });
      await page.screenshot({ path: shot.out });
      const st = await page.evaluate(() => {
        const s = window.__wayman.state();
        return { time: +s.time.toFixed(2), s: +s.player.s.toFixed(1), x: s.player.x, lane: s.player.lane, action: s.player.action,
          score: s.score, coins: s.coins, zone: s.zone, zoneBlend: +s.zoneBlend.toFixed(2), entities: s.entities.length, over: s.over };
      });
      summary.shots.push({ out: shot.out, advanced: shot.advance, ms: Date.now() - t0, state: st });
    }
    summary.hookErrors = await page.evaluate(() => window.__wayman.errors.slice());
  } catch (e) {
    failed = true;
    summary.error = String(e && e.stack || e);
    try { await page.screenshot({ path: shots[0].out }); } catch { /* ignore */ }
  }
  summary.consoleErrors = consoleErrors;
  if (consoleWarnings.length) summary.consoleWarnings = consoleWarnings;
  summary.pageErrors = pageErrors;
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  server?.close();
  if (failed || pageErrors.length || consoleErrors.length || summary.hookErrors?.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
