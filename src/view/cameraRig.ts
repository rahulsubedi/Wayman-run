// Chase camera (placeholder tuning, final API): behind and above the player, looking down the
// street, with smoothed x/y follow and a decaying shake.
import type { PlayerState } from '../sim/types';
import type { Stage } from './stage';

const BACK = 6.8;
const HEIGHT = 3.9;
const LOOK_AHEAD = 9;
const LOOK_HEIGHT = 1.0;

export class CameraRig {
  private readonly stage: Stage;
  private x = 0;
  private y = 0;
  private trauma = 0;
  private time = 0;
  private readonly look = { x: 0, y: 0, z: 0 };

  constructor(stage: Stage) {
    this.stage = stage;
  }

  /** Jump straight to the target (new run, teleports). */
  snap(p: PlayerState): void {
    this.x = p.x * 0.75;
    this.y = p.y * 0.5;
    this.trauma = 0;
    this.update(p, 0);
  }

  update(p: PlayerState, dt: number): void {
    this.time += dt;
    const kx = 1 - Math.exp(-dt * 9);
    const ky = 1 - Math.exp(-dt * 5);
    this.x += (p.x * 0.75 - this.x) * kx;
    this.y += (p.y * 0.5 - this.y) * ky;

    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma;
    const sx = s * 0.35 * Math.sin(this.time * 47.3);
    const sy = s * 0.25 * Math.sin(this.time * 61.7 + 1.3);

    const z = this.stage.worldZ(p.s);
    const cam = this.stage.camera;
    cam.position.set(this.x + sx, HEIGHT + this.y + sy, z + BACK);
    this.look.x = this.x * 0.9 + sx * 0.5;
    this.look.y = LOOK_HEIGHT + this.y * 0.8;
    this.look.z = z - LOOK_AHEAD;
    cam.lookAt(this.look);
  }

  /** Add camera shake; `amount` ~0.3 small bump, 1 = crash. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }
}
