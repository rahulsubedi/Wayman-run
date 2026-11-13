#!/usr/bin/env node
// Numeric audio verification. Bundles src/audio/offline.ts with Vite, loads it in headless
// Chromium and renders every sfx and ~16 s of each music mode through an OfflineAudioContext
// (the same synth code the game uses), then checks level, length, NaNs, spectral distinctness
// and musical rhythm. Exits non-zero if a check fails.
//
//   node scripts/audio-verify.mjs [--json out.json]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = await import(join(ROOT, 'node_modules/vite/dist/node/index.js'));

const out = mkdtempSync(join(tmpdir(), 'wr-audio-'));
await build({
  root: ROOT,
  configFile: false,
  logLevel: 'error',
  build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: join(ROOT, 'scripts/audio-entry.ts'), formats: ['iife'], name: 'WRAudio', fileName: () => 'audio.js' } },
});
const bundle = readFileSync(join(out, 'audio.js'), 'utf8');

/* eslint-disable */
// Runs inside the page.
async function analyse(names) {
  const A = window.WRAudio;

  function fftMag(x, n) {
    // iterative radix-2 FFT, returns magnitude spectrum (n/2 bins)
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < Math.min(n, x.length); i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (Math.min(n, x.length) - 1 || 1)));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    const mag = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }
  function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
  function stats(s) {
    let peak = 0, sum = 0, nan = 0;
    for (let i = 0; i < s.length; i++) {
      const v = s[i];
      if (!Number.isFinite(v)) { nan++; continue; }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / s.length), nan };
  }
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
  function activeLength(s, sr, thresh = 0.002) {
    let first = -1, last = -1;
    for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > thresh) { if (first < 0) first = i; last = i; }
    return first < 0 ? { start: 0, dur: 0 } : { start: first / sr, dur: (last - first) / sr };
  }
  function centroid(s, sr, start, dur) {
    const i0 = Math.floor(start * sr), n = Math.min(Math.floor(dur * sr) + 1, 65536);
    const seg = s.subarray(i0, i0 + n);
    const N = pow2(Math.max(seg.length, 1024));
    const mag = fftMag(seg, N);
    let num = 0, den = 0, bestI = 0, best = 0;
    for (let i = 1; i < mag.length; i++) {
      const f = (i * sr) / N, p = mag[i] * mag[i];
      num += f * p; den += p;
      if (mag[i] > best) { best = mag[i]; bestI = i; }
    }
    return { centroid: den > 0 ? num / den : 0, peakHz: (bestI * sr) / N };
  }
  function dominantHz(s, sr, start, dur) { return centroid(s, sr, start, dur).peakHz; }

  const result = { sfx: {}, music: {}, coin: {} };

  for (const name of names) {
    const r = await A.renderSfx(name);
    const rawR = await A.renderSfx(name, { raw: true });
    const st = stats(r.samples), raw = stats(rawR.samples);
    const act = activeLength(r.samples, r.sampleRate);
    const c = centroid(r.samples, r.sampleRate, act.start, Math.min(act.dur, 1.2));
    result.sfx[name] = {
      peak: +st.peak.toFixed(3), rawPeak: +raw.peak.toFixed(3), rmsDb: +db(st.rms).toFixed(1), nan: st.nan,
      duration: +act.dur.toFixed(3), centroidHz: Math.round(c.centroid), peakHz: Math.round(c.peakHz),
    };
  }

  // coin pitch climb: dominant frequency of ping 1 at combo steps 0, 3, 7
  for (const k of [0, 3, 7]) {
    const r = await A.renderSfx('coin', { step: k });
    const act = activeLength(r.samples, r.sampleRate);
    result.coin['step' + k] = Math.round(dominantHz(r.samples, r.sampleRate, act.start, 0.06));
  }
  // burst of 20 coins 40 ms apart, with the engine's per-name limits NOT applied (worst case): peak must stay < 1
  const burst = await A.renderCoinBurst(20, 0.04);
  const bs = stats(burst.samples);
  result.coin.burst20 = { peak: +bs.peak.toFixed(3), rmsDb: +db(bs.rms).toFixed(1), nan: bs.nan };

  // music
  const cases = [['run', 0], ['run', 0.5], ['run', 1], ['menu', 0]];
  for (const [style, inten] of cases) {
    const seconds = 16;
    const r = await A.renderMusic(style, seconds, inten);
    const rawR = await A.renderMusic(style, seconds, inten, { raw: true });
    const sr = r.sampleRate, s = r.samples;
    const st = stats(s), raw = stats(rawR.samples);
    const bpm = style === 'menu' ? 96 : 118 + 14 * inten;
    // Onset envelope: full-band energy per 10 ms hop, positive flux.
    const hop = Math.round(sr * 0.01);
    const frames = Math.floor((seconds * sr) / hop);
    const env = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      let e = 0;
      for (let i = f * hop; i < (f + 1) * hop; i++) e += s[i] * s[i];
      env[f] = Math.sqrt(e / hop);
    }
    const flux = new Float64Array(frames);
    for (let f = 1; f < frames; f++) flux[f] = Math.max(0, env[f] - env[f - 1]);
    // autocorrelation of flux between 0.25 and 1.2 s
    let bestLag = 0, bestV = -1;
    const mean = flux.reduce((a, b) => a + b, 0) / frames;
    const ac = (lag) => { let v = 0; for (let f = 0; f + lag < frames; f++) v += (flux[f] - mean) * (flux[f + lag] - mean); return v; };
    const ac0 = ac(0);
    const acs = [];
    for (let lag = 25; lag <= 260; lag++) { const v = ac(lag); acs[lag] = v; if (v > bestV) { bestV = v; bestLag = lag; } }
    // prefer the shortest strong local maximum (fundamental period) over its multiples
    for (let lag = 26; lag < bestLag; lag++) if (acs[lag] >= 0.8 * bestV && acs[lag] >= acs[lag - 1] && acs[lag] >= acs[lag + 1]) { bestLag = lag; bestV = acs[lag]; break; }
    const beatSec = 60 / bpm;
    // is the best lag a multiple/half of the beat period? (beat, bar = 4 beats, half-beat)
    const lagSec = bestLag * 0.01;
    const ratio = lagSec / beatSec;
    const nearMultiple = [0.5, 1, 2, 4, 8].some((m) => Math.abs(ratio - m) < 0.08 * m);
    // count onsets: flux peaks above 3x median
    const sorted = Array.from(flux).sort((a, b) => a - b);
    const thr = Math.max(sorted[Math.floor(frames * 0.9)] * 1.0, 1e-4);
    let onsets = 0;
    for (let f = 2; f < frames - 1; f++) if (flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] > flux[f + 1]) onsets++;
    // per-second loudness variation (rhythmic energy, not a flat drone)
    const perSec = [];
    for (let k = 0; k < seconds; k++) { let e = 0; const a = k * sr; for (let i = a; i < a + sr; i++) e += s[i] * s[i]; perSec.push(Math.sqrt(e / sr)); }
    const cen = centroid(s, sr, 0.5, 6);
    const frameDb = Array.from(env).map(db);
    const lo = frameDb.slice().sort((a, b) => a - b);
    result.music[`${style}@${inten}`] = {
      expectedBpm: +bpm.toFixed(1), peak: +st.peak.toFixed(3), rawPeak: +raw.peak.toFixed(3), rmsDb: +db(st.rms).toFixed(1), nan: st.nan,
      centroidHz: Math.round(cen.centroid), onsetsPerSec: +(onsets / seconds).toFixed(2),
      acBestLagSec: +lagSec.toFixed(2), acEstBpmFromLag: +(60 / lagSec).toFixed(1), lagVsBeat: +ratio.toFixed(2), lagIsBeatMultiple: nearMultiple,
      acPeakNorm: +(bestV / ac0).toFixed(2),
      crestDb: +(db(st.peak) - db(st.rms)).toFixed(1), envDynRangeDb: +(lo[Math.floor(lo.length * 0.95)] - lo[Math.floor(lo.length * 0.2)]).toFixed(1),
      rmsPerSecDb: perSec.map((x) => +db(x).toFixed(0)),
    };
  }
  return result;
}
/* eslint-enable */

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: bundle });
const names = await page.evaluate(() => window.WRAudio.SFX_NAMES);
const res = await page.evaluate(analyse, names);
await browser.close();

const fails = [];
const pad = (v, n) => String(v).padStart(n);
console.log('\nSFX (peak = after limiter chain, raw = before compressor/clipper)');
console.log('name         peak   raw   rmsdB  dur(s)  centroid  peakHz');
for (const [n, r] of Object.entries(res.sfx)) {
  console.log(`${n.padEnd(12)} ${pad(r.peak, 5)} ${pad(r.rawPeak, 5)} ${pad(r.rmsDb, 6)} ${pad(r.duration, 7)} ${pad(r.centroidHz, 8)} ${pad(r.peakHz, 7)}`);
  if (r.nan) fails.push(`${n}: NaN samples`);
  if (r.peak < 0.05) fails.push(`${n}: silent (peak ${r.peak})`);
  if (r.peak >= 0.98) fails.push(`${n}: clipping (peak ${r.peak})`);
  if (r.rawPeak >= 1) fails.push(`${n}: raw synth peak >= 1 (${r.rawPeak})`);
  if (r.duration < 0.02 || r.duration > 2.2) fails.push(`${n}: odd duration ${r.duration}`);
}
// distinctness: no two effects with centroid within 12% AND duration within 30%
const entries = Object.entries(res.sfx);
const closePairs = [];
for (let i = 0; i < entries.length; i++)
  for (let j = i + 1; j < entries.length; j++) {
    const [a, x] = entries[i], [b, y] = entries[j];
    const dc = Math.abs(Math.log(x.centroidHz / y.centroidHz)), dd = Math.abs(Math.log(Math.max(x.duration, 0.01) / Math.max(y.duration, 0.01)));
    if (dc < 0.12 && dd < 0.3) closePairs.push(`${a}~${b}`);
  }
console.log('\nindistinct pairs (centroid within 12% and duration within 30%):', closePairs.length ? closePairs.join(', ') : 'none');
if (closePairs.length) fails.push('indistinct sfx: ' + closePairs.join(', '));

console.log('\nCoin pitch climb (dominant Hz of first ping):', res.coin.step0, res.coin.step3, res.coin.step7);
if (!(res.coin.step3 > res.coin.step0 * 1.15 && res.coin.step7 > res.coin.step3 * 1.1)) fails.push('coin pitch does not climb');
console.log('20-coin burst @40ms (worst case, no engine voice limit):', JSON.stringify(res.coin.burst20));
if (res.coin.burst20.peak >= 0.98 || res.coin.burst20.nan) fails.push('coin burst clips');

console.log('\nMUSIC (16 s each)');
for (const [k, m] of Object.entries(res.music)) {
  console.log(`${k.padEnd(9)} bpm=${m.expectedBpm} peak=${m.peak} raw=${m.rawPeak} rms=${m.rmsDb}dB centroid=${m.centroidHz}Hz onsets/s=${m.onsetsPerSec} acLag=${m.acBestLagSec}s (=${m.acEstBpmFromLag}bpm, x${m.lagVsBeat} beat) acNorm=${m.acPeakNorm} crest=${m.crestDb}dB envRange=${m.envDynRangeDb}dB`);
  console.log(`          rms/sec(dB): ${m.rmsPerSecDb.join(' ')}`);
  if (m.nan) fails.push(`music ${k}: NaN`);
  if (m.rmsDb < -45) fails.push(`music ${k}: too quiet`);
  if (m.peak >= 0.98) fails.push(`music ${k}: clipping`);
  if (!m.lagIsBeatMultiple) fails.push(`music ${k}: onset periodicity ${m.acBestLagSec}s is not a beat multiple of ${(60 / m.expectedBpm).toFixed(2)}s`);
  if (m.onsetsPerSec < 2) fails.push(`music ${k}: too few onsets`);
}
const quietSfx = Math.min(...Object.values(res.sfx).map((s) => s.rmsDb));
const loudMusic = Math.max(...Object.values(res.music).map((m) => m.rmsDb));
console.log(`\nbalance: loudest music rms ${loudMusic} dB vs sfx rms range ${quietSfx}..${Math.max(...Object.values(res.sfx).map((s) => s.rmsDb))} dB; music peak max ${Math.max(...Object.values(res.music).map((m) => m.peak))}`);
const rms0 = res.music['run@0'].rmsDb, rms1 = res.music['run@1'].rmsDb, c0 = res.music['run@0'].centroidHz, c1 = res.music['run@1'].centroidHz;
console.log(`intensity adds energy/brightness: rms ${rms0} -> ${rms1} dB, centroid ${c0} -> ${c1} Hz`);
if (!(c1 > c0 * 1.05 || rms1 > rms0 + 0.5)) fails.push('intensity does not change the mix');

if (errors.length) fails.push('page errors: ' + errors.join(' | '));
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0) writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(res, null, 2));
console.log(fails.length ? '\nFAILED:\n - ' + fails.join('\n - ') : '\nALL AUDIO CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
