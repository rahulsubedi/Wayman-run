// Keyboard + touch swipe -> edge-triggered InputActions (placeholder, final API).
import type { InputActions } from '../sim/types';

const SWIPE_MIN_PX = 28;

export class Input {
  /** Called on P / Escape. */
  onPause?: () => void;

  private readonly target: HTMLElement;
  private pending: InputActions = { left: false, right: false, jump: false, roll: false };
  private out: InputActions = { left: false, right: false, jump: false, roll: false };
  private startX = 0;
  private startY = 0;
  private tracking = false;
  private pointerId = -1;

  constructor(target: HTMLElement) {
    this.target = target;
    window.addEventListener('keydown', this.onKey);
    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerup', this.onUp);
    target.addEventListener('pointercancel', this.onUp);
  }

  /**
   * Returns the actions requested since the last call and clears them. The returned object is
   * reused: read it before the next consume().
   */
  consume(): InputActions {
    const o = this.out;
    o.left = this.pending.left;
    o.right = this.pending.right;
    o.jump = this.pending.jump;
    o.roll = this.pending.roll;
    this.clear();
    return o;
  }

  /** Drop anything pending (e.g. when pausing). */
  clear(): void {
    const p = this.pending;
    p.left = p.right = p.jump = p.roll = false;
  }

  /** Inject actions programmatically (autopilot, tests). */
  press(action: keyof InputActions): void {
    this.pending[action] = true;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.target.removeEventListener('pointerdown', this.onDown);
    this.target.removeEventListener('pointermove', this.onMove);
    this.target.removeEventListener('pointerup', this.onUp);
    this.target.removeEventListener('pointercancel', this.onUp);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.pending.left = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.pending.right = true;
        break;
      case 'ArrowUp':
      case 'KeyW':
      case 'Space':
        this.pending.jump = true;
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.pending.roll = true;
        break;
      case 'KeyP':
      case 'Escape':
        this.onPause?.();
        return;
      default:
        return;
    }
    e.preventDefault();
  };

  private readonly onDown = (e: PointerEvent): void => {
    this.tracking = true;
    this.pointerId = e.pointerId;
    this.startX = e.clientX;
    this.startY = e.clientY;
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.tracking || e.pointerId !== this.pointerId) return;
    // Fire as soon as the swipe is long enough (feels faster than waiting for pointerup).
    if (this.detect(e.clientX - this.startX, e.clientY - this.startY)) this.tracking = false;
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.tracking || e.pointerId !== this.pointerId) return;
    this.tracking = false;
    this.detect(e.clientX - this.startX, e.clientY - this.startY);
  };

  private detect(dx: number, dy: number): boolean {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < SWIPE_MIN_PX) return false;
    if (ax > ay) this.pending[dx < 0 ? 'left' : 'right'] = true;
    else this.pending[dy < 0 ? 'jump' : 'roll'] = true;
    return true;
  }
}
