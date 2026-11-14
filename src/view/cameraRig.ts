// Chase camera with three modes:
//   'run'  behind/above the hero looking down the street: lagged lateral follow with a little bank
//          into lane changes, calm vertical follow (holds through jumps, rises onto roofs), FOV that
//          widens with speed, and aspect-aware framing (all three lanes fit on portrait phones; past
//          ~2:1 the vertical field narrows so ultrawide screens are not mostly roofs). In boost
//          flight it rises with the hero, stays near the road's centre line and looks down the street.
//   'menu' a sun-lit front-3/4 view of the idle hero (the sun behind the camera, lit facades and sky
//          behind him), composed around the DOM menu per layout, with a slow drift.
//   'over' the ending: crash = a high side-behind view of the knock-back, caught = a high front-side
//          view of the drone swooping onto the hero. The spot is picked once from candidates so no
//          vehicle stands between camera and hero (higher / other side when neighbours are occupied),
//          then the subject slides clear of the game-over panel.
// Mode changes blend from the current pose along an arc around the hero that never leaves the road
// corridor (|x| <= CORRIDOR_X: lamp posts, trees and stalls stand beyond) and lifts over the hero on
// wide swings. A new run starts with a quick swoop from the menu or a crane drop from the game-over
// view (`beginRun`). All smoothing is exponential in dt (frame-rate independent); nothing allocates
// per frame. `snap()` resets every bit of state.
//
// Until `setMode()` is first called, the mode is inferred: 'over' when the hero is dead, 'menu'
// when the hero has not moved for a moment while time passes, 'run' otherwise.
import { LANE_WIDTH, OBSTACLE_DIMS, SPEED_MAX, SPEED_START } from '../sim/config';
import type { Entity, GameOverReason, ObstacleKind, PlayerState } from '../sim/types';
import type { Stage } from './stage';

export type CameraMode = 'menu' | 'run' | 'over';
/** How a new run is entered: 'swoop' from the menu framing, 'crane' (drop from high behind) otherwise. */
export type RunEntry = 'swoop' | 'crane';

/** Half-width (m) that must stay in view at the hero's distance: outer lane centres + body + margin. */
const FRAME_HALF_WIDTH = LANE_WIDTH + 1.45;
/** The camera never leaves |x| <= this (sidewalk props start at |x| ~ 4.6). */
const CORRIDOR_X = 3.9;
/** Mid-swing limit of |x| for wide transition arcs (keeps sidewalk props well out of the frame). */
const SWING_X = 2.4;
/** Run entry swing: max |x| while beside / in front of the hero, and once looking down the street. */
const ENTRY_X_SIDE = 3.5;
const ENTRY_X_BEHIND = 1.9;
/** Camera never goes above this (overhead bunting / gateways hang at y >= 11). */
const CEILING_Y = 10;
const BLEND_TIME: Record<CameraMode, number> = { run: 1.1, menu: 0.9, over: 0.55 };
const ENTRY_TIME = 0.62;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
/** Ease with a soft start and a long settle: most of the move is done by ~55% of the time. */
const swoopEase = (k: number) => {
  const x = clamp01(k);
  return 1 - (1 - x) * (1 - x) * (1 - x) * (1 + 3 * x);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const D2R = Math.PI / 180;

/** Ray o + t*v against the slab [lo, hi]: entry / exit parameter (+-Infinity when parallel). */
function slabIn(o: number, v: number, lo: number, hi: number): number {
  if (Math.abs(v) < 1e-6) return o >= lo && o <= hi ? -Infinity : Infinity;
  return Math.min((lo - o) / v, (hi - o) / v);
}
function slabOut(o: number, v: number, lo: number, hi: number): number {
  if (Math.abs(v) < 1e-6) return o >= lo && o <= hi ? Infinity : -Infinity;
  return Math.max((lo - o) / v, (hi - o) / v);
}

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

/** Ending camera spot (relative to the hero), chosen once per ending. */
interface OverSpot {
  chosen: boolean;
  /** Azimuth around the hero: 0 = straight behind (+z), +90 deg = to his right (+x), 180 = in front. */
  az: number;
  r: number;
  h: number;
  side: 1 | -1;
}

export class CameraRig {
  private readonly stage: Stage;
  private obstacles: (() => readonly Entity[]) | null = null;

  private _mode: CameraMode = 'run';
  private autoMode = true;
  private blendT = 1;
  private blendDur = 1;
  private entry = false;
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
  private overReason: GameOverReason = 'crash';
  private readonly spot: OverSpot = { chosen: false, az: 0, r: 5, h: 4, side: 1 };
  /** Hero position (world x, z) at the last update, and at the moment the last mode change began. */
  private heroX = 0;
  private heroZ = 0;
  private heroY = 0;
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

  /** Side (+1 right / -1 left of the hero) the ending camera stands on; 0 before one is chosen. */
  get overSide(): number {
    return this._mode === 'over' && this.spot.chosen ? this.spot.side : 0;
  }

  /** Track solids (sim entities) the ending camera keeps its line of sight clear of. */
  setObstacles(list: () => readonly Entity[]): void {
    this.obstacles = list;
  }

  /** Switch framing; blends from the current pose. The first call turns mode inference off. */
  setMode(mode: CameraMode): void {
    this.autoMode = false;
    this.enterMode(mode);
  }

  /** Ending framing for `reason` (blends in from the run view). */
  endRun(reason: GameOverReason): void {
    this.overReason = reason;
    this.spot.chosen = false;
    this.setMode('over');
  }

  /**
   * A new run has just been reset to `p`: swoop from the menu framing, or drop in from high behind
   * (after a game over the world has been rebuilt, so blending from the old view would make no sense).
   */
  beginRun(p: PlayerState, entry: RunEntry): void {
    this.autoMode = false;
    this.snap(p);
    if (entry === 'crane' || this._mode !== 'menu') {
      const hz = this.stage.worldZ(p.s);
      const o = this.out;
      o.px = p.x * 0.5; o.py = p.y + 8.5; o.pz = hz + 7.5;
      o.lx = p.x; o.ly = p.y + 0.6; o.lz = hz - 2.5;
      o.fov = 60; o.roll = 0;
      this.apply(o, 0, 0, 0);
    }
    this.enterMode('run');
    this.blendDur = ENTRY_TIME;
    this.entry = true;
  }

  /** Jump straight to the target (new run, teleports): resets all smoothing, shake and blends. */
  snap(p: PlayerState): void {
    if (this.autoMode && this._mode !== 'menu') this._mode = 'run';
    this.x = this.followX(p.x, p.action === 'fly' ? 1 : 0);
    this.lookX = this.lookFollowX(p.x, p.action === 'fly' ? 1 : 0);
    this.support = p.y;
    this.roll = 0;
    this.speedN = clamp01((p.speed - SPEED_START) / (SPEED_MAX - SPEED_START));
    this.boost = p.action === 'fly' ? 1 : 0;
    this.fovKick = 0;
    this.trauma = 0;
    this.overTime = 0;
    this.spot.chosen = false;
    this.idle = 0;
    this.wasFlying = p.action === 'fly';
    this.lastS = p.s;
    this.blendT = this.blendDur = 1;
    this.entry = false;
    this.update(p, 0);
    this.writePose(this.want, this.out);
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
    this.heroY = p.y;

    if (this.autoMode) this.inferMode(p, dt);
    else if (p.action === 'dead' && this._mode === 'run') this.enterMode('over');

    // ---- shared follow state (kept up to date in every mode so returning to 'run' is smooth)
    this.speedN += (clamp01((p.speed - SPEED_START) / (SPEED_MAX - SPEED_START)) - this.speedN) * damp(1.5, dt);
    // Flight weight: 1 while flying, follows the hero down through the boost descent.
    const flying = p.action === 'fly';
    let fw = flying ? 1 : 0;
    if (!flying && !p.grounded && this.boost > 0.02 && p.vy < 0) fw = clamp01((p.y - (p.groundY ?? 0)) / 5) * this.boost;
    this.boost += (fw - this.boost) * damp(flying ? 3.2 : 4, dt);
    this.fovKick *= Math.exp(-dt * 3);
    if (flying && !this.wasFlying && dt > 0) this.kick(4); // take-off punch
    this.wasFlying = flying;
    this.x += (this.followX(p.x, this.boost) - this.x) * damp(6, dt);
    this.lookX += (this.lookFollowX(p.x, this.boost) - this.lookX) * damp(9, dt);
    this.roll += (p.lean * 2.6 * D2R * (1 - 0.6 * this.boost) - this.roll) * damp(8, dt);

    // Vertical: hold through jumps, follow down when falling below the support, rise on roofs/flight.
    let target = this.support;
    let rate = 4;
    if (flying) {
      target = p.y;
      rate = 6;
    } else if (this.boost > 0.05 && !p.grounded) {
      target = p.y; // boost descent
      rate = 7;
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
      const e = this.entry ? swoopEase(k) : this._mode === 'over' ? 1 - Math.pow(1 - k, 3) : k * k * (3 - 2 * k);
      this.blendPose(e, this.out);
      pose = this.out;
    } else {
      this.entry = false;
    }

    // ---- shake: decaying trauma^2 with smooth noise, translation + roll
    this.trauma = Math.max(0, this.trauma - dt * 1.3);
    const s = this.trauma * this.trauma;
    const nt = this.time * 16;
    const sx = s * 0.4 * noise1(nt, 1);
    const sy = s * 0.3 * noise1(nt, 2);
    const sr = s * 3.5 * D2R * noise1(nt * 0.8, 3);

    this.apply(pose, sx, sy, sr);
    this.writePose(pose, this.out);
  }

  /** Put the camera at `pose` (plus shake offsets). */
  private apply(pose: Pose, sx: number, sy: number, sr: number): void {
    const cam = this.stage.camera;
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
  }

  // ------------------------------------------------------------------ blend

  /**
   * Pose between `from` (kept relative to the hero where the change began, so it travels with him)
   * and `want`. The position orbits the hero (angle + radius) instead of cutting through him, stays
   * inside the road corridor, and lifts over him on wide swings (menu front view -> chase view).
   */
  private blendPose(e: number, o: Pose): void {
    const a = this.from, b = this.want;
    const hx = this.heroX, hz = this.heroZ;
    const mx = hx - this.fromHeroX, mz = hz - this.fromHeroZ;
    const fx = a.px - this.fromHeroX, fz = a.pz - this.fromHeroZ;
    const tx = b.px - hx, tz = b.pz - hz;
    const fr = Math.hypot(fx, fz), tr = Math.hypot(tx, tz);
    let swing = 0;
    if (this.entry && fr > 0.5 && tr > 0.5) {
      // Run entry: a quick swing around the running hero (from the menu's front view, or a drop
      // from the high view after a game over) that passes him close and a little above, then pulls
      // back into the chase view. It comes back toward the centre line as it turns to look ahead,
      // so sidewalk props never cross the frame near the lens.
      const fa = Math.atan2(fx, fz);
      let da = Math.atan2(tx, tz) - fa;
      da -= Math.PI * 2 * Math.floor((da + Math.PI) / (Math.PI * 2));
      const ang = fa + da * e;
      const side = Math.abs(Math.sin(ang));
      const behind = Math.cos(ang); // 1 = straight behind
      // |x| allowed: wide while beside / in front of him, narrow once it looks down the street.
      const lim = lerp(ENTRY_X_BEHIND, ENTRY_X_SIDE, smooth01((1 - behind) / 0.6));
      const ends = lerp(Math.abs(a.px + mx), Math.abs(b.px), e);
      const L = Math.max(lim, ends);
      const room = Math.max(0.3, Math.sin(ang) > 0 ? L - hx : L + hx);
      let r = lerp(fr, tr, e);
      if (side * r > room) r = Math.max(1.6, room / Math.max(1e-3, side));
      o.px = hx + Math.sin(ang) * r;
      o.pz = hz + behind * r;
      swing = smooth01((Math.abs(da) / D2R - 40) / 80) * Math.sin(Math.PI * e) * 0.45;
    } else if (fr > 0.5 && tr > 0.5) {
      const fa = Math.atan2(fx, fz);
      let da = Math.atan2(tx, tz) - fa;
      da -= Math.PI * 2 * Math.floor((da + Math.PI) / (Math.PI * 2));
      const ang = fa + da * e;
      let r = lerp(fr, tr, e);
      swing = smooth01((Math.abs(da) / D2R - 40) / 80) * Math.sin(Math.PI * e);
      // Keep |x| inside the corridor, and on wide swings well inside it (props on the sidewalks
      // would cross the frame close to the lens): come in closer to the hero, and higher (below).
      const ends = lerp(Math.max(Math.abs(a.px + mx), SWING_X), Math.max(Math.abs(b.px), SWING_X), e);
      const lim = Math.min(CORRIDOR_X, ends - (ends - SWING_X) * Math.sin(Math.PI * e));
      const sx = Math.sin(ang);
      const room = Math.max(0.3, sx > 0 ? lim - hx : lim + hx);
      if (Math.abs(sx) * r > room) r = Math.max(1.2, room / Math.max(1e-3, Math.abs(sx)));
      o.px = hx + sx * r;
      o.pz = hz + Math.cos(ang) * r;
    } else {
      o.px = lerp(a.px + mx, b.px, e);
      o.pz = lerp(a.pz + mz, b.pz, e);
    }
    const lift = 2.6 * swing;
    o.py = Math.min(CEILING_Y, lerp(a.py, b.py, e) + lift);
    // Look: between the two targets, pulled onto the hero in the middle of a wide swing so he stays
    // near the centre of the frame while the camera travels around him.
    // (Direction blend: the look target is turned toward the hero's chest by weight w.)
    const w = this.entry ? 0.95 * Math.sin(Math.PI * Math.min(1, e * 1.1)) : 0.8 * swing;
    let lx = lerp(a.lx + mx, b.lx, e) - o.px, ly = lerp(a.ly, b.ly, e) - o.py, lz = lerp(a.lz + mz, b.lz, e) - o.pz;
    if (w > 0) {
      const ll = Math.hypot(lx, ly, lz) || 1;
      const cx = hx - o.px, cy = this.heroY + 1.0 - o.py, cz = hz - o.pz;
      const cl = Math.hypot(cx, cy, cz) || 1;
      lx = lerp(lx / ll, cx / cl, w) * 10; ly = lerp(ly / ll, cy / cl, w) * 10; lz = lerp(lz / ll, cz / cl, w) * 10;
    }
    o.lx = o.px + lx; o.ly = o.py + ly; o.lz = o.pz + lz;
    o.fov = lerp(a.fov, b.fov, e); o.roll = lerp(a.roll, b.roll, e);
  }

  // ------------------------------------------------------------------ poses

  /** 0 for landscape (>= 1.25), 1 for tall portrait phones (<= 0.5). */
  private portrait(): number {
    return clamp01((1.25 - this.stage.aspect) / (1.25 - 0.5));
  }

  /** 0 up to ~1.9:1, 1 from ~2.6:1 (ultrawide monitors). */
  private ultrawide(): number {
    return clamp01((this.stage.aspect - 1.9) / (2.6 - 1.9));
  }

  /** Short landscape phones: the DOM menu splits into a left / right layout. */
  private shortLandscape(): boolean {
    return this.stage.aspect >= 1 && typeof window !== 'undefined' && window.innerHeight <= 520;
  }

  /** Camera x for hero x: partial follow; in flight it stays near the road's centre line. */
  private followX(px: number, fly: number): number {
    return px * lerp(lerp(0.72, 0.35, this.portrait()), 0.3, fly);
  }

  private lookFollowX(px: number, fly: number): number {
    return px * lerp(lerp(0.55, 0.3, this.portrait()), 0.3, fly);
  }

  private runPose(p: PlayerState, hz: number, o: Pose): void {
    const pt = this.portrait();
    const uw = this.ultrawide();
    const fw = this.boost;
    const aspect = this.stage.aspect;
    let fov = lerp(56, 66, pt) + this.speedN * 7 + fw * 2 + this.fovKick;
    let back = lerp(lerp(6.4, 8.2, pt), 7.6 + pt * 1.6, fw) - uw * 0.5;
    const height = lerp(lerp(3.4, 4.3, pt), 2.6 + pt * 0.6, fw) - uw * 0.35;

    // Aspect-aware: widen FOV (up to a cap), then pull back, until the lanes fit at the hero.
    const dist = Math.hypot(back, height - 1);
    const needTan = FRAME_HALF_WIDTH / (dist * aspect);
    const needFov = (2 * Math.atan(needTan)) / D2R;
    const maxFov = 76 + fw * 4;
    if (needFov > fov) fov = Math.min(maxFov, needFov);
    const haveTan = Math.tan((fov / 2) * D2R) * aspect;
    if (haveTan * dist < FRAME_HALF_WIDTH) back = Math.sqrt(Math.max(0, (FRAME_HALF_WIDTH / haveTan) ** 2 - (height - 1) ** 2));
    // Ultrawide: keep the horizontal field of a ~2:1 screen instead of growing it, so the vertical
    // field narrows (less sky and roofs, a bigger hero) while all lanes stay in view.
    if (aspect > 2) {
      const wide = Math.tan((fov / 2) * D2R) * 2 * (1 + 0.12 * uw);
      fov = Math.min(fov, (2 * Math.atan(wide / aspect)) / D2R);
    }

    const sup = this.support;
    o.px = this.x;
    o.py = Math.min(CEILING_Y, sup + height);
    o.pz = hz + back;
    o.lx = this.lookX;
    // Look target: down the street; keeps a jumping / rising hero in frame; looks down in flight.
    o.ly = sup + lerp(1.15, 2.0, pt) + Math.max(0, p.y - sup) * lerp(0.3, 0.75, fw) - fw * lerp(2.9, 2.3, pt) - uw * 0.15;
    o.lz = hz - lerp(10, 15, pt) - fw * 2;
    o.fov = fov;
    o.roll = this.roll;
  }

  private menuPose(p: PlayerState, hz: number, dt: number, o: Pose): void {
    this.menuTime += dt;
    const t = this.menuTime;
    const pt = this.portrait();
    const sl = this.shortLandscape() ? 1 : 0;
    // Front-right of the hero, roughly where the sun stands (market light comes from ahead-right,
    // high): his front and the facades across the street are lit, with sky above them. A slow drift
    // swings around him a little and breathes the height.
    const az = (lerp(157, 160, pt) + Math.sin(t * 0.14) * 5 + Math.sin(t * 0.061 + 1) * 2.5) * D2R;
    let r = lerp(5.0, 6.4, pt) + sl * 0.4 + Math.sin(t * 0.09) * 0.25;
    const sx = Math.sin(az);
    const room = sx > 0 ? CORRIDOR_X - p.x : CORRIDOR_X + p.x;
    if (Math.abs(sx) * r > room) r = room / Math.abs(sx);
    o.px = p.x + sx * r;
    o.py = p.y + lerp(1.75, 1.8, pt) + Math.sin(t * 0.23) * 0.12;
    o.pz = hz + Math.cos(az) * r;
    o.fov = lerp(44, 56, pt) + sl * 4;
    o.roll = 0;
    // Where the hero (chest) sits on screen, clear of the DOM: right of the centred column on
    // desktop (in front of the lit facades, the sunny street and sky receding behind him), between the wordmark (left) and Play (right) on short landscape phones, centred
    // between the stacked wordmark and Play on portrait.
    const u = sl ? 0.14 : lerp(0.42, 0, pt);
    const v = sl ? -0.3 : lerp(-0.16, -0.02, pt);
    this.aim(o, p.x, p.y + 1.05, hz, u, v);
  }

  private overPose(p: PlayerState, hz: number, dt: number, o: Pose): void {
    this.overTime += dt;
    const pt = this.portrait();
    const caught = this.overReason === 'caught';
    const spot = this.spot;
    if (!spot.chosen) this.chooseSpot(p, hz);
    // Slow orbit and rise after the impact.
    const drift = Math.min(this.overTime, 6);
    const az = spot.az + spot.side * drift * 0.035 * (caught ? -1 : 1);
    const sx = Math.sin(az);
    let r = spot.r;
    const room = sx > 0 ? CORRIDOR_X - p.x : CORRIDOR_X + p.x;
    if (Math.abs(sx) * r > room) r = Math.max(1.5, room / Math.abs(sx));
    o.px = p.x + sx * r;
    o.py = Math.min(CEILING_Y, p.y + spot.h + drift * 0.05);
    o.pz = hz + Math.cos(az) * r;
    o.fov = lerp(caught ? 47 : 50, 62, pt);
    o.roll = 0;
    // Subject: where the hero ends up (he falls back, toward +z), with the drone above him when
    // caught. Once the game-over panel arrives it slides clear: left of the centred panel on
    // landscape screens, above it on portrait phones.
    const slide = smooth01((this.overTime - 0.35) / 0.65);
    const u = slide * lerp(caught ? -0.44 : -0.36, 0, pt);
    const v = slide * lerp(0, 0.34, pt);
    this.aim(o, p.x + (caught ? spot.side * 0.2 : 0), p.y + (caught ? 0.9 : 0.4), hz + (caught ? 1.2 : 1.1), u, v);
  }

  /**
   * Pick the ending camera spot: try candidate azimuths / heights (preferring the road-centre side)
   * and keep the first one from which hero and drone are in clear view of every track solid.
   */
  private chooseSpot(p: PlayerState, hz: number): void {
    const spot = this.spot;
    const caught = this.overReason === 'caught';
    // Prefer the side toward the road centre (more room), else the side with fewer solids nearby.
    let pref: 1 | -1 = p.x > 0.5 ? -1 : p.x < -0.5 ? 1 : this.sideLoad(p, hz, 1) <= this.sideLoad(p, hz, -1) ? 1 : -1;
    if (caught && Math.abs(p.x) <= 0.5 && this.sideLoad(p, hz, 1) === this.sideLoad(p, hz, -1)) pref = 1;
    const azs = caught ? [146, 146, 180, 120, 120] : [62, 62, 35, 0, 90];
    const sides = caught ? [pref, -pref, pref, pref, -pref] : [pref, -pref, pref, pref, -pref];
    const r = caught ? 4.7 : 5.0;
    const h0 = caught ? 4.0 : 3.5;
    for (let hi = 0; hi < 4; hi++) {
      const h = h0 + hi * 1.5;
      for (let i = 0; i < azs.length; i++) {
        const side = sides[i] as 1 | -1;
        const az = azs[i] * D2R * side;
        if (this.spotClear(p, hz, az, r, h, caught)) {
          spot.az = az; spot.r = r; spot.h = h; spot.side = side; spot.chosen = true;
          return;
        }
      }
    }
    spot.az = azs[0] * D2R * pref; spot.r = r * 0.8; spot.h = h0 + 5; spot.side = pref; spot.chosen = true;
  }

  /** Number of solids beside the hero on `side` (within a few metres). */
  private sideLoad(p: PlayerState, hz: number, side: 1 | -1): number {
    const list = this.obstacles?.();
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!(e.kind in OBSTACLE_DIMS)) continue;
      const dx = (e.x - p.x) * side;
      if (dx < 0.8 || dx > 4) continue;
      const z = this.stage.worldZ(e.s);
      if (Math.abs(z - hz) > e.len / 2 + 6) continue;
      n++;
    }
    return n;
  }

  private spotClear(p: PlayerState, hz: number, az: number, r: number, h: number, caught: boolean): boolean {
    let sx = Math.sin(az);
    const room = sx > 0 ? CORRIDOR_X - p.x : CORRIDOR_X + p.x;
    if (Math.abs(sx) * r > room) r = Math.max(1.5, room / Math.abs(sx));
    sx *= r;
    const cx = p.x + sx, cy = p.y + h, cz = hz + Math.cos(az) * r;
    if (cy > CEILING_Y) return false;
    // Hero standing (impact), hero lying (+z), drone above him when caught.
    return (
      this.segmentClear(cx, cy, cz, p.x, p.y + 1.0, hz, 0.7) &&
      this.segmentClear(cx, cy, cz, p.x, p.y + 0.3, hz + 1.0, 0.7) &&
      (!caught || this.segmentClear(cx, cy, cz, p.x, p.y + 2.2, hz + 1.2, 0.7))
    );
  }

  /** True when no track solid (grown by `margin` at the camera end) touches the segment a -> b. */
  private segmentClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, margin: number): boolean {
    const list = this.obstacles?.();
    if (!list) return true;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const d = OBSTACLE_DIMS[e.kind as ObstacleKind] as (typeof OBSTACLE_DIMS)[ObstacleKind] | undefined;
      if (!d || !e.active) continue;
      const z = this.stage.worldZ(e.s);
      const m = 0.12;
      const x0 = e.x - d.w / 2 - m, x1 = e.x + d.w / 2 + m;
      const y0 = e.y + d.solidFrom * 0.5, y1 = e.y + d.h + m;
      const z0 = z - e.len / 2 - m, z1 = z + e.len / 2 + m;
      // camera itself too close to the solid
      if (ax > x0 - margin && ax < x1 + margin && ay < y1 + margin && az > z0 - margin && az < z1 + margin) return false;
      // slab test over t in [0, 0.97] (the far end is the subject itself)
      let t0 = 0, t1 = 0.97;
      t0 = Math.max(t0, slabIn(ax, dx, x0, x1)); t1 = Math.min(t1, slabOut(ax, dx, x0, x1));
      t0 = Math.max(t0, slabIn(ay, dy, y0, y1)); t1 = Math.min(t1, slabOut(ay, dy, y0, y1));
      t0 = Math.max(t0, slabIn(az, dz, z0, z1)); t1 = Math.min(t1, slabOut(az, dz, z0, z1));
      if (t0 <= t1) return false;
    }
    return true;
  }

  /**
   * Aim pose `o` (position and fov already set) so the world point (hx, hy, hz) lands at normalised
   * screen coordinates (u, v) in [-1, 1] (+u right, +v up). Yaw/pitch camera, no roll.
   */
  private aim(o: Pose, hx: number, hy: number, hz: number, u: number, v: number): void {
    const dx = hx - o.px, dy = hy - o.py, dz = hz - o.pz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const tV = Math.tan((o.fov / 2) * D2R);
    const tH = tV * this.stage.aspect;
    const A = v * tV, B = u * tH;
    const n = Math.sqrt(1 + A * A + B * B);
    const s = Math.max(-1, Math.min(1, ((dy / len) * n) / Math.sqrt(1 + A * A)));
    const pitch = Math.asin(s) - Math.atan(A);
    const fh = Math.cos(pitch) - A * Math.sin(pitch);
    const yaw = Math.atan2(dx, dz) + Math.atan2(B, fh);
    const c = Math.cos(pitch) * 10;
    o.lx = o.px + Math.sin(yaw) * c;
    o.ly = o.py + Math.sin(pitch) * 10;
    o.lz = o.pz + Math.cos(yaw) * c;
  }

  // ------------------------------------------------------------------ modes

  private enterMode(mode: CameraMode): void {
    if (mode === this._mode) return;
    // Start the blend from what is on screen now (including any blend in progress).
    this.writePose(this.out, this.from);
    this.fromHeroX = this.heroX; this.fromHeroZ = this.heroZ;
    this._mode = mode;
    this.blendT = 0;
    this.blendDur = BLEND_TIME[mode];
    this.entry = false;
    if (mode === 'menu') this.menuTime = 0;
    if (mode === 'over') {
      this.overTime = 0;
      this.spot.chosen = false;
    }
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

  /** Copy a pose (the one actually shown is remembered so the next mode change can blend from it). */
  private writePose(src: Pose, dst: Pose): void {
    if (src === dst) return;
    dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
    dst.lx = src.lx; dst.ly = src.ly; dst.lz = src.lz;
    dst.fov = src.fov; dst.roll = src.roll;
  }
}
