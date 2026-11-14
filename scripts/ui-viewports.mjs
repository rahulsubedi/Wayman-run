#!/usr/bin/env node
// Shoots every UI state at several viewport sizes and reports DOM overflow / overlap problems
// (build first: `npm run build`).
//
//   node scripts/ui-viewports.mjs <outDir> [tag] [--sizes '[[390,844],[1280,720]]'] [--only menu,hud]
//
// States: menu, hud (idle), hudfull (4 power-ups + multiplier + danger meter), popups (2 popups +
// zone banner), pause, count (resume countdown), over-crash, over-caught, over-best.
// Files: <outDir>/<tag>-<W>x<H>-<state>.png. Exits non-zero on console errors/warnings.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const sizes = JSON.parse(flag('sizes', '[[320,568],[390,844],[844,390],[1280,720],[2560,1080]]'));
const only = flag('only', '').split(',').filter(Boolean);
const [outDir, tag = 'ui'] = argv;
mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
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

/** Runs in the page: elements outside the viewport, clipped text, HUD / popup overlaps. */
const CHECK = () => {
  const out = [];
  const W = innerWidth, H = innerHeight;
  const vis = (e) => {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  for (const e of document.querySelectorAll('#ui *')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cls = typeof e.className === 'string' ? e.className : '';
    if (/wr-confetti|wr-dim|wr-screen|wr-popups|wr-logo-streaks|wr-count\b/.test(cls) && !/wr-btn/.test(cls)) continue;
    if (e.closest('.wr-confetti')) continue;
    if (r.right > W + 1 || r.left < -1 || r.bottom > H + 1 || r.top < -1) out.push(`OUTSIDE ${e.tagName}.${cls.split(' ').join('.')} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
  }
  const rects = {};
  for (const sel of ['.wr-hud .wr-coinpill', '.wr-hud .wr-scorebox', '.wr-hud .wr-pausebtn', '.wr-hud .wr-chips', '.wr-hud .wr-danger', '.wr-toast-text', '.wr-popup:nth-child(1)', '.wr-popup:nth-child(2)']) {
    const e = document.querySelector(sel);
    if (e && vis(e)) { const r = e.getBoundingClientRect(); if (r.width) rects[sel] = r; }
  }
  const ks = Object.keys(rects);
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
    const a = rects[ks[i]], b = rects[ks[j]];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`OVERLAP ${ks[i]} x ${ks[j]}`);
  }
  return out;
};

const browser = await chromium.launch();
let bad = 0;
for (const [W, H] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: W < 900, isMobile: W < 900 });
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/GL Driver|adapters/.test(m.text())) msgs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => msgs.push('pageerror: ' + e));
  await page.goto(base + '?seed=6&mute=1');
  await page.waitForFunction(() => window.__wayman?.game, null, { timeout: 90000 });
  await page.evaluate(() => window.__wayman.ready);
  await page.evaluate(() => window.__wayman.game.stage.app.ticker.stop());
  const t = `${W}x${H}`;
  const want = (n) => only.length === 0 || only.includes(n);
  const shot = async (name, wait = 450, render = true) => {
    await page.waitForTimeout(wait);
    if (want(name)) {
      if (render) await page.evaluate(() => window.__wayman.game.stage.render());
      await page.screenshot({ path: `${outDir}/${tag}-${t}-${name}.png` });
    }
    const issues = await page.evaluate(CHECK);
    if (issues.length) { bad++; console.log(t, name, issues); }
  };
  const ev = (f) => page.evaluate(f);
  await page.waitForTimeout(1200);
  await shot('menu', 600);
  await page.locator('.wr-play').first().click({ force: true });
  await ev(() => { const w = window.__wayman; w.setAutopilot(true); w.advance(9); });
  await shot('hud');
  await ev(() => {
    const w = window.__wayman;
    ['magnet', 'shield', 'boost', 'multiplier'].forEach((k) => w.forcePickup(k));
    w.state().powerups.boost = 6; w.game.sim.state.powerups.boost = 6;
    w.state().score = 1234567; w.state().coins = 98765; w.game.forceStumble(); w.advance(0.25);
  });
  await shot('hudfull', 150);
  await page.waitForTimeout(1300); // let earlier popups finish so both slots are free
  await ev(() => { const w = window.__wayman; w.game.ui.popup('SHIELD SAVED YOU!', 'good'); w.game.ui.popup('NEAR MISS!', 'great'); w.game.ui.popup('SCORE X2!', 'great'); w.game.ui.toast('Night Bazaar'); });
  await shot('popups', 120, false); // time-critical: popups only live ~1 s, no re-render
  await ev(() => window.__wayman.pause());
  await shot('pause');
  await ev(() => window.__wayman.game.ui.beginResume());
  await shot('count', 200);
  await page.waitForTimeout(2300);
  await ev(() => { const w = window.__wayman; w.setAutopilot(false); w.game.best.score = 99999999; w.forceCrash('crash'); w.advance(4); });
  await page.waitForTimeout(2300);
  await shot('over-crash');
  await ev(() => { const w = window.__wayman; w.game.home(); w.game.start(); w.setAutopilot(true); w.advance(3); w.setAutopilot(false); w.forceCrash('caught'); w.advance(4); });
  await page.waitForTimeout(2300);
  await shot('over-caught');
  await ev(() => { const w = window.__wayman; w.game.home(); w.game.best.score = 0; w.game.start(); w.setAutopilot(true); w.advance(4); w.state().score = 4321; w.setAutopilot(false); w.forceCrash('crash'); w.advance(4); });
  await page.waitForTimeout(2300);
  await shot('over-best', 1500);
  if (msgs.length) { bad++; console.log(t, 'console', msgs); }
  await ctx.close();
}
await browser.close();
server.close();
console.log(bad ? `${bad} problem group(s)` : 'ui-viewports: clean');
process.exit(bad ? 1 : 0);
