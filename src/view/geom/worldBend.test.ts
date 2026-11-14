import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4 } from '@pixi/3d';
import type { Camera3D } from '@pixi/3d';
import { BEND_DOWN, BendCullFrustum, autoBend, bendOffset, packBend, unpackBend } from './worldBend';
import type { BendValues } from './worldBend';

describe('bend packing', () => {
  it('round-trips through a float32 at 1/1024 m and stays a normal float >= 2', () => {
    const f32 = new Float32Array(1);
    for (const [down, side] of [[0, 0], [10, 16], [10, -16], [15.5, 31.9], [3.3, -0.001]]) {
      const v = packBend(down, side);
      f32[0] = v; // what the engine's uniform copy does
      expect(f32[0]).toBe(v);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(v)).toBe(true);
      const b = unpackBend(f32[0]);
      expect(Math.abs(b.down - down)).toBeLessThan(1 / 1024);
      expect(Math.abs(b.side - side)).toBeLessThan(1 / 1024);
    }
  });

  it('decodes zero / a real fog density as no bend', () => {
    expect(unpackBend(0)).toEqual({ down: 0, side: 0 });
    expect(unpackBend(0.02)).toEqual({ down: 0, side: 0 });
  });
});

describe('automatic driver', () => {
  it('is continuous and turns slowly (no wobble), with left, right and straight stretches', () => {
    const b: BendValues = { down: 0, side: 0 };
    let prev = autoBend(0, b).side;
    let maxStep = 0, left = 0, right = 0, straight = 0;
    for (let s = 1; s < 20000; s++) {
      autoBend(s, b);
      expect(b.down).toBe(BEND_DOWN);
      maxStep = Math.max(maxStep, Math.abs(b.side - prev));
      if (b.side < -6) left++;
      else if (b.side > 6) right++;
      else if (Math.abs(b.side) < 1) straight++;
      prev = b.side;
    }
    // At top speed (30 m/s) the swing at 100 m moves less than ~4 m per second.
    expect(maxStep * 30).toBeLessThan(4);
    expect(left).toBeGreaterThan(1500);
    expect(right).toBeGreaterThan(1500);
    expect(straight).toBeGreaterThan(1000);
  });
});

// ---- culling: a point whose BENT position is on screen must pass the bend cull frustum

function perspective(fovY: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan((fovY * Math.PI) / 360);
  // column-major
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

function mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** View matrix for a camera at (0, h, 0) pitched down by `pitch` degrees, looking toward `dirZ` (-1 / +1). */
function viewMatrix(h: number, pitch: number, dirZ: number): number[] {
  const p = (pitch * Math.PI) / 180;
  const yaw = dirZ < 0 ? 0 : Math.PI;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(p), sp = Math.sin(p);
  // world = T * Ry * Rx(-p); view = inverse
  const rot = mul(
    [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, cp, -sp, 0, 0, sp, cp, 0, 0, 0, 0, 1],
  );
  // inverse of rotation = transpose; then translate by -camPos
  const inv = [rot[0], rot[4], rot[8], 0, rot[1], rot[5], rot[9], 0, rot[2], rot[6], rot[10], 0, 0, 0, 0, 1];
  const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -h, 0, 1];
  return mul(inv, t);
}

function inside(planes: Float32Array, x: number, y: number, z: number, r = 0): boolean {
  for (let i = 0; i < 24; i += 4) if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -r) return false;
  return true;
}

function check(aspect: number, h: number, pitch: number, dirZ: number, bend: BendValues) {
  const F = 200;
  const vp = mul(perspective(58, aspect, 0.3, 420), viewMatrix(h, pitch, dirZ));
  const m = new Matrix4();
  m.elements.set(vp);
  const frustum = new Frustum().setFromProjectionMatrix(m);
  const camera = { frustum, position: { x: 0, y: h, z: 0 } } as unknown as Camera3D;
  const cull = new BendCullFrustum(camera, bend, () => F);
  const planes = cull.planesData;
  const off = { x: 0, y: 0 };
  let misses = 0, plainMisses = 0, tested = 0;
  for (let x = -80; x <= 80; x += 2)
    for (let y = -40; y <= 60; y += 2)
      for (let d = -40; d <= F; d += 2) {
        const z = -d; // camera at z = 0
        bendOffset(bend, d, off);
        if (!inside(frustum.planesData, x + off.x, y + off.y, z)) continue; // not visible once bent
        tested++;
        if (!inside(planes, x, y, z)) misses++;
        if (!inside(frustum.planesData, x, y, z)) plainMisses++;
      }
  return { misses, plainMisses, tested };
}

describe('BendCullFrustum', () => {
  for (const [name, aspect, h, pitch, dirZ] of [
    ['desktop run', 16 / 9, 3.5, 8, -1],
    ['phone run', 390 / 844, 4, 10, -1],
    ['boost flight', 16 / 9, 11, 22, -1],
    ['menu (looking back)', 16 / 9, 2, 5, 1],
  ] as const) {
    for (const bend of [{ down: 10, side: 16 }, { down: 10, side: -16 }, { down: 15, side: 0 }]) {
      it(`never culls geometry the bend brings into view: ${name} ${bend.side}`, () => {
        const r = check(aspect, h, pitch, dirZ, bend);
        expect(r.tested).toBeGreaterThan(1000);
        expect(r.misses).toBe(0);
        if (dirZ < 0) expect(r.plainMisses).toBeGreaterThan(0); // the unbent frustum WOULD pop
      });
    }
  }
});
