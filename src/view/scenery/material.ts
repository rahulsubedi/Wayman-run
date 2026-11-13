// Scenery materials.
//
// One lit vertex-colour PBR material carries ALL static street geometry (ground, buildings, props,
// backdrop). A small shader bit adds emission from vertex alpha: a face painted with alpha < 1
// glows with `rgb * (1 - alpha) * GLOW_MAX`. That lets night windows, lanterns, neon and lamp
// heads live inside the same merged geometry as their building / prop, so they cost no extra draw
// calls, and the bloom pass (threshold 1.0 linear) picks up anything that emits above 1.
// Opaque alpha mode ignores alpha for blending, so the encoding is invisible otherwise.
import { Material3D } from '@pixi/3d';
import type { ShaderBit } from '@pixi/3d';
import { GLOW_MAX } from './kit';

const glowBit: ShaderBit = {
  name: 'waymanSceneryVertexGlow',
  bindings: { material: { glow: 'f32' } },
  gpu: { fragment: { material: /* wgsl */ `{ emissive += input.vColor.rgb * (1.0 - input.vColor.a) * material.glow; }` } },
  gl: { fragment: { material: /* glsl */ `{ emissive += vColor.rgb * (1.0 - vColor.a) * material.glow; }` } },
};

let main: Material3D | null = null;
let water: Material3D | null = null;

/** The shared scenery material (lit, vertex colours, vertex-alpha emission). */
export function sceneryMaterial(): Material3D {
  if (!main) {
    main = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.86, metallic: 0, extraBits: [glowBit] });
    main.label = 'scenery';
    main.data.glow = GLOW_MAX;
  }
  return main;
}

/** Glossy variant for water (sun glints) - harbour sea only. */
export function waterMaterial(): Material3D {
  if (!water) {
    water = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.22, metallic: 0.15, extraBits: [glowBit] });
    water.label = 'scenery-water';
    water.data.glow = GLOW_MAX;
  }
  return water;
}
