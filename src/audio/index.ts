// WebAudio engine: synthesized sfx + procedural music, no audio files.
// Safe to construct and call before unlock() (everything is a no-op until a user gesture creates
// the context), and safe on browsers without WebAudio.
import { buildChain, MASTER_LEVEL, MUSIC_LEVEL, type AudioChain } from './chain';
import { playStep, stepDuration, type MusicStyle } from './music';
import { playSfx, SFX_LIMITS, SFX_NAMES, type SfxName } from './synth';

export type { SfxName } from './synth';
export type MusicMode = 'menu' | 'run' | 'off';

const LOOKAHEAD = 0.25; // seconds of music scheduled ahead
const TICK_MS = 40;
const MAX_VOICE_NODES = 64;
const VOICE_RING = 128;
/** Sounds that must always play even when the voice budget is exhausted. */
const PRIORITY: ReadonlySet<SfxName> = new Set<SfxName>(['crash', 'shieldBreak', 'stumble', 'pickup', 'zone']);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private chain: AudioChain | null = null;
  private muted = false;
  private mode: MusicMode = 'off';
  private intensity = 0;

  // sfx voice limiting
  private readonly voiceEnd = new Float64Array(VOICE_RING);
  private readonly voiceCount = new Uint16Array(VOICE_RING);
  private voiceHead = 0;
  private readonly lastPlayed = new Map<SfxName, number>();
  private readonly ends = new Map<SfxName, Float64Array>();
  private lastCoin = -10;
  private coinCombo = 0;

  // music scheduler
  private timer = 0;
  private nextTime = 0;
  private readonly steps: Record<MusicStyle, number> = { menu: 0, run: 0 };
  private style: MusicStyle = 'menu';
  private smoothIntensity = 0;
  private hiddenSuspended = false;
  private musicStarted = false;

  constructor() {
    for (const n of SFX_NAMES) this.ends.set(n, new Float64Array(SFX_LIMITS[n].max));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Call from a user gesture (click / key / touch). Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.chain = buildChain(this.ctx);
        this.chain.master.gain.value = this.muted ? 0 : this.chain.master.gain.value;
        this.chain.music.gain.value = 0;
        this.ctx.onstatechange = () => {
          if (this.ctx?.state === 'running') this.applyMode(true);
        };
      }
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
      this.applyMode(false);
    } catch {
      this.ctx = null;
      this.chain = null;
    }
  }

  /** Plays a one-shot effect. Voice-limited so bursts (20 coins) cannot pile up or clip. */
  sfx(name: SfxName): void {
    const ctx = this.ctx;
    const chain = this.chain;
    if (!ctx || !chain || this.muted || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const lim = SFX_LIMITS[name];

    const last = this.lastPlayed.get(name);
    if (last !== undefined && now - last < lim.gap) return;
    const ends = this.ends.get(name)!;
    let slot = -1;
    for (let i = 0; i < ends.length; i++) {
      if (ends[i] <= now) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return;
    if (!PRIORITY.has(name) && this.activeNodes(now) > MAX_VOICE_NODES) return;

    let step = 0;
    if (name === 'coin') {
      this.coinCombo = now - this.lastCoin < 0.5 ? Math.min(this.coinCombo + 1, 10) : 0;
      this.lastCoin = now;
      step = this.coinCombo;
    }

    this.lastPlayed.set(name, now);
    const info = playSfx(ctx, chain.sfx, now + 0.005, name, { step });
    ends[slot] = now + info.duration;
    const h = this.voiceHead;
    this.voiceEnd[h] = now + info.duration;
    this.voiceCount[h] = info.voices;
    this.voiceHead = (h + 1) % VOICE_RING;
  }

  setMusic(mode: MusicMode): void {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    if (mode !== 'off') {
      const style: MusicStyle = mode;
      // Returning from silence (pause/resume) continues where we were; a style change restarts.
      if (prev !== 'off' && style !== this.style) this.steps[style] = 0;
      if (prev === 'menu' && mode === 'run') this.steps.run = 0;
      this.style = style;
      this.musicStarted = false;
    }
    this.applyMode(false);
  }

  /** 0..1 run intensity (speed / danger) for adaptive music. */
  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  setMuted(m: boolean): void {
    this.muted = m;
    const ctx = this.ctx;
    if (this.chain && ctx) this.chain.master.gain.setTargetAtTime(m ? 0 : MASTER_LEVEL, ctx.currentTime, 0.03);
  }

  get state(): { muted: boolean; music: MusicMode; intensity: number } {
    return { muted: this.muted, music: this.mode, intensity: this.intensity };
  }

  dispose(): void {
    this.stopTimer();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.chain = null;
  }

  // ----------------------------------------------------------------- internals

  private activeNodes(now: number): number {
    let n = 0;
    for (let i = 0; i < VOICE_RING; i++) if (this.voiceEnd[i] > now) n += this.voiceCount[i];
    return n;
  }

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (document.hidden) {
      if (ctx.state === 'running') {
        this.hiddenSuspended = true;
        void ctx.suspend().catch(() => undefined);
      }
    } else if (this.hiddenSuspended || ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
      this.hiddenSuspended = false;
      void ctx.resume().catch(() => undefined);
    }
  };

  /** Starts / retargets / stops the music scheduler to match `mode`. */
  private applyMode(fromStateChange: boolean): void {
    const ctx = this.ctx;
    const chain = this.chain;
    if (!ctx || !chain) return;
    const g = chain.music.gain;
    const now = ctx.currentTime;
    if (this.mode === 'off') {
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, 0.07);
      window.setTimeout(() => {
        if (this.mode === 'off') this.stopTimer();
      }, 600);
      return;
    }
    if (!this.musicStarted || fromStateChange) {
      // (Re)start: brief dip, then fade in on the downbeat of the current position.
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, 0.03);
      g.setValueAtTime(0, now + 0.12);
      g.linearRampToValueAtTime(MUSIC_LEVEL, now + 0.55);
      this.nextTime = now + 0.12;
      this.musicStarted = true;
    } else {
      g.cancelScheduledValues(now);
      g.setTargetAtTime(MUSIC_LEVEL, now, 0.12);
    }
    if (!this.timer) this.timer = window.setInterval(this.tick, TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private readonly tick = (): void => {
    const ctx = this.ctx;
    const chain = this.chain;
    if (!ctx || !chain || ctx.state !== 'running' || this.mode === 'off') return;
    const now = ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now + 0.03; // fell behind (tab stall): resync
    this.smoothIntensity += (this.intensity - this.smoothIntensity) * 0.08;
    const style = this.style;
    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 16) {
      const sd = stepDuration(style, this.smoothIntensity);
      if (!this.muted) playStep(ctx, chain.musicOut, style, this.steps[style], this.nextTime, sd, this.smoothIntensity);
      this.steps[style]++;
      this.nextTime += sd;
    }
  };
}
