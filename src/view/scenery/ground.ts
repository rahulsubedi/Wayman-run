// Ground modules: one CHUNK_LEN slice of street (road, markings, curbs, paved sidewalks) in a few
// variants, plus the lot fill beyond the sidewalks and the harbour quay + sea.
//
// Chunk-local frame: x lateral, y up, the chunk runs from z = 0 (near end, chunk start s) to
// z = -CHUNK_LEN (far end). Road top is exactly y = 0 (obstacles stand on it); markings are thin
// quads 2 cm above it; sidewalks are 15 cm high.
import { MeshBuilder } from '../geom';
import { shadeHex } from '../geom/color';
import { ROAD_HALF_WIDTH, SIDEWALK_OUTER } from '../../sim/config';
import { panelPY, quadN, slab, Rand, PY, NX, PX, NZ, PZ, grad, bar } from './kit';
import * as P from './palette';
import { CHUNK_LEN, QUAY_EDGE } from './layoutConst';

const R = ROAD_HALF_WIDTH; // 4.5
const CURB_W = 0.3;
const SW_Y = 0.15;
const MARK_Y = 0.02;

/** Number of street-surface variants. */
export const GROUND_VARIANTS = 3;

function roadSurface(mb: MeshBuilder, rnd: Rand, variant: number): void {
  // Road built as abutting cells (no overlaps => no z-fighting) with subtle tonal variation:
  // darker wheel tracks, a gutter strip by each curb, the odd repaired patch.
  const strips = [-R, -4.15, -3.6, -1.4, -1.1, 1.1, 1.4, 3.6, 4.15, R];
  const seg = 6.25;
  for (let si = 0; si < strips.length - 1; si++) {
    const x0 = strips[si], x1 = strips[si + 1];
    const gutter = si === 0 || si === strips.length - 2;
    for (let u = 0; u < CHUNK_LEN - 1e-6; u += seg) {
      let c = gutter ? P.ASPHALT_DARK : P.ASPHALT;
      const r = rnd.next();
      if (!gutter && r < 0.08) c = P.ASPHALT_PATCH;
      panelPY(mb, x0, -u, x1, -(u + seg), 0, { color: c, jitter: 0.03 });
    }
  }
  // Lane dashes between lanes (x = ±1.25) and solid edge lines.
  const crossAt = variant === 1 ? 25 : variant === 3 ? 8 : -100;
  for (const x of [-1.25, 1.25]) {
    for (let u = 1.5; u < CHUNK_LEN; u += 6.25) {
      if (Math.abs(u + 1.5 - crossAt) < 5) continue;
      panelPY(mb, x - 0.07, -u, x + 0.07, -(u + 3), MARK_Y, { color: P.PAINT_WHITE, jitter: 0.03 });
    }
  }
  for (const x of [-4.05, 4.05]) {
    if (crossAt > 0) {
      panelPY(mb, x - 0.08, 0, x + 0.08, -(crossAt - 3), MARK_Y, P.PAINT_YELLOW);
      panelPY(mb, x - 0.08, -(crossAt + 3), x + 0.08, -CHUNK_LEN, MARK_Y, P.PAINT_YELLOW);
    } else panelPY(mb, x - 0.08, 0, x + 0.08, -CHUNK_LEN, MARK_Y, P.PAINT_YELLOW);
  }
  if (crossAt > 0) {
    // Zebra crossing: stripes along the run direction, plus stop lines.
    for (let x = -3.9; x < 3.95; x += 1.05) {
      panelPY(mb, x, -(crossAt - 1.8), x + 0.55, -(crossAt + 1.8), MARK_Y, { color: P.PAINT_WHITE, jitter: 0.04 });
    }
    panelPY(mb, -R + 0.3, -(crossAt + 2.6), R - 0.3, -(crossAt + 2.9), MARK_Y, P.PAINT_WHITE);
  }
  // Manhole covers and drains (low, flush details).
  const holes = variant === 0 ? [[-2.5, 12], [1.9, 38]] : variant === 2 ? [[0.6, 20], [-3.0, 44]] : [[2.6, 40]];
  for (const [x, u] of holes) {
    mb.push().translate(x, 0.012, -u);
    mb.cylinder(0.42, 0.024, 10, {}, 0x3b4048);
    mb.cylinder(0.3, 0.03, 10, {}, 0x474d56);
    mb.pop();
  }
  for (const side of [-1, 1]) {
    for (const u of variant % 2 === 0 ? [9, 34] : [21, 46]) {
      const x = side * 4.32;
      panelPY(mb, x - 0.18, -(u - 0.45), x + 0.18, -(u + 0.45), MARK_Y * 0.6, 0x2b3036);
      for (let k = -2; k <= 2; k++) panelPY(mb, x - 0.15, -(u + k * 0.17 - 0.03), x + 0.15, -(u + k * 0.17 + 0.03), MARK_Y, 0x5a6068);
    }
  }
  if (variant === 2) {
    // Painted arrows near the far end.
    for (const x of [-2.5, 2.5]) {
      const u = 30;
      panelPY(mb, x - 0.1, -u, x + 0.1, -(u + 2.2), MARK_Y, P.PAINT_WHITE);
      mb.push().translate(x, MARK_Y, -(u + 2.2));
      quadN(mb, [-0.45, 0, 0], [0.45, 0, 0], [0.02, 0, -1.0], [-0.02, 0, -1.0], [0, 1, 0], P.PAINT_WHITE);
      mb.pop();
    }
  }
}

function sidewalk(mb: MeshBuilder, rnd: Rand, side: -1 | 1): void {
  const xc0 = side * R, xc1 = side * (R + CURB_W);
  // Curb stones (granite): road-facing face + top, with alternating tone joints.
  for (let u = 0; u < CHUNK_LEN - 1e-6; u += 1.25) {
    const tone = rnd.next() < 0.5 ? P.CURB : shadeHex(P.CURB, 0.94);
    slab(mb, Math.min(xc0, xc1), 0, -(u + 1.25), Math.max(xc0, xc1), SW_Y, -u,
      { color: tone, top: tone, bottom: P.CURB_FACE, jitter: 0.02 }, PY | (side > 0 ? NX : PX));
  }
  // Paving: border band by the curb, running-bond slabs, border band at the building line.
  const xa = R + CURB_W, xb = SIDEWALK_OUTER;
  const bandIn = 0.35, bandOut = 0.3;
  const sx = (x: number) => side * x;
  for (let u = 0; u < CHUNK_LEN - 1e-6; u += 1.25) {
    const t1 = rnd.next() < 0.5 ? P.PAVING_BAND : shadeHex(P.PAVING_BAND, 1.06);
    panelPY(mb, sx(xa), -u, sx(xa + bandIn), -(u + 1.25), SW_Y, { color: t1, jitter: 0.04 });
    const t2 = rnd.next() < 0.5 ? P.PAVING_BAND : shadeHex(P.PAVING_BAND, 0.95);
    panelPY(mb, sx(xb - bandOut), -u, sx(xb), -(u + 1.25), SW_Y, { color: t2, jitter: 0.04 });
  }
  const rowLen = 1.0;
  const inner0 = xa + bandIn, inner1 = xb - bandOut;
  const w = inner1 - inner0;
  let row = 0;
  for (let u = 0; u < CHUNK_LEN - 1e-6; u += rowLen, row++) {
    const cuts = row % 2 === 0 ? [0, 0.33, 0.67, 1] : [0, 0.17, 0.5, 0.83, 1];
    for (let k = 0; k < cuts.length - 1; k++) {
      const c = P.PAVING[rnd.int(P.PAVING.length)];
      panelPY(mb, sx(inner0 + cuts[k] * w), -u, sx(inner0 + cuts[k + 1] * w), -(u + rowLen), SW_Y, { color: c, jitter: 0.05 });
    }
  }
}

/** One chunk of street surface (road + curbs + both sidewalks). */
export function buildGround(variant: number): MeshBuilder {
  const mb = new MeshBuilder({ seed: 700 + variant, jitter: 0.03 });
  const rnd = new Rand(900 + variant * 17);
  roadSurface(mb, rnd, variant);
  sidewalk(mb, rnd, -1);
  sidewalk(mb, rnd, 1);
  return mb;
}

/**
 * Lot fill for one side (right side frame: x from SIDEWALK_OUTER outward): paved ground under and
 * between buildings so alleys and gaps never show the void. Left side = same geometry rotated.
 */
export function buildLotFill(kind: 'town' | 'quay'): MeshBuilder {
  const mb = new MeshBuilder({ seed: kind === 'town' ? 51 : 52, jitter: 0.04 });
  const rnd = new Rand(kind === 'town' ? 77 : 78);
  if (kind === 'town') {
    for (let u = 0; u < CHUNK_LEN - 1e-6; u += 5) {
      panelPY(mb, SIDEWALK_OUTER, -u, 24, -(u + 5), SW_Y, rnd.chance(0.5) ? 0xbcae94 : 0xb4a68b);
      panelPY(mb, 24, -u, 140, -(u + 5), SW_Y, 0x9c8f78);
    }
    return mb;
  }
  // Harbour quay: stone deck out to x = 14, granite edge, quay wall down to the water, railing,
  // bollards. The sea itself is a separate glossy module.
  const edge = QUAY_EDGE;
  for (let u = 0; u < CHUNK_LEN - 1e-6; u += 2.5) {
    panelPY(mb, SIDEWALK_OUTER, -u, edge - 0.6, -(u + 2.5), SW_Y, rnd.chance(0.5) ? 0xb9ab92 : 0xc2b49a);
  }
  slab(mb, edge - 0.6, 0, -CHUNK_LEN, edge, SW_Y + 0.12, 0, grad(0xd8d2c4, 0.85), PY | PX | NX);
  slab(mb, edge - 0.02, -2.6, -CHUNK_LEN, edge, 0, 0, grad(0x8d8576, 0.6), PX);
  // Weed/wet line on the quay wall.
  slab(mb, edge, -1.55, -CHUNK_LEN, edge + 0.02, -1.25, 0, 0x4e5a4a, PX);
  // Railing posts + two rails along the quay edge.
  for (let u = 1; u < CHUNK_LEN; u += 2.5) {
    slab(mb, edge - 0.38, SW_Y + 0.12, -(u + 0.06), edge - 0.26, 1.25, -(u - 0.06), P.IRON, PX | NX | PZ | NZ | PY);
  }
  for (const y of [0.7, 1.22]) {
    slab(mb, edge - 0.4, y - 0.04, -CHUNK_LEN, edge - 0.24, y + 0.04, 0, P.IRON_LIGHT, PX | NX | PY | 8);
  }
  // Bollards with mooring ropes.
  for (const u of [6, 31]) {
    mb.push().translate(edge - 0.9, SW_Y + 0.3, -u);
    mb.cylinder(0.2, 0.6, 8, { radiusTop: 0.16 }, 0x2c3236);
    mb.translate(0, 0.38, 0).sphere(0.24, 0.12, 0.24, 8, 3, 0x2c3236);
    mb.pop();
    bar(mb, [edge - 0.9, SW_Y + 0.5, -u], [edge + 3, -1.1, -u - 1.5], 0.06, 0xc9b48a);
  }
  // Fill under the building row beyond the quay (behind sheds): low deck.
  return mb;
}

/** Glossy sea for the harbour side: one big quad per chunk reaching the horizon. */
export function buildSea(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 53, jitter: 0.0 });
  // Bands of slightly different blue so the glossy surface is not a flat fill.
  const xs = [QUAY_EDGE, QUAY_EDGE + 8, 40, 80, 160, 320, 700];
  const cs = [0x3d7f8f, 0x3a7c90, 0x39778f, 0x3b7591, 0x3e7695, 0x437a99];
  for (let i = 0; i < xs.length - 1; i++) panelPY(mb, xs[i], 0, xs[i + 1], -CHUNK_LEN, -1.25, { color: cs[i], jitter: 0 });
  // A few foam / glint streaks near the quay.
  const rnd = new Rand(54);
  for (let k = 0; k < 10; k++) {
    const x = rnd.range(QUAY_EDGE + 2, 70), u = rnd.range(2, CHUNK_LEN - 4), l = rnd.range(1, 3.5);
    panelPY(mb, x, -u, x + 0.15, -(u + l), -1.235, { color: 0x9cc8cf, jitter: 0 });
  }
  return mb;
}
