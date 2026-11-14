// Deterministic street layout: what goes where in one chunk. Pure logic (no engine), seeded by
// the chunk index and zone, so the same chunk always looks the same and can be unit-tested.
//
// Placements are in chunk-local coordinates: x lateral, y up, u = metres from the chunk start
// along the run direction (world z = chunkZ - u), rot = rotation about Y (0 for right-side
// modules, PI for left-side ones, which are authored for the right side).
import { CHUNK_LEN, FRONT_X, QUAY_EDGE } from './layoutConst';
import { STRING_Y } from './overhead';

export interface Place {
  key: string;
  x: number;
  y: number;
  u: number;
  rot: number;
}

export type AnimKind = 'swing' | 'bob';

export interface AnimPlace extends Place {
  anim: AnimKind;
  phase: number;
}

export interface ChunkLayout {
  index: number;
  zone: number;
  items: Place[];
  anim: AnimPlace[];
}

/** Building catalogue summary the layout needs: width of each variant per zone. */
export type WidthTable = readonly (readonly number[])[];

const SW_Y = 0.15;
const PI = Math.PI;

class R {
  private s: number;
  constructor(a: number, b: number) {
    this.s = (Math.imul(a + 0x9e37, 0x85ebca6b) ^ Math.imul(b + 0x51ed, 0xc2b2ae35)) >>> 0 || 7;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.next() * a.length)];
  }
  weighted(entries: readonly (readonly [string, number])[]): string {
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return entries[entries.length - 1][0];
  }
}

type Seg = { kind: 'b'; w: number; v: number } | { kind: 'gap'; w: number };

/** Split CHUNK_LEN into buildings + gaps for one side. */
function facadeRow(rnd: R, widths: readonly number[], gapSizes: readonly number[], gapChance: number, allowed?: readonly boolean[]): Seg[] {
  const byW = new Map<number, number[]>();
  widths.forEach((w, i) => {
    if (allowed && !allowed[i]) return;
    if (!byW.has(w)) byW.set(w, []);
    byW.get(w)!.push(i);
  });
  const ws = [...byW.keys()];
  const minW = Math.min(...ws);
  const out: Seg[] = [];
  let u = 0;
  let prevGap = true; // no gap right at the chunk start
  const recent: number[] = [];
  let guard = 0;
  while (u < CHUNK_LEN - 1e-6 && guard++ < 50) {
    const rem = CHUNK_LEN - u;
    const ok = (c: number) => rem - c === 0 || rem - c >= minW;
    if (!prevGap && gapSizes.length && rnd.chance(gapChance)) {
      const g = gapSizes.filter((s) => ok(s) && rem - s !== 0);
      if (g.length) {
        const w = rnd.pick(g);
        out.push({ kind: 'gap', w });
        u += w;
        prevGap = true;
        continue;
      }
    }
    let cands = ws.filter(ok);
    if (!cands.length) cands = [rem]; // cannot happen with even widths summing to 50, kept safe
    const w = rnd.pick(cands);
    const vs = byW.get(w) ?? [0];
    const fresh = vs.filter((x) => !recent.includes(x));
    const v = rnd.pick(fresh.length ? fresh : vs);
    recent.push(v);
    if (recent.length > 3) recent.shift();
    out.push({ kind: 'b', w, v });
    u += w;
    prevGap = false;
  }
  return out;
}

const CURB_X = 5.35;
const LAMP_U_R = [6, 31];
const LAMP_U_L = [18.5, 43.5];
const STRING_U = [12.25, 37.25];

const FRONTAGE: Record<number, readonly (readonly [string, number])[]> = {
  0: [['cafe', 3], ['stall', 3], ['planter', 2], ['pots', 2], ['bench', 2], ['crates', 1], ['bicycle', 1], ['hedge', 1]],
  1: [['crates', 3], ['barrels', 3], ['nets', 2], ['bench', 1.5], ['pots', 1], ['bicycle', 1], ['stall', 0.7]],
  2: [['foodStall', 4], ['cafeNight', 2.5], ['stallNight', 2], ['pots', 1.5], ['crates', 1], ['bench', 1]],
};
const CURB: Record<number, readonly (readonly [string, number])[]> = {
  0: [['bin', 2], ['hydrant', 1], ['bollards', 1.5], ['scooter', 2.5], ['signpost', 1], ['bicycle', 1]],
  1: [['bollards', 2], ['bin', 1.5], ['hydrant', 1], ['signpost', 1], ['scooter', 1]],
  2: [['scooter', 3.5], ['bin', 1], ['bollards', 1], ['bicycle', 1]],
};
/** Half-length along the street and frontage x per prop (right-side frame). */
export const PROP_SLOT: Record<string, { half: number; x: number }> = {
  cafe: { half: 1.35, x: 6.65 },
  cafeNight: { half: 1.35, x: 6.65 },
  stall: { half: 1.6, x: 6.6 },
  stallNight: { half: 1.6, x: 6.6 },
  foodStall: { half: 1.6, x: 6.6 },
  planter: { half: 1.0, x: 7.25 },
  hedge: { half: 1.0, x: 7.25 },
  pots: { half: 0.9, x: 7.2 },
  bench: { half: 1.0, x: 7.3 },
  crates: { half: 1.6, x: 7.1 },
  barrels: { half: 0.8, x: 7.25 },
  nets: { half: 1.9, x: 6.9 },
  bicycle: { half: 1.0, x: 7.3 },
  bin: { half: 0.4, x: CURB_X },
  hydrant: { half: 0.3, x: 5.2 },
  bollards: { half: 1.6, x: 5.05 },
  scooter: { half: 0.95, x: 5.4 },
  signpost: { half: 1.0, x: 5.3 },
};

function fill(rnd: R, side: 1 | -1, zone: number, list: readonly (readonly [string, number])[], blocked: [number, number][], items: Place[], density: number, curb: boolean): void {
  let u = 1.5 + rnd.next() * 3;
  while (u < CHUNK_LEN - 1.5) {
    const key = rnd.weighted(list);
    const slot = PROP_SLOT[key];
    const lo = u, hi = u + 2 * slot.half;
    if (hi > CHUNK_LEN - 0.5) break;
    const clash = blocked.some(([a, b]) => hi > a && lo < b);
    if (!clash && rnd.chance(density)) {
      const x = curb && key === 'bicycle' ? 5.45 : slot.x;
      items.push({ key, x: side * x, y: SW_Y, u: u + slot.half, rot: side > 0 ? 0 : PI });
      blocked.push([lo - 0.4, hi + 0.4]);
      u = hi + 0.6 + rnd.next() * (zone === 1 ? 4 : 2.5);
    } else {
      u += 1.2 + rnd.next() * 2;
    }
  }
}

/** Number of variants of each module family the library must provide. */
export const VARIANTS = { ground: 3, backTown: 2, backNight: 2, backHarbor: 2, farTown: 2, farNight: 2, farHarbor: 2, farSea: 2, bunting: 2, flags: 2, lanterns: 1 };

export function chunkZone(index: number, offset: number, zoneLen: number, zoneCount: number): number {
  // Chunks behind the start line (negative index) belong to the same zone as the first chunk.
  const z = Math.floor((Math.max(0, index) * CHUNK_LEN) / zoneLen) + offset;
  return ((z % zoneCount) + zoneCount) % zoneCount;
}

/**
 * Lay out chunk `index` for `zone` (0 market, 1 harbor, 2 night). `low` marks the low building
 * variants (<= 2 storeys) allowed on the harbour's sea side, so masts and sky show over them.
 */
export function layoutChunk(index: number, zone: number, widths: WidthTable, low?: readonly (readonly boolean[])[]): ChunkLayout {
  const rnd = new R(index, zone);
  const items: Place[] = [];
  const anim: AnimPlace[] = [];
  const L = CHUNK_LEN;
  const night = zone === 2;
  const harbor = zone === 1;

  // ---- Ground.
  items.push({ key: `ground${rnd.int(VARIANTS.ground)}`, x: 0, y: 0, u: 0, rot: 0 });
  items.push({ key: 'fill:town', x: 0, y: 0, u: 0, rot: 0 });
  if (harbor) {
    items.push({ key: 'fill:quay', x: 0, y: 0, u: L, rot: PI });
    items.push({ key: 'sea', x: 0, y: 0, u: L, rot: PI });
  } else {
    items.push({ key: 'fill:town', x: 0, y: 0, u: L, rot: PI });
  }

  // ---- Gate (once per zone, mid-zone) reserves sidewalk space.
  const gate = ((index % 10) + 10) % 10 === 4;
  const reserveCurb: Record<1 | -1, [number, number][]> = { 1: [], [-1]: [] };
  const reserveFront: Record<1 | -1, [number, number][]> = { 1: [], [-1]: [] };
  if (gate) {
    items.push({ key: `gate${zone}`, x: 0, y: 0, u: 25, rot: 0 });
    for (const s of [1, -1] as const) {
      reserveCurb[s].push([21.5, 28.5]);
      reserveFront[s].push([22.5, 27.5]);
    }
  }

  // ---- Facades.
  for (const side of [1, -1] as const) {
    const quaySide = harbor && side < 0;
    const segs = facadeRow(rnd, widths[zone], quaySide ? [12, 16, 20] : [4], quaySide ? 0.65 : 0.15, quaySide ? low?.[zone] : undefined);
    let u = 0;
    for (const sg of segs) {
      const uc = u + sg.w / 2;
      if (sg.kind === 'b') {
        items.push({ key: `b${zone}_${sg.v}`, x: side * FRONT_X, y: 0, u: uc, rot: side > 0 ? 0 : PI });
      } else if (quaySide) {
        // Quay opening: deck props, a palm, moored boats beyond the railing.
        const boatKey = rnd.pick(['boat0', 'boat1', 'boat0']);
        anim.push({ key: boatKey, x: side * (QUAY_EDGE + 2.6), y: -1.25, u: uc + (rnd.next() - 0.5) * 2, rot: side > 0 ? 0 : PI, anim: 'bob', phase: rnd.next() * 6.28 });
        if (sg.w >= 16) anim.push({ key: rnd.pick(['boat0', 'boat0']), x: side * (QUAY_EDGE + 7), y: -1.25, u: uc + rnd.next() * 3, rot: side > 0 ? PI : 0, anim: 'bob', phase: rnd.next() * 6.28 });
        items.push({ key: 'palm', x: side * 10.5, y: SW_Y, u: u + 2.5, rot: side > 0 ? 0 : PI });
        items.push({ key: rnd.pick(['crates', 'barrels', 'nets']), x: side * 15, y: SW_Y, u: uc + 1, rot: side > 0 ? 0 : PI });
        if (sg.w >= 16) items.push({ key: 'barrels', x: side * 18, y: SW_Y, u: u + sg.w - 3, rot: side > 0 ? 0 : PI });
        items.push({ key: 'bench', x: side * 12.5, y: SW_Y, u: u + sg.w - 2.5, rot: side > 0 ? 0 : PI });
      } else if (rnd.chance(0.7)) {
        items.push({ key: 'laundry', x: side * FRONT_X, y: SW_Y, u: uc, rot: side > 0 ? 0 : PI });
      }
      u += sg.w;
    }
  }

  // ---- Harbour: more boats moored along the quay behind the low sheds (masts show over roofs).
  if (harbor) {
    for (let k = 0; k < 2; k++) {
      const u = 8 + k * 22 + rnd.next() * 10;
      anim.push({ key: rnd.chance(0.6) ? 'boat1' : rnd.pick(['boat0', 'boat0']), x: -(QUAY_EDGE + 2.6), y: -1.25, u, rot: PI, anim: 'bob', phase: rnd.next() * 6.28 });
    }
  }

  // ---- Back row + far layers.
  for (const side of [1, -1] as const) {
    const uu = side > 0 ? 0 : L;
    const rot = side > 0 ? 0 : PI;
    if (harbor && side < 0) {
      items.push({ key: `far:sea:${((index % 3) + 3) % 3 === 0 ? 0 : (rnd.int(2), 1)}`, x: 0, y: 0, u: uu, rot });
      continue;
    }
    // One merged module per side carries the rear row AND the far hills (one draw, not two).
    // Both variant draws are still consumed so the rest of the layout stays unchanged.
    const kind = harbor ? 'harbor' : night ? 'night' : 'town';
    const v = rnd.int(2);
    rnd.int(2);
    items.push({ key: `bg:${kind}:${v}`, x: 0, y: 0, u: uu, rot });
  }

  // ---- Sidewalk rhythm: lamps, trees, masts + strings.
  for (const side of [1, -1] as const) {
    const rot = side > 0 ? 0 : PI;
    const lamps = side > 0 ? LAMP_U_R : LAMP_U_L;
    const trees = side > 0 ? LAMP_U_L : LAMP_U_R;
    for (const u of lamps) {
      if (gate && Math.abs(u - 25) < 4) continue;
      items.push({ key: night ? 'lampNight' : 'lamp', x: side * CURB_X, y: SW_Y, u, rot });
      reserveCurb[side].push([u - 1.2, u + 1.2]);
    }
    if (!harbor) {
      for (const u of trees) {
        if (gate && Math.abs(u - 25) < 4) continue;
        if (rnd.chance(night ? 0.5 : 0.8)) {
          items.push({ key: 'tree', x: side * 5.9, y: SW_Y, u, rot });
          reserveCurb[side].push([u - 1.6, u + 1.6]);
          reserveFront[side].push([u - 0.8, u + 0.8]);
        }
      }
    }
  }
  const strings: number[] = [];
  for (const u of STRING_U) {
    const p = zone === 0 ? (u < 20 ? 1 : 0.6) : zone === 2 ? 1 : u > 20 ? 0.5 : 0;
    if (rnd.chance(p)) strings.push(u);
  }
  for (const u of strings) {
    for (const side of [1, -1] as const) {
      items.push({ key: night ? 'mastNight' : 'mast', x: side * 5.0, y: SW_Y, u, rot: side > 0 ? 0 : PI });
      reserveCurb[side].push([u - 1.0, u + 1.0]);
    }
    const key = zone === 0 ? `bunting${rnd.int(VARIANTS.bunting)}` : zone === 1 ? `flags${rnd.int(VARIANTS.flags)}` : `lanterns${rnd.int(VARIANTS.lanterns)}`;
    anim.push({ key, x: 0, y: STRING_Y, u, rot: 0, anim: 'swing', phase: rnd.next() * 6.28 });
  }

  // ---- Curb + frontage props.
  for (const side of [1, -1] as const) {
    if (harbor && side < 0) {
      fill(rnd, side, zone, CURB[zone], reserveCurb[side], items, 0.35, true);
      continue;
    }
    fill(rnd, side, zone, CURB[zone], reserveCurb[side], items, zone === 1 ? 0.45 : 0.55, true);
    fill(rnd, side, zone, FRONTAGE[zone], reserveFront[side], items, zone === 1 ? 0.6 : 0.8, false);
  }
  return { index, zone, items, anim };
}
