// Orchestrator: state machine, frame loop, and routing of sim events to view / ui / audio.
// The only module that knows every other module.
//
// Timing model: `tick(dt)` gets real seconds. Gameplay and the views run on a scaled clock so
// the game can do a short hit-stop on impacts and a slow-motion beat after a crash (the sim is
// frozen once it is over, so the death animation is driven by the view clock alone).
import { AudioEngine, type SfxName } from './audio';
import { Input } from './input';
import { CHASER_START_GAP, MAX_SIM_STEP, OBSTACLE_DIMS, speedAt, SPEED_MAX, STUMBLE_WINDOW } from './sim/config';
import { GameSim } from './sim/sim';
import type { ChaserState, InputActions, ObstacleKind, PowerupKind, Quality, SimEvent, SimState } from './sim/types';
import { loadSettings, UI } from './ui';
import { Atmosphere } from './view/atmosphere';
import { CameraRig } from './view/cameraRig';
import { Fx } from './view/fx';
import { ChaserRig, HeroRig } from './view/models';
import { SceneryView } from './view/scenery';
import { Stage, type BackendPreference } from './view/stage';
import { TrackView } from './view/trackView';

export type GameMode = 'menu' | 'running' | 'paused' | 'gameover';
export type Autopilot = (state: SimState) => InputActions;

export interface GameOptions {
  seed?: number;
  quality?: Quality;
  muted?: boolean;
  /** Force the visual zone (0..2) regardless of distance (debug). */
  forceZone?: number | null;
  preference?: BackendPreference;
}

export interface Best {
  score: number;
  coins: number;
}

const BEST_KEY = 'wayman-run.best';
const MAX_FRAME_DT = 0.1;
const NO_INPUT: InputActions = { left: false, right: false, jump: false, roll: false };

// ---- game feel (all times in real seconds unless noted) ----
/** Delay between the impact and the game-over panel. */
const OVER_DELAY_CRASH = 1.35;
const OVER_DELAY_CAUGHT = 1.5;
/** Hit-stop right after the fatal hit: the world nearly freezes. */
const OVER_HITSTOP = 0.12;
const OVER_HITSTOP_SCALE = 0.04;
/** After the hit-stop the clock ramps from this factor up to 1 over OVER_RAMP seconds. */
const OVER_SLOWMO_SCALE = 0.28;
const OVER_RAMP = 0.9;
/** Micro hit-stops (clock factor 0.06) on non-fatal hits. */
const FREEZE_SCALE = 0.06;
const FREEZE_SHIELD = 0.09;
const FREEZE_STUMBLE = 0.06;
const SHAKE = { crash: 1, caught: 0.8, shieldBreak: 0.5, stumble: 0.4, hardLand: 0.2 } as const;
/** Minimum real seconds between near-miss popups. */
const NEAR_MISS_POPUP_GAP = 0.45;
/** Popup every this many metres (zone changes, every 500 m, have their own banner). */
const MILESTONE_EVERY = 250;
const DANGER_PULSE_EVERY = 0.6;

/** Drone placement: lateral offset from the hero and clearance from vehicles. */
const DRONE_SIDE_OFFSET = 2.0;
const DRONE_MIN_OFFSET = 1.3;
const DRONE_X_LIMIT = 3.7;
const DRONE_CLEAR_S = 1.3;
const DRONE_CLEAR_X = 0.9;

const SFX: Partial<Record<SimEvent['type'], SfxName>> = {
  coin: 'coin',
  jump: 'jump',
  land: 'land',
  roll: 'roll',
  laneChange: 'lane',
  stumble: 'stumble',
  pickup: 'pickup',
  powerupEnd: 'powerupEnd',
  shieldBreak: 'shieldBreak',
  nearMiss: 'nearMiss',
  zone: 'zone',
  gameOver: 'crash',
};

const ZONE_TITLES = ['Market Street', 'Harbor Front', 'Night Bazaar'];
const POWERUP_LABEL: Record<PowerupKind, string> = {
  magnet: 'MAGNET!',
  shield: 'SHIELD!',
  boost: 'BOOST!',
  multiplier: 'SCORE x2!',
};

/** Pool sizes created at boot (per livery for trucks / buses) so nothing is built mid-run. */
const PREWARM = {
  hurdle: 8, overhead: 8, blocker: 8,
  truck: 3, bus: 3, busOncoming: 3, ramp: 4,
  coin: 90, magnet: 2, shield: 2, boost: 2, multiplier: 2,
} as const;

function loadBest(): Best {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (raw) {
      const b = JSON.parse(raw) as Partial<Best>;
      return { score: Number(b.score) || 0, coins: Number(b.coins) || 0 };
    }
  } catch {
    // storage blocked (private mode, sandboxed iframe)
  }
  return { score: 0, coins: 0 };
}

function saveBest(b: Best): void {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    // ignore
  }
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth01 = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export class Game {
  readonly stage: Stage;
  readonly sim: GameSim;
  readonly ui: UI;
  readonly input: Input;
  readonly audio: AudioEngine;
  readonly trackView: TrackView;
  readonly scenery: SceneryView;
  readonly atmosphere: Atmosphere;
  readonly cameraRig: CameraRig;
  readonly fx: Fx;
  readonly hero: HeroRig;
  readonly chaser: ChaserRig;

  autopilot: Autopilot | null = null;
  forceZone: number | null;
  /** Debug counters (reset with each run). */
  readonly counters = { runs: 0, hitStops: 0 };

  private _mode: GameMode = 'menu';
  private seed: number;
  private best: Best;
  private readonly allowAutoQuality: boolean;

  // timing
  private clock = 0;
  private viewTime = 0;
  private freeze = 0;
  private overTimer = -1;
  private overDelay = OVER_DELAY_CRASH;
  private overReason = 'crash';

  // feedback state
  private lastNearMissPopup = -10;
  private nextMilestone = MILESTONE_EVERY;
  private dangerClock = 0;

  // drone placement (view-side)
  private viewGap = CHASER_START_GAP;
  private droneX = 0;
  private droneBase = 0;
  private droneSide: 1 | -1 = 1;
  private droneInit = false;
  private readonly chaserView: ChaserState = { gap: CHASER_START_GAP, visible: false };

  private constructor(stage: Stage, uiRoot: HTMLElement, opts: GameOptions) {
    this.stage = stage;
    this.seed = opts.seed ?? 1;
    this.forceZone = opts.forceZone ?? null;
    this.best = loadBest();
    const settings = loadSettings();
    // URL params override saved settings; auto quality only when the player never chose one.
    this.allowAutoQuality = opts.quality === undefined && settings.quality === null;
    const muted = opts.muted === true || settings.muted;
    this.sim = new GameSim(this.seed);
    this.audio = new AudioEngine();
    this.audio.setMuted(muted);

    this.atmosphere = new Atmosphere(stage);
    this.scenery = new SceneryView(stage);
    this.trackView = new TrackView(stage);
    this.trackView.prewarm(PREWARM);
    this.hero = new HeroRig();
    this.chaser = new ChaserRig();
    stage.world.addChild(this.hero.node, this.chaser.node);
    this.fx = new Fx(stage);
    this.cameraRig = new CameraRig(stage);

    this.ui = new UI(
      uiRoot,
      {
        onPlay: () => this.start(),
        onPause: () => this.pause(),
        onResume: () => this.resume(),
        onRestart: () => this.start(),
        onHome: () => this.home(),
        onMute: (m) => this.audio.setMuted(m),
        onQuality: (q) => this.stage.setQuality(q),
      },
      { muted, quality: stage.quality, onClick: () => this.audio.sfx('click') },
    );

    this.input = new Input(stage.app.canvas);
    this.input.onPause = () => {
      if (this._mode === 'running') this.pause();
      else if (this._mode === 'paused' && !this.ui.isCounting) this.ui.beginResume();
    };

    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      if (this._mode === 'running') this.pause();
      else if (this._mode === 'paused' && this.ui.isCounting) this.ui.showPause();
    });

    this.cameraRig.setMode('menu');
    this.cameraRig.snap(this.sim.state.player);
    this.home();
    this.warmup();

    stage.app.ticker.add((ticker) => {
      if (this._mode === 'running') stage.sampleFrameTime(ticker.deltaMS);
      this.tick(Math.min(ticker.deltaMS / 1000, MAX_FRAME_DT));
    });
  }

  static async create(gameRoot: HTMLElement, uiRoot: HTMLElement, opts: GameOptions = {}): Promise<Game> {
    const quality = opts.quality ?? loadSettings().quality ?? undefined;
    const stage = await Stage.create({ parent: gameRoot, quality, preference: opts.preference });
    return new Game(stage, uiRoot, opts);
  }

  get mode(): GameMode {
    return this._mode;
  }

  /** True while the game-over beat (hit-stop + slow motion) plays, before the panel appears. */
  get dying(): boolean {
    return this.overTimer >= 0;
  }

  // ------------------------------------------------------------ state machine

  start(seed: number = this.seed): void {
    this.seed = seed;
    this.resetWorld(seed);
    const p = this.sim.state.player;
    // Swoop: snap the camera state onto the new hero, then blend from the current framing (menu
    // orbit or game-over view) into the chase view.
    this.cameraRig.snap(p);
    this.cameraRig.setMode('run');
    this.cameraRig.kick(3);
    this.hero.setIdle(false);
    this._mode = 'running';
    this.counters.runs++;
    this.ui.showHud();
    this.ui.updateHud(this.sim.state);
    this.audio.unlock();
    this.audio.setMusic('run');
    if (this.allowAutoQuality) this.stage.enableAutoQuality();
  }

  pause(): void {
    if (this._mode !== 'running' || this.sim.state.over) return;
    this._mode = 'paused';
    this.ui.showPause();
    this.audio.setLoop('boost', false);
    this.audio.setMusic('menu'); // soft menu music under the pause panel
  }

  resume(): void {
    if (this._mode !== 'paused') return;
    if (document.hidden) {
      this.ui.showPause();
      return;
    }
    this.input.clear();
    this._mode = 'running';
    this.ui.showHud();
    this.audio.setMusic('run', true);
    if (this.sim.state.powerups.boost > 0) this.audio.setLoop('boost', true);
  }

  home(): void {
    this.resetWorld(this.seed);
    this._mode = 'menu';
    this.hero.setIdle(true);
    this.cameraRig.setMode('menu');
    this.ui.showMenu(this.best);
    this.audio.setMusic('menu');
  }

  // ------------------------------------------------------------------ frame

  /** One frame of game logic + view updates (rendering is done by the pixi ticker). */
  tick(dt: number): void {
    this.clock += dt;
    const st = this.sim.state;

    // Scaled clock: micro hit-stops on hits, slow motion after the fatal one.
    let sdt = dt;
    if (this.freeze > 0) {
      this.freeze -= dt;
      sdt = dt * FREEZE_SCALE;
    }

    if (this._mode === 'running' && !st.over) {
      const real = this.input.consume();
      const input = this.autopilot ? this.autopilot(st) : real;
      const n = Math.max(1, Math.ceil(sdt / MAX_SIM_STEP - 1e-6));
      const h = sdt / n;
      for (let i = 0; i < n; i++) {
        this.sim.update(h, i === 0 ? input : NO_INPUT);
        if (st.over) break;
      }
      this.route(this.sim.drainEvents());
      this.audio.setIntensity(this.intensity(st));
    } else {
      this.input.consume(); // drop input while not running
    }

    if (this.overTimer >= 0) {
      this.overTimer += dt;
      const t = this.overTimer;
      sdt = dt * (t < OVER_HITSTOP ? OVER_HITSTOP_SCALE : OVER_SLOWMO_SCALE + (1 - OVER_SLOWMO_SCALE) * smooth01((t - OVER_HITSTOP) / OVER_RAMP));
      // The sim is frozen once over, so advance the death animation here.
      st.player.actionTime += sdt;
      if (t >= this.overDelay) {
        this.overTimer = -1;
        this.finishRun();
      }
    }

    this.updateViews(this._mode === 'paused' ? 0 : sdt);
  }

  /** Debug: run `seconds` of game time in 1/30 s frames without waiting, then render one frame. */
  advance(seconds: number): void {
    const frame = 1 / 30;
    let left = seconds;
    while (left > 1e-9) {
      const dt = Math.min(frame, left);
      this.tick(dt);
      left -= dt;
    }
    this.stage.render();
  }

  // ------------------------------------------------------------ debug / QA

  /** Force the stumble state exactly as a side-hit would leave it (for screenshots). */
  forceStumble(): void {
    const st = this.sim.state;
    const p = st.player;
    if (st.over) return;
    const internals = this.sim as unknown as { stumbleAnim: number };
    internals.stumbleAnim = 0.6;
    p.stumbleWindow = STUMBLE_WINDOW;
    p.action = 'stumble';
    p.actionTime = 0;
    st.chaser.gap = Math.min(st.chaser.gap, 3);
    st.chaser.visible = true;
    this.route([{ type: 'stumble' }]);
  }

  /** End the run now through the sim's own game-over path. */
  forceGameOver(reason: 'crash' | 'caught' = 'crash'): void {
    if (this.sim.state.over) return;
    (this.sim as unknown as { gameOver(r: string): void }).gameOver(reason);
    this.route(this.sim.drainEvents());
  }

  /** Grant a power-up as if it had just been picked up. */
  forcePickup(kind: PowerupKind): void {
    if (this.sim.state.over) return;
    (this.sim as unknown as { activatePowerup(k: PowerupKind): void }).activatePowerup(kind);
    this.route(this.sim.drainEvents());
  }

  /** Snapshot of view/pool bookkeeping for automated checks. */
  viewStats(): {
    mode: GameMode;
    simEntities: number;
    liveNodes: number;
    visibleLive: number;
    visiblePooled: number;
    nodes: number;
    particles: number;
    runs: number;
  } {
    return {
      mode: this._mode,
      simEntities: this.sim.state.entities.length,
      liveNodes: this.trackView.liveCount,
      visibleLive: this.trackView.visibleLiveCount,
      visiblePooled: this.trackView.visiblePooledCount,
      nodes: this.trackView.nodeCount,
      particles: this.fx.particleCount,
      runs: this.counters.runs,
    };
  }

  // --------------------------------------------------------------- internal

  /** Put every module into its fresh-run state (also used when returning to the menu). */
  private resetWorld(seed: number): void {
    this.trackView.reset();
    this.fx.reset();
    this.hero.reset();
    this.chaser.reset();
    this.ui.reset();
    this.sim.reset(seed);
    this.stage.setOrigin(0);
    this.route(this.sim.drainEvents()); // initial spawns, so there is a street ahead
    this.audio.setLoop('boost', false);
    this.input.clear();
    this.resetViewState();
  }

  private resetViewState(): void {
    this.freeze = 0;
    this.overTimer = -1;
    this.lastNearMissPopup = -10;
    this.nextMilestone = MILESTONE_EVERY;
    this.dangerClock = 0;
    this.viewGap = CHASER_START_GAP;
    this.chaserView.gap = CHASER_START_GAP;
    this.chaserView.visible = false;
    this.droneInit = false;
  }

  /** Render one frame with a sample of every pooled model visible, so shaders compile at boot. */
  private warmup(): void {
    try {
      const p = this.sim.state.player;
      this.trackView.beginWarmup(p.x, 0.5, this.stage.worldZ(p.s) - 3);
      this.stage.render();
    } catch {
      // a failed warm-up render must never stop the game from starting
    } finally {
      this.trackView.endWarmup();
    }
  }

  private intensity(st: SimState): number {
    let v = (speedAt(st.time) - 13) / (SPEED_MAX - 13);
    if ((st.player.stumbleWindow ?? 0) > 0) v = Math.max(v, 0.95); // tenser music while one more stumble ends the run
    return v;
  }

  private updateViews(dt: number): void {
    const st = this.sim.state;
    const p = st.player;
    const running = this._mode === 'running' && !st.over;
    this.viewTime += dt;
    this.stage.rebase(p.s);
    const zone = this.forceZone ?? st.zone;
    const blend = this.forceZone === null ? st.zoneBlend : 0;
    this.atmosphere.update(zone, blend, dt);
    this.scenery.update(p.s, zone, blend, dt);
    this.trackView.update(st, dt);

    // ---- hero
    this.hero.update(p, st.powerups, dt);
    const hero = this.hero.node;
    hero.position.z = this.stage.worldZ(p.s);
    const inv = p.invulnerable ?? 0;
    const blinking = inv > 0 && p.action !== 'fly' && this._mode !== 'menu' && !st.over;
    hero.visible = !blinking || (this.viewTime * 9) % 1 < 0.72;

    this.updateChaser(st, dt);

    // ---- feedback that depends on the stumble window
    const win = p.stumbleWindow ?? 0;
    if (running) {
      this.ui.setDanger(win > 0 ? win / STUMBLE_WINDOW : 0);
      if (win > 0) {
        this.dangerClock += dt;
        if (this.dangerClock >= DANGER_PULSE_EVERY) {
          this.dangerClock = 0;
          this.fx.screen.pulse(0xff3a2a, 0.2);
        }
      } else this.dangerClock = DANGER_PULSE_EVERY * 0.5;
    }

    this.fx.update(st, dt);
    this.cameraRig.update(p, dt);
    if (running) {
      this.ui.updateHud(st);
      if (p.s >= this.nextMilestone) {
        const m = this.nextMilestone;
        this.nextMilestone += MILESTONE_EVERY;
        if (m % 500 !== 0) this.ui.popup(`${m} m`, 'info');
      }
    }
  }

  /** Drone: placed behind the hero on the side away from vehicles, tracks the hero's height. */
  private updateChaser(st: SimState, dt: number): void {
    const p = st.player;
    const node = this.chaser.node;
    const over = st.over;
    const caught = over && this.overReason === 'caught';

    // Gap: follows the sim, but eases in for the 'caught' ending so the catch is visible.
    const gapGoal = st.chaser.gap;
    if (caught) this.viewGap += (gapGoal - this.viewGap) * (1 - Math.exp(-dt * 9));
    else this.viewGap = gapGoal;
    const cs = this.chaserView;
    cs.gap = this.viewGap;
    cs.visible = this._mode !== 'menu' && st.chaser.visible;

    const ds = p.s - this.viewGap;
    // Close to the camera the drone must stay inside the frame: tuck it in and lift it a little.
    const camDist = Math.max(0, this.stage.camera.position.z - this.stage.worldZ(ds));
    const near = clamp((5.5 - camDist) / 2.5, 0, 1);

    // Vertical base: standing surface, plus a fraction of the jump; high in boost flight.
    const ground = p.groundY ?? 0;
    const baseGoal = (p.action === 'fly' ? p.y * 0.85 : ground + Math.max(0, p.y - ground) * 0.3) + near * 0.8;

    // Lateral: pick the side with free space (no vehicle at the drone's height there).
    const catchK = caught ? clamp((this.viewGap - 0.8) / 2, 0, 1) : 1;
    const baseOffset = DRONE_SIDE_OFFSET - 0.7 * near;
    const offset = caught ? 0.6 + (baseOffset - 0.6) * catchK : baseOffset;
    if (!this.droneInit) this.droneSide = p.x > 0.4 ? -1 : 1;
    if (caught) this.droneSide = 1; // the over-camera slides the hero left: keep the drone in frame beside him
    const cur = this.sideCost(this.droneSide, p.x, ds, baseGoal, offset);
    if (cur > 0) {
      const other = this.sideCost(this.droneSide === 1 ? -1 : 1, p.x, ds, baseGoal, offset);
      if (other < cur) this.droneSide = this.droneSide === 1 ? -1 : 1;
    }
    const goalX = this.sideX(this.droneSide, p.x, offset);
    if (!this.droneInit) {
      this.droneX = goalX;
      this.droneBase = baseGoal;
      this.droneInit = true;
    }
    const kx = 1 - Math.exp(-dt * 5);
    this.droneX += (goalX - this.droneX) * kx;
    this.droneBase += (baseGoal - this.droneBase) * (1 - Math.exp(-dt * (baseGoal > this.droneBase ? 3.5 : 4.5)));

    node.position.set(this.droneX, this.droneBase, this.stage.worldZ(ds));
    // Seen from very close (intro, stumble) it would fill the screen: shrink it a little.
    const k = 0.55 + 0.45 * clamp((camDist - 2.2) / 3.3, 0, 1);
    node.scale.set(k, k, k);
    this.chaser.update(cs, this.viewTime, dt);
    // Searchlight follows the hero's chest, on roofs and in flight too.
    const chest = p.y + (p.action === 'roll' ? 0.5 : 1.0);
    this.chaser.setTarget(p.x - node.position.x, chest - node.position.y, this.stage.worldZ(p.s) - node.position.z);
  }

  private sideX(side: 1 | -1, heroX: number, offset: number): number {
    return clamp(heroX + side * offset, -DRONE_X_LIMIT, DRONE_X_LIMIT);
  }

  /** 0 = free; larger = worse (too close to the hero, or inside a solid thing at drone height). */
  private sideCost(side: 1 | -1, heroX: number, ds: number, base: number, offset: number): number {
    const x = this.sideX(side, heroX, offset);
    let cost = Math.abs(x - heroX) < Math.min(DRONE_MIN_OFFSET, offset) ? 2 : 0;
    const list = this.sim.state.entities;
    const droneBottom = base + 0.6;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const d = OBSTACLE_DIMS[e.kind as ObstacleKind] as (typeof OBSTACLE_DIMS)[ObstacleKind] | undefined;
      if (!d) continue; // pickups never block the drone
      if (Math.abs(e.s - ds) > e.len / 2 + DRONE_CLEAR_S) continue;
      if (Math.abs(e.x - x) > d.w / 2 + DRONE_CLEAR_X) continue;
      if (e.y + d.h < droneBottom) continue; // lower than the drone's body
      cost += 1;
    }
    return cost;
  }

  private popup(text: string, kind: 'good' | 'great' | 'info' | 'danger'): void {
    this.ui.popup(text, kind);
  }

  private route(events: readonly SimEvent[]): void {
    const st = this.sim.state;
    for (const e of events) {
      this.trackView.onEvent(e);
      this.fx.onEvent(e, st);
      const sfx = SFX[e.type];
      if (sfx) this.audio.sfx(sfx);
      switch (e.type) {
        case 'zone':
          if (this.forceZone === null) {
            this.ui.toast(ZONE_TITLES[e.index] ?? '');
            this.atmosphere.flash(0.5);
          }
          break;
        case 'pickup':
          this.popup(POWERUP_LABEL[e.kind], 'great');
          if (e.kind === 'boost') {
            this.cameraRig.kick(3);
            this.audio.setLoop('boost', true);
          }
          break;
        case 'powerupEnd':
          if (e.kind === 'boost') this.audio.setLoop('boost', false);
          break;
        case 'nearMiss':
          if (this.clock - this.lastNearMissPopup > NEAR_MISS_POPUP_GAP) {
            this.lastNearMissPopup = this.clock;
            this.popup('NEAR MISS!', 'great');
          }
          break;
        case 'land':
          if (e.hard) this.cameraRig.shake(SHAKE.hardLand);
          break;
        case 'stumble':
          this.cameraRig.shake(SHAKE.stumble);
          this.freeze = Math.max(this.freeze, FREEZE_STUMBLE);
          this.counters.hitStops++;
          this.popup('STUMBLE!', 'danger');
          break;
        case 'shieldBreak':
          this.cameraRig.shake(SHAKE.shieldBreak);
          this.freeze = Math.max(this.freeze, FREEZE_SHIELD);
          this.counters.hitStops++;
          this.popup('SHIELD SAVED YOU!', 'good');
          break;
        case 'gameOver':
          this.overReason = e.reason;
          this.overDelay = e.reason === 'caught' ? OVER_DELAY_CAUGHT : OVER_DELAY_CRASH;
          this.overTimer = 0;
          this.freeze = 0;
          this.cameraRig.shake(e.reason === 'caught' ? SHAKE.caught : SHAKE.crash);
          this.cameraRig.setMode('over');
          this.audio.setLoop('boost', false);
          this.audio.setMusic('off'); // a beat of silence; menu music returns with the panel
          this.ui.setDanger(0);
          break;
        default:
          break;
      }
    }
  }

  private finishRun(): void {
    const st = this.sim.state;
    const stats = st.stats;
    const newBest = st.score > this.best.score;
    if (newBest) this.best.score = st.score;
    if (st.coins > this.best.coins) this.best.coins = st.coins;
    saveBest(this.best);
    this._mode = 'gameover';
    this.audio.setMusic('menu');

    // Up to four fun facts: distance always, then the most interesting non-zero ones.
    const extras: { label: string; value: string }[] = [{ label: 'Distance', value: `${Math.floor(st.player.s).toLocaleString('en-US')} m` }];
    if (stats) {
      const more: [string, number, string][] = [
        ['Near misses', stats.nearMisses, ''],
        ['Roof run', Math.floor(stats.roofMetres), ' m'],
        ['Shield saves', stats.shieldSaves, ''],
        ['Power-ups', stats.powerups, ''],
        ['Jumps', stats.jumps, ''],
        ['Rolls', stats.rolls, ''],
        ['Lane swaps', stats.laneChanges, ''],
        ['Stumbles', stats.stumbles, ''],
      ];
      for (const [label, v, unit] of more) {
        if (extras.length >= 4) break;
        if (v > 0) extras.push({ label, value: `${v}${unit}` });
      }
    }
    this.ui.showGameOver({ score: st.score, coins: st.coins, best: this.best.score, newBest, reason: this.overReason, extras });
  }
}
