// GameSim: pure, deterministic gameplay simulation. No pixi, no DOM, no wall clock, no Math.random.
//
// Step order (update): timers -> forward motion -> moving entities -> input -> lateral tween ->
// vertical (boost / ground / air) -> obstacle collisions + near misses -> pickups (+ magnet) ->
// power-up timers -> chaser -> generator (spawn / plan) -> despawn -> score + zone.
//
// The hot path allocates nothing: entities are pooled (released on drainEvents), arrays reused.
// Only rare events (spawn, coin, jump ...) allocate their small event objects.
import {
  BOOST_DESCENT_VY,
  BOOST_LANDING_GRACE,
  BOOST_RISE_RATE,
  BOOST_Y,
  CHASER_CLOSE_SPEED,
  CHASER_DRIFT_SPEED,
  CHASER_FAR_GAP,
  CHASER_INTRO_TIME,
  CHASER_START_GAP,
  CHASER_STUMBLE_GAP,
  CHASER_SWOOP_GAP,
  CHASER_WARN_GAP,
  CLIP_BOUNCE_VY,
  COIN_SCORE_BONUS,
  COYOTE_TIME,
  DESPAWN_BEHIND,
  FAST_FALL_VY,
  GRAVITY,
  HARD_LAND_DROP,
  JUMP_BUFFER,
  JUMP_VELOCITY,
  LANE_BUFFER,
  LANE_CHANGE_TIME,
  LANE_WIDTH,
  MAGNET_PULL_SPEED,
  MAGNET_RADIUS,
  NEAR_MISS_BONUS,
  NEAR_MISS_LATERAL,
  NEAR_MISS_VERTICAL,
  OBSTACLE_DIMS,
  ONCOMING_SPEED,
  PICKUP_HOVER,
  PICKUP_RADIUS,
  PLAYER,
  POWERUP_DURATION,
  ROLL_TIME,
  ROOF_Y,
  RUN_PHASE_PER_METRE,
  SHIELD_INVULN,
  STEP_UP,
  STUMBLE_TIME,
  STUMBLE_WINDOW,
  ZONE_BLEND_LENGTH,
  ZONE_COUNT,
  ZONE_LENGTH,
  distanceAt,
  laneX,
  speedAt,
} from './config';
import { EntityPool, POWERUP_KINDS, type SimEntity, isPowerupKind, rampTop } from './entity';
import { EventQueue } from './events';
import { TrackGenerator, tierAt } from './generator';
import { Rng } from './rng';
import type { Entity, EntityKind, GameOverReason, InputActions, Lane, PlayerAction, PowerupKind, RunStats, SimEvent, SimState } from './types';

const HALF_W = PLAYER.width / 2;
const HALF_D = PLAYER.depth / 2;
const TOP_EPS = 0.02;
const BOOST_DESCENT_TIME = BOOST_Y / -BOOST_DESCENT_VY;

function freshStats(): RunStats {
  return { jumps: 0, rolls: 0, laneChanges: 0, nearMisses: 0, stumbles: 0, powerups: 0, shieldSaves: 0, roofMetres: 0 };
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
      groundY: 0,
      invulnerable: 0,
      stumbleWindow: 0,
      fastFall: false,
      laneFrom: 0,
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
    distance: 0,
    tier: 0,
    stats: freshStats(),
  };
}

export class GameSim {
  readonly state: SimState;

  private rng: Rng;
  private readonly events = new EventQueue();
  private readonly pool = new EntityPool();
  private readonly gen: TrackGenerator;
  /** Mutable view of state.entities. */
  private readonly entities: SimEntity[] = [];
  private readonly releaseQueue: SimEntity[] = [];
  private readonly spawnFn = (e: SimEntity): void => this.spawnPlanned(e);
  private nextId = 1;
  /** When false the generator neither plans nor spawns (tests place entities by hand). */
  private generation = true;

  // ---- player internals
  private laneFromX = 0;
  private laneT = 1;
  private laneFromLane: Lane = 0;
  /** Lane at the start of the most recent voluntary lane change (near-miss "late dodge"). */
  private laneLeft: Lane = 0;
  private laneChangeAge = 99;
  private bouncing = false;
  private laneBufDir = 0;
  private laneBufT = 0;
  private jumpBuffer = 0;
  private coyote = 0;
  private rollQueued = false;
  private rollTimer = 0;
  private stumbleAnim = 0;
  private peakY = 0;
  private jumpStartY = 0;
  private descending = false;
  private ignoreId = 0;
  private prevS = 0;
  private prevX = 0;
  private prevY = 0;
  private prevH: number = PLAYER.height;
  private scoreDistance = 0;
  private bonusScore = 0;
  private airCoinsUntil = 0;

  constructor(seed = 1) {
    this.state = createState();
    this.rng = new Rng(seed);
    this.gen = new TrackGenerator(this.pool, this.rng);
    this.reset(seed);
  }

  /** Restarts the run. Same seed + same inputs => same run. Keeps every state object identity. */
  reset(seed?: number): void {
    if (seed !== undefined) this.rng = new Rng(seed);
    else this.rng = new Rng(this.rng.state);
    const fresh = createState();
    const st = this.state;
    Object.assign(st.player, fresh.player);
    Object.assign(st.chaser, fresh.chaser);
    Object.assign(st.powerups, fresh.powerups);
    Object.assign(st.stats!, fresh.stats);
    st.time = 0;
    st.score = 0;
    st.coins = 0;
    st.multiplier = 1;
    st.zone = 0;
    st.zoneBlend = 0;
    st.over = false;
    st.distance = 0;
    st.tier = 0;
    for (const e of this.entities) this.pool.release(e);
    this.entities.length = 0;
    this.flushReleases();
    st.entities = this.entities;
    this.events.clear();
    this.nextId = 1;
    this.generation = true;
    this.laneFromX = 0;
    this.laneT = 1;
    this.laneFromLane = 0;
    this.laneLeft = 0;
    this.laneChangeAge = 99;
    this.bouncing = false;
    this.laneBufDir = 0;
    this.laneBufT = 0;
    this.jumpBuffer = 0;
    this.coyote = 0;
    this.rollQueued = false;
    this.rollTimer = 0;
    this.stumbleAnim = 0;
    this.peakY = 0;
    this.jumpStartY = 0;
    this.descending = false;
    this.ignoreId = 0;
    this.prevS = this.prevX = this.prevY = 0;
    this.prevH = PLAYER.height;
    this.scoreDistance = 0;
    this.bonusScore = 0;
    this.airCoinsUntil = 0;
    this.gen.reset(this.rng);
    this.gen.update(0, st.player.speed, this.spawnFn);
  }

  /** Advance by `dt` seconds. Call with small fixed steps (<= MAX_SIM_STEP = 1/120 s). */
  update(dt: number, input: InputActions): void {
    const st = this.state;
    if (st.over || dt <= 0) return;
    if (this.releaseQueue.length > 512) this.flushReleases();
    const p = st.player;
    st.time += dt;
    p.actionTime += dt;
    this.tickTimers(dt);

    this.prevS = p.s;
    this.prevX = p.x;
    this.prevY = p.y;
    this.prevH = this.bodyHeight();

    // Forward motion (speed depends on run time only, so the generator can plan exactly).
    p.speed = speedAt(st.time);
    const ds = p.speed * dt;
    p.s += ds;
    for (const e of this.entities) {
      e.prevS = e.s;
      if (e.vs) e.s += e.vs * dt;
    }

    this.handleInput(input);
    this.updateLateral(dt);
    this.updateVertical(dt);
    if (p.grounded && p.action !== 'dead') p.runPhase = (p.runPhase + ds * RUN_PHASE_PER_METRE) % (Math.PI * 2);

    st.multiplier = st.powerups.multiplier > 0 ? 2 : 1;
    this.scoreDistance += ds * st.multiplier;
    if (p.grounded && (p.groundY ?? 0) >= ROOF_Y - 0.01) st.stats!.roofMetres += ds;

    this.collideObstacles();
    if (!st.over) this.collectPickups(dt);
    this.updatePowerups(dt);
    this.updateChaser(dt);
    if (this.generation) this.gen.update(p.s, p.speed, this.spawnFn);
    this.despawn();

    st.score = Math.floor(this.scoreDistance) + this.bonusScore;
    st.distance = p.s;
    st.tier = tierAt(p.s);
    this.updateZone();
  }

  /** Events since the last drain. The array is only valid until the next call. */
  drainEvents(): SimEvent[] {
    this.flushReleases();
    return this.events.drain();
  }

  // ------------------------------------------------------------ test / debug helpers

  /** Removes every live and planned entity. With `stopGenerator` nothing new is generated afterwards. */
  clearTrack(stopGenerator = true): void {
    for (const e of this.entities) {
      this.emit({ type: 'despawn', id: e.id });
      this.releaseQueue.push(e);
    }
    this.entities.length = 0;
    this.generation = !stopGenerator;
    if (stopGenerator) this.gen.reset(new Rng(this.rng.state));
  }

  /** Places an entity immediately (centre `s`). busOncoming gets its usual speed. */
  placeEntity(kind: EntityKind, lane: Lane, s: number, y = 0): Entity {
    const e = this.pool.acquire(kind, lane, s, y);
    if (kind === 'busOncoming') e.vs = -ONCOMING_SPEED;
    this.spawnPlanned(e);
    return e;
  }

  /** Turns generation on or off (debug). */
  setGeneration(on: boolean): void {
    this.generation = on;
  }

  // ------------------------------------------------------------------ internals

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  private flushReleases(): void {
    for (const e of this.releaseQueue) this.pool.release(e);
    this.releaseQueue.length = 0;
  }

  private spawnPlanned(e: SimEntity): void {
    e.id = this.nextId++;
    e.prevS = e.s;
    this.entities.push(e);
    this.emit({ type: 'spawn', entity: e });
  }

  private setAction(a: PlayerAction): void {
    const p = this.state.player;
    if (p.action !== a) {
      p.action = a;
      p.actionTime = 0;
    }
  }

  private bodyHeight(): number {
    return this.state.player.action === 'roll' ? PLAYER.rollHeight : PLAYER.height;
  }

  private isFlying(): boolean {
    return this.state.player.action === 'fly' || this.descending;
  }

  private tickTimers(dt: number): void {
    const p = this.state.player;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = Math.max(0, this.coyote - dt);
    this.laneBufT = Math.max(0, this.laneBufT - dt);
    this.stumbleAnim = Math.max(0, this.stumbleAnim - dt);
    this.laneChangeAge += dt;
    if (!this.descending) p.invulnerable = Math.max(0, (p.invulnerable ?? 0) - dt);
    p.stumbleWindow = Math.max(0, (p.stumbleWindow ?? 0) - dt);
    if (p.action === 'roll' && p.grounded) this.rollTimer -= dt;
  }

  // ------------------------------------------------------------------ input

  private handleInput(input: InputActions): void {
    const p = this.state.player;
    if (p.action === 'dead') return;
    const dir = input.left ? -1 : input.right ? 1 : 0;
    if (dir !== 0) {
      if (this.bouncing) {
        this.laneBufDir = dir;
        this.laneBufT = LANE_BUFFER;
      } else this.changeLane(dir);
    }
    if (this.isFlying()) return;
    if (input.jump) {
      if (p.grounded || this.coyote > 0) this.doJump();
      else this.jumpBuffer = JUMP_BUFFER;
    } else if (input.roll) {
      if (p.grounded) this.startRoll();
      else {
        p.vy = Math.min(p.vy, FAST_FALL_VY);
        this.rollQueued = true;
        this.jumpBuffer = 0;
        p.fastFall = true;
      }
    }
  }

  private changeLane(dir: number): void {
    const p = this.state.player;
    const next = p.lane + dir;
    if (next < -1 || next > 1) return;
    this.laneFromLane = p.lane;
    this.laneLeft = p.lane;
    this.laneChangeAge = 0;
    this.laneFromX = p.x;
    this.laneT = 0;
    p.lane = next as Lane;
    p.laneFrom = this.laneFromLane;
    this.state.stats!.laneChanges++;
    this.emit({ type: 'laneChange', dir: dir as -1 | 1 });
  }

  private doJump(): void {
    const p = this.state.player;
    p.vy = JUMP_VELOCITY;
    p.grounded = false;
    p.fastFall = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.rollQueued = false;
    this.rollTimer = 0;
    this.jumpStartY = p.y;
    this.peakY = p.y;
    p.action = 'jump';
    p.actionTime = 0;
    this.state.stats!.jumps++;
    this.emit({ type: 'jump' });
  }

  private startRoll(): void {
    const p = this.state.player;
    this.rollTimer = ROLL_TIME;
    p.action = 'roll';
    p.actionTime = 0;
    this.state.stats!.rolls++;
    this.emit({ type: 'roll' });
  }

  // ------------------------------------------------------------------ movement

  private updateLateral(dt: number): void {
    const p = this.state.player;
    const targetX = laneX(p.lane);
    if (this.laneT < 1) {
      this.laneT = Math.min(1, this.laneT + dt / LANE_CHANGE_TIME);
      const k = 1 - (1 - this.laneT) * (1 - this.laneT);
      p.x = this.laneFromX + (targetX - this.laneFromX) * k;
      if (this.laneT >= 1) {
        p.laneFrom = p.lane;
        if (this.bouncing) {
          this.bouncing = false;
          if (this.laneBufT > 0 && this.laneBufDir !== 0) this.changeLane(this.laneBufDir);
          this.laneBufDir = 0;
        }
      }
    } else {
      p.x = targetX;
    }
    const vx = (p.x - this.prevX) / dt;
    const leanTarget = Math.max(-1, Math.min(1, vx / (LANE_WIDTH / LANE_CHANGE_TIME)));
    p.lean += (leanTarget - p.lean) * Math.min(1, dt * 16);
  }

  /** Highest walkable surface top under (x, s) that is not above `maxTop` (0 = road). */
  private support(x: number, s: number, maxTop: number): number {
    let g = 0;
    for (const e of this.entities) {
      if (!e.walkable || !e.active) continue;
      const half = e.len / 2;
      if (s < e.s - half - 0.05 || s > e.s + half + 0.05) continue;
      const d = OBSTACLE_DIMS[e.kind as keyof typeof OBSTACLE_DIMS];
      if (Math.abs(x - e.x) > d.w / 2) continue;
      const top = e.kind === 'ramp' ? rampTop(e, s) : e.y + d.h;
      if (top <= maxTop && top > g) g = top;
    }
    return g;
  }

  private updateVertical(dt: number): void {
    const p = this.state.player;
    if (p.action === 'fly') {
      p.y += (BOOST_Y - p.y) * Math.min(1, BOOST_RISE_RATE * dt);
      p.vy = (p.y - this.prevY) / dt;
      p.grounded = false;
      p.groundY = this.support(p.x, p.s, p.y);
      return;
    }
    if (this.descending) {
      p.vy = BOOST_DESCENT_VY;
      p.y += p.vy * dt;
      const g = this.support(p.x, p.s, this.prevY + STEP_UP);
      p.groundY = g;
      if (p.y <= g) {
        this.descending = false;
        p.invulnerable = BOOST_LANDING_GRACE;
        this.peakY = g; // controlled: never a hard landing
        this.land(g);
      }
      return;
    }
    if (p.grounded) {
      const g = this.support(p.x, p.s, p.y + STEP_UP);
      p.groundY = g;
      if (g >= p.y - 0.05) {
        p.y = g;
        p.vy = 0;
        if (p.action === 'roll' && this.rollTimer <= 0) {
          if (this.headroomBlocked()) this.rollTimer = 0.02;
          else this.setAction(this.stumbleAnim > 0 ? 'stumble' : 'run');
        } else if (p.action === 'stumble' && this.stumbleAnim <= 0) this.setAction('run');
      } else {
        // Walked off a roof edge.
        p.grounded = false;
        p.vy = 0;
        this.coyote = COYOTE_TIME;
        this.peakY = p.y;
        this.rollTimer = 0;
        this.setAction('fall');
      }
      return;
    }
    p.vy -= GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.y > this.peakY) this.peakY = p.y;
    const g = this.support(p.x, p.s, Math.max(this.prevY, p.y) + STEP_UP);
    p.groundY = g;
    if (p.vy <= 0 && p.y <= g) this.land(g);
    else if (p.action === 'jump' && p.vy < 0 && p.y < this.jumpStartY - 0.5) this.setAction('fall');
  }

  private land(g: number): void {
    const p = this.state.player;
    const hard = this.peakY - g >= HARD_LAND_DROP;
    p.y = g;
    p.vy = 0;
    p.grounded = true;
    p.fastFall = false;
    this.emit({ type: 'land', hard });
    if (this.jumpBuffer > 0) this.doJump();
    else if (this.rollQueued) {
      this.rollQueued = false;
      this.startRoll();
    } else this.setAction(this.stumbleAnim > 0 ? 'stumble' : 'run');
  }

  /** True when standing up now would put the head into an overhead bar. */
  private headroomBlocked(): boolean {
    const p = this.state.player;
    for (const e of this.entities) {
      if (!e.active || e.kind !== 'overhead') continue;
      const d = OBSTACLE_DIMS.overhead;
      if (Math.abs(p.x - e.x) >= d.w / 2 + HALF_W) continue;
      // Also look a little ahead: standing up just before a bar would be an unavoidable crash.
      const ahead = Math.max(1, p.speed * 0.12);
      const rel = e.s - p.s;
      if (rel <= -(e.len / 2 + HALF_D + 0.4) || rel >= e.len / 2 + HALF_D + ahead) continue;
      if (p.y + PLAYER.height > e.y + d.solidFrom) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ collisions

  private collideObstacles(): void {
    const st = this.state;
    const p = st.player;
    const h = this.bodyHeight();
    const invuln = this.isFlying() || (p.invulnerable ?? 0) > 0;
    for (const e of this.entities) {
      if (!e.obstacle || !e.active) continue;
      const rel = p.s - e.s;
      if (rel < -20 || rel > e.len / 2 + 2) continue;
      const d = OBSTACLE_DIMS[e.kind as keyof typeof OBSTACLE_DIMS];
      const half = e.len / 2 + HALF_D;
      const prel = this.prevS - e.prevS;
      if (!e.passed && prel < 0 && rel >= 0) this.checkNearMiss(e, h);
      if (Math.min(rel, prel) >= half || Math.max(rel, prel) <= -half) continue;
      const wHalf = d.w / 2 + HALF_W;
      if (Math.abs(p.x - e.x) >= wHalf) continue;

      let top: number;
      let bottom: number;
      if (e.kind === 'ramp') {
        top = rampTop(e, p.s);
        bottom = e.y;
        if (p.y >= top - STEP_UP) continue;
      } else {
        top = e.y + d.h;
        bottom = e.y + d.solidFrom;
        if (p.y >= top - TOP_EPS || p.y + h <= bottom + TOP_EPS) continue;
        if (d.walkable && p.y >= top - STEP_UP && this.prevY >= top - STEP_UP) continue;
      }
      if (invuln || e.id === this.ignoreId) continue;

      // Classify the contact from the previous step's relation.
      const prevXOverlap = Math.abs(this.prevX - e.x) < wHalf;
      const prevSOverlap = Math.abs(prel) < half;
      e.passed = true;
      if (e.kind === 'ramp') {
        if (!prevXOverlap) this.stumble(e, 'side');
        else p.y = top;
        continue;
      }
      const fromAbove = this.prevY >= top - 0.05;
      const fromBelow = this.prevY + this.prevH <= bottom + 0.05;
      let lateralLast = false;
      if (!prevXOverlap && !prevSOverlap) {
        const fLat = (wHalf - Math.abs(p.x - e.x)) / (Math.abs(p.x - this.prevX) + 1e-9);
        const sMove = Math.abs(rel - prel) + 1e-9;
        const fS = Math.abs(rel) < half ? (half - Math.abs(rel)) / sMove : 1;
        lateralLast = fLat < fS;
      }
      if (fromAbove) this.stumble(e, 'vault');
      else if (fromBelow) this.stumble(e, 'bonk');
      else if (!prevXOverlap && (prevSOverlap || lateralLast)) this.stumble(e, 'side');
      else if (e.kind === 'hurdle' && !p.grounded && p.y > 0.15) this.stumble(e, 'vault');
      else this.crash(e);
      if (st.over) return;
    }
  }

  private checkNearMiss(e: SimEntity, h: number): void {
    const p = this.state.player;
    const d = OBSTACLE_DIMS[e.kind as keyof typeof OBSTACLE_DIMS];
    if (!d) return;
    const lc = Math.abs(p.x - e.x) - (d.w / 2 + HALF_W);
    const top = e.y + d.h;
    let near = false;
    if (e.kind === 'hurdle') {
      near = lc < 0 && p.y >= top && p.y - top < NEAR_MISS_VERTICAL;
    } else if (e.kind !== 'ramp') {
      const vOverlap = p.y < top - TOP_EPS && p.y + h > e.y + d.solidFrom;
      if (lc >= 0 && vOverlap) {
        if (lc < NEAR_MISS_LATERAL) near = true;
        else if (e.kind !== 'overhead' && e.lane === this.laneLeft && e.lane !== p.lane) {
          near = this.laneChangeAge < 0.35 + e.len / 2 / Math.max(1, p.speed - e.vs);
        }
      }
    }
    e.passed = true;
    if (near && !this.isFlying()) {
      this.state.stats!.nearMisses++;
      this.bonusScore += NEAR_MISS_BONUS * this.state.multiplier;
      this.emit({ type: 'nearMiss' });
    }
  }

  private stumble(e: SimEntity, mode: 'side' | 'vault' | 'bonk'): void {
    const st = this.state;
    const p = st.player;
    st.stats!.stumbles++;
    this.ignoreId = e.id;
    if ((p.stumbleWindow ?? 0) > 0) {
      if (st.powerups.shield > 0) {
        this.consumeShield(e, false);
      } else {
        st.chaser.gap = 0.8;
        st.chaser.visible = true;
        this.gameOver('caught');
        return;
      }
    } else {
      p.stumbleWindow = STUMBLE_WINDOW;
      this.stumbleAnim = STUMBLE_TIME;
      // The drone swoops in from behind the camera.
      st.chaser.gap = Math.min(st.chaser.gap, CHASER_SWOOP_GAP);
      this.emit({ type: 'stumble' });
    }
    if (mode === 'side') {
      // Bounce back toward the lane we came from.
      const back = this.laneFromLane;
      if (back !== p.lane) {
        this.laneFromLane = p.lane;
        p.laneFrom = p.lane;
        p.lane = back;
        this.laneFromX = p.x;
        this.laneT = 0;
        this.bouncing = true;
      }
    } else if (mode === 'vault') {
      const d = OBSTACLE_DIMS[e.kind as keyof typeof OBSTACLE_DIMS];
      p.y = Math.max(p.y, e.y + d.h);
      p.vy = Math.max(p.vy, CLIP_BOUNCE_VY);
      p.grounded = false;
      this.peakY = p.y;
      this.jumpStartY = p.y;
    } else {
      p.vy = Math.min(p.vy, 0);
    }
    if (p.action !== 'roll') this.setAction('stumble');
  }

  private consumeShield(e: SimEntity, knockOut: boolean): void {
    const st = this.state;
    st.powerups.shield = 0;
    st.stats!.shieldSaves++;
    if (knockOut) e.active = false;
    st.player.invulnerable = Math.max(st.player.invulnerable ?? 0, SHIELD_INVULN);
    this.emit({ type: 'shieldBreak', id: e.id });
  }

  private crash(e: SimEntity): void {
    if (this.state.powerups.shield > 0) {
      this.consumeShield(e, true);
      return;
    }
    this.gameOver('crash');
  }

  private gameOver(reason: GameOverReason): void {
    const st = this.state;
    st.over = true;
    st.player.vy = 0;
    this.setAction('dead');
    this.emit({ type: 'gameOver', reason });
  }

  // ------------------------------------------------------------------ pickups

  private collectPickups(dt: number): void {
    const st = this.state;
    const p = st.player;
    const h = this.bodyHeight();
    const cy = p.y + h / 2;
    const magnet = st.powerups.magnet > 0;
    const r2 = MAGNET_RADIUS * MAGNET_RADIUS;
    const reachS = PICKUP_RADIUS + HALF_D;
    for (const e of this.entities) {
      if (e.obstacle || !e.active) continue;
      if (!e.magnet && !magnet && (e.s - p.s > 3 || p.s - e.s > 3)) continue;
      if (e.kind === 'coin') {
        if (magnet && !e.magnet) {
          const dx = p.x - e.x;
          const dy = cy - (e.y + PICKUP_HOVER);
          const dz = p.s - e.s;
          if (dx * dx + dy * dy + dz * dz < r2) e.magnet = true;
        }
        if (e.magnet) {
          e.s += p.speed * dt;
          const dx = p.x - e.x;
          const dy = cy - (e.y + PICKUP_HOVER);
          const dz = p.s - e.s;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const step = MAGNET_PULL_SPEED * dt;
          if (dist <= step + PICKUP_RADIUS) {
            this.collect(e);
            continue;
          }
          const k = step / dist;
          e.x += dx * k;
          e.y += dy * k;
          e.s += dz * k;
        }
      }
      const rel = p.s - e.s;
      const prel = this.prevS - e.prevS;
      if (Math.min(rel, prel) >= reachS || Math.max(rel, prel) <= -reachS) continue;
      if (Math.abs(p.x - e.x) >= PICKUP_RADIUS + HALF_W) continue;
      const c = e.y + PICKUP_HOVER;
      if (p.y + h <= c - PICKUP_RADIUS || p.y >= c + PICKUP_RADIUS) continue;
      this.collect(e);
    }
  }

  private collect(e: SimEntity): void {
    const st = this.state;
    e.active = false;
    if (e.kind === 'coin') {
      st.coins++;
      this.bonusScore += COIN_SCORE_BONUS * st.multiplier;
      this.emit({ type: 'coin', id: e.id, x: e.x, y: e.y, s: e.s, total: st.coins });
    } else if (isPowerupKind(e.kind)) {
      this.activatePowerup(e.kind);
    }
  }

  private activatePowerup(kind: PowerupKind): void {
    const st = this.state;
    st.powerups[kind] = POWERUP_DURATION[kind];
    st.stats!.powerups++;
    this.emit({ type: 'pickup', kind });
    if (kind === 'boost') this.startBoost();
  }

  private startBoost(): void {
    const st = this.state;
    const p = st.player;
    this.descending = false;
    this.rollQueued = false;
    this.jumpBuffer = 0;
    this.rollTimer = 0;
    p.fastFall = false;
    p.grounded = false;
    this.setAction('fly');
    if (!this.generation) return;
    // Guarantee an empty landing stretch and lay coin lines along the flight path.
    const t0 = st.time;
    const t1 = t0 + POWERUP_DURATION.boost;
    const sEnd = p.s + distanceAt(t1) - distanceAt(t0);
    const tLand = t1 + BOOST_DESCENT_TIME;
    const sLand = sEnd + distanceAt(tLand) - distanceAt(t1);
    const sSafe = sLand + distanceAt(tLand + BOOST_LANDING_GRACE + 0.8) - distanceAt(tLand);
    this.gen.clearRange(sEnd - 6, sSafe + 4, this.entities);
    const from = Math.max(p.s + p.speed * 1.0, this.airCoinsUntil);
    if (sEnd - 4 > from) this.gen.planAirCoins(from, sEnd - 4, p.lane);
    this.airCoinsUntil = sEnd - 4;
  }

  private updatePowerups(dt: number): void {
    const pw = this.state.powerups;
    for (const k of POWERUP_KINDS) {
      if (k === 'shield' || pw[k] <= 0) continue;
      pw[k] = Math.max(0, pw[k] - dt);
      if (pw[k] === 0) {
        this.emit({ type: 'powerupEnd', kind: k });
        if (k === 'boost') this.startDescent();
      }
    }
  }

  private startDescent(): void {
    const p = this.state.player;
    if (p.action !== 'fly' || this.state.over) return;
    this.descending = true;
    p.vy = BOOST_DESCENT_VY;
    p.invulnerable = BOOST_DESCENT_TIME + BOOST_LANDING_GRACE;
    this.setAction('fall');
  }

  // ------------------------------------------------------------------ chaser, track, zone

  private updateChaser(dt: number): void {
    const st = this.state;
    const c = st.chaser;
    const p = st.player;
    let target = CHASER_FAR_GAP;
    if (p.action === 'fly' || this.descending) target = CHASER_FAR_GAP;
    else if (this.stumbleAnim > 0) target = CHASER_STUMBLE_GAP;
    else if ((p.stumbleWindow ?? 0) > 0) target = CHASER_WARN_GAP;
    else if (st.time < CHASER_INTRO_TIME) target = CHASER_START_GAP;
    if (c.gap > target) c.gap = Math.max(target, c.gap - CHASER_CLOSE_SPEED * dt);
    else c.gap = Math.min(target, c.gap + CHASER_DRIFT_SPEED * dt);
    c.visible = c.gap < CHASER_FAR_GAP - 0.01;
  }

  private despawn(): void {
    const p = this.state.player;
    const list = this.entities;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.active && e.s + e.len / 2 >= p.s - DESPAWN_BEHIND) {
        list[w++] = e;
      } else {
        this.emit({ type: 'despawn', id: e.id });
        this.releaseQueue.push(e);
      }
    }
    list.length = w;
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
}
