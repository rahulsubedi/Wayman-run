// Shared gameplay contracts. Pure types: no runtime code, no pixi, no DOM.
// Every other module may import from here (view, ui, audio, input), so keep it dependency-free.

export type Lane = -1 | 0 | 1;

export type ObstacleKind = 'hurdle' | 'overhead' | 'blocker' | 'truck' | 'bus' | 'busOncoming' | 'ramp';
export type PowerupKind = 'magnet' | 'shield' | 'boost' | 'multiplier';
export type PickupKind = 'coin' | PowerupKind;
export type EntityKind = ObstacleKind | PickupKind;

/** A track entity. `s` = centre along the track, `y` = base height (0 = road, ROOF_Y = on a roof). */
export interface Entity {
  id: number;
  kind: EntityKind;
  lane: Lane;
  x: number;
  s: number;
  y: number;
  len: number;
  active: boolean;
  /** Own velocity along s in m/s (negative = driving toward the player, e.g. busOncoming). Always set by the sim. */
  vs?: number;
  /** Deterministic integer 0..7 for visual variety (paint colour, sign text ...). Always set by the sim. */
  variant?: number;
  /** True while a coin is being pulled by the magnet (its x/y/s move toward the player). */
  magnet?: boolean;
}

export type PlayerAction = 'run' | 'jump' | 'fall' | 'roll' | 'fly' | 'stumble' | 'dead';

export interface PlayerState {
  s: number;
  x: number;
  y: number;
  vy: number;
  /** Target lane (the lane being moved to during a lane change). */
  lane: Lane;
  action: PlayerAction;
  /** Seconds since `action` last changed. */
  actionTime: number;
  grounded: boolean;
  speed: number;
  /** -1..1 lateral motion, for body lean. */
  lean: number;
  /** Radians, advances with distance, drives the run cycle. */
  runPhase: number;
  /** Height of the surface under the player (0 = road, ROOF_Y on a roof, in between on a ramp). */
  groundY?: number;
  /** Seconds of invulnerability left (shield hit, boost descent + landing grace). Blink while > 0. */
  invulnerable?: number;
  /** Seconds left in which another stumble means game over ('caught'). 0 = safe. */
  stumbleWindow?: number;
  /** True while diving (roll pressed in the air). */
  fastFall?: boolean;
  /** Lane the player is moving away from (equals `lane` when not changing lanes). */
  laneFrom?: Lane;
}

/** `gap` = metres behind the player. */
export interface ChaserState {
  gap: number;
  visible: boolean;
}

export interface SimState {
  time: number;
  player: PlayerState;
  chaser: ChaserState;
  entities: readonly Entity[];
  score: number;
  coins: number;
  multiplier: number;
  /** Seconds remaining (shield: 1 = held, 0 = none). */
  powerups: Record<PowerupKind, number>;
  /** Zone index 0..ZONE_COUNT-1. */
  zone: number;
  /** 0..1 blend toward the next zone. */
  zoneBlend: number;
  over: boolean;
  /** Metres run (same as player.s). */
  distance?: number;
  /** Current difficulty tier 0..4 of the generator at the player's position. */
  tier?: number;
  /** Per-run counters for the game-over screen. */
  stats?: RunStats;
}

export interface RunStats {
  jumps: number;
  rolls: number;
  laneChanges: number;
  nearMisses: number;
  stumbles: number;
  powerups: number;
  shieldSaves: number;
  roofMetres: number;
}

/** Edge-triggered: true only for the frame on which the action was requested. */
export interface InputActions {
  left: boolean;
  right: boolean;
  jump: boolean;
  roll: boolean;
}

export type GameOverReason = 'crash' | 'caught';

export type SimEvent =
  | { type: 'spawn'; entity: Entity }
  | { type: 'despawn'; id: number }
  | { type: 'coin'; id: number; x: number; y: number; s: number; total: number }
  | { type: 'pickup'; kind: PowerupKind }
  | { type: 'powerupEnd'; kind: PowerupKind }
  | { type: 'jump' }
  | { type: 'land'; hard: boolean }
  | { type: 'roll' }
  | { type: 'laneChange'; dir: -1 | 1 }
  | { type: 'stumble' }
  | { type: 'shieldBreak'; id: number }
  | { type: 'nearMiss' }
  | { type: 'zone'; index: number }
  | { type: 'gameOver'; reason: GameOverReason };

export type SimEventType = SimEvent['type'];

/**
 * Render quality tier. Lives here (not in view/stage.ts) because the UI also needs it and
 * ui/ may only import types/config from sim/. `view/stage.ts` re-exports it.
 */
export type Quality = 'low' | 'medium' | 'high';
