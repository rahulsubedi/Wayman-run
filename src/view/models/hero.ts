// HeroRig: Wayman's articulated hierarchy + procedural animation driven only by PlayerState.
//
// Pose system: every action has a pose function writing joint values into its own Float64Array.
// Each action's weight eases toward 1 (current) or 0 (others) with time-based smoothing, and the
// final pose is the weighted sum, so transitions never pop and the run cycle never lags. On top
// sit a few stateful secondary motions (landing squash spring, scarf follow-through, satchel lag,
// roll tumble, power-up FX fades). Everything is a function of PlayerState + accumulated dt:
// with dt = 0 (paused) nothing moves. No allocations per frame.
import { Container3D, Mesh3D } from '@pixi/3d';
import { ROLL_TIME, STUMBLE_TIME } from '../../sim/config';
import type { PlayerAction, PlayerState, SimState } from '../../sim/types';
import { glow, vertexColorMaterial } from '../geom/materials';
import { HERO_JOINTS as J, heroGeometry } from './heroGeometry';
import { fadeVC, fresnelGlow, glowVC } from './kit';

// ---- pose channels -------------------------------------------------------------------------
const P = {
  bodyY: 0,
  bodyZ: 1,
  bodyPitch: 2,
  tumbleY: 3,
  pelvisY: 4,
  pelvisZ: 5,
  pelvisPitch: 6,
  pelvisYaw: 7,
  pelvisRoll: 8,
  spinePitch: 9,
  spineYaw: 10,
  spineRoll: 11,
  headPitch: 12,
  headYaw: 13,
  headRoll: 14,
  shLx: 15,
  shLz: 16,
  shLy: 17,
  elbowL: 18,
  shRx: 19,
  shRz: 20,
  shRy: 21,
  elbowR: 22,
  hipLx: 23,
  hipLz: 24,
  kneeL: 25,
  ankleL: 26,
  hipRx: 27,
  hipRz: 28,
  kneeR: 29,
  ankleR: 30,
  satchel: 31,
  stretch: 32,
  wind: 33,
  COUNT: 34,
} as const;

const ACTIONS: readonly (PlayerAction | 'idle')[] = ['run', 'jump', 'fall', 'roll', 'fly', 'stumble', 'dead', 'idle'];
const A_INDEX: Record<PlayerAction, number> = { run: 0, jump: 1, fall: 2, roll: 3, fly: 4, stumble: 5, dead: 6 };
const IDLE_INDEX = 7;
/** Blend-in rate per action (1/s): fast for snappy actions, slower for flight/death. */
const BLEND_RATE = [12, 22, 9, 24, 7, 18, 14, 7];

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
/** Exponential approach factor for a rate (1/s) over dt: frame-rate independent. */
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const wrapPi = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU);

export class HeroRig {
  readonly node: Container3D;

  // joints
  private body: Container3D;
  private tumble: Container3D;
  private pelvis: Container3D;
  private spine: Container3D;
  private head: Container3D;
  private shL: Container3D;
  private shR: Container3D;
  private elL: Container3D;
  private elR: Container3D;
  private hipL: Container3D;
  private hipR: Container3D;
  private knL: Container3D;
  private knR: Container3D;
  private anL: Container3D;
  private anR: Container3D;
  private scarf: Container3D[] = [];
  private satchel: Container3D;

  // fx
  private shield: Mesh3D;
  private magnetA: Mesh3D;
  private magnetB: Mesh3D;
  private flame: Mesh3D;
  private nozzle: Mesh3D;
  private sparkles: Mesh3D;
  private fxShield = 0;
  private fxMagnet = 0;
  private fxBoost = 0;
  private fxMult = 0;

  // pose state
  private readonly poses: Float64Array[] = ACTIONS.map(() => new Float64Array(P.COUNT));
  private readonly weights = new Float64Array(ACTIONS.length);
  private readonly pose = new Float64Array(P.COUNT);
  private clock = 0;
  private squash = 0;
  private squashV = 0;
  private prevAction: PlayerAction = 'run';
  private prevVy = 0;
  private tumbleAngle = 0;
  private scarfAng = new Float64Array(3);
  private scarfSide = 0;
  private satchelAng = 0;
  private initialised = false;
  private idleMode = false;
  private dive = 0;

  constructor() {
    const g = heroGeometry();
    const mat = vertexColorMaterial({ roughness: 0.72 });
    const mesh = (geometry: typeof g.torso, parent: Container3D, label: string) =>
      new Mesh3D({ geometry, material: mat, parent, label });
    const joint = (parent: Container3D, x: number, y: number, z: number, label: string) =>
      new Container3D({ parent, position: { x, y, z }, label });

    this.node = new Container3D({ label: 'hero' });
    this.body = joint(this.node, 0, 0, 0, 'body');
    this.tumble = joint(this.body, 0, J.pelvisY, 0, 'tumble');
    this.pelvis = joint(this.tumble, 0, 0, 0, 'pelvis');
    mesh(g.pelvis, this.pelvis, 'pelvis');

    // Legs.
    const leg = (s: -1 | 1) => {
      const hip = joint(this.pelvis, s * J.hipX, J.hipY, 0, s < 0 ? 'hipL' : 'hipR');
      mesh(g.thigh, hip, 'thigh');
      const knee = joint(hip, 0, -J.thigh, 0, 'knee');
      mesh(g.shin, knee, 'shin');
      const ankle = joint(knee, 0, -J.shin, 0, 'ankle');
      mesh(g.foot, ankle, 'foot');
      return [hip, knee, ankle] as const;
    };
    [this.hipL, this.knL, this.anL] = leg(-1);
    [this.hipR, this.knR, this.anR] = leg(1);

    // Upper body.
    this.spine = joint(this.pelvis, 0, J.spineY, 0, 'spine');
    mesh(g.torso, this.spine, 'torso');
    this.head = joint(this.spine, 0, J.neckY, 0, 'head');
    this.head.scale.set(1.12, 1.12, 1.12); // chunky stylised head
    mesh(g.head, this.head, 'head');
    const arm = (s: -1 | 1) => {
      const sh = joint(this.spine, s * J.shoulderX, J.shoulderY, 0, s < 0 ? 'shoulderL' : 'shoulderR');
      mesh(g.upperArm, sh, 'upperArm');
      const el = joint(sh, 0, -J.upperArm, 0, 'elbow');
      mesh(s < 0 ? g.foreArmL : g.foreArmR, el, 'foreArm');
      return [sh, el] as const;
    };
    [this.shL, this.elL] = arm(-1);
    [this.shR, this.elR] = arm(1);

    // Scarf tails (chain) and satchel.
    let parent = joint(this.spine, J.scarfAt[0], J.scarfAt[1], J.scarfAt[2], 'scarf0');
    for (let i = 0; i < 3; i++) {
      if (i > 0) parent = joint(parent, 0, -J.scarfSeg, 0, `scarf${i}`);
      mesh(g.scarf[i], parent, 'scarfSeg');
      this.scarf.push(parent);
    }
    this.satchel = joint(this.spine, J.satchelAt[0], J.satchelAt[1], J.satchelAt[2], 'satchel');
    mesh(g.satchel, this.satchel, 'satchel');

    // Boost thruster: glow + flame under the satchel nozzle.
    this.nozzle = new Mesh3D({ geometry: g.nozzleGlow, material: glow(0xffc46a, 3), parent: this.satchel, position: { x: 0, y: -0.375, z: 0.07 }, label: 'nozzle' });
    this.flame = new Mesh3D({ geometry: g.flame, material: fadeVC(), parent: this.satchel, position: { x: 0, y: -0.38, z: 0.07 }, label: 'flame' });
    this.flame.castShadow = false;
    this.nozzle.castShadow = false;

    // Shield bubble, magnet aura, multiplier sparkles: on the root (they do not tumble).
    const shieldMat = fresnelGlow(0x5cc8ff, { faceAlpha: 0.07, power: 2.4, faceGlow: 0.9, rimGlow: 2.6 });
    this.shield = new Mesh3D({ geometry: g.shield, material: shieldMat, parent: this.node, label: 'shield' });
    this.shield.castShadow = false;
    this.magnetA = new Mesh3D({ geometry: g.magnet, material: fadeVC(), parent: this.node, label: 'magnet' });
    this.magnetB = new Mesh3D({ geometry: g.magnet, material: fadeVC(), parent: this.node, label: 'magnet' });
    this.sparkles = new Mesh3D({ geometry: g.sparkles, material: glowVC(2.6), parent: this.node, label: 'sparkles' });
    for (const m of [this.magnetA, this.magnetB, this.sparkles]) m.castShadow = false;
    this.shield.visible = this.magnetA.visible = this.magnetB.visible = this.flame.visible = this.nozzle.visible = this.sparkles.visible = false;
  }

  /** Menu mode: a ready/idle stance instead of the run cycle. Blends in and out. */
  setIdle(on: boolean): void {
    this.idleMode = on;
  }

  /** Forget all pose, spring and power-up state (new run / back to the menu). */
  reset(): void {
    this.initialised = false;
    this.weights.fill(0);
    this.squash = this.squashV = 0;
    this.tumbleAngle = 0;
    this.satchelAng = 0;
    this.scarfAng.fill(0);
    this.scarfSide = 0;
    this.dive = 0;
    this.fxShield = this.fxMagnet = this.fxBoost = this.fxMult = 0;
    this.prevAction = 'run';
    this.prevVy = 0;
    this.node.visible = true;
    this.shield.visible = this.magnetA.visible = this.magnetB.visible = this.flame.visible = this.nozzle.visible = this.sparkles.visible = false;
  }

  update(p: PlayerState, powerups: SimState['powerups'], dt: number): void {
    if (!(dt >= 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    this.node.position.x = p.x;
    this.node.position.y = p.y;

    const ai = this.idleMode ? IDLE_INDEX : (A_INDEX[p.action] ?? 0);
    this.dive += ((p.fastFall && p.action === 'fall' ? 1 : 0) - this.dive) * approach(18, dt);
    if (!this.initialised) {
      this.weights[ai] = 1;
      this.prevAction = p.action;
      this.initialised = true;
    }
    this.clock += dt;

    // Landing impulse: we were airborne and are now on the ground.
    const wasAir = this.prevAction === 'jump' || this.prevAction === 'fall';
    if (wasAir && (p.action === 'run' || p.action === 'roll' || p.action === 'stumble')) {
      this.squashV -= clamp(-this.prevVy, 4, 26) * 0.11;
    }
    if (this.prevAction === 'fly' && p.action !== 'fly') this.squashV -= 1.2;
    this.prevAction = p.action;
    this.prevVy = p.vy;

    // Squash spring (critically-ish damped), sub-stepped for stability.
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 120);
      this.squashV += (-260 * this.squash - 20 * this.squashV) * h;
      this.squash += this.squashV * h;
      left -= h;
    }
    this.squash = clamp(this.squash, -0.35, 0.3);

    // Weights.
    let total = 0;
    for (let i = 0; i < ACTIONS.length; i++) {
      const target = i === ai ? 1 : 0;
      this.weights[i] += (target - this.weights[i]) * approach(BLEND_RATE[ai], dt);
      if (this.weights[i] < 1e-4) this.weights[i] = 0;
      total += this.weights[i];
    }
    if (total <= 0) {
      this.weights[ai] = 1;
      total = 1;
    }

    // Evaluate the poses that have weight and blend.
    const out = this.pose;
    out.fill(0);
    for (let i = 0; i < ACTIONS.length; i++) {
      const w = this.weights[i] / total;
      if (w <= 0) continue;
      const pose = this.poses[i];
      this.evaluate(i, p, pose);
      for (let k = 0; k < P.COUNT; k++) out[k] += pose[k] * w;
    }

    this.applyPose(p, out, dt);
    this.updateFx(p, powerups, out, dt);
  }

  // --------------------------------------------------------------------------------- poses

  private evaluate(i: number, p: PlayerState, o: Float64Array): void {
    switch (i) {
      case 0: return this.poseRun(p, o);
      case 1: return this.poseJump(p, o);
      case 2: return this.poseFall(p, o);
      case 3: return this.poseRoll(p, o);
      case 4: return this.poseFly(p, o);
      case 5: return this.poseStumble(p, o);
      case 6: return this.poseDead(p, o);
      case 7: return this.poseIdle(o);
    }
  }

  private base(o: Float64Array): void {
    o.fill(0);
    o[P.tumbleY] = J.pelvisY;
    o[P.pelvisY] = J.pelvisY;
    o[P.stretch] = 1;
    o[P.shLz] = -0.12;
    o[P.shRz] = 0.12;
    o[P.elbowL] = o[P.elbowR] = 0.3;
  }

  private speedT(p: PlayerState): number {
    return clamp((p.speed - 13) / 17, 0, 1);
  }

  private poseRun(p: PlayerState, o: Float64Array): void {
    this.base(o);
    const ph = p.runPhase;
    const st = this.speedT(p);
    const sL = Math.sin(ph);
    const amp = 0.56 + 0.1 * st;
    // Legs (phase 0 = passing under the hip moving forward, π/2 = reaching forward, π =
    // mid-stance, 3π/2 = toe-off): forward-biased thigh swing, a fast heel-kick knee bend in
    // recovery, slight knee flex in stance; the foot stays level in stance and points its toe
    // down in recovery.
    const leg = (phase: number, hip: number, knee: number, ankle: number) => {
      const s = Math.sin(phase), c = Math.cos(phase);
      const h = 0.2 + amp * s;
      const swing = Math.pow(Math.max(0, Math.cos(phase + 0.3)), 1.4);
      const k = -(0.15 + (1.7 + 0.2 * st) * swing + 0.3 * Math.max(0, s) * (1 - swing) + 0.2 * Math.max(0, -c));
      o[hip] = h;
      o[knee] = k;
      o[ankle] = -(h + k) * (1 - 0.6 * swing) - 0.55 * swing + 0.2 * Math.max(0, s) * (1 - swing);
    };
    leg(ph, P.hipLx, P.kneeL, P.ankleL);
    leg(ph + Math.PI, P.hipRx, P.kneeR, P.ankleR);
    o[P.hipLz] = -0.03;
    o[P.hipRz] = 0.03;
    // Arms counter-swing, elbows bent ~90°, more bend on the forward swing.
    const arm = 0.85 + 0.15 * st;
    o[P.shLx] = -arm * sL + 0.15;
    o[P.shRx] = arm * sL + 0.15;
    o[P.elbowL] = 1.4 + 0.3 * Math.max(0, -sL);
    o[P.elbowR] = 1.4 + 0.3 * Math.max(0, sL);
    o[P.shLz] = -0.18;
    o[P.shRz] = 0.18;
    o[P.shLy] = 0.2;
    o[P.shRy] = -0.2;
    // Body: bob (lowest at mid-stance, up in the flight phase), twist, hip roll, lean.
    o[P.bodyY] = -0.05 * Math.cos(2 * ph) + 0.03;
    o[P.pelvisYaw] = -0.14 * sL;
    o[P.spineYaw] = 0.34 * sL;
    o[P.pelvisRoll] = 0.05 * Math.sin(2 * ph);
    o[P.spineRoll] = -0.035 * Math.sin(2 * ph);
    o[P.pelvisPitch] = -0.08 - 0.06 * st;
    o[P.spinePitch] = -0.16 - 0.16 * st - 0.04 * Math.cos(2 * ph);
    // Head stabilised: cancel torso pitch/twist so the gaze stays down the street.
    o[P.headPitch] = -(o[P.pelvisPitch] + o[P.spinePitch]) * 0.85 + 0.02 * Math.cos(2 * ph);
    o[P.headYaw] = -(o[P.pelvisYaw] + o[P.spineYaw]) * 0.9;
    o[P.headRoll] = -(o[P.pelvisRoll] + o[P.spineRoll]) * 0.8;
    o[P.satchel] = 0.1 * Math.sin(2 * ph - 1.1);
    o[P.stretch] = 1 + 0.03 * Math.sin(2 * ph + 0.6);
    o[P.wind] = 0.45 + 0.55 * st;
  }

  private poseJump(p: PlayerState, o: Float64Array): void {
    this.base(o);
    const t = p.actionTime;
    const push = Math.exp(-t / 0.09); // push-off stretch right after take-off
    const tuck = smooth(t / 0.18);
    o[P.stretch] = 1 + 0.16 * push - 0.04 * tuck;
    // Lead leg tucked high, trailing leg folded behind.
    o[P.hipLx] = 0.3 + 1.0 * tuck;
    o[P.kneeL] = -0.4 - 1.25 * tuck;
    o[P.ankleL] = 0.2;
    o[P.hipRx] = -0.35 + 0.45 * tuck;
    o[P.kneeR] = -0.6 - 0.9 * tuck;
    o[P.ankleR] = -0.4;
    o[P.hipLz] = -0.05;
    o[P.hipRz] = 0.06;
    // Arms swing up and out.
    o[P.shLx] = 1.1 + 1.2 * tuck;
    o[P.shRx] = 0.6 + 1.3 * tuck;
    o[P.shLz] = -0.35 - 0.25 * tuck;
    o[P.shRz] = 0.35 + 0.25 * tuck;
    o[P.elbowL] = 0.9 - 0.4 * tuck;
    o[P.elbowR] = 0.9 - 0.3 * tuck;
    o[P.pelvisPitch] = -0.08 + 0.1 * tuck;
    o[P.spinePitch] = -0.15 - 0.05 * tuck;
    o[P.headPitch] = 0.18;
    o[P.satchel] = 0.12;
    o[P.wind] = 0.6;
  }

  private poseFall(p: PlayerState, o: Float64Array): void {
    this.base(o);
    const t = p.actionTime;
    const fast = Math.max(clamp((-p.vy - 14) / 10, 0, 1), this.dive); // fast-fall (roll pressed in the air)
    const reach = smooth(t / 0.25);
    const wob = Math.sin(this.clock * 7) * 0.08;
    // Legs extend to reach for the ground, slightly staggered.
    o[P.hipLx] = 0.55 - 0.15 * reach + 0.8 * fast;
    o[P.kneeL] = -0.75 + 0.25 * reach - 1.0 * fast;
    o[P.hipRx] = -0.05 + 0.1 * reach + 0.6 * fast;
    o[P.kneeR] = -0.9 + 0.3 * reach - 0.9 * fast;
    o[P.ankleL] = 0.1;
    o[P.ankleR] = -0.1;
    // Arms out for balance.
    o[P.shLx] = 0.7 + wob - 0.5 * fast;
    o[P.shRx] = 0.5 - wob - 0.5 * fast;
    o[P.shLz] = -1.15 + wob + 0.6 * fast;
    o[P.shRz] = 1.15 + wob - 0.6 * fast;
    o[P.elbowL] = 0.45;
    o[P.elbowR] = 0.45;
    o[P.spinePitch] = -0.05 - 0.4 * fast;
    o[P.pelvisPitch] = 0.04;
    o[P.headPitch] = 0.05 + 0.3 * fast;
    o[P.stretch] = 1.03 + 0.05 * fast + 0.07 * this.dive;
    // Dive: pitched forward, head tucked between the arms, legs trailing.
    o[P.bodyPitch] = -0.28 * this.dive;
    o[P.pelvisPitch] += -0.25 * this.dive;
    o[P.shLx] += 1.2 * this.dive;
    o[P.shRx] += 1.2 * this.dive;
    o[P.satchel] = -0.25 - 0.3 * this.dive;
    o[P.wind] = 0.7 + 0.3 * fast + 0.5 * this.dive;
  }

  private poseRoll(_p: PlayerState, o: Float64Array): void {
    this.base(o);
    // Tight ball around a pivot ~0.4 m up (the 0.8 m roll collider).
    o[P.tumbleY] = 0.42;
    o[P.pelvisY] = 0.42;
    o[P.pelvisZ] = 0.06;
    o[P.pelvisPitch] = -0.55;
    o[P.spinePitch] = -0.85;
    o[P.headPitch] = -0.35;
    o[P.hipLx] = 2.35;
    o[P.hipRx] = 2.2;
    o[P.kneeL] = -2.35;
    o[P.kneeR] = -2.4;
    o[P.ankleL] = 0.4;
    o[P.ankleR] = 0.3;
    o[P.hipLz] = -0.12;
    o[P.hipRz] = 0.12;
    o[P.shLx] = 1.15;
    o[P.shRx] = 1.15;
    o[P.shLz] = 0.15;
    o[P.shRz] = -0.15;
    o[P.elbowL] = 1.7;
    o[P.elbowR] = 1.7;
    o[P.stretch] = 0.95;
    o[P.satchel] = 0.1;
    o[P.wind] = 0.5;
  }

  private poseFly(_p: PlayerState, o: Float64Array): void {
    this.base(o);
    const t = this.clock;
    // Horizontal glide around the hips, one fist forward, scarf streaming.
    o[P.bodyY] = 0.08 * Math.sin(t * 2.3);
    o[P.pelvisPitch] = -1.32 + 0.04 * Math.sin(t * 1.7);
    o[P.pelvisRoll] = 0.1 * Math.sin(t * 1.3);
    o[P.spinePitch] = -0.08;
    o[P.headPitch] = 1.05;
    o[P.shRx] = 2.95;
    o[P.shRz] = 0.1;
    o[P.elbowR] = 0.08;
    o[P.shLx] = -0.25;
    o[P.shLz] = -0.3;
    o[P.elbowL] = 0.35;
    o[P.hipLx] = -0.05 + 0.06 * Math.sin(t * 2.1);
    o[P.hipRx] = 0.1 + 0.06 * Math.sin(t * 2.1 + 1.5);
    o[P.kneeL] = -0.15;
    o[P.kneeR] = -0.65;
    o[P.ankleL] = -0.7;
    o[P.ankleR] = -0.6;
    o[P.hipLz] = -0.07;
    o[P.hipRz] = 0.05;
    o[P.satchel] = 0;
    o[P.wind] = 1.6;
  }

  private poseStumble(p: PlayerState, o: Float64Array): void {
    this.poseRun(p, o);
    const t = p.actionTime;
    const e = Math.sin(Math.PI * clamp(t / STUMBLE_TIME, 0, 1)) * (1 - 0.5 * clamp(t / STUMBLE_TIME, 0, 1));
    const f = this.clock;
    o[P.bodyY] += -0.1 * e;
    o[P.spinePitch] += -0.5 * e + 0.08 * Math.sin(f * 13) * e;
    o[P.pelvisRoll] += 0.18 * Math.sin(f * 11) * e;
    o[P.spineRoll] += -0.15 * Math.sin(f * 9) * e;
    o[P.headPitch] += 0.35 * e;
    o[P.headRoll] += 0.25 * Math.sin(f * 12) * e;
    // Windmilling arms.
    o[P.shLx] += (1.4 + 1.5 * Math.sin(f * 15)) * e;
    o[P.shRx] += (1.4 + 1.5 * Math.sin(f * 15 + 2.4)) * e;
    o[P.shLz] += (-0.7 - 0.5 * Math.sin(f * 10)) * e;
    o[P.shRz] += (0.7 + 0.5 * Math.sin(f * 10 + 1)) * e;
    o[P.elbowL] += -0.9 * e;
    o[P.elbowR] += -0.9 * e;
    // Stuttering legs.
    o[P.kneeL] += -0.3 * e;
    o[P.kneeR] += -0.3 * e;
    o[P.hipLz] += -0.1 * e;
    o[P.hipRz] += 0.1 * e;
  }

  /** Menu "ready" stance: breathing, weight shift, glances at the camera, now and then a wave. */
  private poseIdle(o: Float64Array): void {
    this.base(o);
    const t = this.clock;
    const breath = Math.sin(t * 2.1);
    const shift = Math.sin(t * 0.9);
    // Hop on the toes every ~3.2 s (a little "ready to go" bounce).
    const hopPh = (t % 3.2) / 3.2;
    const hop = hopPh < 0.2 ? Math.sin((hopPh / 0.2) * Math.PI) : 0;
    o[P.bodyY] = 0.012 * breath + 0.1 * hop;
    o[P.stretch] = 1 + 0.012 * breath + 0.03 * hop;
    o[P.pelvisRoll] = 0.05 * shift;
    o[P.spineRoll] = -0.04 * shift;
    o[P.pelvisPitch] = -0.1;
    o[P.spinePitch] = -0.12 + 0.015 * breath;
    // Look around: toward the camera, down the street, back.
    o[P.headYaw] = 0.5 * Math.sin(t * 0.55) + 0.12 * Math.sin(t * 1.7);
    o[P.headPitch] = 0.1 + 0.06 * Math.sin(t * 0.8 + 1) - 0.04 * hop;
    o[P.headRoll] = 0.06 * Math.sin(t * 0.55);
    // Knees soft, feet apart, a slow weight shift.
    o[P.hipLx] = 0.14 + 0.05 * shift + 0.35 * hop;
    o[P.hipRx] = 0.06 - 0.05 * shift + 0.35 * hop;
    o[P.kneeL] = -0.3 - 0.06 * shift - 0.5 * hop;
    o[P.kneeR] = -0.22 + 0.06 * shift - 0.5 * hop;
    o[P.ankleL] = 0.1 + 0.2 * hop;
    o[P.ankleR] = 0.1 + 0.2 * hop;
    o[P.hipLz] = -0.07;
    o[P.hipRz] = 0.07;
    // Left hand on the satchel strap, right arm swings loosely and waves every ~7 s.
    o[P.shLx] = 0.5;
    o[P.shLz] = -0.1;
    o[P.elbowL] = 1.7;
    const wavePh = ((t + 2.5) % 7) / 7;
    const wave = smooth(wavePh / 0.06) * (1 - smooth((wavePh - 0.2) / 0.06));
    o[P.shRx] = 0.1 + 0.04 * breath + (-0.3) * wave;
    o[P.shRz] = 0.14 + 2.2 * wave;
    o[P.shRy] = 0;
    o[P.elbowR] = 0.35 + 0.15 * breath + wave * (0.5 + 0.55 * Math.sin(t * 11));
    o[P.satchel] = 0.04 * breath + 0.08 * hop;
    o[P.wind] = 0.12;
  }

  private poseDead(p: PlayerState, o: Float64Array): void {
    this.base(o);
    const t = p.actionTime;
    // Impact recoil (0..0.12), fall back (..0.55), small bounce, settle. Never loops.
    const recoil = smooth(t / 0.12);
    const fallT = clamp((t - 0.08) / 0.45, 0, 1);
    const fall = fallT * fallT; // accelerating fall
    const bounce = t > 0.53 ? Math.exp(-(t - 0.53) * 7) * Math.sin((t - 0.53) * 18) * 0.12 : 0;
    const pitch = 0.3 * recoil + (1.42 - 0.3) * fall - bounce;
    o[P.bodyPitch] = pitch;
    o[P.bodyZ] = 0.15 * recoil + 0.85 * (1 - Math.pow(1 - clamp(t / 0.7, 0, 1), 2));
    o[P.bodyY] = 0.3 * Math.sin(clamp(pitch, 0, 1.5)) * (fall);
    const settle = smooth((t - 0.45) / 0.4);
    o[P.spinePitch] = 0.35 * recoil - 0.25 * settle;
    o[P.headPitch] = 0.5 * recoil - 0.3 * settle;
    o[P.headYaw] = 0.45 * settle;
    o[P.headRoll] = 0.2 * settle;
    // Arms flung forward on impact, then splayed out on the ground.
    o[P.shLx] = 1.6 * recoil * (1 - settle) + 0.6 * settle;
    o[P.shRx] = 1.9 * recoil * (1 - settle) + 1.0 * settle;
    o[P.shLz] = -0.4 - 0.9 * settle;
    o[P.shRz] = 0.4 + 1.1 * settle;
    o[P.elbowL] = 0.5 + 0.4 * settle;
    o[P.elbowR] = 0.4 + 0.7 * settle;
    // Legs: one knee up, one flat.
    o[P.hipLx] = 0.5 * recoil + 0.4 * settle;
    o[P.kneeL] = -0.3 - 0.9 * settle;
    o[P.hipRx] = 0.2 * recoil;
    o[P.kneeR] = -0.2 - 0.1 * settle;
    o[P.ankleL] = 0.3 * settle;
    o[P.ankleR] = -0.3 * settle;
    o[P.hipLz] = -0.12 * settle;
    o[P.hipRz] = 0.2 * settle;
    o[P.stretch] = 1;
    o[P.satchel] = -0.3 * recoil * (1 - settle);
    o[P.wind] = 0.2 * (1 - settle);
  }

  // ------------------------------------------------------------------------------ apply

  private applyPose(p: PlayerState, o: Float64Array, dt: number): void {
    const wDead = this.weights[6];
    const wFly = this.weights[4];
    const leanAmt = p.lean * (1 - wDead);

    // Squash & stretch around the feet (volume preserving).
    const sy = clamp(o[P.stretch] * (1 + this.squash), 0.6, 1.35);
    const sxz = 1 / Math.sqrt(sy);
    this.body.scale.set(sxz, sy, sxz);
    this.body.position.set(0, o[P.bodyY], o[P.bodyZ]);
    this.body.rotation.x = o[P.bodyPitch];
    this.body.rotation.z = -leanAmt * (0.26 + 0.2 * wFly);
    this.body.rotation.y = -leanAmt * 0.12;

    // Roll tumble: one full forward rotation over the roll; eases home along the short way.
    if (p.action === 'roll') {
      const e = clamp(p.actionTime / ROLL_TIME, 0, 1);
      const eased = e < 1 ? e - Math.sin(TAU * e) * 0.12 : 1;
      this.tumbleAngle = wrapPi(-TAU * eased);
    } else {
      this.tumbleAngle = wrapPi(this.tumbleAngle);
      this.tumbleAngle -= this.tumbleAngle * approach(16, dt);
    }
    this.tumble.position.set(0, o[P.tumbleY], 0);
    this.tumble.rotation.x = this.tumbleAngle;

    this.pelvis.position.set(-leanAmt * 0.04, o[P.pelvisY] - o[P.tumbleY], o[P.pelvisZ]);
    this.pelvis.rotation.set(o[P.pelvisPitch], o[P.pelvisYaw], o[P.pelvisRoll] + leanAmt * 0.06);
    this.spine.rotation.set(o[P.spinePitch], o[P.spineYaw], o[P.spineRoll] + leanAmt * 0.1);
    this.head.rotation.set(o[P.headPitch], o[P.headYaw], o[P.headRoll] + leanAmt * 0.12);

    this.shL.rotation.set(o[P.shLx], o[P.shLy], o[P.shLz] - leanAmt * 0.15);
    this.shR.rotation.set(o[P.shRx], o[P.shRy], o[P.shRz] - leanAmt * 0.15);
    this.elL.rotation.x = o[P.elbowL];
    this.elR.rotation.x = o[P.elbowR];
    this.hipL.rotation.set(o[P.hipLx], 0, o[P.hipLz] - leanAmt * 0.08);
    this.hipR.rotation.set(o[P.hipRx], 0, o[P.hipRz] - leanAmt * 0.08);
    this.knL.rotation.x = o[P.kneeL];
    this.knR.rotation.x = o[P.kneeR];
    this.anL.rotation.x = o[P.ankleL];
    this.anR.rotation.x = o[P.ankleR];

    // Satchel follow-through: swings out when falling, settles back on landing.
    const satTarget = o[P.satchel] - clamp(-p.vy * 0.018, -0.15, 0.4) * (1 - wFly) - 0.6 * this.squashV * 0.05;
    this.satchelAng += (satTarget - this.satchelAng) * approach(14, dt);
    this.satchel.rotation.x = this.satchelAng;

    // Scarf: world-space stream angle from wind (speed, flight, vertical motion) + flutter,
    // converted to local by subtracting the parent pitch; each segment lags the previous.
    const parentPitch = o[P.bodyPitch] + o[P.pelvisPitch] + o[P.spinePitch];
    const wind = o[P.wind];
    const lift = clamp(-p.vy * 0.035, -0.45, 0.7) * (1 - wFly);
    const c = this.clock;
    const flutterAmp = 0.1 + 0.16 * Math.min(1.2, wind);
    for (let i = 0; i < 3; i++) {
      const world = -(0.5 + 0.75 * Math.min(wind, 1.4)) - lift;
      const flutter = Math.sin(c * (10.5 + i * 1.7) - i * 1.1) * flutterAmp * (0.6 + i * 0.35);
      const target = (i === 0 ? world - parentPitch : (world - parentPitch) * 0.08 - 0.05 * i) + flutter;
      const rate = 18 - i * 4.5;
      this.scarfAng[i] += (target - this.scarfAng[i]) * approach(rate, dt);
      this.scarf[i].rotation.x = this.scarfAng[i];
    }
    this.scarfSide += (leanAmt * 0.55 + Math.sin(c * 6.3) * 0.08 * wind - this.scarfSide) * approach(8, dt);
    for (let i = 0; i < 3; i++) this.scarf[i].rotation.z = this.scarfSide * (0.6 + 0.3 * i);
  }

  // -------------------------------------------------------------------------- power-ups

  private updateFx(p: PlayerState, pw: SimState['powerups'], o: Float64Array, dt: number): void {
    const k = approach(9, dt);
    const shieldOn = pw.shield > 0 ? 1 : 0;
    const magnetOn = pw.magnet > 0 ? blink(pw.magnet) : 0;
    const boostOn = pw.boost > 0 || p.action === 'fly' ? (pw.boost > 0 ? blink(pw.boost) : 1) : 0;
    const multOn = pw.multiplier > 0 ? blink(pw.multiplier) : 0;
    this.fxShield += (shieldOn - this.fxShield) * k;
    this.fxMagnet += ((pw.magnet > 0 ? 1 : 0) - this.fxMagnet) * k;
    this.fxBoost += ((pw.boost > 0 || p.action === 'fly' ? 1 : 0) - this.fxBoost) * k;
    this.fxMult += ((pw.multiplier > 0 ? 1 : 0) - this.fxMult) * k;
    const t = this.clock;
    const wRoll = this.weights[3];
    const wFly = this.weights[4];
    const centreY = 0.95 - 0.45 * wRoll + o[P.bodyY];

    // Shield: soft pulsing bubble around the whole body.
    const sh = this.fxShield;
    this.shield.visible = sh > 0.02;
    if (this.shield.visible) {
      const pulse = 1 + 0.035 * Math.sin(t * 5.2);
      const r = (1.05 - 0.3 * wRoll) * sh * pulse;
      this.shield.scale.set(r * (1 + 0.25 * wFly), r * (1.0 - 0.15 * wFly), r * (1 + 0.15 * wFly));
      this.shield.position.set(0, centreY, o[P.bodyZ]);
      this.shield.rotation.y = t * 0.6;
    }

    // Magnet: two dashed rings counter-rotating around the waist, bobbing.
    const mg = this.fxMagnet * magnetOn;
    this.magnetA.visible = this.magnetB.visible = mg > 0.02;
    if (this.magnetA.visible) {
      const s = mg * (1 + 0.06 * Math.sin(t * 9));
      this.magnetA.scale.set(s, s, s);
      this.magnetB.scale.set(s * 0.82, s * 0.82, s * 0.82);
      this.magnetA.position.set(0, centreY - 0.15 + 0.08 * Math.sin(t * 3), 0);
      this.magnetB.position.set(0, centreY + 0.35 + 0.08 * Math.sin(t * 3 + 1.6), 0);
      this.magnetA.rotation.set(0.15 * Math.sin(t * 2), t * 3.2, 0);
      this.magnetB.rotation.set(-0.15 * Math.sin(t * 2), -t * 4.1, 0);
    }

    // Boost: thruster flame + nozzle glow on the satchel (flickering).
    const bo = this.fxBoost * boostOn;
    this.flame.visible = this.nozzle.visible = bo > 0.02;
    if (this.flame.visible) {
      const flick = 1 + 0.18 * Math.sin(t * 41) + 0.1 * Math.sin(t * 67 + 1.3);
      const len = bo * (0.6 + 0.6 * wFly) * flick;
      const wdt = bo * (0.85 + 0.35 * wFly);
      this.flame.scale.set(wdt, len, wdt);
      const g = bo * (0.9 + 0.15 * Math.sin(t * 33));
      this.nozzle.scale.set(g, g, g);
    }

    // Multiplier: purple sparkles orbiting the head.
    const mu = this.fxMult * multOn;
    this.sparkles.visible = mu > 0.02;
    if (this.sparkles.visible) {
      const s = mu * (1 + 0.1 * Math.sin(t * 7));
      this.sparkles.scale.set(s, s, s);
      this.sparkles.position.set(0, centreY + 0.8 - 0.35 * wRoll - 0.5 * wFly, o[P.bodyZ] - 0.3 * wFly);
      this.sparkles.rotation.set(0, t * 2.4, 0.2 * Math.sin(t * 1.5));
    }
  }
}

/** Visibility for a timed power-up: steady, then blinking faster through the last 2 seconds. */
function blink(remaining: number): number {
  if (remaining > 2) return 1;
  const rate = 5 + (2 - remaining) * 6; // blinks per second, accelerating
  return Math.sin(remaining * rate * Math.PI * 2) > -0.35 ? 1 : 0;
}
