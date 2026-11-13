// Original procedural music: a 16-bar form (A section + B section) in C major, scheduled one
// 16th-note step at a time. Everything targets any BaseAudioContext so it can be rendered offline.
//
//   run  : sunny and driving. Drums + bass + pad from the start; chord stabs, lead and sparkle
//          arps join as `intensity` (0..1, game speed) rises. Tempo drifts 118 -> 132 BPM.
//   menu : mellow 96 BPM: soft kick, shaker, warm pad, plucked arp and a sparse lead.

import { noise, tone } from './synth';

export type MusicStyle = 'menu' | 'run';

export interface MusicOut {
  /** Dry music bus. */
  dry: AudioNode;
  /** Send into the echo (feedback delay) bus. */
  echo: AudioNode;
}

export const STEPS_PER_BAR = 16;
export const BARS = 16;
export const LOOP_STEPS = STEPS_PER_BAR * BARS;

// ------------------------------------------------------------------- note data

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(name: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

interface Chord {
  /** Bass root MIDI note. */
  root: number;
  /** Pad / stab voicing (MIDI). */
  tones: readonly number[];
}

const C: Chord = { root: midi('C2'), tones: [midi('C4'), midi('E4'), midi('G4')] };
const G: Chord = { root: midi('G1'), tones: [midi('B3'), midi('D4'), midi('G4')] };
const Am: Chord = { root: midi('A1'), tones: [midi('C4'), midi('E4'), midi('A4')] };
const F: Chord = { root: midi('F1'), tones: [midi('C4'), midi('F4'), midi('A4')] };

const PROGRESSION: readonly Chord[] = [
  // A
  C, G, Am, F, C, G, F, G,
  // B
  Am, F, C, G, Am, F, G, C,
];

/** "step:note:length" triplets per bar (length in 16th steps). */
const LEAD_SRC: readonly string[] = [
  // A: sunny motif, then answer
  '0:E5:3 3:G5:1 4:A5:4 8:G5:2 10:E5:2 12:D5:4',
  '0:D5:3 3:E5:1 4:G5:4 8:E5:2 10:D5:2 12:B4:4',
  '0:C5:3 3:E5:1 4:A5:4 8:G5:2 10:E5:2 12:C5:4',
  '0:A4:3 3:C5:1 4:F5:4 8:E5:2 10:D5:2 12:C5:2 14:D5:2',
  '0:E5:3 3:G5:1 4:C6:4 8:B5:2 10:G5:2 12:E5:4',
  '0:D5:3 3:G5:1 4:B5:4 8:A5:2 10:G5:2 12:D5:4',
  '0:A5:2 2:G5:2 4:F5:4 8:E5:2 10:F5:2 12:G5:2 14:A5:2',
  '0:G5:4 4:B5:2 6:A5:2 8:G5:4 12:D5:2 14:G5:2',
  // B: higher and more rhythmic
  '0:E5:2 2:A5:2 4:C6:2 6:A5:2 8:E5:2 10:A5:2 12:C6:4',
  '0:C6:2 2:A5:2 4:F5:2 6:A5:2 8:C6:4 12:A5:2 14:G5:2',
  '0:G5:2 2:E5:2 4:G5:2 6:C6:2 8:E6:4 12:D6:2 14:C6:2',
  '0:B5:2 2:D6:2 4:G6:4 8:D6:4 12:B5:4',
  '0:C6:2 2:E6:2 4:A5:2 6:C6:2 8:E6:4 12:C6:4',
  '0:A5:2 2:C6:2 4:F6:4 8:E6:2 10:C6:2 12:A5:4',
  '0:D6:2 2:B5:2 4:G5:2 6:B5:2 8:D6:4 12:G5:2 14:A5:2',
  '0:C6:8 8:G5:2 10:E5:2 12:G5:4',
];

interface LeadNote {
  step: number;
  midi: number;
  len: number;
}

/** LEAD[bar] is sorted by step. */
export const LEAD: readonly (readonly LeadNote[])[] = LEAD_SRC.map((bar) =>
  bar.split(' ').map((tok) => {
    const [s, n, l] = tok.split(':');
    return { step: Number(s), midi: midi(n), len: Number(l) };
  }),
);

/** Bass pattern: [step, semitone offset, length in steps]. */
const BASS_RUN: readonly (readonly [number, number, number])[] = [
  [0, 0, 2],
  [3, 0, 1],
  [6, 12, 1],
  [8, 0, 2],
  [10, 7, 1],
  [12, 0, 2],
  [14, 12, 1],
];
const BASS_FILL: readonly (readonly [number, number, number])[] = [
  [0, 0, 2],
  [3, 0, 1],
  [6, 12, 1],
  [8, 0, 2],
  [11, 7, 1],
  [12, 12, 1],
  [13, 7, 1],
  [14, 5, 1],
  [15, 7, 1],
];

// -------------------------------------------------------------------- tempo

export function bpmFor(style: MusicStyle, intensity: number): number {
  return style === 'menu' ? 96 : 118 + 14 * intensity;
}

export function stepDuration(style: MusicStyle, intensity: number): number {
  return 60 / bpmFor(style, intensity) / 4;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------- drums

function kick(ctx: BaseAudioContext, out: AudioNode, t: number, vol: number): void {
  tone(ctx, out, t, { type: 'sine', f0: 155, f1: 44, dur: 0.16, vol, attack: 0.001 });
  tone(ctx, out, t, { type: 'sine', f0: 60, dur: 0.22, vol: vol * 0.55, attack: 0.002 });
  noise(ctx, out, t, { dur: 0.012, vol: vol * 0.25, filter: 'highpass', f0: 2500 });
}

function snare(ctx: BaseAudioContext, out: AudioNode, t: number, vol: number): void {
  noise(ctx, out, t, { dur: 0.16, vol, filter: 'bandpass', f0: 2200, q: 0.7 });
  tone(ctx, out, t, { type: 'triangle', f0: 210, f1: 150, dur: 0.1, vol: vol * 0.6, attack: 0.001 });
}

function hat(ctx: BaseAudioContext, out: AudioNode, t: number, vol: number, open = false): void {
  noise(ctx, out, t, { dur: open ? 0.16 : 0.035, vol, filter: 'highpass', f0: 7500, q: 0.5, attack: 0.001 });
}

function crashCymbal(ctx: BaseAudioContext, out: AudioNode, t: number, vol: number): void {
  noise(ctx, out, t, { dur: 1.2, vol, filter: 'highpass', f0: 5000, q: 0.5, attack: 0.002 });
}

// -------------------------------------------------------------------- voices

function bassNote(ctx: BaseAudioContext, out: AudioNode, t: number, m: number, dur: number, vol: number, bright: number): void {
  const f = mtof(m);
  tone(ctx, out, t, { type: 'sawtooth', f0: f, dur, vol: vol * 0.55, attack: 0.004, lp: 380 + 900 * bright });
  tone(ctx, out, t, { type: 'sine', f0: f, dur: dur * 1.1, vol, attack: 0.004 });
}

function padChord(ctx: BaseAudioContext, out: AudioNode, t: number, tones: readonly number[], dur: number, vol: number, bright: number): void {
  const cutoff = 900 + 1700 * bright;
  const hold = Math.max(0.05, dur - 0.5);
  for (let i = 0; i < tones.length; i++) {
    const f = mtof(tones[i]);
    tone(ctx, out, t, { type: 'sawtooth', f0: f, dur: dur + 0.45, vol, attack: 0.3, hold, detune: -7, lp: cutoff });
    tone(ctx, out, t, { type: 'sawtooth', f0: f, dur: dur + 0.45, vol, attack: 0.3, hold, detune: 7, lp: cutoff });
  }
  // soft octave-down root for warmth
  tone(ctx, out, t, { type: 'sine', f0: mtof(tones[0] - 12), dur: dur + 0.45, vol: vol * 2.2, attack: 0.3, hold });
}

function stab(ctx: BaseAudioContext, out: AudioNode, t: number, tones: readonly number[], vol: number, bright: number): void {
  for (let i = 0; i < tones.length; i++) {
    tone(ctx, out, t, { type: 'sawtooth', f0: mtof(tones[i] + 12), dur: 0.13, vol, attack: 0.002, lp: 1800 + 2200 * bright });
  }
}

function pluck(ctx: BaseAudioContext, out: AudioNode, echo: AudioNode, t: number, m: number, vol: number, sendVol: number): void {
  const f = mtof(m);
  const g = ctx.createGain();
  g.gain.value = 1;
  const s = ctx.createGain();
  s.gain.value = sendVol;
  g.connect(out);
  g.connect(s).connect(echo);
  tone(ctx, g, t, { type: 'triangle', f0: f, dur: 0.22, vol, attack: 0.002 });
  tone(ctx, g, t, { type: 'sine', f0: f * 2, dur: 0.1, vol: vol * 0.35, attack: 0.002 });
}

function leadNote(
  ctx: BaseAudioContext,
  out: MusicOut,
  t: number,
  m: number,
  dur: number,
  vol: number,
  bright: number,
  mellow: boolean,
): void {
  const f = mtof(m);
  const g = ctx.createGain();
  const send = ctx.createGain();
  send.gain.value = mellow ? 0.55 : 0.4;
  g.connect(out.dry);
  g.connect(send).connect(out.echo);
  const lp = 2200 + 2800 * bright;
  if (mellow) {
    tone(ctx, g, t, { type: 'sine', f0: f, dur, vol, attack: 0.02, lp: 2400 });
    tone(ctx, g, t, { type: 'triangle', f0: f * 2, dur: dur * 0.7, vol: vol * 0.25, attack: 0.02 });
  } else {
    tone(ctx, g, t, { type: 'triangle', f0: f, dur, vol, attack: 0.008, lp });
    tone(ctx, g, t, { type: 'square', f0: f, dur, vol: vol * 0.45, attack: 0.008, detune: 5, lp });
    // little sparkle on the attack
    tone(ctx, g, t, { type: 'sine', f0: f * 2, dur: 0.09, vol: vol * 0.3, attack: 0.002 });
  }
}

// ---------------------------------------------------------------------- step

/**
 * Schedules everything that happens on one 16th-note step. `step` is the global counter within
 * the style (loops every LOOP_STEPS). `intensity` in 0..1.
 */
export function playStep(
  ctx: BaseAudioContext,
  out: MusicOut,
  style: MusicStyle,
  step: number,
  t: number,
  stepDur: number,
  intensity: number,
): void {
  const pos = step % LOOP_STEPS;
  const bar = Math.floor(pos / STEPS_PER_BAR);
  const s = pos % STEPS_PER_BAR;
  const chord = PROGRESSION[bar];
  const bright = intensity;
  const dry = out.dry;

  if (style === 'menu') {
    if (s === 0 || s === 8) kick(ctx, dry, t, 0.36);
    if (s % 4 === 2) hat(ctx, dry, t, 0.045);
    if (s === 0) bassNote(ctx, dry, t, chord.root, stepDur * 7, 0.2, 0);
    if (s === 8) bassNote(ctx, dry, t, chord.root + 7, stepDur * 7, 0.16, 0);
    if (s === 0) padChord(ctx, dry, t, chord.tones, stepDur * 16, 0.04, 0.1);
    if (s % 2 === 0) {
      const idx = (s / 2) % 4;
      const pattern = [0, 1, 2, 1];
      const tone3 = chord.tones[pattern[idx] % chord.tones.length] + 12;
      pluck(ctx, dry, out.echo, t, tone3, 0.085, 0.5);
    }
    if (bar % 2 === 1) {
      const notes = LEAD[bar];
      for (let i = 0; i < notes.length; i++) {
        if (notes[i].step === s) leadNote(ctx, out, t, notes[i].midi - 12, notes[i].len * stepDur * 0.95, 0.09, 0, true);
      }
    }
    return;
  }

  // ---- run
  const fillBar = bar % 4 === 3;

  // drums
  if (s % 4 === 0) kick(ctx, dry, t, 0.62);
  if (s === 4 || s === 12) snare(ctx, dry, t, 0.2);
  if (fillBar && s >= 13) snare(ctx, dry, t, 0.09 + 0.04 * (s - 12));
  if (s % 4 === 2) hat(ctx, dry, t, 0.085, s === 14 && bar % 2 === 1);
  else if (s % 4 === 0) hat(ctx, dry, t, 0.035);
  if (intensity > 0.5 && s % 2 === 1) hat(ctx, dry, t, 0.03 + 0.03 * smooth(0.5, 1, intensity));
  if (s === 0 && bar % 8 === 0) crashCymbal(ctx, dry, t, 0.09);

  // bass
  const pat = fillBar ? BASS_FILL : BASS_RUN;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i][0] === s) bassNote(ctx, dry, t, chord.root + pat[i][1], pat[i][2] * stepDur * 0.85, 0.3, bright);
  }

  // pad
  if (s === 0) padChord(ctx, dry, t, chord.tones, stepDur * 16, 0.028, bright);

  // offbeat stabs
  const stabVol = 0.032 * smooth(0.15, 0.45, intensity);
  if (stabVol > 0.001 && s % 4 === 2) stab(ctx, dry, t, chord.tones, stabVol, bright);

  // sparkle arps in the high intensity range
  if (intensity > 0.6 && s % 2 === 1) {
    const k = ((s - 1) / 2) % 4;
    const m = chord.tones[[2, 1, 2, 0][k]] + 24;
    pluck(ctx, dry, out.echo, t, m, 0.04 * smooth(0.6, 0.9, intensity), 0.5);
  }

  // lead melody
  const leadVol = 0.075 * (0.55 + 0.45 * smooth(0.05, 0.5, intensity));
  const notes = LEAD[bar];
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].step === s) leadNote(ctx, out, t, notes[i].midi, notes[i].len * stepDur * 0.92, leadVol, bright, false);
  }
}

/** Convenience for tests / offline rendering: schedule `seconds` of music from t0. */
export function scheduleMusic(
  ctx: BaseAudioContext,
  out: MusicOut,
  style: MusicStyle,
  seconds: number,
  intensity: number,
  t0 = 0,
  startStep = 0,
): number {
  let t = t0;
  let step = startStep;
  const end = t0 + seconds;
  while (t < end) {
    const sd = stepDuration(style, intensity);
    playStep(ctx, out, style, step, t, sd, intensity);
    t += sd;
    step++;
  }
  return step;
}
