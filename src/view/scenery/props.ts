// Street furniture and small props. Each returns a MeshBuilder authored for the RIGHT sidewalk:
// origin on the sidewalk surface (y = 0 here, placed at sidewalk height by the layout), the street
// on the -X side. Left-side copies are rotated 180° about Y.
//
// Footprint rule: every prop stays within |dx| <= its declared `reach` toward the street, so the
// layout can keep everything out of the road volume (|x| < 4.6, y < 11).
import { MeshBuilder } from '../geom';
import { shadeHex } from '../geom/color';
import { glowPaint, grad, Rand, slab, bar, quadN, NX, PX, PY, PZ, NZ } from './kit';
import * as P from './palette';

type Build = () => MeshBuilder;

const mbFor = (seed: number) => new MeshBuilder({ seed, jitter: 0.04 });
const ALLSIDES = NX | PX | PZ | NZ | PY;

function lamp(night: boolean): MeshBuilder {
  const mb = mbFor(night ? 11 : 10);
  const iron = night ? 0x252c30 : P.IRON;
  mb.push().translate(0, 0.35, 0).cylinder(0.22, 0.7, 6, { radiusTop: 0.12, capBottom: false }, grad(iron, 0.8)).pop();
  mb.push().translate(0, 2.55, 0).cylinder(0.075, 3.7, 6, { capTop: false, capBottom: false }, grad(iron, 0.7)).pop();
  mb.push().translate(0, 1.4, 0).cylinder(0.11, 0.18, 6, { capBottom: false }, shadeHex(iron, 1.3)).pop();
  // Lantern head: collar, glass, cap, finial.
  mb.push().translate(0, 4.5, 0).cylinder(0.12, 0.2, 6, { radiusTop: 0.22, capBottom: false }, iron).pop();
  const glassP = night ? glowPaint(P.LIGHT_WARM, 0.95) : { color: 0xf3ead2, top: 0xfffaf0, bottom: 0xd8cfb8, jitter: 0.02 };
  mb.push().translate(0, 4.91, 0).cylinder(0.22, 0.62, 6, { radiusTop: 0.27, capTop: false, capBottom: false }, glassP).pop();
  mb.push().translate(0, 5.28, 0).cylinder(0.32, 0.14, 6, { radiusTop: 0.2 }, iron).pop();
  mb.push().translate(0, 5.5, 0).cone(0.18, 0.32, 6, iron).pop();
  // Hanging flower basket on an arm toward the buildings (+x, never toward the road).
  if (!night) {
    bar(mb, [0, 3.6, 0], [0.7, 3.6, 0], 0.05, iron);
    bar(mb, [0.65, 3.6, 0], [0.65, 3.25, 0], 0.02, iron);
    mb.push().translate(0.65, 3.05, 0).sphere(0.32, 0.22, 0.32, 7, 3, { color: P.LEAF, bottom: P.LEAF_DARK }).pop();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      mb.push().translate(0.65 + Math.cos(a) * 0.26, 3.1, Math.sin(a) * 0.26).box(0.1, 0.1, 0.1, P.FLOWERS[k % P.FLOWERS.length]).pop();
    }
  }
  return mb;
}

function tree(): MeshBuilder {
  const mb = mbFor(12);
  // Tree grate.
  slab(mb, -0.7, 0, -0.7, 0.7, 0.02, 0.7, 0x3a3f42, PY);
  slab(mb, -0.55, 0.02, -0.55, 0.55, 0.03, 0.55, 0x6b5a44, PY);
  mb.push().translate(0, 1.8, 0).cylinder(0.16, 3.6, 7, { radiusTop: 0.11 }, grad(0x7a5a3e, 0.75)).pop();
  bar(mb, [0, 3.0, 0], [0.5, 4.0, 0.3], 0.12, 0x7a5a3e);
  bar(mb, [0, 3.2, 0], [-0.3, 4.1, -0.4], 0.1, 0x7a5a3e);
  const leaf = (c: number) => ({ color: c, top: shadeHex(c, 1.15), bottom: shadeHex(c, 0.7), jitter: 0.08 });
  mb.push().translate(0.15, 4.9, 0).sphere(1.35, 1.2, 1.35, 7, 4, leaf(0x6aa84f)).pop();
  mb.push().translate(0.6, 4.3, 0.6).sphere(0.95, 0.85, 0.95, 6, 4, leaf(0x5c9a45)).pop();
  mb.push().translate(0.3, 4.4, -0.8).sphere(0.9, 0.8, 0.9, 6, 4, leaf(0x75b356)).pop();
  mb.push().translate(-0.1, 5.7, 0.2).sphere(0.85, 0.75, 0.85, 6, 3, leaf(0x7dbb5c)).pop();
  return mb;
}

function palm(): MeshBuilder {
  const mb = mbFor(13);
  slab(mb, -0.6, 0, -0.6, 0.6, 0.35, 0.6, grad(0xd8cbb0, 0.8), ALLSIDES);
  // Curved trunk leaning away from the road (+x).
  let x = 0, y = 0.35;
  const segs = 7;
  for (let k = 0; k < segs; k++) {
    const nx = x + 0.12 + k * 0.03, ny = y + 1.0;
    bar(mb, [x, y, 0], [nx, ny, 0], 0.32 - k * 0.02, k % 2 ? 0x9b7b55 : 0x8a6a48, 6);
    x = nx;
    y = ny;
  }
  // Fronds: drooping two-part blades around the crown.
  const n = 9;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + 0.2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const l1 = 1.3, l2 = 1.1;
    const p0: [number, number, number] = [x, y, 0];
    const p1: [number, number, number] = [x + ca * l1, y + 0.35, sa * l1];
    const p2: [number, number, number] = [x + ca * (l1 + l2), y - 0.55, sa * (l1 + l2)];
    const wv = 0.38;
    const side = (p: [number, number, number], s: number): [number, number, number] => [p[0] - sa * wv * s, p[1], p[2] + ca * wv * s];
    const c1 = k % 2 ? 0x4f9a3e : 0x5aa648, c2 = shadeHex(c1, 0.85);
    quadN(mb, p0, side(p1, 1), p1, side(p1, -1), [0, 1, 0], c1);
    quadN(mb, p0, side(p1, -1), p1, side(p1, 1), [0, -1, 0], c2);
    quadN(mb, side(p1, 1), p2, p2, side(p1, -1), [0, 1, 0], c1);
    quadN(mb, side(p1, -1), p2, p2, side(p1, 1), [0, -1, 0], c2);
  }
  for (let k = 0; k < 3; k++) mb.push().translate(x + Math.cos(k * 2.1) * 0.22, y - 0.25, Math.sin(k * 2.1) * 0.22).sphere(0.15, 0.15, 0.15, 5, 3, 0x6b4a2a).pop();
  return mb;
}

function bench(): MeshBuilder {
  const mb = mbFor(14);
  const L = 1.9;
  for (const z of [-L / 2 + 0.15, L / 2 - 0.15]) {
    slab(mb, -0.3, 0, z - 0.05, 0.3, 0.45, z + 0.05, P.IRON, ALLSIDES);
    slab(mb, 0.22, 0.45, z - 0.05, 0.3, 0.95, z + 0.05, P.IRON, ALLSIDES);
  }
  for (let k = 0; k < 3; k++) slab(mb, -0.3 + k * 0.19, 0.45, -L / 2, -0.15 + k * 0.19, 0.5, L / 2, shadeHex(P.WOOD, 1 + k * 0.05), ALLSIDES | 8);
  for (let k = 0; k < 2; k++) slab(mb, 0.24, 0.6 + k * 0.2, -L / 2, 0.29, 0.72 + k * 0.2, L / 2, P.WOOD, ALLSIDES);
  return mb;
}

function planter(rnd: Rand, flowers: boolean): MeshBuilder {
  const mb = mbFor(flowers ? 15 : 16);
  slab(mb, -0.45, 0, -0.9, 0.45, 0.6, 0.9, grad(0xd7c7a6, 0.75), ALLSIDES);
  slab(mb, -0.5, 0.6, -0.95, 0.5, 0.68, 0.95, 0xe8dcc3, ALLSIDES | 8);
  slab(mb, -0.4, 0.68, -0.85, 0.4, 0.7, 0.85, 0x5e4630, PY);
  for (let k = 0; k < 4; k++) {
    const z = -0.65 + k * 0.43;
    mb.push().translate(rnd.range(-0.1, 0.1), 0.95, z).sphere(0.36, 0.34, 0.3, 6, 3, { color: P.LEAF, top: shadeHex(P.LEAF, 1.2), bottom: P.LEAF_DARK }).pop();
    if (flowers) for (let f = 0; f < 3; f++) mb.push().translate(rnd.range(-0.3, 0.3), 1.15 + rnd.range(0, 0.1), z + rnd.range(-0.2, 0.2)).box(0.11, 0.11, 0.11, rnd.pick(P.FLOWERS)).pop();
  }
  return mb;
}

function pots(rnd: Rand): MeshBuilder {
  const mb = mbFor(17);
  const spots: [number, number, number][] = [[0, 0, 0.8], [0.15, -0.6, 0.6], [-0.1, 0.65, 0.5]];
  for (const [x, z, s] of spots) {
    mb.push().translate(x, 0.25 * s, z).cylinder(0.25 * s, 0.5 * s, 6, { radiusTop: 0.33 * s, capBottom: false }, grad(0xc46a43, 0.75)).pop();
    if (s > 0.7) {
      // Small citrus tree.
      bar(mb, [x, 0.5 * s, z], [x, 1.5, z], 0.06, 0x6b4a2a);
      mb.push().translate(x, 1.75, z).sphere(0.5, 0.45, 0.5, 6, 3, { color: P.LEAF, bottom: P.LEAF_DARK }).pop();
      for (let k = 0; k < 3; k++) mb.push().translate(x + Math.cos(k * 2.1) * 0.42, 1.7 + (k % 2) * 0.2, z + Math.sin(k * 2.1) * 0.42).box(0.1, 0.1, 0.1, 0xf2a03d).pop();
    } else {
      mb.push().translate(x, 0.55 * s + 0.25, z).sphere(0.3 * s + 0.1, 0.3, 0.3 * s + 0.1, 6, 3, { color: P.LEAF, bottom: P.LEAF_DARK }).pop();
      mb.push().translate(x - 0.1, 0.55 * s + 0.45, z).box(0.1, 0.1, 0.1, rnd.pick(P.FLOWERS)).pop();
    }
  }
  return mb;
}

function bin(): MeshBuilder {
  const mb = mbFor(18);
  mb.push().translate(0, 0.5, 0).cylinder(0.3, 1.0, 8, { radiusTop: 0.33 }, grad(0x2f6f5a, 0.7)).pop();
  mb.push().translate(0, 1.05, 0).cylinder(0.36, 0.1, 8, { radiusTop: 0.3 }, 0x24574a).pop();
  for (const y of [0.25, 0.8]) mb.push().translate(0, y, 0).cylinder(0.32, 0.05, 8, {}, 0xc9b25a).pop();
  return mb;
}

function hydrant(): MeshBuilder {
  const mb = mbFor(19);
  mb.push().translate(0, 0.05, 0).cylinder(0.2, 0.1, 8, {}, 0x8f2a20).pop();
  mb.push().translate(0, 0.4, 0).cylinder(0.14, 0.6, 8, {}, grad(0xd23a2a, 0.7)).pop();
  mb.push().translate(0, 0.75, 0).sphere(0.15, 0.12, 0.15, 7, 3, 0xe9c46a).pop();
  mb.push().translate(0, 0.48, 0).rotateZ(Math.PI / 2).cylinder(0.06, 0.45, 6, {}, 0xd23a2a).pop();
  mb.push().translate(-0.18, 0.48, 0).rotateZ(Math.PI / 2).cylinder(0.08, 0.06, 6, {}, 0xe9c46a).pop();
  return mb;
}

function bollards(): MeshBuilder {
  const mb = mbFor(20);
  for (const z of [-1.4, 0, 1.4]) {
    mb.push().translate(0, 0.45, z).cylinder(0.11, 0.9, 8, { radiusTop: 0.09 }, grad(P.IRON, 0.7)).pop();
    mb.push().translate(0, 0.94, z).sphere(0.11, 0.08, 0.11, 7, 3, P.IRON).pop();
    mb.push().translate(0, 0.72, z).cylinder(0.105, 0.08, 8, {}, 0xe9c46a).pop();
  }
  return mb;
}

function wheel(mb: MeshBuilder, x: number, y: number, z: number, r: number, t: number): void {
  // Axle along x: the wheel stands in the y/z plane.
  mb.push().translate(x, y, z).rotateZ(Math.PI / 2).cylinder(r, t, 10, {}, 0x222628).cylinder(r * 0.55, t + 0.02, 8, {}, 0x9aa0a4).pop();
}

function scooter(color: number): MeshBuilder {
  const mb = mbFor(21);
  // Parked along the curb, facing -z.
  wheel(mb, 0, 0.25, -0.65, 0.25, 0.14);
  wheel(mb, 0, 0.25, 0.6, 0.25, 0.14);
  slab(mb, -0.2, 0.3, -0.45, 0.2, 0.42, 0.45, 0x333333, ALLSIDES | 8);
  slab(mb, -0.24, 0.4, 0.05, 0.24, 0.85, 0.8, grad(color, 0.8), ALLSIDES);
  slab(mb, -0.2, 0.85, 0.05, 0.2, 0.95, 0.7, 0x3a2f2a, ALLSIDES);
  slab(mb, -0.22, 0.35, -0.85, 0.22, 1.15, -0.55, grad(color, 0.8), ALLSIDES);
  bar(mb, [0, 1.1, -0.7], [0, 1.25, -0.72], 0.05, 0x333333);
  bar(mb, [-0.38, 1.27, -0.72], [0.38, 1.27, -0.72], 0.05, 0x333333);
  mb.push().translate(0, 1.08, -0.87).box(0.18, 0.14, 0.04, 0xfff4cc).pop();
  return mb;
}

function bicycle(color: number): MeshBuilder {
  const mb = mbFor(22);
  wheel(mb, 0, 0.36, -0.55, 0.36, 0.05);
  wheel(mb, 0, 0.36, 0.55, 0.36, 0.05);
  const c = color;
  bar(mb, [0, 0.36, 0.55], [0, 0.85, 0.05], 0.05, c);
  bar(mb, [0, 0.36, 0.55], [0, 0.4, 0.0], 0.05, c);
  bar(mb, [0, 0.4, 0.0], [0, 0.85, 0.05], 0.05, c);
  bar(mb, [0, 0.4, 0.0], [0, 0.82, -0.45], 0.05, c);
  bar(mb, [0, 0.85, 0.05], [0, 0.82, -0.45], 0.05, c);
  bar(mb, [0, 0.36, -0.55], [0, 1.0, -0.48], 0.04, 0x444444);
  bar(mb, [-0.28, 1.0, -0.48], [0.28, 1.0, -0.48], 0.04, 0x444444);
  mb.push().translate(0, 0.92, 0.08).box(0.12, 0.05, 0.24, 0x3a2f2a).pop();
  mb.push().translate(0, 0.85, -0.65).box(0.3, 0.2, 0.25, 0xa0764a).pop(); // basket
  return mb;
}

function stripedCone(mb: MeshBuilder, x: number, y: number, z: number, r: number, h: number, a: number, b: number, n = 8): void {
  // Parasol canopy: alternating colour panels, top + underside.
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
    const p0: [number, number, number] = [x + Math.cos(a0) * r, y, z + Math.sin(a0) * r];
    const p1: [number, number, number] = [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r];
    const tip: [number, number, number] = [x, y + h, z];
    const c = k % 2 ? a : b;
    quadN(mb, p0, p1, tip, tip, [Math.cos((a0 + a1) / 2) * h, r, Math.sin((a0 + a1) / 2) * h], { color: c, jitter: 0.03 });
    quadN(mb, p0, p1, tip, tip, [-Math.cos((a0 + a1) / 2) * h, -r, -Math.sin((a0 + a1) / 2) * h], { color: shadeHex(c, 0.7), jitter: 0.03 });
    // Little valance flap.
    quadN(mb, p0, p1, [p1[0], y - 0.18, p1[2]], [p0[0], y - 0.18, p0[2]], [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)], c);
  }
}

function cafeSet(rnd: Rand, night: boolean): MeshBuilder {
  const mb = mbFor(night ? 24 : 23);
  // Table.
  mb.push().translate(0, 0.73, 0).cylinder(0.45, 0.05, 10, {}, 0xf4f1ea).pop();
  mb.push().translate(0, 0.37, 0).cylinder(0.04, 0.7, 6, {}, P.IRON).pop();
  mb.push().translate(0, 0.02, 0).cylinder(0.25, 0.04, 8, {}, P.IRON).pop();
  // Chairs on both sides (along z).
  for (const s of [-1, 1]) {
    const z = s * 0.75;
    const cc = rnd.pick([0x2a9d8f, 0xe76f51, 0xe9c46a, 0x3c7fa6]);
    slab(mb, -0.22, 0.44, z - 0.22, 0.22, 0.49, z + 0.22, cc, ALLSIDES | 8);
    for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) slab(mb, dx - 0.025, 0, z + dz - 0.025, dx + 0.025, 0.44, z + dz + 0.025, P.IRON, NX | PX | PZ | NZ);
    slab(mb, -0.22, 0.49, z + s * 0.2 - 0.025, 0.22, 0.95, z + s * 0.2 + 0.025, cc, ALLSIDES);
  }
  // Parasol.
  bar(mb, [0, 0.75, 0], [0, 2.35, 0], 0.05, 0xdddddd);
  const pair = rnd.pick(P.AWNING_PAIRS);
  stripedCone(mb, 0, 2.2, 0, 1.3, 0.5, pair[0], pair[1]);
  if (night) {
    mb.push().translate(0, 2.05, 0).sphere(0.12, 0.12, 0.12, 6, 3, glowPaint(P.LIGHT_WARM, 1)).pop();
    mb.push().translate(0, 0.82, 0).cylinder(0.06, 0.14, 6, {}, glowPaint(P.LIGHT_AMBER, 0.9)).pop();
  } else {
    mb.push().translate(0.1, 0.82, 0.1).cylinder(0.05, 0.12, 6, {}, 0xffffff).pop();
  }
  return mb;
}

function crate(mb: MeshBuilder, x: number, y: number, z: number, s: number, c: number): void {
  slab(mb, x - s / 2, y, z - s / 2, x + s / 2, y + s * 0.8, z + s / 2, grad(c, 0.8), ALLSIDES);
  for (const yy of [y + s * 0.2, y + s * 0.55]) slab(mb, x - s / 2 - 0.01, yy, z - s / 2 - 0.01, x + s / 2 + 0.01, yy + 0.04, z + s / 2 + 0.01, shadeHex(c, 0.75), NX | PX | PZ | NZ);
}

function produce(mb: MeshBuilder, x: number, y: number, z: number, w: number, d: number, c: number, rnd: Rand): void {
  // A heaped mound of fruit + two loose pieces on top (cheap but reads as produce).
  mb.push().translate(x, y + 0.02, z).sphere(w * 0.46, 0.14, d * 0.46, 6, 2, { color: c, top: shadeHex(c, 1.15), bottom: shadeHex(c, 0.75), jitter: 0.12 }).pop();
  for (let k = 0; k < 2; k++) mb.push().translate(x + rnd.range(-0.12, 0.12), y + 0.15, z + rnd.range(-0.12, 0.12)).box(0.11, 0.1, 0.11, shadeHex(c, 1.1)).pop();
}

function stall(rnd: Rand, night: boolean, food: boolean): MeshBuilder {
  const mb = mbFor(night ? (food ? 27 : 26) : 25);
  const W = 1.9, L = 2.8;
  // Counter (front faces the street, -x).
  slab(mb, -W / 2, 0, -L / 2, W / 2 - 0.6, 0.9, L / 2, grad(night ? 0x7a4a32 : P.WOOD, 0.75), ALLSIDES);
  for (let z = -L / 2 + 0.3; z < L / 2; z += 0.45) slab(mb, -W / 2 - 0.01, 0.1, z, -W / 2, 0.85, z + 0.05, P.WOOD_DARK, NX);
  // Sloped display of crates.
  const fruit = [0xf28c28, 0xf2d43d, 0x6dbb4a, 0xd63a2f, 0x9b59b6, 0xf6a5c0];
  for (let k = 0; k < 4; k++) {
    const z = -L / 2 + 0.35 + k * 0.7;
    if (food) {
      // Food stall: pans / bowls with steam-coloured tops.
      mb.push().translate(-0.25, 0.95, z).cylinder(0.26, 0.1, 6, { capTop: false, capBottom: false }, 0x3b3b3b).pop();
      mb.push().translate(-0.25, 0.98, z).cylinder(0.24, 0.04, 6, { capBottom: false }, rnd.pick([0xe8a04a, 0xd9563b, 0xf2d27a, 0x9bc46a])).pop();
    } else {
      crate(mb, -0.25, 0.9, z, 0.6, 0xa47548);
      produce(mb, -0.25, 1.38, z, 0.55, 0.55, fruit[(k + rnd.int(6)) % fruit.length], rnd);
    }
  }
  // Poles + striped roof.
  for (const [x, z] of [[-W / 2 + 0.05, -L / 2 + 0.05], [-W / 2 + 0.05, L / 2 - 0.05], [W / 2 - 0.05, -L / 2 + 0.05], [W / 2 - 0.05, L / 2 - 0.05]]) {
    slab(mb, x - 0.05, 0, z - 0.05, x + 0.05, x < 0 ? 2.1 : 2.36, z + 0.05, 0xd8d0c0, NX | PX | PZ | NZ);
  }
  const pair = rnd.pick(P.AWNING_PAIRS);
  const n = 6;
  for (let k = 0; k < n; k++) {
    const z0 = -L / 2 - 0.15 + ((L + 0.3) * k) / n, z1 = -L / 2 - 0.15 + ((L + 0.3) * (k + 1)) / n;
    const c = night ? shadeHex(pair[k % 2], 0.8) : pair[k % 2];
    quadN(mb, [-W / 2 - 0.25, 2.05, z0], [-W / 2 - 0.25, 2.05, z1], [W / 2 + 0.1, 2.42, z1], [W / 2 + 0.1, 2.42, z0], [-0.37, 1.15, 0], c);
    quadN(mb, [-W / 2 - 0.25, 2.05, z0], [-W / 2 - 0.25, 2.05, z1], [W / 2 + 0.1, 2.42, z1], [W / 2 + 0.1, 2.42, z0], [0.37, -1.15, 0], shadeHex(c, 0.7));
    quadN(mb, [-W / 2 - 0.25, 2.05, z0], [-W / 2 - 0.25, 2.05, z1], [-W / 2 - 0.25, 1.82, z1], [-W / 2 - 0.25, 1.82, z0], [-1, 0, 0], c);
  }
  if (night) {
    // Glowing lamps hanging under the roof + a lit sign board.
    for (const z of [-0.8, 0.0, 0.8]) {
      bar(mb, [-0.4, 2.15, z], [-0.4, 1.9, z], 0.02, 0x222222);
      mb.push().translate(-0.4, 1.75, z).sphere(0.16, 0.2, 0.16, 6, 3, glowPaint(rnd.pick(P.LANTERN), 0.95)).pop();
    }
    slab(mb, -W / 2 - 0.3, 2.1, -0.6, -W / 2 - 0.25, 2.32, 0.6, glowPaint(rnd.pick(P.NEON), 0.35), NX | PX);
  }
  return mb;
}

function crateStack(rnd: Rand): MeshBuilder {
  const mb = mbFor(28);
  const c = [0xa47548, 0x8f6440, 0xb98a5a, 0x6e8b8f];
  crate(mb, 0, 0, -0.4, 0.75, c[0]);
  crate(mb, 0.05, 0, 0.42, 0.75, c[1]);
  crate(mb, 0.02, 0.6, 0.0, 0.7, c[2]);
  crate(mb, 0.4, 0, 1.2, 0.6, c[3]);
  produce(mb, 0.4, 0.48, 1.2, 0.5, 0.5, rnd.pick([0xf28c28, 0x6dbb4a]), rnd);
  return mb;
}

function barrels(): MeshBuilder {
  const mb = mbFor(29);
  for (const [x, z, y] of [[0, -0.35, 0], [0.1, 0.4, 0], [0.05, 0.02, 1.0]]) {
    mb.push().translate(x, y + 0.5, z).cylinder(0.36, 1.0, 8, { radiusTop: 0.36, capBottom: false }, grad(0x8a5a36, 0.75)).pop();
    for (const yy of [0.15, 0.85]) mb.push().translate(x, y + yy, z).cylinder(0.375, 0.07, 8, { capTop: false, capBottom: false }, 0x4a4a4a).pop();
  }
  return mb;
}

function nets(): MeshBuilder {
  // Harbour clutter: a pile of nets, lobster pots, a life-buoy stand.
  const mb = mbFor(30);
  mb.push().translate(0, 0.25, 0).sphere(0.8, 0.3, 0.7, 7, 3, { color: 0x3f7f7a, jitter: 0.1 }).pop();
  mb.push().translate(0.2, 0.42, 0.2).sphere(0.45, 0.25, 0.4, 6, 3, { color: 0xd8823a, jitter: 0.1 }).pop();
  for (const z of [-1.1, -1.7]) {
    slab(mb, -0.3, 0, z - 0.25, 0.3, 0.45, z + 0.25, 0x6b5a3a, ALLSIDES);
    for (let k = 0; k < 3; k++) slab(mb, -0.32, 0.08 + k * 0.14, z - 0.27, 0.32, 0.1 + k * 0.14, z + 0.27, 0x3a3a3a, NX | PX | PZ | NZ);
  }
  slab(mb, 0.2, 0, 1.0, 0.3, 1.6, 1.1, P.WOOD, ALLSIDES);
  mb.push().translate(0.1, 1.25, 1.05).rotateZ(Math.PI / 2);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    mb.push().translate(0, Math.cos(a) * 0.32, Math.sin(a) * 0.32).rotateX(a).box(0.1, 0.12, 0.26, k % 2 ? 0xffffff : 0xe2402f).pop();
  }
  mb.pop();
  return mb;
}

function signpost(): MeshBuilder {
  const mb = mbFor(31);
  mb.push().translate(0, 1.5, 0).cylinder(0.05, 3.0, 6, {}, 0x5a6268).pop();
  const boards: [number, number, number, number][] = [[2.6, 1, 0x2a9d8f, 0.3], [2.25, -1, 0xe76f51, -0.5], [1.9, 1, 0x3c7fa6, 1.2]];
  for (const [y, dir, c, rot] of boards) {
    mb.push().translate(0.0, y, 0).rotateY(rot);
    slab(mb, -0.04, -0.13, dir > 0 ? 0 : -0.9, 0.04, 0.13, dir > 0 ? 0.9 : 0, c, ALLSIDES | 8);
    mb.push().translate(0, 0, dir * 0.95).rotateX(0);
    quadN(mb, [-0.04, -0.13, 0], [-0.04, 0.13, 0], [-0.04, 0, dir * 0.18], [-0.04, 0, dir * 0.18], [-1, 0, 0], c);
    quadN(mb, [0.04, -0.13, 0], [0.04, 0.13, 0], [0.04, 0, dir * 0.18], [0.04, 0, dir * 0.18], [1, 0, 0], c);
    mb.pop();
    slab(mb, -0.05, -0.04, dir > 0 ? 0.15 : -0.75, 0.05, 0.04, dir > 0 ? 0.75 : -0.15, 0xffffff, NX | PX);
    mb.pop();
  }
  return mb;
}

/** Tall festival mast that anchors bunting / lantern strings over the street. */
function mast(night: boolean): MeshBuilder {
  const mb = mbFor(night ? 33 : 32);
  const c = night ? 0x7a2f2a : 0xf2efe6;
  mb.push().translate(0, 0.4, 0).cylinder(0.2, 0.8, 8, { radiusTop: 0.14 }, grad(night ? 0x3a2a26 : 0x2a9d8f, 0.8)).pop();
  mb.push().translate(0, 7.2, 0).cylinder(0.09, 12.8, 8, { radiusTop: 0.06, capBottom: false }, grad(c, 0.85)).pop();
  mb.push().translate(0, 13.65, 0).sphere(0.15, 0.15, 0.15, 6, 3, night ? glowPaint(P.LIGHT_AMBER, 0.9) : 0xe9c46a).pop();
  // A small pennant at the top, pointing toward the buildings (+x).
  quadN(mb, [0.05, 13.3, 0], [0.05, 12.7, 0], [0.9, 13.0, 0], [0.9, 13.0, 0], [0, 0, -1], night ? 0xd1495b : 0xe76f51);
  quadN(mb, [0.05, 13.3, 0], [0.05, 12.7, 0], [0.9, 13.0, 0], [0.9, 13.0, 0], [0, 0, 1], night ? 0xd1495b : 0xe76f51);
  return mb;
}

/** Laundry line across an alley (spans z in [-1.6, 1.6], hung from wall to wall). */
function laundry(rnd: Rand): MeshBuilder {
  const mb = mbFor(34);
  for (const [x, y] of [[1.5, 6.3], [3.5, 7.0]] as const) {
    bar(mb, [x, y, -2.1], [x, y - 0.25, 0], 0.02, 0xdddddd, 3);
    bar(mb, [x, y - 0.25, 0], [x, y, 2.1], 0.02, 0xdddddd, 3);
    for (let k = 0; k < 4; k++) {
      const z = -1.6 + k * 0.95 + rnd.range(-0.1, 0.1);
      const sag = 0.25 * (1 - Math.abs(z) / 2.1);
      const c = rnd.pick([0xffffff, 0xe76f51, 0x3c7fa6, 0xe9c46a, 0xf2d9c4]);
      quadN(mb, [x, y - sag, z - 0.3], [x, y - sag, z + 0.3], [x, y - sag - 0.7, z + 0.3], [x, y - sag - 0.7, z - 0.3], [-1, 0, 0], c);
      quadN(mb, [x, y - sag, z - 0.3], [x, y - sag, z + 0.3], [x, y - sag - 0.7, z + 0.3], [x, y - sag - 0.7, z - 0.3], [1, 0, 0], shadeHex(c, 0.85));
    }
  }
  // Bins / crates at the alley floor.
  mb.push().translate(4.0, 0.5, 0.9).box(1.0, 1.0, 0.8, grad(0x4f6a5e, 0.7)).pop();
  mb.push().translate(2.6, 0.3, -1.0).box(0.6, 0.6, 0.6, grad(0xa47548, 0.8)).pop();
  return mb;
}

// ----------------------------------------------------------------------------- boats

/** Moored boat, hull along z, origin at the waterline. */
function boat(kind: number): MeshBuilder {
  const mb = mbFor(40 + kind);
  const rnd = new Rand(400 + kind);
  const L = kind === 1 ? 9 : kind === 2 ? 6 : 7.5;
  const B = kind === 1 ? 2.6 : 2.2;
  const hull = [0xe9e4d8, 0x2f6f8f, 0xd9563b, 0x2a9d8f][kind % 4];
  const stripe = [0x2a9d8f, 0xffffff, 0xf2d27a, 0xffffff][kind % 4];
  // Hull: extruded side profile (z/y) with raised bow, then narrowed at the bow with wedges.
  const prof: [number, number][] = [[-L / 2, 0.9], [-L / 2 + 0.4, -0.5], [L / 2 - 1.6, -0.55], [L / 2, 0.35], [L / 2 + 0.2, 1.35], [L / 2 - 0.6, 1.2], [-L / 2, 1.1]];
  mb.push().rotateY(Math.PI / 2).scale(1, 1, 1);
  mb.extrude(prof.map(([z, y]) => [-z, y] as [number, number]), B, { color: hull, bottom: shadeHex(hull, 0.6), top: hull, jitter: 0.03 });
  mb.pop();
  // Bow taper (wedge-like caps both sides).
  slab(mb, -B / 2 - 0.02, 0.75, -L / 2, B / 2 + 0.02, 0.92, L / 2 - 0.3, stripe, NX | PX);
  slab(mb, -B / 2 + 0.15, 1.1, -L / 2 + 0.2, B / 2 - 0.15, 1.15, L / 2 - 0.7, 0xb08a5a, PY);
  if (kind === 1) {
    // Sailboat: tall mast, boom with furled sail.
    bar(mb, [0, 1.1, 0.5], [0, 10.5, 0.5], 0.14, 0xe8e2d4, 6);
    bar(mb, [0, 2.3, 0.5], [0, 2.3, -3.3], 0.1, 0xb5a98f);
    bar(mb, [0, 2.45, 0.4], [0, 2.45, -3.1], 0.32, 0xf4efe6, 6);
    bar(mb, [0, 10.4, 0.5], [0, 1.2, L / 2], 0.02, 0x9a9a9a, 3);
    bar(mb, [0, 10.4, 0.5], [0, 1.2, -L / 2 + 0.3], 0.02, 0x9a9a9a, 3);
  } else {
    // Fishing boat: wheelhouse, mast with a cross spar and flags, nets.
    slab(mb, -0.75, 1.15, -0.9, 0.75, 2.6, 0.7, grad(0xf4efe6, 0.85), ALLSIDES);
    slab(mb, -0.85, 2.6, -1.0, 0.85, 2.75, 0.8, rnd.pick([0xd9563b, 0x2a9d8f, 0x3c7fa6]), ALLSIDES | 8);
    for (const s of [-1, 1]) slab(mb, s * 0.76 - 0.01, 1.8, -0.7, s * 0.76 + 0.01, 2.35, 0.5, 0x2c4556, s < 0 ? NX : PX);
    slab(mb, -0.6, 1.8, 0.7, 0.6, 2.35, 0.72, 0x2c4556, PZ);
    bar(mb, [0, 2.75, -0.2], [0, 6.0, -0.2], 0.1, 0xd8d0c0);
    bar(mb, [0, 5.0, -1.2], [0, 5.0, 0.8], 0.06, 0xd8d0c0);
    bar(mb, [0, 1.2, -L / 2 + 0.6], [0, 4.2, -1.0], 0.07, 0xd8d0c0);
    mb.push().translate(0, 1.45, -L / 2 + 1.4).sphere(0.7, 0.35, 0.6, 6, 3, { color: 0x3f7f7a, jitter: 0.1 }).pop();
    quadN(mb, [0, 6.0, -0.2], [0, 5.6, -0.2], [0, 5.8, -1.0], [0, 5.8, -1.0], [1, 0, 0], 0xe9c46a);
    quadN(mb, [0, 6.0, -0.2], [0, 5.6, -0.2], [0, 5.8, -1.0], [0, 5.8, -1.0], [-1, 0, 0], 0xe9c46a);
  }
  // Fenders.
  for (const z of [-1.5, 0.5, 2.0]) mb.push().translate(-B / 2 - 0.1, 0.55, z).cylinder(0.12, 0.45, 6, {}, 0xffffff).pop();
  return mb;
}

// ------------------------------------------------------------------------- catalogue

export interface PropDef {
  build: Build;
  /** Half-length along the street (for spacing). */
  half: number;
  /** How far the prop reaches toward the street (-x) from its origin. */
  reach: number;
  shadow: boolean;
}

export function propCatalogue(): Record<string, PropDef> {
  const r = (s: number) => new Rand(s);
  return {
    lamp: { build: () => lamp(false), half: 0.4, reach: 0.35, shadow: false },
    lampNight: { build: () => lamp(true), half: 0.4, reach: 0.75, shadow: false },
    tree: { build: tree, half: 1.2, reach: 1.4, shadow: true },
    palm: { build: palm, half: 1.2, reach: 1.6, shadow: true },
    bench: { build: bench, half: 1.0, reach: 0.35, shadow: false },
    planter: { build: () => planter(r(5), true), half: 1.0, reach: 0.5, shadow: false },
    hedge: { build: () => planter(r(6), false), half: 1.0, reach: 0.5, shadow: false },
    pots: { build: () => pots(r(7)), half: 0.9, reach: 0.6, shadow: false },
    bin: { build: bin, half: 0.4, reach: 0.4, shadow: false },
    hydrant: { build: hydrant, half: 0.3, reach: 0.4, shadow: false },
    bollards: { build: bollards, half: 1.5, reach: 0.15, shadow: false },
    scooter: { build: () => scooter(0x7fd1b9), half: 0.9, reach: 0.45, shadow: false },
    bicycle: { build: () => bicycle(0x3c7fa6), half: 0.95, reach: 0.35, shadow: false },
    cafe: { build: () => cafeSet(r(8), false), half: 1.3, reach: 1.35, shadow: false },
    cafeNight: { build: () => cafeSet(r(9), true), half: 1.3, reach: 1.35, shadow: false },
    stall: { build: () => stall(r(10), false, false), half: 1.6, reach: 1.25, shadow: true },
    stallNight: { build: () => stall(r(11), true, false), half: 1.6, reach: 1.3, shadow: false },
    foodStall: { build: () => stall(r(12), true, true), half: 1.6, reach: 1.3, shadow: false },
    crates: { build: () => crateStack(r(13)), half: 1.5, reach: 0.5, shadow: false },
    barrels: { build: barrels, half: 0.8, reach: 0.5, shadow: false },
    nets: { build: nets, half: 1.9, reach: 0.8, shadow: false },
    signpost: { build: signpost, half: 1.0, reach: 0.25, shadow: false },
    mast: { build: () => mast(false), half: 0.3, reach: 0.2, shadow: false },
    mastNight: { build: () => mast(true), half: 0.3, reach: 0.2, shadow: false },
    laundry: { build: () => laundry(r(14)), half: 2.0, reach: 0, shadow: false },
    boat0: { build: () => boat(0), half: 4, reach: 1.5, shadow: false },
    boat1: { build: () => boat(1), half: 5, reach: 1.5, shadow: false },
  };
}
