// Fx (placeholder, final API): particles and screen feedback driven by sim events.
// Today: a pooled coin-pickup sparkle burst. Particles are placed in world space once, so they
// subscribe to stage.onRebase() and shift with the origin.
import { Container3D, Mesh3D } from '@pixi/3d';
import { PICKUP_HOVER } from '../../sim/config';
import type { SimEvent, SimState } from '../../sim/types';
import { MeshBuilder } from '../geom/meshBuilder';
import { glow } from '../geom/materials';
import type { Stage } from '../stage';

const POOL = 48;
const BURST = 6;
const LIFE = 0.45;

interface Particle {
  mesh: Mesh3D;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  alive: boolean;
}

export class Fx {
  private readonly stage: Stage;
  private readonly root = new Container3D({ label: 'fx' });
  private readonly particles: Particle[] = [];
  private next = 0;
  private seed = 1;

  constructor(stage: Stage) {
    this.stage = stage;
    stage.world.addChild(this.root);
    const geometry = new MeshBuilder().sphere(0.09, 0.09, 0.09, 4, 2).build();
    const material = glow(0xfff0a0, 3);
    for (let i = 0; i < POOL; i++) {
      const mesh = new Mesh3D({ parent: this.root, geometry, material, castShadow: false, visible: false });
      this.particles.push({ mesh, vx: 0, vy: 0, vz: 0, age: 0, alive: false });
    }
    stage.onRebase((dz) => {
      for (const p of this.particles) if (p.alive) p.mesh.position.z += dz;
    });
  }

  onEvent(e: SimEvent, state: SimState): void {
    if (e.type === 'coin') {
      // Spawn slightly ahead along the run so the burst stays near the passing player.
      const z = this.stage.worldZ(Math.max(e.s, state.player.s));
      for (let i = 0; i < BURST; i++) {
        const a = (i / BURST) * Math.PI * 2 + this.rand() * 0.5;
        this.emit(e.x, e.y + PICKUP_HOVER, z, Math.cos(a) * 2.2, 2.5 + this.rand() * 2, Math.sin(a) * 2.2 - state.player.speed * 0.6);
      }
    }
  }

  update(_state: SimState, dt: number): void {
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= LIFE) {
        p.alive = false;
        p.mesh.visible = false;
        continue;
      }
      p.vy -= 9 * dt;
      const pos = p.mesh.position;
      pos.set(pos.x + p.vx * dt, pos.y + p.vy * dt, pos.z + p.vz * dt);
      const k = 1 - p.age / LIFE;
      p.mesh.scale.set(k, k, k);
    }
  }

  /** Hide everything (new run). */
  reset(): void {
    for (const p of this.particles) {
      p.alive = false;
      p.mesh.visible = false;
    }
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const p = this.particles[this.next];
    this.next = (this.next + 1) % POOL;
    p.mesh.position.set(x, y, z);
    p.mesh.scale.set(1, 1, 1);
    p.mesh.visible = true;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.age = 0;
    p.alive = true;
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
}
