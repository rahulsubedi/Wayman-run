// TrackView: sim entities <-> pooled model nodes.
// - 'spawn' takes a node from the pool of its kind (+ livery for vehicles) or creates one and shows
//   it; 'despawn' hides it and returns it to the pool (visible toggling, never remove/re-add).
// - Every frame each live node is positioned from its entity (x / y / s via stage.worldZ()), so
//   origin re-basing, the oncoming bus and magnet-pulled coins need no special handling here. The
//   Entity objects from 'spawn' events are live references the sim keeps mutating.
// - Per-frame idle animation hooks of the model kit (lamp blink, bus wheels, power-up pulse) are
//   called for every live node.
// - Hot paths allocate nothing: live nodes sit in a dense array (swap-remove) and are looked up by
//   id through a Map only on spawn / despawn.
import type { Container3D } from '@pixi/3d';
import { OBSTACLE_DIMS } from '../sim/config';
import type { Entity, EntityKind, ObstacleKind, PickupKind, SimEvent, SimState } from '../sim/types';
import { createObstacle, createPickup, updateObstacleVisual, updatePickupVisual } from './models';
import type { Stage } from './stage';

const KINDS: readonly EntityKind[] = [
  'hurdle', 'overhead', 'blocker', 'truck', 'bus', 'busOncoming', 'ramp', 'coin', 'magnet', 'shield', 'boost', 'multiplier',
];
const KIND_INDEX: Record<string, number> = {};
KINDS.forEach((k, i) => (KIND_INDEX[k] = i));
/** Distinct liveries per vehicle kind (matches the model kit); everything else has one look. */
const LIVERIES = 3;
const VARIANT_SLOTS = 8;

interface Live {
  node: Container3D;
  entity: Entity;
  kind: EntityKind;
  obstacle: boolean;
  key: number;
  index: number;
}

function isObstacle(kind: EntityKind): kind is ObstacleKind {
  return kind in OBSTACLE_DIMS;
}

function liveries(kind: EntityKind): number {
  return kind === 'truck' || kind === 'bus' ? LIVERIES : 1;
}

/** Pool key: kind + livery slot for vehicles. */
function poolKey(kind: EntityKind, variant: number | undefined): number {
  const base = KIND_INDEX[kind] * VARIANT_SLOTS;
  const n = liveries(kind);
  if (n === 1) return base;
  const v = variant ?? 0;
  return base + (((v % n) + n) % n);
}

export class TrackView {
  private readonly stage: Stage;
  private readonly pools = new Map<number, Container3D[]>();
  private readonly byId = new Map<number, Live>();
  private readonly live: Live[] = [];
  private readonly freeLive: Live[] = [];
  private time = 0;

  constructor(stage: Stage) {
    this.stage = stage;
  }

  /**
   * Create pooled nodes up front so nothing is built mid-run: `counts` per kind (vehicles get
   * `n` per livery). Also builds every livery's geometry.
   */
  prewarm(counts: Partial<Record<EntityKind, number>>): void {
    for (const [kind, n] of Object.entries(counts) as [EntityKind, number][]) {
      const variants = liveries(kind);
      for (let v = 0; v < variants; v++) {
        const key = poolKey(kind, v);
        const pool = this.pool(key);
        for (let i = 0; i < n; i++) pool.push(this.make(kind, v));
      }
    }
  }

  /**
   * Make one node of every pooled kind visible at `focus` (world coordinates) so shaders and
   * instancing buffers compile before the first run; the caller renders one frame, then calls
   * `endWarmup()`.
   */
  beginWarmup(x: number, y: number, z: number): void {
    for (const pool of this.pools.values()) {
      const n = pool[pool.length - 1];
      if (!n) continue;
      n.visible = true;
      n.position.set(x, y, z);
    }
  }

  endWarmup(): void {
    for (const pool of this.pools.values()) for (const n of pool) n.visible = false;
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'spawn') this.spawn(e.entity);
    else if (e.type === 'despawn') this.despawn(e.id);
  }

  update(_state: SimState, dt: number): void {
    this.time += dt;
    const time = this.time;
    const spin = time * 3.2;
    const stage = this.stage;
    const live = this.live;
    for (let i = 0; i < live.length; i++) {
      const l = live[i];
      const e = l.entity;
      const node = l.node;
      node.position.set(e.x, e.y, stage.worldZ(e.s));
      if (l.obstacle) {
        updateObstacleVisual(node, l.kind as ObstacleKind, time);
      } else if (l.kind === 'coin') {
        node.rotation.y = spin + e.s * 0.35;
      } else {
        node.rotation.y = spin * 0.6;
        node.position.y = e.y + Math.sin(time * 3 + e.id) * 0.12;
        updatePickupVisual(node, l.kind as PickupKind, time);
      }
    }
  }

  /** Hide every live node (new run). */
  reset(): void {
    for (let i = this.live.length - 1; i >= 0; i--) this.despawn(this.live[i].entity.id);
    this.time = 0;
  }

  get liveCount(): number {
    return this.live.length;
  }

  /** Debug: number of live nodes that are currently visible (must equal liveCount). */
  get visibleLiveCount(): number {
    let n = 0;
    for (let i = 0; i < this.live.length; i++) if (this.live[i].node.visible) n++;
    return n;
  }

  /** Debug: pooled (idle) nodes that are wrongly visible. Must be 0. */
  get visiblePooledCount(): number {
    let n = 0;
    for (const pool of this.pools.values()) for (let i = 0; i < pool.length; i++) if (pool[i].visible) n++;
    return n;
  }

  /** Debug: total nodes ever created (grows only if prewarm was too small). */
  get nodeCount(): number {
    let n = this.live.length;
    for (const pool of this.pools.values()) n += pool.length;
    return n;
  }

  private spawn(entity: Entity): void {
    if (this.byId.has(entity.id)) return;
    const key = poolKey(entity.kind, entity.variant);
    const node = this.pool(key).pop() ?? this.make(entity.kind, entity.variant ?? 0);
    node.visible = true;
    node.rotation.y = 0;
    node.position.set(entity.x, entity.y, this.stage.worldZ(entity.s));
    const l = this.freeLive.pop() ?? ({ index: 0 } as Live);
    l.node = node;
    l.entity = entity;
    l.kind = entity.kind;
    l.obstacle = isObstacle(entity.kind);
    l.key = key;
    l.index = this.live.length;
    this.live.push(l);
    this.byId.set(entity.id, l);
  }

  private despawn(id: number): void {
    const l = this.byId.get(id);
    if (!l) return;
    l.node.visible = false;
    this.pool(l.key).push(l.node);
    this.byId.delete(id);
    // swap-remove
    const last = this.live.pop()!;
    if (last !== l) {
      this.live[l.index] = last;
      last.index = l.index;
    }
    this.freeLive.push(l);
  }

  private pool(key: number): Container3D[] {
    let p = this.pools.get(key);
    if (!p) {
      p = [];
      this.pools.set(key, p);
    }
    return p;
  }

  private make(kind: EntityKind, variant: number): Container3D {
    const node = isObstacle(kind) ? createObstacle(kind, variant) : createPickup(kind as PickupKind);
    node.visible = false;
    this.stage.world.addChild(node);
    return node;
  }
}
