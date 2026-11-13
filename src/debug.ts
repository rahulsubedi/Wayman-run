// Test hook + URL params for automated checks (brief section 6).
//
// URL params: ?autostart=1  seed=<n>  autopilot=1  quality=low|medium|high  zone=<0..2>  mute=1
//             renderer=webgl|webgpu (default: WebGPU when supported, else WebGL2)
// window.__wayman = { ready, state(), start(), advance(seconds), setAutopilot(on), errors }
import type { Game } from './game';
import { LANES, OBSTACLE_DIMS } from './sim/config';
import type { Entity, InputActions, Lane, ObstacleKind, Quality, SimState } from './sim/types';
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

const BLOCKING: ReadonlySet<ObstacleKind> = new Set(['blocker', 'truck', 'bus', 'busOncoming']);
const out: InputActions = { left: false, right: false, jump: false, roll: false };

function isObstacleEntity(e: Entity): e is Entity & { kind: ObstacleKind } {
  return e.kind in OBSTACLE_DIMS;
}

/** Simple bot: dodges blockers by lane, jumps hurdles, rolls under gantries, drifts toward coins. */
export function autopilot(state: SimState): InputActions {
  out.left = out.right = out.jump = out.roll = false;
  const p = state.player;
  const v = Math.max(1, p.speed);
  const front = p.s + 0.3;
  const look = v * 1.4 + 8;

  // Distance to the nearest blocking obstacle per lane (Infinity = clear), and nearest passable one.
  const block: Record<Lane, number> = { [-1]: Infinity, 0: Infinity, 1: Infinity };
  let near: { kind: ObstacleKind; d: number } | null = null;
  const coinLane: Record<Lane, number> = { [-1]: Infinity, 0: Infinity, 1: Infinity };
  for (const e of state.entities) {
    if (!e.active) continue;
    const d = e.s - e.len / 2 - front; // gap to its near edge
    const far = e.s + e.len / 2 - (p.s - 0.3);
    if (far < -0.2 || d > look) continue;
    if (isObstacleEntity(e)) {
      if (BLOCKING.has(e.kind)) block[e.lane] = Math.min(block[e.lane], d);
      else if (e.lane === p.lane && d > -0.6 && (!near || d < near.d)) near = { kind: e.kind, d };
    } else if (e.kind === 'coin' && d > 0) {
      coinLane[e.lane] = Math.min(coinLane[e.lane], d);
    }
  }

  // Lane choice: go toward the lane whose next blocker is furthest (ties: stay / nearer lane).
  let best: Lane = p.lane;
  for (const l of LANES) {
    const better = block[l] > block[best] + 0.5 || (block[l] === block[best] && Math.abs(l - p.lane) < Math.abs(best - p.lane));
    if (better) best = l;
  }
  const danger = block[p.lane] / v < 1.2;
  if (!danger && block[p.lane] === Infinity) {
    // Drift toward coins in a fully clear neighbouring lane.
    for (const l of LANES) {
      if (Math.abs(l - p.lane) === 1 && block[l] === Infinity && coinLane[l] < 25 && coinLane[l] < coinLane[p.lane]) best = l;
    }
  } else if (!danger) {
    best = p.lane;
  }
  if (best !== p.lane) {
    if (best < p.lane) out.left = true;
    else out.right = true;
  }

  if (near) {
    const t = near.d / v;
    if (near.kind === 'hurdle' && p.grounded && t < 0.28 && t > 0.06) out.jump = true;
    if (near.kind === 'overhead' && p.action !== 'roll' && t < 0.3) out.roll = true;
  }
  return out;
}
