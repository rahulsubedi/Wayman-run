// MeshBuilder: accumulates low-poly parts into ONE merged, vertex-coloured, flat-shaded Geometry3D.
//
//   const mb = new MeshBuilder({ seed: 7, jitter: 0.04 });
//   mb.paint({ color: 0xd9653b, bottom: 0x9c3f22 })      // current paint: colour + vertical gradient
//     .block(-1, 0, -0.2, 1, 0.9, 0.2);                   // min/max corners
//   mb.push().translate(0, 1.2, 0).rotateY(Math.PI / 4)
//     .bevelBox(0.5, 0.5, 0.5, 0.08, 0xffffff)            // per-part paint override
//     .pop();
//   const geometry = mb.build();                          // share it between all instances
//
// Conventions
// - Units are metres. Primitives are centred on the current origin (like the engine's built-ins)
//   except `block`, which takes min/max corners. Axis of cylinders/cones/prisms is +Y.
// - Transforms post-multiply like canvas 2D: `translate(...).rotateY(...)` then a part means the
//   part is rotated first, then translated. `push()` / `pop()` save and restore the matrix.
// - Every face gets its own vertices and its true face normal (flat shading), computed after the
//   transform, so non-uniform scales and mirrors (negative scale) stay correct. Front faces are CCW.
// - Colours: paint colours are sRGB hex (0xRRGGBB) and are stored as LINEAR RGBA, as the engine
//   expects. `bottom`/`top` give a vertical gradient over the part's own local height. `jitter`
//   varies each face's value a little (seeded, deterministic) so flat planes read as facets.
// - Pure CPU code. `toArrays()` needs no GPU; `build()` wraps the arrays in a Geometry3D.
import { Geometry3D } from '@pixi/3d';
import { hexToLinear, type RGB } from './color';

export interface Paint {
  /** sRGB hex base colour. */
  color?: number;
  /** sRGB hex colour at the part's lowest local point (defaults to `color`). */
  bottom?: number;
  /** sRGB hex colour at the part's highest local point (defaults to `color`). */
  top?: number;
  /** Per-face value jitter, 0..~0.15 (fraction of brightness). Defaults to the builder's. */
  jitter?: number;
  /** Vertex alpha (only visible with a blending material). */
  alpha?: number;
}

export type PaintInput = number | Paint;

export interface MeshBuilderOptions {
  /** Seed for per-face jitter. Same seed + same calls => identical geometry. */
  seed?: number;
  /** Default per-face jitter for parts that do not set one. */
  jitter?: number;
}

export interface CylinderOptions {
  /** Top radius (defaults to the bottom radius). 0 makes a cone. */
  radiusTop?: number;
  /** Cap the top / bottom (default true). */
  capTop?: boolean;
  capBottom?: boolean;
  /** Rotation of the first vertex around +Y, radians. Default puts a flat face toward +Z. */
  angle?: number;
}

export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
}

/** A face: convex polygon (flat xyz list, CCW from the front), or a polygon with explicit triangles. */
type Face = number[] | { p: number[]; t: number[] };

type Vec3 = [number, number, number];
type Mat = number[]; // 3x4 row-major affine: [a b c tx, d e f ty, g h i tz]

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function mul(m: Mat, n: Mat): Mat {
  // m * n, both affine 3x4 (implicit last row 0 0 0 1).
  const o: Mat = new Array(12);
  for (let r = 0; r < 3; r++) {
    const a = m[r * 4], b = m[r * 4 + 1], c = m[r * 4 + 2], t = m[r * 4 + 3];
    o[r * 4] = a * n[0] + b * n[4] + c * n[8];
    o[r * 4 + 1] = a * n[1] + b * n[5] + c * n[9];
    o[r * 4 + 2] = a * n[2] + b * n[6] + c * n[10];
    o[r * 4 + 3] = a * n[3] + b * n[7] + c * n[11] + t;
  }
  return o;
}

function det3(m: Mat): number {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

/** Newell normal (unnormalised) of a polygon given as a flat xyz list. CCW => points to viewer. */
function newell(p: number[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const n = p.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = p[i * 3], yi = p[i * 3 + 1], zi = p[i * 3 + 2];
    const xj = p[j * 3], yj = p[j * 3 + 1], zj = p[j * 3 + 2];
    nx += (yi - yj) * (zi + zj);
    ny += (zi - zj) * (xi + xj);
    nz += (xi - xj) * (yi + yj);
  }
  return [nx, ny, nz];
}

function reversePoly(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length / 3 - 1; i >= 0; i--) out.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  return out;
}

/** Orient a convex polygon so its normal points away from `c` (an interior point of the solid). */
function outward(p: number[], c: Vec3): number[] {
  const n = newell(p);
  let cx = 0, cy = 0, cz = 0;
  const k = p.length / 3;
  for (let i = 0; i < k; i++) {
    cx += p[i * 3];
    cy += p[i * 3 + 1];
    cz += p[i * 3 + 2];
  }
  const d = n[0] * (cx / k - c[0]) + n[1] * (cy / k - c[1]) + n[2] * (cz / k - c[2]);
  return d < 0 ? reversePoly(p) : p;
}

/** Orient a polygon so its normal points along `dir`. */
function toward(p: number[], dir: Vec3): number[] {
  const n = newell(p);
  return n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0 ? reversePoly(p) : p;
}

/** Signed area of a 2D polygon [[x, y], ...] (positive = CCW). */
function area2(pts: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Ear-clipping triangulation of a simple CCW polygon. Returns index triples. */
function earClip(pts: ReadonlyArray<readonly [number, number]>): number[] {
  const idx = pts.map((_, i) => i);
  const tris: number[] = [];
  const cross = (a: number, b: number, c: number) =>
    (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
  const inside = (p: number, a: number, b: number, c: number) =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = idx.length * idx.length;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue; // reflex or degenerate
      let ear = true;
      for (const q of idx) {
        if (q !== a && q !== b && q !== c && inside(q, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push(a, b, c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not simple; fall back to a fan for the rest
  }
  for (let i = 1; i + 1 < idx.length; i++) tris.push(idx[0], idx[i], idx[i + 1]);
  return tris;
}

/** Tiny deterministic PRNG for jitter (independent of sim/rng to keep geom self-contained). */
function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private m: Mat = IDENTITY.slice();
  private stack: Mat[] = [];
  private current: Paint = { color: 0xffffff };
  private rand: () => number;
  private defaultJitter: number;

  constructor(options: MeshBuilderOptions = {}) {
    this.rand = mulberry(options.seed ?? 1);
    this.defaultJitter = options.jitter ?? 0.035;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  // ------------------------------------------------------------------ state

  /** Set the current paint for subsequent parts (a hex number = plain colour). */
  paint(p: PaintInput): this {
    this.current = typeof p === 'number' ? { color: p } : { ...p };
    return this;
  }

  push(): this {
    this.stack.push(this.m.slice());
    return this;
  }

  pop(): this {
    const m = this.stack.pop();
    if (!m) throw new Error('MeshBuilder.pop() without push()');
    this.m = m;
    return this;
  }

  /** Reset the matrix to identity (the stack is kept). */
  identity(): this {
    this.m = IDENTITY.slice();
    return this;
  }

  translate(x: number, y: number, z: number): this {
    this.m = mul(this.m, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
    return this;
  }

  rotateX(a: number): this {
    const c = Math.cos(a), s = Math.sin(a);
    this.m = mul(this.m, [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]);
    return this;
  }

  rotateY(a: number): this {
    const c = Math.cos(a), s = Math.sin(a);
    this.m = mul(this.m, [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]);
    return this;
  }

  rotateZ(a: number): this {
    const c = Math.cos(a), s = Math.sin(a);
    this.m = mul(this.m, [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]);
    return this;
  }

  /** Same as rotateY(y).rotateX(x).rotateZ(z). */
  rotate(x: number, y: number, z: number): this {
    return this.rotateY(y).rotateX(x).rotateZ(z);
  }

  scale(x: number, y = x, z = x): this {
    this.m = mul(this.m, [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0]);
    return this;
  }

  // ------------------------------------------------------------- primitives

  /** Axis-aligned box centred on the origin. */
  box(w: number, h: number, d: number, paint?: PaintInput): this {
    const x = w / 2, y = h / 2, z = d / 2;
    const c: Vec3 = [0, 0, 0];
    const faces: Face[] = [
      outward([x, -y, -z, x, y, -z, x, y, z, x, -y, z], c),
      outward([-x, -y, -z, -x, -y, z, -x, y, z, -x, y, -z], c),
      outward([-x, y, -z, -x, y, z, x, y, z, x, y, -z], c),
      outward([-x, -y, -z, x, -y, -z, x, -y, z, -x, -y, z], c),
      outward([-x, -y, z, x, -y, z, x, y, z, -x, y, z], c),
      outward([-x, -y, -z, -x, y, -z, x, y, -z, x, -y, -z], c),
    ];
    return this.part(faces, paint);
  }

  /** Box from min corner to max corner (handy for buildings: `block(x0, 0, z0, x1, h, z1)`). */
  block(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, paint?: PaintInput): this {
    this.push().translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.box(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), paint);
    return this.pop();
  }

  /** Box with every edge chamfered by `bevel` (26 faces). */
  bevelBox(w: number, h: number, d: number, bevel: number, paint?: PaintInput): this {
    const half: Vec3 = [w / 2, h / 2, d / 2];
    const b = Math.max(0, Math.min(bevel, half[0] * 0.999, half[1] * 0.999, half[2] * 0.999));
    if (b <= 1e-6) return this.box(w, h, d, paint);
    const inner: Vec3 = [half[0] - b, half[1] - b, half[2] - b];
    // P(corner signs, axis): the inner-box corner pushed out to the full extent along `axis`.
    const P = (s: Vec3, axis: number): number[] => {
      const v = [s[0] * inner[0], s[1] * inner[1], s[2] * inner[2]];
      v[axis] = s[axis] * half[axis];
      return v;
    };
    const c: Vec3 = [0, 0, 0];
    const faces: Face[] = [];
    // Main faces.
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3;
      for (const sa of [-1, 1]) {
        const ring: number[] = [];
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const s: Vec3 = [0, 0, 0];
          s[a] = sa;
          s[u] = su;
          s[v] = sv;
          ring.push(...P(s, a));
        }
        faces.push(outward(ring, c));
      }
    }
    // Edge chamfers.
    for (let a = 0; a < 3; a++) {
      const bAxis = (a + 1) % 3, cAxis = (a + 2) % 3;
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const s1: Vec3 = [0, 0, 0];
          s1[a] = sa;
          s1[bAxis] = sb;
          s1[cAxis] = -1;
          const s2: Vec3 = [s1[0], s1[1], s1[2]];
          s2[cAxis] = 1;
          faces.push(outward([...P(s1, a), ...P(s2, a), ...P(s2, bAxis), ...P(s1, bAxis)], c));
        }
      }
    }
    // Corner triangles.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const s: Vec3 = [sx, sy, sz];
          faces.push(outward([...P(s, 0), ...P(s, 1), ...P(s, 2)], c));
        }
      }
    }
    return this.part(faces, paint);
  }

  /**
   * N-sided prism / cylinder along +Y, centred on the origin, optionally tapered (radiusTop) and
   * capped. `sides` 3..64. Low side counts give the faceted look.
   */
  cylinder(radius: number, height: number, sides = 8, opts: CylinderOptions = {}, paint?: PaintInput): this {
    const n = Math.max(3, Math.min(64, Math.floor(sides)));
    const rt = opts.radiusTop ?? radius;
    const rb = radius;
    const a0 = opts.angle ?? Math.PI / 2 - Math.PI / n; // flat face toward +Z by default
    const y0 = -height / 2, y1 = height / 2;
    const ring = (r: number, y: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2;
        out.push(Math.cos(a) * r, y, Math.sin(a) * r);
      }
      return out;
    };
    const bot = ring(rb, y0), top = ring(rt, y1);
    const c: Vec3 = [0, 0, 0];
    const faces: Face[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const quad: number[] = [];
      if (rb > 1e-9) quad.push(bot[i * 3], bot[i * 3 + 1], bot[i * 3 + 2], bot[j * 3], bot[j * 3 + 1], bot[j * 3 + 2]);
      else quad.push(0, y0, 0);
      if (rt > 1e-9) quad.push(top[j * 3], top[j * 3 + 1], top[j * 3 + 2], top[i * 3], top[i * 3 + 1], top[i * 3 + 2]);
      else quad.push(0, y1, 0);
      faces.push(outward(quad, c));
    }
    if ((opts.capTop ?? true) && rt > 1e-9) faces.push(toward(top, [0, 1, 0]));
    if ((opts.capBottom ?? true) && rb > 1e-9) faces.push(toward(bot, [0, -1, 0]));
    return this.part(faces, paint);
  }

  /** Cone along +Y, centred on the origin (base at -h/2, tip at +h/2). */
  cone(radius: number, height: number, sides = 8, paint?: PaintInput): this {
    return this.cylinder(radius, height, sides, { radiusTop: 0 }, paint);
  }

  /** Low-poly ellipsoid centred on the origin. `segments` around Y, `rings` from pole to pole. */
  sphere(rx: number, ry = rx, rz = rx, segments = 8, rings = 5, paint?: PaintInput): this {
    const seg = Math.max(3, Math.floor(segments));
    const rg = Math.max(2, Math.floor(rings));
    const pt = (i: number, j: number): number[] => {
      const phi = (j / rg) * Math.PI; // 0 = top
      const th = (i / seg) * Math.PI * 2;
      return [Math.sin(phi) * Math.cos(th) * rx, Math.cos(phi) * ry, Math.sin(phi) * Math.sin(th) * rz];
    };
    const c: Vec3 = [0, 0, 0];
    const faces: Face[] = [];
    for (let j = 0; j < rg; j++) {
      for (let i = 0; i < seg; i++) {
        const i1 = (i + 1) % seg;
        if (j === 0) faces.push(outward([...pt(i, 0), ...pt(i1, 1), ...pt(i, 1)], c));
        else if (j === rg - 1) faces.push(outward([...pt(i, j), ...pt(i1, j), ...pt(i, j + 1)], c));
        else faces.push(outward([...pt(i, j), ...pt(i1, j), ...pt(i1, j + 1), ...pt(i, j + 1)], c));
      }
    }
    return this.part(faces, paint);
  }

  /**
   * Wedge / ramp centred on the origin: a w x d base at y = -h/2 whose top edge (y = +h/2) runs
   * along the -Z end, so the slope rises toward -Z (the run direction).
   */
  wedge(w: number, h: number, d: number, paint?: PaintInput): this {
    const x = w / 2, y = h / 2, z = d / 2;
    const c: Vec3 = [0, -h / 6, -d / 6];
    const faces: Face[] = [
      outward([-x, -y, z, x, -y, z, x, -y, -z, -x, -y, -z], c), // bottom
      outward([-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z], c), // back (vertical)
      outward([-x, -y, z, x, -y, z, x, y, -z, -x, y, -z], c), // slope
      outward([x, -y, z, x, -y, -z, x, y, -z], c), // right side
      outward([-x, -y, z, -x, -y, -z, -x, y, -z], c), // left side
    ];
    return this.part(faces, paint);
  }

  /** Horizontal rectangle facing +Y, centred on the origin. */
  plane(w: number, d: number, paint?: PaintInput): this {
    const x = w / 2, z = d / 2;
    return this.part([toward([-x, 0, -z, x, 0, -z, x, 0, z, -x, 0, z], [0, 1, 0])], paint);
  }

  /** Arbitrary quad, points CCW as seen from its front side. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, paint?: PaintInput): this {
    return this.part([[...a, ...b, ...c, ...d]], paint);
  }

  /** Arbitrary triangle, points CCW as seen from its front side. */
  tri(a: Vec3, b: Vec3, c: Vec3, paint?: PaintInput): this {
    return this.part([[...a, ...b, ...c]], paint);
  }

  /** Convex polygon (flat xyz list or points), CCW from the front. */
  polygon(points: ReadonlyArray<Vec3>, paint?: PaintInput): this {
    return this.part([points.flatMap((p) => [p[0], p[1], p[2]])], paint);
  }

  /**
   * Extrude a simple 2D polygon (in XY, any winding, may be concave) along Z, centred on the
   * origin: caps at z = ±depth/2 (front cap faces +Z).
   */
  extrude(poly: ReadonlyArray<readonly [number, number]>, depth: number, paint?: PaintInput): this {
    const pts = area2(poly) < 0 ? poly.slice().reverse() : poly.slice();
    const n = pts.length;
    if (n < 3) return this;
    const z0 = -depth / 2, z1 = depth / 2;
    const tris = earClip(pts);
    const front: number[] = [], back: number[] = [];
    for (const [x, y] of pts) front.push(x, y, z1);
    // Back cap: points in reverse order (so its polygon normal is -Z), triangles remapped + flipped.
    for (let i = n - 1; i >= 0; i--) back.push(pts[i][0], pts[i][1], z0);
    const backTris: number[] = [];
    for (let i = 0; i < tris.length; i += 3) backTris.push(n - 1 - tris[i], n - 1 - tris[i + 2], n - 1 - tris[i + 1]);
    const faces: Face[] = [{ p: front, t: tris }, { p: back, t: backTris }];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % n];
      // CCW polygon: outward normal of edge a->b is (dy, -dx).
      faces.push(toward([ax, ay, z1, ax, ay, z0, bx, by, z0, bx, by, z1], [by - ay, -(bx - ax), 0]));
    }
    return this.part(faces, paint);
  }

  /** Append another builder's accumulated geometry (transformed by the current matrix). */
  merge(other: MeshBuilder): this {
    const base = this.vertexCount;
    const m = this.m;
    const flip = det3(m) < 0;
    const p = other.pos, nr = other.nrm;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      this.pos.push(
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
      );
    }
    // Normals: inverse-transpose; for our use (rotation + scale) recompute per triangle instead.
    this.uv.push(...other.uv);
    this.col.push(...other.col);
    for (let i = 0; i < other.idx.length; i += 3) {
      const a = other.idx[i] + base, b = other.idx[i + 1] + base, c = other.idx[i + 2] + base;
      if (flip) this.idx.push(a, c, b);
      else this.idx.push(a, b, c);
    }
    // Recompute flat normals for the merged vertices from their triangles.
    const n0 = this.nrm.length;
    this.nrm.length = n0 + nr.length;
    for (let i = 0; i < other.idx.length; i += 3) {
      const ia = other.idx[i] + base, ib = other.idx[i + 1] + base, ic = other.idx[i + 2] + base;
      const P = this.pos;
      const ux = P[ib * 3] - P[ia * 3], uy = P[ib * 3 + 1] - P[ia * 3 + 1], uz = P[ib * 3 + 2] - P[ia * 3 + 2];
      const vx = P[ic * 3] - P[ia * 3], vy = P[ic * 3 + 1] - P[ia * 3 + 1], vz = P[ic * 3 + 2] - P[ia * 3 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const len = Math.hypot(nx, ny, nz) || 1;
      for (const v of [ia, ib, ic]) {
        this.nrm[v * 3] = nx / len;
        this.nrm[v * 3 + 1] = ny / len;
        this.nrm[v * 3 + 2] = nz / len;
      }
    }
    return this;
  }

  /** Remove all accumulated geometry (keeps paint and seed state; resets the matrix stack). */
  clear(): this {
    this.pos.length = this.nrm.length = this.uv.length = this.col.length = this.idx.length = 0;
    this.m = IDENTITY.slice();
    this.stack.length = 0;
    return this;
  }

  // ----------------------------------------------------------------- output

  toArrays(): MeshArrays {
    const vc = this.vertexCount;
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.col),
      indices: vc > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx),
    };
  }

  /** Build the merged Geometry3D. Build once per model kind and share it (auto-instancing). */
  build(): Geometry3D {
    if (this.vertexCount === 0) throw new Error('MeshBuilder.build(): no geometry was added');
    return new Geometry3D(this.toArrays());
  }

  // --------------------------------------------------------------- internal

  private resolve(p: PaintInput | undefined): Paint {
    if (p === undefined) return this.current;
    return typeof p === 'number' ? { ...this.current, color: p, bottom: undefined, top: undefined } : p;
  }

  /** Emit a part: faces in local space (already oriented), painted, transformed, flat-normalled. */
  private part(faces: Face[], paintIn?: PaintInput): this {
    const paint = this.resolve(paintIn);
    const base = paint.color ?? 0xffffff;
    const cb = hexToLinear(paint.bottom ?? base);
    const ct = hexToLinear(paint.top ?? base);
    const jitter = paint.jitter ?? this.defaultJitter;
    const alpha = paint.alpha ?? 1;
    const gradient = cb[0] !== ct[0] || cb[1] !== ct[1] || cb[2] !== ct[2];

    let yMin = Infinity, yMax = -Infinity;
    if (gradient) {
      for (const f of faces) {
        const p = Array.isArray(f) ? f : f.p;
        for (let i = 1; i < p.length; i += 3) {
          if (p[i] < yMin) yMin = p[i];
          if (p[i] > yMax) yMax = p[i];
        }
      }
    }
    const ySpan = yMax - yMin > 1e-9 ? yMax - yMin : 1;

    const m = this.m;
    const flip = det3(m) < 0;
    const rgb: RGB = [0, 0, 0];

    for (const f of faces) {
      const local = Array.isArray(f) ? f : f.p;
      const count = local.length / 3;
      // Transform.
      const world: number[] = new Array(local.length);
      for (let i = 0; i < local.length; i += 3) {
        const x = local[i], y = local[i + 1], z = local[i + 2];
        world[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
        world[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
        world[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      }
      // Normal from the transformed polygon (mirror => winding reversed below).
      const n = newell(world);
      if (flip) {
        n[0] = -n[0];
        n[1] = -n[1];
        n[2] = -n[2];
      }
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-12) continue; // degenerate
      n[0] /= len;
      n[1] /= len;
      n[2] /= len;
      // Planar UVs along the dominant axis (no textures today, but keeps the vertex layout complete).
      const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
      const uAxis = ax >= ay && ax >= az ? 2 : 0;
      const vAxis = ay >= ax && ay >= az ? 2 : 1;

      const k = 1 + (this.rand() * 2 - 1) * jitter;
      const first = this.vertexCount;
      for (let i = 0; i < count; i++) {
        this.pos.push(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
        this.nrm.push(n[0], n[1], n[2]);
        this.uv.push(world[i * 3 + uAxis], world[i * 3 + vAxis]);
        if (gradient) {
          const t = (local[i * 3 + 1] - yMin) / ySpan;
          rgb[0] = cb[0] + (ct[0] - cb[0]) * t;
          rgb[1] = cb[1] + (ct[1] - cb[1]) * t;
          rgb[2] = cb[2] + (ct[2] - cb[2]) * t;
        } else {
          rgb[0] = cb[0];
          rgb[1] = cb[1];
          rgb[2] = cb[2];
        }
        this.col.push(Math.min(1, rgb[0] * k), Math.min(1, rgb[1] * k), Math.min(1, rgb[2] * k), alpha);
      }
      const tris = Array.isArray(f) ? null : f.t;
      if (tris) {
        for (let i = 0; i < tris.length; i += 3) {
          if (flip) this.idx.push(first + tris[i], first + tris[i + 2], first + tris[i + 1]);
          else this.idx.push(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
        }
      } else {
        for (let i = 1; i + 1 < count; i++) {
          if (flip) this.idx.push(first, first + i + 1, first + i);
          else this.idx.push(first, first + i, first + i + 1);
        }
      }
    }
    return this;
  }
}
