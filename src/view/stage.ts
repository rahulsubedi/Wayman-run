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
// - Curved world (geom/worldBend.ts): every fogged material bends away with distance as a pure
//   projection warp. Driven automatically from the true track distance given to `rebase()`;
//   `setWorldBend()` overrides it, `setWorldBendEnabled(false)` turns it off (no recompiles).
// - Backend: `DEFAULT_BACKEND` decides what 'auto' (no `?renderer=`) means. It is WebGL2: the
//   WebGPU path renders the same frames (verified frame by frame) but has only been run on a
//   software adapter, gives no measured CPU win, and a lost device forces a page reload (below).
//   `?renderer=webgpu` opts in. Safety net whenever WebGPU is attempted:
//   1. init: `app.init` throwing on WebGPU falls back to WebGL2;
//   2. probe: before the game builds anything, one frame with the project's custom-shader materials,
//      a shadow-casting light and the post chain is rendered inside GPU error scopes; any
//      validation / internal / out-of-memory error rebuilds the Application on WebGL2;
//   3. watchdog: afterwards, a lost device (the engine cannot recover from one: its GPU objects stay
//      bound to the dead device) or GPU errors early in the session (or in a burst later) store a
//      flag and reload the page, which then starts on WebGL2 (see `gpuFallback.ts`).
//   `stage.backend` is the backend actually running, `stage.fallbackReason` why WebGPU was not used.
import '@pixi/3d'; // registers the 3D extensions; must be imported before app.init()
import { Container3D, DirectionalLight, Material3D, Mesh3D, View3D } from '@pixi/3d';
import type { Camera3D, ShadowFilter, ShadowQuality } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { Application, Container, RendererType } from 'pixi.js';
import type { WebGLRenderer } from 'pixi.js';
import type { Quality } from '../sim/types';
import { BendCullFrustum, autoBend, installWorldBend, writeBendUniform } from './geom/worldBend';
import type { BendValues } from './geom/worldBend';
import { MeshBuilder } from './geom/meshBuilder';
import { unlitVertexColor, vertexColorMaterial } from './geom/materials';
import { fresnelGlow, glowVC } from './models/kit';
import { sceneryMaterial } from './scenery/material';
import { GpuWatchdog, gpuFailFlag, gpuFault, gpuPopScopes, gpuPushScopes, setGpuFailFlag } from './gpuFallback';
import type { GpuDeviceLike } from './gpuFallback';

export type { Quality } from '../sim/types';

export type Backend = 'webgpu' | 'webgl';
/** 'auto' = `DEFAULT_BACKEND`, with WebGPU only when the adapter supports it. */
export type BackendPreference = Backend | 'auto';

/**
 * What 'auto' picks. 'webgpu' = WebGPU when the adapter supports it (with the probe / watchdog
 * fallback), else WebGL2. Kept on 'webgl' until WebGPU has been checked on real GPUs.
 */
export const DEFAULT_BACKEND: Backend = 'webgl';

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

async function pickBackend(pref: BackendPreference): Promise<{ backend: Backend; why: string | null }> {
  if (pref === 'webgl') return { backend: 'webgl', why: null };
  // A WebGPU failure earlier (this session, or a persistent one in the last days) means WebGL2,
  // unless WebGPU was asked for explicitly (`?renderer=webgpu`).
  const failed = gpuFailFlag();
  if (pref === 'auto' && (failed || DEFAULT_BACKEND === 'webgl')) {
    return { backend: 'webgl', why: failed ? `WebGPU failed earlier: ${failed}` : null };
  }
  // @pixi/3d on WebGPU needs 'indirect-first-instance' or app.init throws: check first (documented guard).
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    if (!gpu) return { backend: 'webgl', why: 'WebGPU not available' };
    const adapter = await gpu.requestAdapter();
    if (adapter?.features.has('indirect-first-instance')) return { backend: 'webgpu', why: null };
    return { backend: 'webgl', why: adapter ? 'adapter lacks indirect-first-instance' : 'no WebGPU adapter' };
  } catch (err) {
    return { backend: 'webgl', why: `WebGPU adapter request failed: ${errText(err)}` };
  }
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

function gpuDeviceOf(app: Application): GpuDeviceLike | null {
  if (app.renderer.type !== RendererType.WEBGPU) return null;
  return (app.renderer as unknown as { gpu?: { device?: GpuDeviceLike } }).gpu?.device ?? null;
}

/**
 * Renders one frame with the materials whose shaders differ per backend (custom WGSL bits, world
 * bend, vertex colours, fog, unlit, blended) plus a shadow-casting light and the post chain, inside
 * GPU error scopes. Returns the first GPU error message, or null when the device reported nothing.
 * The cached materials it touches are the game's own, so their pipelines are warm afterwards.
 */
async function probeWebGPU(stage: Stage, device: GpuDeviceLike): Promise<string | null> {
  const fault = gpuFault();
  const geo = new MeshBuilder({ seed: 1 }).box(1, 1, 1, { color: 0xffffff }).build();
  const mats = [vertexColorMaterial(), unlitVertexColor(), sceneryMaterial(), glowVC(), fresnelGlow(0x66ddff)];
  const probe = new Container3D({ label: 'gpu-probe' });
  mats.forEach((material, i) => {
    probe.addChild(new Mesh3D({ geometry: geo, material, position: { x: (i - 2) * 1.2, y: 0, z: -6 } }));
  });
  if (fault === 'shader') {
    // test hook: a material whose WGSL does not compile
    const broken = '{ albedo = waymanUndefinedSymbol; }';
    const material = new Material3D({
      vertexColors: true,
      extraBits: [{ name: 'waymanBrokenProbe', gpu: { fragment: { material: broken } }, gl: { fragment: { material: broken } } }],
    });
    probe.addChild(new Mesh3D({ geometry: geo, material, position: { x: 0, y: 1.2, z: -6 } }));
  }
  const sun = new DirectionalLight({ intensity: 1, castShadow: true, position: { x: 2, y: 6, z: -2 } });
  sun.lookAt({ x: 0, y: 0, z: -6 });
  probe.addChild(sun);
  stage.world.addChild(probe);
  const bloom = stage.bloom;
  const bloomWas = bloom?.enabled ?? false;
  gpuPushScopes(device);
  let error: string | null = null;
  try {
    if (bloom) bloom.enabled = true; // compile the post chain even on tiers without it
    if (fault === 'probe') device.createBuffer({ size: 4, usage: 0 }); // test hook: a validation error
    stage.app.render();
    await device.queue.onSubmittedWorkDone();
  } catch (err) {
    error = `probe frame threw: ${errText(err)}`;
  }
  error = (await gpuPopScopes(device)) ?? error;
  try {
    if (bloom) bloom.enabled = bloomWas;
  } catch {
    // ignore
  }
  stage.world.removeChild(probe);
  probe.destroy({ children: true });
  geo.destroy();
  return error;
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
  /** Why WebGPU is not in use although it was preferred (null when on the preferred backend). */
  fallbackReason: string | null = null;
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
  private watchdog: GpuWatchdog | null = null;

  // curved world
  /** Bend actually applied this frame (0/0 when disabled); read by the cull frustum. */
  private readonly bendNow: BendValues = { down: 0, side: 0 };
  private readonly bendManual: BendValues = { down: 0, side: 0 };
  private bendAuto = true;
  private bendOn = true;
  private bendInstalled = false;
  private trackPos = 0;

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

    // Curved world: hook every scene material before the first frame (one shader variant, so
    // tuning or toggling never recompiles) and cull against a frustum widened for the bend.
    this.bendInstalled = installWorldBend(app.renderer);
    if (this.bendInstalled) {
      cam.cullFrustum = new BendCullFrustum(cam, this.bendNow, () => this.view.fog?.far ?? CAMERA_FAR);
    }

    // Runs at the start of every render (ticker or manual), after all game updates: things that
    // must match the final camera pose of the frame (sky dome, shadow box) hook in here.
    this.view.onRender = () => {
      this.watchdog?.frame();
      this.updateBend();
      for (const cb of this.beforeRender) cb();
    };

    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  /**
   * Creates the Application (WebGPU when safely available, else WebGL2) and the View3D. Any WebGPU
   * failure during init or the probe frame rebuilds everything on WebGL2 (see the header).
   */
  static async create(opts: StageOptions): Promise<Stage> {
    const quality = opts.quality ?? 'high';
    const preset = QUALITY_PRESETS[quality];
    const pref = opts.preference ?? 'auto';
    const picked = await pickBackend(pref);
    let why = picked.why;
    const init = async (preference: Backend): Promise<Application> => {
      if (preference === 'webgpu' && gpuFault() === 'init') throw new Error('test hook: WebGPU init failure');
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
    const failed = (reason: string) => {
      console.warn(`[stage] ${reason}; falling back to WebGL2`);
      why = reason;
    };

    let app: Application | null = null;
    if (picked.backend === 'webgpu') {
      try {
        app = await init('webgpu');
      } catch (err) {
        failed(`WebGPU init failed: ${errText(err)}`);
        setGpuFailFlag(why ?? 'WebGPU init failed', false); // this tab session: skip the retry on reload
      }
    }
    if (app && app.renderer.type === RendererType.WEBGPU) {
      const device = gpuDeviceOf(app);
      let stage: Stage | null = null;
      let error: string | null = device ? null : 'WebGPU renderer has no device';
      if (device) {
        try {
          stage = new Stage(app, 'webgpu', quality);
          error = await probeWebGPU(stage, device);
        } catch (err) {
          error = `WebGPU setup failed: ${errText(err)}`;
        }
      }
      if (!error && stage && device) {
        opts.parent.appendChild(app.canvas);
        stage.watchdog = new GpuWatchdog(device, pref);
        return stage;
      }
      failed(error ?? 'WebGPU probe failed');
      // GPU errors on the probe are a property of browser + GPU + build: remember them for days
      setGpuFailFlag(why ?? 'WebGPU probe failed', true);
      try {
        if (stage) stage.destroy();
        else app.destroy(true);
      } catch {
        // a broken device may throw while tearing down: the WebGL2 app below is independent
      }
      app = null;
    }
    app ??= await init('webgl');
    const backend: Backend = app.renderer.type === RendererType.WEBGPU ? 'webgpu' : 'webgl';
    opts.parent.appendChild(app.canvas);
    const stage = new Stage(app, backend, quality);
    stage.fallbackReason = backend === 'webgl' && pref !== 'webgl' ? why : null;
    return stage;
  }

  /**
   * Called (just before the page reloads onto WebGL2) when the WebGPU watchdog gives up on the
   * device, so the game can stop or save what it needs. The reload itself is not cancellable.
   */
  onBackendFailure(cb: (reason: string) => void): void {
    this.watchdog?.listeners.push(cb);
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
    this.trackPos = playerS;
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

  // ------------------------------------------------------------ curved world

  /**
   * Override the curved-world amount (metres of offset at 100 m ahead of the camera: `down` drop,
   * `side` swing, + = right). Missing fields keep their current value. `null` returns to the
   * automatic driver (the default), which follows the track distance passed to `rebase()`.
   */
  setWorldBend(b: Partial<BendValues> | null): void {
    if (b === null) {
      this.bendAuto = true;
      return;
    }
    if (this.bendAuto) {
      this.bendManual.down = this.bendNow.down;
      this.bendManual.side = this.bendNow.side;
      if (!this.bendOn) autoBend(this.trackPos, this.bendManual);
    }
    this.bendAuto = false;
    if (b.down !== undefined) this.bendManual.down = b.down;
    if (b.side !== undefined) this.bendManual.side = b.side;
  }

  /** Turn the curved world on/off (quality or debug switch, e.g. `?bend=0`). Free at any time. */
  setWorldBendEnabled(on: boolean): void {
    this.bendOn = on;
  }

  /** The bend applied to the current frame (both 0 when disabled or unsupported). */
  get worldBend(): Readonly<BendValues> {
    return this.bendNow;
  }

  /** Whether the curved world is on (and supported by this engine build). */
  get worldBendEnabled(): boolean {
    return this.bendOn && this.bendInstalled;
  }

  private updateBend(): void {
    const b = this.bendNow;
    if (!this.bendOn || !this.bendInstalled) {
      b.down = 0;
      b.side = 0;
    } else if (this.bendAuto) {
      autoBend(this.trackPos, b);
    } else {
      b.down = this.bendManual.down;
      b.side = this.bendManual.side;
    }
    writeBendUniform(this.view.fog, b, this.bendOn && this.bendInstalled);
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
    this.watchdog?.dispose();
    this.watchdog = null;
    window.removeEventListener('resize', this.onResize);
    this.app.destroy(true);
  }
}
