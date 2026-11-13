// Model factory (placeholder art, final API). Owned by the art engineers next.
//
// Contract:
// - createObstacle / createPickup return a NEW Container3D per call whose meshes SHARE one
//   Geometry3D + material per kind (=> the engine auto-instances all copies).
// - Origin at road level, centred in x and in length; length along local Z; sizes fit
//   OBSTACLE_DIMS (the collider uses the same numbers). Run direction is -Z, so the face the
//   player sees is the +Z face.
// - HeroRig/ChaserRig set their node's local pose (x, y, rotation, limbs). game.ts sets node z
//   from stage.worldZ() after calling update().
import { Container3D, Mesh3D } from '@pixi/3d';
import type { Geometry3D, BaseMaterial3D } from '@pixi/3d';
import { OBSTACLE_DIMS, PICKUP_HOVER, ROLL_TIME } from '../../sim/config';
import type { ChaserState, ObstacleKind, PickupKind, PlayerState, SimState } from '../../sim/types';
import { MeshBuilder } from '../geom/meshBuilder';
import { glow, vertexColorGloss, vertexColorMaterial } from '../geom/materials';

interface Part {
  geometry: Geometry3D;
  material: BaseMaterial3D;
}

const partCache = new Map<string, Part[]>();

function parts(key: string, make: () => Part[]): Part[] {
  let p = partCache.get(key);
  if (!p) {
    p = make();
    partCache.set(key, p);
  }
  return p;
}

function instantiate(list: Part[], label: string): Container3D {
  const node = new Container3D({ label });
  for (const p of list) node.addChild(new Mesh3D({ geometry: p.geometry, material: p.material }));
  return node;
}

// ------------------------------------------------------------------ obstacles

function stripedBar(mb: MeshBuilder, x0: number, x1: number, y0: number, y1: number, d: number, a: number, b: number, n: number): void {
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) mb.block(x0 + i * w, y0, -d / 2, x0 + (i + 1) * w, y1, d / 2, i % 2 ? b : a);
}

function wheels(mb: MeshBuilder, len: number, w: number): void {
  for (const z of [len / 2 - 1.1, -len / 2 + 1.1]) {
    for (const x of [-w / 2 + 0.12, w / 2 - 0.12]) {
      mb.push().translate(x, 0.42, z).rotateZ(Math.PI / 2).cylinder(0.42, 0.3, 10, {}, 0x22252b).pop();
    }
  }
}

function buildObstacle(kind: ObstacleKind): Part[] {
  const d = OBSTACLE_DIMS[kind];
  const mb = new MeshBuilder({ seed: kind.length * 31 + 7 });
  switch (kind) {
    case 'hurdle': {
      for (const x of [-d.w / 2 + 0.08, d.w / 2 - 0.08]) {
        mb.block(x - 0.07, 0, -0.05, x + 0.07, d.h, 0.05, 0xd8dde3);
        mb.block(x - 0.1, 0, -d.len / 2, x + 0.1, 0.06, d.len / 2, 0x5a6270);
      }
      stripedBar(mb, -d.w / 2, d.w / 2, d.h - 0.32, d.h, 0.1, 0xe63b2e, 0xfafafa, 8);
      break;
    }
    case 'overhead': {
      for (const x of [-d.w / 2 + 0.08, d.w / 2 - 0.08]) {
        mb.block(x - 0.08, 0, -0.12, x + 0.08, d.h, 0.12, { color: 0x545b66, top: 0x6b7380 });
      }
      stripedBar(mb, -d.w / 2, d.w / 2, d.solidFrom + 0.05, d.solidFrom + 0.55, d.len, 0xf4c20d, 0x1d1d1f, 9);
      mb.block(-d.w / 2, d.h - 0.22, -0.1, d.w / 2, d.h, 0.1, 0x545b66);
      break;
    }
    case 'blocker': {
      for (const x of [-0.7, 0.7]) {
        mb.block(x - 0.06, 0, -0.05, x + 0.06, 0.4, 0.05, 0x3b3f46);
        mb.block(x - 0.12, 0, -d.len / 2, x + 0.12, 0.08, d.len / 2, 0x3b3f46);
      }
      mb.push().translate(0, 0.4 + (d.h - 0.4) / 2, 0).bevelBox(d.w, d.h - 0.4, 0.22, 0.05, { color: 0xf07a1a, bottom: 0xc95a0c }).pop();
      for (let i = 0; i < 3; i++) mb.block(-d.w / 2 + 0.1, 0.75 + i * 0.55, 0.11, d.w / 2 - 0.1, 0.95 + i * 0.55, 0.13, 0xfafafa);
      break;
    }
    case 'truck': {
      const cab = 1.8;
      mb.push().translate(0, 0.35 + (d.h - 0.35) / 2, -cab / 2).bevelBox(d.w, d.h - 0.35, d.len - cab, 0.08, { color: 0xf3efe6, bottom: 0xcfc8ba }).pop();
      mb.push().translate(0, 0.35 + 0.95, d.len / 2 - cab / 2).bevelBox(d.w, 1.9, cab - 0.1, 0.12, { color: 0x2f9bd6, bottom: 0x1f6f9e }).pop();
      mb.block(-d.w / 2 + 0.1, 1.45, d.len / 2 - 0.08, d.w / 2 - 0.1, 2.05, d.len / 2 + 0.01, 0x1c2836);
      wheels(mb, d.len, d.w);
      break;
    }
    case 'bus':
    case 'busOncoming': {
      const body = kind === 'bus' ? { color: 0xf2b134, bottom: 0xc98a1a } : { color: 0xe0503c, bottom: 0xa83426 };
      mb.push().translate(0, 0.35 + (d.h - 0.35) / 2, 0).bevelBox(d.w, d.h - 0.35, d.len, 0.15, body).pop();
      for (const x of [-d.w / 2 - 0.005, d.w / 2 + 0.005]) mb.block(x - 0.01, 1.55, -d.len / 2 + 0.6, x + 0.01, 2.3, d.len / 2 - 0.6, 0x1c2836);
      mb.block(-d.w / 2 + 0.12, 1.4, d.len / 2 - 0.02, d.w / 2 - 0.12, 2.35, d.len / 2 + 0.02, 0x1c2836);
      wheels(mb, d.len, d.w);
      break;
    }
    case 'ramp': {
      mb.push().translate(0, d.h / 2, 0).wedge(d.w, d.h, d.len, { color: 0x3fae5a, bottom: 0x2a7d3e }).pop();
      // Chevrons painted on the slope.
      const slope = Math.atan2(d.h, d.len);
      for (let i = 0; i < 4; i++) {
        const t = 0.15 + i * 0.22;
        mb.push().translate(0, d.h * t + 0.02, d.len / 2 - d.len * t).rotateX(-slope);
        mb.block(-0.6, 0, -0.12, 0.6, 0.02, 0.12, 0xf5e663);
        mb.pop();
      }
      break;
    }
  }
  const mat = kind === 'bus' || kind === 'busOncoming' || kind === 'truck' ? vertexColorGloss() : vertexColorMaterial();
  const list: Part[] = [{ geometry: mb.build(), material: mat }];
  if (kind === 'busOncoming') {
    const lamps = new MeshBuilder();
    for (const x of [-0.75, 0.75]) lamps.block(x - 0.18, 0.6, OBSTACLE_DIMS.busOncoming.len / 2, x + 0.18, 0.8, OBSTACLE_DIMS.busOncoming.len / 2 + 0.04);
    list.push({ geometry: lamps.build(), material: glow(0xfff2c4, 3) });
  }
  return list;
}

export function createObstacle(kind: ObstacleKind): Container3D {
  return instantiate(parts(`obstacle:${kind}`, () => buildObstacle(kind)), kind);
}

// -------------------------------------------------------------------- pickups

const PICKUP_COLOR: Record<PickupKind, number> = {
  coin: 0xffc23a,
  magnet: 0xff4b5c,
  shield: 0x4fb3ff,
  boost: 0x5cf08a,
  multiplier: 0xc77dff,
};

function buildPickup(kind: PickupKind): Part[] {
  const mb = new MeshBuilder({ seed: 11 });
  mb.push().translate(0, PICKUP_HOVER, 0);
  switch (kind) {
    case 'coin':
      mb.rotateX(Math.PI / 2).cylinder(0.42, 0.1, 12, {}, 0xffffff);
      break;
    case 'magnet':
      mb.block(-0.35, -0.3, -0.1, -0.15, 0.25, 0.1).block(0.15, -0.3, -0.1, 0.35, 0.25, 0.1).block(-0.35, 0.25, -0.1, 0.35, 0.4, 0.1);
      break;
    case 'shield':
      mb.sphere(0.4, 0.45, 0.2, 8, 5);
      break;
    case 'boost':
      mb.cone(0.3, 0.8, 6);
      break;
    case 'multiplier':
      mb.bevelBox(0.6, 0.6, 0.2, 0.08);
      break;
  }
  mb.pop();
  return [{ geometry: mb.build(), material: glow(PICKUP_COLOR[kind], kind === 'coin' ? 1.25 : 1.6) }];
}

export function createPickup(kind: PickupKind): Container3D {
  return instantiate(parts(`pickup:${kind}`, () => buildPickup(kind)), kind);
}

// ----------------------------------------------------------------------- hero

const HERO = {
  jacket: 0x1fa3a3,
  jacketDark: 0x137474,
  scarf: 0xff7a2f,
  skin: 0xf0b88a,
  cap: 0x167a86,
  pants: 0x2d3e5c,
  shoes: 0xf4f1ea,
  satchel: 0x9a6236,
};

function heroParts(): Record<'torso' | 'head' | 'arm' | 'leg', Geometry3D> {
  const torso = new MeshBuilder({ seed: 2 });
  torso.push().translate(0, 0.28, 0).bevelBox(0.52, 0.56, 0.32, 0.07, { color: HERO.jacket, bottom: HERO.jacketDark }).pop();
  torso.push().translate(0, 0.56, 0).bevelBox(0.46, 0.1, 0.36, 0.03, HERO.scarf).pop();
  torso.push().translate(0.05, 0.28, 0.22).bevelBox(0.36, 0.34, 0.14, 0.04, HERO.satchel).pop(); // satchel on the back (+Z)
  torso.block(-0.27, 0.0, -0.17, 0.27, 0.06, 0.17, HERO.pants);

  const head = new MeshBuilder({ seed: 3 });
  head.push().translate(0, 0.18, 0).bevelBox(0.32, 0.34, 0.32, 0.07, HERO.skin).pop();
  head.push().translate(0, 0.37, 0.01).bevelBox(0.35, 0.1, 0.35, 0.03, HERO.cap).pop();
  head.block(-0.15, 0.33, -0.36, 0.15, 0.37, -0.1, HERO.cap); // brim toward -Z (forward)
  head.block(-0.1, 0.17, -0.17, -0.05, 0.22, -0.16, 0x222222).block(0.05, 0.17, -0.17, 0.1, 0.22, -0.16, 0x222222);

  // Limbs hang down from their pivot (pivot at local origin).
  const arm = new MeshBuilder({ seed: 4 });
  arm.push().translate(0, -0.22, 0).bevelBox(0.14, 0.46, 0.14, 0.035, { color: HERO.jacket, bottom: HERO.jacketDark }).pop();
  arm.push().translate(0, -0.5, 0).bevelBox(0.12, 0.12, 0.12, 0.03, HERO.skin).pop();

  const leg = new MeshBuilder({ seed: 5 });
  leg.push().translate(0, -0.38, 0).bevelBox(0.17, 0.72, 0.18, 0.04, HERO.pants).pop();
  leg.push().translate(0, -0.8, -0.04).bevelBox(0.19, 0.12, 0.3, 0.04, HERO.shoes).pop();

  return { torso: torso.build(), head: head.build(), arm: arm.build(), leg: leg.build() };
}

let heroGeo: ReturnType<typeof heroParts> | null = null;

export class HeroRig {
  readonly node: Container3D;
  private body: Container3D;
  private tumble: Container3D;
  private armL: Container3D;
  private armR: Container3D;
  private legL: Container3D;
  private legR: Container3D;
  private squash = 1;

  constructor() {
    heroGeo ??= heroParts();
    const g = heroGeo;
    const mat = vertexColorMaterial();
    this.node = new Container3D({ label: 'hero' });
    this.body = new Container3D({ parent: this.node });
    // Tumble pivot at mid-height so a roll spins around the body centre.
    this.tumble = new Container3D({ parent: this.body, position: { x: 0, y: 0.5, z: 0 } });
    const inner = new Container3D({ parent: this.tumble, position: { x: 0, y: -0.5, z: 0 } });
    new Mesh3D({ parent: inner, geometry: g.torso, material: mat, position: { x: 0, y: 0.86, z: 0 } });
    new Mesh3D({ parent: inner, geometry: g.head, material: mat, position: { x: 0, y: 1.44, z: 0 } });
    const limb = (geo: Geometry3D, x: number, y: number) => {
      const pivot = new Container3D({ parent: inner, position: { x, y, z: 0 } });
      new Mesh3D({ parent: pivot, geometry: geo, material: mat });
      return pivot;
    };
    this.armL = limb(g.arm, -0.34, 1.36);
    this.armR = limb(g.arm, 0.34, 1.36);
    this.legL = limb(g.leg, -0.13, 0.86);
    this.legR = limb(g.leg, 0.13, 0.86);
  }

  update(p: PlayerState, _powerups: SimState['powerups'], dt: number): void {
    this.node.position.x = p.x;
    this.node.position.y = p.y;
    const body = this.body;
    const sw = Math.sin(p.runPhase);
    let legSwing = sw * 0.9;
    let armSwing = -sw * 0.8;
    let bob = Math.abs(Math.cos(p.runPhase)) * 0.06;
    let spin = 0;
    let pitch = -0.12; // lean into the run
    let squashTarget = 1;

    switch (p.action) {
      case 'jump':
      case 'fall':
      case 'fly':
        legSwing = 0.7;
        armSwing = -1.9;
        bob = 0;
        pitch = 0.05;
        this.legL.rotation.x = 0.9;
        this.legR.rotation.x = 0.3;
        break;
      case 'roll':
        spin = -(Math.min(1, p.actionTime / ROLL_TIME) * Math.PI * 2);
        squashTarget = 0.62;
        bob = 0;
        break;
      case 'dead':
        pitch = Math.max(-1.45, -p.actionTime * 6);
        legSwing = 0;
        armSwing = -1.2;
        bob = 0;
        break;
      case 'stumble':
        pitch = Math.sin(p.actionTime * 20) * 0.2;
        break;
      default:
        break;
    }
    if (p.action !== 'jump' && p.action !== 'fall' && p.action !== 'fly') {
      this.legL.rotation.x = legSwing;
      this.legR.rotation.x = -legSwing;
    }
    this.armL.rotation.x = armSwing;
    this.armR.rotation.x = p.action === 'jump' || p.action === 'fall' ? armSwing : -armSwing;

    this.squash += (squashTarget - this.squash) * Math.min(1, dt * 20);
    body.scale.set(1 + (1 - this.squash) * 0.3, this.squash, 1);
    body.position.y = bob;
    body.rotation.x = p.action === 'dead' ? pitch : 0;
    this.tumble.rotation.x = p.action === 'dead' ? 0 : spin + pitch;
    body.rotation.z = -p.lean * 0.22;
  }
}

// --------------------------------------------------------------------- chaser

function chaserGeometry(): { hull: Geometry3D; light: Geometry3D } {
  const mb = new MeshBuilder({ seed: 9 });
  mb.sphere(0.55, 0.32, 0.65, 8, 5, { color: 0x3d4552, top: 0x5b6574 });
  for (const [x, z] of [[-0.75, -0.6], [0.75, -0.6], [-0.75, 0.6], [0.75, 0.6]]) {
    mb.block(Math.min(0, x), -0.04, z - 0.05, Math.max(0, x), 0.04, z + 0.05, 0x2a2f38);
    mb.push().translate(x, 0.08, z).cylinder(0.32, 0.03, 10, {}, 0x8a94a3).pop();
  }
  const light = new MeshBuilder();
  light.push().translate(0, -0.18, -0.5).sphere(0.16, 0.12, 0.1, 8, 4).pop();
  return { hull: mb.build(), light: light.build() };
}

let chaserGeo: ReturnType<typeof chaserGeometry> | null = null;

export class ChaserRig {
  readonly node: Container3D;
  private hull: Container3D;

  constructor() {
    chaserGeo ??= chaserGeometry();
    this.node = new Container3D({ label: 'chaser' });
    this.hull = new Container3D({ parent: this.node });
    new Mesh3D({ parent: this.hull, geometry: chaserGeo.hull, material: vertexColorGloss() });
    new Mesh3D({ parent: this.hull, geometry: chaserGeo.light, material: glow(0xbff6ff, 4) });
  }

  update(c: ChaserState, time: number, _dt: number): void {
    this.node.visible = c.visible;
    if (!c.visible) return;
    this.hull.position.y = 1.9 + Math.sin(time * 3.1) * 0.15;
    this.hull.rotation.z = Math.sin(time * 1.7) * 0.08;
    this.hull.rotation.x = 0.15;
  }
}
