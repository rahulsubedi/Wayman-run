#!/usr/bin/env node
// Sandbox check of dist-artifact/wayman-run.html (build it first: `npm run build:artifact`).
//
// Wraps the fragment in the host's skeleton, serves it with a strict CSP (no 'unsafe-eval', scripts
// only inline or from the CDN allowlist) and loads it in headless Chromium inside an
// <iframe sandbox="allow-scripts allow-same-origin"> and again inside sandbox="allow-scripts" (opaque
// origin: localStorage throws), at 1280x720 and 390x844. Asserts per run:
//   - no CSP violation (securitypolicyviolation events) and no console error / page error,
//   - no network request besides the parent page and the frame document,
//   - the game boots to the menu, Play starts a run (mode 'running'),
//   - the canvas is non-blank and fills the frame, nothing scrolls (frame and parent),
//   - after stepping with __wayman.advance the HUD is visible, inside the frame and shows a score.
// Screenshots go to shots/artifact/. Exit code is non-zero on any failure.
// Software rendering is slow (~100 ms/frame): the game is stepped with the debug hook, never waited on.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'dist-artifact/wayman-run.html');
const SHOTS = join(ROOT, 'shots/artifact');
if (!existsSync(FILE)) {
  console.error('dist-artifact/wayman-run.html not found: run `npm run build:artifact` first');
  process.exit(2);
}
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const fragment = readFileSync(FILE, 'utf8');

const failures = [];
const fail = (where, msg) => {
  failures.push(`${where}: ${msg}`);
  console.log(`  FAIL ${msg}`);
};
const ok = (msg) => console.log(`  ok   ${msg}`);

// ---- fragment rules (the host prepends its own skeleton, so the file must be content only)
{
  const before = failures.length;
  if (!fragment.slice(0, 8192).includes('<title>Wayman Run</title>') || !/^\s*<title>/.test(fragment)) fail('file', 'must start with <title>Wayman Run</title> within 8 KB');
  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(fragment)) fail('file', 'contains doctype/html/head/body tags');
  if (/<link[^>]+rel=["']?(modulepreload|stylesheet|icon)/i.test(fragment)) fail('file', 'contains a <link> (modulepreload/stylesheet/icon)');
  if (/sourceMappingURL/.test(fragment)) fail('file', 'contains a source map reference');
  if ((fragment.match(/<script/gi) || []).length !== 1 || (fragment.match(/<\/script>/gi) || []).length !== 1) fail('file', 'expected exactly one <script>');
  if (Buffer.byteLength(fragment) > 16 * 1024 * 1024) fail('file', 'larger than 16 MB');
  if (failures.length === before) ok(`fragment shape (${(Buffer.byteLength(fragment) / 1024).toFixed(0)} KiB)`);
}

// ---- the host skeleton, and the CSP the host sends
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data: blob:; font-src https://fonts.gstatic.com; media-src data: blob:; connect-src 'self'; worker-src blob:";
// Harness-only probe, placed first so it sees every violation (inline script is allowed by the CSP).
const probe =
  "<script>window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+e.blockedURI+' '+(e.sample||''))});</script>";
const framePage =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  '<style>:root{color-scheme:light; padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px)} body{margin:0; font:14px system-ui,sans-serif} img{max-width:100%} [hidden]{display:none!important}</style>' +
  probe +
  '</head><body>' +
  fragment +
  '</body></html>';
const parentPage = (sandbox) =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:#888}iframe{display:block;border:0;width:100%;height:100%}</style></head>' +
  `<body><iframe id="f" src="/frame.html" sandbox="${sandbox}" allow="autoplay; fullscreen"></iframe></body></html>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/parent-same') res.writeHead(200, { 'content-type': 'text/html' }).end(parentPage('allow-scripts allow-same-origin'));
  else if (path === '/parent-opaque') res.writeHead(200, { 'content-type': 'text/html' }).end(parentPage('allow-scripts'));
  else if (path === '/frame.html') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP }).end(framePage);
  else res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// Software GL plus a busy compositor occasionally makes the first screenshot of a page slow: retry once.
async function shot(page, path) {
  try {
    await page.screenshot({ path, timeout: 60000 });
  } catch {
    await page.screenshot({ path, timeout: 90000 });
  }
}

async function run(modeName, parentPath, size) {
  const tag = `${modeName} ${size.w}x${size.h}`;
  const slug = `${size.w}x${size.h}-${modeName}`;
  console.log(`\n== ${tag}`);
  const f = (m) => fail(tag, m);
  const pass = (m) => ok(m);
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 1, hasTouch: size.w < 600 });
  const page = await ctx.newPage();
  const requests = [];
  const consoleErrors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`);
  });
  try {
    await page.goto(`${base}${parentPath}`, { waitUntil: 'load' });
    const frame = await (await page.waitForSelector('#f')).contentFrame();
    await frame.waitForFunction(() => window.__wayman, null, { timeout: 15000 });
    const ready = await Promise.race([
      frame.evaluate(() => window.__wayman.ready.then(() => 'ready', (e) => 'failed: ' + e)),
      new Promise((r) => setTimeout(() => r('timeout'), 90000)),
    ]);
    if (ready !== 'ready') {
      f(`boot ${ready}`);
      throw new Error('boot');
    }
    // Software rendering is ~100 ms/frame: stop the real-time ticker, frames come from advance() only.
    await frame.evaluate(() => window.__wayman.game.stage.app.ticker.stop());
    await frame.waitForSelector('#wr-boot', { state: 'detached', timeout: 15000 }).catch(() => f('boot splash was not removed'));
    const mode0 = await frame.evaluate(() => window.__wayman.mode());
    if (mode0 === 'menu') pass('boots to the menu');
    else f(`mode after boot is ${mode0}, expected menu`);
    const storage = await frame.evaluate(() => {
      try {
        localStorage.setItem('x', '1');
        localStorage.removeItem('x');
        return 'works';
      } catch {
        return 'throws';
      }
    });
    console.log(`  info localStorage ${storage}`);
    if ((modeName === 'opaque-origin') !== (storage === 'throws')) f(`localStorage ${storage} in ${modeName} mode: the sandbox emulation is not what was intended`);
    await frame.waitForSelector('.wr-play', { state: 'visible', timeout: 10000 });
    await frame.evaluate(() => window.__wayman.advance(0.05)); // one rendered frame behind the menu
    await page.waitForTimeout(700); // let the menu fade-in settle
    await shot(page, join(SHOTS, `${slug}-menu.png`));

    // layout: canvas fills the frame, nothing scrolls
    const layout = await frame.evaluate(() => {
      const c = document.querySelector('#game canvas');
      const r = c.getBoundingClientRect();
      const de = document.documentElement;
      return {
        cw: r.width, ch: r.height, cx: r.left, cy: r.top, iw: innerWidth, ih: innerHeight,
        sw: Math.max(de.scrollWidth, document.body.scrollWidth), sh: Math.max(de.scrollHeight, document.body.scrollHeight),
        cwid: de.clientWidth, chei: de.clientHeight,
      };
    });
    const near = (a, b) => Math.abs(a - b) <= 1;
    if (near(layout.cw, layout.iw) && near(layout.ch, layout.ih) && near(layout.cx, 0) && near(layout.cy, 0)) pass(`canvas fills the frame (${layout.cw}x${layout.ch})`);
    else f(`canvas ${layout.cw}x${layout.ch}@${layout.cx},${layout.cy} vs frame ${layout.iw}x${layout.ih}`);
    if (layout.sw <= layout.cwid && layout.sh <= layout.chei) pass('frame has no scrollbars (scroll size = client size)');
    else f(`frame scroll ${layout.sw}x${layout.sh} > client ${layout.cwid}x${layout.chei}`);
    const parentScroll = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      h: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    if (parentScroll.w <= 0 && parentScroll.h <= 0) pass('parent page has no scrollbars');
    else f(`parent scrolls by ${parentScroll.w}x${parentScroll.h}`);

    // Play
    await frame.locator('.wr-play').click({ force: true }); // the button pulses, so Playwright never sees it 'stable'
    await frame.waitForFunction(() => window.__wayman.mode() === 'running', null, { timeout: 15000 }).then(
      () => pass('Play starts a run'),
      () => f('Play did not start a run'),
    );
    await frame.evaluate(() => window.__wayman.setAutopilot(true));
    await frame.evaluate(() => window.__wayman.advance(6));
    await page.waitForTimeout(400);

    // canvas non-blank: read the pixels in the same task as a render (no preserveDrawingBuffer)
    const px = await frame.evaluate(() => {
      window.__wayman.game.stage.render();
      const c = document.querySelector('#game canvas');
      const t = document.createElement('canvas');
      t.width = 64;
      t.height = 64;
      const x = t.getContext('2d');
      x.drawImage(c, 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data;
      const seen = new Set();
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
        if (d[i + 3] > 0) opaque++;
      }
      return { colors: seen.size, opaque };
    });
    if (px.opaque > 0 && px.colors >= 8) pass(`canvas is non-blank (${px.colors} distinct colours)`);
    else f(`canvas looks blank (${px.colors} colours, ${px.opaque} opaque px)`);

    // HUD
    const hud = await frame.evaluate(() => {
      const hudEl = document.querySelector('.wr-hud');
      const score = document.querySelector('.wr-score-num');
      const inside = (r) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0;
      return {
        visible: getComputedStyle(hudEl).display !== 'none' && hudEl.classList.contains('wr-visible'),
        score: score.textContent,
        scoreIn: inside(score.getBoundingClientRect()),
        pauseIn: inside(document.querySelector('.wr-pausebtn').getBoundingClientRect()),
        mode: window.__wayman.mode(),
      };
    });
    if (hud.visible && hud.mode === 'running' && Number(hud.score.replace(/\D/g, '')) > 0) pass(`HUD visible, score "${hud.score}"`);
    else f(`HUD not as expected (visible ${hud.visible}, mode ${hud.mode}, score "${hud.score}")`);
    if (hud.scoreIn && hud.pauseIn) pass('HUD elements inside the frame');
    else f('HUD elements outside the frame');
    await shot(page, join(SHOTS, `${slug}-run.png`));

    // CSP / network / errors
    const csp = await frame.evaluate(() => window.__csp);
    if (csp.length === 0) pass('zero CSP violations');
    else f(`CSP violations: ${csp.join(' | ')}`);
    const wayErrs = await frame.evaluate(() => window.__wayman.errors);
    if (wayErrs.length === 0) pass('__wayman.errors empty');
    else f(`__wayman.errors: ${wayErrs.join(' | ').slice(0, 400)}`);
    if (consoleErrors.length === 0) pass('zero console errors / page errors');
    else f(`console: ${consoleErrors.join(' | ').slice(0, 600)}`);
    const extra = requests.filter((u) => u !== `${base}${parentPath}` && u !== `${base}/frame.html`);
    if (extra.length === 0) pass('no network requests besides the page and the frame document');
    else f(`extra requests: ${extra.join(', ')}`);
  } catch (e) {
    if (e.message !== 'boot') f(`exception: ${e.message}`);
    try {
      await page.screenshot({ path: join(SHOTS, `${slug}-failure.png`) });
    } catch {
      /* ignore */
    }
    if (consoleErrors.length) console.log('  console:', consoleErrors.join(' | ').slice(0, 800));
  } finally {
    await ctx.close();
  }
}

for (const size of [{ w: 1280, h: 720 }, { w: 390, h: 844 }]) {
  await run('same-origin', '/parent-same', size);
  await run('opaque-origin', '/parent-opaque', size);
}
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILURE(S):\n${failures.map((x) => ' - ' + x).join('\n')}` : '\nartifact-check: all passed');
process.exit(failures.length ? 1 : 0);
