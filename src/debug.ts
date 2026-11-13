// Test hook + URL params for automated checks (brief section 6).
//
// URL params: ?autostart=1  seed=<n>  autopilot=1  quality=low|medium|high  zone=<0..2>  mute=1
//             renderer=webgl|webgpu (default: WebGPU when supported, else WebGL2)
// window.__wayman = { ready, state(), start(), advance(seconds), setAutopilot(on), errors }
import type { Game } from './game';
import { autopilot } from './sim/autopilot';
import type { Quality, SimState } from './sim/types';
import type { BackendPreference } from './view/stage';

export interface DebugParams {
  autostart: boolean;
  seed: number;
  autopilot: boolean;
  quality: Quality | undefined;
  zone: number | null;
  mute: boolean;
  renderer: BackendPreference;
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
  };
  window.__wayman = hook;
  return {
    hook,
    attach(g, params) {
      game = g;
      hook.game = g;
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
