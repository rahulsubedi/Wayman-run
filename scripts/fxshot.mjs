#!/usr/bin/env node
// Ad-hoc visual checks for lighting / camera / effects (build first: `npm run build`).
//
//   node scripts/fxshot.mjs --params "autostart=1&seed=1&mute=1" [--width 1280 --height 720] [--hideui]
//        --steps "js:game.stage.app.ticker.stop() | advance:2 |
//                 js:game.fx.onEvent({type:'pickup',kind:'boost'}, game.sim.state) |
//                 advance:0.1 | shot:shots/fx/boost.png"
//
// Steps are separated by `|`:  advance:<seconds> (debug fast-forward, renders one frame),
// js:<code> or jsfile:<path.js> (runs in the page with `game` = window.__wayman.game, then
// renders one frame), shot:<file.png>.  Stop the ticker first for frame-exact effect captures.
// --webgpu launches Chromium with the SwiftShader WebGPU flags and adds renderer=webgpu; the active
// backend is printed (`backend -> ...`). Exits non-zero on page/console errors.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = { params: '', width: 1280, height: 720, hideui: false, webgpu: false, steps: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  if (k === 'hideui') args.hideui = true;
  else if (k === 'webgpu') args.webgpu = true;
  else args[k] = typeof args[k] === 'number' ? Number(argv[++i]) : argv[++i];
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
const query = [args.params, args.webgpu && !/(^|&)renderer=/.test(args.params) ? 'renderer=webgpu' : ''].filter(Boolean).join('&');
const url = `http://127.0.0.1:${server.address().port}/?${query}`;
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'];

const browser = await chromium.launch(args.webgpu ? { args: WEBGPU_FLAGS } : undefined);
const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.stack || e.message}`));
let failed = false;
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.__wayman.ready);
  console.log('backend ->', await page.evaluate(() => window.__wayman.game?.stage?.backend ?? 'unknown'));
  if (args.hideui) await page.addStyleTag({ content: '#ui{display:none!important}' });
  for (const raw of args.steps.split('|').map((s) => s.trim()).filter(Boolean)) {
    const i = raw.indexOf(':');
    const op = raw.slice(0, i), val = raw.slice(i + 1);
    if (op === 'advance') await page.evaluate((s) => window.__wayman.advance(Number(s)), val);
    else if (op === 'js' || op === 'jsfile') {
      const src = op === 'js' ? val : readFileSync(val, 'utf8');
      const r = await page.evaluate((code) => {
        const game = window.__wayman.game; // eslint-disable-line no-unused-vars
        const out = eval(code);
        game.stage.render();
        return out === undefined ? null : JSON.stringify(out);
      }, src);
      if (r !== null) console.log('result ->', r);
    } else if (op === 'shot') {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      mkdirSync(dirname(resolve(val)), { recursive: true });
      await page.screenshot({ path: val });
      const st = await page.evaluate(() => { const s = window.__wayman.state(); return { t: +s.time.toFixed(2), s: +s.player.s.toFixed(1), y: +s.player.y.toFixed(2), action: s.player.action, zone: s.zone, blend: +s.zoneBlend.toFixed(2), over: s.over }; });
      console.log('shot', val, JSON.stringify(st));
    } else throw new Error(`unknown step ${op}`);
  }
  const hook = await page.evaluate(() => window.__wayman.errors.slice());
  errors.push(...hook);
} catch (e) {
  failed = true;
  console.error(e);
}
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
await browser.close();
server.close();
process.exit(failed || errors.some((e) => !e.startsWith('warning')) ? 1 : 0);
