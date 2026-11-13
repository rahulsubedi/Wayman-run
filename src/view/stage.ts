// Stage: owns the pixi Application, the View3D, the world container and the s -> z mapping.
//
// - All game content goes under `stage.world` (never into `view.root` directly: it holds the camera).
// - Track coordinate s maps to world z ONLY through `stage.worldZ(s) = -(s - originS)`.
// - Every ~REBASE_DISTANCE metres the origin moves forward so GPU floats stay small.
//   Views that position nodes from `worldZ()` every frame need do nothing. Views that place nodes
//   once (scenery chunks, particles) subscribe with `onRebase(cb)` and add `dz` to their z.
import '@pixi/3d'; // registers the 3D extensions; must be imported before app.init()
import { Container3D, View3D } from '@pixi/3d';
import type { Camera3D, ShadowFilter, ShadowQuality } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { Application, RendererType } from 'pixi.js';
import type { WebGLRenderer } from 'pixi.js';
import type { Quality } from '../sim/types';

export type { Quality } from '../sim/types';

export type Backend = 'webgpu' | 'webgl';
export type BackendPreference = Backend | 'auto';

export interface QualitySettings {
  shadowQuality: ShadowQuality;
  shadowFilter: ShadowFilter;
  /** Cap on renderer resolution (also capped by devicePixelRatio and 2). */
  maxResolution: number;
  /** Bloom and other post effects. */
  post: boolean;
  /** MSAA. Fixed when the Application is created (from the initial quality). */
  antialias: boolean;
}

export const QUALITY_PRESETS: Readonly<Record<Quality, Readonly<QualitySettings>>> = {
  low: { shadowQuality: 'low', shadowFilter: 'hard', maxResolution: 1, post: false, antialias: false },
  medium: { shadowQuality: 'medium', shadowFilter: 'pcf', maxResolution: 1.5, post: true, antialias: true },
  high: { shadowQuality: 'high', shadowFilter: 'pcf', maxResolution: 2, post: true, antialias: true },
};

/** Re-base the origin when the player is this far past it. */
export const REBASE_DISTANCE = 500;

export type RebaseListener = (dz: number, originS: number) => void;

export interface StageOptions {
  /** Element the canvas is appended to; the canvas follows the window size. */
  parent: HTMLElement;
  quality?: Quality;
  preference?: BackendPreference;
}

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
  readonly backend: Backend;
  /** False on WebGL2 without EXT_color_buffer_float: float post effects would throw there. */
  readonly canDrawFloat: boolean;
  /** Bloom pass, or null when unsupported. Toggled by quality; tuned by Atmosphere. */
  readonly bloom: BloomEffect | null;

  private _quality: Quality;
  private _originS = 0;
  private listeners: RebaseListener[] = [];
  private readonly onResize = () => this.resize(); // devicePixelRatio can change (zoom, monitor)

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
        bloom = new BloomEffect({ intensity: 0.6, radius: 0.6, threshold: 1 });
        bloom.enabled = preset.post;
      } catch {
        bloom = null;
      }
    }
    this.bloom = bloom;

    // Tone mapping, shadow filter and the first post effect recompile shaders: set them here,
    // once, before the first frame.
    this.view = new View3D({
      autoResize: true,
      shadowQuality: preset.shadowQuality,
      shadowFilter: preset.shadowFilter,
      toneMapping: 'aces',
      exposure: 1,
      environment: { skyColor: 0xbcd4f0, groundColor: 0x6b6250, intensity: 0.7 },
      background: 0x9cc6e8,
      fog: { type: 'linear', color: 0x9cc6e8, near: 40, far: 150 },
      passes: bloom ? [bloom] : [],
    });
    app.stage.addChild(this.view);

    this.world = new Container3D({ label: 'world' });
    this.view.root.addChild(this.world);

    const cam = this.view.camera;
    cam.fov = 58;
    cam.near = 0.3;
    cam.far = 260;

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
        backgroundColor: 0x9cc6e8,
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

  /** Switch quality tier at runtime (shadow filter / first post effect recompile: not per frame). */
  setQuality(q: Quality): void {
    if (q === this._quality) return;
    this._quality = q;
    const p = QUALITY_PRESETS[q];
    this.view.shadowQuality = p.shadowQuality;
    if (this.view.shadowFilter !== p.shadowFilter) this.view.shadowFilter = p.shadowFilter;
    if (this.bloom) this.bloom.enabled = p.post;
    this.resize();
  }

  /** True when post effects are active (quality allows it and the device supports it). */
  get postEnabled(): boolean {
    return !!this.bloom && this.bloom.enabled;
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

  // ------------------------------------------------------------- rendering

  resize(): void {
    // `resizeTo: window` follows the window size; we only need to apply resolution changes.
    const r = targetResolution(this._quality);
    if (this.app.renderer.resolution !== r) this.app.renderer.resize(window.innerWidth, window.innerHeight, r);
  }

  /** Render one frame now (used by the debug hook after fast-forwarding). */
  render(): void {
    this.app.render();
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.app.destroy(true);
  }
}
