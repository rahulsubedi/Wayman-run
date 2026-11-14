// Walkable vehicles: delivery truck (6 m), city bus (10 m) and the oncoming bus.
// Boxes are exactly 2.1 wide and their roofs are FLAT at ROOF_Y (the collider top) with low rails
// and hatch panels so they read as "run on me". Parked ones face away from the player (-Z), so the
// player sees their rear (tail lights, plates, reflective tape); the oncoming bus faces +Z with
// its headlights on.
import { OBSTACLE_DIMS, ROOF_Y } from '../../sim/config';
import { shadeHex } from '../geom/color';
import { MeshBuilder } from '../geom/meshBuilder';
import { diagonalStripes, faceToward, taper, type V3 } from './kit';
import { C, type ObstacleBuilders } from './obstacles';

const HW = OBSTACLE_DIMS.truck.w / 2; // 1.05
const WHEEL_R = 0.44;
const WHEEL_W = 0.28;
const WHEEL_X = HW - WHEEL_W / 2 - 0.01;
const ROOF = ROOF_Y;
const GLASS_DARK = 0x1a2430;

export interface TruckLivery {
  box: number;
  cab: number;
  stripe: number;
  emblem: 'parcel' | 'fish' | 'citrus';
  roof: number;
}

export const TRUCK_LIVERIES: readonly TruckLivery[] = [
  { box: 0xf4f1e8, cab: 0x2f86d6, stripe: 0xe8553f, emblem: 'parcel', roof: 0xdfe4ea },
  { box: 0xf2b134, cab: 0xf2b134, stripe: 0x253a66, emblem: 'fish', roof: 0xe9e2cf },
  { box: 0x58b6e8, cab: 0xf4f1e8, stripe: 0xffffff, emblem: 'citrus', roof: 0xe6edf2 },
];

export interface BusLivery {
  lower: number;
  upper: number;
  stripe: number;
  roof: number;
  door: number;
}

export const BUS_LIVERIES: readonly BusLivery[] = [
  { lower: 0xf2b134, upper: 0xf7f2e4, stripe: 0xe0503c, roof: 0xf2efe6, door: 0xd9922a },
  { lower: 0xe8553f, upper: 0xf7f2e4, stripe: 0x253a66, roof: 0xf2efe6, door: 0xbf3f2e },
  { lower: 0x3f9fe0, upper: 0xf4f6f8, stripe: 0xffc81f, roof: 0xeef2f5, door: 0x2e7fbf },
];

/** Oncoming bus: violet, unique among the vehicles, so "purple = coming at you". */
export const ONCOMING_LIVERY: BusLivery = { lower: 0x7a4fd6, upper: 0xf4f0ff, stripe: 0x9cf04a, roof: 0xece8f8, door: 0x5d3aae };

// --------------------------------------------------------------------- parts

/** One axle: both wheels, centred on the axle line (origin), axis along X. */
function axleBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 901, jitter: 0.02 });
  for (const s of [-1, 1]) {
    mb.push().translate(s * WHEEL_X, 0, 0).rotateZ(Math.PI / 2);
    mb.cylinder(WHEEL_R, WHEEL_W, 12, {}, C.rubber);
    // Hub cap (outer side) and a spoke star so the spin reads.
    mb.push().translate(0, s * (WHEEL_W / 2 + 0.006), 0).cylinder(WHEEL_R * 0.55, 0.02, 8, {}, 0xc9d0d8).pop();
    mb.push().translate(0, s * (WHEEL_W / 2 + 0.016), 0).cylinder(WHEEL_R * 0.18, 0.02, 6, {}, 0x6b7380).pop();
    for (let k = 0; k < 3; k++) {
      mb.push().translate(0, s * (WHEEL_W / 2 + 0.014), 0).rotateY((k * Math.PI) / 3).box(WHEEL_R * 1.0, 0.012, 0.05, 0x8a939e).pop();
    }
    mb.pop();
  }
  return mb;
}

/** Static wheels baked into the body (parked vehicles). */
function bakeWheels(mb: MeshBuilder, zs: number[]): void {
  const ax = axleBuilder();
  for (const z of zs) {
    mb.push().translate(0, WHEEL_R, z).merge(ax).pop();
  }
}

/** Dark wheel-arch recess on both sides around an axle. */
function arches(mb: MeshBuilder, z: number, y0: number): void {
  for (const s of [-1, 1]) {
    const x = s * (HW + 0.004);
    // A half-octagon cut-out look: dark polygon on the side.
    const r = WHEEL_R + 0.08;
    const pts: V3[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI;
      pts.push([x, Math.max(y0, WHEEL_R + Math.sin(a) * r), z + Math.cos(a) * r]);
    }
    faceToward(mb, pts, [s, 0, 0], 0x15181d);
  }
}

/** A rectangle decal on a side face (normal ±X) at x = s * (HW + off). */
function sideRect(mb: MeshBuilder, s: number, y0: number, y1: number, z0: number, z1: number, color: number, off = 0.004): void {
  const x = s * (HW + off);
  faceToward(mb, [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]], [s, 0, 0], color);
}

/** A rectangle decal on an end face (normal ±Z) at z. */
function endRect(mb: MeshBuilder, f: number, z: number, x0: number, x1: number, y0: number, y1: number, color: number): void {
  faceToward(mb, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, f], color);
}

const GLINT = 0x51708a;

/** Two slanted reflection streaks on a side window's dark interior (reads as glass). */
function sideGlint(mb: MeshBuilder, s: number, y0: number, y1: number, z0: number, z1: number, off: number): void {
  const x = s * (HW + off + 0.002);
  const w = z1 - z0, h = y1 - y0;
  for (const [a, b] of [[0.18, 0.34], [0.42, 0.5]]) {
    const za = z0 + w * a, zb = z0 + w * b, k = Math.min(w * 0.25, h * 0.5);
    faceToward(mb, [[x, y0, za], [x, y0, zb], [x, y1, zb - k], [x, y1, za - k]], [s, 0, 0], GLINT);
  }
}

/** Reflection streaks on an end window (normal ±Z). */
function endGlint(mb: MeshBuilder, f: number, z: number, x0: number, x1: number, y0: number, y1: number): void {
  const w = x1 - x0, h = y1 - y0;
  const zz = z + f * 0.002;
  for (const [a, b] of [[0.12, 0.26], [0.33, 0.39]]) {
    const xa = x0 + w * a, xb = x0 + w * b, k = Math.min(w * 0.15, h * 0.5);
    faceToward(mb, [[xa, y0, zz], [xb, y0, zz], [xb + k, y1, zz], [xa + k, y1, zz]], [0, 0, f], GLINT);
  }
}

/** Glass pane on a side (glass mesh) slightly outside the dark interior decal. */
function sidePane(g: MeshBuilder, s: number, y0: number, y1: number, z0: number, z1: number): void {
  const x = s * (HW + 0.01);
  faceToward(g, [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]], [s, 0, 0], 0xffffff);
}

function endPane(g: MeshBuilder, f: number, z: number, x0: number, x1: number, y0: number, y1: number): void {
  faceToward(g, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, f], 0xffffff);
}

/** Flat walkable roof: cap plate at ROOF, low side rails, two hatch panels. */
function roof(mb: MeshBuilder, z0: number, z1: number, color: number, hatches: number[]): void {
  mb.block(-HW + 0.03, ROOF - 0.05, z0, HW - 0.03, ROOF, z1, { color, bottom: shadeHex(color, 0.85) });
  for (const s of [-1, 1]) {
    mb.block(s * (HW - 0.03) - 0.025, ROOF, z0 + 0.1, s * (HW - 0.03) + 0.025, ROOF + 0.035, z1 - 0.1, 0x8b939e);
  }
  for (const zc of hatches) {
    mb.block(-0.45, ROOF, zc - 0.45, 0.45, ROOF + 0.012, zc + 0.45, shadeHex(color, 0.8));
    mb.block(-0.32, ROOF + 0.012, zc - 0.32, 0.32, ROOF + 0.02, zc + 0.32, shadeHex(color, 0.92));
  }
}

/** Mirror on an arm at the front corners (stays within the 2.1 m width + 3 cm). */
function mirrors(mb: MeshBuilder, zFront: number, y: number): void {
  for (const s of [-1, 1]) {
    mb.block(s * (HW - 0.02), y - 0.02, zFront + 0.1, s * (HW + 0.02), y + 0.02, zFront + 0.3, C.black);
    mb.push().translate(s * (HW + 0.0), y - 0.12, zFront + 0.12).bevelBox(0.06, 0.3, 0.14, 0.02, C.black).pop();
  }
}

// ---------------------------------------------------------------- emblems

function emblem(mb: MeshBuilder, kind: TruckLivery['emblem'], x: number, s: number, y: number, z: number, col: number, accent: number): void {
  mb.push().translate(x, y, z).rotateY((s * Math.PI) / 2);
  if (s < 0) mb.scale(-1, 1, 1);
  if (kind === 'parcel') {
    mb.push().translate(0, 0, 0).box(0.7, 0.55, 0.02, accent).pop();
    mb.push().translate(0, 0, 0.012).box(0.1, 0.55, 0.02, col).pop();
    mb.push().translate(0, 0, 0.012).box(0.7, 0.1, 0.02, col).pop();
    mb.push().translate(-0.1, 0.33, 0.012).rotateZ(0.5).box(0.22, 0.08, 0.02, col).pop();
    mb.push().translate(0.1, 0.33, 0.012).rotateZ(-0.5).box(0.22, 0.08, 0.02, col).pop();
  } else if (kind === 'fish') {
    const body: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      body.push([Math.cos(a) * 0.42 + 0.1, Math.sin(a) * 0.22]);
    }
    mb.extrude(body, 0.02, accent);
    mb.extrude([[-0.28, 0], [-0.55, 0.2], [-0.5, 0], [-0.55, -0.2]], 0.02, accent);
    mb.push().translate(0.34, 0.05, 0.012).box(0.07, 0.07, 0.02, col).pop();
    mb.push().translate(0.05, 0, 0.012).rotateZ(0.3).box(0.04, 0.28, 0.02, col).pop();
  } else {
    // Citrus slice: rind ring + segments.
    mb.push();
    mb.rotateX(Math.PI / 2);
    mb.cylinder(0.36, 0.02, 12, {}, accent);
    mb.translate(0, 0.012, 0).cylinder(0.29, 0.02, 12, {}, 0xfff2b0);
    for (let k = 0; k < 6; k++) {
      mb.push().rotateY((k * Math.PI) / 3).translate(0.15, 0.012, 0).box(0.2, 0.02, 0.1, 0xffc23a).pop();
    }
    mb.pop();
  }
  mb.pop();
}

// -------------------------------------------------------------------- truck

function truck(v: number): ObstacleBuilders {
  const L = TRUCK_LIVERIES[v % TRUCK_LIVERIES.length];
  const len = OBSTACLE_DIMS.truck.len;
  const zf = -len / 2, zr = len / 2; // front (-Z), rear (+Z)
  const mb = new MeshBuilder({ seed: 400 + v, jitter: 0.025 });
  const glass = new MeshBuilder({ seed: 410 + v });
  const glow = new MeshBuilder({ seed: 420 + v });
  const boxFront = zf + 1.75;

  // Chassis + bumpers.
  mb.block(-0.8, 0.3, zf + 0.25, 0.8, 0.55, zr - 0.2, C.steelDark);
  mb.push().translate(0, 0.42, zr - 0.06).bevelBox(HW * 2 - 0.06, 0.2, 0.12, 0.03, 0x4a515c).pop();
  mb.block(-0.5, 0.26, zr - 0.18, 0.5, 0.32, zr - 0.02, C.steel); // rear step
  mb.push().translate(0, 0.45, zf + 0.07).bevelBox(HW * 2 - 0.04, 0.26, 0.14, 0.04, 0xc9cfd6).pop();

  // Cargo box.
  mb.push().translate(0, (0.58 + ROOF - 0.05) / 2, (boxFront + zr - 0.1) / 2)
    .bevelBox(HW * 2, ROOF - 0.05 - 0.58, zr - 0.1 - boxFront, 0.06, { color: L.box, bottom: shadeHex(L.box, 0.84) }).pop();
  // Cab + roof fairing up to the roof line.
  mb.push().translate(0, (0.55 + 2.25) / 2, (zf + 0.12 + boxFront + 0.05) / 2)
    .bevelBox(HW * 2 - 0.04, 2.25 - 0.55, boxFront + 0.05 - zf - 0.12, 0.12, { color: L.cab, bottom: shadeHex(L.cab, 0.8) }).pop();
  // Fairing: tapered from the cab top to the roof, sloping toward the front.
  mb.push().translate(0, 0, (zf + 0.25 + boxFront) / 2);
  taper(mb, 2.2, ROOF - 0.05, HW * 2 - 0.08, boxFront - zf - 0.3, HW * 2 - 0.04, boxFront - zf - 0.55, { color: L.cab, top: shadeHex(L.cab, 1.08) }, 0.12);
  mb.pop();
  roof(mb, zf + 0.42, zr - 0.08, L.roof, [zf + 2.6, zr - 1.3]);

  // Cab front: windshield (interior + glass), grille, headlights (off), plate.
  const fz = zf + 0.115;
  endRect(mb, -1, fz - 0.005, -0.86, 0.86, 1.45, 2.12, GLASS_DARK);
  endGlint(mb, -1, fz - 0.005, -0.86, 0.86, 1.45, 2.12);
  endPane(glass, -1, fz - 0.02, -0.86, 0.86, 1.45, 2.12);
  endRect(mb, -1, fz - 0.005, -0.6, 0.6, 0.7, 1.05, 0x2b3038);
  for (let i = 0; i < 4; i++) endRect(mb, -1, fz - 0.01, -0.56, 0.56, 0.74 + i * 0.08, 0.77 + i * 0.08, 0x8b939e);
  for (const s of [-1, 1]) endRect(mb, -1, fz - 0.01, s * 0.66 - 0.14, s * 0.66 + 0.14, 0.78, 0.98, 0xfff4cc);
  // Cab side windows.
  for (const s of [-1, 1]) {
    sideRect(mb, s, 1.5, 2.1, zf + 0.35, zf + 1.35, GLASS_DARK, -0.015);
    sideGlint(mb, s, 1.5, 2.1, zf + 0.35, zf + 1.35, -0.015);
    sidePane(glass, s, 1.5, 2.1, zf + 0.35, zf + 1.35);
    sideRect(mb, s, 1.15, 1.18, zf + 0.5, zf + 0.75, 0x2b3038, -0.015); // door handle
  }
  mirrors(mb, zf, 2.05);

  // Livery on the box sides: stripe band + emblem.
  for (const s of [-1, 1]) {
    sideRect(mb, s, 0.95, 1.18, boxFront + 0.1, zr - 0.15, L.stripe);
    sideRect(mb, s, 1.2, 1.25, boxFront + 0.1, zr - 0.15, shadeHex(L.stripe, 0.8));
    emblem(mb, L.emblem, s * (HW - 0.002), s, 1.85, boxFront + 2.0, L.box, L.stripe === 0xffffff ? 0xff7a2f : L.stripe);
    sideRect(mb, s, 0.6, 0.66, boxFront + 0.1, zr - 0.15, 0x3a414c);
  }
  // Rear: roll-up door ribs, reflective tape, tail lights, plate.
  const rz = zr - 0.1 + 0.005;
  // Twin swing doors: recessed frame, centre seam, panel insets, four locking bars with cam
  // keepers and handles, hinges on the outer edges, a door logo plate.
  const dark = shadeHex(L.box, 0.7), mid = shadeHex(L.box, 0.88);
  endRect(mb, 1, rz, -0.95, 0.95, 0.78, 0.84, dark);
  endRect(mb, 1, rz, -0.95, 0.95, ROOF - 0.3, ROOF - 0.24, dark);
  endRect(mb, 1, rz, -0.015, 0.015, 0.84, ROOF - 0.3, 0x2b3038);
  for (const s of [-1, 1]) {
    endRect(mb, 1, rz, s * 0.1 - 0.35, s * 0.1 + 0.35 * 1, 1.3, 1.95, mid);
    endRect(mb, 1, rz, s * 0.47 - 0.33, s * 0.47 + 0.33, 2.02, ROOF - 0.4, mid);
    for (const x of [s * 0.3, s * 0.72]) {
      endRect(mb, 1, rz + 0.012, x - 0.025, x + 0.025, 0.86, ROOF - 0.32, C.steelLight); // locking bar
      endRect(mb, 1, rz + 0.016, x - 0.04, x + 0.04, 0.86, 0.92, C.steel); // cam keepers
      endRect(mb, 1, rz + 0.016, x - 0.04, x + 0.04, ROOF - 0.38, ROOF - 0.32, C.steel);
      endRect(mb, 1, rz + 0.02, x - 0.03, x + 0.11 * s, 1.4, 1.46, 0x2b3038); // handle
    }
    for (const y of [1.0, 1.75, 2.5]) endRect(mb, 1, rz + 0.012, s * 0.93 - 0.05, s * 0.93 + 0.03 * s, y, y + 0.12, 0x2b3038); // hinges
  }
  // Courier-style door plate: emblem on a pale panel (left door).
  endRect(mb, 1, rz + 0.008, -0.62, -0.14, 2.1, 2.36, 0xf4f1e8);
  endRect(mb, 1, rz + 0.01, -0.58, -0.18, 2.2, 2.26, L.stripe === 0xffffff ? 0xff7a2f : L.stripe);
  endRect(mb, 1, rz + 0.001, -HW + 0.06, HW - 0.06, 0.95, 1.18, L.stripe === 0xffffff ? 0xff7a2f : L.stripe);
  endRect(mb, 1, rz + 0.001, -HW + 0.06, HW - 0.06, 2.42, 2.52, L.cab);
  diagonalStripes(mb, -HW + 0.06, HW - 0.06, 0.62, 0.74, rz + 0.002, C.red, 0.24, 1, 1);
  endRect(mb, 1, rz + 0.001, -HW + 0.06, HW - 0.06, 0.62, 0.74, C.white);
  endRect(mb, 1, zr + 0.002, -0.2, 0.2, 0.36, 0.5, 0xf6f4ee); // plate on the bumper
  endRect(mb, 1, zr + 0.003, -0.15, 0.15, 0.4, 0.46, 0x253a66);
  for (const s of [-1, 1]) {
    endRect(glow, 1, rz + 0.004, s * 0.88 - 0.1, s * 0.88 + 0.1, 0.8, 1.25, 0xff2a1a);
    endRect(glow, 1, rz + 0.004, s * 0.88 - 0.1, s * 0.88 + 0.1, 1.28, 1.38, 0xffa020);
    endRect(glow, 1, rz + 0.004, s * 0.88 - 0.08, s * 0.88 + 0.08, ROOF - 0.22, ROOF - 0.16, 0xffa020); // roof markers
  }
  // Mud flaps.
  for (const s of [-1, 1]) mb.block(s * WHEEL_X - 0.13, 0.12, zr - 0.9, s * WHEEL_X + 0.13, 0.6, zr - 0.86, C.black);

  const axles = [zf + 1.05, zr - 1.35];
  for (const z of axles) arches(mb, z, 0.3);
  bakeWheels(mb, axles);
  return { body: mb, glass, glow, glowStrength: 1.8 };
}

// ---------------------------------------------------------------------- bus

function bus(L: BusLivery, seed: number, oncoming: boolean): ObstacleBuilders {
  const len = OBSTACLE_DIMS.bus.len;
  const zf = -len / 2, zr = len / 2;
  const mb = new MeshBuilder({ seed, jitter: 0.025 });
  const glass = new MeshBuilder({ seed: seed + 1 });
  const glow = new MeshBuilder({ seed: seed + 2 });
  const night = new MeshBuilder({ seed: seed + 3 });
  const y0 = 0.42, yBelt = 1.3, yWin1 = 2.22, yTop = ROOF - 0.05;

  // Body: lower skirt, window belt, upper band; corners chamfered.
  mb.push().translate(0, (y0 + yBelt) / 2, 0).bevelBox(HW * 2, yBelt - y0, len - 0.02, 0.12, { color: L.lower, bottom: shadeHex(L.lower, 0.82) }).pop();
  mb.push().translate(0, (yBelt + yTop) / 2, 0).bevelBox(HW * 2 - 0.02, yTop - yBelt, len - 0.04, 0.16, { color: L.upper, top: shadeHex(L.upper, 1.04) }).pop();
  mb.block(-0.9, 0.28, zf + 0.6, 0.9, y0 + 0.02, zr - 0.6, C.steelDark); // underbody
  roof(mb, zf + 0.12, zr - 0.12, L.roof, [zf + 2.8, zr - 2.6]);

  // Accent stripe + lower dark sill.
  for (const s of [-1, 1]) {
    sideRect(mb, s, yBelt - 0.16, yBelt - 0.04, zf + 0.25, zr - 0.25, L.stripe);
    sideRect(mb, s, y0 + 0.03, y0 + 0.12, zf + 0.3, zr - 0.3, 0x2b3038);
  }

  // Side windows: dark interior band, pillars, glass panes. Door(s) on the right (+X).
  const winZ0 = zf + 1.35, winZ1 = zr - 0.7;
  const nWin = 6;
  const doorZ = [zf + 0.45]; // front door just behind the windshield
  const midDoor = 0.4;
  for (const s of [-1, 1]) {
    sideRect(night, s, yBelt + 0.06, yWin1, winZ0 - 0.05, winZ1 + 0.05, 0x4a3e30);
    sideRect(night, s, yWin1 - 0.12, yWin1 - 0.04, winZ0, winZ1, 0x8a7656, 0.002);
    const step = (winZ1 - winZ0) / nWin;
    for (let i = 0; i < nWin; i++) {
      const a = winZ0 + i * step + 0.05, b = winZ0 + (i + 1) * step - 0.05;
      if (s > 0 && b > midDoor - 0.55 && a < midDoor + 0.55) continue;
      sidePane(glass, s, yBelt + 0.1, yWin1 - 0.04, a, b);
      sideGlint(mb, s, yBelt + 0.1, yWin1 - 0.04, a, b, 0.004);
      if (i > 0) sideRect(mb, s, yBelt + 0.06, yWin1, a - 0.1, a - 0.0, L.upper, 0.006);
    }
    // Upper sign band glow-free trim.
    sideRect(mb, s, yWin1 + 0.05, yWin1 + 0.1, zf + 0.4, zr - 0.4, shadeHex(L.upper, 0.86));
  }
  // Right side doors: darker frame + tall glass.
  for (const dz of [...doorZ, midDoor - 0.5]) {
    const a = dz, b = dz + 1.0;
    sideRect(mb, 1, 0.5, yWin1, a, b, L.door, 0.008);
    for (const [p, q] of [[a + 0.05, a + 0.48], [a + 0.52, b - 0.05]]) {
      sideRect(mb, 1, 0.62, yWin1 - 0.06, p, q, GLASS_DARK, 0.012);
      sidePane(glass, 1, 0.62, yWin1 - 0.06, p, q);
    }
  }

  // Front: big windshield, destination sign, headlights, bumper, grille.
  const fz = zf + 0.005;
  endRect(mb, -1, fz, -0.92, 0.92, 1.25, 2.4, GLASS_DARK);
  endGlint(mb, -1, fz, -0.92, 0.92, 1.25, 2.4);
  endPane(glass, -1, fz - 0.01, -0.92, 0.92, 1.25, 2.4);
  endRect(mb, -1, fz, -0.06, 0.06, 1.25, 2.4, L.upper); // centre pillar
  endRect(mb, -1, fz, -0.8, 0.8, 2.47, 2.66, 0x15181d);
  endRect(glow, -1, fz - 0.012, -0.72, 0.72, 2.5, 2.63, oncoming ? 0xffb21f : 0xff9a1a);
  mb.push().translate(0, 0.52, zf + 0.02).bevelBox(HW * 2 - 0.06, 0.24, 0.1, 0.04, 0x3a414c).pop();
  endRect(mb, -1, fz, -0.42, 0.42, 0.75, 1.0, 0x2b3038);
  for (let i = 0; i < 3; i++) endRect(mb, -1, fz - 0.004, -0.38, 0.38, 0.79 + i * 0.07, 0.82 + i * 0.07, 0x8b939e);
  for (const s of [-1, 1]) {
    // Headlight bezels in the body, lamps in the glow mesh (bright for the oncoming bus).
    mb.push().translate(s * 0.7, 0.88, zf + 0.0).rotateX(Math.PI / 2).cylinder(0.17, 0.04, 10, {}, 0x2b3038).pop();
    if (oncoming) {
      glow.push().translate(s * 0.7, 0.88, zf - 0.02).rotateX(Math.PI / 2).cylinder(0.13, 0.03, 10, {}, 0xfff6d8).pop();
      endRect(glow, -1, fz - 0.012, s * 0.7 - 0.12, s * 0.7 + 0.12, 1.06, 1.12, 0xffa020);
    } else {
      mb.push().translate(s * 0.7, 0.88, zf - 0.02).rotateX(Math.PI / 2).cylinder(0.13, 0.03, 10, {}, 0xe8ecef).pop();
    }
  }
  endRect(mb, -1, zf - 0.031, -0.2, 0.2, 0.46, 0.58, 0xf6f4ee);
  mirrors(mb, zf, 2.2);

  // Rear: window, engine grille, tail lights, plate.
  const rz = zr - 0.005;
  // Interior seen through the rear window: night-lit (warm ceiling light, seat backs below).
  endRect(night, 1, rz, -0.8, 0.8, 1.75, 2.4, 0x5a4a38);
  endRect(night, 1, rz + 0.002, -0.78, 0.78, 2.28, 2.36, 0x9a8460);
  for (const x of [-0.5, 0.0, 0.5]) endRect(mb, 1, rz + 0.003, x - 0.17, x + 0.17, 1.75, 1.98, 0x2a3440);
  endGlint(mb, 1, rz, -0.8, 0.8, 1.75, 2.4);
  // Route number board above the window (always lit, amber LEDs).
  endRect(mb, 1, rz, -0.55, 0.55, 2.47, 2.68, 0x14181e);
  endRect(glow, 1, rz + 0.004, -0.45, 0.1, 2.52, 2.63, 0xffa628);
  endRect(glow, 1, rz + 0.004, 0.22, 0.45, 2.52, 2.63, 0xffc85a);
  endPane(glass, 1, rz + 0.01, -0.8, 0.8, 1.75, 2.4);
  endRect(mb, 1, rz, -0.6, 0.6, 0.72, 1.12, 0x2b3038);
  for (let i = 0; i < 5; i++) endRect(mb, 1, rz + 0.004, -0.56, 0.56, 0.75 + i * 0.075, 0.78 + i * 0.075, shadeHex(L.lower, 0.7));
  mb.push().translate(0, 0.52, zr - 0.02).bevelBox(HW * 2 - 0.06, 0.24, 0.1, 0.04, 0x3a414c).pop();
  endRect(mb, 1, zr + 0.031, -0.2, 0.2, 0.46, 0.58, 0xf6f4ee);
  endRect(mb, 1, zr + 0.032, -0.15, 0.15, 0.49, 0.55, 0x253a66);
  for (const s of [-1, 1]) {
    endRect(glow, 1, rz + 0.008, s * 0.88 - 0.09, s * 0.88 + 0.09, 0.75, 1.2, 0xff2a1a);
    endRect(glow, 1, rz + 0.008, s * 0.88 - 0.09, s * 0.88 + 0.09, 1.23, 1.33, 0xffa020);
  }
  // Livery swoosh at the rear corners (diagonal accent), both sides.
  for (const s of [-1, 1]) {
    const x = s * (HW + 0.006);
    faceToward(mb, [[x, y0 + 0.15, zr - 0.3], [x, y0 + 0.15, zr - 1.9], [x, yBelt - 0.2, zr - 1.4], [x, yBelt - 0.2, zr - 0.3]], [s, 0, 0], L.stripe);
  }
  // Oncoming: a bold front stripe "face" so it reads instantly.
  if (oncoming) {
    endRect(mb, -1, fz - 0.003, -HW + 0.08, HW - 0.08, 1.12, 1.2, L.stripe);
    for (const s of [-1, 1]) sideRect(mb, s, yWin1 + 0.12, yWin1 + 0.3, zf + 0.6, zr - 0.6, L.lower, 0.006);
  }

  const axleZ = [zf + 2.05, zr - 2.25];
  for (const z of axleZ) arches(mb, z, 0.28);
  if (oncoming) {
    return { body: mb, glass, glow, night, glowStrength: 3.2, axle: axleBuilder(), axleZ, axleY: WHEEL_R };
  }
  bakeWheels(mb, axleZ);
  return { body: mb, glass, glow, night, glowStrength: 1.8 };
}

/** Rotate every builder of a vehicle by 180° about Y (the oncoming bus faces +Z). */
function turnAround(b: ObstacleBuilders): ObstacleBuilders {
  const flip = (m?: MeshBuilder) => {
    if (!m) return m;
    const out = new MeshBuilder({ seed: 1 });
    out.push().rotateY(Math.PI).merge(m).pop();
    return out;
  };
  return {
    ...b,
    body: flip(b.body)!,
    glass: flip(b.glass),
    glow: flip(b.glow),
    night: flip(b.night),
    axleZ: b.axleZ?.map((z) => -z),
  };
}

export const VEHICLE_VARIANTS = { truck: TRUCK_LIVERIES.length, bus: BUS_LIVERIES.length, busOncoming: 1 } as const;

export function buildVehicle(kind: 'truck' | 'bus' | 'busOncoming', variant: number): ObstacleBuilders {
  switch (kind) {
    case 'truck':
      return truck(variant);
    case 'bus':
      return bus(BUS_LIVERIES[variant % BUS_LIVERIES.length], 500 + variant * 7, false);
    case 'busOncoming':
      return turnAround(bus(ONCOMING_LIVERY, 600, true));
  }
}
