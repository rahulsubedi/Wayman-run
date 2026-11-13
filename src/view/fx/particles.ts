// CPU particle pool on top of one ParticleContainer3D (one draw call per pool).
//
// Struct-of-arrays state, a ring allocator (overflow recycles the oldest), and a reusable spawn
// template (`pool.t`) so emitting allocates nothing:
//
//   pool.t.life = 0.4; pool.t.size0 = 0.3; ...; pool.emit(x, y, z, vx, vy, vz);
//
// Stepped explicitly with `update(dt)` (deterministic, so it works with the debug fast-forward).
// Positions are world space; call `shift(dz)` on origin re-base.
import { ParticleContainer3D } from '@pixi/3d';
import type { Container3D, ParticleBillboardMode, ParticleBlendMode } from '@pixi/3d';
import type { Texture } from 'pixi.js';
import { mixHex } from '../geom/color';

/** Motion modes. */
export const Mode = {
  /** Gravity + drag ballistic flight. */
  Ballistic: 0,
  /** Circles the anchor point (see `setAnchor`): vx = angular speed, vy = radius, vz = height. */
  Orbit: 1,
  /** Ballistic, and rotated each frame to point away from the camera's axis (speed streaks). */
  Radial: 2,
  /** Ballistic with a bounce on y = floor (vz: forward drag on contact). */
  Bounce: 3,
} as const;

export interface SpawnTemplate {
  life: number;
  size0: number;
  size1: number;
  color0: number;
  color1: number;
  alpha0: number;
  alpha1: number;
  /** Fraction of life spent fading in (0 = pops in at alpha0). */
  fadeIn: number;
  frame: number;
  /** Downward acceleration (negative rises). */
  gravity: number;
  /** Velocity damping per second. */
  drag: number;
  rotation: number;
  spin: number;
  mode: number;
  /** Floor height for Mode.Bounce. */
  floor: number;
}

export interface PoolOptions {
  parent: Container3D;
  frames: Texture[];
  capacity: number;
  blendMode: ParticleBlendMode;
  billboard?: ParticleBillboardMode;
  /** Slots [0, reserved) are written by the owner with `node.setParticleAt` (never allocated). */
  reserved?: number;
  label?: string;
}

export class ParticlePool {
  readonly node: ParticleContainer3D;
  readonly capacity: number;
  /** Spawn template: set fields, then call `emit`. */
  readonly t: SpawnTemplate = {
    life: 0.5, size0: 0.3, size1: 0, color0: 0xffffff, color1: 0xffffff, alpha0: 1, alpha1: 0, fadeIn: 0,
    frame: 0, gravity: 0, drag: 0, rotation: 0, spin: 0, mode: 0, floor: 0,
  };

  private readonly reserved: number;
  private next: number;
  private live = 0;
  private dirty = false;
  // per-particle state
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly s0: Float32Array; private readonly s1: Float32Array;
  private readonly a0: Float32Array; private readonly a1: Float32Array; private readonly fin: Float32Array;
  private readonly rot: Float32Array; private readonly spin: Float32Array;
  private readonly grav: Float32Array; private readonly drag: Float32Array; private readonly floor: Float32Array;
  private readonly c0: Uint32Array; private readonly c1: Uint32Array;
  private readonly frame: Uint8Array; private readonly mode: Uint8Array; private readonly alive: Uint8Array;

  // anchor for Mode.Orbit and camera for Mode.Radial
  private ax = 0; private ay = 0; private az = 0;
  private cx = 0; private cy = 0;

  constructor(o: PoolOptions) {
    this.capacity = o.capacity;
    this.reserved = o.reserved ?? 0;
    this.next = this.reserved;
    this.node = new ParticleContainer3D({
      label: o.label ?? 'particles',
      texture: o.frames,
      capacity: o.capacity,
      blendMode: o.blendMode,
      billboard: o.billboard ?? 'spherical',
    });
    o.parent.addChild(this.node);
    const n = o.capacity;
    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.s0 = f(); this.s1 = f(); this.a0 = f(); this.a1 = f(); this.fin = f();
    this.rot = f(); this.spin = f(); this.grav = f(); this.drag = f(); this.floor = f();
    this.c0 = new Uint32Array(n); this.c1 = new Uint32Array(n);
    this.frame = new Uint8Array(n); this.mode = new Uint8Array(n); this.alive = new Uint8Array(n);
  }

  /** Point Mode.Orbit particles circle (world space). */
  setAnchor(x: number, y: number, z: number): void {
    this.ax = x; this.ay = y; this.az = z;
  }

  /** Camera position, for Mode.Radial streak orientation. */
  setCamera(x: number, y: number): void {
    this.cx = x; this.cy = y;
  }

  /** Spawn one particle from the template. For Mode.Orbit, x is the start angle (rad). */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const i = this.next;
    this.next = this.next + 1 >= this.capacity ? this.reserved : this.next + 1;
    if (!this.alive[i]) this.live++;
    const t = this.t;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = Math.max(0.01, t.life);
    this.s0[i] = t.size0; this.s1[i] = t.size1;
    this.a0[i] = t.alpha0; this.a1[i] = t.alpha1; this.fin[i] = t.fadeIn;
    this.c0[i] = t.color0; this.c1[i] = t.color1;
    this.rot[i] = t.rotation; this.spin[i] = t.spin;
    this.grav[i] = t.gravity; this.drag[i] = t.drag; this.floor[i] = t.floor;
    this.frame[i] = t.frame; this.mode[i] = t.mode; this.alive[i] = 1;
  }

  /** Mark reserved-slot writes for upload this frame. */
  touch(): void {
    this.dirty = true;
  }

  update(dt: number): void {
    const node = this.node;
    if (this.live === 0) {
      if (this.dirty) node.upload();
      this.dirty = false;
      return;
    }
    for (let i = this.reserved; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i] + dt;
      const life = this.life[i];
      if (age >= life) {
        this.alive[i] = 0;
        this.live--;
        node.setParticleAt(i, 0, 0, 0, 0);
        continue;
      }
      this.age[i] = age;
      const k = age / life;
      const m = this.mode[i];
      let x: number, y: number, z: number;
      if (m === Mode.Orbit) {
        this.px[i] += this.vx[i] * dt; // angle
        x = this.ax + Math.cos(this.px[i]) * this.vy[i];
        y = this.ay + this.vz[i];
        z = this.az + Math.sin(this.px[i]) * this.vy[i];
      } else {
        const d = this.drag[i] > 0 ? Math.exp(-this.drag[i] * dt) : 1;
        this.vx[i] *= d; this.vz[i] *= d;
        this.vy[i] = this.vy[i] * d - this.grav[i] * dt;
        x = this.px[i] + this.vx[i] * dt;
        y = this.py[i] + this.vy[i] * dt;
        z = this.pz[i] + this.vz[i] * dt;
        if (m === Mode.Bounce && y < this.floor[i]) {
          y = this.floor[i];
          if (this.vy[i] < 0) this.vy[i] *= -0.35;
          this.vx[i] *= 0.6; this.vz[i] *= 0.6; this.spin[i] *= 0.5;
        }
        this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      }
      let r: number;
      if (m === Mode.Radial) r = Math.atan2(y - this.cy, x - this.cx);
      else r = this.rot[i] += this.spin[i] * dt;
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      let a = this.a0[i] + (this.a1[i] - this.a0[i]) * k;
      const fin = this.fin[i];
      if (fin > 0 && k < fin) a *= k / fin;
      const c0 = this.c0[i], c1 = this.c1[i];
      node.setParticleAt(i, x, y, z, size, r, c0 === c1 ? c0 : mixHex(c0, c1, k), a, this.frame[i]);
    }
    node.upload();
    this.dirty = false;
  }

  shift(dz: number): void {
    for (let i = this.reserved; i < this.capacity; i++) if (this.alive[i]) this.pz[i] += dz;
  }

  clear(): void {
    for (let i = this.reserved; i < this.capacity; i++) {
      if (this.alive[i]) this.node.setParticleAt(i, 0, 0, 0, 0);
      this.alive[i] = 0;
    }
    this.live = 0;
    this.node.upload();
  }

  get count(): number {
    return this.live;
  }
}
