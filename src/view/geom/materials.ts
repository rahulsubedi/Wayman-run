// Material kit. Every getter is CACHED: the same arguments return the same instance, so meshes
// that also share a Geometry3D are auto-instanced by the engine (one draw for all copies).
//
// Shared materials must be treated as read-only. If something needs to animate a material
// (pulse an emissive, fade alpha), ask for a private one with `unique(...)` or `material.clone()`,
// and accept that it no longer instances with the shared one.
//
// Curved world: every material created anywhere (this kit, `new Material3D(...)`, FlatMaterial,
// particles, custom `extraBits`) bends automatically through the hook in `worldBend.ts`; nothing
// to do here. The only rule: `fog: false` means "background at infinity, does not bend" (sky,
// sun, moon, clouds, far sky cards). Near geometry must keep the default `fog: true`, or opt in
// with `setMaterialBend(material, true)`. Long faces should be split into <= ~6 m pieces along
// the street so the bend can curve them (it moves vertices only).
import { FlatMaterial, Material3D } from '@pixi/3d';
import type { BaseMaterial3D } from '@pixi/3d';

const cache = new Map<string, BaseMaterial3D>();

function cached<T extends BaseMaterial3D>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) {
    m = make();
    m.label = key;
    cache.set(key, m);
  }
  return m;
}

export interface SurfaceOptions {
  roughness?: number;
  metallic?: number;
}

/**
 * The workhorse: lit PBR material that takes its colour from MeshBuilder vertex colours.
 * MeshBuilder already writes flat face normals, so `flatShading` is not needed.
 */
export function vertexColorMaterial(opts: SurfaceOptions = {}): Material3D {
  const roughness = opts.roughness ?? 0.85;
  const metallic = opts.metallic ?? 0;
  return cached(`vc:${roughness}:${metallic}`, () => new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness, metallic }));
}

/** Slightly shiny vertex-colour variant (vehicles, plastics, metal trims). */
export function vertexColorGloss(): Material3D {
  return vertexColorMaterial({ roughness: 0.45, metallic: 0.05 });
}

/** Plain lit colour (no vertex colours). */
export function solid(color: number, opts: SurfaceOptions = {}): Material3D {
  const roughness = opts.roughness ?? 0.8;
  const metallic = opts.metallic ?? 0;
  return cached(`solid:${color}:${roughness}:${metallic}`, () => new Material3D({ baseColor: color, roughness, metallic }));
}

/**
 * Emissive glow. Bloom's threshold is 1.0 in linear light, so `strength` > 1 blooms (when the
 * quality tier has post effects on). `color` is sRGB hex.
 */
export function glow(color: number, strength = 2.5): Material3D {
  return cached(
    `glow:${color}:${strength}`,
    () => new Material3D({ baseColor: color, roughness: 0.6, emissive: { color, strength } }),
  );
}

/** Emissive glow tinted by vertex colours (emissive colour itself stays uniform). */
export function glowVertexColor(color: number, strength = 1.5): Material3D {
  return cached(
    `glowvc:${color}:${strength}`,
    () => new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.6, emissive: { color, strength } }),
  );
}

/** See-through glass (alpha-blended: no depth writes, casts no shadow). */
export function glass(tint = 0x9fd8ff, alpha = 0.35): Material3D {
  return cached(
    `glass:${tint}:${alpha}`,
    () => new Material3D({ baseColor: tint, roughness: 0.1, metallic: 0, alphaMode: 'blend', alpha }),
  );
}

/** Unlit vertex-colour material (signs, sky cards, decals). `fog: false` for sky/background art. */
export function unlitVertexColor(fog = true): FlatMaterial {
  return cached(`unlitvc:${fog}`, () => new FlatMaterial({ baseColor: 0xffffff, vertexColors: true, fog }));
}

/** Unlit plain colour. */
export function unlit(color: number, fog = true): FlatMaterial {
  return cached(`unlit:${color}:${fog}`, () => new FlatMaterial({ baseColor: color, fog }));
}

/** Unlit, alpha-blended (soft particles, light cones, shadow blobs). */
export function unlitBlend(color: number, alpha = 0.5): FlatMaterial {
  return cached(`unlitblend:${color}:${alpha}`, () => new FlatMaterial({ baseColor: color, alphaMode: 'blend', alpha }));
}

/** A private, uncached material (for animating it). The caller owns and destroys it. */
export function unique<T extends BaseMaterial3D>(make: () => T): T {
  return make();
}

/** Number of distinct cached materials (debug/perf overlay). */
export function materialCount(): number {
  return cache.size;
}
