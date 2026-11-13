#!/usr/bin/env node
// Screenshot the dev model gallery (gallery.html) scene by scene.
//
//   node scripts/gallery-shot.mjs [--out shots/gallery] [--scenes overview,heroA] [--night] [--width 1600 --height 1000]
//
// Starts a Vite dev server on a free port, opens gallery.html in headless Chromium (Playwright),
// calls window.__gallery.show(scene) for each scene and writes <out>/<scene>[-night].png.
// Exits non-zero on page or console errors.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const o = { out: 'shots/gallery', scenes: '', night: false, width: 1600, height: 1000 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  if (k === 'night') o.night = true;
  else if (k in o) o[k] = typeof o[k] === 'number' ? Number(argv[++i]) : argv[++i];
  else throw new Error(`unknown option --${k}`);
}

const server = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const addr = server.httpServer.address();
const url = `http://127.0.0.1:${addr.port}/gallery.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: o.width, height: o.height } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.stack || e.message));
let failed = false;
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__galleryReady, null, { timeout: 120000 });
  await page.evaluate(() => window.__galleryReady);
  const all = await page.evaluate(() => window.__gallery.scenes);
  const scenes = o.scenes ? o.scenes.split(',') : all;
  mkdirSync(resolve(ROOT, o.out), { recursive: true });
  for (const s of scenes) {
    const t0 = Date.now();
    await page.evaluate(([name, night]) => window.__gallery.show(name, { night }), [s, o.night]);
    const file = join(o.out, `${s}${o.night ? '-night' : ''}.png`);
    await page.screenshot({ path: resolve(ROOT, file) });
    const st = await page.evaluate(() => window.__gallery.stats());
    console.log(`${file}  (${Date.now() - t0} ms, ${st.meshes} meshes)`);
  }
} catch (e) {
  failed = true;
  console.error(e);
}
if (errors.length) console.error('page errors:\n' + errors.join('\n'));
await browser.close();
await server.close();
process.exit(failed || errors.length ? 1 : 0);
