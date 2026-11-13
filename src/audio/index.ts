// WebAudio synth (placeholder sounds, final API). Silent until unlock() is called from a user
// gesture (browsers block audio before that). No audio files: everything is synthesized.

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

export type MusicMode = 'menu' | 'run' | 'off';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private music: MusicMode = 'off';
  private intensity = 0;

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Call from a user gesture (click / key / touch). Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  sfx(name: SfxName): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    switch (name) {
      case 'coin':
        this.blip(t, 'square', 988, 1319, 0.09, 0.12);
        break;
      case 'jump':
        this.blip(t, 'triangle', 300, 620, 0.16, 0.25);
        break;
      case 'crash':
        this.noise(t, 0.45, 0.5);
        this.blip(t, 'sawtooth', 160, 40, 0.4, 0.3);
        break;
      case 'pickup':
        this.blip(t, 'square', 523, 1047, 0.25, 0.15);
        break;
      case 'land':
      case 'roll':
      case 'lane':
        this.blip(t, 'sine', 220, 160, 0.06, 0.12);
        break;
      default:
        this.blip(t, 'sine', 440, 440, 0.05, 0.08);
    }
  }

  /** Placeholder: remembers the mode; music is synthesized by the audio engineer later. */
  setMusic(mode: MusicMode): void {
    this.music = mode;
  }

  /** 0..1 run intensity (speed / danger) for adaptive music. */
  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  get state(): { muted: boolean; music: MusicMode; intensity: number } {
    return { muted: this.muted, music: this.music, intensity: this.intensity };
  }

  private blip(t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(t: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this.master!);
    src.start(t);
  }
}
