// Procedural canvas textures for the sky (no image assets): soft glow, moon face, star dot.
// Each is drawn once and cached. Canvas images upload premultiplied, so transparent texels are
// black and these work with both normal and additive blending.
import { Texture } from 'pixi.js';

const cache = new Map<string, Texture>();

function canvasTexture(key: string, size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): Texture {
  let t = cache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  t = Texture.from(c);
  cache.set(key, t);
  return t;
}

/** Radial glow: bright core falling off smoothly to transparent at the edge. */
export function glowTexture(): Texture {
  return canvasTexture('glow', 128, (ctx, s) => {
    const h = s / 2;
    const g = ctx.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.3)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Moon face: pale disc with soft limb darkening and a few stylised maria. */
export function moonTexture(): Texture {
  return canvasTexture('moon', 128, (ctx, s) => {
    const h = s / 2;
    const r = h * 0.92;
    const g = ctx.createRadialGradient(h * 0.85, h * 0.8, r * 0.1, h, h, r);
    g.addColorStop(0, 'rgba(255,255,250,1)');
    g.addColorStop(0.75, 'rgba(232,238,255,1)');
    g.addColorStop(1, 'rgba(190,204,240,1)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(h, h, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,165,210,0.35)';
    const maria: Array<[number, number, number]> = [
      [0.36, 0.38, 0.16], [0.6, 0.32, 0.1], [0.52, 0.6, 0.18], [0.3, 0.66, 0.08], [0.7, 0.62, 0.07],
    ];
    for (const [x, y, rr] of maria) {
      ctx.beginPath();
      ctx.arc(x * s, y * s, rr * s, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** Star: a tiny bright core with a faint four-point glint. */
export function starTexture(): Texture {
  return canvasTexture('star', 32, (ctx, s) => {
    const h = s / 2;
    const g = ctx.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(h - 0.5, 2, 1, s - 4);
    ctx.fillRect(2, h - 0.5, s - 4, 1);
  });
}
