// Autopilot: a competent bot that reads only the public SimState (like a player looking at the
// screen) and returns edge-triggered InputActions. Used for automated QA screenshots and as the
// fairness fuzzer in the tests. Pure and allocation-free per call.
//
// Per lane it computes the time until the lane becomes impassable ("block time") over a 3 s
// horizon: hurdles (jump) and overheads (roll) are passable, ramps open a roof chain that runs
// until the last touching vehicle, blockers / vehicles at road level / oncoming buses block.
// It then moves toward the best reachable lane (checking for side hits on the way), jumps
// hurdles so that the apex is over them and rolls under overheads.
import { CHAIN_MAX_GAP, LANES, LANE_CHANGE_TIME, OBSTACLE_DIMS, PLAYER, ROLL_TIME, ROOF_Y, STEP_UP, laneX } from './config';
import type { Entity, InputActions, ObstacleKind, SimState } from './types';

const HORIZON = 3;
const HALF_D = PLAYER.depth / 2;
/** Stay in the current lane while it is clear for at least this long (s). */
const SAFE_T = 1.05;

interface Obs {
  e: Entity;
  kind: ObstacleKind;
  /** Time until the player's front reaches the near edge (s). */
  tc: number;
  /** Time until the player's back passes the far edge (s). */
  te: number;
}

const out: InputActions = { left: false, right: false, jump: false, roll: false };
const lanes: Obs[][] = [[], [], []];
const obsPool: Obs[] = [];
let obsUsed = 0;
const blockT = [0, 0, 0];
const roofLane = [false, false, false];
const coinScore = [0, 0, 0];
const score = [0, 0, 0];
const airCoinT = [0, 0, 0];

function obs(): Obs {
  if (obsUsed >= obsPool.length) obsPool.push({ e: null as unknown as Entity, kind: 'hurdle', tc: 0, te: 0 });
  return obsPool[obsUsed++];
}

function insertSorted(list: Obs[], o: Obs): void {
  list.push(o);
  let i = list.length - 1;
  while (i > 0 && list[i - 1].tc > o.tc) {
    list[i] = list[i - 1];
    i--;
  }
  list[i] = o;
}

function isWalkable(k: ObstacleKind): boolean {
  return OBSTACLE_DIMS[k].walkable && k !== 'busOncoming';
}

function rampHeightAt(e: Entity, s: number): number {
  const k = (s - (e.s - e.len / 2)) / e.len;
  return e.y + ROOF_Y * Math.max(0, Math.min(1, k));
}

/** Time until lane li becomes impassable, from the player's point of view. */
function analyzeLane(state: SimState, li: number, v: number): number {
  const p = state.player;
  const L = li - 1;
  const list = lanes[li];
  const inLane = L === p.lane;
  const high = p.y >= ROOF_Y - 0.35;
  const chainGapT = (CHAIN_MAX_GAP + 0.4) / v;
  let roofUntil = -Infinity;
  roofLane[li] = false;
  for (const o of list) {
    if (o.te <= 0) continue;
    if (o.tc > HORIZON) break;
    const k = o.kind;
    if (isWalkable(k)) {
      const overlapping = o.tc <= 0;
      if (roofUntil > -Infinity && o.tc <= roofUntil + chainGapT) {
        roofUntil = Math.max(roofUntil, o.te);
        continue;
      }
      if (overlapping && (inLane || high) && (k !== 'ramp' || inLane)) {
        // Standing on it (or level with its roof): ride the chain.
        if (k !== 'ramp' && !high) return o.tc;
        roofUntil = o.te;
        roofLane[li] = true;
        continue;
      }
      if (k === 'ramp' && o.tc > (inLane ? 0.02 : 0.2)) {
        roofUntil = o.te;
        roofLane[li] = true;
        continue;
      }
      return o.tc;
    }
    if (k === 'busOncoming' || k === 'blocker') return o.tc;
    if (o.tc < roofUntil) continue; // under / beside us while we run on the roof
  }
  return Infinity;
}

/** Can the player's body move through lane li during [t0, t1] without a side hit? */
function canCross(state: SimState, li: number, t0: number, t1: number, v: number): boolean {
  const p = state.player;
  const rolling = p.action === 'roll' && p.grounded;
  for (const o of lanes[li]) {
    if (o.te < t0 || o.tc > t1) continue;
    switch (o.kind) {
      case 'ramp': {
        const top = rampHeightAt(o.e, p.s + v * t1);
        if (top > p.y + STEP_UP - 0.1) return false;
        break;
      }
      case 'truck':
      case 'bus':
      case 'busOncoming':
        if (p.y < ROOF_Y - 0.3) return false;
        break;
      case 'hurdle':
        if (p.y < OBSTACLE_DIMS.hurdle.h + 0.05) return false;
        break;
      case 'overhead':
        if (!rolling && p.y < OBSTACLE_DIMS.overhead.h) return false;
        break;
      case 'blocker':
        if (p.y < OBSTACLE_DIMS.blocker.h + 0.05) return false;
        break;
    }
  }
  return true;
}

export function autopilot(state: SimState): InputActions {
  out.left = out.right = out.jump = out.roll = false;
  if (state.over) return out;
  const p = state.player;
  const v = Math.max(1, p.speed);
  const flying = p.action === 'fly';

  // ---- gather obstacles per lane, sorted by contact time; pickups per lane
  obsUsed = 0;
  for (let i = 0; i < 3; i++) {
    lanes[i].length = 0;
    coinScore[i] = 0;
    airCoinT[i] = Infinity;
  }
  for (const e of state.entities) {
    if (!e.active) continue;
    const li = e.lane + 1;
    if (e.kind in OBSTACLE_DIMS) {
      const rv = v - (e.vs ?? 0);
      const tc = (e.s - e.len / 2 - (p.s + HALF_D)) / rv;
      const te = (e.s + e.len / 2 - (p.s - HALF_D)) / rv;
      if (te < -0.05 || tc > HORIZON + 0.5) continue;
      const o = obs();
      o.e = e;
      o.kind = e.kind as ObstacleKind;
      o.tc = tc;
      o.te = te;
      insertSorted(lanes[li], o);
    } else {
      const t = (e.s - p.s) / v;
      if (t < 0 || t > 2.2) continue;
      if (e.y > 4) {
        airCoinT[li] = Math.min(airCoinT[li], t);
        continue;
      }
      coinScore[li] += e.kind === 'coin' ? 0.03 : 0.7;
    }
  }

  const settled = Math.abs(p.x - laneX(p.lane)) < 0.35;
  const cur = p.lane;
  const ci = cur + 1;

  if (flying) {
    let best = ci;
    for (let i = 0; i < 3; i++) if (airCoinT[i] < airCoinT[best] - 0.15) best = i;
    if (settled && best !== ci) {
      if (best < ci) out.left = true;
      else out.right = true;
    }
    return out;
  }

  // ---- lane choice
  for (let i = 0; i < 3; i++) blockT[i] = analyzeLane(state, i, v);
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(i - ci);
    let ok = true;
    if (d >= 1) ok = canCross(state, i, 0, LANE_CHANGE_TIME + 0.06, v);
    if (ok && d === 2) ok = canCross(state, 1, 0, LANE_CHANGE_TIME * 2 + 0.06, v) && blockT[1] > 0.25;
    if (ok && d >= 1 && blockT[i] < LANE_CHANGE_TIME * d + 0.08) ok = false;
    const bt = Math.min(blockT[i], HORIZON);
    // Pickups only count when they come before the lane closes.
    const bonus = blockT[i] > 1.2 ? Math.min(0.9, coinScore[i]) : 0;
    score[i] = ok ? bt - 0.07 * d + bonus + (roofLane[i] ? 0.4 : 0) : -Infinity;
  }
  // Riding a ramp / roof: stay up there unless the lane is about to close.
  const elevated = p.grounded && (p.groundY ?? 0) > 0.3;
  if (elevated) for (let i = 0; i < 3; i++) if (i !== ci && !roofLane[i]) score[i] -= 1;
  let best = ci;
  for (let i = 0; i < 3; i++) if (score[i] > score[best] + 1e-6) best = i;
  const curClear = blockT[ci] >= SAFE_T;
  const worth = score[best] > score[ci] + (curClear ? 0.3 : 0.02);
  if (settled && best !== ci && worth && p.action !== 'dead') {
    if (best < ci) out.left = true;
    else out.right = true;
  }

  // ---- vertical actions in the lane(s) the body occupies
  let jumpAt = Infinity;
  let rollAt = Infinity;
  for (const L of LANES) {
    const overlapsBody = L === p.lane || Math.abs(p.x - laneX(L)) < 1.5;
    if (!overlapsBody) continue;
    for (const o of lanes[L + 1]) {
      if (o.te <= 0) continue;
      if (o.kind !== 'hurdle' && o.kind !== 'overhead') continue;
      if (p.y >= ROOF_Y - 0.4) continue; // running on roofs: ground obstacles are below us
      const tCentre = (o.e.s - p.s) / (v - (o.e.vs ?? 0));
      if (o.kind === 'hurdle') jumpAt = Math.min(jumpAt, tCentre);
      else rollAt = Math.min(rollAt, o.tc);
      break;
    }
  }
  const canJump = p.grounded || p.action === 'fall';
  if (jumpAt < rollAt) {
    if (canJump && jumpAt > 0.06 && jumpAt <= 0.33) out.jump = true;
  } else if (rollAt < Infinity) {
    const rolling = p.action === 'roll';
    const remaining = rolling ? ROLL_TIME - p.actionTime : 0;
    if (rollAt < 0.3 && rollAt > -0.2 && (!rolling || remaining < 0.12)) out.roll = true;
  }
  if (out.jump && out.roll) out.roll = false;
  return out;
}
