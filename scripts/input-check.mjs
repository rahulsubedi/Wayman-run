#!/usr/bin/env node
// Playwright check that real keyboard events and touch/mouse swipes drive the running game.
//   node scripts/input-check.mjs     (build first: `npm run build`)
// Uses window.__wayman.state().player, so it needs no pixel inspection. Exits non-zero on failure.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const dist = join(ROOT, 'dist');
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const browser = await chromium.launch();
const errors = [];

async function fresh(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}?autostart=1&seed=1&mute=1&quality=low`);
  await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__wayman.ready);
  // freeze the first empty ~60 m: keep the sim time small so nothing can hit us
  return { ctx, page };
}
const player = (page) => page.evaluate(() => { const p = window.__wayman.state().player; return { lane: p.lane, action: p.action, y: p.y, grounded: p.grounded, over: window.__wayman.state().over }; });
const until = async (page, fn, arg, timeout = 4000) => {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 30 }); return true; } catch { return false; }
};
const settle = (page, ms = 700) => page.waitForTimeout(ms);
// Real time passes while we poll (software rendering), and the first ~60 m of a run are empty.
// Restart whenever we are late into the run so an obstacle can never end the test.
const fresher = async (page) => {
  await page.evaluate(() => { const g = window.__wayman.game; if (g.mode !== 'running' || g.sim.state.over || g.sim.state.time > 1.5) { g.start(); } });
  await page.waitForTimeout(150);
};

// -------- keyboard
{
  const { ctx, page } = await fresh();
  await page.focus('body').catch(() => {});
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft -> lane -1', await until(page, () => window.__wayman.state().player.lane === -1));
  await page.keyboard.press('ArrowRight');
  check('ArrowRight -> lane 0', await until(page, () => window.__wayman.state().player.lane === 0));
  await page.keyboard.press('KeyD');
  check('D -> lane 1', await until(page, () => window.__wayman.state().player.lane === 1));
  await page.keyboard.press('KeyA');
  check('A -> lane 0', await until(page, () => window.__wayman.state().player.lane === 0));
  await settle(page);

  // auto-repeat must be ignored
  await page.evaluate(() => { for (let i = 0; i < 6; i++) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', repeat: true, cancelable: true })); });
  await settle(page, 500);
  check('key auto-repeat ignored', (await player(page)).lane === 0);

  // browser shortcuts are not swallowed; game keys are
  const prevented = await page.evaluate(() => {
    const mk = (code, extra = {}) => { const e = new KeyboardEvent('keydown', { code, cancelable: true, bubbles: true, ...extra }); window.dispatchEvent(e); return e.defaultPrevented; };
    return { ctrlR: mk('KeyR', { ctrlKey: true }), ctrlA: mk('KeyA', { ctrlKey: true }), metaLeft: mk('ArrowLeft', { metaKey: true }), space: mk('Space') };
  });
  check('Ctrl+R / Ctrl+A / Cmd+Left are not swallowed', !prevented.ctrlR && !prevented.ctrlA && !prevented.metaLeft, JSON.stringify(prevented));
  check('Space is captured (no page scroll)', prevented.space === true);
  await settle(page, 900);

  const before = await player(page);
  await fresher(page);
  await page.keyboard.press('Space');
  const jumped = await until(page, () => !window.__wayman.state().player.grounded || window.__wayman.state().player.y > 0.05);
  check('Space -> jump', jumped && !before.over);
  await settle(page, 1000);
  await fresher(page);
  await page.keyboard.press('ArrowDown');
  check('ArrowDown -> roll', await until(page, () => window.__wayman.state().player.action === 'roll', null, 3000));
  await settle(page, 900);
  await fresher(page);
  await page.keyboard.press('KeyW');
  check('W -> jump', await until(page, () => !window.__wayman.state().player.grounded));
  await settle(page, 1000);

  await fresher(page);
  await page.keyboard.press('KeyP');
  check('P -> pause', await until(page, () => window.__wayman.game.mode === 'paused', null, 2000));
  check('pause screen visible', await page.evaluate(() => document.querySelector('#ui').dataset.screen === 'pause'));
  await page.keyboard.press('Escape');
  check('Esc -> resume', await until(page, () => window.__wayman.game.mode === 'running', null, 2000));
  await ctx.close();
}

// -------- touch swipes through CDP (real touch events -> pointer events)
{
  const { ctx, page } = await fresh();
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const swipe = async (pts) => {
    await touch('touchStart', pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) { await touch('touchMove', x, y); await page.waitForTimeout(16); }
  };

  await fresher(page);
  await swipe([[200, 500], [185, 500], [165, 500], [150, 500]]);
  check('touch swipe left (fires before release) -> lane -1', await until(page, () => window.__wayman.state().player.lane === -1));
  // second swipe, same touch, no lift: up
  const laneNow = (await player(page)).lane;
  await swipe([[150, 480], [150, 450], [150, 420]]);
  const up = await until(page, () => !window.__wayman.state().player.grounded);
  check('second swipe in same touch (left then up) -> jump', up && laneNow === -1);
  await touch('touchEnd');
  await settle(page, 1100);

  await fresher(page);
  await swipe([[100, 400], [140, 400], [180, 400], [220, 400]]);
  await touch('touchEnd');
  check('touch swipe right -> lane 1', await until(page, () => window.__wayman.state().player.lane === 1));
  await settle(page, 600);
  await fresher(page);
  // a roll lasts only 0.65 s of sim time, so count the roll inputs the sim receives instead of polling the action
  await page.evaluate(() => { const sim = window.__wayman.game.sim; const u = sim.update.bind(sim); window.__rolls = 0; sim.update = (dt, i) => { if (i.roll) window.__rolls++; return u(dt, i); }; });
  await swipe([[200, 400], [200, 440], [200, 480], [200, 520]]);
  await touch('touchEnd');
  check('touch swipe down -> roll input reaches the sim', await until(page, () => window.__rolls === 1, null, 3000), 'rolls=' + (await page.evaluate(() => window.__rolls)));
  await settle(page, 900);

  // a small jitter must do nothing
  const lane0 = (await player(page)).lane;
  await swipe([[200, 400], [205, 402], [196, 399]]);
  await touch('touchEnd');
  await settle(page, 400);
  check('tiny movement is not a swipe', (await player(page)).lane === lane0);

  // swipes starting on a UI button are not delivered to the game: start on the pause button
  const box = await page.evaluate(() => { const r = document.querySelector('.wr-pausebtn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const laneB = (await player(page)).lane;
  await swipe([[box.x, box.y], [box.x - 30, box.y], [box.x - 60, box.y]]);
  await touch('touchEnd');
  await settle(page, 400);
  check('swipe starting on a UI button does not steer the game', (await player(page)).lane === laneB);
  await ctx.close();
}

// -------- mouse drag (desktop testing)
{
  const { ctx, page } = await fresh({ hasTouch: false, isMobile: false, viewport: { width: 900, height: 600 } });
  await page.mouse.move(450, 300);
  await page.mouse.down();
  await page.mouse.move(420, 300, { steps: 3 });
  await page.mouse.move(380, 300, { steps: 3 });
  check('mouse drag left -> lane -1', await until(page, () => window.__wayman.state().player.lane === -1));
  await page.mouse.move(380, 260, { steps: 4 });
  check('mouse drag then up (same drag) -> jump', await until(page, () => !window.__wayman.state().player.grounded));
  await page.mouse.up();
  await ctx.close();
}

// -------- Space/Enter on menu and game over
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await page.goto(`${base}?seed=1&mute=1&quality=low`);
  await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__wayman.ready);
  check('starts on the menu', await page.evaluate(() => window.__wayman.game.mode === 'menu'));
  await page.keyboard.press('Enter');
  check('Enter on menu -> Play', await until(page, () => window.__wayman.game.mode === 'running', null, 2000));
  await page.evaluate(() => { const g = window.__wayman.game; g.pause(); g.home(); });
  await page.keyboard.press('Space');
  check('Space on menu -> Play', await until(page, () => window.__wayman.game.mode === 'running', null, 2000));
  await page.evaluate(() => { const g = window.__wayman.game; g.ui.showGameOver({ score: 10, coins: 1, best: 10, newBest: false, reason: 'crash' }); });
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  check('Space right after game over is ignored (anti mis-tap lock)', await page.evaluate(() => document.querySelector('#ui').dataset.screen === 'gameover'));
  await page.waitForTimeout(700);
  await page.keyboard.press('Space');
  check('Space on game over (after lock) -> Play again', await page.evaluate(() => document.querySelector('#ui').dataset.screen === 'hud'));
  await ctx.close();
}

await browser.close();
server.close();
if (errors.length) { console.log('console/page errors:\n' + errors.join('\n')); }
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} input checks passed${errors.length ? `, ${errors.length} errors` : ''}`);
process.exit(failed || errors.length ? 1 : 0);
