#!/usr/bin/env node
// Camera / cinematic review sheets (Playwright, drives window.__wayman). Build first: `npm run build`.
//
//   node scripts/camshots.mjs --scene start,crash [--size 1280x720,390x844] [--out shots/cam] [--zone 0]
//                             [--frames]   also keep the individual frames
//   node scripts/camshots.mjs --list       list the scenes
//
// Every scene stages a moment with the sim helpers (clearTrack / placeEntity / input.press), steps
// the game with `game.tick()` (the real-time ticker is stopped: software rendering is ~100 ms per
// frame) and captures labelled frames, which are composed into ONE sheet per scene and viewport:
// <out>/<scene>-<W>x<H>.png. The DOM (menu, HUD, panels) is part of the capture on purpose: the
// framing has to work with it. Exits non-zero on page errors, console errors or __wayman.errors.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const OUT = resolve(opt('out', 'shots/cam'));
const ZONE = opt('zone', '0');
const KEEP = argv.includes('--frames');

// ------------------------------------------------------------------ page helpers (run in page)
const HELP = `
const G = window.__wayman.game, sim = G.sim, st = sim.state, p = st.player;
const ROOF = 2.8;
const shot = async (label) => { G.stage.render(); await window.__shot(label); };
const run = (secs, fn, dt = 1/60) => { const n = Math.round(secs / dt); for (let i = 0; i < n; i++) { if (fn) fn(i, i*dt); G.tick(dt); } };
const until = (cond, fn, dt = 1/60, max = 20) => { let t = 0; while (!cond() && t < max) { if (fn) fn(t); G.tick(dt); t += dt; } return t; };
const press = (a) => G.input.press(a);
const fresh = (secs = 0.6) => { G.autopilot = null; sim.clearTrack(true); G.cameraRig.snap(p); run(secs); };
const seq = async (times, prefix = 't') => { let t0 = 0; for (const t of times) { run(t - t0); t0 = t; await shot(prefix + t.toFixed(2)); } };
const toLane = (l) => { while (p.lane > l) { press('left'); run(0.2); } while (p.lane < l) { press('right'); run(0.2); } };
`;

const SCENES = {
  menu: `
    G.home(); run(0.3); await shot('menu 0.3s');
    for (const t of (window.__menuT ?? [3, 8, 14, 22, 30])) { run(t - (window.__t ?? 0.3)); window.__t = t; await shot('menu ' + t + 's'); }`,
  start: `
    G.home(); run(1.5); await shot('menu');
    G.start(); await shot('t0');
    await seq([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.4, 2.0]);`,
  startLate: `
    G.home(); run(17); await shot('menu 17s');
    G.start(); await seq([0.15, 0.3, 0.45, 0.6, 0.9, 1.4]);`,
  restart: `
    fresh(1.0); sim.placeEntity('blocker', 0, p.s + 8); until(() => st.over); run(3); await shot('game over panel');
    G.start(); await shot('t0');
    await seq([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.4, 2.0]);`,
  restartLeft: `
    fresh(0.3); toLane(-1); run(0.3); sim.placeEntity('truck', -1, p.s + 9); sim.placeEntity('bus', 0, p.s + 6); until(() => st.over); run(3); await shot('game over panel');
    G.start(); await seq([0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5]);`,
  crash: `
    fresh(); sim.placeEntity('blocker', 0, p.s + 9);
    until(() => st.over, null, 1/60, 5); await shot('impact');
    await seq([0.05, 0.15, 0.3, 0.5, 0.8, 1.1, 1.6, 2.5]);`,
  crashBus: `
    fresh(); toLane(1); run(0.3); const s0 = p.s; sim.placeEntity('bus', 1, s0 + 12); sim.placeEntity('truck', 0, s0 + 8); sim.placeEntity('ramp', -1, s0 + 10);
    until(() => st.over, null, 1/60, 5); await shot('impact');
    await seq([0.1, 0.3, 0.6, 1.0, 1.6, 2.5]);`,
  caught: `
    fresh(); const s0 = p.s;
    sim.placeEntity('truck', 1, s0 + 1.5); press('right'); run(0.12); run(1.5);
    sim.placeEntity('truck', -1, p.s + 1.5); press('left'); run(0.06);
    await shot('2nd hit'); await seq([0.1, 0.25, 0.4, 0.6, 0.9, 1.2, 1.6, 2.5]);`,
  caughtBlocked: `
    fresh(); const s0 = p.s;
    sim.placeEntity('truck', -1, s0 + 1.5); press('left'); run(0.12); run(1.0);
    const s1 = p.s; sim.placeEntity('truck', -1, s1 + 3); sim.placeEntity('bus', 1, s1 + 4); sim.placeEntity('truck', 1, s1 + 14);
    press('right'); run(0.1); await shot('2nd hit');
    await seq([0.1, 0.25, 0.4, 0.6, 0.9, 1.2, 1.6, 2.5]);`,
  stumble: `
    fresh(); const s0 = p.s;
    sim.placeEntity('truck', -1, s0 + 1.5); sim.placeEntity('bus', 1, s0 + 8);
    press('left'); run(0.12); await shot('hit');
    await seq([0.15, 0.3, 0.5, 0.75, 1.0, 1.4, 2.0, 2.6]);`,
  boost: `
    fresh(0.3); toLane(1); run(0.4); G.forcePickup('boost'); await shot('pickup');
    await seq([0.15, 0.3, 0.5, 0.8, 1.3, 2.5]);
    press('left'); run(0.4); await shot('to centre'); press('right'); run(1.5); await shot('back right');
    until(() => st.powerups.boost <= 0); await shot('descent 0');
    await seq([0.3, 0.6, 0.9], 'desc+');
    until(() => p.grounded); await shot('landed'); run(0.6); await shot('landed+0.6');`,
  roof: `
    fresh(); const s0 = p.s;
    sim.placeEntity('ramp', 0, s0 + 22); sim.placeEntity('bus', 0, s0 + 30); sim.placeEntity('truck', 0, s0 + 38);
    sim.placeEntity('truck', 1, s0 + 30); sim.placeEntity('ramp', -1, s0 + 22); sim.placeEntity('truck', -1, s0 + 28);
    sim.placeEntity('overhead', 0, s0 + 60);
    await shot('approach');
    for (const d of [18, 23, 28, 36, 41]) { until(() => p.s >= s0 + d); await shot('s+' + d); }
    press('left'); run(0.3); await shot('lane on roof'); press('right'); run(0.1);
    until(() => p.s >= s0 + 43); await shot('edge'); run(0.25); await shot('falling'); until(() => p.grounded); await shot('landed'); run(0.5); await shot('after');`,
  moves: `
    fresh(0.6); await shot('run'); press('left'); run(0.06); await shot('lane L 0.06'); run(0.12); await shot('lane L 0.18');
    run(0.4); press('left'); run(0.2); await shot('wall left'); press('right'); run(0.3); press('right'); run(0.1); await shot('lane R'); run(0.4);
    press('jump'); run(0.2); await shot('jump 0.2'); run(0.2); await shot('jump 0.4'); run(0.25); await shot('jump 0.65');
    run(0.3); press('roll'); run(0.2); await shot('roll'); sim.placeEntity('hurdle', 1, p.s + 10); sim.placeEntity('overhead', 0, p.s + 14); sim.placeEntity('blocker', -1, p.s + 12); run(0.4); await shot('obstacles ahead');`,
  shield: `
    fresh(); G.forcePickup('shield'); run(0.4); sim.placeEntity('blocker', 0, p.s + 7);
    until(() => st.powerups.shield === 0, null, 1/60, 3); await shot('break');
    await seq([0.05, 0.15, 0.3, 0.6, 1.0]);`,
  oncoming: `
    fresh(); const s0 = p.s; sim.placeEntity('busOncoming', 0, s0 + 50); sim.placeEntity('busOncoming', 1, s0 + 70);
    await shot('far'); press('left'); run(0.3); await shot('dodge'); await seq([0.4, 0.8, 1.1, 1.4, 1.8]);`,
  bend: `
    fresh(2.0); const s0 = p.s;
    sim.placeEntity('bus', 0, s0 + 40); sim.placeEntity('truck', -1, s0 + 30); sim.placeEntity('blocker', 1, s0 + 24);
    for (const [d, s] of [[10, 16], [10, -16], [14, 0], [10, 24], [10, -24]]) { G.stage.setWorldBend({ down: d, side: s }); G.tick(1/60); await shot('bend ' + d + ',' + s); }
    G.stage.setWorldBend(null);`,
  gateway: `
    G.autopilot = null; sim.clearTrack(true); G.forceZone = null; while (p.s < 470) G.tick(1/30);
    await shot('s' + p.s.toFixed(0)); for (let i = 0; i < 7; i++) { until(() => false, null, 1/60, 0.35); await shot('s' + p.s.toFixed(0)); }`,
  pause: `
    fresh(1.0); press('left'); run(0.08); G.pause(); run(0.5); await shot('paused'); G.resume(); run(0.05); await shot('resumed'); run(0.4); await shot('+0.4');`,
};

// ------------------------------------------------------------------ server
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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

/** Compose labelled frames into one sheet (rendered by the browser itself: no image deps). */
async function sheet(browser, frames, W, H, file) {
  const cols = W / H > 1.2 ? (frames.length > 9 ? 4 : 3) : Math.min(frames.length, 6);
  const cw = Math.round(Math.min(2000 / cols, W * 0.5));
  const ch = Math.round((cw * H) / W);
  const rows = Math.ceil(frames.length / cols);
  const page = await browser.newPage({ viewport: { width: cw * cols, height: ch * rows } });
  const cells = frames
    .map((f) => `<div style="position:relative;width:${cw}px;height:${ch}px"><img src="data:image/png;base64,${f.png.toString('base64')}" style="width:100%;height:100%;display:block">` +
      `<span style="position:absolute;left:4px;bottom:4px;font:bold 14px sans-serif;color:#fff;background:#000a;padding:1px 5px">${f.label}</span></div>`)
    .join('');
  await page.setContent(`<body style="margin:0;background:#000"><div style="display:grid;grid-template-columns:repeat(${cols},${cw}px)">${cells}</div></body>`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

async function main() {
  if (argv.includes('--list')) return console.log(Object.keys(SCENES).join('\n'));
  const scenes = opt('scene', 'start').split(',');
  const sizes = opt('size', '1280x720').split(',').map((s) => s.split('x').map(Number));
  mkdirSync(OUT, { recursive: true });
  const { server, url } = await serveDist();
  const browser = await chromium.launch();
  let failed = false;
  try {
    for (const [W, H] of sizes) {
      for (const scene of scenes) {
        const body = SCENES[scene];
        if (!body) throw new Error(`unknown scene ${scene}`);
        const page = await browser.newPage({ viewport: { width: W, height: H } });
        const errs = [];
        page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
        page.on('pageerror', (e) => errs.push(String(e)));
        const frames = [];
        await page.exposeFunction('__shot', async (label) => {
          frames.push({ label, png: await page.screenshot({ timeout: 120000 }) });
        });
        const zq = ZONE === 'n' ? '' : `&zone=${ZONE}`;
        await page.goto(`${url}?seed=9&mute=1${zq}${opt('params', '') ? '&' + opt('params', '') : ''}`);
        await page.waitForFunction(() => window.__wayman?.game, null, { timeout: 60000 });
        await page.evaluate(() => window.__wayman.ready);
        await page.evaluate(() => window.__wayman.game.stage.app.ticker.stop());
        if (!/^\s*(G\.home|G\.autopilot)/.test(body)) await page.evaluate(() => window.__wayman.start());
        await page.evaluate(`(async () => { ${HELP} ${body} })()`);
        errs.push(...(await page.evaluate(() => window.__wayman.errors)));
        const file = join(OUT, `${scene}-${W}x${H}.png`);
        await sheet(browser, frames, W, H, file);
        if (KEEP) frames.forEach((f, i) => writeFileSync(join(OUT, `${scene}-${W}x${H}-${String(i).padStart(2, '0')}.png`), f.png));
        console.log(`${file}  (${frames.length} frames)${errs.length ? '  ERRORS: ' + errs.join(' | ') : ''}`);
        if (errs.length) failed = true;
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
