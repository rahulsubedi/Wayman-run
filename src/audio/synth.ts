// Sound-effect voices. Every function targets any BaseAudioContext (live or Offline) and an
// output node, so the same code can be rendered offline for verification.

export type SfxName =
  | 'coin'
  | 'jump'
  | 'land'
  | 'roll'
  | 'lane'
  | 'crash'
  | 'stumble'
  | 'pickup'
  | 'powerupEnd'
  | 'shieldBreak'
  | 'nearMiss'
  | 'zone'
  | 'click';

export interface SfxOptions {
  /** Coin combo step (0 = first pickup, climbs while pickups come quickly). */
  step?: number;
  /** Master level multiplier for this one voice. */
  gain?: number;
}

/** Voice descriptor returned by a synth function: how long it rings and how many nodes it used. */
export interface VoiceInfo {
  duration: number;
  voices: number;
}

// ------------------------------------------------------------------ primitives

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
let noiseCursor = 0;

/** 2 s of deterministic white noise (LCG), cached per context. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const len = Math.floor(ctx.sampleRate * 2);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 0x9e3779b9;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

export interface ToneOpts {
  type?: OscillatorType;
  f0: number;
  /** End frequency (exponential glide). Defaults to f0. */
  f1?: number;
  dur: number;
  vol: number;
  attack?: number;
  /** Peak is held this long before decaying (seconds). */
  hold?: number;
  detune?: number;
  /** Optional lowpass cutoff (fixed). */
  lp?: number;
  pan?: number;
}

/** One oscillator voice with attack/decay envelope. Returns the node count used. */
export function tone(ctx: BaseAudioContext, out: AudioNode, t: number, o: ToneOpts): number {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1 !== undefined && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1), t + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  const a = o.attack ?? 0.004;
  const hold = o.hold ?? 0;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(o.vol, t + a);
  if (hold > 0) g.gain.setValueAtTime(o.vol, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  let node: AudioNode = osc;
  node.connect(g);
  node = g;
  if (o.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lp;
    node.connect(f);
    node = f;
  }
  if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    node.connect(p);
    node = p;
  }
  node.connect(out);
  osc.start(t);
  osc.stop(t + o.dur + 0.03);
  return 1;
}

export interface NoiseOpts {
  dur: number;
  vol: number;
  filter?: BiquadFilterType;
  f0?: number;
  f1?: number;
  /** Filter frequency reached at the `peak` position (sweep up then down). */
  fMid?: number;
  q?: number;
  attack?: number;
  /** Peak position as a fraction of dur (for up-down swells). Default: immediately at attack. */
  peak?: number;
  pan0?: number;
  pan1?: number;
}

/** Filtered noise burst with an optional frequency sweep. */
export function noise(ctx: BaseAudioContext, out: AudioNode, t: number, o: NoiseOpts): number {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const g = ctx.createGain();
  const a = o.attack ?? 0.003;
  g.gain.setValueAtTime(0.0001, t);
  if (o.peak !== undefined) {
    g.gain.linearRampToValueAtTime(o.vol, t + o.dur * o.peak);
  } else {
    g.gain.linearRampToValueAtTime(o.vol, t + a);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  let node: AudioNode = src;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    const f0 = o.f0 ?? 1000;
    f.frequency.setValueAtTime(f0, t);
    if (o.fMid !== undefined && o.peak !== undefined) f.frequency.exponentialRampToValueAtTime(o.fMid, t + o.dur * o.peak);
    if (o.f1 !== undefined && (o.f1 !== f0 || o.fMid !== undefined)) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    f.Q.value = o.q ?? 0.8;
    node.connect(f);
    node = f;
  }
  node.connect(g);
  node = g;
  if (o.pan0 !== undefined && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(o.pan0, t);
    if (o.pan1 !== undefined) p.pan.linearRampToValueAtTime(o.pan1, t + o.dur);
    node.connect(p);
    node = p;
  }
  node.connect(out);
  const offset = (noiseCursor = (noiseCursor + 0.37) % 1.5);
  src.start(t, offset);
  src.stop(t + o.dur + 0.03);
  return 1;
}

/** Semitone ratio. */
export const semi = (n: number): number => Math.pow(2, n / 12);

// Major pentatonic climb used by the coin combo (semitones above the base note).
const COIN_CLIMB = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

// ------------------------------------------------------------------ the voices

type Voice = (ctx: BaseAudioContext, out: AudioNode, t: number, o: SfxOptions) => VoiceInfo;

const coin: Voice = (ctx, out, t, o) => {
  const step = Math.max(0, Math.min(COIN_CLIMB.length - 1, o.step ?? 0));
  const f = 988 * semi(COIN_CLIMB[step]); // B5 and up
  let n = 0;
  n += tone(ctx, out, t, { type: 'triangle', f0: f, dur: 0.16, vol: 0.34, attack: 0.002 });
  n += tone(ctx, out, t, { type: 'sine', f0: f * 2, dur: 0.1, vol: 0.1, attack: 0.002 });
  n += tone(ctx, out, t + 0.065, { type: 'triangle', f0: f * 1.5, dur: 0.24, vol: 0.34, attack: 0.002 });
  n += tone(ctx, out, t + 0.065, { type: 'sine', f0: f * 3, dur: 0.14, vol: 0.09, attack: 0.002 });
  return { duration: 0.31, voices: n };
};

const jump: Voice = (ctx, out, t) => {
  let n = 0;
  n += tone(ctx, out, t, { type: 'triangle', f0: 260, f1: 700, dur: 0.2, vol: 0.28, attack: 0.012, lp: 3000 });
  n += noise(ctx, out, t, { dur: 0.22, vol: 0.2, filter: 'bandpass', f0: 500, f1: 2600, q: 1.1, attack: 0.03 });
  return { duration: 0.25, voices: n };
};

const land: Voice = (ctx, out, t) => {
  let n = 0;
  n += tone(ctx, out, t, { type: 'sine', f0: 135, f1: 48, dur: 0.18, vol: 0.55, attack: 0.002 });
  n += noise(ctx, out, t, { dur: 0.09, vol: 0.28, filter: 'lowpass', f0: 900, f1: 260, q: 0.7 });
  return { duration: 0.21, voices: n };
};

const roll: Voice = (ctx, out, t) => {
  let n = 0;
  n += noise(ctx, out, t, { dur: 0.3, vol: 0.34, filter: 'bandpass', f0: 3000, f1: 650, q: 1.4, attack: 0.02, peak: 0.25 });
  n += tone(ctx, out, t, { type: 'sine', f0: 240, f1: 150, dur: 0.22, vol: 0.1, attack: 0.01 });
  return { duration: 0.33, voices: n };
};

const lane: Voice = (ctx, out, t) => {
  let n = 0;
  n += tone(ctx, out, t, { type: 'triangle', f0: 1250, f1: 880, dur: 0.045, vol: 0.2, attack: 0.001 });
  n += noise(ctx, out, t, { dur: 0.025, vol: 0.1, filter: 'highpass', f0: 4500 });
  return { duration: 0.08, voices: n };
};

const stumble: Voice = (ctx, out, t) => {
  let n = 0;
  n += tone(ctx, out, t, { type: 'sine', f0: 190, f1: 85, dur: 0.24, vol: 0.5, attack: 0.002 });
  n += tone(ctx, out, t + 0.07, { type: 'triangle', f0: 150, f1: 70, dur: 0.2, vol: 0.28, attack: 0.002, lp: 700 });
  n += noise(ctx, out, t, { dur: 0.12, vol: 0.25, filter: 'lowpass', f0: 1200, f1: 300 });
  return { duration: 0.3, voices: n };
};

const pickup: Voice = (ctx, out, t) => {
  let n = 0;
  const notes = [1047, 1319, 1568, 2093, 2637]; // C6 E6 G6 C7 E7
  for (let i = 0; i < notes.length; i++) {
    const tt = t + i * 0.058;
    n += tone(ctx, out, tt, { type: 'triangle', f0: notes[i], dur: 0.26, vol: 0.26, attack: 0.002 });
    n += tone(ctx, out, tt, { type: 'sine', f0: notes[i] * 2, dur: 0.14, vol: 0.07, attack: 0.002 });
  }
  n += noise(ctx, out, t, { dur: 0.45, vol: 0.05, filter: 'highpass', f0: 7500, attack: 0.1, peak: 0.4 });
  return { duration: 0.6, voices: n };
};

const powerupEnd: Voice = (ctx, out, t) => {
  let n = 0;
  const notes = [784, 659, 523]; // G5 E5 C5
  for (let i = 0; i < notes.length; i++) {
    n += tone(ctx, out, t + i * 0.085, { type: 'square', f0: notes[i], dur: 0.1, vol: 0.12, attack: 0.002, lp: 1800 });
  }
  return { duration: 0.33, voices: n };
};

const shieldBreak: Voice = (ctx, out, t) => {
  let n = 0;
  n += noise(ctx, out, t, { dur: 0.32, vol: 0.38, filter: 'highpass', f0: 3800, f1: 7500, q: 0.6 });
  const partials = [2300, 3100, 4100, 5200, 6400];
  for (let i = 0; i < partials.length; i++) {
    n += tone(ctx, out, t + i * 0.012, { type: 'sine', f0: partials[i], f1: partials[i] * 0.72, dur: 0.22 + i * 0.03, vol: 0.12, attack: 0.001 });
  }
  n += tone(ctx, out, t, { type: 'triangle', f0: 520, f1: 180, dur: 0.18, vol: 0.28, attack: 0.002 });
  return { duration: 0.5, voices: n };
};

const nearMiss: Voice = (ctx, out, t) => {
  let n = 0;
  // Doppler-ish: a fast pass-by whose pitch/brightness rise then fall, panning across.
  n += noise(ctx, out, t, { dur: 0.34, vol: 0.34, filter: 'bandpass', f0: 450, fMid: 2400, f1: 380, q: 1.3, peak: 0.4, pan0: -0.6, pan1: 0.6 });
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(420, t);
  o.frequency.exponentialRampToValueAtTime(900, t + 0.12);
  o.frequency.exponentialRampToValueAtTime(300, t + 0.34);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.07, t + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  o.connect(g).connect(lp).connect(out);
  o.start(t);
  o.stop(t + 0.37);
  n += 1;
  return { duration: 0.38, voices: n };
};

const zone: Voice = (ctx, out, t) => {
  let n = 0;
  const notes = [523, 784, 1047, 1319]; // C5 G5 C6 E6
  for (let i = 0; i < notes.length; i++) {
    const tt = t + i * 0.11;
    n += tone(ctx, out, tt, { type: 'sine', f0: notes[i], dur: 1.1, vol: 0.2, attack: 0.012 });
    n += tone(ctx, out, tt, { type: 'triangle', f0: notes[i] * 2.005, dur: 0.6, vol: 0.05, attack: 0.012 });
  }
  return { duration: 1.6, voices: n };
};

const crash: Voice = (ctx, out, t) => {
  let n = 0;
  n += tone(ctx, out, t, { type: 'sine', f0: 160, f1: 34, dur: 0.45, vol: 0.8, attack: 0.002 });
  n += tone(ctx, out, t, { type: 'sawtooth', f0: 110, f1: 38, dur: 0.35, vol: 0.2, attack: 0.002, lp: 600 });
  n += noise(ctx, out, t, { dur: 0.85, vol: 0.55, filter: 'lowpass', f0: 7000, f1: 350, q: 0.7 });
  n += noise(ctx, out, t, { dur: 0.05, vol: 0.4, filter: 'highpass', f0: 2500 });
  return { duration: 0.95, voices: n };
};

const click: Voice = (ctx, out, t) => {
  const n = tone(ctx, out, t, { type: 'triangle', f0: 880, f1: 660, dur: 0.06, vol: 0.2, attack: 0.001 });
  return { duration: 0.09, voices: n };
};

export const SFX_VOICES: Readonly<Record<SfxName, Voice>> = {
  coin,
  jump,
  land,
  roll,
  lane,
  crash,
  stumble,
  pickup,
  powerupEnd,
  shieldBreak,
  nearMiss,
  zone,
  click,
};

/** Relative loudness trim per sfx so the set sits evenly. */
export const SFX_GAIN: Readonly<Record<SfxName, number>> = {
  coin: 1,
  jump: 1.45,
  land: 1.05,
  roll: 1.5,
  lane: 1.6,
  crash: 0.7,
  stumble: 1,
  pickup: 1,
  powerupEnd: 1.5,
  shieldBreak: 0.9,
  nearMiss: 1.5,
  zone: 0.9,
  click: 1.3,
};

export const SFX_NAMES = Object.keys(SFX_VOICES) as SfxName[];

/** Per-name minimum spacing in seconds (stops stacked retriggers) and max overlapping instances. */
export const SFX_LIMITS: Readonly<Record<SfxName, { gap: number; max: number }>> = {
  coin: { gap: 0.03, max: 4 },
  jump: { gap: 0.08, max: 2 },
  land: { gap: 0.08, max: 2 },
  roll: { gap: 0.08, max: 2 },
  lane: { gap: 0.05, max: 3 },
  crash: { gap: 0.3, max: 1 },
  stumble: { gap: 0.2, max: 1 },
  pickup: { gap: 0.15, max: 2 },
  powerupEnd: { gap: 0.15, max: 2 },
  shieldBreak: { gap: 0.2, max: 1 },
  nearMiss: { gap: 0.15, max: 2 },
  zone: { gap: 1, max: 1 },
  click: { gap: 0.04, max: 2 },
};

/** Plays `name` on `out` starting at `t`. Pure with respect to engine state. */
export function playSfx(ctx: BaseAudioContext, out: AudioNode, t: number, name: SfxName, opts: SfxOptions = {}): VoiceInfo {
  const level = (opts.gain ?? 1) * SFX_GAIN[name];
  if (level === 1) return SFX_VOICES[name](ctx, out, t, opts);
  const g = ctx.createGain();
  g.gain.value = level;
  g.connect(out);
  return SFX_VOICES[name](ctx, g, t, opts);
}
