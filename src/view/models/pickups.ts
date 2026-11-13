// Pickups: gold coins (cheap, 40+ on screen) and four colour-coded power-up tokens with halos.
// Every pickup node has its visual centre PICKUP_HOVER above the node origin (the entity base).
import { PICKUP_HOVER } from '../../sim/config';
import type { PickupKind, PowerupKind } from '../../sim/types';
import { glow, glowVertexColor } from '../geom/materials';
import { MeshBuilder } from '../geom/meshBuilder';
import { fresnelGlow, glowVC, loft, paintGloss, ring, type Part } from './kit';

export const POWERUP_COLOR: Record<PowerupKind, number> = {
  magnet: 0xff3b4e,
  shield: 0x3d8bff,
  boost: 0xff8a1f,
  multiplier: 0xb35cff,
};

// --------------------------------------------------------------------- coin

const COIN_R = 0.35;
const COIN_T = 0.11;

function star(points: number, r0: number, r1: number, rot = Math.PI / 2): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 ? r1 : r0;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

/** Coin face plate + embossed star (lit, softly self-lit gold). Disc faces ±Z. */
export function coinBodyBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 81, jitter: 0.04 });
  mb.push().translate(0, PICKUP_HOVER, 0);
  // Face plate (slightly recessed inside the rim).
  mb.push().rotateX(Math.PI / 2).cylinder(COIN_R - 0.05, COIN_T * 0.75, 12, {}, { color: 0xf7b52a, bottom: 0xd9780c }).pop();
  // Embossed star on both faces (one extrusion through the coin).
  mb.extrude(star(5, 0.19, 0.085), COIN_T + 0.03, { color: 0xffdc5c, bottom: 0xffa81a });
  mb.pop();
  return mb;
}

/** Bright emissive rim (blooms). */
export function coinRimBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 82, jitter: 0 });
  mb.push().translate(0, PICKUP_HOVER, 0);
  ring(mb, COIN_R, COIN_R - 0.06, COIN_T, 12, 0xffffff);
  mb.pop();
  return mb;
}

// ----------------------------------------------------------------- power-ups

export interface PowerupBuilders {
  icon: MeshBuilder;
  accent: MeshBuilder;
  halo: MeshBuilder;
  bubble: MeshBuilder;
}

/** Dashed halo ring around the token, in the token colour (emissive). */
function halo(color: number): MeshBuilder {
  const mb = new MeshBuilder({ seed: 83, jitter: 0 });
  const n = 8;
  for (let i = 0; i < n; i++) {
    ring(mb, 0.47, 0.42, 0.035, 3, color, ((Math.PI * 2) / n) * 0.7, (i / n) * Math.PI * 2);
  }
  return mb;
}

/** Faint additive sphere behind the icon so the token reads as "special" even edge-on. */
function bubble(color: number): MeshBuilder {
  const mb = new MeshBuilder({ seed: 84, jitter: 0 });
  void color;
  mb.sphere(0.4, 0.4, 0.4, 10, 6, 0xffffff);
  return mb;
}

function magnet(icon: MeshBuilder, accent: MeshBuilder): void {
  const red = POWERUP_COLOR.magnet;
  // Horseshoe: arch + two legs (red), silver pole tips.
  icon.push().translate(0, 0.06, 0);
  ring(icon, 0.26, 0.12, 0.16, 8, { color: red, bottom: 0xc0202e }, Math.PI, 0);
  icon.pop();
  for (const s of [-1, 1]) {
    icon.block(s * 0.26, -0.12, -0.08, s * 0.12, 0.06, 0.08, { color: 0xd02a3a, top: red });
    icon.block(s * 0.265, -0.25, -0.085, s * 0.115, -0.12, 0.085, { color: 0xc8d0d8, top: 0xf2f5f8 });
  }
  // Little spark bolts between the poles (emissive white).
  for (const s of [-1, 1]) {
    accent.push().translate(s * 0.07, -0.33, 0).rotateZ(s * 0.5).box(0.03, 0.12, 0.03, 0xfff2f2).pop();
  }
  accent.push().translate(0, -0.37, 0).box(0.1, 0.03, 0.03, 0xfff2f2).pop();
}

function shield(icon: MeshBuilder, accent: MeshBuilder): void {
  const blue = POWERUP_COLOR.shield;
  const outline = (s: number): [number, number][] => [
    [-0.25 * s, 0.25 * s], [0, 0.31 * s], [0.25 * s, 0.25 * s], [0.24 * s, 0.02 * s], [0.15 * s, -0.17 * s], [0, -0.31 * s], [-0.15 * s, -0.17 * s], [-0.24 * s, 0.02 * s],
  ];
  // Silver rim plate, blue face, white chevron.
  icon.extrude(outline(1.0), 0.12, { color: 0xc8d4e2, top: 0xf2f6fa });
  icon.extrude(outline(0.84), 0.16, { color: 0x2e6fd6, top: blue });
  accent.push().translate(0, 0.0, 0);
  accent.extrude([[-0.12, 0.06], [0, -0.08], [0.12, 0.06], [0.12, 0.13], [0, -0.01], [-0.12, 0.13]], 0.18, 0xeaf4ff);
  accent.pop();
}

function boost(icon: MeshBuilder, accent: MeshBuilder): void {
  const orange = POWERUP_COLOR.boost;
  // Rocket tilted forward-up, with fins, porthole and a flame.
  icon.push().rotateZ(-0.5);
  loft(icon, [
    { y: -0.22, rx: 0.07, rz: 0.07 },
    { y: -0.16, rx: 0.1, rz: 0.1 },
    { y: 0.06, rx: 0.11, rz: 0.11 },
    { y: 0.16, rx: 0.09, rz: 0.09 },
    { y: 0.26, rx: 0.04, rz: 0.04 },
    { y: 0.3, rx: 0, rz: 0 },
  ], { sides: 8, bands: [0x5a6270, 0xf6f4ee, 0xf6f4ee, orange, orange] });
  for (let k = 0; k < 3; k++) {
    icon.push().rotateY((k * Math.PI * 2) / 3 + Math.PI / 2).translate(0, -0.14, 0.12).box(0.02, 0.14, 0.1, orange).pop();
  }
  icon.push().translate(0, 0.02, -0.108).rotateX(Math.PI / 2).cylinder(0.045, 0.02, 8, {}, 0x3d8bff).pop();
  icon.push().translate(0, 0.02, 0.108).rotateX(Math.PI / 2).cylinder(0.045, 0.02, 8, {}, 0x3d8bff).pop();
  loft(accent, [
    { y: -0.22, rx: 0.06, rz: 0.06 },
    { y: -0.3, rx: 0.075, rz: 0.075 },
    { y: -0.46, rx: 0, rz: 0 },
  ], { sides: 6, bands: [0xffe08a, 0xff8a1f], capTop: true });
  icon.pop();
  // Re-apply the tilt to the accent (built in the same frame above, so rotate it here).
}

function digit2(mb: MeshBuilder, x: number, z: number, f: 1 | -1, col: number): void {
  // A chunky "2": top bar, right upper stroke, diagonal, bottom bar. Mirrored on the back face
  // (f = -1) so it reads correctly from both sides.
  mb.push().translate(x, 0, z);
  if (f < 0) mb.rotateY(Math.PI);
  const t = 0.045, w = 0.17, h = 0.25;
  // Rounded top hook (arc over the top), diagonal stroke, flat base.
  const r = 0.075, cy = h / 2 - r;
  mb.push().translate(0, cy, 0);
  ring(mb, r, r - t, 0.04, 6, col, Math.PI + 0.65, -0.65);
  mb.pop();
  const ax = Math.cos(-0.65) * (r - t / 2), ay = cy + Math.sin(-0.65) * (r - t / 2);
  const bx = -w / 2 + t / 2, by = -h / 2 + t;
  const len = Math.hypot(ax - bx, ay - by);
  mb.push().translate((ax + bx) / 2, (ay + by) / 2, 0).rotateZ(Math.atan2(ay - by, ax - bx) - Math.PI / 2).box(t, len + 0.02, 0.04, col).pop();
  mb.block(-w / 2, -h / 2, -0.02, w / 2, -h / 2 + t, 0.02, col);
  mb.pop();
}

function times(mb: MeshBuilder, x: number, z: number, col: number): void {
  for (const a of [0.785, -0.785]) mb.push().translate(x, -0.03, z).rotateZ(a).box(0.035, 0.14, 0.04, col).pop();
}

function multiplier(icon: MeshBuilder, accent: MeshBuilder): void {
  const purple = POWERUP_COLOR.multiplier;
  // Token disc with a raised rim, glyphs "×2" on both faces.
  icon.push().rotateX(Math.PI / 2).cylinder(0.3, 0.1, 12, {}, { color: 0x7d33cc, top: purple }).pop();
  icon.push().rotateX(Math.PI / 2).cylinder(0.24, 0.12, 12, {}, { color: 0x5a1fa0, top: 0x6c2bbd }).pop();
  for (const f of [1, -1] as const) {
    const z = f * 0.07;
    // Facing +Z: "×" on the left, "2" on the right; on the back the order flips.
    times(accent, -0.09 * f, z, 0xfff0a0);
    digit2(accent, 0.07 * f, z, f, 0xfff0a0);
  }
}

export function powerupBuilders(kind: PowerupKind): PowerupBuilders {
  const icon = new MeshBuilder({ seed: 90 + kind.length, jitter: 0.03 });
  const accent = new MeshBuilder({ seed: 95 + kind.length, jitter: 0 });
  switch (kind) {
    case 'magnet':
      magnet(icon, accent);
      break;
    case 'shield':
      shield(icon, accent);
      break;
    case 'boost': {
      boost(icon, accent);
      // The flame was built untilted; tilt it like the rocket body.
      const tilted = new MeshBuilder({ seed: 96, jitter: 0 });
      tilted.push().rotateZ(-0.5).merge(accent).pop();
      return { icon, accent: tilted, halo: halo(POWERUP_COLOR[kind]), bubble: bubble(POWERUP_COLOR[kind]) };
    }
    case 'multiplier':
      multiplier(icon, accent);
      break;
  }
  return { icon, accent, halo: halo(POWERUP_COLOR[kind]), bubble: bubble(POWERUP_COLOR[kind]) };
}

/** Parts for a pickup kind (meshes in pivot space, pivot sits at PICKUP_HOVER). */
export function pickupParts(kind: PickupKind): Part[] {
  if (kind === 'coin') {
    return [
      { geometry: coinBodyBuilder().build(), material: glowVertexColor(0xff9000, 0.28), label: 'coin' },
      { geometry: coinRimBuilder().build(), material: glow(0xffb52e, 1.9), label: 'rim', castShadow: false },
    ];
  }
  const b = powerupBuilders(kind);
  return [
    { geometry: b.icon.build(), material: paintGloss(), label: 'icon' },
    { geometry: b.accent.build(), material: glowVC(2.4), label: 'accent', castShadow: false },
    { geometry: b.halo.build(), material: glowVC(2.2), label: 'halo', castShadow: false },
    { geometry: b.bubble.build(), material: fresnelGlow(POWERUP_COLOR[kind], { faceAlpha: 0.04, power: 2, faceGlow: 0.6, rimGlow: 1.6 }), label: 'bubble', castShadow: false },
  ];
}
