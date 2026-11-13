// Master signal chain, shared by the live engine and the offline renderer:
//
//   sfx ──────────────┐
//   music ─┬──────────┴─> master gain -> compressor -> soft clipper -> destination
//   echo ──┘ (feedback delay, returns into music)
//
import type { MusicOut } from './music';

export interface AudioChain {
  master: GainNode;
  sfx: GainNode;
  music: GainNode;
  musicOut: MusicOut;
}

export const MUSIC_LEVEL = 0.2;
export const SFX_LEVEL = 1;
export const MASTER_LEVEL = 0.85;

/** Unity-slope tanh saturator: inputs clamp at +-1 so the ceiling is ~0.76 (about -2.4 dBFS). */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x);
  }
  return c;
}

/**
 * Builds the chain. With `limiter: false` the compressor and clipper are bypassed so tests can
 * measure the raw, pre-limiter level of the synthesis.
 */
export function buildChain(ctx: BaseAudioContext, opts: { limiter?: boolean } = {}): AudioChain {
  const master = ctx.createGain();
  master.gain.value = MASTER_LEVEL;

  if (opts.limiter === false) {
    master.connect(ctx.destination);
  } else {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 10;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = '2x';
    master.connect(comp);
    comp.connect(clip);
    clip.connect(ctx.destination);
  }

  const sfx = ctx.createGain();
  sfx.gain.value = SFX_LEVEL;
  sfx.connect(master);

  const music = ctx.createGain();
  music.gain.value = MUSIC_LEVEL;
  music.connect(master);

  // Echo: ~dotted-eighth at 128 BPM, darkening feedback.
  const echoIn = ctx.createGain();
  echoIn.gain.value = 1;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.234;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 2600;
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  echoIn.connect(delay);
  delay.connect(damp);
  damp.connect(fb);
  fb.connect(delay);
  damp.connect(wet);
  wet.connect(music);

  return { master, sfx, music, musicOut: { dry: music, echo: echoIn } };
}
