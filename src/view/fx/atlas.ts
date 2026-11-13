// Procedural particle sprite sheet (one canvas, one TextureSource, so every particle pool can use
// all frames and still draw in one call). White shapes with alpha: tint per particle.
import { Rectangle, Texture } from 'pixi.js';

export const Frame = {
  Dot: 0,
  Spark: 1,
  Streak: 2,
  Ring: 3,
  Puff: 4,
  Shard: 5,
  Star: 6,
  Blob: 7,
} as const;

const CELL = 64;
const COUNT = 8;
let frames: Texture[] | null = null;

/** The atlas frames, indexed by `Frame`. Drawn once. */
export function particleFrames(): Texture[] {
  if (frames) return frames;
  const canvas = document.createElement('canvas');
  canvas.width = CELL * COUNT;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d')!;
  const h = CELL / 2;
  const cell = (i: number, draw: () => void) => {
    ctx.save();
    ctx.translate(i * CELL, 0);
    ctx.beginPath();
    ctx.rect(0, 0, CELL, CELL);
    ctx.clip();
    draw();
    ctx.restore();
  };
  const radial = (stops: Array<[number, number]>, r = h) => {
    const g = ctx.createRadialGradient(h, h, 0, h, h, r);
    for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CELL, CELL);
  };

  // 0 soft dot
  cell(Frame.Dot, () => radial([[0, 1], [0.25, 0.85], [0.6, 0.25], [1, 0]]));
  // 1 four-point sparkle with a hot core
  cell(Frame.Spark, () => {
    radial([[0, 1], [0.15, 0.7], [0.4, 0.1], [1, 0]], h * 0.7);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    const r1 = h * 0.95, r2 = h * 0.12;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 - Math.PI / 2;
      const r = k % 2 === 0 ? r1 : r2;
      ctx.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  });
  // 2 streak: thin horizontal line, bright middle, fading ends
  cell(Frame.Streak, () => {
    const g = ctx.createLinearGradient(0, 0, CELL, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h - 1.5, CELL, 3);
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, h - 3, CELL, 6);
  });
  // 3 ring
  cell(Frame.Ring, () => radial([[0, 0], [0.55, 0], [0.78, 1], [0.86, 0.9], [1, 0]]));
  // 4 puff: lumpy soft cloud
  cell(Frame.Puff, () => {
    const blobs: Array<[number, number, number]> = [[0.5, 0.55, 0.36], [0.33, 0.5, 0.24], [0.66, 0.46, 0.26], [0.48, 0.36, 0.22]];
    for (const [x, y, r] of blobs) {
      const g = ctx.createRadialGradient(x * CELL, y * CELL, 0, x * CELL, y * CELL, r * CELL);
      g.addColorStop(0, 'rgba(255,255,255,0.75)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CELL, CELL);
    }
  });
  // 5 shard: sharp sliver
  cell(Frame.Shard, () => {
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(h, 4);
    ctx.lineTo(h + 13, h + 6);
    ctx.lineTo(h - 4, CELL - 6);
    ctx.lineTo(h - 12, h - 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(h, 4);
    ctx.lineTo(h + 13, h + 6);
    ctx.lineTo(h, h + 2);
    ctx.closePath();
    ctx.fill();
  });
  // 6 cartoon star
  cell(Frame.Star, () => {
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
      const r = k % 2 === 0 ? h * 0.92 : h * 0.42;
      ctx.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  });
  // 7 blob: flat-topped soft disc (contact shadow, ground glow)
  cell(Frame.Blob, () => radial([[0, 1], [0.45, 0.85], [0.8, 0.3], [1, 0]]));

  const base = Texture.from(canvas);
  frames = [];
  for (let i = 0; i < COUNT; i++) {
    frames.push(new Texture({ source: base.source, frame: new Rectangle(i * CELL, 0, CELL, CELL) }));
  }
  return frames;
}
