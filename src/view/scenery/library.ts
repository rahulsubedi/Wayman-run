// The scenery module library: every shared geometry the street is assembled from, keyed by name.
// Built ONCE at start-up (as MeshBuilders, so tests can inspect them without a GPU); a chunk is
// only ever an arrangement of instances of these.
import type { MeshBuilder } from '../geom';
import { buildBackRow, buildFar } from './backdrop';
import { buildBuilding, zoneSpecs, zoneWalls, type ZoneFamily } from './buildings';
import { buildGround, buildLotFill, buildSea, GROUND_VARIANTS } from './ground';
import { VARIANTS, type WidthTable } from './layout';
import { buildBunting, buildGate, buildLanterns } from './overhead';
import { propCatalogue } from './props';

export interface ModuleDef {
  build: () => MeshBuilder;
  shadow: boolean;
  /** Small street clutter: hidden in chunks far ahead (tiny + fogged there) to save draws. */
  small?: boolean;
  /** 'water' uses the glossy sea material; everything else the shared scenery material. */
  material: 'main' | 'water';
}

const SMALL = new Set(['bin', 'hydrant', 'bollards', 'scooter', 'scooterRed', 'bicycle', 'signpost', 'pots', 'bench', 'laundry', 'hedge', 'planter', 'barrels', 'nets']);

export function moduleDefs(): Map<string, ModuleDef> {
  const m = new Map<string, ModuleDef>();
  const add = (key: string, build: () => MeshBuilder, shadow = false, material: 'main' | 'water' = 'main') => m.set(key, { build, shadow, material });
  for (let v = 0; v < GROUND_VARIANTS; v++) add(`ground${v}`, () => buildGround(v));
  add('fill:town', () => buildLotFill('town'));
  add('fill:quay', () => buildLotFill('quay'));
  add('sea', buildSea, false, 'water');
  for (const z of [0, 1, 2] as ZoneFamily[]) {
    zoneSpecs(z).forEach((spec, i) => add(`b${z}_${i}`, () => buildBuilding(spec, zoneWalls(z)), true));
    add(`gate${z}`, () => buildGate(z), true);
  }
  for (let v = 0; v < VARIANTS.backTown; v++) add(`back:town:${v}`, () => buildBackRow('town', v));
  for (let v = 0; v < VARIANTS.backNight; v++) add(`back:night:${v}`, () => buildBackRow('night', v));
  for (let v = 0; v < VARIANTS.backHarbor; v++) add(`back:harbor:${v}`, () => buildBackRow('harbor', v));
  for (let v = 0; v < VARIANTS.farTown; v++) add(`far:town:${v}`, () => buildFar('town', v));
  for (let v = 0; v < VARIANTS.farNight; v++) add(`far:night:${v}`, () => buildFar('night', v));
  for (let v = 0; v < VARIANTS.farHarbor; v++) add(`far:harbor:${v}`, () => buildFar('harbor', v));
  for (let v = 0; v < VARIANTS.farSea; v++) add(`far:sea:${v}`, () => buildFar('sea', v));
  for (let v = 0; v < VARIANTS.bunting; v++) add(`bunting${v}`, () => buildBunting(v, false));
  for (let v = 0; v < VARIANTS.flags; v++) add(`flags${v}`, () => buildBunting(10 + v, true));
  for (let v = 0; v < VARIANTS.lanterns; v++) add(`lanterns${v}`, () => buildLanterns(v));
  for (const [key, def] of Object.entries(propCatalogue())) {
    add(key, def.build, def.shadow);
    if (SMALL.has(key)) m.get(key)!.small = true;
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
