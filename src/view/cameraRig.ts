// Chase camera with three modes:
//   'run'  behind/above the hero looking down the street: lagged lateral follow with a little bank
//          into lane changes, calm vertical follow (holds through jumps, rises onto roofs and in
//          boost flight), FOV that widens with speed, pulled-back framing while flying, and
//          aspect-aware framing so all three lanes fit on portrait phones.
//   'menu' a slow idle 3/4 orbit of the hero with the street behind him.
//   'over' a short impact push-in toward the hero.
// Mode changes blend from the current pose. All smoothing is exponential in dt (frame-rate
// independent); nothing allocates per frame. `snap()` resets every bit of state.
//
// Until `setMode()` is first called, the mode is inferred: 'over' when the hero is dead, 'menu'
// when the hero has not moved for a moment while time passes, 'run' otherwise.
import { LANE_WIDTH, SPEED_MAX, SPEED_START } from '../sim/config';
import type { PlayerState } from '../sim/types';
import type { Stage } from './stage';

export type CameraMode = 'menu' | 'run' | 'over';

/** Half-width (m) that must stay in view at the hero's distance: outer lane centres + body + margin. */
const FRAME_HALF_WIDTH = LANE_WIDTH + 1.45;
const BLEND_TIME: Record<CameraMode, number> = { run: 1.1, menu: 0.9, over: 0.5 };

const smooth01 = (v: number) => {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  return x * x * (3 - 2 * x);
};
function shortLandscapeOver(stage: Stage): boolean {
  return stage.aspect >= 1 && typeof window !== 'undefined' && window.innerHeight <= 520;
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const D2R = Math.PI / 180;

/** Smooth 1D value noise in [-1, 1] (allocation-free). */
function hash1(n: number, seed: number): number {
  const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i, seed);
  return a + (hash1(i + 1, seed) - a) * u;
}

interface Pose {
  px: number; py: number; pz: number;
  lx: number; ly: number; lz: number;
  fov: number;
  roll: number;
}

function newPose(): Pose {
  return { px: 0, py: 0, pz: 0, lx: 0, ly: 0, lz: -1, fov: 58, roll: 0 };
}

export class CameraRig {
  private readonly stage: Stage;

  private _mode: CameraMode = 'run';
  private autoMode = true;
  private blendT = 1;
  private blendDur = 1;
  private readonly from = newPose();
  private readonly want = newPose();
  private readonly out = newPose();

  // run-follow state
  private x = 0;
  private lookX = 0;
  private support = 0;
  private roll = 0;
  private speedN = 0;
  private boost = 0;
  private fovKick = 0;
  private trauma = 0;
  private time = 0;
  private menuTime = 0;
  private overTime = 0;
  private lastS = 0;
  private idle = 0;
  private wasFlying = false;
  /** Hero position (world x, z) at the last update, and at the moment the last mode change began. */
  private heroX = 0;
  private heroZ = 0;
  private fromHeroX = 0;
  private fromHeroZ = 0;

  private readonly look = { x: 0, y: 0, z: 0 };
  private readonly up = { x: 0, y: 1, z: 0 };

  constructor(stage: Stage) {
    this.stage = stage;
    stage.onRebase((dz) => {
      this.from.pz += dz; this.from.lz += dz;
      this.out.pz += dz; this.out.lz += dz;
      this.heroZ += dz; this.fromHeroZ += dz;
    });
  }

  get mode(): CameraMode {
    return this._mode;
  }

  /** Switch framing; blends from the current pose. The first call turns mode inference off. */
  setMode(mode: CameraMode): void {
    this.autoMode = false;
    this.enterMode(mode);
  }

  /** Jump straight to the target (new run, teleports): resets all smoothing, shake and blends. */
  snap(p: PlayerState): void {
    if (this.autoMode && this._mode !== 'menu') this._mode = 'run';
    this.x = this.followX(p.x);
    this.lookX = p.x * this.lookFollow();
    this.support = p.y;
    this.roll = 0;
    this.speedN = clamp01((p.speed - SPEED_START) / (SPEED_MAX - SPEED_START));
    this.boost = p.action === 'fly' ? 1 : 0;
    this.fovKick = 0;
    this.trauma = 0;
    this.overTime = 0;
    this.idle = 0;
    this.wasFlying = p.action === 'fly';
    this.lastS = p.s;
    this.blendT = this.blendDur = 1;
    this.update(p, 0);
  }

  /** Add camera shake; `amount` ~0.3 small bump, 1 = crash. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Momentary FOV punch in degrees (e.g. 6 on a boost pickup); decays by itself. */
  kick(degrees: number): void {
    this.fovKick = Math.max(-12, Math.min(14, this.fovKick + degrees));
  }

  update(p: PlayerState, dt: number): void {
    this.time += dt;
    const stage = this.stage;
    const hz = stage.worldZ(p.s);
    stage.focus.x = p.x;
    stage.focus.y = p.y;
    stage.focus.z = hz;
    this.heroX = p.x;
    this.heroZ = hz;

    if (this.autoMode) this.inferMode(p, dt);
    else if (p.action === 'dead' && this._mode === 'run') this.enterMode('over');

    // ---- shared follow state (kept up to date in every mode so returning to 'run' is smooth)
    this.speedN += (clamp01((p.speed - SPEED_START) / (SPEED_MAX - SPEED_START)) - this.speedN) * damp(1.5, dt);
    this.boost += ((p.action === 'fly' ? 1 : 0) - this.boost) * damp(2.2, dt);
    this.fovKick *= Math.exp(-dt * 3);
    if (p.action === 'fly' && !this.wasFlying && dt > 0) this.kick(7); // take-off punch
    this.wasFlying = p.action === 'fly';
    this.x += (this.followX(p.x) - this.x) * damp(6, dt);
    this.lookX += (p.x * this.lookFollow() - this.lookX) * damp(9, dt);
    this.roll += (p.lean * 2.6 * D2R - this.roll) * damp(8, dt);

    // Vertical: hold through jumps, follow down when falling below the support, rise on roofs/flight.
    let target = this.support;
    let rate = 4;
    if (p.action === 'fly') {
      target = p.y * 0.8;
      rate = 2.2;
    } else if (p.grounded || p.action === 'dead') {
      target = p.y;
      rate = p.y > this.support ? 3.5 : 6;
    } else if (p.y < this.support - 0.25) {
      target = p.y;
      rate = 5;
    }
    this.support += (target - this.support) * damp(rate, dt);

    // ---- desired pose for the active mode
    if (this._mode === 'run') this.runPose(p, hz, this.want);
    else if (this._mode === 'menu') this.menuPose(p, hz, dt, this.want);
    else this.overPose(p, hz, dt, this.want);

    // ---- blend from the pose we had when the mode changed
    let pose = this.want;
    if (this.blendT < this.blendDur) {
      this.blendT += dt;
      const k = clamp01(this.blendT / this.blendDur);
      const e = this._mode === 'over' ? 1 - Math.pow(1 - k, 3) : k * k * (3 - 2 * k);
      // The pose we blend from is kept relative to the hero, so it travels with him (a swoop from the
      // menu framing into the chase view while he is already running).
      const a = this.from, b = this.want, o = this.out;
      const mx = this.heroX - this.fromHeroX, mz = this.heroZ - this.fromHeroZ;
      // Camera position: orbit around the hero (angle + radius) instead of cutting straight through
      // him when the framings are on opposite sides (menu front view -> chase view from behind).
      const fx = a.px - this.fromHeroX, fz = a.pz - this.fromHeroZ;
      const tx = b.px - this.heroX, tz = b.pz - this.heroZ;
      const fr = Math.hypot(fx, fz), tr = Math.hypot(tx, tz);
      if (fr > 0.5 && tr > 0.5) {
        const fa = Math.atan2(fx, fz);
        let da = Math.atan2(tx, tz) - fa;
        da -= Math.PI * 2 * Math.floor((da + Math.PI) / (Math.PI * 2));
        const ang = fa + da * e;
        const r = lerp(fr, tr, e);
        o.px = this.heroX + Math.sin(ang) * r;
        o.pz = this.heroZ + Math.cos(ang) * r;
      } else {
        o.px = lerp(a.px + mx, b.px, e);
        o.pz = lerp(a.pz + mz, b.pz, e);
      }
      o.py = lerp(a.py, b.py, e);
      o.lx = lerp(a.lx + mx, b.lx, e); o.ly = lerp(a.ly, b.ly, e); o.lz = lerp(a.lz + mz, b.lz, e);
      o.fov = lerp(a.fov, b.fov, e); o.roll = lerp(a.roll, b.roll, e);
      pose = o;
    }

    // ---- shake: decaying trauma^2 with smooth noise, translation + roll
    this.trauma = Math.max(0, this.trauma - dt * 1.3);
    const s = this.trauma * this.trauma;
    const nt = this.time * 16;
    const sx = s * 0.4 * noise1(nt, 1);
    const sy = s * 0.3 * noise1(nt, 2);
    const sr = s * 3.5 * D2R * noise1(nt * 0.8, 3);

    const cam = stage.camera;
    cam.fov = pose.fov;
    cam.position.set(pose.px + sx, pose.py + sy, pose.pz);
    this.look.x = pose.lx + sx * 0.4;
    this.look.y = pose.ly + sy * 0.4;
    this.look.z = pose.lz;
    const r = pose.roll + sr;
    this.up.x = Math.sin(r);
    this.up.y = Math.cos(r);
    this.up.z = 0;
    cam.lookAt(this.look, this.up);

    this.writePose(pose, this.out);
  }

  // ------------------------------------------------------------------ poses

  /** 0 for landscape (>= 1.25), 1 for tall portrait phones (<= 0.5). */
  private portrait(): number {
    return clamp01((1.25 - this.stage.aspect) / (1.25 - 0.5));
  }

  private followX(px: number): number {
    return px * lerp(0.72, 0.35, this.portrait());
  }

  private lookFollow(): number {
    return lerp(0.55, 0.3, this.portrait());
  }

  private runPose(p: PlayerState, hz: number, o: Pose): void {
    const pt = this.portrait();
    const aspect = this.stage.aspect;
    let fov = lerp(56, 66, pt) + this.speedN * 7 + this.boost * 6 + this.fovKick;
    let back = lerp(6.4, 8.2, pt) + this.boost * 1.5;
    const height = lerp(3.4, 4.3, pt) + this.boost * 0.8;

    // Aspect-aware: widen FOV (up to a cap), then pull back, until the lanes fit at the hero.
    const dist = Math.hypot(back, height - 1);
    const needTan = FRAME_HALF_WIDTH / (dist * aspect);
    const needFov = (2 * Math.atan(needTan)) / D2R;
    const maxFov = 76 + this.boost * 6;
    if (needFov > fov) fov = Math.min(maxFov, needFov);
    const haveTan = Math.tan((fov / 2) * D2R) * aspect;
    if (haveTan * dist < FRAME_HALF_WIDTH) back = Math.sqrt(Math.max(0, (FRAME_HALF_WIDTH / haveTan) ** 2 - (height - 1) ** 2));

    const sup = this.support;
    o.px = this.x;
    o.py = sup + height;
    o.pz = hz + back;
    o.lx = this.lookX;
    o.ly = sup + lerp(1.15, 2.0, pt) + Math.max(0, p.y - sup) * 0.3 - this.boost * 0.6;
    o.lz = hz - lerp(10, 15, pt) - this.boost * 4;
    o.fov = fov;
    o.roll = this.roll;
  }

  private menuPose(p: PlayerState, hz: number, dt: number, o: Pose): void {
    this.menuTime += dt;
    const pt = this.portrait();
    // Front-right 3/4 view, slowly swaying, the street running away behind the hero.
    const th = 2.45 + Math.sin(this.menuTime * 0.16) * 0.32;
    const R = lerp(5.4, 8.8, pt);
    o.px = p.x + Math.sin(th) * R;
    o.py = p.y + lerp(1.7, 2.3, pt) + Math.sin(this.menuTime * 0.23) * 0.15;
    o.pz = hz + Math.cos(th) * R;
    // Aim past the hero and off to the side, so he stands low and right of centre on landscape
    // (clear of the title / play button) and low and centred on portrait.
    const fx = -Math.sin(th), fz = -Math.cos(th); // camera -> hero, horizontal
    // The DOM menu is a centred column on normal landscape screens (hero pushed well to the right,
    // clear of the Play button) and a left/right split on short landscape phones (hero between).
    const shortLandscape = this.stage.aspect >= 1 && typeof window !== 'undefined' && window.innerHeight <= 520;
    const off = lerp(shortLandscape ? 1.5 : 3.1, 0, pt);
    o.lx = p.x + fx * 2 - Math.cos(th) * off;
    o.ly = p.y + lerp(shortLandscape ? 1.9 : 1.45, 2.4, pt);
    o.lz = hz + fz * 2 + Math.sin(th) * off;
    o.fov = lerp(48, 60, pt);
    o.roll = 0;
  }

  private overPose(p: PlayerState, hz: number, dt: number, o: Pose): void {
    this.overTime += dt;
    const pt = this.portrait();
    // A short push-in from the run framing (higher and closer), then a slow sideways drift.
    const drift = Math.min(this.overTime, 6) * 0.06;
    // Frame the spot where the hero ends up (he falls back toward the camera). Once the game-over
    // panel arrives the hero slides out from behind it: left of the panel on landscape screens,
    // above it on portrait phones.
    const slide = smooth01((this.overTime - 0.3) / 0.6);
    o.px = p.x * 0.6 + 0.6 + drift;
    o.py = p.y + lerp(3.2, 3.9, pt);
    o.pz = hz + lerp(5.6, 6.8, pt);
    o.lx = p.x + slide * lerp(shortLandscapeOver(this.stage) ? 1.9 : 2.3, 0, pt);
    o.ly = p.y - 0.2 + slide * pt * 1.6;
    o.lz = hz + 1.0;
    o.fov = lerp(50, 64, pt);
    o.roll = -1.5 * D2R;
  }

  // ------------------------------------------------------------------ modes

  private enterMode(mode: CameraMode): void {
    if (mode === this._mode) return;
    // Start the blend from what is on screen now (including any blend in progress).
    this.from.px = this.out.px; this.from.py = this.out.py; this.from.pz = this.out.pz;
    this.from.lx = this.out.lx; this.from.ly = this.out.ly; this.from.lz = this.out.lz;
    this.from.fov = this.out.fov; this.from.roll = this.out.roll;
    this.fromHeroX = this.heroX; this.fromHeroZ = this.heroZ;
    this._mode = mode;
    this.blendT = 0;
    this.blendDur = BLEND_TIME[mode];
    if (mode === 'menu') this.menuTime = 0;
    if (mode === 'over') this.overTime = 0;
  }

  private inferMode(p: PlayerState, dt: number): void {
    if (p.action === 'dead') {
      if (this._mode === 'run') this.enterMode('over');
      this.lastS = p.s;
      return;
    }
    if (dt > 0) {
      const moved = Math.abs(p.s - this.lastS) > 1e-6;
      this.idle = moved ? 0 : this.idle + dt;
      if (this._mode !== 'menu' && this.idle > 0.3) this.enterMode('menu');
      else if (moved && this._mode !== 'run') this.enterMode('run');
    }
    this.lastS = p.s;
  }

  /** Remember the pose actually shown, so the next mode change can blend from it. */
  private writePose(src: Pose, dst: Pose): void {
    if (src === dst) return;
    dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
    dst.lx = src.lx; dst.ly = src.ly; dst.lz = src.lz;
    dst.fov = src.fov; dst.roll = src.roll;
  }
}
