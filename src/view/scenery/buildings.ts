// Modular building generator + the per-zone variant catalogues.
//
// A building is authored for the RIGHT side of the street: its street face is the plane x = 0,
// the body extends to +x (depth), it is centred on z = 0 with width `w` along z, and facade detail
// protrudes toward -x. The left side uses the same geometry rotated by 180° about Y (a rotation,
// not a mirror, so winding and normals stay valid and instances keep sharing geometry).
//
// Variants are hand-specified recipes (width, storeys, ground floor, window style, roof...) so
// every one of them is visibly different; colours and small details come from the seed.
import { MeshBuilder } from '../geom';
import { shadeHex, mixHex } from '../geom/color';
import {
  acUnit, arcade, awning, balcony, bigDoor, bladeSign, bulbString, det, door, drainpipe, fascia, flowerBox,
  free, frenchDoor, glass, shopfront, window, type Look,
} from './facade';
import { glowPaint, grad, NX, NY, NZ, PY, PZ, Rand, slab, panelNX, bar, PX, quadN } from './kit';
import * as P from './palette';

export const GROUND_H = 4.2;
export const FLOOR_H = 3.2;

export type GroundKind = 'shop' | 'cafe' | 'arcade' | 'house' | 'warehouse' | 'shed' | 'stalls';
export type UpperKind = 'shutters' | 'balcony' | 'arched' | 'boxes' | 'industrial' | 'mixed' | 'loggia';
export type RoofKind = 'parapet' | 'tile' | 'hip' | 'terrace' | 'gable' | 'tower' | 'shedroof';

export interface BuildingSpec {
  w: number;
  floors: number;
  ground: GroundKind;
  upper: UpperKind;
  roof: RoofKind;
  /** Wall colour index / explicit colour. */
  wall: number;
  seed: number;
  night?: boolean;
  setback?: boolean;
  awning?: boolean;
  blade?: boolean;
  /** Painted sign band on warehouses. */
  band?: boolean;
  depth?: number;
}

export function buildingHeight(s: BuildingSpec): number {
  return GROUND_H + (s.floors - 1) * FLOOR_H;
}

/** Roof stuff for a flat roof at height H over [0, D] x [-w/2, w/2]. */
function roofClutter(mb: MeshBuilder, rnd: Rand, H: number, D: number, w: number, kinds: ('tank' | 'antenna' | 'solar' | 'hut' | 'ac')[]): void {
  const half = w / 2;
  for (const k of kinds) {
    const x = rnd.range(2.5, Math.max(3, D - 2.5));
    const z = rnd.range(-half + 1.4, half - 1.4);
    if (k === 'tank') {
      for (const [dx, dz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) {
        slab(mb, x + dx - 0.06, H, z + dz - 0.06, x + dx + 0.06, H + 1.2, z + dz + 0.06, P.IRON, NX | PX | PZ | NZ);
      }
      mb.push().translate(x, H + 1.95, z).cylinder(0.85, 1.5, 10, {}, grad(rnd.pick([0xe8e3d8, 0x8fa7b3, 0xc9b9a0]), 0.8));
      mb.translate(0, 0.85, 0).cone(0.9, 0.35, 10, 0x8c8c86).pop();
    } else if (k === 'antenna') {
      bar(mb, [x, H, z], [x, H + 4.2, z], 0.06, 0x8a9096);
      bar(mb, [x, H + 3.2, z - 0.7], [x, H + 3.2, z + 0.7], 0.04, 0x8a9096);
      bar(mb, [x, H + 3.8, z - 0.5], [x, H + 3.8, z + 0.5], 0.04, 0x8a9096);
    } else if (k === 'solar') {
      mb.push().translate(x, H + 0.75, z).rotateZ(0.5);
      mb.box(1.6, 0.08, 2.6, 0x223a5e);
      mb.translate(0, 0.05, 0).box(1.5, 0.02, 0.05, 0x6f8fb8).box(0.05, 0.02, 2.5, 0x6f8fb8);
      mb.pop();
      slab(mb, x + 0.5, H, z - 1.1, x + 0.6, H + 1.1, z + 1.1, P.IRON, NX | PX | PZ | NZ);
    } else if (k === 'hut') {
      slab(mb, x - 1.2, H, z - 1.1, x + 1.2, H + 2.4, z + 1.1, grad(0xe5dccb, 0.8), NX | PX | PZ | NZ | PY);
      slab(mb, x - 1.35, H + 2.4, z - 1.25, x + 1.35, H + 2.55, z + 1.25, 0xb8ad98, NX | PX | PZ | NZ | PY);
      panelNX(mb, x - 1.21, H, z - 0.45, H + 2.0, z + 0.45, 0x6b4a33);
    } else {
      slab(mb, x - 0.5, H, z - 0.6, x + 0.5, H + 0.8, z + 0.6, grad(0xd9d6cf, 0.8), NX | PX | PZ | NZ | PY);
    }
  }
}

function parapet(mb: MeshBuilder, H: number, D: number, w: number, color: number, coping: number, h = 0.9): void {
  const half = w / 2;
  slab(mb, -0.05, H, -half, 0.3, H + h, half, grad(color, 0.9), NX | PY | PZ | NZ | PX);
  slab(mb, 0.3, H, -half, D, H + h, -half + 0.3, grad(color, 0.9), PY | NZ | PZ);
  slab(mb, 0.3, H, half - 0.3, D, H + h, half, grad(color, 0.9), PY | PZ | NZ);
  slab(mb, -0.15, H + h, -half, 0.4, H + h + 0.14, half, coping, NX | PY | NY | PX);
}

function tileRoof(mb: MeshBuilder, rnd: Rand, H: number, D: number, w: number, look: Look, dormer: boolean): void {
  const half = w / 2;
  const rise = Math.min(4.2, D * 0.38);
  const ov = 0.55;
  // Roof prism, ridge parallel to the street: front slope (tiles), gable-end triangles in wall
  // colour, eave soffit. The back slope faces away from every camera position and is skipped.
  const tileP = { color: P.ROOF_TILE, bottom: P.ROOF_TILE_DARK, top: shadeHex(P.ROOF_TILE, 1.08), jitter: 0.05 };
  quadN(mb, [-ov, H, -half], [-ov, H, half], [D / 2, H + rise, half], [D / 2, H + rise, -half], [-rise, D / 2 + ov, 0], tileP);
  quadN(mb, [D / 2, H + rise, -half], [D / 2, H + rise, half], [D + ov, H, half], [D + ov, H, -half], [rise, D / 2 + ov, 0], shadeHex(P.ROOF_TILE, 0.8));
  for (const sz of [-1, 1]) {
    const z = sz * half;
    quadN(mb, [0, H, z], [D, H, z], [D / 2, H + rise, z], [D / 2, H + rise, z], [0, 0, sz], shadeHex(look.wall, 0.92));
    quadN(mb, [-ov, H, z], [0, H, z], [D / 2, H + rise, z], [D / 2, H + rise, z], [0, 0, sz], P.ROOF_TILE_DARK);
  }
  quadN(mb, [-ov, H - 0.01, -half], [-ov, H - 0.01, half], [0, H - 0.01, half], [0, H - 0.01, -half], [0, -1, 0], shadeHex(look.wall, 0.65));
  // Tile courses on the street-facing slope (thin rotated strips).
  const ang = Math.atan2(rise, D / 2 + ov);
  const slopeLen = Math.hypot(rise, D / 2 + ov);
  const rows = Math.floor(slopeLen / 0.55);
  for (let k = 1; k < rows; k++) {
    const t = k / rows;
    const x = -ov + (D / 2 + ov) * t, y = H + rise * t;
    mb.push().translate(x, y, 0).rotateZ(ang);
    slab(mb, -0.04, -0.02, -half, 0.04, 0.07, half, shadeHex(P.ROOF_TILE_DARK, rnd.range(0.9, 1.05)), NX | PY);
    mb.pop();
  }
  // Ridge cap + eaves fascia.
  mb.push().translate(D / 2, H + rise + 0.02, 0).rotateX(Math.PI / 2).cylinder(0.16, w, 6, {}, P.ROOF_TILE_DARK).pop();
  slab(mb, -ov - 0.05, H - 0.25, -half, -ov + 0.1, H + 0.05, half, shadeHex(look.trim === 0xffffff ? 0xf2ede2 : look.trim, 0.95), NX | NY | PY);
  if (dormer) {
    const z = rnd.range(-half + 1.5, half - 1.5);
    const x0 = 0.9, y0 = H + rise * ((x0 + ov) / (D / 2 + ov)) - 0.2;
    slab(mb, x0, y0, z - 0.8, x0 + 1.8, y0 + 1.6, z + 0.8, grad(look.wall, 0.85), NX | PZ | NZ);
    mb.push().translate(x0 + 0.9, y0 + 1.6, z).rotateY(Math.PI / 2);
    mb.extrude([[-1.0, 0], [1.0, 0], [0, 0.7]], 2.0, P.ROOF_TILE);
    mb.pop();
    panelNX(mb, x0 - 0.02, y0 + 0.35, z - 0.45, y0 + 1.35, z + 0.45, glassFor(look));
  }
  if (rnd.chance(0.7)) {
    // Chimney.
    const z = rnd.range(-half + 1, half - 1);
    const x = D * 0.65;
    slab(mb, x - 0.4, H + rise * 0.5, z - 0.45, x + 0.4, H + rise + 1.2, z + 0.45, grad(shadeHex(look.wall, 0.9), 0.8), NX | PX | PZ | NZ | PY);
    slab(mb, x - 0.5, H + rise + 1.2, z - 0.55, x + 0.5, H + rise + 1.4, z + 0.55, 0x8d8273, NX | PX | PZ | NZ | PY);
  }
}

function glassFor(look: Look): number | ReturnType<typeof glowPaint> {
  if (look.night && look.rnd.chance(0.5)) return glowPaint(P.LIGHT_WARM, 0.35);
  return look.night ? 0x1c2533 : P.GLASS_BOTTOM;
}

function hipRoof(mb: MeshBuilder, H: number, D: number, w: number, look: Look): void {
  const rise = Math.min(3.2, Math.min(D, w) * 0.33);
  const r = Math.SQRT2;
  mb.push().translate(D / 2 - 0.2, H + rise / 2, 0).scale(D / 2 + 0.6, 1, w / 2);
  mb.cylinder(r, rise, 4, { radiusTop: r * 0.18, capBottom: false }, { color: P.ROOF_TILE, bottom: P.ROOF_TILE_DARK, top: shadeHex(P.ROOF_TILE, 1.1), jitter: 0.05 });
  mb.pop();
  slab(mb, -0.85, H - 0.3, -w / 2, -0.7, H + 0.02, w / 2, look.trim === 0xffffff ? 0xf2ede2 : look.trim, NX | NY | PY);
  // Soffit so the overhang never shows the inside.
  slab(mb, -0.8, H - 0.02, -w / 2, 0, H, w / 2, shadeHex(look.wall, 0.7), NY);
}

function gableFront(mb: MeshBuilder, H: number, D: number, w: number, look: Look, roofColor: number): void {
  const half = w / 2;
  const rise = Math.min(4.5, w * 0.35);
  // Pediment: front triangle (wall colour) + the two roof slopes running back along x.
  quadN(mb, [0, H, -half], [0, H, half], [0, H + rise, 0], [0, H + rise, 0], [-1, 0, 0], grad(look.wall, 0.92));
  const ang = Math.atan2(rise, half);
  const len = Math.hypot(rise, half) + 0.3;
  const rp = { color: roofColor, bottom: shadeHex(roofColor, 0.72), jitter: 0.05 };
  for (const s of [-1, 1]) {
    mb.push().translate(-0.45, H + rise, 0).rotateX(s * ang);
    slab(mb, 0, 0.02, s > 0 ? 0 : -len, D + 0.6, 0.24, s > 0 ? len : 0, rp, NX | PY | 8 | (s > 0 ? PZ : NZ));
    mb.pop();
  }
  // Round window in the gable.
  mb.push().translate(-0.06, H + rise * 0.4, 0).rotateZ(Math.PI / 2);
  mb.cylinder(0.75, 0.12, 12, {}, look.trim);
  mb.cylinder(0.58, 0.16, 12, {}, look.night ? glowPaint(P.LIGHT_AMBER, 0.35) : P.GLASS_BOTTOM);
  mb.pop();
}

/** Build a building variant. */
export function buildBuilding(spec: BuildingSpec, wallsPalette: readonly number[]): MeshBuilder {
  const rnd = new Rand(spec.seed);
  const mb = new MeshBuilder({ seed: spec.seed, jitter: 0.035 });
  const w = spec.w;
  const half = w / 2;
  const D = spec.depth ?? 12;
  const H = buildingHeight(spec);
  const wall = wallsPalette[spec.wall % wallsPalette.length];
  const trimIdx = rnd.int(P.TRIMS.length);
  const look: Look = {
    wall,
    trim: rnd.chance(0.55) ? 0xffffff : P.TRIMS[trimIdx],
    accent: P.TRIMS[(trimIdx + 1 + rnd.int(P.TRIMS.length - 1)) % P.TRIMS.length],
    shutter: P.SHUTTERS[rnd.int(P.SHUTTERS.length)],
    night: !!spec.night,
    rnd,
    litChance: 0.5,
  };
  if (look.accent === 0xffffff) look.accent = 0x2a9d8f;
  const wallPaint = { color: wall, top: shadeHex(wall, 1.04), bottom: shadeHex(wall, 0.8), jitter: 0.03 };
  const recess = spec.ground === 'arcade' ? 2.4 : spec.ground === 'shed' ? 3.2 : 0;

  // ---- Body.
  const off = spec.setback ? 1.6 : 0;
  const yTop = spec.setback ? GROUND_H + (spec.floors - 2) * FLOOR_H : H;
  if (recess > 0) slab(mb, recess, 0, -half, D, GROUND_H, half, wallPaint, NX | PZ | NZ);
  slab(mb, 0, recess > 0 ? GROUND_H : 0, -half, D, yTop, half, wallPaint, NX | PZ | NZ | PY);
  if (off > 0) slab(mb, off, yTop, -half, D, H, half, wallPaint, NX | PZ | NZ | PY);
  // Side-wall windows: hidden inside a same-depth neighbour, they show above a lower neighbour
  // and beside alleys / quay openings so those walls are never blank.
  for (const sd of [-1, 1]) {
    const z = sd * (half + 0.02);
    for (let f = 1; f < spec.floors; f++) {
      const y0 = GROUND_H + (f - 1) * FLOOR_H + 0.9;
      if (y0 + 1.6 > yTop) break;
      for (const x of [2.2, 5.6]) {
        quadN(mb, [x, y0, z], [x + 1.1, y0, z], [x + 1.1, y0 + 1.6, z], [x, y0 + 1.6, z], [0, 0, sd], glass(look, 0.3));
        quadN(mb, [x - 0.12, y0 - 0.18, z], [x + 1.22, y0 - 0.18, z], [x + 1.22, y0 - 0.02, z], [x - 0.12, y0 - 0.02, z], [0, 0, sd], 0xeee7da);
      }
    }
  }
  // Plinth, corner pilasters, string course, cornice.
  const darkWall = shadeHex(wall, 0.82);
  if (recess === 0) det(mb, -0.08, 0.15, -half, 0, 0.6, half, grad(shadeHex(wall, 0.7), 0.85));
  const quoin = spec.ground === 'warehouse' || spec.ground === 'shed' ? shadeHex(wall, 0.85) : mixHex(wall, 0xffffff, 0.35);
  for (const s of [-1, 1]) {
    const za = s < 0 ? -half : half - 0.42;
    det(mb, -0.1, recess > 0 ? GROUND_H : 0.6, za, 0, yTop - (off > 0 ? 0 : 0.3), za + 0.42, grad(quoin, 0.9));
  }
  det(mb, -0.2, GROUND_H - 0.05, -half, 0, GROUND_H + 0.22, half, grad(look.trim === 0xffffff ? 0xf3eee4 : look.trim, 0.85));
  const flatTop = spec.roof === 'parapet' || spec.roof === 'terrace' || spec.roof === 'tower';
  mb.push().translate(off, 0, 0);
  if (flatTop) {
    det(mb, -0.3, H - 0.45, -half, 0, H - 0.2, half, grad(shadeHex(wall, 0.9), 0.9));
    det(mb, -0.45, H - 0.2, -half, 0, H + 0.05, half, mixHex(wall, 0xffffff, 0.4));
  } else if (spec.roof !== 'gable' && spec.roof !== 'shedroof') {
    det(mb, -0.3, H - 0.35, -half, 0, H, half, mixHex(wall, 0xffffff, 0.3));
  }
  mb.pop();

  // ---- Ground floor.
  const nb = Math.max(2, Math.round(w / 2.75));
  const bw = w / nb;
  const zc = (i: number) => -half + bw * (i + 0.5);
  const doorBay = rnd.int(nb);
  const gh = GROUND_H - 0.25;
  switch (spec.ground) {
    case 'shop':
    case 'cafe': {
      const shopH = gh - 1.0;
      shopfront(mb, look, -half + 0.45, half - 0.45, shopH, doorBay, spec.ground === 'cafe' ? Math.max(2, nb) : nb);
      fascia(mb, look, -half + 0.45, half - 0.45, shopH + 0.22, gh - 0.1);
      if (spec.awning !== false) {
        const pair = P.AWNING_PAIRS[rnd.int(P.AWNING_PAIRS.length)];
        awning(mb, -half + 0.5, half - 0.5, shopH + 0.1, spec.ground === 'cafe' ? 2.3 : 1.7, 0.95, pair, look.night);
        if (look.night) bulbString(mb, -half + 0.6, half - 0.6, shopH - 0.95, -(spec.ground === 'cafe' ? 2.3 : 1.7) + 0.05, P.LANTERN, rnd);
      } else if (look.night) {
        bulbString(mb, -half + 0.6, half - 0.6, shopH + 0.05, -0.4, P.LANTERN, rnd);
      }
      break;
    }
    case 'house': {
      door(mb, look, zc(doorBay), 1.3, 2.6, rnd.pick([0x2a6f8f, 0x8f3b2a, 0x3d6b45, 0x5e3b26]));
      for (let i = 0; i < nb; i++) {
        if (i === doorBay) continue;
        window(mb, look, zc(i), 1.2, Math.min(1.2, bw * 0.5), 1.9, { shutters: true });
      }
      break;
    }
    case 'arcade':
      arcade(mb, look, -half, half, GROUND_H, nb, recess);
      break;
    case 'warehouse': {
      const doors = w >= 10 ? 2 : 1;
      const dw = Math.min(3.6, (w - 1.5) / doors - 0.8);
      for (let k = 0; k < doors; k++) {
        const c = doors === 1 ? 0 : (k === 0 ? -w / 4 : w / 4);
        bigDoor(mb, look, c - dw / 2, c + dw / 2, 3.4, rnd.pick([0x2f6f73, 0x8b3a2f, 0x3c5a7a, 0x6b7b4a]), rnd.chance(0.35) || (look.night && k === 0));
      }
      // Loading platform.
      slab(mb, -1.2, 0, -half + 0.2, 0, 0.75, half - 0.2, grad(0x9b8f7c, 0.75), NX | PY | PZ | NZ);
      for (let z = -half + 0.6; z < half - 0.4; z += 1.6) det(mb, -1.25, 0.15, z - 0.12, -1.1, 0.7, z + 0.12, 0x2c2c2c);
      break;
    }
    case 'shed': {
      // Open market hall: columns at the front, counters with ice + fish crates inside.
      const cols = Math.max(3, Math.round(w / 3) + 1);
      for (let k = 0; k < cols; k++) {
        const z = -half + 0.3 + ((w - 0.6) * k) / (cols - 1);
        free(mb, -0.25, 0.15, z - 0.2, 0.15, GROUND_H, z + 0.2, grad(look.trim, 0.8));
      }
      slab(mb, 0, 0.13, -half, recess, 0.15, half, 0xb4b0a6, PY);
      slab(mb, 0, GROUND_H - 0.02, -half, recess, GROUND_H, half, shadeHex(wall, 0.55), 8);
      panelNX(mb, recess - 0.01, 0.15, -half, GROUND_H, half, look.night ? 0x3a2c24 : shadeHex(wall, 0.6));
      for (let z = -half + 1.2; z < half - 1; z += 2.6) {
        slab(mb, 0.6, 0.15, z - 1, 1.9, 1.0, z + 1, grad(0xd8d6d0, 0.8), NX | PX | PY | PZ | NZ);
        slab(mb, 0.65, 1.0, z - 0.95, 1.85, 1.08, z + 0.95, 0xeaf4f7, PY | NX);
        for (let k = 0; k < 3; k++) mb.push().translate(1.2, 1.12, z - 0.6 + k * 0.6).box(0.6, 0.08, 0.2, rnd.pick([0x9fb6c2, 0xd88c6a, 0xc0c8cc])).pop();
      }
      if (look.night) for (let z = -half + 1.5; z < half - 1; z += 3) mb.push().translate(1.4, GROUND_H - 0.6, z).sphere(0.22, 0.25, 0.22, 6, 3, glowPaint(P.LIGHT_WARM, 0.95)).pop();
      // Striped canopy along the front.
      const pair = P.AWNING_PAIRS[rnd.int(P.AWNING_PAIRS.length)];
      awning(mb, -half + 0.1, half - 0.1, GROUND_H + 0.1, 1.6, 0.7, pair, look.night);
      break;
    }
    case 'stalls':
      break;
  }

  // ---- Upper floors.
  const shutterPref = spec.upper === 'shutters' || (spec.upper === 'mixed' && rnd.chance(0.5));
  for (let f = 1; f < spec.floors; f++) {
    const yFloor = GROUND_H + (f - 1) * FLOOR_H;
    const top = f === spec.floors - 1;
    const set = spec.setback && top;
    if (set) {
      // Setback top floor: terrace slab + railing in front, upper wall further back.
      mb.push().translate(off, 0, 0);
    }
    for (let i = 0; i < nb; i++) {
      const z = zc(i);
      const ww = Math.min(1.35, bw * 0.48);
      const wh = 1.75;
      const y0 = yFloor + 0.85;
      let kind: UpperKind = spec.upper;
      if (kind === 'mixed') kind = f === 1 ? 'balcony' : rnd.pick(['shutters', 'boxes', 'arched'] as const);
      if (kind === 'loggia') kind = f === spec.floors - 1 ? 'arched' : 'balcony';
      if (f >= 3 && kind !== 'industrial') {
        // Upper storeys (rarely seen up close) get a simpler window: frame, one pane, sill.
        simpleWindow(mb, look, z, y0, ww, wh, kind === 'shutters' || kind === 'boxes');
        continue;
      }
      switch (kind) {
        case 'shutters':
          window(mb, look, z, y0, ww, wh, { shutters: true, box: rnd.chance(0.2) });
          break;
        case 'boxes':
          window(mb, look, z, y0, ww, wh, { shutters: shutterPref && rnd.chance(0.5), box: true });
          break;
        case 'arched':
          window(mb, look, z, y0, ww, wh + 0.2, { arched: true, box: rnd.chance(0.3) });
          break;
        case 'balcony': {
          frenchDoor(mb, look, z, yFloor + 0.2, ww, 2.3);
          if (spec.upper !== 'mixed' || f === 1) {
            const span = f === 1 && nb >= 3 && spec.upper === 'balcony' && i === Math.floor(nb / 2);
            balcony(mb, look, z - (span ? bw * 0.45 : ww / 2 + 0.35), z + (span ? bw * 0.45 : ww / 2 + 0.35), yFloor + 0.2, span ? 1.1 : 0.8);
          }
          break;
        }
        case 'industrial': {
          const iw = bw * 0.7;
          det(mb, -0.1, y0 - 0.15, z - iw / 2 - 0.1, 0, y0 + wh + 0.15, z + iw / 2 + 0.1, look.trim);
          panelNX(mb, -0.12, y0, z - iw / 2, y0 + wh, z + iw / 2, glassPaintFor(look));
          for (let k = 1; k < 4; k++) det(mb, -0.15, y0, z - iw / 2 + (iw * k) / 4 - 0.03, -0.12, y0 + wh, z - iw / 2 + (iw * k) / 4 + 0.03, look.trim);
          det(mb, -0.15, y0 + wh * 0.5 - 0.03, z - iw / 2, -0.12, y0 + wh * 0.5 + 0.03, z + iw / 2, look.trim);
          det(mb, -0.2, y0 - 0.25, z - iw / 2 - 0.15, 0, y0 - 0.12, z + iw / 2 + 0.15, 0xd9d2c4);
          break;
        }
        default:
          window(mb, look, z, y0, ww, wh, {});
      }
      if (!top && !set && f <= 2 && rnd.chance(0.12) && kind !== 'balcony') acUnit(mb, z + (rnd.chance(0.5) ? 0.9 : -0.9) * Math.min(1, bw * 0.3), yFloor + 0.25);
    }
    if (set) {
      mb.pop();
      // Terrace railing at the original front + wall section of the setback.
      slab(mb, -0.05, yFloor - 0.05, -half, off, yFloor + 0.03, half, 0xd6cfc0, PY | NX);
      for (let z = -half + 0.2; z <= half - 0.15; z += 0.45) free(mb, -0.02, yFloor, z - 0.03, 0.04, yFloor + 1.0, z + 0.03, P.IRON);
      free(mb, -0.05, yFloor + 0.95, -half, 0.08, yFloor + 1.05, half, P.IRON);
    }
    // Floor band.
    if (!top && spec.floors > 2 && f % 2 === 1 && spec.ground !== 'warehouse') det(mb, -0.12, yFloor + FLOOR_H - 0.12, -half, 0, yFloor + FLOOR_H, half, darkWall);
  }

  // ---- Warehouse sign band.
  if (spec.band) {
    const y = GROUND_H + 0.5;
    det(mb, -0.12, y, -half + 0.8, 0, y + 1.0, half - 0.8, look.night ? 0x253040 : 0xf1ece1);
    const letters = Math.round((w - 2) / 0.9);
    const lc = look.night ? glowPaint(rnd.pick(P.NEON), 0.85) : { color: rnd.pick([0x264653, 0x8b3a2f, 0x2a6f8f]) };
    for (let k = 0; k < letters; k++) {
      const z = -half + 1.2 + k * ((w - 2.4) / letters);
      det(mb, -0.17, y + 0.22, z, -0.12, y + 0.78, z + ((w - 2.4) / letters) * 0.7, lc);
    }
  }

  // ---- Extras: drainpipe, blade sign.
  if (rnd.chance(0.6) && spec.ground !== 'shed') drainpipe(mb, rnd.chance(0.5) ? -half + 0.65 : half - 0.65, H, rnd.pick([0x7d8a8f, 0xb87333, 0x6f6f6f, 0xe8e3d8]));
  if (spec.blade) bladeSign(mb, look, rnd.chance(0.5) ? -half + 0.9 : half - 0.9, GROUND_H + 0.6);

  // ---- Roof (on the setback block when there is one).
  mb.push().translate(off, 0, 0);
  const Dr = D - off;
  switch (spec.roof) {
    case 'parapet':
      parapet(mb, H, Dr, w, shadeHex(wall, 0.95), mixHex(wall, 0xffffff, 0.45), 0.7);
      roofClutter(mb, rnd, H, Dr, w, rnd.pick([['tank', 'antenna'], ['solar', 'ac'], ['hut', 'antenna'], ['tank', 'solar'], ['ac', 'ac', 'antenna']] as const).slice());
      break;
    case 'terrace': {
      parapet(mb, H, Dr, w, shadeHex(wall, 0.95), mixHex(wall, 0xffffff, 0.45), 1.0);
      // Pergola with climbing green and a parasol.
      const x0 = 1.0, x1 = Math.min(Dr - 1, 5);
      for (const x of [x0, x1]) for (const z of [-half + 1, half - 1]) slab(mb, x - 0.08, H, z - 0.08, x + 0.08, H + 2.5, z + 0.08, P.WOOD, NX | PX | PZ | NZ);
      for (let z = -half + 1; z <= half - 0.9; z += 0.6) slab(mb, x0 - 0.2, H + 2.5, z - 0.05, x1 + 0.2, H + 2.62, z + 0.05, P.WOOD, NX | PZ | NZ | 8);
      for (let k = 0; k < 4; k++) mb.push().translate(x0 + rnd.range(0, x1 - x0), H + 2.7, rnd.range(-half + 1, half - 1)).sphere(0.7, 0.35, 0.7, 6, 3, { color: P.LEAF, bottom: P.LEAF_DARK }).pop();
      const pz = rnd.range(-half + 1.5, half - 1.5);
      mb.push().translate(x1 + 1.4, H + 2.2, pz).cone(1.4, 0.6, 8, { color: rnd.pick([0xe76f51, 0x2a9d8f, 0xe9c46a]), bottom: 0xffffff }).pop();
      bar(mb, [x1 + 1.4, H, pz], [x1 + 1.4, H + 2.0, pz], 0.06, 0xdddddd);
      if (look.night) bulbString(mb, -half + 0.8, half - 0.8, H + 2.4, x0, P.LANTERN, rnd);
      break;
    }
    case 'tile':
      tileRoof(mb, rnd, H, Dr, w, look, rnd.chance(0.5));
      break;
    case 'hip':
      hipRoof(mb, H, Dr, w, look);
      break;
    case 'gable':
      gableFront(mb, H, Dr, w, look, rnd.pick([0x6d7b82, 0x9a4a35, 0x5c6b5a, 0x7b8794]));
      if (rnd.chance(0.7)) {
        // Hoist beam with pulley.
        free(mb, -1.2, H + 0.9, -0.12, 0.0, H + 1.15, 0.12, 0x4a3a2a);
        mb.push().translate(-1.05, H + 0.75, 0).rotateX(Math.PI / 2).cylinder(0.16, 0.08, 8, {}, 0x333333).pop();
        bar(mb, [-1.21, H + 0.7, 0], [-1.21, GROUND_H + 0.6, 0], 0.03, 0xc9b48a);
      }
      break;
    case 'shedroof': {
      // Low mono-pitch roof (sheds): rises toward the back.
      mb.push().translate(-0.6, H, 0).rotateZ(0.16);
      slab(mb, 0, 0, -half, Dr + 0.8, 0.18, half, { color: 0x7b8794, bottom: 0x5b6670, jitter: 0.05 }, NX | PY | 8 | PZ | NZ);
      mb.pop();
      slab(mb, 0, H, -half, Dr, H + Math.tan(0.16) * Dr, -half + 0.02, shadeHex(wall, 0.9), NZ);
      slab(mb, 0, H, half - 0.02, Dr, H + Math.tan(0.16) * Dr, half, shadeHex(wall, 0.9), PZ);
      if (spec.band !== true) {
        // Ventilator on top.
        slab(mb, Dr * 0.5 - 0.6, H + Math.tan(0.16) * (Dr * 0.5) + 0.1, -1, Dr * 0.5 + 0.6, H + Math.tan(0.16) * Dr * 0.5 + 0.9, 1, grad(0xc0c4c8, 0.8), NX | PX | PZ | NZ | PY);
      }
      break;
    }
    case 'tower': {
      parapet(mb, H, Dr, w, shadeHex(wall, 0.95), mixHex(wall, 0xffffff, 0.45), 0.6);
      // Small clock / bell turret centred near the front.
      const tx = 2.2, th = 3.6;
      slab(mb, tx - 1.3, H, -1.3, tx + 1.3, H + th, 1.3, grad(mixHex(wall, 0xffffff, 0.25), 0.85), NX | PX | PZ | NZ);
      det(mb, -0.15 + tx - 1.3, H + th - 0.3, -1.4, tx - 1.3, H + th, 1.4, look.trim);
      mb.push().translate(tx - 1.36, H + th * 0.55, 0).rotateZ(Math.PI / 2);
      mb.cylinder(0.85, 0.08, 14, {}, 0xf4efe2);
      mb.pop();
      mb.push().translate(tx - 1.42, H + th * 0.55, 0);
      mb.box(0.04, 0.6, 0.08, 0x222222).translate(0, 0.0, 0.18).box(0.04, 0.08, 0.42, 0x222222);
      mb.pop();
      mb.push().translate(tx, H + th + 1.2, 0).scale(1, 1, 1);
      mb.cylinder(1.95, 2.4, 4, { radiusTop: 0.05, capBottom: false }, { color: look.accent, bottom: shadeHex(look.accent, 0.7) });
      mb.pop();
      if (look.night) mb.push().translate(tx - 1.37, H + th * 0.55, 0).rotateZ(Math.PI / 2).cylinder(0.7, 0.04, 14, {}, glowPaint(P.LIGHT_CREAM, 0.6)).pop();
      break;
    }
  }
  mb.pop();
  // Flower boxes on the first floor of some buildings regardless of style (market life).
  if (!spec.night && spec.upper === 'shutters' && rnd.chance(0.3)) flowerBox(mb, look, zc(0), GROUND_H + 0.6, 1.2);
  void NZ;
  void PZ;
  return mb;
}

function simpleWindow(mb: MeshBuilder, look: Look, zc: number, y0: number, ww: number, wh: number, shutters: boolean): void {
  const z0 = zc - ww / 2, z1 = zc + ww / 2;
  det(mb, -0.08, y0 - 0.1, z0 - 0.1, 0, y0 + wh + 0.1, z1 + 0.1, look.night ? shadeHex(look.trim, 0.8) : look.trim);
  panelNX(mb, -0.1, y0, z0, y0 + wh, z1, glass(look));
  det(mb, -0.2, y0 - 0.2, z0 - 0.18, 0, y0 - 0.08, z1 + 0.18, 0xeee7da);
  if (shutters) {
    for (const sd of [-1, 1]) {
      const za = sd < 0 ? z0 - 0.12 - ww / 2 : z1 + 0.12;
      slab(mb, -0.06, y0, za, 0, y0 + wh, za + ww / 2, grad(look.shutter, 0.82), NX | PZ | NZ);
    }
  }
}

function glassPaintFor(look: Look) {
  if (look.night && look.rnd.chance(0.45)) return glowPaint(P.LIGHT_AMBER, 0.28);
  return look.night ? { color: 0x1c2533 } : { color: 0x3b5566, top: P.GLASS_TOP, bottom: P.GLASS_BOTTOM, jitter: 0.06 };
}

// ------------------------------------------------------------------------- catalogues

type Row = [w: number, floors: number, ground: GroundKind, upper: UpperKind, roof: RoofKind, extra?: Partial<BuildingSpec>];

const MARKET_ROWS: Row[] = [
  [8, 3, 'shop', 'shutters', 'parapet', { blade: true }],
  [10, 2, 'cafe', 'balcony', 'tile'],
  [6, 4, 'shop', 'boxes', 'hip'],
  [12, 3, 'arcade', 'arched', 'terrace'],
  [8, 2, 'shop', 'shutters', 'tile', { blade: true }],
  [10, 4, 'shop', 'balcony', 'parapet', { setback: true }],
  [6, 3, 'cafe', 'arched', 'tile'],
  [12, 2, 'shop', 'boxes', 'parapet'],
  [8, 5, 'shop', 'mixed', 'parapet', { blade: true }],
  [10, 3, 'arcade', 'shutters', 'hip'],
  [6, 2, 'house', 'boxes', 'terrace'],
  [12, 4, 'cafe', 'balcony', 'tile'],
  [8, 3, 'house', 'shutters', 'parapet'],
  [10, 3, 'shop', 'arched', 'tower'],
];

const NIGHT_ROWS: Row[] = [
  [8, 3, 'shop', 'balcony', 'parapet', { blade: true }],
  [10, 2, 'shop', 'shutters', 'tile', { blade: true }],
  [6, 4, 'cafe', 'boxes', 'parapet'],
  [12, 3, 'arcade', 'arched', 'parapet'],
  [8, 2, 'cafe', 'arched', 'terrace'],
  [10, 4, 'shop', 'mixed', 'tile', { blade: true }],
  [6, 3, 'shop', 'shutters', 'hip', { awning: false, blade: true }],
  [12, 2, 'shop', 'balcony', 'terrace'],
  [8, 4, 'shop', 'boxes', 'tile'],
  [10, 3, 'cafe', 'balcony', 'parapet', { setback: true }],
  [6, 2, 'shop', 'arched', 'tile', { blade: true }],
  [12, 4, 'arcade', 'shutters', 'tower'],
  [8, 3, 'house', 'boxes', 'hip'],
  [10, 2, 'shop', 'shutters', 'parapet', { awning: false }],
];

const HARBOR_ROWS: Row[] = [
  [12, 2, 'warehouse', 'industrial', 'gable', { band: true }],
  [10, 3, 'warehouse', 'industrial', 'parapet', { band: true }],
  [8, 1, 'shed', 'shutters', 'shedroof'],
  [12, 3, 'arcade', 'arched', 'tower'],
  [6, 3, 'shop', 'shutters', 'tile', { blade: true }],
  [10, 2, 'warehouse', 'industrial', 'tile'],
  [8, 3, 'shop', 'boxes', 'hip', { blade: true }],
  [12, 1, 'shed', 'shutters', 'shedroof', { band: true }],
  [6, 2, 'warehouse', 'industrial', 'gable'],
  [10, 4, 'cafe', 'balcony', 'parapet'],
  [8, 2, 'warehouse', 'industrial', 'gable', { band: true }],
  [12, 3, 'warehouse', 'industrial', 'parapet'],
  [10, 2, 'cafe', 'shutters', 'tile'],
  [6, 4, 'house', 'shutters', 'parapet'],
];

export type ZoneFamily = 0 | 1 | 2;

export function zoneSpecs(zone: ZoneFamily): BuildingSpec[] {
  const rows = zone === 0 ? MARKET_ROWS : zone === 1 ? HARBOR_ROWS : NIGHT_ROWS;
  return rows.map(([w, floors, ground, upper, roof, extra], i) => ({
    w, floors, ground, upper, roof,
    wall: zone === 1 ? i * 3 : i * 7 + 3,
    seed: 1000 * (zone + 1) + i * 37,
    night: zone === 2,
    depth: zone === 1 ? 12 : 11 + (i % 3),
    ...extra,
  }));
}

export function zoneWalls(zone: ZoneFamily): readonly number[] {
  return zone === 1 ? P.WALLS_HARBOR : P.WALLS_MARKET;
}
