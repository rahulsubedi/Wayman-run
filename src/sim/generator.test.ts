import { describe, expect, it } from 'vitest';
import { autopilot } from './autopilot';
import {
  DESPAWN_BEHIND,
  MAX_SIM_STEP,
  OBSTACLE_DIMS,
  ONCOMING_SPEED,
  SPAWN_AHEAD,
  START_SAFE_DISTANCE,
  speedAtDistance,
} from './config';
import { EntityPool, isObstacleKind, isPowerupKind, rampTop } from './entity';
import { type PlanItem, buildIntervals, buildRows, checkPlan } from './fairness';
import { PATTERN_NAMES, TrackGenerator, tierAt } from './generator';
import { Rng } from './rng';
import { GameSim } from './sim';
import { NONE } from './testUtil';
import type { Entity, Lane } from './types';

interface Logged extends PlanItem {
  y: number;
  pattern: string;
}

const LENGTH = 3000;
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

function plan(seed: number): Logged[] {
  const g = new TrackGenerator(new EntityPool(), new Rng(seed));
  const log: Logged[] = [];
  g.onCommit = (e, pattern) => log.push({ kind: e.kind, lane: e.lane, s: e.s, len: e.len, meetS: e.meetS, chain: e.chain, y: e.y, pattern });
  for (let s = 0; s < LENGTH; s += 4) g.update(s, speedAtDistance(s), () => {});
  return log.filter((e) => e.s < LENGTH);
}

const plans = new Map<number, Logged[]>(SEEDS.map((s) => [s, plan(s)]));
const obstaclesOf = (log: Logged[]) => log.filter((e) => isObstacleKind(e.kind as Entity['kind']));

describe('track generator invariants (24 seeds x 3000 m)', () => {
  it('always leaves a survivable path that never needs a reaction faster than MIN_REACTION_TIME', () => {
    for (const [seed, log] of plans) {
      expect(checkPlan(log), `seed ${seed}`).toBe(-1);
      const rows = buildRows(buildIntervals(log));
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].st.some((st) => st !== 4), `seed ${seed} row ${i} fully blocked`).toBe(true);
      }
    }
  });

  it('keeps the first metres empty and starts gently', () => {
    for (const [seed, log] of plans) {
      const obs = obstaclesOf(log);
      expect(Math.min(...obs.map((e) => e.s - e.len / 2)), `seed ${seed}`).toBeGreaterThanOrEqual(START_SAFE_DISTANCE);
      // Intro tier: single obstacles only.
      for (const e of obs) if (tierAt(e.s) === 0) expect(e.pattern).toBe('single');
    }
  });

  it('never overlaps obstacles, and keeps oncoming buses a clear lane to drive in', () => {
    for (const [seed, log] of plans) {
      const statics = obstaclesOf(log).filter((e) => e.kind !== 'busOncoming');
      for (const lane of [-1, 0, 1] as Lane[]) {
        const inLane = statics.filter((e) => e.lane === lane).sort((a, b) => a.s - b.s);
        for (let i = 1; i < inLane.length; i++) {
          const prevEnd = inLane[i - 1].s + inLane[i - 1].len / 2;
          const start = inLane[i].s - inLane[i].len / 2;
          // A ramp leads straight onto its vehicle (same roof chain): touching is intended.
          if (inLane[i - 1].kind === 'ramp' && inLane[i - 1].chain === inLane[i].chain) {
            expect(start).toBeCloseTo(prevEnd, 6);
            continue;
          }
          expect(start, `seed ${seed} lane ${lane} at ${start.toFixed(1)}`).toBeGreaterThanOrEqual(prevEnd + 0.2 - 1e-6);
        }
      }
      for (const bus of log.filter((e) => e.kind === 'busOncoming')) {
        const v = speedAtDistance(bus.meetS);
        const reach = bus.meetS + (ONCOMING_SPEED * SPAWN_AHEAD) / (v + ONCOMING_SPEED) + bus.len;
        for (const e of log) {
          if (e === bus || e.lane !== bus.lane || e.y > 4) continue;
          const inside = e.s + e.len / 2 > bus.meetS - 2 && e.s - e.len / 2 < reach;
          expect(inside, `seed ${seed}: ${e.kind} at ${e.s.toFixed(1)} in the path of an oncoming bus`).toBe(false);
        }
      }
    }
  });

  it('never puts pickups inside obstacles', () => {
    for (const [seed, log] of plans) {
      const obs = obstaclesOf(log).filter((e) => e.kind !== 'busOncoming');
      for (const c of log) {
        if (isObstacleKind(c.kind as Entity['kind'])) continue;
        for (const o of obs) {
          if (o.lane !== c.lane || Math.abs(c.s - o.s) > o.len / 2) continue;
          const d = OBSTACLE_DIMS[o.kind as keyof typeof OBSTACLE_DIMS];
          const ok =
            o.kind === 'ramp'
              ? c.y >= rampTop({ s: o.s, len: o.len, y: 0 } as Entity, c.s) - 0.06
              : o.kind === 'overhead'
                ? c.y <= 0.05 || c.y >= d.h
                : c.y >= d.h - 0.06;
          expect(ok, `seed ${seed}: ${c.kind} y=${c.y.toFixed(2)} inside ${o.kind} at ${o.s.toFixed(1)}`).toBe(true);
        }
      }
    }
  });

  it('places power-ups every ~150-250 m, never the same kind twice in a row', () => {
    let total = 0;
    let gaps = 0;
    for (const [seed, log] of plans) {
      const pw = log.filter((e) => isPowerupKind(e.kind as Entity['kind'])).sort((a, b) => a.s - b.s);
      expect(pw.length, `seed ${seed}`).toBeGreaterThanOrEqual(10);
      for (let i = 1; i < pw.length; i++) {
        const gap = pw[i].s - pw[i - 1].s;
        expect(gap, `seed ${seed} power-up gap`).toBeGreaterThan(110);
        expect(gap, `seed ${seed} power-up gap`).toBeLessThan(330);
        expect(pw[i].kind, `seed ${seed} repeat at ${pw[i].s.toFixed(0)}`).not.toBe(pw[i - 1].kind);
        total += gap;
        gaps++;
      }
      expect(pw[0].s).toBeLessThan(260);
    }
    expect(total / gaps).toBeGreaterThan(150);
    expect(total / gaps).toBeLessThan(260);
  });

  it('varies patterns: never the same one twice in a row, every pattern appears', () => {
    const used = new Set<string>();
    for (const [seed, log] of plans) {
      const seq: string[] = [];
      for (const e of log) {
        if (!isObstacleKind(e.kind as Entity['kind'])) continue;
        if (seq[seq.length - 1] !== e.pattern) seq.push(e.pattern);
      }
      // Consecutive obstacle groups with the same name would be the same pattern twice in a row
      // (each committed pattern instance is contiguous in the log).
      for (let i = 1; i < seq.length; i++) expect(seq[i], `seed ${seed} #${i}`).not.toBe(seq[i - 1]);
      for (const p of seq) used.add(p);
    }
    for (const p of PATTERN_NAMES) expect(used.has(p), p).toBe(true);
  });

  it('gets denser with distance and keeps plenty of coins', () => {
    let early = 0;
    let late = 0;
    for (const [seed, log] of plans) {
      const rowsPerSecond = (a: number, b: number) => {
        const rows = buildRows(buildIntervals(log.filter((e) => e.s >= a && e.s < b)));
        const seconds = (b - a) / speedAtDistance((a + b) / 2);
        return rows.length / seconds;
      };
      early += rowsPerSecond(300, 700);
      late += rowsPerSecond(2400, 3000);
      const coins = log.filter((e) => e.kind === 'coin').length;
      expect(coins / (LENGTH / 1000), `seed ${seed} coins per km`).toBeGreaterThan(110);
    }
    expect(late).toBeGreaterThan(early * 1.25);
  });
});

describe('spawn window (through the sim)', () => {
  it(`spawns at player.s + ${SPAWN_AHEAD}, despawns ${DESPAWN_BEHIND} m behind, and reuses entity objects`, () => {
    for (const seed of [3, 11]) {
      const sim = new GameSim(seed);
      const st = sim.state;
      const p = st.player;
      const objects = new Set<Entity>();
      let spawns = 0;
      sim.drainEvents();
      let bad = '';
      for (let i = 0; i < 120 * 70 && !st.over; i++) {
        sim.update(MAX_SIM_STEP, i % 4 === 0 ? autopilot(st) : NONE);
        for (const ev of sim.drainEvents()) {
          if (ev.type !== 'spawn') continue;
          const e = ev.entity;
          spawns++;
          objects.add(e);
          const near = e.s - e.len / 2;
          expect(near, `${e.kind} spawned too far`).toBeLessThanOrEqual(p.s + SPAWN_AHEAD + 0.01);
          // Air coins are laid when a boost starts, so they may appear closer; everything else pops in at the horizon.
          if (e.y < 4) expect(near, `${e.kind} spawned late`).toBeGreaterThan(p.s + SPAWN_AHEAD - 1.5);
        }
        for (const e of st.entities) {
          if (e.magnet) continue;
          if (e.s - e.len / 2 > p.s + SPAWN_AHEAD + 0.01 || e.s + e.len / 2 < p.s - DESPAWN_BEHIND) bad ||= `${e.kind} at ${e.s} (player ${p.s})`;
        }
      }
      expect(bad).toBe('');
      expect(st.over).toBe(false);
      expect(spawns).toBeGreaterThan(200);
      expect(objects.size).toBeLessThan(spawns / 3);
    }
  });
});
