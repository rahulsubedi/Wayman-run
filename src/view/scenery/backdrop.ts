// Backdrop: the row of plain buildings behind the street fronts (seen over low roofs and at the
// end of alleys) and the far layers (hills dotted with houses, harbour cranes, lighthouse island)
// that give depth through the fog. All chunk-length modules in the right-side frame (x > 0,
// z from 0 to -CHUNK_LEN), rotated 180° for the left side. Module ends meet at fixed heights so
// any two variants tile seamlessly.
import { MeshBuilder } from '../geom';
import { shadeHex, mixHex } from '../geom/color';
import { glowPaint, grad, quadN, quadNSplit, slab, zCuts, bar, Rand, NX, PX, PY, PZ, NZ } from './kit';
import * as P from './palette';
import { CHUNK_LEN } from './layoutConst';

const ALLS = NX | PX | PZ | NZ | PY;
const BACK_X = 23;

/** Rear building row: kind 'town' | 'night' | 'harbor'. */
export function buildBackRow(kind: 'town' | 'night' | 'harbor', variant: number): MeshBuilder {
  const mb = new MeshBuilder({ seed: 500 + variant * 7 + (kind === 'harbor' ? 100 : kind === 'night' ? 200 : 0), jitter: 0.05 });
  const rnd = new Rand(510 + variant * 13 + (kind === 'harbor' ? 1000 : 0));
  const walls = kind === 'harbor' ? P.WALLS_HARBOR : P.WALLS_MARKET;
  let u = 0;
  while (u < CHUNK_LEN - 0.01) {
    const w = Math.min(CHUNK_LEN - u, rnd.range(7, 14));
    const x0 = BACK_X + rnd.range(0, 2.5);
    const h = kind === 'harbor' ? rnd.range(9, 16) : rnd.range(11, 21);
    const wall = walls[rnd.int(walls.length)];
    const z0 = -(u + w), z1 = -u;
    slab(mb, x0, 0, z0, x0 + 16, h, z1, { color: wall, top: shadeHex(wall, 1.02), bottom: shadeHex(wall, 0.72), jitter: 0.04 }, NX | PY | PZ | NZ, true);
    // Upper windows (only the part that shows above the front row).
    const rows = Math.floor((h - 8) / 3.2) + 1;
    const cols = Math.max(1, Math.floor(w / 2.6));
    for (let r = 0; r < rows; r++) {
      const y = h - 2.6 - r * 3.2;
      if (y < 7) break;
      for (let c = 0; c < cols; c++) {
        const zc = z0 + (c + 0.5) * (w / cols);
        const lit = kind === 'night' && rnd.chance(0.35);
        const paint = lit ? glowPaint(rnd.pick([P.LIGHT_WARM, P.LIGHT_AMBER]), 0.3) : kind === 'night' ? 0x1b2230 : 0x34495a;
        quadN(mb, [x0 - 0.02, y, zc - 0.5], [x0 - 0.02, y, zc + 0.5], [x0 - 0.02, y + 1.4, zc + 0.5], [x0 - 0.02, y + 1.4, zc - 0.5], [-1, 0, 0], paint);
      }
    }
    if (kind === 'harbor') {
      // Warehouse gable seen end-on + ridge running back.
      const rise = 3;
      // Gable end as a strip of trapezoids (cut on the grid and at the apex) so it bends smoothly.
      const mid = (z0 + z1) / 2, half = (z1 - z0) / 2;
      const cuts = [...zCuts(z0, mid), ...zCuts(mid, z1)].filter((z, i, a) => i === 0 || z !== a[i - 1]);
      const topAt = (z: number) => h + rise * (1 - Math.abs(z - mid) / half);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const za = cuts[i], zb = cuts[i + 1];
        quadN(mb, [x0, h, za], [x0, h, zb], [x0, topAt(zb), zb], [x0, topAt(za), za], [-1, 0, 0], shadeHex(wall, 0.92));
      }
      const roofC = rnd.pick([0x6d7b82, 0x9a4a35, 0x5c6b5a]);
      quadNSplit(mb, [x0 - 0.3, h, z1], [x0 + 16, h, z1], [x0 + 16, h + rise, (z0 + z1) / 2], [x0 - 0.3, h + rise, (z0 + z1) / 2], [0, w / 2, rise], roofC);
      quadNSplit(mb, [x0 - 0.3, h, z0], [x0 + 16, h, z0], [x0 + 16, h + rise, (z0 + z1) / 2], [x0 - 0.3, h + rise, (z0 + z1) / 2], [0, w / 2, -rise], shadeHex(roofC, 0.85));
    } else if (rnd.chance(0.55)) {
      // Pitched terracotta roof (ridge along the street).
      const rise = 2.6;
      quadNSplit(mb, [x0 - 0.4, h, z0], [x0 - 0.4, h, z1], [x0 + 5, h + rise, z1], [x0 + 5, h + rise, z0], [-rise, 5.4, 0], { color: P.ROOF_TILE, bottom: P.ROOF_TILE_DARK, jitter: 0.06 });
      for (const [z, s] of [[z0, -1], [z1, 1]] as const) quadN(mb, [x0, h, z], [x0 + 10, h, z], [x0 + 5, h + rise, z], [x0 + 5, h + rise, z], [0, 0, s], shadeHex(wall, 0.9));
      quadNSplit(mb, [x0 + 5, h + rise, z0], [x0 + 5, h + rise, z1], [x0 + 10, h, z1], [x0 + 10, h, z0], [rise, 5, 0], shadeHex(P.ROOF_TILE, 0.8));
    } else {
      slab(mb, x0 - 0.1, h, z0, x0 + 16, h + 0.6, z1, mixHex(wall, 0xffffff, 0.3), NX | PY | PZ | NZ, true);
      if (rnd.chance(0.5)) {
        const z = (z0 + z1) / 2;
        mb.push().translate(x0 + 4, h + 1.6, z).cylinder(0.8, 1.6, 8, {}, grad(0xd9d4c8, 0.8)).pop();
      }
    }
    u += w;
  }
  if (kind === 'harbor' && variant === 1) {
    // Harbour crane behind the warehouses.
    crane(mb, BACK_X + 22, -25, 0xe2a33a);
  }
  return mb;
}

function crane(mb: MeshBuilder, x: number, z: number, color: number): void {
  const H = 34;
  for (const dx of [-1.2, 1.2]) for (const dz of [-1.2, 1.2]) bar(mb, [x + dx * 2, 0, z + dz * 2], [x + dx, H, z + dz], 0.35, grad(color, 0.8), 4);
  for (let y = 4; y < H; y += 5) {
    bar(mb, [x - 1.6, y, z - 1.6], [x + 1.6, y + 5, z - 1.6], 0.15, color);
    bar(mb, [x - 1.6, y, z + 1.6], [x + 1.6, y + 5, z + 1.6], 0.15, color);
    bar(mb, [x - 1.6, y, z - 1.6], [x - 1.6, y + 5, z + 1.6], 0.15, color);
  }
  slab(mb, x - 2, H, z - 2, x + 3, H + 3, z + 2, grad(0xe8e1d0, 0.85), ALLS | 8);
  // Jib reaching out toward the street (over the roofs, high above anything).
  bar(mb, [x + 3, H + 2.5, z], [x - 26, H + 2.5, z], 0.9, color, 4);
  bar(mb, [x + 3, H + 1.0, z], [x + 12, H + 1.0, z], 0.9, color, 4);
  slab(mb, x + 10, H - 1, z - 1.6, x + 13, H + 1.5, z + 1.6, 0x6f6f6f, ALLS | 8);
  bar(mb, [x, H + 3, z], [x, H + 9, z], 0.4, color, 4);
  bar(mb, [x, H + 9, z], [x - 24, H + 2.6, z], 0.12, 0x555555, 3);
  bar(mb, [x, H + 9, z], [x + 12, H + 1.2, z], 0.12, 0x555555, 3);
  bar(mb, [x - 20, H + 2, z], [x - 20, H - 12, z], 0.06, 0x333333, 3);
  slab(mb, x - 20.6, H - 13.2, z - 0.6, x - 19.4, H - 12, z + 0.6, 0xe2402f, ALLS | 8);
}

/** Ridge height function shared by the hill modules (ends pinned so variants tile). */
function ridge(rnd: Rand, n: number, lo: number, hi: number, end: number): number[] {
  const hs: number[] = [end];
  for (let i = 1; i < n; i++) hs.push(rnd.range(lo, hi));
  hs.push(end);
  return hs;
}

/** Far hills (right-side frame) with a sprinkle of houses; 'night' dots them with lights. */
export function buildFar(kind: 'town' | 'night' | 'harbor' | 'sea', variant: number): MeshBuilder {
  const mb = new MeshBuilder({ seed: 600 + variant + (kind === 'night' ? 50 : kind === 'harbor' ? 70 : kind === 'sea' ? 90 : 0), jitter: 0.06 });
  const rnd = new Rand(610 + variant * 31 + (kind === 'sea' ? 500 : 0));
  if (kind === 'sea') {
    // Open sea side, three variants that alternate chunk by chunk: 0 a rocky islet with a
    // red-and-white lighthouse and keeper's cottage, 1 a cargo ship at anchor, 2 open water with
    // a few sailboats. All sit 45-90 m out, close enough to read crisply through the haze.
    if (variant === 0) {
      const x = 52, z = -24;
      // Rocks: a few squashed boulders.
      for (const [dx, dz, r, h] of [[0, 0, 9, 3.2], [6, -6, 6, 2.4], [-5, 7, 5, 2], [4, 9, 4, 1.6]] as const) {
        mb.push().translate(x + dx, -1.4, z + dz).sphere(r, h, r * 0.9, 7, 3, { color: 0x8b8378, top: 0x9c9384, bottom: 0x5d574f, jitter: 0.1 }).pop();
      }
      const lx = x - 1, lz = z - 1;
      mb.push().translate(lx, 1.2, lz).cylinder(2.6, 1.2, 10, {}, grad(0xe8e1d0, 0.8)).pop();
      mb.push().translate(lx, 9.2, lz).cylinder(1.9, 15, 10, { radiusTop: 1.35 }, grad(0xf6f1e7, 0.9)).pop();
      for (const y of [5.2, 10.4, 15.2]) mb.push().translate(lx, y, lz).cylinder(1.8 - (y - 5) * 0.035, 2.2, 10, { radiusTop: 1.72 - (y - 5) * 0.035 }, 0xd9453a).pop();
      mb.push().translate(lx, 17.1, lz).cylinder(2.0, 0.35, 10, {}, 0x2a3a40).pop();
      mb.push().translate(lx, 18.6, lz).cylinder(1.15, 2.6, 8, {}, glowPaint(0xfff2c0, 0.75)).pop();
      mb.push().translate(lx, 20.7, lz).cone(1.6, 1.6, 8, 0xc0392b).pop();
      // Keeper's cottage.
      slab(mb, x + 3, 0.6, z + 2, x + 8, 3.6, z + 7, grad(0xf3e7cf, 0.85), ALLS);
      quadN(mb, [x + 2.8, 3.6, z + 1.8], [x + 2.8, 3.6, z + 7.2], [x + 5.5, 5.2, z + 7.2], [x + 5.5, 5.2, z + 1.8], [-1.6, 2.7, 0], P.ROOF_TILE);
      quadN(mb, [x + 8.2, 3.6, z + 1.8], [x + 8.2, 3.6, z + 7.2], [x + 5.5, 5.2, z + 7.2], [x + 5.5, 5.2, z + 1.8], [1.6, 2.7, 0], P.ROOF_TILE_DARK);
    } else if (variant === 1) {
      // Cargo ship at anchor, bow toward the street end; hull in short pieces (curved world).
      const x = 70, z0 = -44, z1 = -6;
      slab(mb, x - 5, -2, z0 + 3, x + 5, 3.2, z1, { color: 0x2b4c6f, top: 0x335a80, bottom: 0x1d3550, jitter: 0.03 }, ALLS, true);
      slab(mb, x - 5.02, -1.3, z0 + 3, x + 5.02, -0.2, z1, 0xa23b2c, NX | PX, true);
      // Bow wedge.
      quadN(mb, [x - 5, -2, z0 + 3], [x, -2, z0], [x, 3.6, z0 - 0.8], [x - 5, 3.2, z0 + 3], [-1, 0, -0.6], 0x2b4c6f);
      quadN(mb, [x + 5, -2, z0 + 3], [x, -2, z0], [x, 3.6, z0 - 0.8], [x + 5, 3.2, z0 + 3], [1, 0, -0.6], 0x2b4c6f);
      quadN(mb, [x - 5, 3.2, z0 + 3], [x + 5, 3.2, z0 + 3], [x, 3.6, z0 - 0.8], [x, 3.6, z0 - 0.8], [0, 1, 0], 0x6b7378);
      // Containers in coloured stacks.
      const cc = [0xd9453a, 0x2a9d8f, 0xe9b949, 0x3c7fa6, 0xe8e1d0, 0xe76f51];
      for (let zc = z0 + 5; zc < z1 - 11; zc += 6.25) {
        const hgt = 1 + rnd.int(3);
        for (let k = 0; k < hgt; k++) {
          for (const sx of [-1, 1]) slab(mb, x + (sx < 0 ? -4.4 : 0.1), 3.2 + k * 2.4, zc, x + (sx < 0 ? -0.1 : 4.4), 5.5 + k * 2.4, zc + 6, cc[rnd.int(cc.length)], ALLS);
        }
      }
      // Bridge house at the stern + funnel.
      slab(mb, x - 4.6, 3.2, z1 - 8.4, x + 4.6, 11, z1 - 2, grad(0xf4efe6, 0.85), ALLS);
      slab(mb, x - 4.62, 9.2, z1 - 8.4, x + 4.62, 10.2, z1 - 2, 0x24323c, NX | PX | NZ);
      mb.push().translate(x, 13, z1 - 4).cylinder(1.3, 4, 8, {}, grad(0xd9453a, 0.85)).pop();
    } else {
      for (let k = 0; k < 4; k++) {
        const x = rnd.range(38, 80), z = -rnd.range(5, 45);
        quadN(mb, [x, -1.2, z], [x, -1.2, z - 4], [x, 7, z - 2], [x, 7, z - 2], [-1, 0, 0], 0xf4efe6);
        quadN(mb, [x, -1.2, z], [x, -1.2, z - 4], [x, 7, z - 2], [x, 7, z - 2], [1, 0, 0], 0xe4ddd0);
        slab(mb, x - 1, -1.3, z - 4.5, x + 1, -0.5, z + 0.5, rnd.pick([0xe9e4d8, 0x2f6f8f, 0xd9563b]), ALLS);
      }
    }
    return mb;
  }
  const n = 5;
  const hs = ridge(rnd, n, kind === 'harbor' ? 22 : 30, kind === 'harbor' ? 42 : 58, 34);
  const x0 = 70, x1 = 150;
  const base = kind === 'night' ? 0x3a4458 : kind === 'harbor' ? 0x9a8a6a : 0x8fa06a;
  const top = kind === 'night' ? 0x4a5670 : kind === 'harbor' ? 0xb49a72 : 0xa9b77c;
  for (let i = 0; i < n; i++) {
    const za = -(i * CHUNK_LEN) / n, zb = -((i + 1) * CHUNK_LEN) / n;
    const ha = hs[i], hb = hs[i + 1];
    // Front slope (faces the street) and a crest band.
    quadNSplit(mb, [x0, 0, za], [x0, 0, zb], [x1 - 30, hb, zb], [x1 - 30, ha, za], [-1, 0.6, 0], { color: base, top, bottom: shadeHex(base, 0.8), jitter: 0.06 });
    quadNSplit(mb, [x1 - 30, ha, za], [x1 - 30, hb, zb], [x1 + 40, hb * 0.6, zb], [x1 + 40, ha * 0.6, za], [-0.3, 1, 0], shadeHex(top, 0.95));
  }
  // Houses / lights scattered on the slope.
  const count = kind === 'harbor' ? 10 : 22;
  for (let k = 0; k < count; k++) {
    const t = rnd.range(0.15, 0.85);
    const u = rnd.range(1, CHUNK_LEN - 1);
    const i = Math.min(n - 1, Math.floor((u / CHUNK_LEN) * n));
    const f = (u / CHUNK_LEN) * n - i;
    const h = hs[i] + (hs[i + 1] - hs[i]) * f;
    const x = x0 + (x1 - 30 - x0) * t;
    const y = h * t;
    if (kind === 'night') {
      if (rnd.chance(0.8)) quadN(mb, [x - 0.3, y + 0.6, -u - 0.5], [x - 0.3, y + 0.6, -u + 0.5], [x - 0.3, y + 1.4, -u + 0.5], [x - 0.3, y + 1.4, -u - 0.5], [-1, 0, 0], glowPaint(rnd.pick([P.LIGHT_WARM, P.LIGHT_AMBER, P.LIGHT_CREAM]), 0.55));
    } else {
      const c = rnd.pick([0xf6f0e3, 0xf3e7cf, 0xe9cfa3, 0xf2d9c4]);
      slab(mb, x - 1.2, y - 1, -u - 1.5, x + 1.2, y + 1.8, -u + 1.5, c, NX | PY | PZ | NZ);
      quadN(mb, [x - 1.4, y + 1.8, -u - 1.5], [x - 1.4, y + 1.8, -u + 1.5], [x, y + 2.8, -u + 1.5], [x, y + 2.8, -u - 1.5], [-1, 1.4, 0], P.ROOF_TILE);
    }
  }
  if (kind === 'town' && variant === 1) {
    // Hilltop chapel / tower silhouette.
    const x = 112, u = 25, h = hs[2] + (hs[3] - hs[2]) * 0.5;
    const y = h * ((x - x0) / (x1 - 30 - x0));
    slab(mb, x - 2, y - 2, -u - 2, x + 2, y + 9, -u + 2, 0xf6f0e3, NX | PY | PZ | NZ);
    mb.push().translate(x, y + 10.5, -u).cone(2.3, 3, 4, 0xc0583a).pop();
  }
  if (kind === 'harbor') {
    crane(mb, 62, -20, variant === 0 ? 0xd9453a : 0xe2a33a);
  }
  return mb;
}

