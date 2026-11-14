// ChaserRig: "Warden", a hovering patrol drone. Graphite pod with a single red eye, four ducted
// rotors, red/blue beacons, an antenna and a searchlight cone aimed at the hero.
import { Container3D, Mesh3D } from '@pixi/3d';
import type { Geometry3D } from '@pixi/3d';
import type { ChaserState } from '../../sim/types';
import { glow, vertexColorGloss } from '../geom/materials';
import { MeshBuilder } from '../geom/meshBuilder';
import { fadeVC, glowVC, loft, ring } from './kit';

const D = {
  hull: 0x2c3442,
  hullDark: 0x1c222c,
  hullLight: 0x46536a,
  accent: 0xffb21f,
  accentDark: 0xd98a00,
  metal: 0x9aa4b1,
  black: 0x14171c,
} as const;

/** Rotor duct centres (x, z). */
const DUCTS: readonly [number, number][] = [[-0.78, -0.5], [0.78, -0.5], [-0.78, 0.55], [0.78, 0.55]];
const DUCT_Y = 0.06;
const HOVER_Y = 2.35;
/** Overall size: ~1.5 m across the rotors. */
const DRONE_SCALE = 0.82;

function hullBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 61, jitter: 0.03 });
  // Pod: flattened, longer than wide, graphite with an amber belt.
  loft(mb, [
    { y: -0.3, rx: 0.16, rz: 0.22 },
    { y: -0.2, rx: 0.36, rz: 0.48 },
    { y: -0.06, rx: 0.46, rz: 0.6 },
    { y: 0.0, rx: 0.47, rz: 0.61 },
    { y: 0.05, rx: 0.46, rz: 0.6 },
    { y: 0.17, rx: 0.38, rz: 0.5 },
    { y: 0.27, rx: 0.2, rz: 0.28 },
    { y: 0.3, rx: 0.06, rz: 0.08 },
  ], { sides: 8, bands: [D.hullDark, D.hull, D.accent, D.accentDark, D.hull, D.hullLight, D.hullLight] });
  // Eye socket on the front (-Z): dark bezel ring.
  mb.push().translate(0, 0.02, -0.56).rotateX(Math.PI / 2).cylinder(0.2, 0.12, 8, {}, D.black).pop();
  mb.push().translate(0, 0.02, -0.6);
  ring(mb, 0.22, 0.15, 0.06, 8, D.metal, Math.PI * 2, 0, false, false);
  mb.pop();
  // Searchlight housing under the chin.
  mb.push().translate(0, -0.22, -0.4).rotateX(Math.PI / 2 + 0.5).cylinder(0.1, 0.16, 8, { radiusTop: 0.08 }, D.hullDark).pop();
  // Struts and ducts.
  for (const [x, z] of DUCTS) {
    const len = Math.hypot(x, z) - 0.35;
    const a = Math.atan2(x, z);
    mb.push().translate(x * 0.5, DUCT_Y - 0.02, z * 0.5).rotateY(a).box(0.09, 0.07, len, D.hull).pop();
    mb.push().translate(x, DUCT_Y, z).rotateX(Math.PI / 2);
    // Duct: top face toward +Y after the rotation is the ring's -Z side, so keep both caps
    // but drop nothing visible; amber outer wall reads as a warning band.
    ring(mb, 0.36, 0.31, 0.12, 10, { color: D.accentDark, top: D.accent }, Math.PI * 2, 0, true, true);
    mb.pop();
    // Motor pylon + cross brace inside the duct.
    mb.push().translate(x, DUCT_Y - 0.03, z).cylinder(0.05, 0.12, 5, { capBottom: false }, D.black).pop();
    mb.push().translate(x, DUCT_Y - 0.06, z).box(0.64, 0.025, 0.04, D.hullDark).pop();
  }
  // Beacon bases + antenna.
  for (const s of [-1, 1]) mb.push().translate(s * 0.16, 0.25, 0.08).cylinder(0.065, 0.05, 6, { capBottom: false }, D.black).pop();
  mb.push().translate(0.05, 0.42, 0.3).rotateX(-0.3).cylinder(0.012, 0.36, 5, {}, D.metal).pop();
  mb.push().translate(0.05, 0.6, 0.36).sphere(0.03, 0.03, 0.03, 6, 3, D.accent).pop();
  // Little grabber skids underneath (toy-like).
  for (const s of [-1, 1]) {
    mb.push().translate(s * 0.22, -0.34, 0.05).rotateZ(s * 0.35).box(0.05, 0.16, 0.05, D.metal).pop();
    mb.push().translate(s * 0.27, -0.42, 0.05).box(0.06, 0.04, 0.36, D.hullDark).pop();
  }
  // Side vents.
  for (const s of [-1, 1]) for (let i = 0; i < 2; i++) mb.block(s * 0.465 - 0.01, -0.06 + i * 0.045, 0.05 + -0.12, s * 0.465 + 0.01, -0.04 + i * 0.045, 0.05 + 0.12, D.black);
  return mb;
}

function rotorBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 62, jitter: 0.02 });
  mb.cylinder(0.05, 0.05, 5, { capBottom: false }, D.metal);
  for (let k = 0; k < 2; k++) {
    mb.push().rotateY(k * Math.PI).translate(0.15, 0, 0).rotateX(0.25).box(0.27, 0.012, 0.07, k === 0 ? D.accent : 0xd9dee5).pop();
  }
  return mb;
}

function eyeBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 63, jitter: 0 });
  // Red eye lens + bright pupil.
  mb.push().translate(0, 0.02, -0.615).rotateX(Math.PI / 2).cylinder(0.14, 0.02, 8, { capTop: false }, 0xff2a2a).pop();
  mb.push().translate(0, 0.02, -0.628).rotateX(Math.PI / 2).cylinder(0.055, 0.02, 6, { capTop: false }, 0xffd0c0).pop();
  // Searchlight emitter.
  mb.push().translate(0, -0.27, -0.47).rotateX(Math.PI / 2 + 0.5).cylinder(0.07, 0.02, 6, {}, 0xe8fbff).pop();
  return mb;
}

function beaconBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 64, jitter: 0 });
  mb.sphere(0.085, 0.1, 0.085, 6, 3, 0xffffff);
  return mb;
}

/** Searchlight cone: apex at the origin, opening along -Z, unit length; fades to black. */
function coneBuilder(): MeshBuilder {
  const mb = new MeshBuilder({ seed: 65, jitter: 0 });
  mb.push().rotateX(Math.PI / 2);
  loft(mb, [
    { y: 0, rx: 0.03, rz: 0.03 },
    { y: -0.15, rx: 0.06, rz: 0.06 },
    { y: -0.55, rx: 0.15, rz: 0.15 },
    { y: -1, rx: 0.24, rz: 0.24 },
  ], { sides: 12, bands: [{ color: 0xf2fcff, alpha: 0.42 }, { color: 0xe6f8ff, alpha: 0.2 }, { color: 0xdaf4ff, alpha: 0.07 }], capTop: false, capBottom: false });
  mb.pop();
  return mb;
}

interface ChaserGeometry {
  hull: Geometry3D;
  rotor: Geometry3D;
  eye: Geometry3D;
  beacon: Geometry3D;
  cone: Geometry3D;
}

let cache: ChaserGeometry | null = null;

export function chaserBuilders(): Record<string, MeshBuilder> {
  return { hull: hullBuilder(), rotor: rotorBuilder(), eye: eyeBuilder(), beacon: beaconBuilder(), cone: coneBuilder() };
}

function geometry(): ChaserGeometry {
  cache ??= {
    hull: hullBuilder().build(),
    rotor: rotorBuilder().build(),
    eye: eyeBuilder().build(),
    beacon: beaconBuilder().build(),
    cone: coneBuilder().build(),
  };
  return cache;
}

export class ChaserRig {
  readonly node: Container3D;
  private readonly hover: Container3D;
  private readonly frame: Container3D;
  private readonly scaleRoot: Container3D;
  private readonly rotors: Mesh3D[] = [];
  private readonly red: Mesh3D;
  private readonly blue: Mesh3D;
  private readonly coneYaw: Container3D;
  private readonly conePitch: Container3D;
  private readonly cone: Mesh3D;
  private vis = 0;
  private rotorAngle = 0;
  private lastX = NaN;
  private vx = 0;
  private bank = 0;
  private hasTarget = false;
  private readonly target = { x: 0, y: 0, z: 0 };

  constructor() {
    const g = geometry();
    this.node = new Container3D({ label: 'chaser' });
    this.hover = new Container3D({ parent: this.node, label: 'hover' });
    this.scaleRoot = new Container3D({ parent: this.hover, label: 'scale' });
    this.scaleRoot.scale.set(DRONE_SCALE, DRONE_SCALE, DRONE_SCALE);
    this.frame = new Container3D({ parent: this.scaleRoot, label: 'frame' });
    new Mesh3D({ geometry: g.hull, material: vertexColorGloss(), parent: this.frame, label: 'hull' });
    const eye = new Mesh3D({ geometry: g.eye, material: glowVC(3.2), parent: this.frame, label: 'eye' });
    eye.castShadow = false;
    for (let i = 0; i < DUCTS.length; i++) {
      const [x, z] = DUCTS[i];
      const r = new Mesh3D({ geometry: g.rotor, material: vertexColorGloss(), parent: this.frame, position: { x, y: DUCT_Y + 0.03, z }, label: 'rotor' });
      r.castShadow = false;
      this.rotors.push(r);
    }
    this.red = new Mesh3D({ geometry: g.beacon, material: glow(0xff2a2a, 4), parent: this.frame, position: { x: -0.16, y: 0.33, z: 0.08 }, label: 'beacon' });
    this.blue = new Mesh3D({ geometry: g.beacon, material: glow(0x2a7bff, 4), parent: this.frame, position: { x: 0.16, y: 0.33, z: 0.08 }, label: 'beacon' });
    this.red.castShadow = this.blue.castShadow = false;
    this.coneYaw = new Container3D({ parent: this.frame, position: { x: 0, y: -0.28, z: -0.48 }, label: 'searchlight' });
    this.conePitch = new Container3D({ parent: this.coneYaw });
    this.cone = new Mesh3D({ geometry: g.cone, material: fadeVC(), parent: this.conePitch, label: 'cone' });
    this.cone.castShadow = false;
    this.node.visible = false;
  }

  /**
   * Optional: aim the searchlight at a point given RELATIVE to this rig's node (e.g. the hero's
   * chest minus the drone node position). Without it the rig estimates the hero's position from
   * the gap and the lateral offset game.ts applies.
   */
  setTarget(dx: number, dy: number, dz: number): void {
    this.hasTarget = true;
    this.target.x = dx;
    this.target.y = dy;
    this.target.z = dz;
  }

  /** Hide the drone and forget motion state (new run / menu). */
  reset(): void {
    this.vis = 0;
    this.lastX = NaN;
    this.vx = 0;
    this.bank = 0;
    this.hasTarget = false;
    this.node.visible = false;
  }

  update(c: ChaserState, time: number, dt: number): void {
    if (!(dt >= 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    // Fade/scale in and out instead of popping.
    const goal = c.visible ? 1 : 0;
    this.vis += (goal - this.vis) * (1 - Math.exp(-dt * (c.visible ? 5 : 7)));
    if (Math.abs(goal - this.vis) < 0.002) this.vis = goal;
    this.node.visible = this.vis > 0.01;
    if (!this.node.visible) {
      this.lastX = NaN;
      return;
    }
    const e = this.vis * this.vis * (3 - 2 * this.vis);
    this.hover.scale.set(e, e, e);

    // Lateral velocity (game.ts moves the node in x after update) -> banking.
    const x = this.node.position.x;
    if (dt > 0) {
      if (Number.isFinite(this.lastX)) this.vx += ((x - this.lastX) / dt - this.vx) * (1 - Math.exp(-dt * 6));
      this.lastX = x;
    }
    this.bank += (Math.max(-0.5, Math.min(0.5, -this.vx * 0.12)) - this.bank) * (1 - Math.exp(-dt * 5));

    const bob = Math.sin(time * 2.6) * 0.13 + Math.sin(time * 4.3 + 1) * 0.04;
    this.hover.position.set(0, HOVER_Y + bob + (1 - e) * 1.6, 0);
    this.frame.rotation.set(-0.14 + Math.sin(time * 1.9) * 0.05, Math.sin(time * 0.9) * 0.12, this.bank + Math.sin(time * 1.6) * 0.07);

    // Rotors (alternating directions).
    this.rotorAngle += dt * 38;
    for (let i = 0; i < this.rotors.length; i++) this.rotors[i].rotation.y = (i === 0 || i === 3 ? 1 : -1) * this.rotorAngle + i;

    // Beacons: alternating double flashes.
    const ph = (time * 1.6) % 1;
    const flashR = (ph < 0.1 || (ph > 0.18 && ph < 0.28)) ? 1 : 0.35;
    const flashB = (ph > 0.5 && ph < 0.6) || (ph > 0.68 && ph < 0.78) ? 1 : 0.35;
    this.red.scale.set(flashR, flashR, flashR);
    this.blue.scale.set(flashB, flashB, flashB);

    // Searchlight aimed at the hero.
    let tx: number, ty: number, tz: number;
    if (this.hasTarget) {
      tx = this.target.x;
      ty = this.target.y;
      tz = this.target.z;
    } else {
      const heroX = (x - 1.7) / 0.6; // game.ts: chaser.x = hero.x * 0.6 + 1.7
      tx = heroX - x;
      ty = 0.9 - (HOVER_Y + bob);
      tz = -Math.max(2, c.gap);
    }
    // From the emitter (approx. node-relative) to the target.
    const dx = tx, dy = ty - (HOVER_Y + bob - 0.28 * DRONE_SCALE), dz = tz + 0.48 * DRONE_SCALE;
    const horiz = Math.hypot(dx, dz);
    this.coneYaw.rotation.y = Math.atan2(-dx, -dz) - this.frame.rotation.y + Math.sin(time * 1.3) * 0.04;
    this.conePitch.rotation.x = Math.atan2(dy, horiz) - this.frame.rotation.x;
    const dist = Math.min(13, Math.hypot(horiz, dy));
    const wide = 1.2 + dist * 0.22;
    const k = e / DRONE_SCALE;
    this.cone.scale.set(wide * k, wide * k, dist * k);
  }
}
