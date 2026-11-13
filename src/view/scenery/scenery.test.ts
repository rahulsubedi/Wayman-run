import { describe, expect, it } from 'vitest';
import { ZONE_COUNT, ZONE_LENGTH } from '../../sim/config';
import { chunkZone, layoutChunk } from './layout';
import { CHUNK_LEN, ROAD_CLEAR_X, ROAD_CLEAR_Y } from './layoutConst';
import { lowTable, moduleDefs, widthTable } from './library';

const defs = moduleDefs();
const arrays = new Map([...defs].map(([k, d]) => [k, d.build().toArrays()]));
const widths = widthTable();
const low = lowTable();

describe('scenery layout', () => {
  it('is deterministic per chunk index and zone', () => {
    for (let z = 0; z < 3; z++) {
      expect(JSON.stringify(layoutChunk(17, z, widths, low))).toBe(JSON.stringify(layoutChunk(17, z, widths, low)));
    }
  });

  it('only references modules that exist', () => {
    for (let z = 0; z < 3; z++) {
      for (let i = 0; i < 60; i++) {
        const l = layoutChunk(i, z, widths, low);
        for (const it of [...l.items, ...l.anim]) expect(defs.has(it.key), it.key).toBe(true);
      }
    }
  });

  it('fills both street fronts exactly (buildings + gaps = chunk length)', () => {
    for (let z = 0; z < 3; z++) {
      for (let i = 0; i < 60; i++) {
        const l = layoutChunk(i, z, widths, low);
        for (const side of [1, -1]) {
          const b = l.items.filter((it) => it.key.startsWith(`b${z}_`) && Math.sign(it.x) === side);
          const used = b.reduce((a, it) => a + widths[z][Number(it.key.split('_')[1])], 0);
          expect(used).toBeLessThanOrEqual(CHUNK_LEN);
          expect(used).toBeGreaterThan(CHUNK_LEN * 0.3);
        }
      }
    }
  });

  it('chunk zones follow the zone length and honour the debug offset', () => {
    expect(chunkZone(0, 0, ZONE_LENGTH, ZONE_COUNT)).toBe(0);
    expect(chunkZone(ZONE_LENGTH / CHUNK_LEN, 0, ZONE_LENGTH, ZONE_COUNT)).toBe(1);
    expect(chunkZone(0, 2, ZONE_LENGTH, ZONE_COUNT)).toBe(2);
    expect(chunkZone(2 * (ZONE_LENGTH / CHUNK_LEN), 2, ZONE_LENGTH, ZONE_COUNT)).toBe(1);
  });

  it('keeps every placed vertex out of the road volume (|x| < 4.6 and y < 11)', () => {
    for (let z = 0; z < 3; z++) {
      for (let i = 0; i < 30; i++) {
        const l = layoutChunk(i, z, widths, low);
        for (const it of [...l.items, ...l.anim]) {
          if (it.key.startsWith('ground')) continue; // the road surface itself
          const a = arrays.get(it.key)!;
          const c = Math.cos(it.rot), s = Math.sin(it.rot);
          const p = a.positions;
          const swing = it.key.startsWith('bunting') || it.key.startsWith('flags') || it.key.startsWith('lanterns') ? 0.15 : 0;
          for (let v = 0; v < p.length; v += 3) {
            const x = it.x + c * p[v] + s * p[v + 2];
            const y = it.y + p[v + 1] - swing;
            if (Math.abs(x) < ROAD_CLEAR_X && y < ROAD_CLEAR_Y && y > 0.03) {
              throw new Error(`${it.key} vertex at x=${x.toFixed(2)} y=${y.toFixed(2)} (chunk ${i}, zone ${z})`);
            }
          }
        }
      }
    }
  });
});

describe('scenery budget', () => {
  it('reports triangle counts per module and per chunk', () => {
    const tri = (k: string) => arrays.get(k)!.indices.length / 3;
    const report: string[] = [];
    for (let z = 0; z < 3; z++) {
      let total = 0, max = 0;
      for (let i = 0; i < 20; i++) {
        const l = layoutChunk(i, z, widths, low);
        const t = [...l.items, ...l.anim].reduce((a, it) => a + tri(it.key), 0);
        total += t;
        max = Math.max(max, t);
      }
      report.push(`zone ${z}: avg ${(total / 20) | 0} tris/chunk, max ${max}`);
    }
    const mods = [...arrays.keys()].map((k) => `${k}:${tri(k)}`).join(' ');
    console.log(report.join('\n') + '\n' + mods);
    expect(report.length).toBe(3);
  });
});
