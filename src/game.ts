// Orchestrator: state machine, frame loop, and routing of sim events to view / ui / audio.
// The only module that knows every other module.
import { AudioEngine, type SfxName } from './audio';
import { Input } from './input';
import { MAX_SIM_STEP, speedAt, SPEED_MAX } from './sim/config';
import { GameSim } from './sim/sim';
import type { InputActions, Quality, SimEvent, SimState } from './sim/types';
import { UI } from './ui';
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
const GAMEOVER_DELAY = 0.9;
const NO_INPUT: InputActions = { left: false, right: false, jump: false, roll: false };

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

  private _mode: GameMode = 'menu';
  private seed: number;
  private best: Best;
  private overTimer = -1;
  private overReason = 'crash';
  private viewTime = 0;

  private constructor(stage: Stage, uiRoot: HTMLElement, opts: GameOptions) {
    this.stage = stage;
    this.seed = opts.seed ?? 1;
    this.forceZone = opts.forceZone ?? null;
    this.best = loadBest();
    this.sim = new GameSim(this.seed);
    this.audio = new AudioEngine();
    this.audio.setMuted(!!opts.muted);

    this.atmosphere = new Atmosphere(stage);
    this.scenery = new SceneryView(stage);
    this.trackView = new TrackView(stage);
    this.trackView.prewarm({ hurdle: 6, overhead: 6, blocker: 6, coin: 40 });
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
      { muted: !!opts.muted, quality: stage.quality },
    );

    this.input = new Input(stage.app.canvas);
    this.input.onPause = () => (this._mode === 'running' ? this.pause() : this._mode === 'paused' ? this.resume() : undefined);

    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this._mode === 'running') this.pause();
    });

    this.route(this.sim.drainEvents()); // initial spawns, so the menu shows a street ahead
    this.cameraRig.snap(this.sim.state.player);
    this.home();

    stage.app.ticker.add((ticker) => this.tick(Math.min(ticker.deltaMS / 1000, MAX_FRAME_DT)));
  }

  static async create(gameRoot: HTMLElement, uiRoot: HTMLElement, opts: GameOptions = {}): Promise<Game> {
    const stage = await Stage.create({ parent: gameRoot, quality: opts.quality, preference: opts.preference });
    return new Game(stage, uiRoot, opts);
  }

  get mode(): GameMode {
    return this._mode;
  }

  // ------------------------------------------------------------ state machine

  start(seed: number = this.seed): void {
    this.seed = seed;
    this.trackView.reset();
    this.fx.reset();
    this.sim.reset(seed);
    this.stage.setOrigin(0);
    this.route(this.sim.drainEvents());
    this.cameraRig.snap(this.sim.state.player);
    this.input.clear();
    this.overTimer = -1;
    this._mode = 'running';
    this.ui.showHud();
    this.ui.updateHud(this.sim.state);
    this.audio.unlock();
    this.audio.setMusic('run');
  }

  pause(): void {
    if (this._mode !== 'running') return;
    this._mode = 'paused';
    this.ui.showPause();
    this.audio.setMusic('off');
  }

  resume(): void {
    if (this._mode !== 'paused') return;
    this.input.clear();
    this._mode = 'running';
    this.ui.showHud();
    this.audio.setMusic('run');
  }

  home(): void {
    this._mode = 'menu';
    this.ui.showMenu(this.best);
    this.audio.setMusic('menu');
  }

  // ------------------------------------------------------------------ frame

  /** One frame of game logic + view updates (rendering is done by the pixi ticker). */
  tick(dt: number): void {
    const st = this.sim.state;
    if (this._mode === 'running' && !st.over) {
      const real = this.input.consume();
      const input = this.autopilot ? this.autopilot(st) : real;
      const n = Math.max(1, Math.ceil(dt / MAX_SIM_STEP - 1e-6));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.sim.update(h, i === 0 ? input : NO_INPUT);
        if (st.over) break;
      }
      this.route(this.sim.drainEvents());
      this.audio.setIntensity((speedAt(st.time) - 13) / (SPEED_MAX - 13));
    } else {
      this.input.consume(); // drop input while not running
    }

    if (this.overTimer >= 0) {
      this.overTimer += dt;
      if (this.overTimer >= GAMEOVER_DELAY) {
        this.overTimer = -1;
        this.finishRun();
      }
    }

    this.updateViews(this._mode === 'paused' ? 0 : dt);
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

  // --------------------------------------------------------------- internal

  private updateViews(dt: number): void {
    const st = this.sim.state;
    const p = st.player;
    this.viewTime += dt;
    this.stage.rebase(p.s);
    const zone = this.forceZone ?? st.zone;
    const blend = this.forceZone === null ? st.zoneBlend : 0;
    this.atmosphere.update(zone, blend, dt);
    this.scenery.update(p.s, zone, blend, dt);
    this.trackView.update(st, dt);

    this.hero.update(p, st.powerups, dt);
    this.hero.node.position.z = this.stage.worldZ(p.s);
    this.chaser.update(st.chaser, this.viewTime, dt);
    this.chaser.node.position.x = p.x * 0.6 + 1.7; // off to one side so it never hides the hero
    this.chaser.node.position.z = this.stage.worldZ(p.s - st.chaser.gap);

    this.fx.update(st, dt);
    this.cameraRig.update(p, dt);
    if (this._mode === 'running') this.ui.updateHud(st);
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
          if (this.forceZone === null) this.ui.toast(ZONE_TITLES[e.index] ?? '');
          break;
        case 'land':
          if (e.hard) this.cameraRig.shake(0.15);
          break;
        case 'stumble':
          this.cameraRig.shake(0.35);
          break;
        case 'gameOver':
          this.cameraRig.shake(0.9);
          this.overReason = e.reason;
          this.overTimer = 0;
          break;
        default:
          break;
      }
    }
  }

  private finishRun(): void {
    const st = this.sim.state;
    const newBest = st.score > this.best.score;
    if (newBest) this.best.score = st.score;
    if (st.coins > this.best.coins) this.best.coins = st.coins;
    saveBest(this.best);
    this._mode = 'gameover';
    this.audio.setMusic('menu');
    this.ui.showGameOver({ score: st.score, coins: st.coins, best: this.best.score, newBest, reason: this.overReason });
  }
}
