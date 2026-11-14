#!/usr/bin/env node
// Art-review capture: frame-exact screenshots of the real game plus whole-frame GPU cost
// (draw calls and triangles counted by wrapping the WebGL2 draw entry points, shadow pass included).
// Build first: `npm run build`.
//
//   node scripts/artshot.mjs --out shots/art --params "seed=3&quality=high" [--width 1280 --height 720]
//        --steps "to:120 | shot:market-120 | to:480 | shot:tr-480 | stumble | tick:0.4 | shot:drone"
//
// The game is started with autostart+autopilot+mute and the real-time ticker is stopped; the run is
// then stepped at 30 Hz. Steps (separated by `|`):
//   to:<s>        tick until the player has run s metres (stops early on game over)
//   tick:<sec>    tick this many seconds
//   js:<code> | jsfile:<path>  eval in the page (`game`, `w` = window.__wayman); result is printed
//   stumble | boost | magnet | multiplier | shield   force the state / power-up
//   zone:<0..2|n> force the visual zone (n = follow the run)
//   quality:<low|medium|high>
//   shot:<name>   render one frame, count its draws, write <out>/<name>.png, print a JSON line
// Prints one JSON line per shot: {name, s, zone, blend, calls, tris, action}. Exits non-zero on
// page errors.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = { params: '', width: 1280, height: 720, out: 'shots/art', steps: '', ui: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  if (k === 'ui') args.ui = true;
  else args[k] = typeof args[k] === 'number' ? Number(argv[++i]) : argv[++i];
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
const url = `http://127.0.0.1:${server.address().port}/?autostart=1&autopilot=1&mute=1&renderer=webgl&${args.params}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: args.width, height: args.height } });
await ctx.addInitScript(() => {
  const dc = (window.__dc = { calls: 0, tris: 0 });
  const P = WebGL2RenderingContext.prototype;
  const wrap = (name, countArg, instArg) => {
    const o = P[name];
    P[name] = function (...a) {
      dc.calls++;
      if (a[0] === 4) dc.tris += (a[countArg] / 3) * (instArg >= 0 ? a[instArg] : 1);
      return o.apply(this, a);
    };
  };
  wrap('drawElements', 1, -1);
  wrap('drawElementsInstanced', 1, 4);
  wrap('drawArrays', 2, -1);
  wrap('drawArraysInstanced', 2, 3);
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.stack || e.message}`));
let failed = false;
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__wayman.ready);
  await page.evaluate(() => window.__wayman.game.stage.app.ticker.stop());
  if (!args.ui) await page.addStyleTag({ content: '#ui{display:none!important}' });
  mkdirSync(resolve(args.out), { recursive: true });
  for (const raw of args.steps.split('|').map((s) => s.trim()).filter(Boolean)) {
    const i = raw.indexOf(':');
    const op = i < 0 ? raw : raw.slice(0, i), val = i < 0 ? '' : raw.slice(i + 1);
    if (op === 'to' || op === 'tick') {
      await page.evaluate(([op, v]) => {
        const w = window.__wayman, g = w.game;
        const T = Number(v);
        let guard = 0;
        if (op === 'to') while (w.state().player.s < T && !w.state().over && guard++ < 20000) g.tick(1 / 30);
        else for (let t = 0; t < T - 1e-6 && !w.state().over; t += 1 / 30) g.tick(1 / 30);
      }, [op, val]);
    } else if (op === 'js' || op === 'jsfile') {
      const r = await page.evaluate((code) => {
        const w = window.__wayman, game = w.game; // eslint-disable-line no-unused-vars
        const out = eval(code);
        return out === undefined ? null : JSON.stringify(out);
      }, op === 'js' ? val : readFileSync(val, 'utf8'));
      if (r !== null) console.log('js ->', r);
    } else if (op === 'stumble') await page.evaluate(() => window.__wayman.forceStumble());
    else if (['boost', 'magnet', 'multiplier', 'shield', 'sneakers'].includes(op)) await page.evaluate((k) => window.__wayman.forcePickup(k), op);
    else if (op === 'zone') await page.evaluate((z) => window.__wayman.setZone(z === 'n' ? null : Number(z)), val);
    else if (op === 'quality') await page.evaluate((q) => window.__wayman.game.stage.setQuality(q), val);
    else if (op === 'shot') {
      const st = await page.evaluate(() => {
        const w = window.__wayman, g = w.game;
        g.tick(1 / 60);
        window.__dc.calls = 0; window.__dc.tris = 0;
        g.stage.render();
        const s = w.state();
        return { s: +s.player.s.toFixed(1), zone: s.zone, blend: +s.zoneBlend.toFixed(2), calls: window.__dc.calls, tris: Math.round(window.__dc.tris), action: s.player.action, over: s.over, q: g.stage.quality };
      });
      const file = join(resolve(args.out), `${val}.png`);
      await page.screenshot({ path: file, timeout: 180000 });
      console.log(JSON.stringify({ name: val, ...st }));
    } else throw new Error(`unknown step ${op}`);
  }
  errors.push(...(await page.evaluate(() => window.__wayman.errors.slice())));
} catch (e) {
  failed = true;
  console.error(e);
}
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
await browser.close();
server.close();
process.exit(failed || errors.length ? 1 : 0);
