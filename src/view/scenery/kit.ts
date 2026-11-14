// Scenery modelling kit: small helpers on top of MeshBuilder used by every scenery module.
//
// - `slab` is a box that can skip faces nobody sees (the face glued to a wall, the underside),
//   which roughly halves the triangle cost of facade detail.
// - `glowPaint` marks faces as self-lit: the scenery material (material.ts) turns vertex alpha
//   below 1 into emission, so lit windows, lanterns and neon live in the SAME merged geometry and
//   draw call as the building or prop they belong to.
// - `Rand` is a tiny seeded PRNG so every generated variant is deterministic.
import { shadeHex, type MeshBuilder, type Paint, type PaintInput } from '../geom';

/** Emission scale of the scenery material: a face with glow `e` emits `colour * e * GLOW_MAX`. */
export const GLOW_MAX = 4;

/** Paint for a self-lit face. `e` 0..1 (0.3 ≈ softly lit, 0.7+ blooms). */
export function glowPaint(color: number, e: number): Paint {
  return { color, alpha: 1 - Math.max(0, Math.min(1, e)), jitter: 0.02 };
}

/** Vertical gradient paint: `color` at the top, darkened by `k` at the bottom. */
export function grad(color: number, k = 0.78, jitter?: number): Paint {
  return { color, top: color, bottom: shadeHex(color, k), jitter };
}

// Face masks for `slab`.
export const PX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32;
export const ALL = 63;

type V3 = [number, number, number];

function quadToward(mb: MeshBuilder, a: V3, b: V3, c: V3, d: V3, n: V3, paint?: PaintInput): void {
  // Orient a planar quad so its winding (CCW from the front) faces along n.
  const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
  const vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) mb.quad(a, b, c, d, paint);
  else mb.quad(d, c, b, a, paint);
}

/**
 * Axis-aligned box from min to max corner emitting only the faces in `faces` (bitmask of
 * PX/NX/PY/NY/PZ/NZ). The vertical gradient of `paint` spans the slab's own height.
 */
export function slab(
  mb: MeshBuilder,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  paint: PaintInput,
  faces = ALL & ~NY,
): void {
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  if (z0 > z1) [z0, z1] = [z1, z0];
  // Per-face gradients must use the slab's height, but MeshBuilder computes the gradient per part
  // (per quad here). Side faces span the full height so they get it right; top/bottom faces are
  // flat, so give them the top / bottom colour explicitly.
  const p: Paint = typeof paint === 'number' ? { color: paint } : paint;
  const topP: Paint = { ...p, color: p.top ?? p.color, bottom: undefined, top: undefined };
  const botP: Paint = { ...p, color: p.bottom ?? p.color, bottom: undefined, top: undefined };
  if (faces & PX) quadToward(mb, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], p);
  if (faces & NX) quadToward(mb, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], p);
  if (faces & PZ) quadToward(mb, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], p);
  if (faces & NZ) quadToward(mb, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], p);
  if (faces & PY) quadToward(mb, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], topP);
  if (faces & NY) quadToward(mb, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], botP);
}

/** Flat rectangle in the plane x = const facing -X (toward the street for a right-side facade). */
export function panelNX(mb: MeshBuilder, x: number, y0: number, z0: number, y1: number, z1: number, paint: PaintInput): void {
  quadToward(mb, [x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], [-1, 0, 0], paint);
}

/** Flat horizontal rectangle facing +Y. */
export function panelPY(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, paint: PaintInput): void {
  quadToward(mb, [x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], paint);
}

/** Generic oriented quad (any plane), front along n. */
export function quadN(mb: MeshBuilder, a: V3, b: V3, c: V3, d: V3, n: V3, paint: PaintInput): void {
  quadToward(mb, a, b, c, d, n, paint);
}

/** A thin straight bar between two points (square section `t`), for rails, ropes, strings. */
export function bar(mb: MeshBuilder, a: V3, b: V3, t: number, paint: PaintInput, sides = 4): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  // Rotate +Y onto the direction: yaw around Y then pitch around X (post-multiplied).
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.acos(Math.max(-1, Math.min(1, dy / len)));
  mb.push()
    .translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    .rotateY(yaw)
    .rotateX(pitch)
    .cylinder(t / 2, len, sides, { capTop: false, capBottom: false }, paint)
    .pop();
}

/** Small deterministic PRNG (mulberry32) for content generation. */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = (seed * 2654435761) >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}
