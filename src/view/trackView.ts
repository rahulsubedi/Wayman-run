// TrackView: sim entities <-> pooled model nodes.
// - 'spawn' takes a node from the kind's pool (or creates one) and shows it; 'despawn' hides it
//   and returns it to the pool (visible toggling, never remove/re-add).
// - Every frame each live node is positioned from its entity with stage.worldZ(), so origin
//   re-basing needs no extra handling here.
// - Entity objects from 'spawn' events are live references the sim keeps mutating (e.g. a
//   busOncoming's s), so reading them every frame is correct.
import type { Container3D } from '@pixi/3d';
import { OBSTACLE_DIMS } from '../sim/config';
import type { Entity, EntityKind, ObstacleKind, PickupKind, SimEvent, SimState } from '../sim/types';
import { createObstacle, createPickup } from './models';
import type { Stage } from './stage';

interface Live {
  node: Container3D;
  entity: Entity;
}

function isObstacle(kind: EntityKind): kind is ObstacleKind {
  return kind in OBSTACLE_DIMS;
}

export class TrackView {
  private readonly stage: Stage;
  private readonly pools = new Map<EntityKind, Container3D[]>();
  private readonly live = new Map<number, Live>();
  private time = 0;

  constructor(stage: Stage) {
    this.stage = stage;
  }

  /** Create pooled nodes up front so the first spawns do not hitch. */
  prewarm(counts: Partial<Record<EntityKind, number>>): void {
    for (const [kind, n] of Object.entries(counts) as [EntityKind, number][]) {
      const pool = this.pool(kind);
      for (let i = 0; i < n; i++) pool.push(this.make(kind));
    }
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'spawn') this.spawn(e.entity);
    else if (e.type === 'despawn') this.despawn(e.id);
  }

  update(_state: SimState, dt: number): void {
    this.time += dt;
    const spin = this.time * 3.2;
    for (const l of this.live.values()) {
      const e = l.entity;
      l.node.position.set(e.x, e.y, this.stage.worldZ(e.s));
      if (e.kind === 'coin') l.node.rotation.y = spin + e.s * 0.35;
      else if (!isObstacle(e.kind)) {
        l.node.rotation.y = spin * 0.6;
        l.node.position.y = e.y + Math.sin(this.time * 3 + e.id) * 0.12;
      }
    }
  }

  /** Hide every live node (new run). */
  reset(): void {
    for (const id of [...this.live.keys()]) this.despawn(id);
  }

  get liveCount(): number {
    return this.live.size;
  }

  private spawn(entity: Entity): void {
    if (this.live.has(entity.id)) return;
    const pool = this.pool(entity.kind);
    const node = pool.pop() ?? this.make(entity.kind);
    node.visible = true;
    node.rotation.y = 0;
    node.position.set(entity.x, entity.y, this.stage.worldZ(entity.s));
    this.live.set(entity.id, { node, entity });
  }

  private despawn(id: number): void {
    const l = this.live.get(id);
    if (!l) return;
    l.node.visible = false;
    this.pool(l.entity.kind).push(l.node);
    this.live.delete(id);
  }

  private pool(kind: EntityKind): Container3D[] {
    let p = this.pools.get(kind);
    if (!p) {
      p = [];
      this.pools.set(kind, p);
    }
    return p;
  }

  private make(kind: EntityKind): Container3D {
    const node = isObstacle(kind) ? createObstacle(kind) : createPickup(kind as PickupKind);
    node.visible = false;
    this.stage.world.addChild(node);
    return node;
  }
}
