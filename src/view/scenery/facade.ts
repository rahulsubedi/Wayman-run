// Facade modules: windows, shopfronts, awnings, balconies, signs, cornices, drainpipes, AC units.
//
// Facade frame (a right-side building, street on the -X side):
//   x = 0 is the wall face, details protrude toward -x; z runs along the facade; y is up.
// Faces nobody can see (the side glued to the wall, tops above any camera height, undersides
// below eye level) are skipped to save triangles.
import type { MeshBuilder, Paint, PaintInput } from '../geom';
import { shadeHex, mixHex } from '../geom/color';
import { slab, glowPaint, grad, Rand, NX, PY, NY, PZ, NZ, PX, panelNX, quadN, bar } from './kit';
import * as P from './palette';

/** Highest camera eye (flying) and lowest (running): used to drop invisible faces. */
const EYE_MAX = 9.5;
const EYE_MIN = 3.0;

/** A facade detail block glued to the wall (x1 <= 0), with automatic face culling. */
export function det(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, paint: PaintInput): void {
  let f = NX | PZ | NZ;
  if (Math.max(y0, y1) < EYE_MAX) f |= PY;
  if (Math.min(y0, y1) > EYE_MIN) f |= NY;
  slab(mb, x0, y0, z0, x1, y1, z1, paint, f);
}

/** A free-standing block in front of the wall (all faces except hidden top/bottom). */
export function free(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, paint: PaintInput): void {
  let f = NX | PX | PZ | NZ;
  if (Math.max(y0, y1) < EYE_MAX) f |= PY;
  if (Math.min(y0, y1) > EYE_MIN) f |= NY;
  slab(mb, x0, y0, z0, x1, y1, z1, paint, f);
}

export interface Look {
  wall: number;
  trim: number;
  accent: number;
  shutter: number;
  night: boolean;
  rnd: Rand;
  /** Probability a window is lit at night. */
  litChance: number;
}

const glassPaint: Paint = { color: P.GLASS_BOTTOM, bottom: P.GLASS_BOTTOM, top: P.GLASS_TOP, jitter: 0.06 };

/** Glass paint for one pane: dark reflective by day; at night maybe a warm lit window. */
export function glass(look: Look, bright = 0.32): Paint {
  if (look.night && look.rnd.chance(look.litChance)) {
    const c = look.rnd.pick([P.LIGHT_WARM, P.LIGHT_AMBER, P.LIGHT_CREAM, P.LIGHT_WARM]);
    return glowPaint(c, bright * look.rnd.range(0.75, 1.25));
  }
  if (look.night) return { color: 0x1c2533, bottom: 0x161d29, top: 0x2b3a50, jitter: 0.05 };
  return glassPaint;
}

/** Four glass panes (2 x 2) in the plane x, leaving 6 cm gaps that show the frame behind. */
export function panes(mb: MeshBuilder, look: Look, z0: number, z1: number, y0: number, y1: number, x: number, bright: number): void {
  const g = 0.035;
  const zm = (z0 + z1) / 2, ym = y0 + (y1 - y0) * 0.7;
  const p = glass(look, bright);
  panelNX(mb, x, y0, z0, ym - g, zm - g, p);
  panelNX(mb, x, y0, zm + g, ym - g, z1, p);
  panelNX(mb, x, ym + g, z0, y1, zm - g, p);
  panelNX(mb, x, ym + g, zm + g, y1, z1, p);
}

/** Plain framed window: frame block, glass pane in front, sill, lintel. (y0 = bottom of glass) */
export function window(mb: MeshBuilder, look: Look, zc: number, y0: number, ww: number, wh: number, opts: { shutters?: boolean; box?: boolean; arched?: boolean; lintel?: boolean } = {}): void {
  const z0 = zc - ww / 2, z1 = zc + ww / 2;
  const fr = 0.12;
  const frameC = look.night ? shadeHex(look.trim, 0.8) : look.trim;
  if (opts.arched) {
    // Arched top: frame + glass as extruded profiles (polygon in z/y, extruded along x).
    const r = ww / 2;
    const prof = (inset: number): [number, number][] => {
      const pts: [number, number][] = [[z0 + inset, y0 + inset], [z1 - inset, y0 + inset]];
      const rr = r - inset;
      for (let k = 0; k <= 6; k++) {
        const a = (k / 6) * Math.PI;
        pts.push([zc + Math.cos(a) * rr, y0 + wh - r + Math.sin(a) * rr]);
      }
      return pts;
    };
    mb.push().translate(-0.04, 0, 0).rotateY(-Math.PI / 2);
    // After rotateY(-90°): local x -> world z, local z -> world -x... extrude depth along local z.
    mb.extrude(prof(-fr).map(([z, y]) => [z, y] as [number, number]), 0.08, frameC);
    mb.pop();
    mb.push().translate(-0.1, 0, 0).rotateY(-Math.PI / 2);
    mb.extrude(prof(0.02), 0.02, glass(look));
    mb.pop();
  } else {
    // Frame block with four glass panes in front of it: the gaps between panes read as the
    // mullion and transom without extra geometry.
    det(mb, -0.08, y0 - fr, z0 - fr, 0, y0 + wh + fr, z1 + fr, frameC);
    panes(mb, look, z0, z1, y0, y0 + wh, -0.1, 0.36);
  }
  // Sill.
  det(mb, -0.22, y0 - fr - 0.1, z0 - fr - 0.08, 0, y0 - fr + 0.02, z1 + fr + 0.08, shadeHex(look.trim === 0xffffff ? 0xeee6d6 : 0xf1ebe0, 0.97));
  if (opts.lintel !== false && !opts.arched) {
    det(mb, -0.16, y0 + wh + fr, z0 - fr - 0.06, 0, y0 + wh + fr + 0.18, z1 + fr + 0.06, shadeHex(look.wall, 0.86));
  }
  if (opts.shutters) {
    const sw = ww / 2 + 0.05;
    const sc = grad(look.shutter, 0.82);
    for (const sd of [-1, 1]) {
      const za = sd < 0 ? z0 - fr - sw - 0.02 : z1 + fr + 0.02;
      det(mb, -0.07, y0 - 0.05, za, 0, y0 + wh + 0.05, za + sw, sc);
      det(mb, -0.1, y0 + wh * 0.48, za + 0.05, -0.07, y0 + wh * 0.54, za + sw - 0.05, shadeHex(look.shutter, 0.7));
    }
  }
  if (opts.box) flowerBox(mb, look, zc, y0 - fr - 0.1, ww + 0.3);
}

export function flowerBox(mb: MeshBuilder, look: Look, zc: number, yTop: number, w: number): void {
  const z0 = zc - w / 2, z1 = zc + w / 2;
  det(mb, -0.5, yTop - 0.35, z0, -0.12, yTop, z1, grad(look.rnd.pick([0xb5563a, 0x8b5a3c, 0x2a8f86, 0xe9e2d2]), 0.8));
  // Foliage (one long low-poly mound) + a few flowers.
  mb.push().translate(-0.31, yTop + 0.06, zc).sphere(0.24, 0.2, w / 2 - 0.05, 6, 3, { color: P.LEAF, bottom: P.LEAF_DARK, top: shadeHex(P.LEAF, 1.15) }).pop();
  const n = Math.max(2, Math.round(w / 0.5));
  for (let k = 0; k < n; k += 2) {
    const z = z0 + ((k + 0.5) / n) * w;
    slab(mb, -0.5, yTop + 0.12, z - 0.06, -0.38, yTop + 0.26, z + 0.06, look.rnd.pick(P.FLOWERS), NX | PY | PZ | NZ);
  }
}

/** Balcony slab + iron railing in front of a French door. */
export function balcony(mb: MeshBuilder, look: Look, z0: number, z1: number, yFloor: number, depth = 0.85): void {
  const iron = look.night ? 0x1e2428 : P.IRON;
  det(mb, -depth, yFloor - 0.16, z0, 0, yFloor + 0.02, z1, grad(shadeHex(look.trim === 0xffffff ? 0xece5d8 : 0xe9e1d2, 1), 0.85));
  // Corbels.
  for (const z of [z0 + 0.25, z1 - 0.25]) det(mb, -depth * 0.7, yFloor - 0.45, z - 0.08, 0, yFloor - 0.16, z + 0.08, shadeHex(look.wall, 0.85));
  const h = 1.0;
  // Top rail (front + returns), bottom rail, balusters (street-facing faces only).
  free(mb, -depth, yFloor + h - 0.05, z0, -depth + 0.06, yFloor + h, z1, iron);
  det(mb, -depth, yFloor + 0.1, z0, -depth + 0.04, yFloor + 0.15, z1, iron);
  for (const z of [z0, z1 - 0.05]) det(mb, -depth, yFloor + h - 0.05, z, 0, yFloor + h, z + 0.05, iron);
  const n = Math.max(3, Math.round((z1 - z0) / 0.42));
  for (let k = 0; k <= n; k++) {
    const z = z0 + 0.03 + ((z1 - z0 - 0.06) * k) / n;
    slab(mb, -depth + 0.005, yFloor + 0.02, z - 0.02, -depth + 0.045, yFloor + h, z + 0.02, iron, NX | PZ | NZ);
  }
  // A potted plant on some balconies.
  if (look.rnd.chance(0.3)) {
    const z = look.rnd.range(z0 + 0.4, z1 - 0.4);
    mb.push().translate(-depth * 0.45, yFloor + 0.22, z);
    mb.cylinder(0.18, 0.4, 5, { radiusTop: 0.22, capBottom: false }, 0xb5563a);
    mb.translate(0, 0.45, 0).sphere(0.3, 0.32, 0.3, 5, 3, { color: P.LEAF, bottom: P.LEAF_DARK });
    mb.pop();
  }
}

/** French door (tall glazing) used behind balconies. */
export function frenchDoor(mb: MeshBuilder, look: Look, zc: number, yFloor: number, ww: number, wh: number): void {
  const z0 = zc - ww / 2, z1 = zc + ww / 2;
  const frameC = look.night ? shadeHex(look.trim, 0.8) : look.trim;
  det(mb, -0.08, yFloor, z0 - 0.12, 0, yFloor + wh + 0.12, z1 + 0.12, frameC);
  panes(mb, look, z0, z1, yFloor + 0.05, yFloor + wh, -0.1, 0.36);
  det(mb, -0.16, yFloor + wh + 0.12, z0 - 0.2, 0, yFloor + wh + 0.32, z1 + 0.2, shadeHex(look.wall, 0.85));
}

/**
 * Striped awning: sloped canvas from the wall out over the sidewalk, scalloped valance.
 * Built from strips along z so the stripes are real geometry (two colours).
 */
export function awning(mb: MeshBuilder, z0: number, z1: number, yTop: number, out: number, drop: number, colors: [number, number], night = false): void {
  const n = Math.max(2, Math.round((z1 - z0) / 0.5));
  const sw = (z1 - z0) / n;
  const yb = yTop - drop;
  const dim = (c: number) => (night ? shadeHex(c, 0.75) : c);
  for (let k = 0; k < n; k++) {
    const za = z0 + k * sw, zb = za + sw;
    const c = dim(colors[k % 2]);
    // Top surface (faces up/out) and underside (faces down/in).
    quadN(mb, [0, yTop, za], [0, yTop, zb], [-out, yb, zb], [-out, yb, za], [-drop, out, 0], { color: c, jitter: 0.03 });
    quadN(mb, [0, yTop, za], [0, yTop, zb], [-out, yb, zb], [-out, yb, za], [drop, -out, 0], { color: shadeHex(c, 0.72), jitter: 0.03 });
    // Valance with a scallop.
    quadN(mb, [-out, yb, za], [-out, yb, zb], [-out, yb - 0.28, zb], [-out, yb - 0.28, za], [-1, 0, 0], { color: c, jitter: 0.03 });
    quadN(mb, [-out, yb, za], [-out, yb, zb], [-out, yb - 0.28, zb], [-out, yb - 0.28, za], [1, 0, 0], { color: shadeHex(c, 0.7), jitter: 0.03 });
    mb.tri([-out, yb - 0.28, za], [-out, yb - 0.28, zb], [-out, yb - 0.42, (za + zb) / 2], { color: c });
    mb.tri([-out, yb - 0.28, zb], [-out, yb - 0.28, za], [-out, yb - 0.42, (za + zb) / 2], { color: shadeHex(c, 0.7) });
  }
  // Side cheeks.
  for (const [z, s] of [[z0, -1], [z1, 1]] as const) {
    mb.polygon(s < 0 ? [[0, yTop, z], [-out, yb, z], [-out, yb - 0.28, z], [0, yb - 0.1, z]] : [[0, yTop, z], [0, yb - 0.1, z], [-out, yb - 0.28, z], [-out, yb, z]], dim(colors[0]));
  }
  // Rail along the top.
  det(mb, -0.12, yTop - 0.05, z0, 0, yTop + 0.08, z1, P.IRON);
}

/** Shop sign fascia with stylised "lettering" blocks; letters glow at night. */
export function fascia(mb: MeshBuilder, look: Look, z0: number, z1: number, y0: number, y1: number): void {
  const board = look.night ? shadeHex(look.accent, 0.55) : look.accent;
  det(mb, -0.14, y0, z0, 0, y1, z1, grad(board, 0.85));
  det(mb, -0.18, y1 - 0.06, z0, -0.14, y1, z1, shadeHex(board, 0.8));
  const letters = Math.max(3, Math.min(9, Math.round((z1 - z0) / 0.7)));
  const lw = ((z1 - z0) * 0.7) / letters;
  const start = (z0 + z1) / 2 - (letters * lw) / 2;
  const lc = look.night ? look.rnd.pick(P.NEON) : (look.accent === 0xffffff || look.accent === 0xe9c46a ? 0x264653 : 0xfbf3e4);
  const lp: Paint = look.night ? glowPaint(lc, 0.85) : { color: lc, jitter: 0.02 };
  const lh = (y1 - y0) * 0.5;
  for (let k = 0; k < letters; k++) {
    const z = start + k * lw;
    const tall = look.rnd.chance(0.3) ? 1.15 : 1;
    det(mb, -0.2, (y0 + y1) / 2 - lh / 2, z + lw * 0.15, -0.14, (y0 + y1) / 2 + (lh / 2) * tall, z + lw * 0.85, lp);
  }
}

/** Projecting blade sign on an iron bracket. */
export function bladeSign(mb: MeshBuilder, look: Look, z: number, y: number): void {
  const iron = P.IRON;
  free(mb, -1.25, y + 0.62, z - 0.03, 0, y + 0.68, z + 0.03, iron);
  bar(mb, [-0.05, y + 0.1, z], [-0.9, y + 0.65, z], 0.04, iron);
  const c = look.rnd.pick([P.TRIMS[0], P.TRIMS[1], P.TRIMS[2], P.TRIMS[5], 0xd1495b]);
  const round = look.rnd.chance(0.5);
  mb.push().translate(-0.75, y + 0.15, z);
  if (round) {
    mb.rotateX(Math.PI / 2).cylinder(0.42, 0.08, 10, {}, look.night ? glowPaint(c, 0.25) : grad(c, 0.85));
    mb.cylinder(0.3, 0.1, 10, {}, look.night ? glowPaint(0xffe2a8, 0.4) : 0xfbf3e4);
  } else {
    mb.box(0.75, 0.6, 0.08, look.night ? glowPaint(c, 0.25) : grad(c, 0.85));
    mb.box(0.55, 0.4, 0.1, look.night ? glowPaint(0xffe2a8, 0.4) : 0xfbf3e4);
  }
  mb.pop();
}

/** Small string of glowing bulbs under a fascia or awning (night). */
export function bulbString(mb: MeshBuilder, z0: number, z1: number, y: number, x: number, colors: readonly number[], rnd: Rand): void {
  const n = Math.max(3, Math.round((z1 - z0) / 0.85));
  const sagAt = (t: number) => Math.sin(t * Math.PI) * 0.25;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const z = z0 + (z1 - z0) * t;
    const yy = y - sagAt(t);
    const p = glowPaint(colors[rnd.int(colors.length)], 0.95);
    // Two crossed quads (street-facing and run-facing) read as a bulb from every useful angle.
    quadN(mb, [x, yy - 0.07, z - 0.06], [x, yy - 0.07, z + 0.06], [x, yy + 0.07, z + 0.06], [x, yy + 0.07, z - 0.06], [-1, 0, 0], p);
    quadN(mb, [x - 0.06, yy - 0.07, z], [x + 0.06, yy - 0.07, z], [x + 0.06, yy + 0.07, z], [x - 0.06, yy + 0.07, z], [0, 0, 1], p);
  }
  for (let k = 0; k < n; k++) {
    const ta = k / n, tb = (k + 1) / n;
    bar(mb, [x, y + 0.06 - sagAt(ta), z0 + (z1 - z0) * ta], [x, y + 0.06 - sagAt(tb), z0 + (z1 - z0) * tb], 0.02, 0x222222, 3);
  }
}

/** AC unit hung under a window. */
export function acUnit(mb: MeshBuilder, z: number, y: number): void {
  free(mb, -0.55, y, z - 0.42, -0.02, y + 0.55, z + 0.42, grad(0xdedad2, 0.8));
  panelNX(mb, -0.56, y + 0.08, z - 0.32, y + 0.47, z + 0.1, 0x8e938f);
  mb.push().translate(-0.56, y + 0.27, z + 0.24).rotateZ(Math.PI / 2).cylinder(0.12, 0.02, 8, {}, 0x6c706d).pop();
  free(mb, -0.4, y - 0.08, z - 0.35, -0.3, y, z + 0.35, P.IRON);
}

/** Drainpipe down the full height with brackets. */
export function drainpipe(mb: MeshBuilder, z: number, h: number, color: number): void {
  mb.push().translate(-0.16, h / 2, z).cylinder(0.075, h, 6, { capTop: false, capBottom: false }, grad(color, 0.75)).pop();
  for (let y = 1.5; y < h; y += 2.6) free(mb, -0.2, y, z - 0.1, 0, y + 0.06, z + 0.1, shadeHex(color, 0.8));
  mb.push().translate(-0.3, 0.25, z).box(0.3, 0.12, 0.18, shadeHex(color, 0.8)).pop();
}

/** Door: recessed panelled door with fanlight. */
export function door(mb: MeshBuilder, look: Look, zc: number, w: number, h: number, color: number): void {
  const z0 = zc - w / 2, z1 = zc + w / 2;
  det(mb, -0.14, 0.15, z0 - 0.16, 0, h + 0.25, z1 + 0.16, look.night ? shadeHex(look.trim, 0.8) : look.trim);
  panelNX(mb, -0.15, 0.15, z0, h - 0.5, z1, grad(color, 0.75));
  panelNX(mb, -0.15, h - 0.45, z0, h, z1, glass(look, 0.5));
  // Panels.
  for (const zz of [z0 + w * 0.12, zc + w * 0.06]) {
    det(mb, -0.19, 0.5, zz, -0.15, h * 0.48, zz + w * 0.32, shadeHex(color, 1.12));
    det(mb, -0.19, h * 0.53, zz, -0.15, h - 0.65, zz + w * 0.32, shadeHex(color, 1.12));
  }
  // Step.
  slab(mb, -0.5, 0.15, z0 - 0.25, 0, 0.27, z1 + 0.25, 0xd8d1c2, NX | PY | PZ | NZ);
  void PX;
}

/** Shopfront across [z0, z1]: stall riser, display glazing in frames, a door in one bay. */
export function shopfront(mb: MeshBuilder, look: Look, z0: number, z1: number, h: number, doorAt: number, bays: number): void {
  const frame = look.night ? shadeHex(look.accent, 0.7) : look.accent;
  const bw = (z1 - z0) / bays;
  // Pilasters between bays.
  for (let i = 0; i <= bays; i++) {
    const z = z0 + i * bw;
    det(mb, -0.22, 0.15, z - 0.14, 0, h, z + 0.14, grad(frame, 0.8));
  }
  for (let i = 0; i < bays; i++) {
    const za = z0 + i * bw + 0.14, zb = za + bw - 0.28;
    if (i === doorAt) {
      const dw = Math.min(1.3, bw - 0.4);
      const zc = (za + zb) / 2;
      // Door with glazing, a transom light above.
      panelNX(mb, -0.12, 0.15, za, h, zb, shadeHex(frame, 0.75));
      panelNX(mb, -0.14, 0.2, zc - dw / 2, h - 0.75, zc + dw / 2, glass(look, 0.28));
      det(mb, -0.2, 0.15, zc - dw / 2 - 0.06, -0.12, h - 0.7, zc - dw / 2, frame);
      det(mb, -0.2, 0.15, zc + dw / 2, -0.12, h - 0.7, zc + dw / 2 + 0.06, frame);
      det(mb, -0.2, h - 0.75, zc - dw / 2, -0.12, h - 0.68, zc + dw / 2, frame);
      panelNX(mb, -0.14, h - 0.62, zc - dw / 2, h - 0.1, zc + dw / 2, glass(look, 0.28));
      slab(mb, -0.45, 0.15, za, 0, 0.24, zb, 0xcfc7b6, NX | PY | PZ | NZ);
    } else {
      // Stall riser + glazing + glazing bars.
      det(mb, -0.16, 0.15, za, 0, 0.75, zb, grad(shadeHex(frame, 0.85), 0.75));
      panelNX(mb, -0.08, 0.75, za, h - 0.1, zb, glass(look, 0.2));
      det(mb, -0.2, 0.72, za, -0.1, 0.82, zb, frame);
      det(mb, -0.14, h - 0.65, za, -0.08, h - 0.58, zb, frame);
      det(mb, -0.14, 0.82, (za + zb) / 2 - 0.03, -0.08, h - 0.1, (za + zb) / 2 + 0.03, frame);
      // Goods silhouettes in the window (day only: shelves with colourful boxes).
      if (!look.night && look.rnd.chance(0.7)) {
        for (let k = 0; k < 3; k++) {
          const zz = za + 0.25 + k * ((zb - za - 0.5) / 2);
          panelNX(mb, -0.085, 0.9, zz - 0.15, 1.25 + look.rnd.range(0, 0.3), zz + 0.15, { color: look.rnd.pick(P.FLOWERS), jitter: 0.05, top: undefined });
        }
      }
    }
  }
  // Head beam.
  det(mb, -0.24, h, z0 - 0.0, 0, h + 0.22, z1, grad(frame, 0.85));
}

/** Arcade: piers + arches in front of a recessed shop wall at x = depth. */
export function arcade(mb: MeshBuilder, look: Look, z0: number, z1: number, h: number, bays: number, depth: number): void {
  const bw = (z1 - z0) / bays;
  const pier = 0.55;
  const stone = mixHex(look.wall, 0xffffff, 0.15);
  // Arch faces: one extruded concave profile per bay (rectangle minus a round-headed opening).
  for (let i = 0; i < bays; i++) {
    const za = z0 + i * bw, zb = za + bw;
    const oa = za + pier / 2, ob = zb - pier / 2;
    const r = (ob - oa) / 2;
    const spring = h - r - 0.35;
    const pts: [number, number][] = [[za, 0], [oa, 0], [oa, spring]];
    for (let k = 1; k < 8; k++) {
      const a = Math.PI - (k / 8) * Math.PI;
      pts.push([(oa + ob) / 2 + Math.cos(a) * r, spring + Math.sin(a) * r]);
    }
    pts.push([ob, spring], [ob, 0], [zb, 0], [zb, h], [za, h]);
    mb.push().translate(-0.3, 0, 0).rotateY(-Math.PI / 2);
    mb.extrude(pts, 0.6, grad(stone, 0.8));
    mb.pop();
    // Keystone.
    det(mb, -0.66, spring + r - 0.15, (oa + ob) / 2 - 0.18, -0.6, spring + r + 0.3, (oa + ob) / 2 + 0.18, look.trim);
    // Recessed shopfront behind the arch.
    const dz0 = oa + 0.1, dz1 = ob - 0.1;
    panelNX(mb, depth - 0.02, 0.15, dz0 - 0.2, spring + r, dz1 + 0.2, shadeHex(look.wall, 0.7));
    panelNX(mb, depth - 0.05, 0.7, dz0 + 0.1, spring + r * 0.6, dz1 - 0.1, glass(look, 0.5));
  }
  // Arcade floor + ceiling + side returns (only what shows through the arches).
  slab(mb, 0, 0.13, z0, depth, 0.15, z1, 0xc9bfa9, PY);
  slab(mb, 0, h - 0.02, z0, depth, h, z1, shadeHex(look.wall, 0.6), NY);
  slab(mb, 0, 0, z0, depth, h, z0 + 0.02, shadeHex(look.wall, 0.75), PZ);
  slab(mb, 0, 0, z1 - 0.02, depth, h, z1, shadeHex(look.wall, 0.75), NZ);
  // Lamps inside the arcade at night.
  if (look.night) {
    for (let i = 0; i < bays; i++) {
      const zc = z0 + (i + 0.5) * bw;
      mb.push().translate(depth * 0.5, h - 0.45, zc).sphere(0.18, 0.22, 0.18, 6, 3, glowPaint(P.LIGHT_WARM, 0.9)).pop();
    }
  }
}

/** Roller shutter / warehouse door with ribs. */
export function bigDoor(mb: MeshBuilder, look: Look, z0: number, z1: number, h: number, color: number, open: boolean): void {
  det(mb, -0.2, 0, z0 - 0.25, 0, h + 0.3, z0, shadeHex(look.trim, 0.9));
  det(mb, -0.2, 0, z1, 0, h + 0.3, z1 + 0.25, shadeHex(look.trim, 0.9));
  det(mb, -0.2, h, z0, 0, h + 0.3, z1, shadeHex(look.trim, 0.9));
  if (open) {
    panelNX(mb, -0.01, 0.15, z0, h, z1, look.night ? glowPaint(P.LIGHT_AMBER, 0.3) : 0x2a2622);
    // Crates visible inside.
    for (let k = 0; k < 3; k++) {
      const z = z0 + 0.4 + k * ((z1 - z0 - 0.8) / 2);
      slab(mb, -0.02 - 0.0, 0.15, z - 0.35, 0.0, 0.85, z + 0.35, 0x9a7048, NX);
    }
    return;
  }
  panelNX(mb, -0.05, 0.15, z0, h, z1, grad(color, 0.8));
  for (let y = 0.5; y < h - 0.1; y += 0.32) det(mb, -0.09, y, z0, -0.05, y + 0.06, z1, shadeHex(color, 0.82));
}

/** Corrugated cladding look: vertical ribs over a wall section. */
export function ribs(mb: MeshBuilder, z0: number, z1: number, y0: number, y1: number, color: number, step = 0.55): void {
  for (let z = z0 + step / 2; z < z1 - 0.05; z += step) det(mb, -0.06, y0, z - 0.06, 0, y1, z + 0.06, shadeHex(color, 0.88));
}

export { PY, NY, NX };
