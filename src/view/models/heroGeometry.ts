// Wayman, the parcel courier: geometry for every articulated part (built once, shared by all rigs).
// Each part is authored in its own joint space: limbs hang down -Y from their pivot, the face
// looks toward -Z (the run direction), the satchel sits on the back (+Z).
import { SphereGeometry } from '@pixi/3d';
import type { Geometry3D } from '@pixi/3d';
import { shadeHex } from '../geom/color';
import { MeshBuilder } from '../geom/meshBuilder';
import { faceToward, loft, ring, taper, type V3 } from './kit';

export const HERO_COLORS = {
  jacket: 0x14bfb0,
  jacketDark: 0x0e8c83,
  jacketLight: 0x7fe3d6,
  reflect: 0xe9f1ee,
  scarf: 0xff7424,
  scarfDark: 0xd9541a,
  scarfLight: 0xffb070,
  skin: 0xf0aa7e,
  skinDark: 0xd98a62,
  hair: 0x3a2417,
  cap: 0x285c8e,
  capDark: 0x163a5a,
  pants: 0x33497a,
  pantsDark: 0x253659,
  shoe: 0xf6f3ec,
  sole: 0xfff7ec,
  tread: 0xb4552c,
  sock: 0xf2f2f2,
  leather: 0xb06a37,
  leatherDark: 0x7f4722,
  leatherLight: 0xd08a4c,
  strap: 0x5a3720,
  metal: 0xc8d0d8,
  nozzle: 0x4a515c,
  eye: 0x1c1a22,
} as const;

const H = HERO_COLORS;

/** Hi-vis accents: vertex alpha < 1 marks them as self-lit in the hero material (night glow). */
const REFLECT = { color: H.reflect, alpha: 0.55 };
const REFLECT_STRIP = { color: 0xffd9a0, alpha: 0.35 };
const SOLE = { color: H.sole, alpha: 0.7 };

/** Joint layout (rest pose), metres. Feet on y = 0, facing -Z. */
export const HERO_JOINTS = {
  pelvisY: 0.9,
  hipX: 0.105,
  hipY: -0.05,
  thigh: 0.38,
  shin: 0.37,
  /** Ankle height above the sole. */
  ankle: 0.1,
  spineY: 0.06,
  neckY: 0.46,
  shoulderX: 0.245,
  shoulderY: 0.385,
  upperArm: 0.26,
  scarfAt: [0.04, 0.47, 0.125] as V3,
  scarfSeg: 0.15,
  satchelAt: [0, 0.4, 0.15] as V3,
} as const;

const J = HERO_JOINTS;

function pelvis(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 11, jitter: 0.03 });
  loft(mb, [
    { y: -0.13, rx: 0.15, rz: 0.11 },
    { y: -0.04, rx: 0.185, rz: 0.13 },
    { y: 0.05, rx: 0.19, rz: 0.13 },
    { y: 0.09, rx: 0.18, rz: 0.125 },
  ], { bands: [H.pantsDark, H.pants, H.strap] });
  // Belt buckle.
  mb.block(-0.035, 0.05, -0.135, 0.035, 0.09, -0.115, H.metal);
  return mb;
}

function torso(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 12, jitter: 0.03 });
  loft(mb, [
    { y: -0.03, rx: 0.17, rz: 0.12 },
    { y: 0.03, rx: 0.18, rz: 0.125 },
    { y: 0.16, rx: 0.2, rz: 0.135 },
    { y: 0.2, rx: 0.208, rz: 0.14 },
    { y: 0.25, rx: 0.218, rz: 0.145 },
    { y: 0.35, rx: 0.232, rz: 0.15 },
    { y: 0.42, rx: 0.212, rz: 0.135 },
    { y: 0.47, rx: 0.13, rz: 0.1 },
  ], { bands: [H.jacketDark, shadeHex(H.jacket, 0.88), H.jacket, REFLECT, H.jacket, shadeHex(H.jacket, 1.05), H.jacketLight] });
  // Shoulder yokes (lighter panels).
  for (const s of [-1, 1]) {
    mb.push().translate(s * 0.15, 0.4, 0).rotateZ(s * -0.35).bevelBox(0.14, 0.05, 0.27, 0.02, H.jacketLight).pop();
  }
  // Collar.
  loft(mb, [
    { y: 0.42, rx: 0.135, rz: 0.11 },
    { y: 0.5, rx: 0.12, rz: 0.1 },
  ], { bands: [H.jacketLight], capBottom: false });
  // Neck.
  mb.push().translate(0, 0.52, 0.0).cylinder(0.06, 0.08, 8, {}, H.skinDark).pop();
  // Scarf wrap + knot + short front tail.
  loft(mb, [
    { y: 0.45, rx: 0.14, rz: 0.12 },
    { y: 0.5, rx: 0.145, rz: 0.125 },
    { y: 0.545, rx: 0.12, rz: 0.105 },
  ], { bands: [H.scarfDark, H.scarf] });
  mb.push().translate(-0.06, 0.47, -0.12).rotateZ(0.3).bevelBox(0.09, 0.08, 0.06, 0.02, H.scarf).pop();
  mb.push().translate(-0.075, 0.37, -0.145).rotateZ(0.15).rotateX(0.12).bevelBox(0.07, 0.14, 0.025, 0.01, H.scarfDark).pop();
  // Satchel strap across the chest (right shoulder to left hip) and over the back.
  const strapPts = (z: number, dir: 1 | -1) => {
    const a: V3 = [0.17, 0.43, z], b: V3 = [-0.2, 0.06, z];
    const w = 0.035;
    faceToward(mb, [[a[0] - w, a[1] + w, a[2]], [a[0] + w, a[1] - w, a[2]], [b[0] + w, b[1] - w, b[2]], [b[0] - w, b[1] + w, b[2]]], [0, 0, dir], H.strap);
  };
  strapPts(-0.152, -1);
  strapPts(0.152, 1);
  // Chest pocket flap + zip.
  mb.block(0.055, 0.27, -0.153, 0.16, 0.3, -0.141, H.jacketDark);
  mb.block(-0.012, 0.0, -0.137, 0.012, 0.19, -0.127, H.jacketLight);
  // Hem.
  loft(mb, [
    { y: -0.05, rx: 0.175, rz: 0.125 },
    { y: 0.0, rx: 0.178, rz: 0.127 },
  ], { bands: [H.jacketDark] });
  return mb;
}

function head(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 13, jitter: 0.025 });
  // Skull / face.
  loft(mb, [
    { y: 0.03, rx: 0.095, rz: 0.095, z: -0.01 },
    { y: 0.07, rx: 0.145, rz: 0.15, z: -0.01 },
    { y: 0.16, rx: 0.172, rz: 0.178, z: -0.005 },
    { y: 0.25, rx: 0.168, rz: 0.174 },
    { y: 0.3, rx: 0.14, rz: 0.146 },
  ], { bands: [H.skinDark, H.skin, H.skin, H.skin], capTop: false });
  // Hair at the back and sides, under the cap.
  loft(mb, [
    { y: 0.08, rx: 0.15, rz: 0.155, z: 0.012 },
    { y: 0.17, rx: 0.18, rz: 0.186, z: 0.01 },
    { y: 0.27, rx: 0.176, rz: 0.182, z: 0.008 },
  ], { bands: [H.hair], capTop: false, capBottom: false, keep: (c) => c[2] > 0.02 });
  // Ears.
  for (const s of [-1, 1]) mb.push().translate(s * 0.172, 0.15, 0.01).bevelBox(0.035, 0.07, 0.06, 0.012, H.skinDark).pop();
  // Eyes (dark ovals with a glint), brows, nose, smile.
  for (const s of [-1, 1]) {
    mb.push().translate(s * 0.064, 0.165, -0.168).sphere(0.03, 0.04, 0.016, 6, 3, H.eye).pop();
    mb.block(s * 0.064 - 0.005 - s * 0.01, 0.18, -0.188, s * 0.064 + 0.009 - s * 0.01, 0.193, -0.18, 0xffffff);
    mb.push().translate(s * 0.068, 0.222, -0.17).rotateZ(s * 0.18).box(0.06, 0.016, 0.02, H.hair).pop();
  }
  mb.push().translate(0, 0.125, -0.18).bevelBox(0.042, 0.05, 0.04, 0.012, H.skinDark).pop();
  mb.push().translate(0, 0.082, -0.163).rotateX(0.2).box(0.07, 0.014, 0.02, 0x9a4a3a).pop();
  // Cap: crown, band, button, logo, brim.
  loft(mb, [
    { y: 0.235, rx: 0.186, rz: 0.19 },
    { y: 0.27, rx: 0.19, rz: 0.194 },
    { y: 0.33, rx: 0.172, rz: 0.176 },
    { y: 0.375, rx: 0.12, rz: 0.124 },
    { y: 0.39, rx: 0.04, rz: 0.04 },
  ], { bands: [H.capDark, H.cap, H.cap, shadeHex(H.cap, 1.1)] });
  mb.push().translate(0, 0.395, 0).cylinder(0.025, 0.02, 6, {}, H.scarf).pop();
  mb.push().translate(0, 0.3, -0.18).rotateX(Math.PI / 2 - 0.35).cylinder(0.042, 0.012, 8, {}, H.scarf).pop();
  // Brim (tapered slab, slightly drooping).
  mb.push().translate(0, 0.245, -0.16).rotateX(0.12);
  faceBrim(mb);
  mb.pop();
  // Back strap opening of the cap.
  mb.block(-0.05, 0.24, 0.17, 0.05, 0.27, 0.19, H.scarf);
  return mb;
}

function faceBrim(mb: MeshBuilder): void {
  // Brim in local space: from z = 0 (at the crown) to z = -0.17 (front), rounded front edge.
  const pts: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = Math.PI + (i / 6) * Math.PI;
    pts.push([Math.cos(a) * 0.17, Math.sin(a) * 0.16]);
  }
  pts.push([0.17, 0.02], [-0.17, 0.02]);
  // Extrude in XY then lay it flat (XY -> XZ).
  mb.push().rotateX(Math.PI / 2);
  mb.extrude(pts.map(([x, y]) => [x, y] as [number, number]), 0.022, H.capDark);
  mb.pop();
}

function upperArm(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 14, jitter: 0.03 });
  mb.push().translate(0, -0.01, 0).sphere(0.09, 0.08, 0.085, 8, 4, H.jacket).pop();
  loft(mb, [
    { y: -0.02, rx: 0.075, rz: 0.075 },
    { y: -0.14, rx: 0.07, rz: 0.07 },
    { y: -0.27, rx: 0.06, rz: 0.062 },
  ], { bands: [H.jacket, shadeHex(H.jacket, 0.9)], sides: 7 });
  // Reflective arm band.
  loft(mb, [
    { y: -0.1, rx: 0.075, rz: 0.075 },
    { y: -0.13, rx: 0.073, rz: 0.073 },
  ], { bands: [REFLECT], sides: 7 });
  return mb;
}

function foreArm(side: -1 | 1): MeshBuilder {
  const mb = new MeshBuilder({ seed: 15, jitter: 0.03 });
  loft(mb, [
    { y: 0.02, rx: 0.06, rz: 0.062 },
    { y: -0.15, rx: 0.055, rz: 0.056 },
    { y: -0.17, rx: 0.066, rz: 0.066 },
    { y: -0.215, rx: 0.064, rz: 0.064 },
  ], { bands: [shadeHex(H.jacket, 0.92), H.jacketLight, H.jacketLight], sides: 7 });
  // Big chunky fist + thumb on the inner-forward side.
  mb.push().translate(0, -0.285, -0.005).bevelBox(0.12, 0.13, 0.125, 0.032, { color: H.skin, bottom: H.skinDark }).pop();
  mb.push().translate(-side * 0.05, -0.255, -0.045).rotateZ(side * 0.3).bevelBox(0.04, 0.07, 0.045, 0.012, H.skin).pop();
  // Knuckle line.
  mb.block(-0.045, -0.3, -0.064, 0.045, -0.29, -0.058, H.skinDark);
  return mb;
}

function thigh(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 16, jitter: 0.03 });
  loft(mb, [
    { y: 0.04, rx: 0.098, rz: 0.1 },
    { y: -0.17, rx: 0.095, rz: 0.1 },
    { y: -0.39, rx: 0.074, rz: 0.078 },
  ], { bands: [H.pants, shadeHex(H.pants, 0.9)], sides: 7 });
  // Cargo pocket on the outer side is added per side by the rig? Keep symmetric: a front crease.
  mb.block(-0.01, -0.3, -0.087, 0.01, -0.06, -0.08, H.pantsDark);
  return mb;
}

function shin(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 17, jitter: 0.03 });
  loft(mb, [
    { y: 0.02, rx: 0.074, rz: 0.077 },
    { y: -0.1, rx: 0.079, rz: 0.084 },
    { y: -0.27, rx: 0.06, rz: 0.062 },
    { y: -0.29, rx: 0.066, rz: 0.068 },
    { y: -0.3, rx: 0.056, rz: 0.058 },
    { y: -0.375, rx: 0.052, rz: 0.054 },
  ], { bands: [H.pants, shadeHex(H.pants, 0.92), H.pantsDark, H.pantsDark, H.sock], sides: 7 });
  return mb;
}

/** Chunky sneaker, ankle joint at the origin, sole bottom at y = -ankle. */
function foot(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 18, jitter: 0.025 });
  const a = J.ankle;
  // Sole: dark tread + orange midsole stripe + white wall.
  mb.push().translate(0, -a + 0.012, -0.055).box(0.15, 0.024, 0.31, H.tread).pop();
  mb.push().translate(0, -a + 0.037, -0.055).bevelBox(0.158, 0.03, 0.315, 0.012, SOLE).pop();
  // Upper.
  mb.push().translate(0, -a + 0.085, -0.03).bevelBox(0.145, 0.075, 0.24, 0.035, H.shoe).pop();
  // Toe box (lower, rounder).
  mb.push().translate(0, -a + 0.07, -0.16).bevelBox(0.14, 0.055, 0.1, 0.03, H.shoe).pop();
  // Ankle collar + heel tab.
  mb.push().translate(0, -a + 0.13, 0.03).bevelBox(0.13, 0.06, 0.12, 0.03, H.shoe).pop();
  mb.push().translate(0, -a + 0.13, 0.095).box(0.06, 0.08, 0.025, H.scarf).pop();
  // Laces (teal) and a side swoosh-free stripe (teal panel).
  for (let i = 0; i < 3; i++) mb.block(-0.04, -a + 0.123 - i * 0.006, -0.055 - i * 0.035, 0.04, -a + 0.135 - i * 0.006, -0.04 - i * 0.035, H.jacket);
  for (const s of [-1, 1]) {
    faceToward(mb, [[s * 0.0735, -a + 0.065, 0.05], [s * 0.0735, -a + 0.065, -0.1], [s * 0.0735, -a + 0.095, -0.06], [s * 0.0735, -a + 0.095, 0.04]], [s, 0, 0], H.jacket);
  }
  return mb;
}

/** Scarf tail segment, hanging -Y from its pivot. `end` adds the fringe. */
function scarfSeg(i: number): MeshBuilder {
  const mb = new MeshBuilder({ seed: 20 + i, jitter: 0.03 });
  const w = 0.165 - i * 0.012;
  const len = J.scarfSeg + 0.02;
  taper(mb, -len, 0, w * 0.92, 0.034, w, 0.036, i === 1 ? H.scarfDark : H.scarf);
  if (i === 2) {
    // White stripe + fringe.
    mb.block(-w * 0.47, -len * 0.62, -0.014, w * 0.47, -len * 0.5, 0.014, 0xfff3e6);
    for (let k = -2; k <= 2; k++) mb.block(k * 0.024 - 0.008, -len - 0.05, -0.01, k * 0.024 + 0.008, -len, 0.01, H.scarfLight);
  }
  return mb;
}

/** Messenger satchel with a jet nozzle underneath. Pivot at the top-centre of the strap. */
function satchel(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 30, jitter: 0.03 });
  // Bag body (hangs below the pivot, sitting against the back).
  mb.push().translate(0, -0.17, 0.07).bevelBox(0.36, 0.28, 0.14, 0.04, { color: H.leather, bottom: H.leatherDark }).pop();
  // Flap over the top and most of the back face.
  mb.push().translate(0, -0.06, 0.07).bevelBox(0.37, 0.07, 0.15, 0.03, H.leatherLight).pop();
  mb.push().translate(0, -0.135, 0.147).box(0.355, 0.2, 0.02, H.leatherLight).pop();
  // Courier logo on the flap: orange disc with a white parcel arrow.
  mb.push().translate(0, -0.14, 0.159).rotateX(Math.PI / 2).cylinder(0.065, 0.01, 10, {}, H.scarf).pop();
  faceToward(mb, [[-0.035, -0.17, 0.166], [0.02, -0.17, 0.166], [0.02, -0.11, 0.166], [-0.035, -0.11, 0.166]], [0, 0, 1], 0xfff6ea);
  faceToward(mb, [[0.02, -0.18, 0.167], [0.055, -0.14, 0.167], [0.02, -0.1, 0.167]], [0, 0, 1], 0xfff6ea);
  // Reflector strip across the bottom of the back face (catches the light at night).
  mb.block(-0.15, -0.262, 0.148, 0.15, -0.238, 0.162, REFLECT_STRIP);
  // Buckle straps.
  for (const s of [-1, 1]) {
    mb.block(s * 0.12 - 0.02, -0.29, 0.155, s * 0.12 + 0.02, -0.07, 0.165, H.strap);
    mb.block(s * 0.12 - 0.025, -0.25, 0.163, s * 0.12 + 0.025, -0.225, 0.17, H.metal);
  }
  // Side pockets.
  for (const s of [-1, 1]) mb.push().translate(s * 0.19, -0.2, 0.07).box(0.04, 0.14, 0.1, H.leatherDark).pop();
  // Strap stubs going over the shoulders.
  for (const s of [-1, 1]) mb.block(s * 0.1 - 0.022, -0.04, 0.0, s * 0.1 + 0.022, 0.06, 0.02, H.strap);
  // Jet nozzle + vents.
  mb.push().translate(0, -0.33, 0.07).cylinder(0.055, 0.06, 8, { radiusTop: 0.045 }, H.nozzle).pop();
  mb.push().translate(0, -0.365, 0.07).cylinder(0.065, 0.025, 8, { radiusTop: 0.055 }, 0x2b3038).pop();
  for (const s of [-1, 1]) mb.push().translate(s * 0.11, -0.315, 0.07).cylinder(0.025, 0.04, 6, {}, H.nozzle).pop();
  return mb;
}

// ---------------------------------------------------------------- power-up FX

/** Dashed ring in the XZ plane (magnet aura), additive vertex colours. */
function magnetRing(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 40, jitter: 0 });
  mb.push().rotateX(Math.PI / 2);
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    ring(mb, 0.64, 0.54, 0.05, 3, { color: i % 2 ? 0xff3044 : 0xd8e4ff, alpha: 0.85 }, (Math.PI * 2) / n * 0.62, a0, false, true);
  }
  mb.pop();
  return mb;
}

/** Thruster flame pointing -Y (additive gradient: hot core at the top, fading to black). */
function flame(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 41, jitter: 0 });
  // Outer flame.
  loft(mb, [
    { y: 0, rx: 0.06, rz: 0.06 },
    { y: -0.08, rx: 0.085, rz: 0.085 },
    { y: -0.3, rx: 0.06, rz: 0.06 },
    { y: -0.62, rx: 0, rz: 0 },
  ], { sides: 8, bands: [{ color: 0xffd27a, alpha: 0.9 }, { color: 0xff8a2a, alpha: 0.6 }, { color: 0xff5a10, alpha: 0.18 }], capTop: false });
  // Inner core.
  loft(mb, [
    { y: -0.01, rx: 0.035, rz: 0.035 },
    { y: -0.1, rx: 0.045, rz: 0.045 },
    { y: -0.3, rx: 0, rz: 0 },
  ], { sides: 6, bands: [{ color: 0xfff6d8, alpha: 1 }, { color: 0xffc060, alpha: 0.55 }], capTop: false });
  return mb;
}

/** Four diamond sparkles on a circle (multiplier), emissive purple. */
function sparkles(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 42, jitter: 0 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const r = 0.36;
    const y = i % 2 ? 0.06 : -0.04;
    mb.push().translate(Math.cos(a) * r, y, Math.sin(a) * r).rotateY(a);
    loft(mb, [
      { y: -0.1, rx: 0, rz: 0 },
      { y: 0, rx: 0.055, rz: 0.055 },
      { y: 0.1, rx: 0, rz: 0 },
    ], { sides: 4, bands: [0xd9a0ff, 0xf3dcff] });
    mb.pop();
  }
  // A small "x2" orbiting badge would clutter: a central halo instead.
  return mb;
}

export interface HeroGeometry {
  pelvis: Geometry3D;
  torso: Geometry3D;
  head: Geometry3D;
  upperArm: Geometry3D;
  foreArmL: Geometry3D;
  foreArmR: Geometry3D;
  thigh: Geometry3D;
  shin: Geometry3D;
  foot: Geometry3D;
  scarf: Geometry3D[];
  satchel: Geometry3D;
  shield: Geometry3D;
  magnet: Geometry3D;
  flame: Geometry3D;
  nozzleGlow: Geometry3D;
  sparkles: Geometry3D;
}

/** Builders only (no GPU objects): used by tests to count triangles. */
export function heroBuilders(): Record<string, MeshBuilder> {
  return {
    pelvis: pelvis(),
    torso: torso(),
    head: head(),
    upperArmL: upperArm(),
    upperArmR: upperArm(),
    foreArmL: foreArm(-1),
    foreArmR: foreArm(1),
    thighL: thigh(),
    thighR: thigh(),
    shinL: shin(),
    shinR: shin(),
    footL: foot(),
    footR: foot(),
    scarf0: scarfSeg(0),
    scarf1: scarfSeg(1),
    scarf2: scarfSeg(2),
    satchel: satchel(),
    magnetA: magnetRing(),
    magnetB: magnetRing(),
    flame: flame(),
    sparkles: sparkles(),
  };
}

/** Engine sphere used for the shield (smooth normals for a clean fresnel rim). */
export const SHIELD_SEGMENTS = { widthSegments: 16, heightSegments: 10 } as const;

let cache: HeroGeometry | null = null;

export function heroGeometry(): HeroGeometry {
  if (cache) return cache;
  const nozzle = new MeshBuilder({ seed: 43, jitter: 0 });
  nozzle.sphere(0.07, 0.05, 0.07, 8, 4, 0xffffff);
  cache = {
    pelvis: pelvis().build(),
    torso: torso().build(),
    head: head().build(),
    upperArm: upperArm().build(),
    foreArmL: foreArm(-1).build(),
    foreArmR: foreArm(1).build(),
    thigh: thigh().build(),
    shin: shin().build(),
    foot: foot().build(),
    scarf: [scarfSeg(0).build(), scarfSeg(1).build(), scarfSeg(2).build()],
    satchel: satchel().build(),
    shield: new SphereGeometry({ radius: 1, ...SHIELD_SEGMENTS }),
    magnet: magnetRing().build(),
    flame: flame().build(),
    nozzleGlow: nozzle.build(),
    sparkles: sparkles().build(),
  };
  return cache;
}
