// Atmosphere: the three zone looks (sun/moon key, fill, hemisphere, fog, exposure, bloom, sky),
// blended smoothly by zone + zoneBlend, plus the hero-following shadow box.
//
// Tone mapping ('aces'), fog type, environment kind, shadow filter and the bloom pass are created
// once by Stage before the first frame (each recompiles shaders when changed). Everything here is a
// cheap per-frame property write: the fog / hemisphere objects are mutated in place, never replaced.
//
// Shadows: one shadow map over a fixed-size box that follows the hero (`stage.focus`). The engine
// snaps a fixed box's centre to whole shadow texels and the box's size never changes while the sun
// direction is steady, so edges do not shimmer or swim as the camera moves (cascades would resize
// with the camera FOV, which widens with speed). Box length and map size scale with quality.
import { Box, DirectionalLight, Vector3 } from '@pixi/3d';
import type { Fog, Hemisphere } from '@pixi/3d';
import { ZONE_COUNT } from '../sim/config';
import type { Quality } from '../sim/types';
import { mixHex } from './geom/color';
import { Sky, type SkyState } from './sky/sky';
import type { QualitySettings, Stage } from './stage';

type V3 = [number, number, number];

export interface ZonePalette {
  /** Key light (sun by day, moon at night). */
  sunColor: number;
  sunIntensity: number;
  /** Direction the key light travels (normalised in use). */
  sunDir: V3;
  /** Shadowless fill light (lantern glow at night, sky bounce at golden hour). */
  fillColor: number;
  fillIntensity: number;
  fillDir: V3;
  /** Hemisphere ambient. */
  skyColor: number;
  groundColor: number;
  hemiIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  exposure: number;
  bloom: number;
  bloomThreshold: number;
  /** Sky look; the haze band always takes `fogColor`. */
  sky: Omit<SkyState, 'haze'>;
}

export const ZONE_PALETTES: readonly ZonePalette[] = [
  // 0 Market Street: bright midday, warm white sun high on the right, clear blue sky.
  {
    sunColor: 0xfff2dc, sunIntensity: 3.4, sunDir: [-0.55, -1, 0.42],
    fillColor: 0xcfe2ff, fillIntensity: 0.25, fillDir: [0.5, -0.4, -0.6],
    skyColor: 0x9fc8f5, groundColor: 0xb09070, hemiIntensity: 0.8,
    fogColor: 0xcde4f5, fogNear: 55, fogFar: 200,
    exposure: 1.0, bloom: 0.3, bloomThreshold: 1.1,
    sky: {
      zenith: 0x1f6fd8, upper: 0x56a2ee, horizon: 0xa9d4f7, glow: 0xfff6e0, glowStrength: 0.35,
      sunAz: 42, sunEl: 58, sunColor: 0xfff8ea, sun: 1,
      moonAz: -30, moonEl: 30, moon: 0, stars: 0,
      cloudTint: 0xffffff, clouds: 1,
    },
  },
  // 1 Harbor Front: golden hour, low orange sun front-right, long shadows across the road.
  {
    sunColor: 0xffa04a, sunIntensity: 3.6, sunDir: [-0.193, -0.375, 0.907],
    fillColor: 0x86a8ff, fillIntensity: 0.6, fillDir: [0.35, -0.4, -1],
    skyColor: 0x8fb0d8, groundColor: 0x9a5a3e, hemiIntensity: 0.62,
    fogColor: 0xf6b48c, fogNear: 42, fogFar: 175,
    exposure: 1.05, bloom: 0.5, bloomThreshold: 1.0,
    sky: {
      zenith: 0x2f7f9e, upper: 0xc590b8, horizon: 0xffa98f, glow: 0xffd27a, glowStrength: 0.95,
      sunAz: 6, sunEl: 6, sunColor: 0xffd59a, sun: 1,
      moonAz: -40, moonEl: 30, moon: 0, stars: 0,
      cloudTint: 0xffbfa6, clouds: 0.85,
    },
  },
  // 2 Night Bazaar: cool moonlight key, warm lantern fill, purple-blue fog, stars.
  {
    sunColor: 0x9db8ff, sunIntensity: 1.5, sunDir: [0.45, -0.8, 0.5],
    fillColor: 0xffa860, fillIntensity: 0.55, fillDir: [0.0, -0.35, -1],
    skyColor: 0x5468b0, groundColor: 0x4a3248, hemiIntensity: 1.0,
    fogColor: 0x30306a, fogNear: 38, fogFar: 160,
    exposure: 1.3, bloom: 0.9, bloomThreshold: 0.95,
    sky: {
      zenith: 0x050a24, upper: 0x121c4e, horizon: 0x3a3478, glow: 0x7f86d8, glowStrength: 0.4,
      sunAz: 30, sunEl: -20, sunColor: 0xffffff, sun: 0,
      moonAz: -3, moonEl: 12, moon: 1, stars: 1,
      cloudTint: 0x34407a, clouds: 0.45,
    },
  },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Atmosphere {
  readonly sun: DirectionalLight;
  /** Shadowless fill (see ZonePalette.fillColor). */
  readonly fill: DirectionalLight;
  readonly sky: Sky;
  private readonly stage: Stage;
  private readonly fog: Fog;
  private readonly hemi: Hemisphere;
  private readonly target = { x: 0, y: 0, z: 0 };
  private readonly shadowBox = new Box(new Vector3(-12, -1, -60), new Vector3(12, 10, 10));
  private readonly skyState: SkyState;
  private lastZone = -1;
  private lastBlend = -1;
  /** Extra sky-glow / exposure kick (0..1), e.g. a flash on zone change; decays on its own. */
  private pulse = 0;

  constructor(stage: Stage) {
    this.stage = stage;
    const view = stage.view;
    // Reuse the objects the view was created with (same fog type => no recompile).
    this.fog = (view.fog ?? { type: 'linear', color: 0xcde4f5, near: 55, far: 200 }) as Fog;
    if (!view.fog) view.fog = this.fog;
    const env = view.environment;
    this.hemi = env && 'skyColor' in env ? env : { skyColor: 0x9fc8f5, groundColor: 0xb09070, intensity: 0.8 };
    if (view.environment !== this.hemi) view.environment = this.hemi;

    this.sun = new DirectionalLight({
      label: 'sun',
      color: 0xfff2dc,
      intensity: 3.4,
      castShadow: true,
      // Bias is a fraction of the shadow depth range (box depth + 4x its half-width toward the
      // light, ~150 m): 0.00025 ≈ 4 cm keeps contact shadows attached (no peter-panning); the
      // default normal bias (3 texels, scales with map size) removes acne on grazing faces.
      shadow: { bounds: this.shadowBox, bias: 0.00025 },
    });
    view.root.addChild(this.sun);
    this.fill = new DirectionalLight({ label: 'fill', color: 0xffa860, intensity: 0, castShadow: false });
    view.root.addChild(this.fill);

    this.sky = new Sky(stage);
    const p0 = ZONE_PALETTES[0];
    this.skyState = { ...p0.sky, haze: p0.fogColor };

    stage.onBeforeRender(() => this.placeShadowBox());
    stage.onQualityChange((_q: Quality, _s: Readonly<QualitySettings>) => this.placeShadowBox());
    this.update(0, 0, 0);
  }

  /** Brief brightening of the sky/exposure (0..1), e.g. on entering a new zone. Optional. */
  flash(amount = 0.6): void {
    this.pulse = Math.min(1, this.pulse + amount);
  }

  update(zone: number, zoneBlend: number, dt: number): void {
    const zi = ((Math.floor(zone) % ZONE_COUNT) + ZONE_COUNT) % ZONE_COUNT;
    const a = ZONE_PALETTES[zi];
    const b = ZONE_PALETTES[(zi + 1) % ZONE_COUNT];
    const raw = Math.max(0, Math.min(1, zoneBlend));
    const t = raw * raw * (3 - 2 * raw); // ease in/out across the blend distance

    this.pulse = Math.max(0, this.pulse - dt * 1.5);
    this.sky.update(dt);

    if (zi === this.lastZone && t === this.lastBlend && this.pulse === 0) return;
    this.lastZone = zi;
    this.lastBlend = t;

    this.sun.color = mixHex(a.sunColor, b.sunColor, t);
    this.sun.intensity = lerp(a.sunIntensity, b.sunIntensity, t);
    this.aim(this.sun, a.sunDir, b.sunDir, t);
    this.fill.color = mixHex(a.fillColor, b.fillColor, t);
    this.fill.intensity = lerp(a.fillIntensity, b.fillIntensity, t);
    this.fill.visible = this.fill.intensity > 0.01;
    this.aim(this.fill, a.fillDir, b.fillDir, t);

    this.hemi.skyColor = mixHex(a.skyColor, b.skyColor, t);
    this.hemi.groundColor = mixHex(a.groundColor, b.groundColor, t);
    this.hemi.intensity = lerp(a.hemiIntensity, b.hemiIntensity, t);

    const fogColor = mixHex(a.fogColor, b.fogColor, t);
    this.fog.color = fogColor;
    this.fog.near = lerp(a.fogNear, b.fogNear, t);
    this.fog.far = lerp(a.fogFar, b.fogFar, t);
    this.stage.view.background = fogColor;

    this.stage.view.exposure = lerp(a.exposure, b.exposure, t) * (1 + this.pulse * 0.15);
    const bloom = this.stage.bloom;
    if (bloom) {
      bloom.intensity = lerp(a.bloom, b.bloom, t);
      bloom.threshold = lerp(a.bloomThreshold, b.bloomThreshold, t);
    }

    const s = this.skyState, sa = a.sky, sb = b.sky;
    s.zenith = mixHex(sa.zenith, sb.zenith, t);
    s.upper = mixHex(sa.upper, sb.upper, t);
    s.horizon = mixHex(sa.horizon, sb.horizon, t);
    s.haze = fogColor;
    s.glow = mixHex(sa.glow, sb.glow, t);
    s.glowStrength = lerp(sa.glowStrength, sb.glowStrength, t) + this.pulse * 0.3;
    s.sunAz = lerp(sa.sunAz, sb.sunAz, t);
    s.sunEl = lerp(sa.sunEl, sb.sunEl, t);
    s.sunColor = mixHex(sa.sunColor, sb.sunColor, t);
    // fade the disc out/in rather than letting it slide below the horizon in view
    s.sun = lerp(sa.sun, sb.sun, smoothEdge(t, sa.sun > sb.sun));
    s.moonAz = lerp(sa.moonAz, sb.moonAz, t);
    s.moonEl = lerp(sa.moonEl, sb.moonEl, t);
    s.moon = lerp(sa.moon, sb.moon, smoothEdge(t, sa.moon > sb.moon));
    s.stars = lerp(sa.stars, sb.stars, t);
    s.cloudTint = mixHex(sa.cloudTint, sb.cloudTint, t);
    s.clouds = lerp(sa.clouds, sb.clouds, t);
    this.sky.apply(s);
  }

  private aim(light: DirectionalLight, da: V3, db: V3, t: number): void {
    let x = lerp(da[0], db[0], t), y = lerp(da[1], db[1], t), z = lerp(da[2], db[2], t);
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    if (y > -0.2) {
      // keep the key above the horizon mid-blend (a grazing light would stretch shadows forever)
      y = -0.2;
    }
    light.position.set(0, 0, 0);
    this.target.x = x;
    this.target.y = y;
    this.target.z = z;
    light.lookAt(this.target);
  }

  /** Centre the shadow box on the hero, with this tier's reach. Runs right before each render. */
  private placeShadowBox(): void {
    const r = this.stage.settings.shadowReach;
    const f = this.stage.focus;
    const min = this.shadowBox.min, max = this.shadowBox.max;
    min.set(-r.side, -0.5, f.z - r.ahead);
    max.set(r.side, r.top, f.z + r.back); // constant size: no texel-size changes
  }
}

/** Visibility fades favour the end that is hidden, so a disc never lingers half-faded. */
function smoothEdge(t: number, fadingOut: boolean): number {
  return fadingOut ? Math.min(1, t * 1.6) : Math.max(0, (t - 0.375) * 1.6);
}
