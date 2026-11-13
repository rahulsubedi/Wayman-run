// Fairness fuzz: the autopilot (which only reads public state) must survive long runs.
// If it dies, the failure message names the seed and distance so the run can be replayed.
import { describe, expect, it } from 'vitest';
import { autopilot } from './autopilot';
import { MAX_SIM_STEP } from './config';
import { GameSim } from './sim';
import { NONE } from './testUtil';

const TARGET = 3000;

function runBot(seed: number): { s: number; over: boolean; reason: string; coins: number; stumbles: number } {
  const sim = new GameSim(seed);
  const st = sim.state;
  let reason = '';
  // Same cadence as the game at 30 fps: one decision per 4 sim steps.
  for (let i = 0; !st.over && st.player.s < TARGET; i++) {
    sim.update(MAX_SIM_STEP, i % 4 === 0 ? autopilot(st) : NONE);
    for (const e of sim.drainEvents()) if (e.type === 'gameOver') reason = e.reason;
  }
  return { s: st.player.s, over: st.over, reason, coins: st.coins, stumbles: st.stats!.stumbles };
}

describe('autopilot fuzz', () => {
  it(`survives ${TARGET} m on at least 19 of 20 seeds`, () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ seed: i + 1, ...runBot(i + 1) }));
    const deaths = results.filter((r) => r.over);
    const table = results.map((r) => `seed ${r.seed}: ${r.over ? `died (${r.reason}) at ${r.s.toFixed(0)} m` : 'ok'} coins=${r.coins} stumbles=${r.stumbles}`).join('\n');
    expect(deaths.length, table).toBeLessThanOrEqual(1);
    for (const r of results) if (!r.over) expect(r.coins).toBeGreaterThan(150);
  });
});
