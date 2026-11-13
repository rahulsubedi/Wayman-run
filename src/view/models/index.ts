// Model factory (final API).
//
// Contract:
// - createObstacle / createPickup return a NEW Container3D per call whose meshes SHARE one
//   Geometry3D + material per kind/variant (=> the engine auto-instances all copies).
// - Origin at road level, centred in x and in length; length along local Z; sizes fit
//   OBSTACLE_DIMS (the collider uses the same numbers). Run direction is -Z, so the face the
//   player sees is the +Z face.
// - HeroRig/ChaserRig set their node's local pose (x, y, rotation, limbs). game.ts sets node z
//   from stage.worldZ() after calling update().
// - updateObstacleVisual / updatePickupVisual are optional per-frame idle animation hooks
//   (allocation-free). They only touch the node's CHILDREN, never the node transform that
//   TrackView owns.
import { Container3D, Mesh3D } from '@pixi/3d';
import { ONCOMING_SPEED, PICKUP_HOVER } from '../../sim/config';
import type { ObstacleKind, PickupKind } from '../../sim/types';
import { glow, vertexColorMaterial } from '../geom/materials';
import { cachedParts, glowVC, meshOf, paintGloss, windowGlass, type Part } from './kit';
import { buildSmallObstacle, type ObstacleBuilders } from './obstacles';
import { pickupParts } from './pickups';
import { buildVehicle, VEHICLE_VARIANTS } from './vehicles';

export { HeroRig } from './hero';
export { ChaserRig } from './chaser';

const WHEEL_R = 0.44;

function isVehicle(kind: ObstacleKind): kind is 'truck' | 'bus' | 'busOncoming' {
  return kind === 'truck' || kind === 'bus' || kind === 'busOncoming';
}

/** Turn builders into shared parts. Axles are returned separately (one mesh per axle). */
function toParts(b: ObstacleBuilders, vehicle: boolean): { parts: Part[]; axle: Part | null } {
  const parts: Part[] = [{ geometry: b.body.build(), material: vehicle ? paintGloss() : vertexColorMaterial({ roughness: 0.7 }), label: 'body' }];
  if (b.glass && b.glass.vertexCount > 0) parts.push({ geometry: b.glass.build(), material: windowGlass(), label: 'glass', castShadow: false });
  if (b.glow && b.glow.vertexCount > 0) parts.push({ geometry: b.glow.build(), material: glowVC(b.glowStrength ?? 2), label: 'glow', castShadow: false });
  if (b.lamps && b.lamps.vertexCount > 0) parts.push({ geometry: b.lamps.build(), material: glow(b.lampColor ?? 0xffb020, 3.2), label: 'lamp', castShadow: false });
  const axle = b.axle ? { geometry: b.axle.build(), material: paintGloss(), label: 'axle' } : null;
  return { parts, axle };
}

interface ObstacleModel {
  parts: Part[];
  axle: Part | null;
  axleZ: number[];
  axleY: number;
}

const models = new Map<string, ObstacleModel>();
const variantCounter: Partial<Record<ObstacleKind, number>> = {};

function obstacleModel(kind: ObstacleKind, variant: number): ObstacleModel {
  const key = `${kind}:${variant}`;
  let m = models.get(key);
  if (!m) {
    const b = isVehicle(kind) ? buildVehicle(kind, variant) : buildSmallObstacle(kind);
    const { parts, axle } = toParts(b, isVehicle(kind));
    m = { parts, axle, axleZ: b.axleZ ?? [], axleY: b.axleY ?? WHEEL_R };
    models.set(key, m);
  }
  return m;
}

/**
 * New obstacle node. Vehicles cycle through their liveries (3 trucks, 3 buses) on successive
 * calls, so pooled nodes get a mix; pass `variant` to pick one explicitly.
 */
export function createObstacle(kind: ObstacleKind, variant?: number): Container3D {
  let v = 0;
  if (isVehicle(kind)) {
    const count = VEHICLE_VARIANTS[kind];
    if (variant === undefined) {
      v = (variantCounter[kind] ?? 0) % count;
      variantCounter[kind] = v + 1;
    } else {
      v = ((variant % count) + count) % count;
    }
  }
  const m = obstacleModel(kind, v);
  const node = new Container3D({ label: kind });
  for (const p of m.parts) meshOf(p, node);
  if (m.axle) {
    for (const z of m.axleZ) {
      const a = meshOf(m.axle, node);
      a.position.set(0, m.axleY, z);
    }
  }
  return node;
}

/** New pickup node: visual centre PICKUP_HOVER above the origin. */
export function createPickup(kind: PickupKind): Container3D {
  const parts = cachedParts(`pickup:${kind}`, () => pickupParts(kind));
  const node = new Container3D({ label: kind });
  if (kind === 'coin') {
    // Coin geometry is already offset to the hover height (fewest nodes for 40+ coins).
    for (const p of parts) meshOf(p, node);
    return node;
  }
  const pivot = new Container3D({ parent: node, position: { x: 0, y: PICKUP_HOVER, z: 0 }, label: 'pivot' });
  for (const p of parts) meshOf(p, pivot);
  return node;
}

/**
 * Idle animation for a pickup (spin wobble, halo spin, pulse). Call once per frame per live
 * pickup with a running time in seconds. Coins need nothing beyond TrackView's spin.
 */
export function updatePickupVisual(node: Container3D, kind: PickupKind, time: number): void {
  if (kind === 'coin') return;
  const pivot = node.children[0] as Container3D | undefined;
  if (!pivot) return;
  pivot.rotation.z = Math.sin(time * 2.1) * 0.14;
  const s = 1 + Math.sin(time * 4.2) * 0.05;
  pivot.scale.set(s, s, s);
  const kids = pivot.children;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.label === 'halo') {
      k.rotation.z = time * 1.4;
      const h = 1 + Math.sin(time * 6) * 0.06;
      k.scale.set(h, h, h);
    } else if (k.label === 'bubble') {
      const b = 1 + Math.sin(time * 3.1 + 1) * 0.08;
      k.scale.set(b, b, b);
    }
  }
}

/**
 * Idle animation for an obstacle: warning lamps blink (lanes alternate), the oncoming bus's
 * wheels spin. Call once per frame per live obstacle with a running time in seconds.
 */
export function updateObstacleVisual(node: Container3D, kind: ObstacleKind, time: number): void {
  const kids = node.children;
  if (kind === 'busOncoming') {
    const a = (time * ONCOMING_SPEED) / WHEEL_R;
    for (let i = 0; i < kids.length; i++) if (kids[i].label === 'axle') kids[i].rotation.x = a;
    return;
  }
  if (kind === 'hurdle' || kind === 'overhead' || kind === 'blocker') {
    const on = Math.sin(time * Math.PI * 2 * 1.3 + node.position.x * 1.3) > -0.2;
    for (let i = 0; i < kids.length; i++) if (kids[i].label === 'lamp') kids[i].visible = on;
  }
}

/** True when `node` is a Mesh3D (helper for galleries / stats). */
export function isMesh(node: unknown): node is Mesh3D {
  return node instanceof Mesh3D;
}
