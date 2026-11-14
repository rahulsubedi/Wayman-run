// The scenery module library: every shared geometry the street is assembled from, keyed by name.
// Built ONCE at start-up (as MeshBuilders, so tests can inspect them without a GPU); a chunk is
// only ever an arrangement of instances of these.
import type { MeshBuilder } from '../geom';
import { buildBackRow, buildFar } from './backdrop';
import { buildBuilding, shadowBoxes, zoneSpecs, zoneWalls, type Box, type ZoneFamily } from './buildings';
import { buildGround, buildLotFill, buildSea, GROUND_VARIANTS } from './ground';
import { VARIANTS, type WidthTable } from './layout';
import { buildBunting, buildGate, buildLanterns } from './overhead';
import { propCatalogue } from './props';

export interface ModuleDef {
  build: () => MeshBuilder;
  shadow: boolean;
  /** Distance tier: 1 = small street clutter, 2 = mid-size frontage; hidden in chunks far ahead (tiny + fogged there) to save draws. */
  tier?: 1 | 2;
  /** 'water' uses the glossy sea material; everything else the shared scenery material. */
  material: 'main' | 'water';
}

const MEDIUM = new Set(['cafe', 'cafeNight', 'stall', 'stallNight', 'foodStall', 'crates', 'palm', 'boat0', 'boat1']);
const SMALL = new Set(['bin', 'hydrant', 'bollards', 'scooter', 'bicycle', 'signpost', 'pots', 'bench', 'laundry', 'hedge', 'planter', 'barrels', 'nets']);

export function moduleDefs(): Map<string, ModuleDef> {
  const m = new Map<string, ModuleDef>();
  const add = (key: string, build: () => MeshBuilder, shadow = false, material: 'main' | 'water' = 'main') => m.set(key, { build, shadow, material });
  for (let v = 0; v < GROUND_VARIANTS; v++) add(`ground${v}`, () => buildGround(v));
  add('fill:town', () => buildLotFill('town'));
  add('fill:quay', () => buildLotFill('quay'));
  add('sea', buildSea, false, 'water');
  for (const z of [0, 1, 2] as ZoneFamily[]) {
    // Buildings cast through shadow proxies (shadowTable), not their detailed geometry.
    zoneSpecs(z).forEach((spec, i) => add(`b${z}_${i}`, () => buildBuilding(spec, zoneWalls(z))));
    add(`gate${z}`, () => buildGate(z), true);
  }
  // Rear building row + far hills merged into one module per variant (one draw per side).
  for (const kind of ['town', 'night', 'harbor'] as const) {
    for (let v = 0; v < 2; v++) add(`bg:${kind}:${v}`, () => buildBackRow(kind, v).merge(buildFar(kind, v)));
  }
  for (let v = 0; v < VARIANTS.farSea; v++) add(`far:sea:${v}`, () => buildFar('sea', v));
  for (let v = 0; v < VARIANTS.bunting; v++) add(`bunting${v}`, () => buildBunting(v, false));
  for (let v = 0; v < VARIANTS.flags; v++) add(`flags${v}`, () => buildBunting(10 + v, true));
  for (let v = 0; v < VARIANTS.lanterns; v++) add(`lanterns${v}`, () => buildLanterns(v));
  for (const [key, def] of Object.entries(propCatalogue())) {
    add(key, def.build, def.shadow);
    if (SMALL.has(key)) m.get(key)!.tier = 1;
    else if (MEDIUM.has(key)) m.get(key)!.tier = 2;
  }
  return m;
}

/** Widths of the building variants per zone (what the layout needs). */
export function widthTable(): WidthTable {
  return ([0, 1, 2] as ZoneFamily[]).map((z) => zoneSpecs(z).map((s) => s.w));
}

/** Low variants (<= 2 storeys) per zone: the harbour's sea side uses only these. */
export function lowTable(): boolean[][] {
  return ([0, 1, 2] as ZoneFamily[]).map((z) => zoneSpecs(z).map((s) => s.floors <= 2));
}

/** Shadow-caster boxes per building module key (see shadowBoxes). */
export function shadowTable(): Map<string, Box[]> {
  const m = new Map<string, Box[]>();
  for (const z of [0, 1, 2] as ZoneFamily[]) zoneSpecs(z).forEach((spec, i) => m.set(`b${z}_${i}`, shadowBoxes(spec)));
  return m;
}
