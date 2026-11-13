// Offline rendering of the same synthesis code (for numeric verification, see scripts/audio-verify.mjs).
import { buildChain } from './chain';
import { scheduleMusic, type MusicStyle } from './music';
import { playSfx, SFX_NAMES, type SfxName, type SfxOptions } from './synth';

export interface Rendered {
  sampleRate: number;
  /** Left channel. */
  samples: Float32Array;
}

function make(seconds: number, sampleRate: number): OfflineAudioContext {
  return new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
}

/** Render one effect (a little extra tail so decays are not cut). */
export async function renderSfx(name: SfxName, opts: SfxOptions & { raw?: boolean; sampleRate?: number } = {}): Promise<Rendered> {
  const sampleRate = opts.sampleRate ?? 44100;
  const ctx = make(2.5, sampleRate);
  const chain = buildChain(ctx, { limiter: !opts.raw });
  playSfx(ctx, chain.sfx, 0.02, name, opts);
  const buf = await ctx.startRendering();
  return { sampleRate, samples: buf.getChannelData(0).slice() };
}

/** Render `n` coin pings spaced `gap` seconds apart, climbing like the live engine does. */
export async function renderCoinBurst(n: number, gap: number, sampleRate = 44100): Promise<Rendered> {
  const ctx = make(n * gap + 1, sampleRate);
  const chain = buildChain(ctx);
  for (let i = 0; i < n; i++) playSfx(ctx, chain.sfx, 0.02 + i * gap, 'coin', { step: i });
  const buf = await ctx.startRendering();
  return { sampleRate, samples: buf.getChannelData(0).slice() };
}

export async function renderMusic(
  style: MusicStyle,
  seconds: number,
  intensity: number,
  opts: { raw?: boolean; sampleRate?: number } = {},
): Promise<Rendered> {
  const sampleRate = opts.sampleRate ?? 44100;
  const ctx = make(seconds + 1.5, sampleRate);
  const chain = buildChain(ctx, { limiter: !opts.raw });
  scheduleMusic(ctx, chain.musicOut, style, seconds, intensity);
  const buf = await ctx.startRendering();
  return { sampleRate, samples: buf.getChannelData(0).slice() };
}

export { SFX_NAMES };
