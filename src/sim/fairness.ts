// Fairness checker: an abstract "is there a survivable path that never needs a reaction faster than
// MIN_REACTION_TIME?" test over planned obstacles. Used by the generator at plan time (every pattern
// must pass before it is committed) and by the tests over whole runs.
//
// Model (conservative on purpose):
// - Each obstacle becomes a lane interval in *player-s* coordinates, widened by half the player depth.
//   An oncoming bus is static in player-s: it occupies [meetS, meetS + len * v / (v + ONCOMING_SPEED)].
//   A roof chain (ramp + vehicles touching end to end) is one interval, passable ('climb') only when
//   the chain starts with a ramp; vehicles without a ramp block their lane.
// - Overlapping intervals (across lanes) merge into rows. Inside a row each lane has one status:
//   free, jump (hurdles), roll (overheads), climb, or block (anything else / mixed requirements).
// - Between two rows the player may change lanes. Moving or acting needs
//   MIN_REACTION_TIME + LANE_CHANGE_TIME per lane of the gap time; jump -> jump needs 0.75 s
//   (land and take off again); leaving a roof chain adds 0.4 s (fall + blind transition).
import { LANE_CHANGE_TIME, MIN_REACTION_TIME, OBSTACLE_DIMS, ONCOMING_SPEED, PLAYER, speedAtDistance } from './config';
import type { Lane, ObstacleKind } from './types';

export const ST_FREE = 0;
export const ST_JUMP = 1;
export const ST_ROLL = 2;
export const ST_CLIMB = 3;
export const ST_BLOCK = 4;
const UNREACHABLE = -1;

/** Rows closer than this (m) merge. */
export const ROW_PAD = 0.5;
const HALF_DEPTH = PLAYER.depth / 2;

export interface PlanItem {
  kind: ObstacleKind | string;
  lane: Lane;
  /** Centre along the track (static entities). */
  s: number;
  len: number;
  /** busOncoming: planned meeting s. */
  meetS: number;
  /** Roof chain id (0 = none). */
  chain: number;
}

export interface Interval {
  lane: Lane;
  a: number;
  b: number;
  st: number;
}

export interface Row {
  a: number;
  b: number;
  st: [number, number, number];
}

export interface FairState {
  /** End s of the last row. */
  end: number;
  /** Status in the last row per lane index (lane + 1), or -1 when that lane was not reachable. */
  st: [number, number, number];
}

export function freshFairState(end = -Infinity): FairState {
  return { end, st: [ST_FREE, ST_FREE, ST_FREE] };
}

function obstacleStatus(kind: string): number {
  if (kind === 'hurdle') return ST_JUMP;
  if (kind === 'overhead') return ST_ROLL;
  if (kind === 'ramp') return ST_CLIMB;
  return ST_BLOCK;
}

/** Converts plan items to lane intervals (sorted by a). Pickups are ignored. */
export function buildIntervals(items: readonly PlanItem[]): Interval[] {
  const out: Interval[] = [];
  const chains = new Map<number, Interval & { rampA: number }>();
  for (const it of items) {
    if (!(it.kind in OBSTACLE_DIMS)) continue;
    if (it.kind === 'busOncoming') {
      const v = speedAtDistance(it.meetS);
      const eff = (it.len * v) / (v + ONCOMING_SPEED);
      out.push({ lane: it.lane, a: it.meetS - HALF_DEPTH, b: it.meetS + eff + HALF_DEPTH, st: ST_BLOCK });
      continue;
    }
    const a = it.s - it.len / 2 - HALF_DEPTH;
    const b = it.s + it.len / 2 + HALF_DEPTH;
    if (it.chain > 0) {
      let c = chains.get(it.chain);
      if (!c) {
        c = { lane: it.lane, a, b, st: ST_BLOCK, rampA: Infinity };
        chains.set(it.chain, c);
      }
      c.a = Math.min(c.a, a);
      c.b = Math.max(c.b, b);
      if (it.kind === 'ramp') c.rampA = Math.min(c.rampA, a);
      continue;
    }
    out.push({ lane: it.lane, a, b, st: obstacleStatus(it.kind) });
  }
  for (const c of chains.values()) {
    out.push({ lane: c.lane, a: c.a, b: c.b, st: c.rampA <= c.a + 1e-6 ? ST_CLIMB : ST_BLOCK });
  }
  out.sort((p, q) => p.a - q.a);
  return out;
}

function combine(x: number, y: number): number {
  if (x === ST_FREE) return y;
  if (y === ST_FREE) return x;
  if (x === y && x !== ST_CLIMB) return x;
  return ST_BLOCK;
}

/** Merges intervals (sorted by a) into rows. */
export function buildRows(intervals: readonly Interval[]): Row[] {
  const rows: Row[] = [];
  let cur: Row | null = null;
  for (const iv of intervals) {
    if (!cur || iv.a > cur.b + ROW_PAD) {
      cur = { a: iv.a, b: iv.b, st: [ST_FREE, ST_FREE, ST_FREE] };
      rows.push(cur);
    } else {
      cur.b = Math.max(cur.b, iv.b);
    }
    const li = iv.lane + 1;
    let st = iv.st;
    // A roof chain is only enterable at its ramp, i.e. at the very start of the row.
    if (st === ST_CLIMB && iv.a > cur.a + ROW_PAD) st = ST_BLOCK;
    cur.st[li] = combine(cur.st[li], st);
  }
  return rows;
}

function need(prevLane: number, prevSt: number, lane: number, st: number): number {
  const d = Math.abs(lane - prevLane);
  let n = 0;
  if (d > 0) n = MIN_REACTION_TIME + d * LANE_CHANGE_TIME;
  else if (st !== ST_FREE) n = MIN_REACTION_TIME;
  if (prevSt === ST_JUMP && st === ST_JUMP) n = Math.max(n, 0.75);
  if (prevSt === ST_CLIMB) n += 0.4;
  return n;
}

/**
 * Advances the DP state over one row. Returns false (state untouched) when no lane is reachable.
 * `slack` (optional out) receives the smallest positive time margin of the best path into the row.
 */
export function advanceRow(state: FairState, row: Row, scratch: [number, number, number] = [0, 0, 0]): boolean {
  const v = speedAtDistance(row.a);
  const gap = (row.a - state.end) / v;
  let any = false;
  for (let li = 0; li < 3; li++) {
    const st = row.st[li];
    scratch[li] = UNREACHABLE;
    if (st === ST_BLOCK) continue;
    for (let pi = 0; pi < 3; pi++) {
      const pst = state.st[pi];
      if (pst === UNREACHABLE) continue;
      if (gap >= need(pi, pst, li, st)) {
        scratch[li] = st;
        any = true;
        break;
      }
    }
  }
  if (!any) return false;
  state.st[0] = scratch[0];
  state.st[1] = scratch[1];
  state.st[2] = scratch[2];
  state.end = Math.max(state.end, row.b);
  return true;
}

/** Checks a whole plan. Returns the index of the first unfair row, or -1 when the plan is fair. */
export function checkPlan(items: readonly PlanItem[], state: FairState = freshFairState()): number {
  const rows = buildRows(buildIntervals(items));
  for (let i = 0; i < rows.length; i++) {
    if (!advanceRow(state, rows[i])) return i;
  }
  return -1;
}
