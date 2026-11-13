import { describe, expect, it } from 'vitest';
import { autopilot } from './autopilot';
import {
  BOOST_Y,
  CHASER_FAR_GAP,
  FAST_FALL_VY,
  MAX_SIM_STEP,
  OBSTACLE_DIMS,
  POWERUP_DURATION,
  ROOF_Y,
  START_SAFE_DISTANCE,
  distanceAt,
  speedAt,
} from './config';
import { GameSim } from './sim';
import { JUMP, LEFT, NONE, RIGHT, ROLL, runTo, step, types } from './testUtil';
import type { SimEvent } from './types';

function bare(seed = 1): GameSim {
  const sim = new GameSim(seed);
  sim.clearTrack();
  sim.drainEvents();
  return sim;
}

function overReason(events: SimEvent[]): string | null {
  const e = events.find((x) => x.type === 'gameOver');
  return e && e.type === 'gameOver' ? e.reason : null;
}

describe('determinism', () => {
  it('same seed + same inputs give identical runs; reset reproduces', () => {
    const run = (sim: GameSim) => {
      const log: string[] = [];
      for (let i = 0; i < 120 * 40 && !sim.state.over; i++) {
        sim.update(MAX_SIM_STEP, i % 4 === 0 ? autopilot(sim.state) : NONE);
        for (const e of sim.drainEvents()) log.push(e.type === 'spawn' ? `spawn:${e.entity.kind}@${e.entity.lane}:${e.entity.s.toFixed(3)}` : JSON.stringify(e));
      }
      return { log: log.join('\n'), state: JSON.stringify(sim.state) };
    };
    const a = run(new GameSim(42));
    const b = run(new GameSim(42));
    expect(a.state).toBe(b.state);
    expect(a.log).toBe(b.log);
    const c = new GameSim(7);
    c.reset(42);
    expect(run(c).state).toBe(a.state);
    expect(run(new GameSim(43)).log).not.toBe(a.log);
  });
});

describe('basics', () => {
  it('follows the speed curve and the closed-form distance', () => {
    expect(speedAt(0)).toBe(13);
    expect(speedAt(1e6)).toBeCloseTo(30, 5);
    const sim = bare();
    step(sim, 10);
    expect(sim.state.player.s).toBeCloseTo(distanceAt(10), 1);
    expect(sim.state.distance).toBe(sim.state.player.s);
  });

  it('starts with an empty safe zone and spawns ahead', () => {
    for (const seed of [1, 2, 3]) {
      const sim = new GameSim(seed);
      expect(sim.state.entities.length).toBeGreaterThan(0);
      for (const e of sim.state.entities) {
        if (e.kind === 'coin') expect(e.s).toBeGreaterThanOrEqual(30);
        else expect(e.s - e.len / 2).toBeGreaterThanOrEqual(START_SAFE_DISTANCE);
      }
    }
  });

  it('shows the chaser at the start, then it drifts out of view', () => {
    const sim = bare();
    expect(sim.state.chaser.visible).toBe(true);
    step(sim, 1);
    expect(sim.state.chaser.visible).toBe(true);
    step(sim, 5);
    expect(sim.state.chaser.visible).toBe(false);
    expect(sim.state.chaser.gap).toBe(CHASER_FAR_GAP);
  });

  it('progresses zones with a blend', () => {
    const sim = bare();
    const p = sim.state.player;
    p.s = 480;
    step(sim, MAX_SIM_STEP);
    expect(sim.state.zone).toBe(0);
    expect(sim.state.zoneBlend).toBeGreaterThan(0.5);
    p.s = 501;
    const ev = step(sim, MAX_SIM_STEP);
    expect(sim.state.zone).toBe(1);
    expect(ev).toContainEqual({ type: 'zone', index: 1 });
  });

  it('collects coins, scores them and despawns them', () => {
    const sim = bare();
    const c = sim.placeEntity('coin', 0, 5);
    const ev = step(sim, 0.6);
    expect(sim.state.coins).toBe(1);
    expect(ev.find((e) => e.type === 'coin')).toMatchObject({ type: 'coin', id: c.id, total: 1 });
    expect(ev).toContainEqual({ type: 'despawn', id: c.id });
    expect(sim.state.score).toBeGreaterThanOrEqual(10);
  });
});

describe('player controller', () => {
  it('changes lanes with a 0.12 s tween and chains presses', () => {
    const sim = bare();
    const ev = step(sim, 0.3, RIGHT);
    expect(sim.state.player.lane).toBe(1);
    expect(sim.state.player.x).toBeCloseTo(2.5, 5);
    expect(ev).toContainEqual({ type: 'laneChange', dir: 1 });
    step(sim, 0.05, LEFT);
    step(sim, 0.03, LEFT);
    expect(sim.state.player.lane).toBe(-1);
    step(sim, 0.2);
    expect(sim.state.player.x).toBeCloseTo(-2.5, 5);
    // Pressing outward at the edge does nothing.
    const ev2 = step(sim, 0.1, LEFT);
    expect(types(ev2)).not.toContain('laneChange');
  });

  it('jumps (apex ~2 m, ~0.65 s airtime) and lands softly', () => {
    const sim = bare();
    const ev = step(sim, 0.33, JUMP);
    expect(types(ev)).toContain('jump');
    expect(sim.state.player.y).toBeGreaterThan(1.9);
    const ev2 = step(sim, 0.4);
    expect(sim.state.player.grounded).toBe(true);
    expect(ev2).toContainEqual({ type: 'land', hard: false });
    expect(sim.state.player.action).toBe('run');
  });

  it('buffers a jump pressed just before landing', () => {
    const sim = bare();
    step(sim, 0.6, JUMP); // still airborne (~0.05 s left)
    expect(sim.state.player.grounded).toBe(false);
    const ev = step(sim, 0.2, JUMP);
    expect(types(ev).filter((t) => t === 'jump').length).toBe(1);
    expect(sim.state.player.y).toBeGreaterThan(0.5);
  });

  it('roll lasts 0.65 s; roll in the air fast-falls and rolls on landing', () => {
    const sim = bare();
    step(sim, 0.3, ROLL);
    expect(sim.state.player.action).toBe('roll');
    step(sim, 0.4);
    expect(sim.state.player.action).toBe('run');
    step(sim, 0.2, JUMP);
    step(sim, MAX_SIM_STEP, ROLL);
    expect(sim.state.player.vy).toBeLessThanOrEqual(FAST_FALL_VY);
    expect(sim.state.player.fastFall).toBe(true);
    const ev = step(sim, 0.2);
    expect(types(ev)).toEqual(expect.arrayContaining(['land', 'roll']));
    expect(sim.state.player.action).toBe('roll');
  });

  it('can jump out of a roll', () => {
    const sim = bare();
    step(sim, 0.1, ROLL);
    step(sim, 0.1, JUMP);
    expect(sim.state.player.action).toBe('jump');
    expect(sim.state.player.y).toBeGreaterThan(0.5);
  });
});

describe('obstacles', () => {
  it('jump clears a hurdle; running or rolling into it is a crash', () => {
    const jumper = bare();
    jumper.placeEntity('hurdle', 0, 8);
    step(jumper, 0.3);
    step(jumper, 1.0, JUMP);
    expect(jumper.state.over).toBe(false);
    expect(jumper.state.player.s).toBeGreaterThan(9);

    const runner = bare();
    runner.placeEntity('hurdle', 0, 8);
    expect(overReason(step(runner, 1.2))).toBe('crash');

    const roller = bare();
    roller.placeEntity('hurdle', 0, 8);
    step(roller, 0.3, ROLL);
    expect(overReason(step(roller, 1))).toBe('crash');
  });

  it('clipping a hurdle low while airborne is a stumble, not a crash', () => {
    const sim = bare();
    sim.placeEntity('hurdle', 0, 6);
    runTo(sim, 5.1);
    const p = sim.state.player;
    p.grounded = false;
    p.y = 0.5;
    p.vy = 0;
    const ev = step(sim, 0.5);
    expect(types(ev)).toContain('stumble');
    expect(sim.state.over).toBe(false);
    expect(sim.state.player.s).toBeGreaterThan(7);
  });

  it('roll passes under an overhead; standing or jumping into it crashes', () => {
    const sim = bare();
    sim.placeEntity('overhead', 0, 6);
    step(sim, 0.2);
    step(sim, 0.6, ROLL);
    expect(sim.state.over).toBe(false);

    const run = bare();
    run.placeEntity('overhead', 0, 6);
    expect(overReason(step(run, 1))).toBe('crash');

    const jump = bare();
    jump.placeEntity('overhead', 0, 8);
    step(jump, 0.3);
    expect(overReason(step(jump, 1, JUMP))).toBe('crash');
  });

  it('keeps rolling while an overhead is above (never stands up into it)', () => {
    const sim = bare();
    step(sim, 0.05, ROLL);
    // The roll would end around s = 9.4; put a bar right there.
    const end = sim.state.player.s + 0.65 * sim.state.player.speed;
    sim.placeEntity('overhead', 0, end + 0.2);
    const ev = step(sim, 1.2);
    expect(types(ev)).not.toContain('stumble');
    expect(sim.state.over).toBe(false);
  });

  it('a blocker must be dodged by changing lane', () => {
    const crash = bare();
    crash.placeEntity('blocker', 0, 15);
    expect(overReason(step(crash, 2))).toBe('crash');

    const dodge = bare();
    dodge.placeEntity('blocker', 0, 15);
    step(dodge, 0.5, LEFT);
    step(dodge, 1.5);
    expect(dodge.state.over).toBe(false);
  });

  it('running into a vehicle front is a crash', () => {
    for (const kind of ['truck', 'bus'] as const) {
      const sim = bare();
      sim.placeEntity(kind, 0, 20);
      expect(overReason(step(sim, 2))).toBe('crash');
    }
  });

  it('landing on a vehicle roof from above is safe; walking off it is a hard fall', () => {
    const sim = bare();
    sim.placeEntity('truck', 0, 20);
    runTo(sim, 16);
    const p = sim.state.player;
    p.grounded = false;
    p.y = 4;
    p.vy = 0;
    const ev = step(sim, 0.4);
    expect(sim.state.over).toBe(false);
    expect(types(ev)).toContain('land');
    expect(p.y).toBeCloseTo(ROOF_Y, 5);
    expect(p.groundY).toBeCloseTo(ROOF_Y, 5);
    expect(p.grounded).toBe(true);
    const ev2 = runTo(sim, 23.2);
    expect(sim.state.over).toBe(false);
    step(sim, MAX_SIM_STEP * 3);
    expect(p.action).toBe('fall');
    const ev3 = step(sim, 0.6);
    expect(types(ev2)).not.toContain('gameOver');
    expect(ev3).toContainEqual({ type: 'land', hard: true });
  });

  it('runs up a ramp onto a bus roof, across a chain gap, and back down to the road', () => {
    const sim = bare();
    const ramp = sim.placeEntity('ramp', 0, 13); // 10..16
    sim.placeEntity('bus', 0, 16 + 5); // 16..26
    sim.placeEntity('truck', 0, 26.8 + 3); // 26.8..32.8 (0.8 m gap)
    runTo(sim, 13);
    const p = sim.state.player;
    expect(p.y).toBeGreaterThan(1.0);
    expect(p.y).toBeLessThan(ROOF_Y);
    expect(p.y).toBeCloseTo(((p.s - (ramp.s - 3)) / 6) * ROOF_Y, 1);
    runTo(sim, 24);
    expect(p.y).toBeCloseTo(ROOF_Y, 5);
    runTo(sim, 30);
    expect(sim.state.over).toBe(false);
    expect(p.y).toBeCloseTo(ROOF_Y, 5);
    const ev = runTo(sim, 45);
    expect(sim.state.over).toBe(false);
    expect(p.y).toBe(0);
    expect(types(ev)).toContain('land');
    expect(sim.state.stats!.roofMetres).toBeGreaterThan(15);
  });

  it('jumps or steps between roofs in neighbouring lanes', () => {
    const sim = bare();
    sim.placeEntity('ramp', 0, 13);
    sim.placeEntity('bus', 0, 21); // 16..26
    sim.placeEntity('bus', 1, 24); // 19..29
    runTo(sim, 21);
    const ev = step(sim, 0.3, RIGHT);
    expect(types(ev)).not.toContain('stumble');
    expect(sim.state.player.x).toBeCloseTo(2.5, 5);
    expect(sim.state.player.y).toBeCloseTo(ROOF_Y, 1);
    runTo(sim, 28);
    expect(sim.state.player.y).toBeCloseTo(ROOF_Y, 5);
    expect(sim.state.over).toBe(false);
  });

  it('a side hit during a lane change is a stumble with a bounce back; the chaser closes in', () => {
    const sim = bare();
    step(sim, 6); // let the intro chaser leave
    expect(sim.state.chaser.visible).toBe(false);
    const s = sim.state.player.s;
    sim.placeEntity('bus', 1, s + 3); // alongside, s-2..s+8
    const ev = step(sim, 0.4, RIGHT);
    expect(types(ev)).toContain('stumble');
    expect(sim.state.over).toBe(false);
    expect(sim.state.player.lane).toBe(0);
    expect(sim.state.player.x).toBeCloseTo(0, 5);
    expect(sim.state.player.stumbleWindow).toBeGreaterThan(5);
    expect(sim.state.chaser.visible).toBe(true);
    expect(sim.state.chaser.gap).toBeLessThan(5);
  });

  it('a second stumble within 6 s is game over (caught)', () => {
    const sim = bare();
    const s = sim.state.player.s;
    sim.placeEntity('bus', 1, s + 15);
    sim.placeEntity('bus', 1, s + 45);
    runTo(sim, s + 12);
    expect(types(step(sim, 0.3, RIGHT))).toContain('stumble');
    runTo(sim, s + 42);
    const ev = step(sim, 0.3, RIGHT);
    expect(overReason(ev)).toBe('caught');
    expect(sim.state.player.action).toBe('dead');
  });

  it('a stumble after the 6 s window is forgiven and the chaser drifts back out of view', () => {
    const sim = bare();
    sim.placeEntity('bus', 1, 15);
    runTo(sim, 12);
    expect(types(step(sim, 0.3, RIGHT))).toContain('stumble');
    step(sim, 11);
    expect(sim.state.player.stumbleWindow).toBe(0);
    expect(sim.state.chaser.visible).toBe(false);
    const s = sim.state.player.s;
    sim.placeEntity('bus', 1, s + 3);
    const ev = step(sim, 0.3, RIGHT);
    expect(types(ev)).toContain('stumble');
    expect(sim.state.over).toBe(false);
  });

  it('an oncoming bus drives toward the player: crash head-on, dodge by lane', () => {
    const sim = bare();
    const bus = sim.placeEntity('busOncoming', 0, 60);
    expect(bus.vs).toBeLessThan(0);
    step(sim, 0.5);
    expect(bus.s).toBeLessThan(60);
    expect(overReason(step(sim, 3))).toBe('crash');

    const dodge = bare();
    dodge.placeEntity('busOncoming', 0, 60);
    step(dodge, 1, RIGHT);
    step(dodge, 3);
    expect(dodge.state.over).toBe(false);
  });

  it('does not tunnel through thin obstacles at max speed, even with big steps', () => {
    for (const dt of [MAX_SIM_STEP, 1 / 30]) {
      for (const kind of ['blocker', 'hurdle', 'busOncoming'] as const) {
        const sim = bare();
        sim.state.time = 1000; // speed ~ 30 m/s
        sim.placeEntity(kind, 0, 40);
        const ev = step(sim, 2, NONE, dt);
        expect(sim.state.player.speed).toBeGreaterThan(29.9);
        expect(overReason(ev), `${kind} dt=${dt}`).toBe('crash');
      }
    }
  });

  it('emits nearMiss for a last-moment dodge', () => {
    const sim = bare();
    sim.placeEntity('blocker', 0, 12);
    runTo(sim, 12 - 0.3 - 0.3 - 1.4);
    const ev = step(sim, 1, RIGHT);
    expect(sim.state.over).toBe(false);
    expect(types(ev)).toContain('nearMiss');
    expect(sim.state.stats!.nearMisses).toBe(1);
  });
});

describe('power-ups', () => {
  it('shield absorbs a crash, knocks the obstacle out and grants brief invulnerability', () => {
    const sim = bare();
    sim.placeEntity('shield', 0, 5);
    const b1 = sim.placeEntity('blocker', 0, 20);
    sim.placeEntity('blocker', 0, 22);
    const ev = step(sim, 1.6);
    expect(ev).toContainEqual({ type: 'pickup', kind: 'shield' });
    expect(ev).toContainEqual({ type: 'shieldBreak', id: b1.id });
    expect(b1.active).toBe(false);
    expect(sim.state.over).toBe(false);
    expect(sim.state.powerups.shield).toBe(0);
    const ev2 = step(sim, 1.5);
    expect(sim.state.over).toBe(false);
    expect(types(ev2)).not.toContain('shieldBreak');
    sim.placeEntity('blocker', 0, sim.state.player.s + 10);
    expect(overReason(step(sim, 1.5))).toBe('crash');
  });

  it('magnet pulls coins within 6 m (moving the coin entities)', () => {
    const sim = bare();
    sim.placeEntity('magnet', 0, 4);
    const coins = [0, 1, 2, 3, 4].map((i) => sim.placeEntity('coin', 1, 15 + i * 2.4));
    const far = sim.placeEntity('coin', -1, 45, 7); // > 6 m away: not pulled
    step(sim, 0.5);
    expect(sim.state.powerups.magnet).toBeGreaterThan(9);
    const x0 = coins[0].x;
    step(sim, 1.6);
    expect(sim.state.coins).toBe(5);
    expect(x0).toBe(2.5);
    expect(far.active).toBe(true);
    step(sim, 2);
    expect(sim.state.coins).toBe(5);

    const plain = bare();
    for (let i = 0; i < 5; i++) plain.placeEntity('coin', 1, 30 + i * 2.4);
    step(plain, 3);
    expect(plain.state.coins).toBe(0);
  });

  it('multiplier doubles the score rate for 12 s; picking another refreshes it', () => {
    const sim = bare();
    sim.placeEntity('multiplier', 0, 3);
    step(sim, 0.4);
    expect(sim.state.multiplier).toBe(2);
    const s0 = sim.state.player.s;
    const score0 = sim.state.score;
    step(sim, 2);
    expect(sim.state.score - score0).toBeCloseTo(2 * (sim.state.player.s - s0), -1);
    sim.placeEntity('multiplier', 0, sim.state.player.s + 3);
    step(sim, 0.4);
    expect(sim.state.powerups.multiplier).toBeGreaterThan(POWERUP_DURATION.multiplier - 0.3);
    const ev = step(sim, 12.5);
    expect(ev).toContainEqual({ type: 'powerupEnd', kind: 'multiplier' });
    expect(sim.state.multiplier).toBe(1);
  });

  it('boost: flight at BOOST_Y, invulnerable, lane changes, controlled descent with grace', () => {
    const sim = bare();
    sim.placeEntity('boost', 0, 4);
    step(sim, 0.4);
    expect(sim.state.player.action).toBe('fly');
    step(sim, 1.2);
    expect(sim.state.player.y).toBeGreaterThan(BOOST_Y - 0.2);
    // Obstacles below are harmless; lanes still change.
    const s = sim.state.player.s;
    sim.placeEntity('bus', 0, s + 20);
    sim.placeEntity('blocker', 1, s + 25);
    step(sim, 0.3, RIGHT);
    expect(sim.state.player.lane).toBe(1);
    const ev = step(sim, 5.4);
    expect(sim.state.over).toBe(false);
    expect(ev).toContainEqual({ type: 'powerupEnd', kind: 'boost' });
    expect(sim.state.player.action).not.toBe('fly');
    const ev2 = step(sim, 1.2);
    expect(ev2).toContainEqual({ type: 'land', hard: false });
    expect(sim.state.player.grounded).toBe(true);
    expect(sim.state.player.invulnerable).toBeGreaterThan(0.3);
  });

  it('boost lays air coins and clears the landing stretch (generator running)', () => {
    const sim = new GameSim(5);
    // Let the bot carry us into the busy part of the track first.
    for (let i = 0; i < 120 * 60 && (i < 120 * 25 || sim.state.player.action !== 'run' || sim.state.player.invulnerable! > 0); i++) {
      sim.update(MAX_SIM_STEP, i % 4 === 0 ? autopilot(sim.state) : NONE);
      sim.drainEvents();
    }
    expect(sim.state.over).toBe(false);
    const p = sim.state.player;
    const boost = sim.placeEntity('boost', p.lane, p.s + 2);
    sim.drainEvents();
    expect(boost.active).toBe(true);
    const t0 = sim.state.time;
    const before = sim.state.coins;
    const spawned: { kind: string; a: number; b: number }[] = [];
    let landS = 0;
    let ended = false;
    for (let i = 0; i < 120 * 11 && !sim.state.over; i++) {
      sim.update(MAX_SIM_STEP, i % 4 === 0 ? autopilot(sim.state) : NONE);
      for (const e of sim.drainEvents()) {
        if (e.type === 'spawn' && e.entity.kind in OBSTACLE_DIMS) spawned.push({ kind: e.entity.kind, a: e.entity.s - e.entity.len / 2, b: e.entity.s + e.entity.len / 2 });
        if (e.type === 'powerupEnd' && e.kind === 'boost') ended = true;
        if (e.type === 'land' && ended && !landS) landS = p.s;
      }
    }
    expect(sim.state.over).toBe(false);
    expect(sim.state.coins - before).toBeGreaterThan(15);
    expect(landS).toBeGreaterThan(0);
    const sEnd = landS - (distanceAt(t0 + 7 + 0.875) - distanceAt(t0 + 7));
    const clearTo = landS + 1.5 * p.speed;
    for (const e of [...spawned, ...sim.state.entities.filter((x) => x.kind in OBSTACLE_DIMS && x.active).map((x) => ({ kind: x.kind, a: x.s - x.len / 2, b: x.s + x.len / 2 }))]) {
      if (e.kind === 'busOncoming') continue;
      const inside = e.b > sEnd && e.a < clearTo;
      expect(inside, `${e.kind} ${e.a.toFixed(1)}..${e.b.toFixed(1)} in landing stretch ${sEnd.toFixed(1)}..${clearTo.toFixed(1)}`).toBe(false);
    }
  });
});
