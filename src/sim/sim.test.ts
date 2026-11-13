import { describe, expect, it } from 'vitest';
import { MAX_SIM_STEP, OBSTACLE_DIMS, speedAt } from './config';
import { GameSim } from './sim';
import type { Entity, InputActions, SimEvent } from './types';

const NONE: InputActions = { left: false, right: false, jump: false, roll: false };

function step(sim: GameSim, seconds: number, input: InputActions = NONE): SimEvent[] {
  const out: SimEvent[] = [];
  const n = Math.round(seconds / MAX_SIM_STEP);
  for (let i = 0; i < n; i++) {
    sim.update(MAX_SIM_STEP, i === 0 ? input : NONE);
    out.push(...sim.drainEvents());
  }
  return out;
}

/** Remove generated content and place exactly what a test needs. */
function clearTrack(sim: GameSim): Entity[] {
  const list = sim.state.entities as Entity[];
  list.length = 0;
  return list;
}

describe('GameSim', () => {
  it('is deterministic for a seed', () => {
    const a = new GameSim(42);
    const b = new GameSim(42);
    const c = new GameSim(7);
    const sig = (s: GameSim) => s.state.entities.map((e) => `${e.kind}@${e.lane}:${e.s.toFixed(2)}`).join('|');
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).not.toBe(sig(c));
    step(a, 3);
    step(b, 3);
    expect(a.state.player.s).toBeCloseTo(b.state.player.s, 9);
    expect(sig(a)).toBe(sig(b));
    a.reset(42);
    b.reset(42);
    expect(sig(a)).toBe(sig(b));
  });

  it('follows the speed curve', () => {
    expect(speedAt(0)).toBe(13);
    expect(speedAt(1e6)).toBeCloseTo(30, 5);
    const sim = new GameSim(1);
    clearTrack(sim);
    step(sim, 1);
    expect(sim.state.player.s).toBeGreaterThan(13);
    expect(sim.state.player.s).toBeLessThan(13.2);
  });

  it('starts with an empty safe zone and spawns ahead', () => {
    const sim = new GameSim(3);
    expect(sim.state.entities.length).toBeGreaterThan(0);
    for (const e of sim.state.entities) expect(e.s).toBeGreaterThanOrEqual(50);
  });

  it('jump clears a hurdle; running into it is game over', () => {
    const jumper = new GameSim(1);
    clearTrack(jumper).push({ id: 999, kind: 'hurdle', lane: 0, x: 0, s: 8, y: 0, len: OBSTACLE_DIMS.hurdle.len, active: true });
    step(jumper, 0.35); // reach ~4.5 m
    step(jumper, 1.0, { ...NONE, jump: true });
    expect(jumper.state.over).toBe(false);
    expect(jumper.state.player.s).toBeGreaterThan(9);

    const runner = new GameSim(1);
    clearTrack(runner).push({ id: 999, kind: 'hurdle', lane: 0, x: 0, s: 8, y: 0, len: OBSTACLE_DIMS.hurdle.len, active: true });
    const ev = step(runner, 1.2);
    expect(runner.state.over).toBe(true);
    expect(ev.some((e) => e.type === 'gameOver')).toBe(true);
  });

  it('roll passes under an overhead bar', () => {
    const sim = new GameSim(1);
    clearTrack(sim).push({ id: 5, kind: 'overhead', lane: 0, x: 0, s: 6, y: 0, len: OBSTACLE_DIMS.overhead.len, active: true });
    step(sim, 0.2);
    step(sim, 0.6, { ...NONE, roll: true });
    expect(sim.state.over).toBe(false);
  });

  it('lane change moves to the next lane and emits laneChange', () => {
    const sim = new GameSim(1);
    clearTrack(sim);
    const ev = step(sim, 0.3, { ...NONE, right: true });
    expect(sim.state.player.lane).toBe(1);
    expect(sim.state.player.x).toBeCloseTo(2.5, 5);
    expect(ev).toContainEqual({ type: 'laneChange', dir: 1 });
  });

  it('collects coins and despawns them', () => {
    const sim = new GameSim(1);
    clearTrack(sim).push({ id: 77, kind: 'coin', lane: 0, x: 0, s: 5, y: 0, len: 0.6, active: true });
    const ev = step(sim, 0.6);
    expect(sim.state.coins).toBe(1);
    expect(ev.find((e) => e.type === 'coin')).toMatchObject({ type: 'coin', id: 77, total: 1 });
    expect(ev).toContainEqual({ type: 'despawn', id: 77 });
    expect(sim.state.score).toBeGreaterThanOrEqual(10);
  });

  it('progresses zones with a blend', () => {
    const sim = new GameSim(1);
    const p = sim.state.player;
    clearTrack(sim);
    p.s = 480;
    step(sim, MAX_SIM_STEP);
    expect(sim.state.zone).toBe(0);
    expect(sim.state.zoneBlend).toBeGreaterThan(0.5);
    clearTrack(sim);
    p.s = 501;
    const ev = step(sim, MAX_SIM_STEP);
    expect(sim.state.zone).toBe(1);
    expect(ev).toContainEqual({ type: 'zone', index: 1 });
  });
});
