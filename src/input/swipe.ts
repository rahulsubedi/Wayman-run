// Pure swipe recogniser (no DOM). Feed it pointer positions; it reports a direction the moment
// the finger has travelled `threshold` pixels from its anchor, then re-anchors at the finger so
// a second swipe within the same touch works (left, then up, without lifting).
//
// Direction lock: after a swipe fires, further travel in the SAME direction drags the anchor
// along with the finger (one long drag = one lane change). Only a perpendicular move, or a
// reversal of `threshold` px from the furthest point, fires again.

export type SwipeDir = 'left' | 'right' | 'up' | 'down';

export interface SwipeOptions {
  /** Pixels of travel from the anchor before a swipe fires. */
  threshold: number;
}

export class SwipeRecognizer {
  threshold: number;
  private ax = 0;
  private ay = 0;
  private active = false;
  /** 0 none, 1 horizontal, 2 vertical. */
  private lockAxis = 0;
  private lockSign = 0;

  constructor(opts: Partial<SwipeOptions> = {}) {
    this.threshold = opts.threshold ?? 24;
  }

  get tracking(): boolean {
    return this.active;
  }

  begin(x: number, y: number): void {
    this.active = true;
    this.ax = x;
    this.ay = y;
    this.lockAxis = 0;
    this.lockSign = 0;
  }

  /** Returns the swipe direction if this move completed one, else null. Allocation-free. */
  move(x: number, y: number): SwipeDir | null {
    if (!this.active) return null;
    let dx = x - this.ax;
    let dy = y - this.ay;

    // Same-direction continuation: slide the anchor so we do not fire twice.
    if (this.lockAxis === 1 && dx * this.lockSign > 0) {
      this.ax = x;
      dx = 0;
    } else if (this.lockAxis === 2 && dy * this.lockSign > 0) {
      this.ay = y;
      dy = 0;
    }

    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx < this.threshold && ady < this.threshold) return null;

    let dir: SwipeDir;
    if (adx >= ady) {
      dir = dx < 0 ? 'left' : 'right';
      this.lockAxis = 1;
      this.lockSign = dx < 0 ? -1 : 1;
    } else {
      dir = dy < 0 ? 'up' : 'down';
      this.lockAxis = 2;
      this.lockSign = dy < 0 ? -1 : 1;
    }
    this.ax = x;
    this.ay = y;
    return dir;
  }

  end(): void {
    this.active = false;
    this.lockAxis = 0;
    this.lockSign = 0;
  }
}
