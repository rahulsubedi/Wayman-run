// Keyboard + touch/mouse swipe (+ optional gamepad) -> edge-triggered InputActions.
import type { InputActions } from '../sim/types';
import { SwipeRecognizer, type SwipeDir } from './swipe';

export { SwipeRecognizer } from './swipe';
export type { SwipeDir } from './swipe';

/** Elements whose pointer events must never reach the game. */
const UI_SELECTOR = 'button, select, input, a, [data-no-swipe]';

export class Input {
  /** Called on P / Escape / gamepad Start. */
  onPause?: () => void;

  private readonly target: HTMLElement;
  private readonly pending: InputActions = { left: false, right: false, jump: false, roll: false };
  private readonly out: InputActions = { left: false, right: false, jump: false, roll: false };
  private readonly swipe: SwipeRecognizer;
  private pointerId = -1;
  private gamepadSeen = false;
  private padPrev = 0;

  constructor(target: HTMLElement) {
    this.target = target;
    // Threshold scales a little with screen size: ~6% of the short side, clamped.
    const short = Math.min(window.innerWidth || 400, window.innerHeight || 400);
    this.swipe = new SwipeRecognizer({ threshold: Math.max(22, Math.min(42, short * 0.06)) });

    const style = target.style as CSSStyleDeclaration & { webkitUserSelect?: string; webkitTouchCallout?: string };
    style.touchAction = 'none';
    style.userSelect = 'none';
    style.webkitUserSelect = 'none';
    style.webkitTouchCallout = 'none';

    window.addEventListener('keydown', this.onKey);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onPadConnect);
    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerup', this.onUp);
    target.addEventListener('pointercancel', this.onUp);
    target.addEventListener('lostpointercapture', this.onUp);
    target.addEventListener('contextmenu', this.onContext);
    target.addEventListener('touchmove', this.onTouchMove, { passive: false });
    target.addEventListener('touchstart', this.onTouchMove, { passive: false });
    if (typeof navigator.getGamepads === 'function') {
      // Some browsers only report pads that were already connected at load.
      for (const p of navigator.getGamepads()) if (p) this.gamepadSeen = true;
    }
  }

  /**
   * Returns the actions requested since the last call and clears them. The returned object is
   * reused: read it before the next consume().
   */
  consume(): InputActions {
    if (this.gamepadSeen) this.pollGamepad();
    const o = this.out;
    const p = this.pending;
    o.left = p.left;
    o.right = p.right;
    o.jump = p.jump;
    o.roll = p.roll;
    p.left = p.right = p.jump = p.roll = false;
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
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onPadConnect);
    const t = this.target;
    t.removeEventListener('pointerdown', this.onDown);
    t.removeEventListener('pointermove', this.onMove);
    t.removeEventListener('pointerup', this.onUp);
    t.removeEventListener('pointercancel', this.onUp);
    t.removeEventListener('lostpointercapture', this.onUp);
    t.removeEventListener('contextmenu', this.onContext);
    t.removeEventListener('touchmove', this.onTouchMove);
    t.removeEventListener('touchstart', this.onTouchMove);
  }

  // ----------------------------------------------------------------- keyboard

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return; // never swallow browser shortcuts
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
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

  private readonly onBlur = (): void => {
    this.endSwipe();
  };

  // ------------------------------------------------------------ touch / mouse

  private readonly onContext = (e: Event): void => e.preventDefault();

  /** Stops scrolling, pull-to-refresh and pinch-zoom on the game surface. */
  private readonly onTouchMove = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault();
  };

  private readonly onDown = (e: PointerEvent): void => {
    const el = e.target as Element | null;
    if (el && el !== this.target && el.closest?.(UI_SELECTOR)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerId = e.pointerId;
    this.swipe.begin(e.clientX, e.clientY);
    try {
      this.target.setPointerCapture(e.pointerId);
    } catch {
      // not capturable (synthetic event): the swipe still works while the pointer stays over the target
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const d = this.swipe.move(e.clientX, e.clientY);
    if (d) this.apply(d);
  };

  private readonly onUp = (e: Event): void => {
    const id = (e as PointerEvent).pointerId;
    if (id !== undefined && id !== this.pointerId) return;
    this.endSwipe();
  };

  private endSwipe(): void {
    this.swipe.end();
    this.pointerId = -1;
  }

  private apply(d: SwipeDir): void {
    switch (d) {
      case 'left':
        this.pending.left = true;
        break;
      case 'right':
        this.pending.right = true;
        break;
      case 'up':
        this.pending.jump = true;
        break;
      case 'down':
        this.pending.roll = true;
        break;
    }
  }

  // ----------------------------------------------------------------- gamepad

  private readonly onPadConnect = (): void => {
    this.gamepadSeen = true;
  };

  private pollGamepad(): void {
    const pads = navigator.getGamepads();
    let bits = 0;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p) continue;
      const b = p.buttons;
      const ax = p.axes;
      const dn = (n: number) => (b[n] ? b[n].pressed : false);
      if (dn(14) || (ax[0] ?? 0) < -0.6) bits |= 1;
      if (dn(15) || (ax[0] ?? 0) > 0.6) bits |= 2;
      if (dn(12) || dn(0) || dn(2) || (ax[1] ?? 0) < -0.6) bits |= 4;
      if (dn(13) || dn(1) || dn(3) || (ax[1] ?? 0) > 0.6) bits |= 8;
      if (dn(9)) bits |= 16;
    }
    const edge = bits & ~this.padPrev;
    this.padPrev = bits;
    if (edge & 1) this.pending.left = true;
    if (edge & 2) this.pending.right = true;
    if (edge & 4) this.pending.jump = true;
    if (edge & 8) this.pending.roll = true;
    if (edge & 16) this.onPause?.();
  }
}
