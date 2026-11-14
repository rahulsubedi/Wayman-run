#!/usr/bin/env node
// WebGL2 vs WebGPU frame comparison (build first: `npm run build`).
//
//   node scripts/gpucompare.mjs --out shots/cmp --params "autostart=1&seed=1&autopilot=1&mute=1&zone=2"
//        [--width 1280 --height 720] [--backends webgl,webgpu] [--perf 6]
//        --steps "advance:4 | shot:z2a | js:game.stage.setWorldBend({down:15,side:-30}) | shot:z2bend"
//
// Every run is made deterministic before the steps: the ticker is stopped and the run restarted
// with the same seed (`game.start(seed)`), so the same `advance` times give the same sim state on
// both backends. Steps (separated by `|`): advance:<s>, js:<code> (with `game`; renders a frame),
// shot:<name> (writes <out>/<name>-<backend>.png). The UI overlay is hidden. --menu skips the
// restart (title-screen comparisons; omit autostart=1).
// After both backends ran, every shot pair is compared: percentage of pixels whose max channel
// difference exceeds 16 and 48, plus mean absolute difference; a <name>-diff.png heat map is written.
// --perf N times N extra `stage.render()` calls (waiting for the GPU) per backend and reports
// draw-call counts where the renderer exposes them.
// Prints JSON; exits non-zero on page errors, console errors, WebGPU validation warnings, or when a
// backend silently fell back to another one.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'];

const args = { out: 'shots/cmp', params: 'autostart=1&seed=1&mute=1', width: 1280, height: 720, steps: '', backends: 'webgl,webgpu', perf: 0, seed: 1, menu: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  if (k === 'menu') { args.menu = true; continue; }
  if (!(k in args)) throw new Error(`unknown option --${k}`);
  args[k] = typeof args[k] === 'number' ? Number(argv[++i]) : argv[++i];
}
const seedMatch = /(?:^|&)seed=(\d+)/.exec(args.params);
if (seedMatch) args.seed = Number(seedMatch[1]);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const dist = join(ROOT, 'dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ not found: run `npm run build` first');
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

const steps = args.steps.split('|').map((s) => s.trim()).filter(Boolean).map((raw) => {
  const i = raw.indexOf(':');
  return { op: raw.slice(0, i), val: raw.slice(i + 1) };
});

const result = { params: args.params, viewport: `${args.width}x${args.height}`, runs: {}, compare: {} };
let failed = false;

for (const backend of args.backends.split(',')) {
  const browser = await chromium.launch(backend === 'webgpu' ? { args: WEBGPU_FLAGS } : undefined);
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
  const run = { backend: null, shots: [], errors: [], warnings: [] };
  result.runs[backend] = run;
  page.on('console', (m) => {
    if (m.type() === 'error') run.errors.push(m.text());
    else if (m.type() === 'warning') run.warnings.push(m.text());
  });
  page.on('pageerror', (e) => run.errors.push(`pageerror: ${e.stack || e.message}`));
  // Freeze page time: the ticker then only ever sees dt = 0, so real-time frames before the ticker is
  // stopped (menu camera orbit, coin spin clocks, particle seeds) cannot differ between backends.
  await page.addInitScript(() => {
    const t0 = performance.now();
    const real = performance.now.bind(performance);
    window.__realNow = real;
    performance.now = () => t0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf(() => cb(t0));
  });
  try {
    await page.goto(`${base}?${args.params}&renderer=${backend}`);
    await page.waitForFunction(() => window.__wayman && window.__wayman.ready, null, { timeout: 120000 });
    await page.evaluate(() => window.__wayman.ready);
    await page.addStyleTag({ content: '#ui{display:none!important}' });
    run.backend = await page.evaluate(() => window.__wayman.game.stage.backend);
    if (run.backend !== backend) run.errors.push(`backend mismatch: asked ${backend}, running ${run.backend}`);
    await page.evaluate(([seed, menu]) => {
      const game = window.__wayman.game;
      game.stage.app.ticker.stop();
      if (!menu) game.start(seed);
    }, [args.seed, args.menu]);
    for (const { op, val } of steps) {
      if (op === 'advance') await page.evaluate((s) => window.__wayman.advance(Number(s)), val);
      else if (op === 'js') {
        const r = await page.evaluate((code) => {
          const game = window.__wayman.game; // eslint-disable-line no-unused-vars
          const out = eval(code);
          game.stage.render();
          return out === undefined ? null : JSON.stringify(out);
        }, val);
        if (r !== null) run.shots.push({ js: val, result: r });
      } else if (op === 'shot') {
        await page.evaluate(() => { window.__wayman.game.stage.render(); });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const file = join(args.out, `${val}-${backend}.png`);
        await page.screenshot({ path: file });
        const st = await page.evaluate(() => { const s = window.__wayman.state(); return { t: +s.time.toFixed(3), s: +s.player.s.toFixed(2), action: s.player.action, zone: s.zone, over: s.over }; });
        run.shots.push({ name: val, file, state: st });
      } else throw new Error(`unknown step ${op}`);
    }
    if (args.perf > 0) {
      run.perf = await page.evaluate(async (n) => {
        const game = window.__wayman.game;
        const r = game.stage.app.renderer;
        const device = r.gpu?.device;
        const gl = r.gl;
        const wait = async () => {
          if (device) await device.queue.onSubmittedWorkDone();
          else if (gl) { const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        };
        // count draw calls by wrapping the low-level draw entry points for one frame
        let draws = 0;
        let bundles = 0; // WebGPU render bundles replayed (their draws are recorded once, not counted above)
        const unwrap = [];
        const wrap = (obj, name) => {
          if (!obj || typeof obj[name] !== 'function') return;
          const orig = obj[name];
          obj[name] = function (...a) { draws++; return orig.apply(this, a); };
          unwrap.push(() => { obj[name] = orig; });
        };
        if (gl) for (const f of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) wrap(gl, f);
        if (device) {
          const origCreate = device.createCommandEncoder.bind(device);
          device.createCommandEncoder = (d) => {
            const enc = origCreate(d);
            const origPass = enc.beginRenderPass.bind(enc);
            enc.beginRenderPass = (pd) => {
              const pass = origPass(pd);
              for (const f of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) wrap(pass, f);
              if (typeof pass.executeBundles === 'function') {
                const ex = pass.executeBundles.bind(pass);
                pass.executeBundles = (list) => { bundles += list.length; return ex(list); };
              }
              return pass;
            };
            return enc;
          };
          unwrap.push(() => { device.createCommandEncoder = origCreate; });
        }
        game.stage.render();
        await wait();
        const drawCalls = draws;
        const bundlesReplayed = bundles;
        for (const u of unwrap) u();
        // performance.now is frozen (see addInitScript): time with the real clock saved in the page
        const now = window.__realNow;
        const times = [], cpu = [];
        for (let i = 0; i < n; i++) {
          const t0 = now();
          game.stage.render();
          const t1 = now(); // JS + command submission only (what a real GPU would not hide)
          await wait();
          times.push(now() - t0);
          cpu.push(t1 - t0);
        }
        const med = (a) => +a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(1);
        return { drawCalls, bundlesReplayed, frames: n, submitMsMedian: med(cpu), frameMsMedian: med(times) };
      }, args.perf);
    }
  } catch (e) {
    failed = true;
    run.errors.push(`script: ${e && e.stack || e}`);
  }
  // Chrome reports WebGPU validation / pipeline errors as console warnings.
  run.gpuWarnings = run.warnings.filter((w) => /webgpu|wgsl|pipeline|validation|GPU/i.test(w) && !/GL Driver Message/.test(w));
  if (run.errors.length || run.gpuWarnings.length) failed = true;
  await browser.close();
}
server.close();

// ---------------------------------------------------------------- compare
const names = steps.filter((s) => s.op === 'shot').map((s) => s.val);
const [ba, bb] = args.backends.split(',');
if (bb && names.length) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const name of names) {
    const fa = join(args.out, `${name}-${ba}.png`);
    const fb = join(args.out, `${name}-${bb}.png`);
    if (!existsSync(fa) || !existsSync(fb)) continue;
    const r = await page.evaluate(async ([a, b]) => {
      const load = (src) => new Promise((ok, err) => { const im = new Image(); im.onload = () => ok(im); im.onerror = err; im.src = src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = ia.width, h = ia.height;
      const get = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, w, h).data; };
      const da = get(ia), db = get(ib);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      const out = x.createImageData(w, h);
      let over16 = 0, over48 = 0, sum = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        sum += (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])) / 3;
        if (d > 16) over16++;
        if (d > 48) over48++;
        const v = Math.min(255, d * 4);
        const g = (da[i] + da[i + 1] + da[i + 2]) / 12;
        out.data[i] = Math.max(v, g); out.data[i + 1] = g; out.data[i + 2] = g; out.data[i + 3] = 255;
      }
      x.putImageData(out, 0, 0);
      const n = w * h;
      return { over16: +(100 * over16 / n).toFixed(2), over48: +(100 * over48 / n).toFixed(2), meanAbs: +(sum / n).toFixed(2), png: c.toDataURL('image/png') };
    }, [`data:image/png;base64,${readFileSync(fa).toString('base64')}`, `data:image/png;base64,${readFileSync(fb).toString('base64')}`]);
    const diffFile = join(args.out, `${name}-diff.png`);
    writeFileSync(diffFile, Buffer.from(r.png.split(',')[1], 'base64'));
    result.compare[name] = { pctOver16: r.over16, pctOver48: r.over48, meanAbs: r.meanAbs, diff: diffFile };
  }
  await browser.close();
}

for (const run of Object.values(result.runs)) if (!run.warnings.length) delete run.warnings;
console.log(JSON.stringify(result, null, 2));
process.exit(failed ? 1 : 0);
