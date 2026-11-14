// Shared helpers for the model files: part caching + instancing, extra MeshBuilder shapes
// (lofts, tapered hulls, rings, stripes) and the few extra materials the models need.
//
// Everything that builds geometry runs ONCE per model kind/variant; instances share the same
// Geometry3D and material objects so the engine auto-instances them.
import { Container3D, FlatMaterial, Material3D, Mesh3D } from '@pixi/3d';
import type { BaseMaterial3D, Geometry3D, ShaderBit } from '@pixi/3d';
import { mixHex } from '../geom/color';
import type { MeshBuilder, PaintInput } from '../geom/meshBuilder';

export type V3 = [number, number, number];

export interface Part {
  geometry: Geometry3D;
  material: BaseMaterial3D;
  label?: string;
  castShadow?: boolean;
}

const partCache = new Map<string, Part[]>();

/** Build a model's part list once per key and return the cached list afterwards. */
export function cachedParts(key: string, make: () => Part[]): Part[] {
  let p = partCache.get(key);
  if (!p) {
    p = make();
    partCache.set(key, p);
  }
  return p;
}

/** A new node holding one Mesh3D per part (shared geometry + material => instanced draws). */
export function instantiate(list: readonly Part[], label: string): Container3D {
  const node = new Container3D({ label });
  for (const p of list) meshOf(p, node);
  return node;
}

/** Make a mesh for a part under `parent`. */
export function meshOf(p: Part, parent: Container3D, label?: string): Mesh3D {
  const m = new Mesh3D({ geometry: p.geometry, material: p.material, label: label ?? p.label ?? 'Mesh3D' });
  if (p.castShadow === false) m.castShadow = false;
  parent.addChild(m);
  return m;
}

// ------------------------------------------------------------------ geometry

function newell(pts: readonly V3[]): V3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/** Emit a convex polygon whose front faces away from `interior`. */
export function face(mb: MeshBuilder, pts: V3[], interior: V3, paint?: PaintInput): void {
  const n = newell(pts);
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const k = pts.length;
  const d = n[0] * (cx / k - interior[0]) + n[1] * (cy / k - interior[1]) + n[2] * (cz / k - interior[2]);
  mb.polygon(d < 0 ? pts.slice().reverse() : pts, paint);
}

/** Emit a convex polygon facing along `dir`. */
export function faceToward(mb: MeshBuilder, pts: V3[], dir: V3, paint?: PaintInput): void {
  const n = newell(pts);
  mb.polygon(n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0 ? pts.slice().reverse() : pts, paint);
}

export interface Ring {
  y: number;
  rx: number;
  rz: number;
  x?: number;
  z?: number;
}

export interface LoftOptions {
  sides?: number;
  /** Rotation of the first vertex (default: a flat face toward +Z/-Z). */
  angle?: number;
  capTop?: boolean;
  capBottom?: boolean;
  /** Per-band paint (band i = between ring i and i+1). Overrides `bottom/top`. */
  bands?: readonly PaintInput[];
  /** Gradient colours by band (sRGB hex), mixed per band. */
  bottom?: number;
  top?: number;
  /** Only keep faces whose centre satisfies this (e.g. half shells). */
  keep?: (c: V3) => boolean;
}

/**
 * Faceted lofted solid through horizontal elliptical rings (local Y up). Each band gets one flat
 * colour, so gradients read as crisp facet steps (the chunky low-poly look).
 */
export function loft(mb: MeshBuilder, rings: readonly Ring[], opts: LoftOptions = {}): void {
  const n = opts.sides ?? 8;
  const a0 = opts.angle ?? Math.PI / 2 - Math.PI / n;
  const pts: V3[][] = rings.map((r) => {
    const out: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      out.push([(r.x ?? 0) + Math.cos(a) * r.rx, r.y, (r.z ?? 0) + Math.sin(a) * r.rz]);
    }
    return out;
  });
  const bandCount = rings.length - 1;
  const paintOf = (b: number): PaintInput | undefined => {
    if (opts.bands) return opts.bands[Math.min(b, opts.bands.length - 1)];
    if (opts.bottom !== undefined) {
      const t = bandCount <= 1 ? 0.5 : b / (bandCount - 1);
      return mixHex(opts.bottom, opts.top ?? opts.bottom, t);
    }
    return undefined;
  };
  for (let b = 0; b < bandCount; b++) {
    const r0 = rings[b], r1 = rings[b + 1];
    const deg0 = r0.rx < 1e-6 && r0.rz < 1e-6;
    const deg1 = r1.rx < 1e-6 && r1.rz < 1e-6;
    if (deg0 && deg1) continue;
    const interior: V3 = [((r0.x ?? 0) + (r1.x ?? 0)) / 2, (r0.y + r1.y) / 2, ((r0.z ?? 0) + (r1.z ?? 0)) / 2];
    const paint = paintOf(b);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const q: V3[] = [];
      if (deg0) q.push(pts[b][0]);
      else q.push(pts[b][i], pts[b][j]);
      if (deg1) q.push(pts[b + 1][0]);
      else q.push(pts[b + 1][j], pts[b + 1][i]);
      if (opts.keep) {
        let cx = 0, cy = 0, cz = 0;
        for (const p of q) {
          cx += p[0];
          cy += p[1];
          cz += p[2];
        }
        if (!opts.keep([cx / q.length, cy / q.length, cz / q.length])) continue;
      }
      face(mb, q, interior, paint);
    }
  }
  const last = rings.length - 1;
  if ((opts.capTop ?? true) && rings[last].rx > 1e-6) faceToward(mb, pts[last], [0, 1, 0], paintOf(bandCount - 1));
  if ((opts.capBottom ?? true) && rings[0].rx > 1e-6) faceToward(mb, pts[0], [0, -1, 0], paintOf(0));
}

/**
 * Convex hull of a "box-like" solid given its 8 corners: bottom quad (4, any consistent order)
 * then top quad (same order). Handy for tapered blocks, wedges and skewed panels.
 */
export function hull8(mb: MeshBuilder, c: readonly V3[], paint?: PaintInput): void {
  const centre: V3 = [0, 0, 0];
  for (const p of c) {
    centre[0] += p[0] / 8;
    centre[1] += p[1] / 8;
    centre[2] += p[2] / 8;
  }
  const [a, b, cc, d, e, f, g, h] = c;
  face(mb, [a, b, cc, d], centre, paint);
  face(mb, [e, f, g, h], centre, paint);
  face(mb, [a, b, f, e], centre, paint);
  face(mb, [b, cc, g, f], centre, paint);
  face(mb, [cc, d, h, g], centre, paint);
  face(mb, [d, a, e, h], centre, paint);
}

/** Tapered box: bottom w0 x d0 at y0, top w1 x d1 at y1 (centred on x/z, top shifted by dz). */
export function taper(
  mb: MeshBuilder,
  y0: number, y1: number,
  w0: number, d0: number,
  w1: number, d1: number,
  paint?: PaintInput,
  dz = 0,
  dx = 0,
): void {
  const bx = w0 / 2, bz = d0 / 2, tx = w1 / 2, tz = d1 / 2;
  hull8(mb, [
    [-bx, y0, -bz], [bx, y0, -bz], [bx, y0, bz], [-bx, y0, bz],
    [-tx + dx, y1, -tz + dz], [tx + dx, y1, -tz + dz], [tx + dx, y1, tz + dz], [-tx + dx, y1, tz + dz],
  ], paint);
}

/** Flat ring (annulus) in the XY plane, extruded along Z (depth), centred on the origin. */
export function ring(mb: MeshBuilder, rOuter: number, rInner: number, depth: number, segs: number, paint?: PaintInput, arc = Math.PI * 2, a0 = 0, back = true, inner = true): void {
  const z0 = -depth / 2, z1 = depth / 2;
  const full = arc >= Math.PI * 2 - 1e-6;
  const count = full ? segs : segs + 1;
  const P = (r: number, i: number, z: number): V3 => {
    const a = a0 + (i / segs) * arc;
    return [Math.cos(a) * r, Math.sin(a) * r, z];
  };
  for (let i = 0; i < segs; i++) {
    const j = full ? (i + 1) % count : i + 1;
    const mid = a0 + ((i + 0.5) / segs) * arc;
    const rm = (rOuter + rInner) / 2;
    const interior: V3 = [Math.cos(mid) * rm, Math.sin(mid) * rm, 0];
    face(mb, [P(rOuter, i, z1), P(rOuter, j, z1), P(rInner, j, z1), P(rInner, i, z1)], interior, paint);
    if (back) face(mb, [P(rOuter, i, z0), P(rOuter, j, z0), P(rInner, j, z0), P(rInner, i, z0)], interior, paint);
    face(mb, [P(rOuter, i, z0), P(rOuter, j, z0), P(rOuter, j, z1), P(rOuter, i, z1)], interior, paint);
    if (inner && rInner > 1e-6) face(mb, [P(rInner, i, z0), P(rInner, j, z0), P(rInner, j, z1), P(rInner, i, z1)], interior, paint);
  }
  if (!full) {
    for (const i of [0, segs]) {
      const a = a0 + (i / segs) * arc;
      const da = i === 0 ? 0.01 : -0.01;
      const rm = (rOuter + rInner) / 2;
      const interior: V3 = [Math.cos(a + da) * rm, Math.sin(a + da) * rm, 0];
      face(mb, [P(rOuter, i, z0), P(rOuter, i, z1), P(rInner, i, z1), P(rInner, i, z0)], interior, paint);
    }
  }
}

/** Alternating colour bands along X on a block from (x0, y0) to (x1, y1), depth d centred on z. */
export function stripedBlock(mb: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, a: number, b: number, n: number): void {
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) mb.block(x0 + i * w, y0, z0, x0 + (i + 1) * w, y1, z1, i % 2 ? b : a);
}

/**
 * Diagonal hazard stripes painted on a vertical rectangle facing +Z (or -Z with `back`), as thin
 * parallelogram decals offset `eps` in front of the surface at z. Stripes are clipped to the rect.
 */
export function diagonalStripes(
  mb: MeshBuilder,
  x0: number, x1: number, y0: number, y1: number, z: number,
  color: number, period: number, facing: 1 | -1, slant = 1,
): void {
  const h = y1 - y0;
  const half = period / 2;
  // Each stripe is the band between lines x - slant*(y-y0) = s and = s + half, clipped.
  for (let s = x0 - h * Math.abs(slant) - period; s < x1 + period; s += period) {
    const poly = clipBand(x0, x1, y0, y1, s, s + half, slant);
    if (poly.length < 3) continue;
    const pts: V3[] = poly.map(([x, y]) => [x, y, z]);
    faceToward(mb, pts, [0, 0, facing], color);
  }
}

/** Clip the band s0 <= x - slant*(y - y0) <= s1 against the rectangle; returns a convex polygon. */
function clipBand(x0: number, x1: number, y0: number, y1: number, s0: number, s1: number, slant: number): [number, number][] {
  let poly: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const f = (p: [number, number]) => p[0] - slant * (p[1] - y0);
  const clip = (keep: (v: number) => boolean, edge: number) => {
    const out: [number, number][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a), fb = f(b);
      const ka = keep(fa), kb = keep(fb);
      if (ka) out.push(a);
      if (ka !== kb) {
        const t = (edge - fa) / (fb - fa);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
  };
  clip((v) => v >= s0, s0);
  if (poly.length) clip((v) => v <= s1, s1);
  return poly;
}

// ----------------------------------------------------------------- materials

const matCache = new Map<string, BaseMaterial3D>();

function cachedMat<T extends BaseMaterial3D>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) {
    m = make();
    m.label = key;
    matCache.set(key, m);
  }
  return m;
}

/**
 * Unlit, alpha-blended vertex-colour material (light cones, flames, auras). Vertex alpha (paint
 * `alpha`, per part / loft band) fades the shape. Casts no shadow (blend).
 *
 * Note: `state.blendMode = 'add'` on a 3D material renders solid white with this engine version,
 * so everything here uses normal alpha blending.
 */
export function fadeVC(fog = true): FlatMaterial {
  return cachedMat(`models:fadevc:${fog}`, () => new FlatMaterial({ baseColor: 0xffffff, vertexColors: true, alphaMode: 'blend', alpha: 1, fog, doubleSided: true }));
}

const FRESNEL_GL = `{
  vec3 fV = normalize(uCameraPosition - vPosition);
  float fR = pow(1.0 - abs(dot(normalize(normal), fV)), material.rimPower);
  albedo = decodeColor(material.rimColor.rgb) * (material.faceGlow + material.rimGlow * fR);
  alpha = clamp(material.faceAlpha + fR * (1.0 - material.faceAlpha), 0.0, 1.0);
}`;
const FRESNEL_GPU = `{
  let fV = normalize(camera.uCameraPosition - input.vPosition);
  let fR = pow(1.0 - abs(dot(normalize(normal), fV)), material.rimPower);
  albedo = decodeColor(material.rimColor.rgb) * (material.faceGlow + material.rimGlow * fR);
  alpha = clamp(material.faceAlpha + fR * (1.0 - material.faceAlpha), 0.0, 1.0);
}`;
const fresnelBit: ShaderBit = {
  name: 'waymanFresnel',
  bindings: { material: { rimColor: 'vec4<f32>', rimPower: 'f32', faceGlow: 'f32', rimGlow: 'f32', faceAlpha: 'f32' } },
  gpu: { fragment: { material: FRESNEL_GPU } },
  gl: { fragment: { material: FRESNEL_GL } },
};

export interface FresnelOptions {
  /** Opacity seen face-on (0..1). */
  faceAlpha?: number;
  /** Rim sharpness (higher = thinner rim). */
  power?: number;
  /** Brightness face-on / added at the rim (values above 1 bloom). */
  faceGlow?: number;
  rimGlow?: number;
}

/**
 * Unlit "energy bubble": nearly clear face-on, bright and opaque at grazing angles. `color` is
 * sRGB hex. Cached per colour + options.
 */
export function fresnelGlow(color: number, o: FresnelOptions = {}): FlatMaterial {
  const faceAlpha = o.faceAlpha ?? 0.06, power = o.power ?? 2.2, faceGlow = o.faceGlow ?? 0.8, rimGlow = o.rimGlow ?? 2.2;
  return cachedMat(`models:fresnel:${color}:${faceAlpha}:${power}:${faceGlow}:${rimGlow}`, () => {
    const m = new FlatMaterial({ baseColor: 0xffffff, alphaMode: 'blend', alpha: 1, extraBits: [fresnelBit] });
    m.data.rimColor = [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, 1];
    m.data.rimPower = power;
    m.data.faceGlow = faceGlow;
    m.data.rimGlow = rimGlow;
    m.data.faceAlpha = faceAlpha;
    return m;
  });
}

const GLOW_VC_CODE = '{ emissive = albedo * material.glowStrength; }';
const glowVcBit: ShaderBit = {
  name: 'waymanGlowVC',
  bindings: { material: { glowStrength: 'f32' } },
  gpu: { fragment: { material: GLOW_VC_CODE } },
  gl: { fragment: { material: GLOW_VC_CODE } },
};

/**
 * Emissive in the colour of the vertex colours, so one merged mesh can hold white headlights,
 * amber signs and red tail lights. `strength` > 1 blooms.
 */
export function glowVC(strength = 2.5): Material3D {
  return cachedMat(`models:glowvc:${strength}`, () => {
    const m = new Material3D({
      baseColor: 0xffffff,
      vertexColors: true,
      roughness: 0.5,
      emissive: { color: 0x000000, strength: 0 },
      extraBits: [glowVcBit],
    });
    m.data.glowStrength = strength;
    return m;
  });
}

/** Glossy painted metal for vehicles (vertex colours). */
export function paintGloss(): Material3D {
  return cachedMat('models:paint', () => new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.38, metallic: 0.1 }));
}

/** Tinted see-through glass with a strong glint (vehicle windows). */
export function windowGlass(): Material3D {
  return cachedMat('models:glass', () => new Material3D({ baseColor: 0x9fd6f0, roughness: 0.08, metallic: 0.3, alphaMode: 'blend', alpha: 0.42 }));
}

// ------------------------------------------------------------------ hero look

const HERO_GL = `{
  float hF = 1.0 - clamp(dot(normalize(normal), viewDir), 0.0, 1.0);
  float hF2 = hF * hF;
  float hRim = hF2 * hF2;
  // Rim tinted by the surface colour so thin limbs keep their identity instead of turning white.
  emissive += albedo * material.heroLift + material.heroRim.rgb * (albedo * 2.0 + vec3(0.12)) * (hRim * material.heroRim.a);
  emissive += vColor.rgb * (1.0 - vColor.a) * material.heroGlow;
}`;
const HERO_GPU = `{
  let hF = 1.0 - clamp(dot(normalize(normal), viewDir), 0.0, 1.0);
  let hF2 = hF * hF;
  let hRim = hF2 * hF2;
  emissive += albedo * material.heroLift + material.heroRim.rgb * (albedo * 2.0 + vec3<f32>(0.12)) * (hRim * material.heroRim.a);
  emissive += input.vColor.rgb * (1.0 - input.vColor.a) * material.heroGlow;
}`;
const heroBit: ShaderBit = {
  name: 'waymanHeroLook',
  bindings: { material: { heroRim: 'vec4<f32>', heroLift: 'f32', heroGlow: 'f32' } },
  gpu: { fragment: { material: HERO_GPU } },
  gl: { fragment: { material: HERO_GL } },
};

/** Per-zone hero readability controls (pushed by Atmosphere; cheap uniform writes). */
export interface HeroLook {
  /** Rim (back/edge) light colour, sRGB hex, and strength (linear; ~0.3 subtle, 1+ blooms). */
  rimColor: number;
  rim: number;
  /** Self-lift: fraction of the albedo added as emission so the hero never sinks into the dark. */
  lift: number;
  /** Emission of the reflective accents (faces painted with vertex alpha < 1). */
  glow: number;
}

/**
 * The hero's lit vertex-colour material with a view-dependent rim light, a small albedo lift and
 * vertex-alpha emission for the reflective accents (hi-vis bands, soles, satchel reflector).
 */
export function heroMaterial(): Material3D {
  return cachedMat('models:hero', () => {
    const m = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.68, metallic: 0, extraBits: [heroBit] });
    m.data.heroRim = [1, 0.85, 0.6, 0.3];
    m.data.heroLift = 0.04;
    m.data.heroGlow = 0.4;
    return m;
  });
}

const rimTmp = [0, 0, 0, 0];

/** Apply a HeroLook to the hero material (no allocation). */
export function setHeroLook(l: Readonly<HeroLook>): void {
  const m = heroMaterial();
  const c = l.rimColor;
  // sRGB -> linear (gamma 2.2 is plenty for a rim tint).
  rimTmp[0] = Math.pow(((c >> 16) & 255) / 255, 2.2);
  rimTmp[1] = Math.pow(((c >> 8) & 255) / 255, 2.2);
  rimTmp[2] = Math.pow((c & 255) / 255, 2.2);
  rimTmp[3] = l.rim;
  m.data.heroRim = rimTmp;
  m.data.heroLift = l.lift;
  m.data.heroGlow = l.glow;
}
