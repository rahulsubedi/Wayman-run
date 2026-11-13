import type { SimEvent } from './types';

/**
 * Double-buffered event queue: `drain()` hands out the filled buffer and starts writing into the
 * other one, so steady-state draining allocates nothing. The returned array is only valid until
 * the next `drain()`.
 */
export class EventQueue {
  private a: SimEvent[] = [];
  private b: SimEvent[] = [];

  push(e: SimEvent): void {
    this.a.push(e);
  }

  drain(): SimEvent[] {
    const out = this.a;
    this.a = this.b;
    this.a.length = 0;
    this.b = out;
    return out;
  }

  clear(): void {
    this.a.length = 0;
    this.b.length = 0;
  }
}
