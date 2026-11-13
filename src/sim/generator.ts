// Track generator: hand-authored patterns, mixed by a distance-driven difficulty tier.
//
// Planning runs ~70 m beyond the spawn window. Each pattern is first *staged*, then validated:
//  - no entity may sit in the path an oncoming bus drives through ("sweep"),
//  - the fairness DP (./fairness.ts) must find a survivable path from the previous rows that never
//    needs a reaction faster than MIN_REACTION_TIME at the planned speed.
// Only then is it committed to the plan queue (sorted by the player s at which each entity spawns).
// All spacing is expressed in seconds and converted with the speed the player will have there, so
// the reaction budget is the same at 13 m/s and at 30 m/s.
import {
  BOOST_Y,
  CHAIN_MAX_GAP,
  COIN_SPACING,
  GRAVITY,
  JUMP_VELOCITY,
  LANES,
  OBSTACLE_DIMS,
  ONCOMING_SPEED,
  POWERUP_GAP_MAX,
  POWERUP_GAP_MIN,
  ROOF_Y,
  SPAWN_AHEAD,
  START_SAFE_DISTANCE,
  TIER_DISTANCES,
  laneX,
  speedAtDistance,
} from './config';
import { EntityPool, type SimEntity, isObstacleKind, rampTop } from './entity';
import { type FairState, advanceRow, buildIntervals, buildRows, freshFairState } from './fairness';
import type { Rng } from './rng';
import type { EntityKind, Lane, ObstacleKind, PowerupKind } from './types';

/** Plan this far beyond the spawn window (so oncoming buses can be scheduled in time). */
const PLAN_BEYOND = 70;

/** Seconds between patterns, per tier [min, max]. */
const TIER_GAP: readonly (readonly [number, number])[] = [
  [1.9, 2.5],
  [1.3, 1.8],
  [1.0, 1.4],
  [0.85, 1.15],
  [0.75, 1.0],
];
/** Seconds between rows inside a pattern, per tier (always >= 0.8: two lane changes + reaction). */
const ROW_GAP: readonly number[] = [1.1, 1.05, 0.95, 0.86, 0.8];

export function tierAt(s: number): number {
  let t = 0;
  for (let i = 0; i < TIER_DISTANCES.length; i++) if (s >= TIER_DISTANCES[i]) t = i;
  return t;
}

interface Sweep {
  lane: Lane;
  a: number;
  b: number;
}

interface Zone {
  a: number;
  b: number;
}

type PatternFn = (b: PatternBuilder) => void;

interface PatternDef {
  name: string;
  /** Selection weight per tier (0 = never). */
  weight: readonly number[];
  build: PatternFn;
}

const H: ObstacleKind = 'hurdle';
const O: ObstacleKind = 'overhead';
const B: ObstacleKind = 'blocker';

function otherLanes(l: Lane, out: Lane[]): Lane[] {
  out.length = 0;
  for (const x of LANES) if (x !== l) out.push(x);
  return out;
}

const tmpLanes: Lane[] = [];

/** Helper the patterns write through. Lanes given to it are logical; mirroring is applied here. */
export class PatternBuilder {
  s0 = 0;
  v = 13;
  tier = 0;
  mirror = false;
  end = 0;
  failed = false;
  readonly staged: SimEntity[] = [];
  readonly stagedSweeps: Sweep[] = [];
  /** Set when the pattern placed the due power-up itself (e.g. on a roof); applied on commit. */
  placedPowerup: PowerupKind | null = null;
  placedPowerupS = 0;

  constructor(
    readonly g: TrackGenerator,
    readonly rng: Rng,
  ) {}

  begin(s0: number, v: number, tier: number, mirror: boolean): void {
    this.s0 = s0;
    this.v = v;
    this.tier = tier;
    this.mirror = mirror;
    this.end = s0;
    this.failed = false;
    this.staged.length = 0;
    this.stagedSweeps.length = 0;
    this.placedPowerup = null;
  }

  /** Seconds -> metres at this pattern's speed. */
  t(sec: number): number {
    return sec * this.v;
  }

  rowGap(): number {
    return this.t(ROW_GAP[this.tier]);
  }

  lane(): Lane {
    return this.rng.pick(LANES);
  }

  /** A random lane adjacent to `l`. */
  adjacent(l: Lane): Lane {
    if (l === 0) return this.rng.chance(0.5) ? -1 : 1;
    return 0;
  }

  private map(l: Lane): Lane {
    return (this.mirror ? -l : l) as Lane;
  }

  /** Places an obstacle with its near edge at `near`. */
  ob(kind: ObstacleKind, lane: Lane, near: number, chain = 0): SimEntity {
    const len = OBSTACLE_DIMS[kind].len;
    const ml = this.map(lane);
    const e = this.g.pool.acquire(kind, ml, near + len / 2, 0);
    e.chain = chain;
    if (this.g.sweepConflict(ml, near - 0.5, near + len + 0.5, this.stagedSweeps)) this.failed = true;
    this.staged.push(e);
    this.end = Math.max(this.end, near + len);
    return e;
  }

  /** A roof chain in one lane: optional ramp, then vehicles end to end. Returns the far edge. */
  chain(lane: Lane, near: number, kinds: readonly ('truck' | 'bus')[], ramp: boolean): number {
    const id = this.g.nextChainId++;
    let s = near;
    if (ramp) {
      this.ob('ramp', lane, s, id);
      s += OBSTACLE_DIMS.ramp.len;
    }
    for (let i = 0; i < kinds.length; i++) {
      this.ob(kinds[i], lane, s, id);
      s += OBSTACLE_DIMS[kinds[i]].len;
      if (i < kinds.length - 1) s += this.rng.range(0.25, CHAIN_MAX_GAP * 0.75);
    }
    return s;
  }

  /** An oncoming bus whose near edge meets the player at `meetS`. Returns the end of its player-s footprint. */
  oncoming(lane: Lane, meetS: number): number {
    const ml = this.map(lane);
    const e = this.g.pool.acquire('busOncoming', ml, meetS, 0);
    e.meetS = meetS;
    e.vs = -ONCOMING_SPEED;
    const v = speedAtDistance(meetS);
    const lead = (ONCOMING_SPEED * SPAWN_AHEAD) / (v + ONCOMING_SPEED);
    const sweep: Sweep = { lane: ml, a: meetS - 2, b: meetS + lead + e.len + 1 };
    if (this.g.sweepConflict(ml, sweep.a, sweep.b, null) || this.stagedConflict(ml, sweep.a, sweep.b)) this.failed = true;
    this.stagedSweeps.push(sweep);
    this.staged.push(e);
    const effEnd = meetS + (e.len * v) / (v + ONCOMING_SPEED);
    this.end = Math.max(this.end, effEnd);
    return effEnd;
  }

  private stagedConflict(lane: Lane, a: number, b: number): boolean {
    for (const e of this.staged) {
      if (e.lane === lane && e.kind !== 'busOncoming' && e.s + e.len / 2 > a && e.s - e.len / 2 < b) return true;
    }
    return false;
  }

  /** Height of the staged surface (ramp/roof) at s in a mapped lane, or -1 if none. */
  private surfaceAt(ml: Lane, s: number): number {
    let best = -1;
    for (const e of this.staged) {
      if (e.lane !== ml || !isObstacleKind(e.kind) || !OBSTACLE_DIMS[e.kind].walkable || e.kind === 'busOncoming') continue;
      const half = e.len / 2;
      if (s < e.s - half - CHAIN_MAX_GAP || s > e.s + half + CHAIN_MAX_GAP) continue;
      if (e.kind === 'ramp') {
        if (s >= e.s - half && s <= e.s + half) best = Math.max(best, rampTop(e, s));
      } else {
        best = Math.max(best, ROOF_Y);
      }
    }
    return best;
  }

  private coinBlocked(ml: Lane, s: number, y: number): boolean {
    for (const e of this.staged) {
      if (e.lane !== ml || !isObstacleKind(e.kind) || e.kind === 'busOncoming') continue;
      if (Math.abs(s - e.s) > e.len / 2 + 0.5) continue;
      const d = OBSTACLE_DIMS[e.kind];
      if (e.kind === 'ramp') {
        if (y < rampTop(e, s) - 0.05) return true;
      } else if (e.kind === 'overhead') {
        if (y > 0.05 && y < d.h) return true;
      } else if (y < d.h - 0.05) return true;
    }
    if (y < 4 && this.g.sweepConflict(ml, s - 0.5, s + 0.5, this.stagedSweeps)) return true;
    return false;
  }

  coin(lane: Lane, s: number, y = 0): void {
    const ml = this.map(lane);
    if (this.coinBlocked(ml, s, y)) return;
    this.staged.push(this.g.pool.acquire('coin', ml, s, y));
    this.end = Math.max(this.end, s + 0.5);
  }

  coinLine(lane: Lane, s: number, n: number, spacing = COIN_SPACING, y = 0): void {
    for (let i = 0; i < n; i++) this.coin(lane, s + i * spacing, y);
  }

  /** Coins along the jump parabola over an obstacle centred at `centre` (apex above it). */
  coinArc(lane: Lane, centre: number, baseY = 0): void {
    const tApex = JUMP_VELOCITY / GRAVITY;
    const air = 2 * tApex;
    const take = centre - this.v * tApex;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const t = (air * (i + 0.5)) / n;
      const y = baseY + JUMP_VELOCITY * t - 0.5 * GRAVITY * t * t;
      this.coin(lane, take + this.v * t, Math.max(baseY, y));
    }
  }

  /** Coins following the ramp/roof surface of a staged chain in `lane` from s0 to s1. */
  roofCoins(lane: Lane, s0: number, s1: number): void {
    const ml = this.map(lane);
    for (let s = s0; s <= s1; s += COIN_SPACING) {
      const y = this.surfaceAt(ml, s);
      if (y >= 0) this.staged.push(this.g.pool.acquire('coin', ml, s, y));
    }
  }

  powerup(lane: Lane, s: number, y = 0): void {
    const ml = this.map(lane);
    if (y < 4 && this.g.sweepConflict(ml, s - 1, s + 1, this.stagedSweeps)) return;
    const kind = this.g.choosePowerup();
    this.staged.push(this.g.pool.acquire(kind, ml, s, y));
    this.placedPowerup = kind;
    this.placedPowerupS = s;
  }
}

// ------------------------------------------------------------------------------------- patterns

const PATTERNS: readonly PatternDef[] = [
  {
    name: 'single',
    weight: [10, 2.5, 1, 0.5, 0.3],
    build(b) {
      const lane = b.lane();
      const kind = b.rng.pick([H, O, B]);
      const e = b.ob(kind, lane, b.s0);
      if (kind === H) b.coinArc(lane, e.s);
      else if (kind === O) b.coinLine(lane, e.s - 2 * COIN_SPACING, 5);
      else b.coinLine(b.adjacent(lane), b.s0 - 4, 5);
    },
  },
  {
    name: 'pair',
    weight: [0, 5, 4, 3, 2],
    build(b) {
      const free = b.lane();
      for (const l of otherLanes(free, tmpLanes)) {
        const r = b.rng.next();
        if (b.tier >= 3 && r < 0.25) b.chain(l, b.s0, ['truck'], false);
        else b.ob(r < 0.45 ? B : r < 0.72 ? H : O, l, b.s0);
      }
      b.coinLine(free, b.s0 - 2 * COIN_SPACING, 6);
    },
  },
  {
    name: 'hurdleRow',
    weight: [0, 3, 2, 1.5, 1],
    build(b) {
      for (const l of LANES) b.ob(H, l, b.s0);
      b.coinArc(b.lane(), b.s0 + OBSTACLE_DIMS.hurdle.len / 2);
    },
  },
  {
    name: 'overheadRow',
    weight: [0, 3, 2, 1.5, 1],
    build(b) {
      for (const l of LANES) b.ob(O, l, b.s0);
      b.coinLine(b.lane(), b.s0 - 2 * COIN_SPACING, 5);
    },
  },
  {
    name: 'jumpRoll',
    weight: [0, 0, 3, 3, 3],
    build(b) {
      const rows = b.tier >= 3 ? 3 : 2;
      let s = b.s0;
      for (let r = 0; r < rows; r++) {
        const kind: ObstacleKind = r % 2 === 0 ? H : O;
        const blockLane = b.rng.chance(0.5) ? b.lane() : 9;
        let coinLane: Lane = 0;
        for (const l of LANES) {
          if (l === blockLane) b.ob(B, l, s);
          else {
            b.ob(kind, l, s);
            coinLane = l;
          }
        }
        const len = OBSTACLE_DIMS[kind].len;
        if (kind === H) b.coinArc(coinLane, s + len / 2);
        else b.coinLine(coinLane, s - COIN_SPACING, 3);
        s += Math.max(len, blockLane !== 9 ? OBSTACLE_DIMS.blocker.len : 0) + b.rowGap();
      }
    },
  },
  {
    name: 'slalom',
    weight: [0, 1.5, 3, 3, 3],
    build(b) {
      const rows = b.tier >= 3 ? 4 : 3;
      let free = b.lane();
      let s = b.s0;
      for (let r = 0; r < rows; r++) {
        let rowLen = OBSTACLE_DIMS.blocker.len;
        for (const l of otherLanes(free, tmpLanes)) {
          if (b.tier >= 3 && b.rng.chance(0.3)) {
            b.chain(l, s, ['truck'], false);
            rowLen = Math.max(rowLen, OBSTACLE_DIMS.truck.len);
          } else b.ob(B, l, s);
        }
        b.coinLine(free, s - COIN_SPACING, Math.max(2, Math.round(rowLen / COIN_SPACING) + 2));
        s += rowLen + b.rowGap();
        free = b.adjacent(free);
      }
    },
  },
  {
    name: 'vehicleSlalom',
    weight: [0, 0, 2, 3, 3],
    build(b) {
      const rows = b.tier >= 4 ? 3 : 2;
      let free = b.lane();
      let s = b.s0;
      for (let r = 0; r < rows; r++) {
        let far = s;
        const lanes = otherLanes(free, tmpLanes);
        const rampLane = b.rng.chance(0.35) ? b.rng.pick(lanes) : 9;
        for (const l of lanes) {
          const kinds: ('truck' | 'bus')[] = b.rng.chance(0.5) ? ['bus'] : ['truck'];
          const end = b.chain(l, s, kinds, l === rampLane);
          if (l === rampLane) b.roofCoins(l, s + 1, end - 1);
          far = Math.max(far, end);
        }
        b.coinLine(free, s, Math.max(3, Math.floor((far - s) / COIN_SPACING)));
        s = far + b.t(ROW_GAP[b.tier] + (rampLane !== 9 ? 0.45 : 0));
        free = b.adjacent(free);
      }
    },
  },
  {
    name: 'corridor',
    weight: [0, 1.5, 3, 3, 3],
    build(b) {
      const free = b.lane();
      const lanes = otherLanes(free, tmpLanes);
      const rampLane = b.tier >= 2 && b.rng.chance(0.4) ? b.rng.pick(lanes) : 9;
      let far = b.s0;
      for (const l of lanes) {
        const r = b.rng.next();
        const kinds: ('truck' | 'bus')[] = r < 0.33 ? ['bus', 'truck'] : r < 0.66 ? ['truck', 'bus'] : ['bus', 'bus'];
        const end = b.chain(l, b.s0, kinds, l === rampLane);
        if (l === rampLane) b.roofCoins(l, b.s0 + 1, end - 1);
        far = Math.max(far, end);
      }
      const len = far - b.s0;
      if (b.tier >= 3 && b.rng.chance(0.6)) {
        const kind = b.rng.chance(0.5) ? H : O;
        const at = b.s0 + len * b.rng.range(0.4, 0.6);
        const e = b.ob(kind, free, at);
        if (kind === H) {
          b.coinLine(free, b.s0, Math.max(1, Math.floor((at - b.s0 - b.v * 0.4) / COIN_SPACING)));
          b.coinArc(free, e.s);
        } else b.coinLine(free, b.s0, Math.floor(len / COIN_SPACING));
      } else {
        b.coinLine(free, b.s0, Math.floor(len / COIN_SPACING));
      }
      if (rampLane !== 9) b.end += b.t(0.45);
    },
  },
  {
    name: 'rampRun',
    weight: [0, 2.5, 3, 3, 3],
    build(b) {
      const lane = b.lane();
      const r = b.rng.next();
      const kinds: ('truck' | 'bus')[] = r < 0.3 ? ['bus'] : r < 0.55 ? ['truck', 'truck'] : r < 0.8 ? ['truck', 'bus'] : ['bus', 'truck'];
      const end = b.chain(lane, b.s0, kinds, true);
      b.roofCoins(lane, b.s0 + 1, end - 1);
      if (b.g.powerupDue(b.s0) && b.tier >= 1) b.powerup(lane, b.s0 + (end - b.s0) * 0.7, ROOF_Y);
      const forced = b.tier >= 3 && b.rng.chance(0.5);
      for (const l of otherLanes(lane, tmpLanes)) {
        if (forced) {
          b.chain(l, b.s0 + b.rng.range(1, 4), b.rng.chance(0.5) ? ['bus'] : ['truck', 'truck'], false);
        } else if (b.rng.chance(0.4)) {
          b.ob(b.rng.pick([H, O, B]), l, b.s0 + b.rng.range(4, 9));
        }
      }
      b.end = Math.max(b.end, end) + b.t(0.45);
    },
  },
  {
    name: 'roofHop',
    weight: [0, 0, 0, 2.5, 3],
    build(b) {
      const a = b.lane();
      const c = b.adjacent(a);
      const endA = b.chain(a, b.s0, ['truck', 'truck'], true);
      const startC = b.s0 + OBSTACLE_DIMS.ramp.len + 3;
      const endC = b.chain(c, startC, ['bus', 'truck'], false);
      b.roofCoins(a, b.s0 + 1, endA - 3);
      b.roofCoins(c, endA - 1, endC - 1);
      // Third lane: open road with a light hazard so the roof route is the attractive one.
      for (const l of LANES) {
        if (l === a || l === c) continue;
        if (b.rng.chance(0.5)) b.ob(b.rng.pick([H, O]), l, b.s0 + b.rng.range(8, 14));
      }
      b.end = Math.max(endA, endC) + b.t(0.45);
    },
  },
  {
    name: 'oncoming',
    weight: [0, 0, 2, 3, 3],
    build(b) {
      const lane = b.lane();
      const meet = b.s0;
      const eff = b.oncoming(lane, meet);
      const coinLane = b.adjacent(lane);
      b.coinLine(coinLane, meet - 6, 6);
      if (b.tier >= 3 && b.rng.chance(0.55)) {
        const l2 = b.rng.pick(otherLanes(lane, tmpLanes));
        b.oncoming(l2, eff + b.rowGap());
      }
    },
  },
  {
    name: 'hurdleRhythm',
    weight: [0, 2, 2, 2, 2],
    build(b) {
      const lane = b.lane();
      const n = 3;
      const step = b.t(1.05);
      for (let i = 0; i < n; i++) {
        const e = b.ob(H, lane, b.s0 + i * step);
        b.coinArc(lane, e.s);
      }
      const len = (n - 1) * step + OBSTACLE_DIMS.hurdle.len;
      if (b.tier >= 3) {
        for (const l of otherLanes(lane, tmpLanes)) {
          if (b.rng.chance(0.6)) b.chain(l, b.s0 - 1, len > 16 ? ['bus', 'truck'] : ['bus'], false);
        }
      }
    },
  },
  {
    name: 'gauntlet',
    weight: [0, 0, 0, 3, 4],
    build(b) {
      const rows = b.tier >= 4 ? 4 : 3;
      let s = b.s0;
      const kinds: ObstacleKind[] = [H, O, B];
      for (let r = 0; r < rows; r++) {
        // Random permutation of hurdle / overhead / blocker across the lanes.
        for (let i = 2; i > 0; i--) {
          const j = b.rng.int(i + 1);
          const t = kinds[i];
          kinds[i] = kinds[j];
          kinds[j] = t;
        }
        for (let i = 0; i < 3; i++) {
          const e = b.ob(kinds[i], LANES[i], s);
          if (kinds[i] === H && b.rng.chance(0.6)) b.coinArc(LANES[i], e.s);
        }
        s += OBSTACLE_DIMS.blocker.len + b.t(Math.max(0.85, ROW_GAP[b.tier]));
      }
    },
  },
  {
    name: 'oncomingCorridor',
    weight: [0, 0, 0, 2, 3],
    build(b) {
      const parked = b.lane();
      const lanes = otherLanes(parked, tmpLanes);
      const onc = b.rng.pick(lanes);
      const free = lanes[0] === onc ? lanes[1] : lanes[0];
      const end = b.chain(parked, b.s0, b.rng.chance(0.5) ? ['bus', 'truck'] : ['truck', 'bus'], false);
      b.oncoming(onc, b.s0 + b.rng.range(2, 6));
      b.coinLine(free, b.s0, Math.floor((end - b.s0) / COIN_SPACING));
    },
  },
];

const PATTERN_INDEX: Record<string, number> = {};
PATTERNS.forEach((p, i) => (PATTERN_INDEX[p.name] = i));
export const PATTERN_NAMES: readonly string[] = PATTERNS.map((p) => p.name);

// ------------------------------------------------------------------------------------- generator

export class TrackGenerator {
  readonly pool: EntityPool;
  rng: Rng;
  nextChainId = 1;
  /** Planned entities sorted by `trigger` (player s at which they spawn); [head..] are pending. */
  private planned: SimEntity[] = [];
  private head = 0;
  private cursor = START_SAFE_DISTANCE;
  private fair: FairState = freshFairState();
  private fairTmp: FairState = freshFairState();
  private sweeps: Sweep[] = [];
  private zones: Zone[] = [];
  private builder: PatternBuilder;
  private recent: number[] = [-1, -1];
  private patternsSinceRest = 0;
  private restEvery = 6;
  private nextPowerupS = 0;
  private lastPowerup: PowerupKind | null = null;
  private weights: number[] = [];
  /** Optional hook (tests): called for every committed entity, with the pattern name. */
  onCommit: ((e: SimEntity, pattern: string) => void) | null = null;
  /** Count of patterns used per name (stats / tests). */
  readonly usage: Record<string, number> = {};

  constructor(pool: EntityPool, rng: Rng) {
    this.pool = pool;
    this.rng = rng;
    this.builder = new PatternBuilder(this, rng);
    this.reset(rng);
  }

  reset(rng: Rng): void {
    this.rng = rng;
    this.builder = new PatternBuilder(this, rng);
    for (let i = this.head; i < this.planned.length; i++) this.pool.release(this.planned[i]);
    this.planned.length = 0;
    this.head = 0;
    this.cursor = START_SAFE_DISTANCE;
    this.fair = freshFairState();
    this.sweeps.length = 0;
    this.zones.length = 0;
    this.recent[0] = this.recent[1] = -1;
    this.patternsSinceRest = 0;
    this.restEvery = 5 + this.rng.int(3);
    this.nextPowerupS = this.rng.range(POWERUP_GAP_MIN * 0.8, POWERUP_GAP_MAX * 0.8);
    this.lastPowerup = null;
    this.nextChainId = 1;
    for (const k of PATTERN_NAMES) this.usage[k] = 0;
    // A short welcome coin line just before the first obstacles.
    for (let s = 34; s < START_SAFE_DISTANCE - 4; s += COIN_SPACING) this.commit(this.pool.acquire('coin', 0, s, 0), 'intro');
  }

  get plannedCount(): number {
    return this.planned.length - this.head;
  }

  /** Spawns every planned entity whose trigger is reached and keeps the plan ahead of the player. */
  update(playerS: number, playerSpeed: number, spawn: (e: SimEntity) => void): void {
    while (this.cursor < playerS + SPAWN_AHEAD + PLAN_BEYOND) this.planNext();
    const v = Math.max(1, playerSpeed);
    while (this.head < this.planned.length && this.planned[this.head].trigger <= playerS) {
      const e = this.planned[this.head++];
      if (e.kind === 'busOncoming') {
        // Place the bus so that it meets the player exactly at meetS at the current speed.
        let near = e.meetS + (ONCOMING_SPEED * Math.max(0, e.meetS - playerS)) / v;
        near = Math.min(near, playerS + SPAWN_AHEAD);
        e.s = near + e.len / 2;
        e.prevS = e.s;
        e.vs = -ONCOMING_SPEED;
      }
      spawn(e);
    }
    if (this.head > 256) {
      this.planned.copyWithin(0, this.head);
      this.planned.length -= this.head;
      this.head = 0;
    }
    // Forget sweeps and zones far behind.
    let w = 0;
    for (let i = 0; i < this.sweeps.length; i++) if (this.sweeps[i].b > playerS - 50) this.sweeps[w++] = this.sweeps[i];
    this.sweeps.length = w;
    w = 0;
    for (let i = 0; i < this.zones.length; i++) if (this.zones[i].b > playerS - 50) this.zones[w++] = this.zones[i];
    this.zones.length = w;
  }

  // --------------------------------------------------------------- queries used by patterns

  sweepConflict(lane: Lane, a: number, b: number, extra: readonly Sweep[] | null): boolean {
    for (const sw of this.sweeps) if (sw.lane === lane && b > sw.a && a < sw.b) return true;
    if (extra) for (const sw of extra) if (sw.lane === lane && b > sw.a && a < sw.b) return true;
    return false;
  }

  /** A power-up is due a little before its nominal spot (patterns can be long; this keeps gaps ~150-250 m). */
  powerupDue(s: number): boolean {
    return s >= this.nextPowerupS - 30;
  }

  choosePowerup(): PowerupKind {
    const kinds: readonly PowerupKind[] = ['magnet', 'multiplier', 'shield', 'boost'];
    const w = [3, 3, 2.5, 1.8];
    let total = 0;
    for (let i = 0; i < 4; i++) if (kinds[i] !== this.lastPowerup) total += w[i];
    let r = this.rng.next() * total;
    for (let i = 0; i < 4; i++) {
      if (kinds[i] === this.lastPowerup) continue;
      r -= w[i];
      if (r <= 0) return kinds[i];
    }
    return kinds[0] === this.lastPowerup ? kinds[1] : kinds[0];
  }

  notePowerupPlaced(kind: PowerupKind, s: number): void {
    this.lastPowerup = kind;
    this.nextPowerupS = s + this.rng.range(POWERUP_GAP_MIN + 10, POWERUP_GAP_MAX - 10);
  }

  // --------------------------------------------------------------- boost support

  /**
   * Guarantees an obstacle-free stretch [a, b] (boost landing): removes live and planned obstacles
   * touching it (whole roof chains), and keeps future patterns out of it.
   */
  clearRange(a: number, b: number, live: SimEntity[]): void {
    const chains = new Set<number>();
    const touches = (e: SimEntity): boolean => {
      if (!isObstacleKind(e.kind)) return false;
      if (e.kind === 'busOncoming') return e.meetS > a - 15 && e.meetS < b;
      return e.s + e.len / 2 > a && e.s - e.len / 2 < b;
    };
    for (const e of live) if (e.active && touches(e) && e.chain) chains.add(e.chain);
    for (let i = this.head; i < this.planned.length; i++) if (touches(this.planned[i]) && this.planned[i].chain) chains.add(this.planned[i].chain);
    for (const e of live) {
      if (e.active && isObstacleKind(e.kind) && (touches(e) || (e.chain && chains.has(e.chain)))) e.active = false;
    }
    let w = this.head;
    for (let i = this.head; i < this.planned.length; i++) {
      const e = this.planned[i];
      if (isObstacleKind(e.kind) && (touches(e) || (e.chain && chains.has(e.chain)))) this.pool.release(e);
      else this.planned[w++] = e;
    }
    this.planned.length = w;
    this.zones.push({ a, b });
    if (this.cursor > a - 60 && this.cursor < b) {
      this.cursor = b;
      this.fair = freshFairState(b);
    }
  }

  /** Coin lines at flight height between s0 and s1, starting in `lane`. */
  planAirCoins(s0: number, s1: number, lane: Lane): void {
    let l = lane;
    let s = s0;
    while (s < s1) {
      const segEnd = Math.min(s1, s + this.rng.range(24, 40));
      for (; s < segEnd; s += 3) this.commit(this.pool.acquire('coin', l, s, BOOST_Y), 'air');
      const next = l === 0 ? (this.rng.chance(0.5) ? -1 : 1) : this.rng.chance(0.7) ? 0 : l;
      if (next !== l) s += 6;
      l = next as Lane;
    }
  }

  // --------------------------------------------------------------- planning

  private planNext(): void {
    for (const z of this.zones) {
      if (this.cursor > z.a - 60 && this.cursor < z.b) {
        this.cursor = z.b;
        this.fair = freshFairState(z.b);
      }
    }
    const s0 = this.cursor;
    const v = speedAtDistance(s0);
    const tier = tierAt(s0);

    if (this.powerupDue(s0) && tier >= 0) {
      this.placePowerupGap(s0, v);
      return;
    }
    if (this.patternsSinceRest >= this.restEvery && tier >= 1) {
      this.placeRest(s0, v);
      return;
    }

    const b = this.builder;
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = this.choosePattern(tier, attempt);
      b.begin(s0, v, tier, this.rng.chance(0.5));
      PATTERNS[id].build(b);
      if (!b.failed && this.fairCheck(b.staged)) {
        for (const e of b.staged) this.commit(e, PATTERNS[id].name);
        for (const sw of b.stagedSweeps) this.sweeps.push(sw);
        b.staged.length = 0;
        if (b.placedPowerup) this.notePowerupPlaced(b.placedPowerup, b.placedPowerupS);
        this.usage[PATTERNS[id].name]++;
        this.recent[1] = this.recent[0];
        this.recent[0] = id;
        this.patternsSinceRest++;
        const g = TIER_GAP[tier];
        this.cursor = b.end + speedAtDistance(b.end) * this.rng.range(g[0], g[1]);
        return;
      }
      for (const e of b.staged) this.pool.release(e);
      b.staged.length = 0;
    }
    // Nothing fits here (usually an oncoming bus sweeping this stretch): leave a short gap.
    this.cursor += v * 0.5;
  }

  private choosePattern(tier: number, attempt: number): number {
    const w = this.weights;
    w.length = PATTERNS.length;
    let total = 0;
    for (let i = 0; i < PATTERNS.length; i++) {
      let x = PATTERNS[i].weight[tier] ?? 0;
      if (i === this.recent[0]) x = 0;
      else if (i === this.recent[1]) x *= 0.35;
      if (attempt >= 5 && PATTERNS[i].name !== 'single' && PATTERNS[i].name !== 'pair') x *= 0.2;
      w[i] = x;
      total += x;
    }
    if (total <= 0) return PATTERN_INDEX.single;
    let r = this.rng.next() * total;
    for (let i = 0; i < w.length; i++) {
      r -= w[i];
      if (r <= 0 && w[i] > 0) return i;
    }
    return PATTERN_INDEX.single;
  }

  private fairCheck(staged: readonly SimEntity[]): boolean {
    const rows = buildRows(buildIntervals(staged));
    const st = this.fairTmp;
    st.end = this.fair.end;
    st.st[0] = this.fair.st[0];
    st.st[1] = this.fair.st[1];
    st.st[2] = this.fair.st[2];
    for (const r of rows) if (!advanceRow(st, r)) return false;
    this.fair.end = st.end;
    this.fair.st[0] = st.st[0];
    this.fair.st[1] = st.st[1];
    this.fair.st[2] = st.st[2];
    return true;
  }

  /** A calm stretch holding a power-up (reachable from any lane, in a lane no bus sweeps). */
  private placePowerupGap(s0: number, v: number): void {
    const s = s0 + v * 0.25;
    let lane = this.rng.pick(LANES);
    for (let i = 0; i < 3 && this.sweepConflict(lane, s - 8, s + 2, null); i++) lane = (((lane + 2) % 3) - 1) as Lane;
    if (!this.sweepConflict(lane, s - 8, s + 2, null)) {
      const b = this.builder;
      b.begin(s0, v, tierAt(s0), false);
      b.coinLine(lane, s - 3 * COIN_SPACING, 3);
      b.powerup(lane, s);
      for (const e of b.staged) this.commit(e, 'powerup');
      b.staged.length = 0;
      if (b.placedPowerup) this.notePowerupPlaced(b.placedPowerup, b.placedPowerupS);
    } else {
      this.nextPowerupS = s0 + 20;
    }
    this.cursor = s + v * 1.0;
  }

  /** Breathing gap: a coin snake across the lanes, no obstacles. */
  private placeRest(s0: number, v: number): void {
    this.patternsSinceRest = 0;
    this.restEvery = 6 + this.rng.int(3);
    const len = v * this.rng.range(1.9, 2.6);
    const b = this.builder;
    b.begin(s0, v, tierAt(s0), false);
    let lane = this.rng.pick(LANES);
    let s = s0 + v * 0.3;
    while (s < s0 + len - v * 0.4) {
      b.coinLine(lane, s, 4);
      s += 4 * COIN_SPACING + v * 0.35;
      lane = b.adjacent(lane);
    }
    for (const e of b.staged) this.commit(e, 'rest');
    b.staged.length = 0;
    this.cursor = Math.max(s0 + len, b.end + v * 0.3);
  }

  private commit(e: SimEntity, pattern: string): void {
    if (e.kind === 'busOncoming') {
      let v = speedAtDistance(e.meetS - 100);
      let trig = e.meetS - (v * SPAWN_AHEAD) / (v + ONCOMING_SPEED);
      v = speedAtDistance(trig);
      trig = e.meetS - (v * SPAWN_AHEAD) / (v + ONCOMING_SPEED);
      e.trigger = trig;
    } else {
      e.trigger = e.s - e.len / 2 - SPAWN_AHEAD;
    }
    e.x = laneX(e.lane);
    e.variant = this.rng.int(8);
    this.onCommit?.(e, pattern);
    // Insertion into the sorted pending part of the queue (no allocation).
    const q = this.planned;
    q.push(e);
    let i = q.length - 1;
    while (i > this.head && q[i - 1].trigger > e.trigger) {
      q[i] = q[i - 1];
      i--;
    }
    q[i] = e;
  }
}

export type { EntityKind };
