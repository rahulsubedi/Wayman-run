// Atmosphere (placeholder palettes, final API): sun, hemisphere fill, fog, background, exposure
// and bloom strength per zone, blended with zoneBlend.
//
// Tone mapping ('aces') and the bloom pass are created once by Stage before the first frame
// (both recompile shaders when changed). Everything here is a cheap per-frame property write:
// the fog / hemisphere objects are mutated in place, never replaced.
import { DirectionalLight } from '@pixi/3d';
import type { Fog, Hemisphere } from '@pixi/3d';
import { ZONE_COUNT } from '../sim/config';
import { mixHex } from './geom/color';
import type { Stage } from './stage';

export interface ZonePalette {
  sunColor: number;
  sunIntensity: number;
  /** Direction the sun light travels (normalised in use). */
  sunDir: [number, number, number];
  skyColor: number;
  groundColor: number;
  hemiIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  exposure: number;
  bloom: number;
}

export const ZONE_PALETTES: readonly ZonePalette[] = [
  // 0 market: bright midday
  {
    sunColor: 0xfff1d6, sunIntensity: 3.2, sunDir: [-0.45, -1, -0.35],
    skyColor: 0xbfe0ff, groundColor: 0x8a7458, hemiIntensity: 0.75,
    fogColor: 0xa9d3f2, fogNear: 45, fogFar: 170, exposure: 1.0, bloom: 0.45,
  },
  // 1 harbor: golden hour
  {
    sunColor: 0xffb46b, sunIntensity: 2.8, sunDir: [0.7, -0.45, -0.55],
    skyColor: 0xf7c59a, groundColor: 0x6e5040, hemiIntensity: 0.6,
    fogColor: 0xf0b48a, fogNear: 40, fogFar: 160, exposure: 1.05, bloom: 0.6,
  },
  // 2 night: night bazaar
  {
    sunColor: 0x9bb4ff, sunIntensity: 1.3, sunDir: [-0.3, -1, 0.2],
    skyColor: 0x46609e, groundColor: 0x2a2030, hemiIntensity: 0.85,
    fogColor: 0x1d2342, fogNear: 30, fogFar: 140, exposure: 1.25, bloom: 1.0,
  },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Atmosphere {
  readonly sun: DirectionalLight;
  private readonly stage: Stage;
  private readonly fog: Fog;
  private readonly hemi: Hemisphere;
  private readonly target = { x: 0, y: 0, z: 0 };

  constructor(stage: Stage) {
    this.stage = stage;
    const view = stage.view;
    // Reuse the objects the view was created with (same fog type => no recompile).
    this.fog = (view.fog ?? { type: 'linear', color: 0xa9d3f2, near: 45, far: 170 }) as Fog;
    if (!view.fog) view.fog = this.fog;
    const env = view.environment;
    this.hemi = env && 'skyColor' in env ? env : { skyColor: 0xbfe0ff, groundColor: 0x8a7458, intensity: 0.75 };
    if (view.environment !== this.hemi) view.environment = this.hemi;

    // Camera-following cascades keep shadows crisp near the player along an endless street.
    this.sun = new DirectionalLight({
      color: 0xfff1d6,
      intensity: 3,
      castShadow: true,
      shadow: { cascades: 2, maxDistance: 70, lambda: 0.6, bias: 0.0008, normalBias: 0.04 },
    });
    view.root.addChild(this.sun);
    this.update(0, 0, 0);
  }

  update(zone: number, zoneBlend: number, _dt: number): void {
    const a = ZONE_PALETTES[((zone % ZONE_COUNT) + ZONE_COUNT) % ZONE_COUNT];
    const b = ZONE_PALETTES[(zone + 1) % ZONE_COUNT];
    const t = Math.max(0, Math.min(1, zoneBlend));

    this.sun.color = mixHex(a.sunColor, b.sunColor, t);
    this.sun.intensity = lerp(a.sunIntensity, b.sunIntensity, t);
    const dx = lerp(a.sunDir[0], b.sunDir[0], t), dy = lerp(a.sunDir[1], b.sunDir[1], t), dz = lerp(a.sunDir[2], b.sunDir[2], t);
    this.sun.position.set(0, 0, 0);
    this.target.x = dx;
    this.target.y = dy;
    this.target.z = dz;
    this.sun.lookAt(this.target);

    this.hemi.skyColor = mixHex(a.skyColor, b.skyColor, t);
    this.hemi.groundColor = mixHex(a.groundColor, b.groundColor, t);
    this.hemi.intensity = lerp(a.hemiIntensity, b.hemiIntensity, t);

    const fogColor = mixHex(a.fogColor, b.fogColor, t);
    this.fog.color = fogColor;
    this.fog.near = lerp(a.fogNear, b.fogNear, t);
    this.fog.far = lerp(a.fogFar, b.fogFar, t);
    this.stage.view.background = fogColor;

    this.stage.view.exposure = lerp(a.exposure, b.exposure, t);
    if (this.stage.bloom) this.stage.bloom.intensity = lerp(a.bloom, b.bloom, t);
  }
}
