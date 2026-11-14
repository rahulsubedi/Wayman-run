#!/usr/bin/env node
// `npm run build:artifact`: builds dist-artifact/wayman-run.html, a single self-contained HTML
// FRAGMENT (no doctype/html/head/body: the host wraps it) with all CSS and JS inline.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-artifact');
const TMP = join(OUT, '.tmp');

const require = createRequire(import.meta.url);
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const r = spawnSync(process.execPath, [viteBin, 'build', '-c', 'vite.artifact.config.ts'], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);

const files = readdirSync(TMP);
const unexpected = files.filter((f) => f !== 'bundle.js' && f !== 'bundle.css');
if (unexpected.length) throw new Error(`unexpected build outputs: ${unexpected.join(', ')}`);
let js = readFileSync(join(TMP, 'bundle.js'), 'utf8');
const css = files.includes('bundle.css') ? readFileSync(join(TMP, 'bundle.css'), 'utf8') : '';

// A literal "</script" (or "<!--") inside an inline script would end / confuse it: escape.
js = js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const safeCss = css.replace(/<\/(style)/gi, '<\\/$1');

// Single-look page. Sizing: html/body 100% (the host's :root carries safe-area padding, so border-box).
const base = `
:root { color-scheme: dark; background: #0f1d36; box-sizing: border-box; }
*, *::before, *::after { box-sizing: inherit; }
html, body { margin: 0; height: 100%; overflow: hidden; background: #0f1d36; color: #fff3d6; touch-action: none; overscroll-behavior: none; -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; }
body { position: relative; }
#game, #ui { position: absolute; inset: 0; }
#game canvas { display: block; touch-action: none; }
#ui { pointer-events: none; overflow: hidden; }
#game { overflow: hidden; }
#wr-boot { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; background: radial-gradient(ellipse at 50% 40%, #1d3f73, #0f1d36 70%); color: #fff3d6; font: 900 italic 40px/1 'Arial Black', system-ui, sans-serif; letter-spacing: 0.04em; transition: opacity 0.45s; pointer-events: none; }
#wr-boot span { color: #ff8a1f; }
#wr-boot i { display: block; width: 120px; height: 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.18); overflow: hidden; }
#wr-boot i::after { content: ''; display: block; width: 40%; height: 100%; border-radius: 8px; background: #17c3b2; animation: wr-load 1s ease-in-out infinite alternate; }
#wr-boot.wr-boot-out { opacity: 0; }
@keyframes wr-load { from { transform: translateX(-10%); } to { transform: translateX(160%); } }
`;

const html = `<title>Wayman Run</title>
<style>${base}${safeCss}</style>
<div id="game"></div>
<div id="ui"></div>
<div id="wr-boot" role="status" aria-label="Loading"><div>WAYMAN <span>RUN</span></div><i></i></div>
<noscript>Wayman Run needs JavaScript.</noscript>
<script type="module">${js}</script>
`;

writeFileSync(join(OUT, 'wayman-run.html'), html);
rmSync(TMP, { recursive: true, force: true });
const raw = Buffer.byteLength(html);
console.log(`dist-artifact/wayman-run.html: ${(raw / 1024).toFixed(0)} KiB raw, ${(gzipSync(html, { level: 9 }).length / 1024).toFixed(0)} KiB gzip`);
