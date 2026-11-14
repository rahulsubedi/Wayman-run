// Test hook + URL params for automated checks (brief section 6).
//
// URL params: ?autostart=1  seed=<n>  autopilot=1  quality=low|medium|high  zone=<0..2>  mute=1
//             renderer=webgl|webgpu (default: WebGPU when supported, else WebGL2)
//             bend=0|1   curved-world effect on/off (only if the renderer provides it)
// window.__wayman = { ready, state(), start(), advance(seconds), setAutopilot(on), errors,
//   game, mode(), pause(), resume(), home(), seed(n),
//   forceStumble(), forceCrash(reason?), forcePickup(kind), setZone(z|null), bend(on), stats() }
import type { Game, GameMode } from './game';
import { autopilot } from './sim/autopilot';
import type { PowerupKind, Quality, SimState } from './sim/types';
import type { BackendPreference } from './view/stage';

export interface DebugParams {
  autostart: boolean;
  seed: number;
  autopilot: boolean;
  quality: Quality | undefined;
  zone: number | null;
  mute: boolean;
  renderer: BackendPreference;
  /** `bend=0|1`; null when the param is absent. */
  bend: boolean | null;
}

export interface WaymanHook {
  ready: Promise<void>;
  state(): SimState;
  start(): void;
  advance(seconds: number): void;
  setAutopilot(on: boolean): void;
  errors: string[];
  /** The live Game (for poking at internals in ad-hoc checks; not part of the stable contract). */
  game: Game | null;
  mode(): GameMode;
  pause(): void;
  resume(): void;
  home(): void;
  /** Force the stumble state (as after a side hit): hero stagger, drone, danger meter. */
  forceStumble(): void;
  /** End the run now ('crash' by default; 'caught' shows the drone catching up). */
  forceCrash(reason?: 'crash' | 'caught'): void;
  /** Grant a power-up as if just picked up. */
  forcePickup(kind: PowerupKind): void;
  /** Force the visual zone (0..2), or null to follow the run. */
  setZone(zone: number | null): void;
  /** Curved-world effect on/off; returns false when the renderer does not provide it. */
  bend(on: boolean): boolean;
  /** View/pool bookkeeping: live nodes vs sim entities, visible nodes, particles ... */
  stats(): ReturnType<Game['viewStats']>;
}

declare global {
  interface Window {
    __wayman?: WaymanHook;
  }
}

export function readParams(search: string = location.search): DebugParams {
  const q = new URLSearchParams(search);
  const quality = q.get('quality');
  const zone = q.get('zone');
  const renderer = q.get('renderer');
  const seed = Number(q.get('seed'));
  return {
    autostart: q.get('autostart') === '1',
    seed: Number.isFinite(seed) && q.has('seed') ? seed : 1,
    autopilot: q.get('autopilot') === '1',
    quality: quality === 'low' || quality === 'medium' || quality === 'high' ? quality : undefined,
    zone: zone !== null && /^[0-2]$/.test(zone) ? Number(zone) : null,
    mute: q.get('mute') === '1',
    renderer: renderer === 'webgl' || renderer === 'webgpu' ? renderer : 'auto',
    bend: q.get('bend') === '1' ? true : q.get('bend') === '0' ? false : null,
  };
}

/**
 * Installs window.__wayman immediately (so `errors` captures boot failures). Call `attach(game)`
 * once the game exists; `ready` resolves after that and one rendered frame.
 */
export function installDebugHook(): { hook: WaymanHook; attach(game: Game, params: DebugParams): void; fail(err: unknown): void } {
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.error?.stack ?? e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String((e.reason as Error)?.stack ?? e.reason)));
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let game: Game | null = null;
  const need = (): Game => {
    if (!game) throw new Error('__wayman: game not ready yet (await __wayman.ready)');
    return game;
  };
  const hook: WaymanHook = {
    ready,
    errors,
    state: () => need().sim.state,
    start: () => need().start(),
    advance: (seconds: number) => need().advance(seconds),
    setAutopilot: (on: boolean) => {
      need().autopilot = on ? autopilot : null;
    },
    game: null,
    mode: () => need().mode,
    pause: () => need().pause(),
    resume: () => need().resume(),
    home: () => need().home(),
    forceStumble: () => need().forceStumble(),
    forceCrash: (reason = 'crash') => need().forceGameOver(reason),
    forcePickup: (kind) => need().forcePickup(kind),
    setZone: (zone) => {
      need().forceZone = zone;
    },
    bend: (on) => applyBend(need(), on),
    stats: () => need().viewStats(),
  };
  window.__wayman = hook;
  return {
    hook,
    attach(g, params) {
      game = g;
      hook.game = g;
      if (params.bend !== null) applyBend(g, params.bend);
      if (params.autopilot) g.autopilot = autopilot;
      if (params.autostart) g.start(params.seed);
      g.stage.render();
      requestAnimationFrame(() => resolve());
    },
    fail(err) {
      errors.push(String((err as Error)?.stack ?? err));
      reject(err);
    },
  };
}

// ------------------------------------------------------------------ autopilot

/** The bot lives in the pure sim module (src/sim/autopilot.ts); re-exported for existing importers. */
export { autopilot };

// ----------------------------------------------------------------------- curved world

/**
 * The curved-world shader effect is being added to the stage in parallel, so its API is
 * feature-detected by name at runtime. Calls the first matching function with 0/1 (works for
 * both boolean and amount signatures) or assigns a matching property.
 */
function applyBend(g: Game, on: boolean): boolean {
  const stage = g.stage as unknown as Record<string, unknown>;
  for (const name of ['setWorldBend', 'setBend', 'setCurvedWorld', 'setWorldCurve', 'setCurve']) {
    if (name in stage && typeof stage[name] === 'function') {
      (stage[name] as (v: number) => void).call(stage, on ? 1 : 0);
      return true;
    }
  }
  for (const name of ['worldBend', 'bend', 'curvedWorld']) {
    if (name in stage && typeof stage[name] !== 'function') {
      stage[name] = on ? 1 : 0;
      return true;
    }
  }
  return false;
}
