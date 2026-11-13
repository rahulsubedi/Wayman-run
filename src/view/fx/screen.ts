// Screen-space feedback on the stage's 2D overlay (above the 3D view): a full-screen flash, a
// subtle cinematic vignette that deepens with speed, and a coloured edge pulse (power-ups, hits).
// Three sprites, no allocation per frame; the vignette quads are skipped on tiers without it.
import { Sprite, Texture } from 'pixi.js';
import type { Stage } from '../stage';

let edgeTex: Texture | null = null;

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
  private flashDecay = 4;
  private edgeA = 0;
  private w = 0;
  private h = 0;
  /** Base vignette strength (0..1) and the extra applied at full speed. */
  baseVignette = 0.32;
  speedVignette = 0.25;

  constructor(stage: Stage) {
    this.stage = stage;
    this.vignette = new Sprite(edgeTexture());
    this.vignette.tint = 0x0b1026;
    this.edge = new Sprite(edgeTexture());
    this.edge.blendMode = 'add';
    this.flashSprite = new Sprite(Texture.WHITE);
    for (const s of [this.vignette, this.edge, this.flashSprite]) {
      s.alpha = 0;
      s.visible = false;
      s.eventMode = 'none';
      stage.overlay.addChild(s);
    }
  }

  /** Full-screen flash of `color`, starting at `alpha`, fading at `decay` alpha/second. */
  flash(color: number, alpha: number, decay = 4): void {
    if (alpha < this.flashA) return;
    this.flashSprite.tint = color;
    this.flashA = alpha;
    this.flashDecay = decay;
  }

  /** Coloured glow from the screen edges (additive), fading quickly. */
  pulse(color: number, strength = 0.6): void {
    this.edge.tint = color;
    this.edgeA = Math.max(this.edgeA, strength);
  }

  /** `speed01`: 0 at cruising, 1 at full speed / boost. */
  update(dt: number, speed01: number): void {
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
    this.edgeA = Math.max(0, this.edgeA - dt * 2.2);
    this.edge.alpha = this.edgeA;
    this.edge.visible = this.edgeA > 0.004;
    const vig = this.stage.settings.vignette;
    this.vignette.visible = vig;
    if (vig) this.vignette.alpha = this.baseVignette + this.speedVignette * Math.max(0, Math.min(1, speed01));
  }

  reset(): void {
    this.flashA = 0;
    this.edgeA = 0;
  }
}
