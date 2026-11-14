// Fx: particles and screen feedback driven by sim events and state.
//
// Four pooled particle containers (one draw call each), all sharing one procedural sprite sheet:
//   glow    additive, camera-facing: sparkles, sparks, streaks, exhaust, shards, stars
//   soft    normal blend, camera-facing: dust puffs, crash debris
//   ground  normal blend, lying flat: contact shadow under the hero, dust rings
//   halo    additive, lying flat: power-up rings, boost ground glow
// plus a 2D ScreenFx layer (flash, vignette, coloured edge pulse).
//
// Particle counts scale with the quality tier's `fxDensity`. Everything is world space and shifts
// on origin re-base. `update()` allocates nothing.
import { Container3D } from '@pixi/3d';
import { MAGNET_RADIUS, PICKUP_HOVER, SPEED_MAX, SPEED_START } from '../../sim/config';
import type { PowerupKind, SimEvent, SimState } from '../../sim/types';
import { mixHex } from '../geom/color';
import { POWERUP_COLOR } from '../models/pickups';
import type { Stage } from '../stage';
import { Frame, particleFrames } from './atlas';
import { Mode, ParticlePool } from './particles';
import { ScreenFx } from './screen';

/** Colours per power-up: the pickup models' colours (magnet red, shield blue, boost orange, multiplier purple). */
export const POWERUP_FX_COLOR: Record<PowerupKind, number> = POWERUP_COLOR;

/** Dust tint per zone (market sandstone, harbor warm, night cool). */
const DUST = [0xe6d6b8, 0xf0c9a0, 0x8d93b8];
const DEBRIS = [0x5d6470, 0xe8763a, 0xf2efe6, 0x2a2f3a, 0xf0c040];
const TAU = Math.PI * 2;

export class Fx {
  readonly screen: ScreenFx;
  private readonly stage: Stage;
  private readonly root = new Container3D({ label: 'fx' });
  private readonly glow: ParticlePool;
  private readonly soft: ParticlePool;
  private readonly ground: ParticlePool;
  private readonly halo: ParticlePool;
  private seed = 1;
  private density = 1;
  private zone = 0;
  private time = 0;
  // continuous-emitter accumulators
  private streakAcc = 0;
  private exhaustAcc = 0;
  private magnetAcc = 0;
  private lastStep = 0;
  private stepSide = 1;
  private support = 0;
  private wasDead = false;

  constructor(stage: Stage) {
    this.stage = stage;
    stage.world.addChild(this.root);
    const frames = particleFrames();
    this.ground = new ParticlePool({ parent: this.root, frames, capacity: 24, blendMode: 'normal', billboard: 'horizontal', reserved: 1, label: 'fxGround' });
    this.halo = new ParticlePool({ parent: this.root, frames, capacity: 24, blendMode: 'add', billboard: 'horizontal', reserved: 1, label: 'fxHalo' });
    this.soft = new ParticlePool({ parent: this.root, frames, capacity: 160, blendMode: 'normal', label: 'fxSoft' });
    this.glow = new ParticlePool({ parent: this.root, frames, capacity: 360, blendMode: 'add', label: 'fxGlow' });
    this.screen = new ScreenFx(stage);
    this.density = stage.settings.fxDensity;
    stage.onQualityChange((_q, s) => {
      this.density = s.fxDensity;
    });
    stage.onRebase((dz) => {
      this.glow.shift(dz);
      this.soft.shift(dz);
      this.ground.shift(dz);
      this.halo.shift(dz);
    });
  }

  onEvent(e: SimEvent, state: SimState): void {
    const p = state.player;
    const hz = this.stage.worldZ(p.s);
    const carry = -p.speed; // world z velocity of the hero
    switch (e.type) {
      case 'coin':
        // Coins are collected at the hero: burst just in front of him (camera side) so his body
        // never hides it, travelling with him.
        this.coinBurst(e.x, e.y + PICKUP_HOVER + 0.15, hz + 0.45, carry);
        break;
      case 'pickup': {
        const c = POWERUP_FX_COLOR[e.kind];
        this.ringBurst(p.x, p.y, hz, carry, c, 1);
        this.screen.pulse(c, 0.55);
        this.screen.flash(0xffffff, 0.1);
        break;
      }
      case 'powerupEnd':
        this.fizzle(p.x, p.y, hz, carry, POWERUP_FX_COLOR[e.kind]);
        break;
      case 'land':
        this.dust(p.x, p.y, hz, carry, e.hard ? 12 : 6, e.hard ? 1.25 : 0.9);
        if (e.hard) this.groundRing(p.x, p.y, hz, carry, DUST[this.zone], 0.45);
        break;
      case 'jump':
        this.dust(p.x, p.y, hz, carry, 4, 0.7);
        break;
      case 'roll':
        this.dust(p.x, p.y, hz, carry, 4, 0.6);
        break;
      case 'laneChange':
        this.kickDust(p.x, p.y, hz, carry, -e.dir);
        break;
      case 'nearMiss':
        this.whoosh(p.x, p.y, hz, carry);
        break;
      case 'stumble':
        this.stumbleStars(p.x, p.y, hz, carry);
        this.screen.pulse(0xff9a3a, 0.3, 4);
        break;
      case 'shieldBreak':
        this.shards(p.x, p.y + 1.0, hz - 0.4, carry * 0.5, POWERUP_FX_COLOR.shield);
        this.screen.flash(0xbfe8ff, 0.22);
        this.screen.pulse(POWERUP_FX_COLOR.shield, 0.45, 5);
        break;
      case 'gameOver':
        if (e.reason === 'crash') {
          this.crash(p.x, p.y, hz);
          this.screen.flash(0xfff0e0, 0.3);
          this.screen.pulse(0xff3a2a, 0.45, 5);
        } else {
          this.stumbleStars(p.x, p.y, hz, 0);
          this.sparks(p.x, p.y + 1.2, hz, 0, 0xfff1b0, 14);
          this.screen.flash(0xff5a4a, 0.25);
          this.screen.pulse(0xff3a2a, 0.3, 5);
        }
        break;
      default:
        break;
    }
  }

  update(state: SimState, dt: number): void {
    this.time += dt;
    const p = state.player;
    this.zone = ((state.zone % 3) + 3) % 3;
    const hz = this.stage.worldZ(p.s);
    const cam = this.stage.camera.position;
    const d = this.density;
    const flying = p.action === 'fly';
    const speed01 = Math.max(0, Math.min(1, (p.speed - SPEED_START) / (SPEED_MAX - SPEED_START)));

    // support height under the hero (for ground decals)
    if (p.grounded || p.action === 'dead') this.support = p.y;
    else if (p.y < this.support) this.support = p.y;
    if (flying) this.support = 0;

    this.glow.setAnchor(p.x, p.y, hz);
    this.soft.setAnchor(p.x, p.y, hz);
    this.glow.setCamera(cam.x, cam.y);

    if (dt > 0 && !state.over) {
      // footstep dust
      if (p.grounded && p.action === 'run' && d >= 0.6) {
        const step = Math.floor(p.runPhase / Math.PI);
        if (step !== this.lastStep) {
          this.lastStep = step;
          this.stepSide = -this.stepSide;
          if (this.rand() < 0.7) this.footPuff(p.x + this.stepSide * 0.17, p.y, hz + 0.15, -p.speed);
        }
      }
      // speed streaks (high speed, and always in boost flight)
      const rate = (Math.max(0, speed01 - 0.4) * 34 + (flying ? 34 : 0)) * d;
      this.streakAcc += rate * dt;
      while (this.streakAcc >= 1) {
        this.streakAcc -= 1;
        this.streak(cam.x, cam.y, cam.z, flying);
      }
      // boost exhaust
      if (flying) {
        this.exhaustAcc += 55 * d * dt;
        while (this.exhaustAcc >= 1) {
          this.exhaustAcc -= 1;
          this.exhaust(p.x, p.y, hz, -p.speed);
        }
      } else this.exhaustAcc = 0;
      // magnet glints on coins being pulled in + a slow orbit around the hero
      if (state.powerups.magnet > 0) {
        this.magnetAcc += 18 * d * dt;
        while (this.magnetAcc >= 1) {
          this.magnetAcc -= 1;
          this.magnetGlint(state, hz);
        }
      }
    }

    // contact shadow (ground slot 0) and boost glow (halo slot 0)
    const h = Math.max(0, p.y - this.support);
    const show = p.action !== 'dead' || h < 0.1;
    const shadowA = show ? 0.3 * Math.max(0, 1 - h / 5) : 0;
    this.ground.node.setParticleAt(0, p.x, this.support + 0.03, hz, 1.05 + h * 0.12, 0, 0x0c1022, shadowA, Frame.Blob);
    this.ground.touch();
    if (flying) {
      const pulse = 0.75 + 0.25 * Math.sin(this.time * 9);
      this.halo.node.setParticleAt(0, p.x, 0.05, hz, 2.6 * pulse, 0, POWERUP_FX_COLOR.boost, 0.45 * pulse, Frame.Blob);
    } else {
      this.halo.node.setParticleAt(0, 0, 0, 0, 0);
    }
    this.halo.touch();

    if (p.action === 'dead' && !this.wasDead) this.speedLinesOff();
    this.wasDead = p.action === 'dead';

    this.glow.update(dt);
    this.soft.update(dt);
    this.ground.update(dt);
    this.halo.update(dt);
    this.screen.update(dt, flying ? 1 : speed01);
  }

  /** Hide everything (new run). */
  reset(): void {
    this.glow.clear();
    this.soft.clear();
    this.ground.clear();
    this.halo.clear();
    this.screen.reset();
    this.streakAcc = this.exhaustAcc = this.magnetAcc = 0;
    this.support = 0;
    this.wasDead = false;
    this.seed = 1; // every run replays the same effect randomness (deterministic captures)
  }

  /** Live particle count (debug / perf overlay). */
  get particleCount(): number {
    return this.glow.count + this.soft.count + this.ground.count + this.halo.count;
  }

  // ------------------------------------------------------------- effects

  private n(base: number): number {
    return Math.max(1, Math.round(base * this.density));
  }

  private coinBurst(x: number, y: number, z: number, carry: number): void {
    const g = this.glow, t = g.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Spark; t.fadeIn = 0;
    t.color0 = 0xffd75a; t.color1 = 0xff8a10; t.alpha0 = 0.9; t.alpha1 = 0;
    t.gravity = 5; t.drag = 2.5; t.spin = 0; t.rotation = 0;
    const count = this.n(9);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + this.rand() * 0.6;
      const sp = 2 + this.rand() * 2.2;
      t.life = 0.32 + this.rand() * 0.2;
      t.size0 = 0.22 + this.rand() * 0.16; t.size1 = 0.04;
      t.rotation = this.rand() * 0.8;
      g.emit(x, y, z, Math.cos(a) * sp, Math.sin(a) * sp * 0.9 + 1.6, carry + (this.rand() - 0.2) * 1.2);
    }
    // bright pop + ring
    t.gravity = 0; t.drag = 0; t.frame = Frame.Dot; t.life = 0.12; t.size0 = 0.55; t.size1 = 0.2;
    t.color0 = 0xffe9a0; t.color1 = 0xffb020; t.alpha0 = 0.45;
    g.emit(x, y, z, 0, 0, carry);
    t.frame = Frame.Ring; t.life = 0.26; t.size0 = 0.35; t.size1 = 1.5; t.alpha0 = 0.65;
    g.emit(x, y, z, 0, 0, carry);
  }

  private ringBurst(x: number, y: number, z: number, carry: number, color: number, scale: number): void {
    const hl = this.halo, t = hl.t;
    t.mode = Mode.Ballistic; t.gravity = 0; t.drag = 0; t.spin = 0; t.rotation = 0; t.fadeIn = 0;
    t.frame = Frame.Ring; t.color0 = mixHex(0xffffff, color, 0.45); t.color1 = color; t.alpha0 = 0.8; t.alpha1 = 0;
    t.life = 0.55; t.size0 = 0.6; t.size1 = 7 * scale;
    hl.emit(x, y + 0.06, z, 0, 0, carry * 0.9);
    t.life = 0.8; t.size0 = 0.4; t.size1 = 4.5 * scale; t.color0 = color; t.alpha0 = 0.7;
    hl.emit(x, y + 0.07, z, 0, 0, carry * 0.9);
    // rising spiral of sparkles
    const g = this.glow, s = g.t;
    s.mode = Mode.Ballistic; s.frame = Frame.Spark; s.fadeIn = 0.1;
    s.color0 = mixHex(0xffffff, color, 0.5); s.color1 = color; s.alpha0 = 0.85; s.alpha1 = 0; s.gravity = -3; s.drag = 1.8; s.spin = 3;
    const count = this.n(18);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const sp = 2.4 + this.rand() * 1.2;
      s.life = 0.6 + this.rand() * 0.35; s.size0 = 0.32 + this.rand() * 0.18; s.size1 = 0.05;
      s.rotation = this.rand() * TAU;
      g.emit(x + Math.cos(a) * 0.4, y + 0.3 + this.rand() * 1.4, z + Math.sin(a) * 0.4, Math.cos(a) * sp, 1 + this.rand() * 2.5, Math.sin(a) * sp + carry * 0.95);
    }
  }

  private fizzle(x: number, y: number, z: number, carry: number, color: number): void {
    const g = this.glow, t = g.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Dot; t.fadeIn = 0; t.gravity = -1.5; t.drag = 2; t.spin = 0;
    t.color0 = color; t.color1 = color; t.alpha0 = 0.8; t.alpha1 = 0;
    const count = this.n(10);
    for (let i = 0; i < count; i++) {
      t.life = 0.4 + this.rand() * 0.3; t.size0 = 0.18; t.size1 = 0.02;
      g.emit(x + (this.rand() - 0.5) * 0.8, y + 0.3 + this.rand() * 1.4, z, (this.rand() - 0.5) * 1.5, 0.8, carry * 0.95);
    }
  }

  private dust(x: number, y: number, z: number, carry: number, base: number, scale: number): void {
    const s = this.soft, t = s.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Puff; t.fadeIn = 0.08;
    t.color0 = DUST[this.zone]; t.color1 = t.color0; t.alpha0 = 0.6; t.alpha1 = 0;
    t.gravity = -0.4; t.drag = 3.2; t.spin = 0;
    const count = this.n(base);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + this.rand() * 0.5;
      const sp = (1.6 + this.rand() * 1.8) * scale;
      t.life = 0.45 + this.rand() * 0.3;
      t.size0 = 0.3 * scale; t.size1 = (0.9 + this.rand() * 0.5) * scale;
      t.rotation = this.rand() * TAU; t.spin = (this.rand() - 0.5) * 2;
      s.emit(x + Math.cos(a) * 0.25, y + 0.12, z + Math.sin(a) * 0.2, Math.cos(a) * sp, 0.4 + this.rand() * 0.6, Math.sin(a) * sp * 0.6 + carry * 0.8);
    }
  }

  private footPuff(x: number, y: number, z: number, carry: number): void {
    const s = this.soft, t = s.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Puff; t.fadeIn = 0.1;
    t.color0 = DUST[this.zone]; t.color1 = t.color0; t.alpha0 = 0.32; t.alpha1 = 0;
    t.gravity = -0.3; t.drag = 3; t.life = 0.38; t.size0 = 0.18; t.size1 = 0.55;
    t.rotation = this.rand() * TAU; t.spin = 0;
    s.emit(x, y + 0.08, z, (this.rand() - 0.5) * 0.8, 0.35, carry * 0.55);
  }

  private kickDust(x: number, y: number, z: number, carry: number, dir: number): void {
    const s = this.soft, t = s.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Puff; t.fadeIn = 0.08;
    t.color0 = DUST[this.zone]; t.color1 = t.color0; t.alpha0 = 0.4; t.alpha1 = 0;
    t.gravity = -0.3; t.drag = 3.5; t.spin = 0;
    const count = this.n(3);
    for (let i = 0; i < count; i++) {
      t.life = 0.35 + this.rand() * 0.15; t.size0 = 0.22; t.size1 = 0.7; t.rotation = this.rand() * TAU;
      s.emit(x, y + 0.1, z + 0.1, dir * (1.8 + this.rand()), 0.3, carry * 0.7);
    }
  }

  private groundRing(x: number, y: number, z: number, carry: number, color: number, alpha: number): void {
    const g = this.ground, t = g.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Ring; t.fadeIn = 0; t.gravity = 0; t.drag = 0; t.spin = 0;
    t.color0 = color; t.color1 = color; t.alpha0 = alpha; t.alpha1 = 0; t.life = 0.4; t.size0 = 0.6; t.size1 = 3.2;
    g.emit(x, y + 0.04, z, 0, 0, carry * 0.85);
  }

  private streak(cx: number, cy: number, cz: number, flying: boolean): void {
    const g = this.glow, t = g.t;
    const a = this.rand() * TAU;
    const r = 2.6 + this.rand() * 4.5;
    const x = cx + Math.cos(a) * r * 1.2;
    const y = Math.max(0.4, cy + Math.sin(a) * r * 0.75);
    const z = cz - 12 - this.rand() * 26;
    t.mode = Mode.Radial; t.frame = Frame.Streak; t.fadeIn = 0.3;
    t.color0 = flying ? 0xd8ffe6 : 0xffffff; t.color1 = t.color0;
    t.alpha0 = flying ? 0.55 : 0.45; t.alpha1 = 0; t.gravity = 0; t.drag = 0; t.spin = 0;
    t.life = 0.32 + this.rand() * 0.15; t.size0 = 1.6 + this.rand() * 1.6; t.size1 = t.size0 * 1.4;
    g.emit(x, y, z, 0, 0, 30 + this.rand() * 15);
  }

  private whoosh(x: number, y: number, z: number, carry: number): void {
    const g = this.glow, t = g.t;
    t.mode = Mode.Radial; t.frame = Frame.Streak; t.fadeIn = 0.2; t.gravity = 0; t.drag = 0; t.spin = 0;
    t.color0 = 0xffffff; t.color1 = 0xffffff; t.alpha0 = 0.55; t.alpha1 = 0;
    const count = this.n(6);
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? 1 : -1;
      t.life = 0.25 + this.rand() * 0.1; t.size0 = 1.4; t.size1 = 2.2;
      g.emit(x + side * (0.9 + this.rand() * 0.6), y + 0.4 + this.rand() * 1.4, z - 1 - this.rand() * 2, 0, 0, carry * 0.6 + 12);
    }
  }

  private exhaust(x: number, y: number, z: number, carry: number): void {
    const g = this.glow, t = g.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Dot; t.fadeIn = 0;
    t.color0 = 0xfff4c0; t.color1 = 0xff5a1f; t.alpha0 = 0.85; t.alpha1 = 0;
    t.gravity = 1.5; t.drag = 1.5; t.spin = 0;
    t.life = 0.35 + this.rand() * 0.2; t.size0 = 0.42 + this.rand() * 0.2; t.size1 = 0.08;
    const side = this.rand() < 0.5 ? -0.14 : 0.14;
    g.emit(x + side, y + 0.75, z + 0.3, (this.rand() - 0.5) * 0.7, -1.2 - this.rand() * 1.5, carry * 0.55 + this.rand());
  }

  private magnetGlint(state: SimState, hz: number): void {
    const p = state.player;
    const g = this.glow, t = g.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Spark; t.fadeIn = 0.15; t.gravity = 0; t.drag = 0; t.spin = 4;
    t.color0 = 0xffffff; t.color1 = POWERUP_FX_COLOR.magnet; t.alpha0 = 0.9; t.alpha1 = 0;
    // a coin inside the pull radius, if any (scan from a random start, no allocation)
    const ents = state.entities;
    const nEnt = ents.length;
    if (nEnt > 0 && this.rand() < 0.7) {
      const start = Math.floor(this.rand() * nEnt);
      for (let k = 0; k < nEnt; k++) {
        const e = ents[(start + k) % nEnt];
        if (!e.active || e.kind !== 'coin') continue;
        const ds = e.s - p.s;
        if (ds < -1 || ds > MAGNET_RADIUS * 1.6) continue;
        const ez = this.stage.worldZ(e.s);
        t.life = 0.3; t.size0 = 0.4; t.size1 = 0.05; t.rotation = this.rand();
        g.emit(e.x, e.y + PICKUP_HOVER, ez, (p.x - e.x) * 2, (p.y + 1 - e.y - PICKUP_HOVER) * 2, -p.speed + (hz - ez) * 2);
        return;
      }
    }
    // orbiting spark around the hero's chest
    t.mode = Mode.Orbit; t.life = 0.5; t.size0 = 0.22; t.size1 = 0.05; t.spin = 0;
    g.emit(this.rand() * TAU, 0, 0, 7 + this.rand() * 2, 0.75 + this.rand() * 0.25, 0.5 + this.rand() * 1.1);
  }

  private stumbleStars(x: number, y: number, z: number, carry: number): void {
    const g = this.soft, t = g.t; // normal blend: cartoon stars stay truly yellow on a bright road
    t.mode = Mode.Orbit; t.frame = Frame.Star; t.fadeIn = 0.1; t.gravity = 0; t.drag = 0; t.spin = 2;
    t.color0 = 0xffe24a; t.color1 = 0xffb020; t.alpha0 = 1; t.alpha1 = 0.2;
    const count = 5;
    for (let i = 0; i < count; i++) {
      t.life = 0.9; t.size0 = 0.34; t.size1 = 0.26; t.rotation = this.rand() * TAU;
      g.emit((i / count) * TAU, 0, 0, 6.5, 0.48, 2.05);
    }
    this.sparks(x, y + 1.0, z - 0.3, carry * 0.7, 0xfff0b0, 6);
    this.dust(x, y, z, carry, 3, 0.7);
  }

  private sparks(x: number, y: number, z: number, carry: number, color: number, base: number): void {
    const g = this.glow, t = g.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Dot; t.fadeIn = 0; t.gravity = 12; t.drag = 1.2; t.spin = 0;
    t.color0 = 0xffffff; t.color1 = color; t.alpha0 = 1; t.alpha1 = 0;
    const count = this.n(base);
    for (let i = 0; i < count; i++) {
      const a = this.rand() * TAU;
      const sp = 3 + this.rand() * 5;
      t.life = 0.35 + this.rand() * 0.35; t.size0 = 0.12 + this.rand() * 0.1; t.size1 = 0.02;
      g.emit(x, y, z, Math.cos(a) * sp, 2 + this.rand() * 5, Math.sin(a) * sp + carry);
    }
  }

  private shards(x: number, y: number, z: number, carry: number, color: number): void {
    const g = this.glow, t = g.t;
    t.mode = Mode.Ballistic; t.frame = Frame.Shard; t.fadeIn = 0; t.gravity = 9; t.drag = 1;
    t.color0 = 0xeaffff; t.color1 = color; t.alpha0 = 1; t.alpha1 = 0;
    const count = this.n(18);
    for (let i = 0; i < count; i++) {
      const a = this.rand() * TAU, b = (this.rand() - 0.3) * Math.PI * 0.8;
      const sp = 4 + this.rand() * 5;
      t.life = 0.55 + this.rand() * 0.3; t.size0 = 0.3 + this.rand() * 0.25; t.size1 = 0.08;
      t.rotation = this.rand() * TAU; t.spin = (this.rand() - 0.5) * 18;
      g.emit(x, y, z, Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp + 2, Math.sin(a) * Math.cos(b) * sp + carry);
    }
    t.frame = Frame.Ring; t.life = 0.35; t.size0 = 0.8; t.size1 = 4; t.spin = 0; t.gravity = 0; t.drag = 0;
    t.color0 = 0xffffff; t.alpha0 = 0.9;
    g.emit(x, y, z, 0, 0, carry);
  }

  private crash(x: number, y: number, z: number): void {
    // chunky debris that bounces on the road
    const s = this.soft, t = s.t;
    t.mode = Mode.Bounce; t.frame = Frame.Shard; t.fadeIn = 0; t.gravity = 16; t.drag = 0.6; t.alpha0 = 1; t.alpha1 = 0;
    t.floor = y + 0.05;
    const count = this.n(20);
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (this.rand() - 0.5) * Math.PI * 1.4; // mostly back toward camera / sideways
      const sp = 2.5 + this.rand() * 5;
      t.color0 = DEBRIS[Math.floor(this.rand() * DEBRIS.length)]; t.color1 = t.color0;
      t.life = 0.9 + this.rand() * 0.6; t.size0 = 0.18 + this.rand() * 0.28; t.size1 = t.size0 * 0.8;
      t.rotation = this.rand() * TAU; t.spin = (this.rand() - 0.5) * 16;
      s.emit(x + (this.rand() - 0.5) * 0.6, y + 0.6 + this.rand() * 1.2, z - 0.6, Math.cos(a) * sp * 0.8, 3 + this.rand() * 5, -Math.sin(a) * sp * 0.6);
    }
    this.dust(x, y, z - 0.4, 0, 12, 1.5);
    this.sparks(x, y + 1.1, z - 0.6, 0, 0xffb040, 26);
    // impact flash at the contact point
    const g = this.glow, f = g.t;
    f.mode = Mode.Ballistic; f.frame = Frame.Dot; f.gravity = 0; f.drag = 0; f.spin = 0; f.fadeIn = 0;
    f.color0 = 0xffffff; f.color1 = 0xffb060; f.alpha0 = 0.55; f.alpha1 = 0; f.life = 0.16; f.size0 = 1.2; f.size1 = 2;
    g.emit(x, y + 1.1, z - 0.7, 0, 0, 0);
    f.frame = Frame.Ring; f.life = 0.3; f.size0 = 0.8; f.size1 = 3.2; f.alpha0 = 0.4; f.color1 = 0xffd090;
    g.emit(x, y + 1.0, z - 0.7, 0, 0, 0);
    this.groundRing(x, y, z, 0, DUST[this.zone], 0.6);
  }

  private speedLinesOff(): void {
    this.streakAcc = 0;
    this.exhaustAcc = 0;
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
}
