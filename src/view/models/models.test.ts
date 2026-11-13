import { describe, expect, it } from 'vitest';
import { OBSTACLE_DIMS, PICKUP_HOVER } from '../../sim/config';
import type { ObstacleKind, PowerupKind } from '../../sim/types';
import type { MeshBuilder } from '../geom/meshBuilder';
import { chaserBuilders } from './chaser';
import { heroBuilders, SHIELD_SEGMENTS } from './heroGeometry';
import { buildSmallObstacle, type ObstacleBuilders } from './obstacles';
import { coinBodyBuilder, coinRimBuilder, powerupBuilders } from './pickups';
import { buildVehicle, VEHICLE_VARIANTS } from './vehicles';

function bounds(list: (MeshBuilder | undefined)[], offsets: { z: number; y: number; mb: MeshBuilder }[] = []) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const add = (mb: MeshBuilder, dy = 0, dz = 0) => {
    const p = mb.toArrays().positions;
    for (let i = 0; i < p.length; i += 3) {
      const v = [p[i], p[i + 1] + dy, p[i + 2] + dz];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
  };
  for (const mb of list) if (mb) add(mb);
  for (const o of offsets) add(o.mb, o.y, o.z);
  return { min, max };
}

function tris(b: ObstacleBuilders): number {
  let n = b.body.triangleCount + (b.glass?.triangleCount ?? 0) + (b.glow?.triangleCount ?? 0) + (b.lamps?.triangleCount ?? 0);
  n += (b.axle?.triangleCount ?? 0) * (b.axleZ?.length ?? 0);
  return n;
}

function meshCount(b: ObstacleBuilders): number {
  return 1 + (b.glass ? 1 : 0) + (b.glow ? 1 : 0) + (b.lamps ? 1 : 0) + (b.axleZ?.length ?? 0);
}

const ALL: { kind: ObstacleKind; variant: number; b: ObstacleBuilders }[] = [];
for (const kind of ['hurdle', 'overhead', 'blocker', 'ramp'] as const) ALL.push({ kind, variant: 0, b: buildSmallObstacle(kind) });
for (const kind of ['truck', 'bus', 'busOncoming'] as const) {
  for (let v = 0; v < VEHICLE_VARIANTS[kind]; v++) ALL.push({ kind, variant: v, b: buildVehicle(kind, v) });
}

describe('obstacle models', () => {
  for (const { kind, variant, b } of ALL) {
    it(`${kind}#${variant} fits its collider box and budget`, () => {
      const d = OBSTACLE_DIMS[kind];
      const axles = (b.axleZ ?? []).map((z) => ({ z, y: b.axleY ?? 0, mb: b.axle! }));
      const { min, max } = bounds([b.body, b.glass, b.glow, b.lamps], axles);
      const tolXZ = 0.04;
      expect(min[0]).toBeGreaterThanOrEqual(-d.w / 2 - tolXZ);
      expect(max[0]).toBeLessThanOrEqual(d.w / 2 + tolXZ);
      expect(min[2]).toBeGreaterThanOrEqual(-d.len / 2 - tolXZ);
      expect(max[2]).toBeLessThanOrEqual(d.len / 2 + tolXZ);
      expect(min[1]).toBeGreaterThanOrEqual(-0.001);
      expect(max[1]).toBeLessThanOrEqual(d.h + 0.06);
      const t = tris(b);
      const vehicle = kind === 'truck' || kind === 'bus' || kind === 'busOncoming';
      expect(t).toBeLessThanOrEqual(vehicle ? 1800 : kind === "ramp" ? 900 : 500);
      expect(meshCount(b)).toBeLessThanOrEqual(vehicle ? 5 : 3);
    });
  }

  it('walkable roofs reach ROOF_Y', () => {
    for (const { kind, b } of ALL) {
      if (!OBSTACLE_DIMS[kind].walkable) continue;
      const { max } = bounds([b.body]);
      expect(max[1]).toBeGreaterThanOrEqual(OBSTACLE_DIMS[kind].h - 0.01);
    }
  });

  it('overhead leaves the space under 1.2 m clear between its posts', () => {
    const b = buildSmallObstacle('overhead');
    const p = b.body.toArrays().positions;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i]) < 0.85) expect(p[i + 1]).toBeGreaterThanOrEqual(OBSTACLE_DIMS.overhead.solidFrom - 0.001);
    }
  });
});

describe('pickups', () => {
  it('coin is cheap and ~0.7 m wide, centred at the hover height', () => {
    const body = coinBodyBuilder(), rim = coinRimBuilder();
    expect(body.triangleCount + rim.triangleCount).toBeLessThanOrEqual(200);
    const { min, max } = bounds([body, rim]);
    expect(max[0] - min[0]).toBeCloseTo(0.7, 1);
    expect((min[1] + max[1]) / 2).toBeCloseTo(PICKUP_HOVER, 2);
  });

  for (const kind of ['magnet', 'shield', 'boost', 'multiplier'] as PowerupKind[]) {
    it(`${kind} token is ~0.9 m`, () => {
      const b = powerupBuilders(kind);
      const { min, max } = bounds([b.icon, b.accent, b.halo]);
      expect(Math.max(max[0] - min[0], max[1] - min[1])).toBeLessThanOrEqual(1.0);
      expect(Math.max(max[0] - min[0], max[1] - min[1])).toBeGreaterThanOrEqual(0.8);
    });
  }
});

describe('rigs', () => {
  it('hero stays within the triangle budget', () => {
    let t = 0;
    for (const mb of Object.values(heroBuilders())) t += mb.triangleCount;
    t += SHIELD_SEGMENTS.widthSegments * SHIELD_SEGMENTS.heightSegments * 2;
    expect(t).toBeLessThanOrEqual(3500);
  });

  it('drone stays within the triangle budget', () => {
    const b = chaserBuilders();
    const t = b.hull.triangleCount + b.rotor.triangleCount * 4 + b.eye.triangleCount + b.beacon.triangleCount * 2 + b.cone.triangleCount;
    expect(t).toBeLessThanOrEqual(1200);
  });
});
