// Internal entity representation + pooling. SimEntity objects are what views receive as `Entity`
// (the extra fields are internal bookkeeping and may change).
import { OBSTACLE_DIMS, PICKUP_LEN, ROOF_Y, laneX } from './config';
import type { Entity, EntityKind, Lane, ObstacleKind, PowerupKind } from './types';

export interface SimEntity extends Entity {
  vs: number;
  variant: number;
  magnet: boolean;
  /** s at the previous step (swept collision). */
  prevS: number;
  /** Player s at which the planned entity is spawned. */
  trigger: number;
  /** busOncoming: planned s where the player meets the bus' near edge. */
  meetS: number;
  /** Roof chain id (ramp + vehicles run as one surface), 0 = none. */
  chain: number;
  /** Near-miss / pass bookkeeping already done. */
  passed: boolean;
  /** Cached kind flags (hot loops). */
  obstacle: boolean;
  walkable: boolean;
}

export const POWERUP_KINDS: readonly PowerupKind[] = ['magnet', 'shield', 'boost', 'multiplier'];

export function isObstacleKind(kind: EntityKind): kind is ObstacleKind {
  return kind in OBSTACLE_DIMS;
}

export function isPowerupKind(kind: EntityKind): kind is PowerupKind {
  return kind === 'magnet' || kind === 'shield' || kind === 'boost' || kind === 'multiplier';
}

export function isVehicleKind(kind: EntityKind): boolean {
  return kind === 'truck' || kind === 'bus' || kind === 'busOncoming';
}

export function lengthOf(kind: EntityKind): number {
  return isObstacleKind(kind) ? OBSTACLE_DIMS[kind].len : PICKUP_LEN[kind];
}

/** Top of the ramp surface at track position `s` (0 at the near end, ROOF_Y at the far end). */
export function rampTop(e: Entity, s: number): number {
  const s0 = e.s - e.len / 2;
  const k = (s - s0) / e.len;
  return e.y + ROOF_Y * (k < 0 ? 0 : k > 1 ? 1 : k);
}

export class EntityPool {
  private free: SimEntity[] = [];

  acquire(kind: EntityKind, lane: Lane, s: number, y: number): SimEntity {
    const e = this.free.pop() ?? {
      id: 0,
      kind,
      lane,
      x: 0,
      s: 0,
      y: 0,
      len: 0,
      active: true,
      vs: 0,
      variant: 0,
      magnet: false,
      prevS: 0,
      trigger: 0,
      meetS: 0,
      chain: 0,
      passed: false,
      obstacle: false,
      walkable: false,
    };
    e.id = 0;
    e.kind = kind;
    e.lane = lane;
    e.x = laneX(lane);
    e.s = s;
    e.prevS = s;
    e.y = y;
    e.len = lengthOf(kind);
    e.active = true;
    e.vs = 0;
    e.variant = 0;
    e.magnet = false;
    e.trigger = 0;
    e.meetS = 0;
    e.chain = 0;
    e.passed = false;
    e.obstacle = isObstacleKind(kind);
    e.walkable = e.obstacle && OBSTACLE_DIMS[kind as ObstacleKind].walkable;
    return e;
  }

  release(e: SimEntity): void {
    this.free.push(e);
  }

  get size(): number {
    return this.free.length;
  }
}
