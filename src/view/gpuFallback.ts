// WebGPU safety net used by Stage (see the header of stage.ts for the whole flow).
//
// - `GpuWatchdog` listens to the live WebGPU device: a lost device, any GPU error in the first
//   BOOT_FRAMES rendered frames, or a burst of errors later means the picture is broken. It then
//   stores a flag, notifies listeners and reloads the page; the next boot sees the flag and starts on
//   WebGL2. An isolated late error only flags the NEXT session (no reload mid-run).
// - Flags: device loss is often transient (driver reset, GPU process crash), so it only lasts for
//   this tab session (sessionStorage). Validation / shader / pipeline errors are a property of the
//   browser + GPU + build, so they persist for FLAG_TTL_MS (localStorage).
// - Test hook: `window.__waymanGpuFault = 'init' | 'probe' | 'shader' | 'validation' | 'lost'`
//   (set before the game boots, e.g. with Playwright's addInitScript) forces each failure path on
//   WebGPU: init throws / the probe frame gets a validation error / the probe compiles broken WGSL /
//   an uncaptured validation error after boot / the device is destroyed after boot. No effect on WebGL.

const FLAG_KEY = 'wayman.webgpu.failed';
const FLAG_TTL_MS = 3 * 24 * 3600 * 1000;
/** Errors within this many rendered frames after boot fall back at once. */
const BOOT_FRAMES = 300;
/** Later on, this many errors within BURST_MS fall back too. */
const BURST_COUNT = 5;
const BURST_MS = 5000;
/** A test-hook fault fires at this rendered frame. */
const FAULT_FRAME = 3;

export type GpuFault = 'init' | 'probe' | 'shader' | 'validation' | 'lost';

/** The subset of GPUDevice used here (the project does not pull in the WebGPU type package). */
export interface GpuDeviceLike {
  readonly lost: Promise<{ reason?: string; message: string }>;
  readonly queue: { onSubmittedWorkDone(): Promise<void> };
  pushErrorScope(filter: 'validation' | 'internal' | 'out-of-memory'): void;
  popErrorScope(): Promise<{ message: string } | null>;
  addEventListener(type: 'uncapturederror', cb: (e: Event & { error?: { message: string } }) => void): void;
  removeEventListener(type: 'uncapturederror', cb: (e: Event & { error?: { message: string } }) => void): void;
  createBuffer(desc: { size: number; usage: number }): unknown;
  destroy(): void;
}

export function gpuFault(): GpuFault | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { __waymanGpuFault?: GpuFault }).__waymanGpuFault ?? null;
}

/** The stored reason WebGPU failed earlier (this session, or persistently within the TTL), or null. */
export function gpuFailFlag(): string | null {
  try {
    const session = sessionStorage.getItem(FLAG_KEY);
    if (session) return session;
    const raw = localStorage.getItem(FLAG_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { reason?: string; t?: number };
    if (typeof v.t === 'number' && Date.now() - v.t < FLAG_TTL_MS) return v.reason ?? 'unknown';
    localStorage.removeItem(FLAG_KEY);
  } catch {
    // storage blocked: no memory of failures, the probe still protects each boot
  }
  return null;
}

export function setGpuFailFlag(reason: string, persistent: boolean): void {
  const r = reason.slice(0, 300);
  try {
    sessionStorage.setItem(FLAG_KEY, r);
    if (persistent) localStorage.setItem(FLAG_KEY, JSON.stringify({ reason: r, t: Date.now() }));
  } catch {
    // ignore
  }
}

const SCOPES = ['validation', 'internal', 'out-of-memory'] as const;

export function gpuPushScopes(device: GpuDeviceLike): void {
  for (const f of SCOPES) device.pushErrorScope(f);
}

/** Pops the scopes pushed by `gpuPushScopes`; returns the first error message, or null. */
export async function gpuPopScopes(device: GpuDeviceLike): Promise<string | null> {
  let first: string | null = null;
  for (let i = 0; i < SCOPES.length; i++) {
    try {
      const e = await device.popErrorScope();
      if (e && !first) first = e.message || 'GPU error';
    } catch (err) {
      first ??= `error scope failed: ${String((err as Error)?.message ?? err)}`;
    }
  }
  return first;
}

export class GpuWatchdog {
  /** Called with the reason right before the reload. */
  readonly listeners: Array<(reason: string) => void> = [];
  private frames = 0;
  private recent: number[] = [];
  private disposed = false;
  private failed = false;
  private readonly onError = (e: Event & { error?: { message: string } }) => this.error(e.error?.message ?? 'GPU error');

  constructor(
    private readonly device: GpuDeviceLike,
    private readonly preference: string,
  ) {
    device.addEventListener('uncapturederror', this.onError);
    void device.lost.then((info) => {
      if (this.disposed) return; // our own teardown
      this.fail(`WebGPU device lost (${info.reason ?? 'unknown'}): ${info.message}`, false);
    });
  }

  /** Call once per rendered frame. */
  frame(): void {
    this.frames++;
    if (this.frames !== FAULT_FRAME) return;
    const fault = gpuFault();
    if (fault === 'validation') this.device.createBuffer({ size: 4, usage: 0 });
    else if (fault === 'lost') this.device.destroy();
  }

  private error(message: string): void {
    if (this.disposed || this.failed) return;
    if (this.frames <= BOOT_FRAMES) {
      this.fail(`WebGPU error during startup: ${message}`, true);
      return;
    }
    const now = Date.now();
    this.recent.push(now);
    while (this.recent.length && now - this.recent[0] > BURST_MS) this.recent.shift();
    if (this.recent.length >= BURST_COUNT) {
      this.fail(`repeated WebGPU errors: ${message}`, true);
    } else {
      // keep playing; the next session starts on WebGL2
      console.warn(`[stage] WebGPU error (next start uses WebGL2): ${message}`);
      setGpuFailFlag(`WebGPU error: ${message}`, true);
    }
  }

  private fail(reason: string, persistent: boolean): void {
    if (this.failed) return;
    this.failed = true;
    console.warn(`[stage] ${reason}; reloading on WebGL2`);
    setGpuFailFlag(reason, persistent);
    for (const cb of this.listeners) {
      try {
        cb(reason);
      } catch {
        // never block the fallback
      }
    }
    const url = new URL(location.href);
    // an explicit ?renderer=webgpu would loop: let the flag decide on the next boot
    if (url.searchParams.get('renderer') === 'webgpu' || this.preference === 'webgpu') url.searchParams.delete('renderer');
    location.replace(url.toString());
  }

  dispose(): void {
    this.disposed = true;
    this.device.removeEventListener('uncapturederror', this.onError);
  }
}
