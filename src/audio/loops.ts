// Sustained (looping) sounds. Unlike one-shot sfx these run until stopped, so they live apart
// from SFX_NAMES (which the offline verifier renders as finite voices).
import { noiseBuffer } from './synth';

export type LoopName = 'boost';

export interface LoopHandle {
  /** Fade out and release every node. */
  stop(ctx: BaseAudioContext): void;
}

const BOOST_LEVEL = 0.55;

/**
 * Boost flight: a breathy jet whoosh (band-passed noise with a slow sweep) over a low engine
 * hum with a gentle tremolo. Fades in over ~0.3 s.
 */
export function startBoostLoop(ctx: BaseAudioContext, out: AudioNode): LoopHandle {
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.linearRampToValueAtTime(BOOST_LEVEL, t + 0.3);
  master.connect(out);

  // Noise whoosh.
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  noise.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1100;
  band.Q.value = 0.9;
  const sweep = ctx.createOscillator();
  sweep.frequency.value = 0.55;
  const sweepAmt = ctx.createGain();
  sweepAmt.gain.value = 420;
  sweep.connect(sweepAmt);
  sweepAmt.connect(band.frequency);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 280;
  const nGain = ctx.createGain();
  nGain.gain.value = 0.42;
  noise.connect(band);
  band.connect(hp);
  hp.connect(nGain);
  nGain.connect(master);

  // Engine hum.
  const hum = ctx.createOscillator();
  hum.type = 'sawtooth';
  hum.frequency.value = 74;
  const hum2 = ctx.createOscillator();
  hum2.type = 'square';
  hum2.frequency.value = 111;
  hum2.detune.value = 9;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 340;
  const trem = ctx.createGain();
  trem.gain.value = 0.16;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 9;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 0.05;
  lfo.connect(lfoAmt);
  lfoAmt.connect(trem.gain);
  hum.connect(lp);
  hum2.connect(lp);
  lp.connect(trem);
  trem.connect(master);

  const sources: AudioScheduledSourceNode[] = [noise, sweep, hum, hum2, lfo];
  for (const s of sources) s.start(t);

  return {
    stop(c) {
      const now = c.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0.0001, now + 0.3);
      for (const s of sources) {
        try {
          s.stop(now + 0.35);
        } catch {
          // already stopped
        }
      }
      window.setTimeout(() => master.disconnect(), 500);
    },
  };
}
