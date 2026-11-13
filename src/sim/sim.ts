// GameSim: pure, deterministic gameplay simulation. No pixi, no DOM, no wall clock, no Math.random.
//
// FOUNDATION NOTE: this is the walking-skeleton implementation. The public API (constructor,
// state, reset, update, drainEvents) and the types in ./types.ts are final; the internals
// (generator, collision rules, power-ups, stumble/chaser logic, roofs) are meant to be rewritten.
import {
  CHASER_FAR_GAP,
  CHASER_START_GAP,
  COIN_SCORE_BONUS,
  COIN_SPACING,
  DESPAWN_BEHIND,
  FAST_FALL_VY,
  GRAVITY,
  HARD_LAND_VY,
  JUMP_VELOCITY,
  LANE_CHANGE_TIME,
  LANES,
  OBSTACLE_DIMS,
  PICKUP_HOVER,
  PICKUP_LEN,
  PICKUP_RADIUS,
  PLAYER,
  POWERUP_DURATION,
  ROLL_TIME,
  RUN_PHASE_PER_METRE,
  SPAWN_AHEAD,
  START_SAFE_DISTANCE,
  ZONE_BLEND_LENGTH,
  ZONE_COUNT,
  ZONE_LENGTH,
  laneX,
  speedAt,
} from './config';
import { EventQueue } from './events';
import { Rng } from './rng';
import type {
  Entity,
  EntityKind,
  InputActions,
  Lane,
  ObstacleKind,
  PickupKind,
  PlayerAction,
  PowerupKind,
  SimEvent,
  SimState,
} from './types';

const POWERUP_KINDS: readonly PowerupKind[] = ['magnet', 'shield', 'boost', 'multiplier'];
const ROW_OBSTACLES: readonly ObstacleKind[] = ['hurdle', 'overhead', 'blocker'];

function isObstacle(kind: EntityKind): kind is ObstacleKind {
  return kind in OBSTACLE_DIMS;
}

function isPowerup(kind: EntityKind): kind is PowerupKind {
  return (POWERUP_KINDS as readonly string[]).includes(kind);
}

function createState(): SimState {
  return {
    time: 0,
    player: {
      s: 0,
      x: 0,
      y: 0,
      vy: 0,
      lane: 0,
      action: 'run',
      actionTime: 0,
      grounded: true,
      speed: speedAt(0),
      lean: 0,
      runPhase: 0,
    },
    chaser: { gap: CHASER_START_GAP, visible: true },
    entities: [],
    score: 0,
    coins: 0,
    multiplier: 1,
    powerups: { magnet: 0, shield: 0, boost: 0, multiplier: 0 },
    zone: 0,
    zoneBlend: 0,
    over: false,
  };
}

export class GameSim {
  readonly state: SimState;

  private rng: Rng;
  private events = new EventQueue();
  /** Mutable view of state.entities. */
  private entities: Entity[] = [];
  private nextId = 1;
  private nextRowS = START_SAFE_DISTANCE;
  private laneFromX = 0;
  private laneT = 1;
  private rollQueued = false;
  private scoreDistance = 0;

  constructor(seed = 1) {
    this.state = createState();
    this.rng = new Rng(seed);
    this.reset(seed);
  }

  /** Restarts the run. Same seed + same inputs => same run. */
  reset(seed?: number): void {
    if (seed !== undefined) this.rng = new Rng(seed);
    const fresh = createState();
    // Keep object identities stable so views may hold references to state sub-objects.
    const st = this.state;
    Object.assign(st.player, fresh.player);
    Object.assign(st.chaser, fresh.chaser);
    Object.assign(st.powerups, fresh.powerups);
    st.time = 0;
    st.score = 0;
    st.coins = 0;
    st.multiplier = 1;
    st.zone = 0;
    st.zoneBlend = 0;
    st.over = false;
    this.entities.length = 0;
    st.entities = this.entities;
    this.events.clear();
    this.nextId = 1;
    this.nextRowS = START_SAFE_DISTANCE;
    this.laneFromX = 0;
    this.laneT = 1;
    this.rollQueued = false;
    this.scoreDistance = 0;
    this.generate();
  }

  /** Advance by `dt` seconds. Call with small fixed steps (<= MAX_SIM_STEP = 1/120 s). */
  update(dt: number, input: InputActions): void {
    const st = this.state;
    if (st.over) return;
    const p = st.player;
    st.time += dt;
    p.actionTime += dt;

    this.handleInput(input);

    // Forward motion.
    p.speed = speedAt(st.time);
    const ds = p.speed * dt;
    p.s += ds;
    p.runPhase = (p.runPhase + ds * RUN_PHASE_PER_METRE) % (Math.PI * 2);
    st.multiplier = st.powerups.multiplier > 0 ? 2 : 1;
    this.scoreDistance += ds * st.multiplier;

    // Lateral tween (ease-out), chainable: a new press restarts from the current x.
    const targetX = laneX(p.lane);
    if (this.laneT < 1) {
      this.laneT = Math.min(1, this.laneT + dt / LANE_CHANGE_TIME);
      const k = 1 - (1 - this.laneT) * (1 - this.laneT);
      p.x = this.laneFromX + (targetX - this.laneFromX) * k;
    } else {
      p.x = targetX;
    }
    const leanTarget = Math.max(-1, Math.min(1, (targetX - p.x) / 1.2));
    p.lean += (leanTarget - p.lean) * Math.min(1, dt * 18);

    // Vertical.
    if (!p.grounded) {
      p.vy -= GRAVITY * dt;
      p.y += p.vy * dt;
      if (p.y <= 0) {
        const hard = p.vy < HARD_LAND_VY;
        p.y = 0;
        p.vy = 0;
        p.grounded = true;
        this.emit({ type: 'land', hard });
        if (this.rollQueued) {
          this.rollQueued = false;
          this.setAction('roll');
          this.emit({ type: 'roll' });
        } else {
          this.setAction('run');
        }
      } else if (p.vy <= 0 && p.action === 'jump') {
        this.setAction('fall');
      }
    } else if (p.action === 'roll' && p.actionTime >= ROLL_TIME) {
      this.setAction('run');
    }

    this.updatePowerups(dt);
    this.updateChaser(dt);
    this.generate();
    this.collide();

    st.score = Math.floor(this.scoreDistance) + st.coins * COIN_SCORE_BONUS;
    this.updateZone();
  }

  /** Events since the last drain. The array is only valid until the next call. */
  drainEvents(): SimEvent[] {
    return this.events.drain();
  }

  // ---------------------------------------------------------------- internals

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  private setAction(a: PlayerAction): void {
    const p = this.state.player;
    if (p.action !== a) {
      p.action = a;
      p.actionTime = 0;
    }
  }

  private handleInput(input: InputActions): void {
    const p = this.state.player;
    const dir = input.left ? -1 : input.right ? 1 : 0;
    if (dir !== 0) {
      const next = p.lane + dir;
      if (next >= -1 && next <= 1) {
        this.laneFromX = p.x;
        this.laneT = 0;
        p.lane = next as Lane;
        this.emit({ type: 'laneChange', dir: dir as -1 | 1 });
      }
    }
    if (input.jump && p.grounded) {
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      this.rollQueued = false;
      this.setAction('jump');
      this.emit({ type: 'jump' });
    } else if (input.roll) {
      if (p.grounded) {
        p.action = 'roll';
        p.actionTime = 0;
        this.emit({ type: 'roll' });
      } else {
        p.vy = Math.min(p.vy, FAST_FALL_VY);
        this.rollQueued = true;
      }
    }
  }

  private updatePowerups(dt: number): void {
    const pw = this.state.powerups;
    for (const k of POWERUP_KINDS) {
      if (k === 'shield' || pw[k] <= 0) continue;
      pw[k] = Math.max(0, pw[k] - dt);
      if (pw[k] === 0) this.emit({ type: 'powerupEnd', kind: k });
    }
  }

  private updateChaser(dt: number): void {
    const c = this.state.chaser;
    // Skeleton behaviour: visible at the start of a run, then drifts back and hides.
    c.gap = Math.min(CHASER_FAR_GAP, c.gap + dt * 6);
    c.visible = c.gap < CHASER_FAR_GAP;
  }

  private updateZone(): void {
    const st = this.state;
    const s = st.player.s;
    const zone = Math.floor(s / ZONE_LENGTH) % ZONE_COUNT;
    const into = s % ZONE_LENGTH;
    const t = Math.max(0, (into - (ZONE_LENGTH - ZONE_BLEND_LENGTH)) / ZONE_BLEND_LENGTH);
    st.zoneBlend = t * t * (3 - 2 * t);
    if (zone !== st.zone) {
      st.zone = zone;
      this.emit({ type: 'zone', index: zone });
    }
  }

  private spawn(kind: EntityKind, lane: Lane, s: number, y = 0): Entity {
    const len = isObstacle(kind) ? OBSTACLE_DIMS[kind].len : PICKUP_LEN[kind as PickupKind];
    const e: Entity = { id: this.nextId++, kind, lane, x: laneX(lane), s, y, len, active: true };
    this.entities.push(e);
    this.emit({ type: 'spawn', entity: e });
    return e;
  }

  /** Skeleton generator: rows of 1-2 obstacles with one guaranteed free lane, plus coin lines. */
  private generate(): void {
    const p = this.state.player;
    while (this.nextRowS < p.s + SPAWN_AHEAD) {
      const s = this.nextRowS;
      const free = this.rng.pick(LANES);
      const count = this.rng.chance(0.4) ? 2 : 1;
      let placed = 0;
      for (const lane of LANES) {
        if (lane === free || placed >= count) continue;
        if (count === 1 && this.rng.chance(0.5)) continue;
        this.spawn(this.rng.pick(ROW_OBSTACLES), lane, s);
        placed++;
      }
      if (placed === 0) {
        const lane = free === 0 ? 1 : 0;
        this.spawn(this.rng.pick(ROW_OBSTACLES), lane, s);
      }
      // A coin line through the free lane, centred on the row.
      const n = 5;
      for (let i = 0; i < n; i++) {
        this.spawn('coin', free, s + (i - (n - 1) / 2) * COIN_SPACING);
      }
      // Rows get further apart as speed rises, keeping reaction time roughly constant.
      const v = speedAt(this.state.time + (s - p.s) / Math.max(1, p.speed));
      this.nextRowS += Math.max(16, v * this.rng.range(1.25, 1.9));
    }

    // Despawn behind (compacting in place).
    let w = 0;
    const list = this.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.active && e.s + e.len / 2 >= p.s - DESPAWN_BEHIND) {
        list[w++] = e;
      } else {
        this.emit({ type: 'despawn', id: e.id });
      }
    }
    list.length = w;
  }

  private collide(): void {
    const st = this.state;
    const p = st.player;
    const h = p.action === 'roll' ? PLAYER.rollHeight : PLAYER.height;
    const px0 = p.x - PLAYER.width / 2;
    const px1 = p.x + PLAYER.width / 2;
    const ps0 = p.s - PLAYER.depth / 2;
    const ps1 = p.s + PLAYER.depth / 2;
    const py0 = p.y;
    const py1 = p.y + h;

    for (const e of this.entities) {
      if (!e.active) continue;
      if (e.s - e.len / 2 > ps1 + 2 || e.s + e.len / 2 < ps0 - 2) continue;
      if (isObstacle(e.kind)) {
        const d = OBSTACLE_DIMS[e.kind];
        if (
          px1 > e.x - d.w / 2 &&
          px0 < e.x + d.w / 2 &&
          ps1 > e.s - d.len / 2 &&
          ps0 < e.s + d.len / 2 &&
          py1 > e.y + d.solidFrom &&
          py0 < e.y + d.h
        ) {
          this.crash();
          return;
        }
      } else {
        const cy = e.y + PICKUP_HOVER;
        const r = PICKUP_RADIUS;
        if (
          px1 > e.x - r &&
          px0 < e.x + r &&
          ps1 > e.s - r &&
          ps0 < e.s + r &&
          py1 > cy - r &&
          py0 < cy + r
        ) {
          e.active = false; // removed (and 'despawn' emitted) by the next generate() pass
          if (e.kind === 'coin') {
            st.coins++;
            this.emit({ type: 'coin', id: e.id, x: e.x, y: e.y, s: e.s, total: st.coins });
          } else if (isPowerup(e.kind)) {
            st.powerups[e.kind] = POWERUP_DURATION[e.kind];
            this.emit({ type: 'pickup', kind: e.kind });
          }
        }
      }
    }
  }

  private crash(): void {
    const st = this.state;
    st.over = true;
    st.player.vy = 0;
    this.setAction('dead');
    this.emit({ type: 'gameOver', reason: 'crash' });
  }
}
