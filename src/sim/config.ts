// Gameplay constants (brief section 5). Shared by the sim (colliders) and the view (model sizes).
import type { Lane, ObstacleKind, PickupKind, PowerupKind } from './types';

// ---- Track layout (metres; +X right, +Y up, run direction -Z) ----
export const LANE_WIDTH = 2.5;
export const LANES: readonly Lane[] = [-1, 0, 1];
/** Road spans x in [-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH]. */
export const ROAD_HALF_WIDTH = 4.5;
/** Sidewalks run from the road edge to |x| = SIDEWALK_OUTER; buildings start beyond. */
export const SIDEWALK_OUTER = 8;
/** Top of walkable vehicles. Unreachable by a plain jump. */
export const ROOF_Y = 2.8;

export function laneX(lane: Lane): number {
  return lane * LANE_WIDTH;
}

// ---- Speed curve: v = START + RANGE * (1 - exp(-t / TAU)) ----
export const SPEED_START = 13;
export const SPEED_MAX = 30;
export const SPEED_TAU = 90;

export function speedAt(runSeconds: number): number {
  return SPEED_START + (SPEED_MAX - SPEED_START) * (1 - Math.exp(-runSeconds / SPEED_TAU));
}

// ---- Player movement ----
export const LANE_CHANGE_TIME = 0.12;
export const GRAVITY = 38;
export const JUMP_VELOCITY = 12.3;
export const ROLL_TIME = 0.65;
export const FAST_FALL_VY = -25;
/** Landing faster than this (downwards, m/s) counts as a hard landing. */
export const HARD_LAND_VY = -16;
/** Run-cycle radians per metre (one full stride cycle ≈ 2.6 m). */
export const RUN_PHASE_PER_METRE = (Math.PI * 2) / 2.6;

export const PLAYER = {
  width: 0.8,
  depth: 0.6,
  height: 1.8,
  rollHeight: 0.8,
} as const;

// ---- Entities ----
export const SPAWN_AHEAD = 140;
export const DESPAWN_BEHIND = 12;
/** The first metres of a run are empty. */
export const START_SAFE_DISTANCE = 60;
/** Generation must never require a reaction faster than this (seconds). */
export const MIN_REACTION_TIME = 0.45;

export interface ObstacleDims {
  /** Width (x). */
  w: number;
  /** Height (y) above the entity base. */
  h: number;
  /** Length along the track (s / local Z). */
  len: number;
  /** The collider is solid only from this height above the base (overhead gantries). */
  solidFrom: number;
  /** Roof can be stood on. */
  walkable: boolean;
}

export const OBSTACLE_DIMS: Readonly<Record<ObstacleKind, Readonly<ObstacleDims>>> = {
  hurdle: { w: 2.0, h: 0.9, len: 0.4, solidFrom: 0, walkable: false },
  overhead: { w: 2.2, h: 2.6, len: 0.5, solidFrom: 1.2, walkable: false },
  blocker: { w: 2.0, h: 2.4, len: 0.6, solidFrom: 0, walkable: false },
  truck: { w: 2.1, h: ROOF_Y, len: 6, solidFrom: 0, walkable: true },
  bus: { w: 2.1, h: ROOF_Y, len: 10, solidFrom: 0, walkable: true },
  busOncoming: { w: 2.1, h: ROOF_Y, len: 10, solidFrom: 0, walkable: true },
  ramp: { w: 2.1, h: ROOF_Y, len: 6, solidFrom: 0, walkable: true },
};

/** Own speed of `busOncoming` toward the player (m/s). */
export const ONCOMING_SPEED = 8;

/** Pickups: the model's visual centre floats this high above the entity base. */
export const PICKUP_HOVER = 0.9;
/** Pickup collision radius (sphere-ish, around the hover centre). */
export const PICKUP_RADIUS = 0.6;
/** Spacing of coins in a line (metres). */
export const COIN_SPACING = 2.4;

export const PICKUP_LEN: Readonly<Record<PickupKind, number>> = {
  coin: 0.6,
  magnet: 1,
  shield: 1,
  boost: 1,
  multiplier: 1,
};

export const POWERUP_DURATION: Readonly<Record<PowerupKind, number>> = {
  magnet: 10,
  shield: 1, // held until used
  boost: 7,
  multiplier: 12,
};
export const MAGNET_RADIUS = 6;
export const BOOST_Y = 7;
export const BOOST_LANDING_GRACE = 1.5;

// ---- Hits ----
export const STUMBLE_TIME = 0.6;
/** A second stumble within this many seconds is game over ('caught'). */
export const STUMBLE_WINDOW = 6;

// ---- Chaser ----
export const CHASER_START_GAP = 4;
export const CHASER_FAR_GAP = 30;

// ---- Score ----
export const COIN_SCORE_BONUS = 10;

// ---- Zones ----
export const ZONE_LENGTH = 500;
export const ZONE_COUNT = 3;
export const ZONE_NAMES = ['market', 'harbor', 'night'] as const;
export type ZoneName = (typeof ZONE_NAMES)[number];
/** zoneBlend ramps 0 -> 1 over the last ZONE_BLEND_LENGTH metres of each zone. */
export const ZONE_BLEND_LENGTH = 80;

// ---- Simulation ----
/** Largest step GameSim.update should be called with. */
export const MAX_SIM_STEP = 1 / 120;
