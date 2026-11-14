// Screen-space feedback on the stage's 2D overlay (above the 3D view): an edge flash, a subtle
// cinematic vignette that deepens with speed, and a coloured edge pulse (power-ups, hits).
// Three sprites, no allocation per frame; the vignette quads are skipped on tiers without it.
//
// Safety rules: flashes and pulses never cover the centre of the screen (they use the edge
// texture), are capped (FLASH_MAX), last at most ~0.15 s and decay on REAL time (performance.now),
// so the crash hit-stop / slow motion cannot stretch them. With prefers-reduced-motion flashes are
// dropped and pulses are weak.
import { Sprite, Texture } from 'pixi.js';
import type { Stage } from '../stage';

let edgeTex: Texture | null = null;

/** Peak alpha of any flash (photosensitivity), and how long a flash may last (s). */
const FLASH_MAX = 0.3;
const FLASH_LIFE = 0.14;
const PULSE_MAX = 0.45;
const reduceMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** White edges fading to a transparent centre (tinted per use). */
function edgeTexture(): Texture {
  if (edgeTex) return edgeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 40, 128, 128, 182);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  edgeTex = Texture.from(c);
  return edgeTex;
}

export class ScreenFx {
  private readonly stage: Stage;
  private readonly flashSprite: Sprite;
  private readonly vignette: Sprite;
  private readonly edge: Sprite;
  private flashA = 0;
  private flashDecay = 1 / FLASH_LIFE;
  private edgeA = 0;
  private edgeDecay = 3;
  private lastNow = -1;
  private readonly reduced = reduceMotion();
  private w = 0;
  private h = 0;
  /** Base vignette strength (0..1) and the extra applied at full speed. */
  baseVignette = 0.26;
  speedVignette = 0.16;

  constructor(stage: Stage) {
    this.stage = stage;
    this.vignette = new Sprite(edgeTexture());
    this.vignette.tint = 0x0b1026;
    this.edge = new Sprite(edgeTexture());
    this.edge.blendMode = 'add';
    this.flashSprite = new Sprite(edgeTexture());
    for (const s of [this.vignette, this.edge, this.flashSprite]) {
      s.alpha = 0;
      s.visible = false;
      s.eventMode = 'none';
      stage.overlay.addChild(s);
    }
  }

  /** Edge flash of `color` at `alpha` (capped at FLASH_MAX), gone within ~FLASH_LIFE real seconds. */
  flash(color: number, alpha: number, _decay?: number): void {
    if (this.reduced) return;
    alpha = Math.min(alpha, FLASH_MAX);
    if (alpha < this.flashA) return;
    this.flashSprite.tint = color;
    this.flashA = alpha;
    this.flashDecay = alpha / FLASH_LIFE;
  }

  /** Coloured glow from the screen edges (additive); `decay` in alpha per real second. */
  pulse(color: number, strength = 0.6, decay = 3): void {
    if (this.reduced) strength *= 0.35;
    this.edge.tint = color;
    this.edgeA = Math.max(this.edgeA, Math.min(strength, PULSE_MAX));
    this.edgeDecay = decay;
  }

  /** `speed01`: 0 at cruising, 1 at full speed / boost. */
  update(_gameDt: number, speed01: number): void {
    const now = performance.now() / 1000;
    const dt = this.lastNow < 0 ? 0 : Math.min(0.1, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    const scr = this.stage.app.screen;
    if (scr.width !== this.w || scr.height !== this.h) {
      this.w = scr.width;
      this.h = scr.height;
      for (const s of [this.vignette, this.edge, this.flashSprite]) {
        s.width = this.w;
        s.height = this.h;
      }
    }
    this.flashA = Math.max(0, this.flashA - dt * this.flashDecay);
    this.flashSprite.alpha = this.flashA;
    this.flashSprite.visible = this.flashA > 0.004;
    this.edgeA = Math.max(0, this.edgeA - dt * this.edgeDecay);
    this.edge.alpha = this.edgeA;
    this.edge.visible = this.edgeA > 0.004;
    const vig = this.stage.settings.vignette;
    this.vignette.visible = vig;
    if (vig) this.vignette.alpha = this.baseVignette + this.speedVignette * Math.max(0, Math.min(1, speed01));
  }

  reset(): void {
    this.flashA = 0;
    this.edgeA = 0;
    this.lastNow = -1;
  }
}
