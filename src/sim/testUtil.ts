// Shared helpers for the sim tests (not shipped: only imported by *.test.ts files).
import { MAX_SIM_STEP } from './config';
import type { GameSim } from './sim';
import type { InputActions, SimEvent } from './types';

export const NONE: InputActions = { left: false, right: false, jump: false, roll: false };
export const JUMP: InputActions = { ...NONE, jump: true };
export const ROLL: InputActions = { ...NONE, roll: true };
export const LEFT: InputActions = { ...NONE, left: true };
export const RIGHT: InputActions = { ...NONE, right: true };

/** Steps `seconds` at MAX_SIM_STEP; `input` is applied on the first step only. Returns all events. */
export function step(sim: GameSim, seconds: number, input: InputActions = NONE, dt = MAX_SIM_STEP): SimEvent[] {
  const out: SimEvent[] = [];
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) {
    sim.update(dt, i === 0 ? input : NONE);
    out.push(...sim.drainEvents());
    if (sim.state.over) break;
  }
  return out;
}

/** Steps until the player reaches distance `s` (or the run ends). */
export function runTo(sim: GameSim, s: number, input: InputActions = NONE): SimEvent[] {
  const out: SimEvent[] = [];
  let first = true;
  while (sim.state.player.s < s && !sim.state.over) {
    sim.update(MAX_SIM_STEP, first ? input : NONE);
    first = false;
    out.push(...sim.drainEvents());
  }
  return out;
}

export function types(events: readonly SimEvent[]): string[] {
  return events.map((e) => e.type);
}
