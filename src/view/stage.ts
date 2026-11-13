// Stage: owns the pixi Application, the View3D, the world container and the s -> z mapping.
//
// - All game content goes under `stage.world` (never into `view.root` directly: it holds the camera).
// - Track coordinate s maps to world z ONLY through `stage.worldZ(s) = -(s - originS)`.
// - Every ~REBASE_DISTANCE metres the origin moves forward so GPU floats stay small.
//   Views that position nodes from `worldZ()` every frame need do nothing. Views that place nodes
//   once (scenery chunks, particles) subscribe with `onRebase(cb)` and add `dz` to their z.
// - `overlay` is a 2D layer drawn above the 3D view (screen flashes, vignette).
// - Quality tiers (`QUALITY_PRESETS`) drive shadows, post, resolution, effect density; an optional
//   frame-time watchdog (`enableAutoQuality` + `sampleFrameTime`) steps the tier down on slow devices.
import '@pixi/3d'; // registers the 3D extensions; must be imported before app.init()
import { Container3D, View3D } from '@pixi/3d';
import type { Camera3D, ShadowFilter, ShadowQuality } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { Application, Container, RendererType } from 'pixi.js';
import type { WebGLRenderer } from 'pixi.js';
import type { Quality } from '../sim/types';

export type { Quality } from '../sim/types';

export type Backend = 'webgpu' | 'webgl';
export type BackendPreference = Backend | 'auto';

/** Extent of the hero-following shadow box, metres relative to the hero (run direction is -Z). */
export interface ShadowReach {
  /** Metres behind the hero (+Z). */
  back: number;
  /** Metres ahead of the hero (-Z). */
  ahead: number;
  /** Half-width in x around the street centre. */
  side: number;
  /** Top of the box (world y); casters above it may lose their shadow. */
  top: number;
}

export interface QualitySettings {
  shadowQuality: ShadowQuality;
  shadowFilter: ShadowFilter;
  shadowReach: Readonly<ShadowReach>;
  /** Cap on renderer resolution (also capped by devicePixelRatio and 2). */
  maxResolution: number;
  /** Bloom and other post effects. */
  post: boolean;
  /** MSAA. Fixed when the Application is created (from the initial quality). */
  antialias: boolean;
  /** Particle density multiplier (0..1) for Fx. */
  fxDensity: number;
  /** 2D screen vignette / speed vignette (one full-screen blended quad). */
  vignette: boolean;
}

export const QUALITY_PRESETS: Readonly<Record<Quality, Readonly<QualitySettings>>> = {
  low: {
    shadowQuality: 'low', shadowFilter: 'hard', shadowReach: { back: 6, ahead: 30, side: 9, top: 10 },
    maxResolution: 1, post: false, antialias: false, fxDensity: 0.4, vignette: false,
  },
  medium: {
    shadowQuality: 'medium', shadowFilter: 'pcf', shadowReach: { back: 8, ahead: 42, side: 11, top: 10 },
    maxResolution: 1.5, post: true, antialias: true, fxDensity: 0.7, vignette: true,
  },
  high: {
    shadowQuality: 'high', shadowFilter: 'pcf', shadowReach: { back: 10, ahead: 56, side: 12, top: 10 },
    maxResolution: 2, post: true, antialias: true, fxDensity: 1, vignette: true,
  },
};

const TIER_ORDER: readonly Quality[] = ['low', 'medium', 'high'];

/** Re-base the origin when the player is this far past it. */
export const REBASE_DISTANCE = 500;

/** Camera far plane. The sky dome sits just inside it (see view/sky). */
export const CAMERA_FAR = 420;

export type RebaseListener = (dz: number, originS: number) => void;
export type QualityListener = (q: Quality, settings: Readonly<QualitySettings>) => void;

export interface StageOptions {
  /** Element the canvas is appended to; the canvas follows the window size. */
  parent: HTMLElement;
  quality?: Quality;
  preference?: BackendPreference;
}

/** Auto quality: frames ignored after enabling/stepping, frames averaged, and the slow threshold. */
const AUTO_WARMUP_FRAMES = 60;
const AUTO_SAMPLE_FRAMES = 150;
const AUTO_SLOW_MS = 1000 / 42;

async function pickBackend(pref: BackendPreference): Promise<Backend> {
  if (pref === 'webgl') return 'webgl';
  // @pixi/3d on WebGPU needs 'indirect-first-instance' or app.init throws: check first (documented guard).
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    const adapter = await gpu?.requestAdapter();
    if (adapter?.features.has('indirect-first-instance')) return 'webgpu';
  } catch {
    // fall through
  }
  return 'webgl';
}

function targetResolution(q: Quality): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(dpr, 2, QUALITY_PRESETS[q].maxResolution);
}

export class Stage {
  readonly app: Application;
  readonly view: View3D;
  /** Parent of all game content (scenery, track entities, hero, fx). */
  readonly world: Container3D;
  /** 2D layer above the 3D view (screen-space effects). Children are laid out in CSS pixels. */
  readonly overlay: Container;
  readonly backend: Backend;
  /** False on WebGL2 without EXT_color_buffer_float: float post effects would throw there. */
  readonly canDrawFloat: boolean;
  /** Bloom pass, or null when unsupported. Toggled by quality; tuned by Atmosphere. */
  readonly bloom: BloomEffect | null;
  /**
   * World position of the gameplay focus (the hero), kept by CameraRig and shifted on re-base.
   * Atmosphere centres the shadow box on it.
   */
  readonly focus = { x: 0, y: 0, z: 0 };

  private _quality: Quality;
  private _originS = 0;
  private listeners: RebaseListener[] = [];
  private qualityListeners: QualityListener[] = [];
  private beforeRender: Array<() => void> = [];
  private readonly onResize = () => this.resize(); // devicePixelRatio can change (zoom, monitor)

  // auto quality
  private autoOn = false;
  private autoInert = false;
  private userChoseQuality = false;
  private autoFrames = 0;
  private autoSum = 0;

  private constructor(app: Application, backend: Backend, quality: Quality) {
    this.app = app;
    this.backend = backend;
    this._quality = quality;
    const preset = QUALITY_PRESETS[quality];

    this.canDrawFloat =
      app.renderer.type !== RendererType.WEBGL ||
      Boolean((app.renderer as WebGLRenderer).context?.extensions?.colorBufferFloat);

    let bloom: BloomEffect | null = null;
    if (this.canDrawFloat) {
      try {
        // 5 levels at half resolution: wide soft halos for lanterns/neon at night.
        bloom = new BloomEffect({ intensity: 0.45, radius: 0.65, threshold: 1, levels: 5, resolution: 0.5 });
      } catch {
        bloom = null;
      }
    }
    this.bloom = bloom;

    // Tone mapping, fog type, environment kind, shadow filter and the first post effect recompile
    // shaders: set them here, once, before the first frame.
    let view: View3D;
    const make = (passes: BloomEffect[]) =>
      new View3D({
        autoResize: true,
        shadowQuality: preset.shadowQuality,
        shadowFilter: preset.shadowFilter,
        toneMapping: 'aces',
        exposure: 1,
        environment: { skyColor: 0xa8cdf5, groundColor: 0x9a8466, intensity: 0.8 },
        background: 0xcfe3f2,
        fog: { type: 'linear', color: 0xcfe3f2, near: 50, far: 190 },
        passes,
      });
    try {
      view = make(bloom ? [bloom] : []);
    } catch {
      // A post effect the device cannot build must never stop the game.
      view = make([]);
      this.bloom = null;
    }
    this.view = view;
    if (this.bloom) this.bloom.enabled = preset.post;
    app.stage.addChild(this.view);

    this.overlay = new Container({ label: 'overlay' });
    this.overlay.eventMode = 'none';
    app.stage.addChild(this.overlay);

    this.world = new Container3D({ label: 'world' });
    this.view.root.addChild(this.world);

    const cam = this.view.camera;
    cam.fov = 58;
    cam.near = 0.3;
    cam.far = CAMERA_FAR;

    // Runs at the start of every render (ticker or manual), after all game updates: things that
    // must match the final camera pose of the frame (sky dome, shadow box) hook in here.
    this.view.onRender = () => {
      for (const cb of this.beforeRender) cb();
    };

    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  /** Creates the Application (WebGPU when safely available, else WebGL2) and the View3D. */
  static async create(opts: StageOptions): Promise<Stage> {
    const quality = opts.quality ?? 'high';
    const preset = QUALITY_PRESETS[quality];
    let backend = await pickBackend(opts.preference ?? 'auto');
    const init = async (preference: Backend): Promise<Application> => {
      const app = new Application();
      await app.init({
        preference,
        resizeTo: window,
        resolution: targetResolution(quality),
        autoDensity: true,
        antialias: preset.antialias,
        backgroundColor: 0xcfe3f2,
        powerPreference: 'high-performance',
      });
      return app;
    };
    let app: Application;
    try {
      app = await init(backend);
    } catch (err) {
      if (backend === 'webgl') throw err;
      console.warn('WebGPU init failed, falling back to WebGL2', err);
      backend = 'webgl';
      app = await init('webgl');
    }
    backend = app.renderer.type === RendererType.WEBGPU ? 'webgpu' : 'webgl';
    opts.parent.appendChild(app.canvas);
    return new Stage(app, backend, quality);
  }

  get camera(): Camera3D {
    return this.view.camera;
  }

  get quality(): Quality {
    return this._quality;
  }

  /** The active tier's settings. */
  get settings(): Readonly<QualitySettings> {
    return QUALITY_PRESETS[this._quality];
  }

  /** Viewport aspect (width / height) in CSS pixels. */
  get aspect(): number {
    const s = this.app.screen;
    return s.height > 0 ? s.width / s.height : 16 / 9;
  }

  /**
   * Switch quality tier at runtime. Safe at any time, but the shadow filter and enabling/disabling
   * post rebuild shaders/graph once: a settings action, not a per-frame one. A user choice turns
   * the automatic fallback off.
   */
  setQuality(q: Quality): void {
    this.autoOn = false;
    this.userChoseQuality = true;
    this.applyQuality(q);
  }

  /** Called with the new tier after every quality change (Atmosphere, Fx re-tune themselves). */
  onQualityChange(cb: QualityListener): () => void {
    this.qualityListeners.push(cb);
    return () => {
      const i = this.qualityListeners.indexOf(cb);
      if (i >= 0) this.qualityListeners.splice(i, 1);
    };
  }

  private applyQuality(q: Quality): void {
    if (q === this._quality) return;
    this._quality = q;
    const p = QUALITY_PRESETS[q];
    this.view.shadowQuality = p.shadowQuality;
    if (this.view.shadowFilter !== p.shadowFilter) this.view.shadowFilter = p.shadowFilter;
    if (this.bloom && this.bloom.enabled !== p.post) {
      try {
        this.bloom.enabled = p.post;
      } catch {
        // never let a post toggle take the game down
      }
    }
    this.resize();
    for (const cb of this.qualityListeners) cb(q, p);
  }

  /** True when post effects are active (quality allows it and the device supports it). */
  get postEnabled(): boolean {
    return !!this.bloom && this.bloom.enabled;
  }

  // ---------------------------------------------------------- auto quality

  /**
   * Turn on the automatic fallback: `sampleFrameTime()` then steps the tier down (high -> medium
   * -> low) when real frames average slower than ~42 fps. Call it when a run starts. After a user
   * `setQuality()` it does nothing. If `render()` (the debug fast-forward path) is called while it
   * is on, it goes permanently inert, so debug/automation frames are never judged.
   */
  enableAutoQuality(on = true): void {
    this.autoOn = on && !this.userChoseQuality;
    this.autoFrames = 0;
    this.autoSum = 0;
  }

  get autoQualityEnabled(): boolean {
    return this.autoOn && !this.autoInert;
  }

  /**
   * Feed one REAL frame time (ms, e.g. `ticker.deltaMS`) while a run is playing. Cheap; no-op unless
   * enabled. Ignores the first frames (shader warm-up), averages a window, steps down if slow.
   */
  sampleFrameTime(ms: number): void {
    if (!this.autoOn || this.autoInert || !(ms > 0)) return;
    this.autoFrames++;
    if (this.autoFrames <= AUTO_WARMUP_FRAMES) return;
    this.autoSum += Math.min(ms, 250);
    if (this.autoFrames < AUTO_WARMUP_FRAMES + AUTO_SAMPLE_FRAMES) return;
    const avg = this.autoSum / AUTO_SAMPLE_FRAMES;
    this.autoFrames = 0;
    this.autoSum = 0;
    const i = TIER_ORDER.indexOf(this._quality);
    if (avg > AUTO_SLOW_MS && i > 0) this.applyQuality(TIER_ORDER[i - 1]);
    else this.autoOn = false; // fast enough (or already low): stop measuring
  }

  // ------------------------------------------------------------ coordinates

  get originS(): number {
    return this._originS;
  }

  /** Track distance -> world z. The ONLY place this mapping lives. */
  worldZ(s: number): number {
    return -(s - this._originS);
  }

  /** World z -> track distance (inverse of worldZ). */
  trackS(z: number): number {
    return this._originS - z;
  }

  /**
   * Call once per frame (before views update) with the player's s. Moves the origin forward in
   * REBASE_DISTANCE steps and notifies listeners. Returns true when a rebase happened.
   */
  rebase(playerS: number): boolean {
    if (playerS - this._originS < REBASE_DISTANCE) return false;
    const step = Math.floor((playerS - this._originS) / REBASE_DISTANCE) * REBASE_DISTANCE;
    this.setOrigin(this._originS + step);
    return true;
  }

  /** Put the origin at `s` (e.g. 0 for a new run). Notifies listeners with the z shift. */
  setOrigin(s: number): void {
    const dz = s - this._originS; // worldZ(x) grows by dz for every x
    if (dz === 0) return;
    this._originS = s;
    this.focus.z += dz;
    for (const cb of this.listeners) cb(dz, s);
  }

  /** Subscribe to origin changes. `dz` must be ADDED to the z of nodes placed with worldZ(). */
  onRebase(cb: RebaseListener): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Run `cb` at the start of every render, after the frame's game updates (both the ticker and
   * `render()`); use it for things that must follow the final camera pose.
   */
  onBeforeRender(cb: () => void): () => void {
    this.beforeRender.push(cb);
    return () => {
      const i = this.beforeRender.indexOf(cb);
      if (i >= 0) this.beforeRender.splice(i, 1);
    };
  }

  // ------------------------------------------------------------- rendering

  resize(): void {
    // `resizeTo: window` follows the window size; we only need to apply resolution changes.
    const r = targetResolution(this._quality);
    if (this.app.renderer.resolution !== r) this.app.renderer.resize(window.innerWidth, window.innerHeight, r);
  }

  /** Render one frame now (used by the debug hook after fast-forwarding). */
  render(): void {
    // Manual rendering means frames are not real time: the frame-time watchdog must not judge them.
    if (this.autoOn) this.autoInert = true;
    this.app.render();
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.app.destroy(true);
  }
}
