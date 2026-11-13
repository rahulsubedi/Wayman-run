#!/usr/bin/env node
// Drives the real UI with fake data and screenshots every state at three viewport sizes.
//   node scripts/ui-shots.mjs [--out <dir>] [--only desktop|portrait|landscape]
// Build first (`npm run build`): it serves ./dist itself.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const OUT = resolve(opt('out', 'shots/ui'));
const ONLY = opt('only', '');
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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

const VIEWS = [
  { name: 'desktop', viewport: { width: 1280, height: 720 }, touch: false },
  { name: 'portrait', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'landscape', viewport: { width: 844, height: 390 }, touch: true },
].filter((v) => !ONLY || v.name === ONLY);

const browser = await chromium.launch();
const problems = [];
for (const v of VIEWS) {
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.touch ? 2 : 1, hasTouch: v.touch, isMobile: v.touch });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${v.name}: ${e.stack || e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${v.name}: console ${m.text()}`); });
  await page.goto(`${base}?seed=3&mute=1&zone=0`);
  await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__wayman.ready);
  const shot = async (name, wait = 900) => {
    await page.waitForTimeout(wait);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: join(OUT, `${v.name}-${name}.png`) });
  };

  await page.evaluate(() => window.__wayman.game.ui.showMenu({ score: 24680, coins: 312 }));
  await shot('menu', 1100);

  // HUD: run a little, freeze the ticker, then drive the HUD with fake values
  await page.evaluate(() => { window.__wayman.start(); window.__wayman.advance(4); window.__wayman.game.stage.app.ticker.stop(); });
  await page.evaluate(() => {
    const g = window.__wayman.game;
    const s = g.sim.state;
    const fake = { ...s, score: 12840, coins: 87, multiplier: 2, powerups: { magnet: 6.1, shield: 1, boost: 2.1, multiplier: 9 } };
    g.ui.updateHud(fake);
    g.ui.toast('Harbor Front');
    g.ui.popup('Near miss!', 'great');
  });
  await shot('hud', 700);
  await page.evaluate(() => {
    const g = window.__wayman.game;
    g.ui.showHud();
    g.ui.updateHud({ ...g.sim.state, score: 480, coins: 3, multiplier: 1, powerups: { magnet: 0, shield: 0, boost: 0, multiplier: 0 } });
  });
  await shot('hud-plain', 300);

  await page.evaluate(() => window.__wayman.game.ui.showPause());
  await shot('pause', 700);

  // real countdown: click Resume, grab the first tick (game mode is 'running' only if pause() ran; here we just look)
  await page.evaluate(() => { window.__wayman.game.ui.showPause(); });
  await page.click('.wr-pause-panel .wr-primary');
  await shot('countdown', 200);
  await page.evaluate(() => window.__wayman.game.ui.cancelCountdown());

  await page.evaluate(() => window.__wayman.game.ui.showGameOver({ score: 15230, coins: 87, best: 15230, newBest: true, reason: 'crash' }));
  await shot('gameover-best', 1900);
  await page.evaluate(() => window.__wayman.game.ui.showGameOver({ score: 4210, coins: 23, best: 24680, newBest: false, reason: 'caught' }));
  await shot('gameover-caught', 1700);
  await ctx.close();
}
await browser.close();
server.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('screenshots in', OUT);
