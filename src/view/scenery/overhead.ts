// Things above the street: bunting / lantern / signal-flag strings between festival masts, and
// zone gateways. Everything over the road stays at y >= ROAD_CLEAR_Y (11 m) so a flying player
// (y ≈ 7–9) always passes underneath.
//
// Strings are authored with their anchor line on local y = 0 (anchors at x = ±STRING_HALF) and
// hang below it; the node is placed at STRING_Y and swings by rotating about local X.
import { MeshBuilder } from '../geom';
import { shadeHex } from '../geom/color';
import { glowPaint, grad, quadN, slab, bar, Rand, NX, PX, PY, PZ, NZ } from './kit';
import * as P from './palette';

export const STRING_HALF = 5.0;
export const STRING_Y = 13.4;
const SAG = 1.15;

const sagAt = (x: number) => -SAG * (1 - (x / STRING_HALF) ** 2);

function cord(mb: MeshBuilder, color: number): void {
  const n = 10;
  for (let k = 0; k < n; k++) {
    const xa = -STRING_HALF + (2 * STRING_HALF * k) / n, xb = -STRING_HALF + (2 * STRING_HALF * (k + 1)) / n;
    bar(mb, [xa, sagAt(xa), 0], [xb, sagAt(xb), 0], 0.035, color, 3);
  }
}

/** Triangular bunting flags (market) or square signal flags (harbour). */
export function buildBunting(seed: number, square: boolean): MeshBuilder {
  const mb = new MeshBuilder({ seed: 300 + seed, jitter: 0.04 });
  const rnd = new Rand(310 + seed);
  cord(mb, 0xf4efe6);
  const colors = square
    ? [0xe2402f, 0xf2d43d, 0x2f6fb0, 0xffffff, 0x1f2a44, 0x2a9d8f]
    : [0xe76f51, 0x2a9d8f, 0xe9c46a, 0xffffff, 0x3c7fa6, 0xd1495b, 0x5c946e];
  const step = square ? 0.75 : 0.6;
  let i = rnd.int(colors.length);
  for (let x = -STRING_HALF + 0.45; x < STRING_HALF - 0.3; x += step) {
    const w = square ? 0.5 : 0.44;
    const xa = x - w / 2, xb = x + w / 2;
    const ya = sagAt(xa), yb = sagAt(xb);
    const c = colors[i++ % colors.length];
    if (square) {
      const len = 0.48;
      for (const s of [-1, 1]) quadN(mb, [xa, ya, 0], [xb, yb, 0], [xb, yb - len, 0], [xa, ya - len, 0], [0, 0, s], s > 0 ? c : shadeHex(c, 0.85));
      if (c === 0xffffff) quadN(mb, [x - 0.1, (ya + yb) / 2 - 0.14, 0.005], [x + 0.1, (ya + yb) / 2 - 0.14, 0.005], [x + 0.1, (ya + yb) / 2 - 0.34, 0.005], [x - 0.1, (ya + yb) / 2 - 0.34, 0.005], [0, 0, 1], 0x2f6fb0);
    } else {
      const tip: [number, number, number] = [x, (ya + yb) / 2 - 0.5, 0];
      for (const s of [-1, 1]) quadN(mb, [xa, ya, 0], [xb, yb, 0], tip, tip, [0, 0, s], s > 0 ? c : shadeHex(c, 0.85));
    }
  }
  return mb;
}

/** Night: paper lanterns along the string (self-lit). */
export function buildLanterns(seed: number): MeshBuilder {
  const mb = new MeshBuilder({ seed: 320 + seed, jitter: 0.03 });
  const rnd = new Rand(330 + seed);
  cord(mb, 0x2a2420);
  for (let x = -STRING_HALF + 0.7; x < STRING_HALF - 0.5; x += 0.95) {
    const y = sagAt(x);
    const c = rnd.pick(P.LANTERN);
    bar(mb, [x, y, 0], [x, y - 0.12, 0], 0.02, 0x2a2420, 3);
    mb.push().translate(x, y - 0.32, 0);
    mb.cylinder(0.07, 0.06, 5, { capBottom: false }, 0x3a2a20);
    mb.translate(0, -0.2, 0).cylinder(0.2, 0.34, 7, {}, glowPaint(c, 0.75));
    mb.pop();
  }
  return mb;
}

/**
 * Zone gateway spanning the street: pillars on both sidewalks (|x| in [5.0, 6.6]) and a beam whose
 * underside is at y >= 11.2. Faces +z toward the approaching runner.
 */
export function buildGate(zone: 0 | 1 | 2): MeshBuilder {
  const mb = new MeshBuilder({ seed: 340 + zone, jitter: 0.035 });
  const rnd = new Rand(350 + zone);
  const ALLS = NX | PX | PZ | NZ | PY;
  if (zone === 0) {
    const stone = 0xe8cfa2, tile = 0x2a9d8f;
    for (const s of [-1, 1]) {
      const x0 = s * 5.0, x1 = s * 6.7;
      slab(mb, x0, 0.15, -0.9, x1, 0.9, 0.9, grad(shadeHex(stone, 0.85), 0.85), ALLS);
      slab(mb, s * 5.15, 0.9, -0.75, s * 6.55, 13.2, 0.75, grad(stone, 0.8), ALLS);
      for (const y of [3.2, 6.4, 9.6]) slab(mb, s * 5.1, y, -0.8, s * 6.6, y + 0.45, 0.8, tile, ALLS | 8);
      // Niche with a little arch outline.
      slab(mb, s * 5.6, 4.2, 0.75, s * 6.1, 5.8, 0.8, 0x2f6f73, PZ);
      slab(mb, s * 4.95, 13.2, -0.95, s * 6.75, 13.6, 0.95, 0xf6f0e3, ALLS | 8);
      mb.push().translate(s * 5.85, 14.2, 0).cone(0.8, 1.2, 4, { color: 0xc0583a, bottom: 0x9c4229 }).pop();
    }
    slab(mb, -5.15, 11.25, -0.6, 5.15, 12.75, 0.6, grad(stone, 0.85), PZ | NZ | 8 | PY);
    slab(mb, -5.15, 11.25, 0.6, 5.15, 11.55, 0.7, tile, PZ | 8);
    slab(mb, -5.15, 12.45, 0.6, 5.15, 12.75, 0.7, tile, PZ | 8);
    // Stepped crest + sun disc.
    slab(mb, -3.2, 12.75, -0.5, 3.2, 13.4, 0.5, grad(stone, 0.9), PZ | NZ | PY | NX | PX);
    slab(mb, -1.8, 13.4, -0.45, 1.8, 14.0, 0.45, grad(stone, 0.9), PZ | NZ | PY | NX | PX);
    mb.push().translate(0, 13.9, 0.5).rotateX(Math.PI / 2).cylinder(1.05, 0.12, 14, {}, 0xe9b949).cylinder(0.7, 0.16, 14, {}, 0xf6d36b).pop();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      mb.push().translate(Math.cos(a) * 1.3, 13.9 + Math.sin(a) * 1.3, 0.5).rotateZ(a).box(0.45, 0.14, 0.08, 0xe9b949).pop();
    }
    // Sign letters on the beam.
    for (let k = 0; k < 8; k++) slab(mb, -3.0 + k * 0.78, 11.7, 0.6, -2.55 + k * 0.78, 12.3, 0.66, 0xfbf3e4, PZ);
  } else if (zone === 1) {
    const steel = 0x3f6f86;
    for (const s of [-1, 1]) {
      for (const xa of [5.0, 6.4]) for (const za of [-0.6, 0.6]) bar(mb, [s * xa, 0.15, za], [s * xa, 12.6, za], 0.16, grad(steel, 0.8), 4);
      for (let y = 1.2; y < 12; y += 1.4) {
        bar(mb, [s * 5.0, y, -0.6], [s * 6.4, y + 1.4, -0.6], 0.07, steel);
        bar(mb, [s * 5.0, y, 0.6], [s * 6.4, y + 1.4, 0.6], 0.07, steel);
        bar(mb, [s * 5.0, y, -0.6], [s * 5.0, y + 1.4, 0.6], 0.07, steel);
        bar(mb, [s * 6.4, y, -0.6], [s * 6.4, y + 1.4, 0.6], 0.07, steel);
      }
      slab(mb, s * 4.8, 0.15, -0.8, s * 6.6, 0.6, 0.8, 0x8d8576, ALLS);
    }
    for (const y of [11.3, 12.6]) for (const z of [-0.6, 0.6]) bar(mb, [-6.4, y, z], [6.4, y, z], 0.14, steel, 4);
    for (let x = -6; x < 6; x += 1.2) {
      bar(mb, [x, 11.3, 0.6], [x + 1.2, 12.6, 0.6], 0.06, steel);
      bar(mb, [x, 11.3, -0.6], [x + 1.2, 12.6, -0.6], 0.06, steel);
    }
    // Sign board with letters + small lamps.
    slab(mb, -3.6, 12.75, 0.4, 3.6, 14.2, 0.55, grad(0xf1ece1, 0.9), PZ | NX | PX | PY);
    for (let k = 0; k < 6; k++) slab(mb, -3.1 + k * 1.05, 13.05, 0.55, -2.4 + k * 1.05, 13.9, 0.6, 0x1f4e6b, PZ);
    for (const x of [-2.4, 0, 2.4]) mb.push().translate(x, 14.4, 0.7).box(0.3, 0.18, 0.3, 0x2a2f33).pop();
    // Life buoys on the towers.
    for (const s of [-1, 1]) {
      mb.push().translate(s * 5.7, 3.0, 0.7).rotateX(Math.PI / 2);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        mb.push().translate(Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35).rotateY(-a).box(0.14, 0.14, 0.3, k % 2 ? 0xffffff : 0xe2402f).pop();
      }
      mb.pop();
    }
  } else {
    const red = 0xb3312a, gold = 0xe0a83a;
    for (const s of [-1, 1]) {
      slab(mb, s * 5.0, 0.15, -0.8, s * 6.6, 0.8, 0.8, 0x3a2a26, ALLS);
      mb.push().translate(s * 5.8, 6.9, 0).cylinder(0.55, 12.2, 8, {}, grad(red, 0.6)).pop();
      for (const y of [1.6, 10.6]) mb.push().translate(s * 5.8, y, 0).cylinder(0.65, 0.35, 8, {}, gold).pop();
    }
    slab(mb, -7.2, 11.3, -0.55, 7.2, 12.0, 0.55, grad(red, 0.8), ALLS | 8);
    slab(mb, -7.8, 12.6, -0.75, 7.8, 13.1, 0.75, grad(0x3a2420, 0.9), ALLS | 8);
    // Upturned roof ends.
    for (const s of [-1, 1]) mb.push().translate(s * 7.8, 13.0, 0).rotateZ(s * -0.5).box(1.2, 0.3, 1.5, 0x3a2420).pop();
    slab(mb, -6.6, 12.0, -0.4, 6.6, 12.6, 0.4, gold, NX | PX | PZ | NZ);
    // Glowing name panel + neon letters.
    slab(mb, -2.6, 13.1, -0.2, 2.6, 14.6, 0.2, grad(0x2a1418, 0.9), ALLS);
    for (let k = 0; k < 5; k++) slab(mb, -2.2 + k * 0.9, 13.4, 0.2, -1.65 + k * 0.9, 14.3, 0.26, glowPaint(rnd.pick(P.NEON), 0.9), PZ | NX | PX | PY | 8);
    // Lanterns under the beam (bottoms above 11.1 m only near the pillars; centre ones above 11.4 m).
    for (const x of [-4.5, -2.25, 0, 2.25, 4.5]) {
      mb.push().translate(x, 11.45, 0.6).sphere(0.26, 0.2, 0.26, 8, 3, glowPaint(P.LANTERN[0], 0.8)).pop();
    }
  }
  return mb;
}
