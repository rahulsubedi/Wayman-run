import { describe, expect, it } from 'vitest';
import { hexToLinear, srgbToLinear } from './color';
import { MeshBuilder, type MeshArrays } from './meshBuilder';

/** Every triangle's winding (CCW) must agree with its vertex normals, and normals must be unit. */
function checkWinding(a: MeshArrays): void {
  const { positions: p, normals: n, indices: idx } = a;
  for (let i = 0; i < idx.length; i += 3) {
    const [ia, ib, ic] = [idx[i], idx[i + 1], idx[i + 2]];
    const ux = p[ib * 3] - p[ia * 3], uy = p[ib * 3 + 1] - p[ia * 3 + 1], uz = p[ib * 3 + 2] - p[ia * 3 + 2];
    const vx = p[ic * 3] - p[ia * 3], vy = p[ic * 3 + 1] - p[ia * 3 + 1], vz = p[ic * 3 + 2] - p[ia * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const dot = cx * n[ia * 3] + cy * n[ia * 3 + 1] + cz * n[ia * 3 + 2];
    expect(dot).toBeGreaterThan(0);
    expect(Math.hypot(n[ia * 3], n[ia * 3 + 1], n[ia * 3 + 2])).toBeCloseTo(1, 5);
  }
}

/** For a solid centred at `c`, every face normal points away from the centre. */
function checkOutward(a: MeshArrays, c: [number, number, number]): void {
  const { positions: p, normals: n } = a;
  for (let v = 0; v < p.length / 3; v++) {
    const d = (p[v * 3] - c[0]) * n[v * 3] + (p[v * 3 + 1] - c[1]) * n[v * 3 + 1] + (p[v * 3 + 2] - c[2]) * n[v * 3 + 2];
    expect(d).toBeGreaterThan(0);
  }
}

describe('MeshBuilder', () => {
  it('box: 24 vertices, 12 triangles, axis-aligned outward flat normals', () => {
    const a = new MeshBuilder({ jitter: 0 }).box(2, 4, 6, 0xffffff).toArrays();
    expect(a.positions.length / 3).toBe(24);
    expect(a.indices.length).toBe(36);
    expect(a.colors.length).toBe(24 * 4);
    expect(a.uvs.length).toBe(24 * 2);
    expect(a.indices).toBeInstanceOf(Uint16Array);
    const seen = new Set<string>();
    for (let v = 0; v < 24; v++) {
      const nx = a.normals[v * 3], ny = a.normals[v * 3 + 1], nz = a.normals[v * 3 + 2];
      expect(Math.abs(nx) + Math.abs(ny) + Math.abs(nz)).toBeCloseTo(1, 6); // axis aligned
      seen.add(`${Math.round(nx)},${Math.round(ny)},${Math.round(nz)}`);
      // Each vertex lies on the face its normal names.
      const ext = [1, 2, 3];
      const axis = Math.abs(nx) > 0.5 ? 0 : Math.abs(ny) > 0.5 ? 1 : 2;
      const sign = Math.sign([nx, ny, nz][axis]);
      expect(a.positions[v * 3 + axis]).toBeCloseTo(sign * ext[axis], 6);
    }
    expect(seen.size).toBe(6);
    checkWinding(a);
    checkOutward(a, [0, 0, 0]);
    // White, no jitter => linear 1.
    expect(Array.from(a.colors.slice(0, 4))).toEqual([1, 1, 1, 1]);
  });

  it('transforms parts, including mirrors, without breaking normals', () => {
    const mb = new MeshBuilder();
    mb.push().translate(5, 0, 0).rotateY(0.7).scale(-1, 2, 0.5).box(1, 1, 1).pop();
    const a = mb.toArrays();
    checkWinding(a);
    checkOutward(a, [5, 0, 0]);
  });

  it('bevelBox has 26 faces and stays inside its extents', () => {
    const a = new MeshBuilder().bevelBox(2, 1, 1, 0.1).toArrays();
    expect(a.positions.length / 3).toBe(6 * 4 + 12 * 4 + 8 * 3);
    expect(a.indices.length / 3).toBe(6 * 2 + 12 * 2 + 8);
    for (let i = 0; i < a.positions.length; i += 3) {
      expect(Math.abs(a.positions[i])).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(a.positions[i + 1])).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    checkWinding(a);
    checkOutward(a, [0, 0, 0]);
  });

  it('cylinders, cones, spheres, wedges and extrusions are closed and outward', () => {
    const solids: [string, (mb: MeshBuilder) => void, [number, number, number]][] = [
      ['cylinder', (mb) => mb.cylinder(1, 2, 6), [0, 0, 0]],
      ['taper', (mb) => mb.cylinder(1, 2, 7, { radiusTop: 0.4 }), [0, 0, 0]],
      ['cone', (mb) => mb.cone(1, 2, 5), [0, -0.5, 0]],
      ['sphere', (mb) => mb.sphere(1, 0.5, 2, 7, 4), [0, 0, 0]],
      ['wedge', (mb) => mb.wedge(2, 1, 3), [0, -1 / 6, -0.5]],
    ];
    for (const [, add, c] of solids) {
      const mb = new MeshBuilder();
      add(mb);
      const a = mb.toArrays();
      checkWinding(a);
      checkOutward(a, c);
    }
    // Concave L-shape extrusion: 6 sides + 2 caps of 4 triangles each.
    const L: [number, number][] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    const e = new MeshBuilder().extrude(L, 1).toArrays();
    expect(e.indices.length / 3).toBe(4 + 4 + 6 * 2);
    checkWinding(e);
  });

  it('paints linear colours with a vertical gradient and deterministic jitter', () => {
    const a = new MeshBuilder({ jitter: 0 }).box(1, 1, 1, { color: 0x808080, bottom: 0x000000, top: 0xffffff }).toArrays();
    for (let v = 0; v < a.positions.length / 3; v++) {
      const y = a.positions[v * 3 + 1];
      expect(a.colors[v * 4]).toBeCloseTo(y + 0.5, 5);
    }
    const mid = hexToLinear(0x808080);
    expect(mid[0]).toBeCloseTo(srgbToLinear(128 / 255), 6);
    expect(mid[0]).toBeLessThan(0.25); // linear, not 0.5

    const j1 = new MeshBuilder({ seed: 3, jitter: 0.1 }).box(1, 1, 1, 0x808080).toArrays().colors;
    const j2 = new MeshBuilder({ seed: 3, jitter: 0.1 }).box(1, 1, 1, 0x808080).toArrays().colors;
    expect(Array.from(j1)).toEqual(Array.from(j2));
    expect(new Set(Array.from(j1).filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(1);
  });

  it('merge appends another builder and build() returns a Geometry3D', () => {
    const part = new MeshBuilder().box(1, 1, 1);
    const mb = new MeshBuilder().box(1, 1, 1);
    mb.push().translate(3, 0, 0).scale(-1, 1, 1).merge(part).pop();
    const a = mb.toArrays();
    expect(a.positions.length / 3).toBe(48);
    checkWinding(a);
    const g = mb.build();
    expect(g.vertexCount).toBe(48);
  });
});
