#!/usr/bin/env node
// Integration QA driver (Playwright, drives window.__wayman). Build first: `npm run build`.
//
//   node scripts/integration.mjs shots [--out <dir>] [--only a,b,c]   review screenshots
//   node scripts/integration.mjs soak  [--seeds 1,2,3,4,5] [--seconds 120] [--out <dir>]
//   node scripts/integration.mjs restart [--times 6]                   crash -> play again loop
//
// The page's real ticker is stopped (the game is stepped with __wayman.advance only), so runs are
// deterministic and never wait on software-rendered real time. Exits non-zero on any failure.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'shots', ...rest] = process.argv.slice(2);
const opt = (k, d) => (rest.includes(`--${k}`) ? rest[rest.indexOf(`--${k}`) + 1] : d);
const OUT = resolve(opt('out', 'shots/integration'));
mkdirSync(OUT, { recursive: true });

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

const browser = await chromium.launch();
const problems = [];
const fail = (m) => {
  problems.push(m);
  console.log('FAIL', m);
};

async function open(params, size = { width: 1280, height: 720 }, keepTicker = false) {
  const page = await browser.newPage({ viewport: size });
  page.on('console', (m) => m.type() === 'error' && fail(`console: ${m.text()}`));
  page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
  await page.goto(`${base}?mute=1&${params}`);
  await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__wayman.ready);
  if (!keepTicker) await page.evaluate(() => window.__wayman.game.stage.app.ticker.stop());
  return page;
}
const adv = (page, s) => page.evaluate((x) => window.__wayman.advance(x), s);
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function snap(page, name) {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('shot', name);
}
const info = (page) =>
  page.evaluate(() => {
    const w = window.__wayman;
    const s = w.state();
    return { mode: w.mode(), t: +s.time.toFixed(2), s: +s.player.s.toFixed(1), x: +s.player.x.toFixed(2), y: +s.player.y.toFixed(2), action: s.player.action, groundY: s.player.groundY, coins: s.coins, score: s.score, zone: s.zone, over: s.over, stats: w.stats() };
  });

/** Step the game (no rendering) until `pred` is true in the page, then render once. */
async function advanceUntil(page, predSrc, maxSeconds, step = 1 / 30) {
  const ok = await page.evaluate(
    ({ src, max, dt }) => {
      const g = window.__wayman.game;
      const f = new Function('s', `return (${src})(s);`);
      for (let t = 0; t < max; t += dt) {
        g.tick(dt);
        if (f(g.sim.state)) return true;
        if (g.sim.state.over) return false;
      }
      return false;
    },
    { src: predSrc, max: maxSeconds, dt: step },
  );
  await adv(page, 0.01);
  return ok;
}

// ------------------------------------------------------------------------------- shots
const SHOTS = {
  async menu() {
    for (const [n, w, h] of [['desktop', 1280, 720], ['portrait', 390, 844], ['landscape', 844, 390]]) {
      const page = await open('', { width: w, height: h });
      await adv(page, 1.5);
      await snap(page, `menu_${n}`);
      await page.close();
    }
  },
  async swoop() {
    const page = await open('seed=3');
    await adv(page, 0.5);
    await page.evaluate(() => window.__wayman.start());
    let at = 0;
    for (const t of [0.05, 0.3, 0.6, 1.0, 1.6, 2.6]) {
      await adv(page, t - at);
      at = t;
      await snap(page, `swoop_${String(Math.round(t * 100)).padStart(3, '0')}`);
    }
    await page.close();
  },
  async roof() {
    const page = await open('autostart=1&autopilot=1&seed=2');
    const ok = await advanceUntil(page, '(s) => s.player.grounded && (s.player.groundY ?? 0) > 2.7', 150);
    console.log('roof found:', ok, JSON.stringify(await info(page)));
    await adv(page, 0.4);
    await snap(page, 'roof_run');
    await page.close();
  },
  async boost() {
    const page = await open('autostart=1&autopilot=1&seed=4');
    await adv(page, 6);
    await page.evaluate(() => window.__wayman.forcePickup('boost'));
    await adv(page, 0.25);
    await snap(page, 'boost_takeoff');
    await adv(page, 2.2);
    await snap(page, 'boost_flight_coins');
    await adv(page, 4.8);
    await snap(page, 'boost_end');
    await adv(page, 0.6);
    await snap(page, 'boost_descent_a');
    await adv(page, 0.5);
    await snap(page, 'boost_descent_b');
    await adv(page, 0.4);
    await snap(page, 'boost_landing');
    console.log(JSON.stringify(await info(page)));
    await page.close();
  },
  async magnet() {
    const page = await open('autostart=1&autopilot=1&seed=5');
    await adv(page, 4);
    await page.evaluate(() => window.__wayman.forcePickup('magnet'));
    const ok = await advanceUntil(page, '(s) => s.entities.some((e) => e.kind === "coin" && e.magnet)', 20);
    console.log('magnet coins:', ok);
    await snap(page, 'magnet_pull');
    await page.close();
  },
  async stumble() {
    const page = await open('autostart=1&autopilot=1&seed=1');
    await adv(page, 8);
    await page.evaluate(() => window.__wayman.forceStumble());
    await adv(page, 0.12);
    await snap(page, 'stumble_a');
    await adv(page, 0.5);
    await snap(page, 'stumble_danger');
    await page.close();
  },
  async powerups() {
    const page = await open('autostart=1&autopilot=1&seed=2');
    await adv(page, 5);
    await page.evaluate(() => {
      window.__wayman.forcePickup('shield');
      window.__wayman.forcePickup('multiplier');
    });
    await adv(page, 0.5);
    await snap(page, 'shield_multiplier');
    await page.close();
  },
  async crash() {
    const page = await open('autostart=1&autopilot=1&seed=1');
    await adv(page, 10);
    await page.evaluate(() => window.__wayman.forceCrash('crash'));
    let at = 0;
    for (const t of [0.04, 0.2, 0.5, 0.9, 1.25]) {
      await adv(page, t - at);
      at = t;
      await snap(page, `crash_${String(Math.round(t * 100)).padStart(3, '0')}`);
    }
    await adv(page, 0.3);
    await snap(page, 'gameover_panel');
    console.log('mode after crash:', (await info(page)).mode);
    await page.close();
  },
  async caught() {
    const page = await open('autostart=1&autopilot=1&seed=1');
    await adv(page, 10);
    await page.evaluate(() => window.__wayman.forceStumble());
    await adv(page, 0.8);
    await page.evaluate(() => window.__wayman.forceCrash('caught'));
    let at = 0;
    for (const t of [0.05, 0.4, 0.9, 1.4]) {
      await adv(page, t - at);
      at = t;
      await snap(page, `caught_${String(Math.round(t * 100)).padStart(3, '0')}`);
    }
    await adv(page, 0.4);
    await snap(page, 'gameover_caught');
    await page.close();
  },
  async over_sizes() {
    for (const [n, w, h] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
      const page = await open('autostart=1&autopilot=1&seed=3', { width: w, height: h });
      await adv(page, 12);
      await page.evaluate(() => window.__wayman.forceCrash('crash'));
      await adv(page, 2);
      await snap(page, `gameover_${n}`);
      await page.close();
    }
  },
  async pause() {
    const page = await open('autostart=1&autopilot=1&seed=1');
    await adv(page, 6);
    await page.evaluate(() => window.__wayman.pause());
    await adv(page, 0.3);
    await snap(page, 'pause');
    await page.close();
  },
  async zones() {
    for (const z of [0, 1, 2]) {
      const page = await open(`autostart=1&autopilot=1&seed=1&zone=${z}`);
      await adv(page, 9);
      await snap(page, `zone_${z}`);
      await page.close();
    }
  },
};

// -------------------------------------------------------------------------------- soak
async function soakSeed(seed, seconds) {
  const page = await open(`autostart=1&autopilot=1&seed=${seed}`);
  let worst = { mismatch: 0, hiddenLive: 0, visiblePooled: 0 };
  let runs = 1;
  let nodesStart = (await info(page)).stats.nodes;
  let restarts = 0;
  const step = 1.0;
  const shots = new Set([30, 60, 90, 119].map((x) => Math.min(x, seconds - 1)));
  for (let t = 0; t < seconds; t += step) {
    await adv(page, step);
    const i = await info(page);
    const st = i.stats;
    // Live nodes must equal sim entities, all visible; pooled nodes must all be hidden.
    if (st.liveNodes !== st.simEntities) worst.mismatch = Math.max(worst.mismatch, Math.abs(st.liveNodes - st.simEntities));
    if (st.visibleLive !== st.liveNodes) worst.hiddenLive = Math.max(worst.hiddenLive, st.liveNodes - st.visibleLive);
    if (st.visiblePooled > 0) worst.visiblePooled = Math.max(worst.visiblePooled, st.visiblePooled);
    if (shots.has(Math.round(t))) await snap(page, `soak_seed${seed}_t${Math.round(t)}`);
    if (i.over || i.mode === 'gameover') {
      // The autopilot died: finish the death beat, then play again (also exercises restart).
      await adv(page, 2);
      const m = (await info(page)).mode;
      if (m !== 'gameover') fail(`seed ${seed}: expected gameover panel, mode ${m}`);
      await page.evaluate(() => window.__wayman.start());
      restarts++;
      runs++;
    }
  }
  const end = await info(page);
  const errs = await page.evaluate(() => window.__wayman.errors.slice());
  if (errs.length) fail(`seed ${seed}: hook errors ${errs.join(' | ')}`);
  if (worst.mismatch) fail(`seed ${seed}: live node count != sim entities (max diff ${worst.mismatch})`);
  if (worst.hiddenLive) fail(`seed ${seed}: ${worst.hiddenLive} live nodes hidden`);
  if (worst.visiblePooled) fail(`seed ${seed}: ${worst.visiblePooled} pooled nodes visible`);
  console.log(`seed ${seed}: ${seconds}s, final t=${end.t} s=${end.s} score=${end.score} restarts=${restarts} nodes ${nodesStart} -> ${end.stats.nodes}`, JSON.stringify(worst));
  await page.close();
}

async function restartLoop(times) {
  const page = await open('autostart=1&autopilot=1&seed=1');
  for (let k = 0; k < times; k++) {
    await adv(page, 6);
    // Gather some transient state: power-ups, popups, particles.
    await page.evaluate(() => {
      window.__wayman.forcePickup('magnet');
      window.__wayman.forcePickup('shield');
      window.__wayman.forceStumble();
    });
    await adv(page, 0.5);
    await page.evaluate((r) => window.__wayman.forceCrash(r), k % 2 ? 'caught' : 'crash');
    await adv(page, 2);
    if ((await info(page)).mode !== 'gameover') fail(`restart ${k}: not in gameover`);
    await page.evaluate(() => window.__wayman.start());
    await adv(page, 0.2);
    const i = await info(page);
    const dom = await page.evaluate(() => ({
      screen: document.getElementById('ui').dataset.screen,
      popups: [...document.querySelectorAll('.wr-popup.wr-go')].length,
      danger: document.querySelector('.wr-danger')?.classList.contains('wr-on'),
      chips: [...document.querySelectorAll('.wr-chip.wr-on')].length,
    }));
    const st = i.stats;
    console.log(`restart ${k}:`, JSON.stringify({ mode: i.mode, t: i.t, s: i.s, coins: i.coins, particles: st.particles, live: st.liveNodes, ent: st.simEntities, vp: st.visiblePooled, ...dom }));
    if (i.mode !== 'running' || i.t > 0.5 || i.coins !== 0) fail(`restart ${k}: bad state ${JSON.stringify(i)}`);
    if (dom.screen !== 'hud' || dom.danger || dom.chips > 0) fail(`restart ${k}: stale UI ${JSON.stringify(dom)}`);
    if (st.liveNodes !== st.simEntities || st.visiblePooled) fail(`restart ${k}: pooled nodes inconsistent`);
    if (k === 0) await snap(page, 'restart_clean');
  }
  // Home -> menu -> play too.
  await page.evaluate(() => window.__wayman.home());
  await adv(page, 0.5);
  const m = await info(page);
  if (m.mode !== 'menu' || m.s !== 0 || m.action === 'dead') fail(`home: bad state ${JSON.stringify(m)}`);
  await page.close();
}

try {
  if (cmd === 'shots') {
    const only = opt('only', '');
    for (const [name, fn] of Object.entries(SHOTS)) {
      if (only && !only.split(',').includes(name)) continue;
      console.log(`--- ${name}`);
      await fn();
    }
  } else if (cmd === 'soak') {
    const seconds = Number(opt('seconds', '120'));
    for (const seed of opt('seeds', '1,2,3,4,5').split(',').map(Number)) await soakSeed(seed, seconds);
  } else if (cmd === 'restart') {
    await restartLoop(Number(opt('times', '6')));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
} catch (e) {
  fail(`exception: ${e.stack || e}`);
}
await browser.close();
server.close();
console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nOK');
process.exit(problems.length ? 1 : 0);
