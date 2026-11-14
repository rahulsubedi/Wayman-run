// Curved world ("world bend"): the far street drops toward the horizon and swings left/right.
//
// HOW IT WORKS
// - Purely a projection warp. One vertex shader bit (`worldBendBit`) runs in the LAST vertex slot
//   (`end`) and adds a world-space offset to the clip position only:
//       d      = max(|cameraZ - worldZ| - 6 m, 0)       (metres along the street past a 6 m dead zone)
//       offset = (side, -down, 0) * (d / 100 m)^2       (so `down`/`side` are metres ~100 m out)
//       clip  += viewProjection * vec4(offset, 0)
//   `worldPosition` (and with it the `vPosition` varying used for lighting, shadow-map lookup and
//   fog) is left untouched. The shadow pass draws casters with its own unbent shader, receivers
//   look shadows up at their unbent world position, then both are warped identically on screen:
//   shadows stay glued to their objects. Near the camera d^2 is tiny, so gameplay framing and lane
//   positions are unchanged.
// - Global coverage: `installWorldBend(renderer)` wraps the engine's per-mesh material descriptor
//   builder (`renderer.material3d._materialDescriptor`, both the WebGL and the WebGPU material
//   system) and appends the bit to EVERY scene material: Material3D, FlatMaterial, Phong, Toon,
//   particle containers and anything with custom `extraBits`, created anywhere, now or later.
//   Nothing has to opt in.
// - Which materials bend: everything with `fog: true` (the engine default). `fog: false` is this
//   project's existing convention for "background at infinity" (sky dome, sun, moon, stars,
//   clouds, far sky cards), and those stay put. Override per material with
//   `setMaterialBend(material, true | false)` before its first draw.
// - Parameters: the engine has no custom global uniforms (a bit may not add fields to `global`),
//   and per-material values would need a write to every material each frame. So the two numbers
//   are packed into ONE existing global float that linear fog never reads: `uFogParams.z`
//   (= `view.fog.density`, used only by exponential fog curves). `packBend()` stores
//   (0x4000 + down*1024) in the high 16 bits and (32768 + side*1024) in the low 16 bits, which is
//   always a normal finite float >= 2, so it survives the engine's `fog.density || 0` copy and the
//   UBO upload bit-exactly; the shader reads it back with floatBitsToUint / bitcast<u32>.
//   A density below 2 (e.g. 0, or a real exponential fog) decodes as "no bend".
//   Requirement: the view keeps a LINEAR fog object (Stage creates it; Atmosphere mutates it).
// - Culling: frustum culling tests unbent bounds, so `BendCullFrustum` (assigned to
//   `camera.cullFrustum`) widens each plane that the bend moves geometry INTO, by exactly the
//   linear upper bound of the quadratic offset out to the fog's far distance (beyond which
//   everything is fully fogged into the background). Planes the bend moves geometry away from are
//   left alone, so culling stays tight.
// - Everything is configured before the first frame: the bit is always compiled in (zero bend is
//   the same shader), so toggling or tuning never recompiles.
//
// Anything mapping world -> screen on the CPU (view.worldToScreen, picking rays) does not know about
// the bend; `bendOffset()` gives the same offset the shader applies, for such code.
import { Frustum } from '@pixi/3d';
import type { BaseMaterial3D, Camera3D, Fog, ShaderBit, ShaderDescriptor, View3D } from '@pixi/3d';
import { RendererType } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { ZONE_BLEND_LENGTH, ZONE_COUNT, ZONE_LENGTH } from '../../sim/config';

/** Bend amount: metres of displacement at 100 m ahead of the camera. */
export interface BendValues {
  /** Downward drop at 100 m (>= 0). */
  down: number;
  /** Sideways swing at 100 m; + = the far street goes right (+X), - = left. */
  side: number;
}

/** Packing scale (1/1024 m resolution) and limits of the encoded values. */
const Q = 1024;
const MAX_DOWN = 0x3eff / Q; // ~15.7 m
const MAX_SIDE = 32767 / Q; // ~32 m

/**
 * The bend starts this far ahead of (and behind) the camera, so the hero and the next metres of
 * street (the hero runs ~6-7 m ahead of the chase camera) are not moved at all.
 */
export const BEND_START = 6;

const packU32 = new Uint32Array(1);
const packF32 = new Float32Array(packU32.buffer);

/** Encode a bend as the float written to `fog.density` (see header). */
export function packBend(down: number, side: number): number {
  const qd = Math.round(Math.min(Math.max(down, 0), MAX_DOWN) * Q);
  const qs = Math.round(Math.min(Math.max(side, -MAX_SIDE), MAX_SIDE) * Q) + 32768;
  packU32[0] = (0x4000 + qd) * 65536 + qs;
  return packF32[0];
}

/** Decode (mirror of the shader; for tests and CPU-side helpers). */
export function unpackBend(v: number, out: BendValues = { down: 0, side: 0 }): BendValues {
  packF32[0] = v;
  const bits = packU32[0];
  if (bits < 0x40000000) {
    out.down = 0;
    out.side = 0;
    return out;
  }
  out.down = ((bits >>> 16) - 0x4000) / Q;
  out.side = ((bits & 0xffff) - 32768) / Q;
  return out;
}

/** The world offset the shader adds at `d` metres ahead of the camera (x = side, y = down). */
export function bendOffset(b: BendValues, d: number, out: { x: number; y: number }): { x: number; y: number } {
  const e = Math.max(Math.abs(d) - BEND_START, 0);
  const k = e * e * 1e-4;
  out.x = b.side * k;
  out.y = -b.down * k;
  return out;
}

// ---------------------------------------------------------------- shader bit

const GL_END = /* glsl */ `{
  uint wbBits = floatBitsToUint(uFogParams.z);
  if (wbBits >= 0x40000000u) {
    float wbDown = float((wbBits >> 16u) - 16384u) * ${(1 / Q).toFixed(10)};
    float wbSide = float(int(wbBits & 65535u) - 32768) * ${(1 / Q).toFixed(10)};
    float wbD = max(abs(uCameraPosition.z - worldPosition.z) - ${BEND_START.toFixed(1)}, 0.0);
    float wbK = wbD * wbD * 0.0001;
    gl_Position += uViewProjectionMatrix * vec4(wbSide * wbK, -wbDown * wbK, 0.0, 0.0);
  }
}`;

// WGSL twin: the vertex stage reads `global.*` / `camera.*` and writes `clipPosition`. Checked on
// WebGPU (SwiftShader adapter): same frames as GL at any bend (scripts/gpucompare.mjs); the fog
// uniform is a Float32Array copied into the UBO on both backends, so the packed bits survive.
const GPU_END = /* wgsl */ `{
  let wbBits = bitcast<u32>(global.uFogParams.z);
  if (wbBits >= 0x40000000u) {
    let wbDown = f32((wbBits >> 16u) - 16384u) * ${(1 / Q).toFixed(10)};
    let wbSide = f32(i32(wbBits & 65535u) - 32768) * ${(1 / Q).toFixed(10)};
    let wbD = max(abs(camera.uCameraPosition.z - worldPosition.z) - ${BEND_START.toFixed(1)}, 0.0);
    let wbK = wbD * wbD * 0.0001;
    clipPosition = clipPosition + camera.uViewProjectionMatrix * vec4<f32>(wbSide * wbK, -wbDown * wbK, 0.0, 0.0);
  }
}`;

/**
 * The bend bit. Normally added automatically by `installWorldBend`; listed for materials drawn by
 * a custom pass descriptor that should bend too (`extraBits: [worldBendBit]`).
 */
export const worldBendBit: ShaderBit = {
  name: 'waymanWorldBend',
  gpu: { vertex: { end: GPU_END } },
  gl: { vertex: { end: GL_END } },
};

// ------------------------------------------------------- material selection

const overrides = new WeakMap<BaseMaterial3D, boolean>();

/**
 * Force a material in (true) or out (false) of the bend, overriding the `fog` rule. Call before
 * the first frame that draws it (or call `mesh.invalidate()` on its meshes afterwards).
 */
export function setMaterialBend(material: BaseMaterial3D, bends: boolean): void {
  overrides.set(material, bends);
}

/** Whether a material bends: its override, else `material.fog`. */
export function materialBends(material: BaseMaterial3D): boolean {
  const o = overrides.get(material);
  return o ?? material.fog !== false;
}

type DescriptorFn = (mesh: { material: BaseMaterial3D }, view: View3D) => ShaderDescriptor;
const installed = new WeakSet<object>();
const scratchBits: ShaderBit[] = [];

/**
 * Hook the renderer's material system so every scene material gets the bend bit. Call once,
 * before the first render. Returns false (and nothing bends, so nothing tears) if this engine
 * build has no hook point.
 */
export function installWorldBend(renderer: Renderer): boolean {
  const sys = (renderer as unknown as { material3d?: { _materialDescriptor?: DescriptorFn } }).material3d;
  if (!sys) return false;
  if (installed.has(sys)) return true;
  const original = sys._materialDescriptor;
  if (typeof original !== 'function') {
    console.warn('[worldBend] engine material hook not found: curved world disabled');
    return false;
  }
  const gpu = renderer.type === RendererType.WEBGPU;
  sys._materialDescriptor = function (this: unknown, mesh, view) {
    const d = original.call(this, mesh, view);
    if (!materialBends(mesh.material)) return d;
    const src = gpu ? d.bitsGpu : d.bitsGl;
    if (src.includes(worldBendBit)) return d;
    // Reused array: the engine copies the bit list when it compiles, and the descriptor it
    // returns is its own scratch object, rebuilt on every call.
    scratchBits.length = 0;
    for (let i = 0; i < src.length; i++) scratchBits.push(src[i]);
    scratchBits.push(worldBendBit);
    return d.update({
      bitsGpu: gpu ? scratchBits : d.bitsGpu,
      bitsGl: gpu ? d.bitsGl : scratchBits,
      template: d.template,
      overrides: d.overrides,
      outputLocations: d.outputLocations,
      includeGlobal: d.includeGlobal,
      includeCamera: d.includeCamera,
    });
  };
  installed.add(sys);
  return true;
}

// ------------------------------------------------------------------ culling

/**
 * Cull frustum that accounts for the bend: reads the camera's freshly built frustum each time the
 * engine asks for the planes (after the camera matrices are rebuilt for the frame) and widens the
 * planes the bend pushes geometry into. Assign once: `camera.cullFrustum = new BendCullFrustum(...)`.
 */
export class BendCullFrustum extends Frustum {
  private readonly out = new Float32Array(24);

  constructor(
    private readonly camera: Camera3D,
    private readonly bend: Readonly<BendValues>,
    /** Distance beyond which everything is invisible (fog far). */
    private readonly farFn: () => number,
  ) {
    super();
  }

  override get planesData(): Float32Array {
    const src = this.camera.frustum.planesData;
    const out = this.out;
    out.set(src);
    const { down, side } = this.bend;
    if (down === 0 && side === 0) return out;
    const F = Math.max(1, this.farFn());
    const L = 20; // behind-the-camera / wrong-facing slack (metres of |d|)
    const camZ = this.camera.position.z;
    const sigma = src[22] < 0 ? 1 : -1; // near-plane normal = camera forward; +1 when looking down -Z
    for (let i = 0; i < 24; i += 4) {
      const nx = src[i], ny = src[i + 1], nz = src[i + 2], w = src[i + 3];
      // inward motion of the plane test per unit d^2
      const a = (nx * side - ny * down) * 1e-4;
      if (a <= 0) continue;
      const nz2 = nz - a * F * sigma;
      const w2 = w + a * F * sigma * camZ + a * L * L;
      const len = Math.hypot(nx, ny, nz2) || 1;
      out[i] = nx / len;
      out[i + 1] = ny / len;
      out[i + 2] = nz2 / len;
      out[i + 3] = w2 / len;
    }
    return out;
  }
}

// ------------------------------------------------------------ automatic driver

/** Tuned look (metres at 100 m ahead). */
export const BEND_DOWN = 10;
/** Peak sideways swing per zone (market, harbor, night). */
export const BEND_SIDE_BY_ZONE: readonly number[] = [14, 16, 11];
/** Metres of track per noise cell: one full turn-in / turn-out takes ~1-2 cells. */
const SIDE_WAVELENGTH = 620;

function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f); // smooth turns, no kinks
  const a = hash1(i);
  return a + (hash1(i + 1) - a) * u;
}

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Zone amplitude, blended over the same ramp the sim uses for zone colours. */
function zoneAmp(s: number): number {
  const z = Math.floor(s / ZONE_LENGTH);
  const into = s - z * ZONE_LENGTH;
  const a = BEND_SIDE_BY_ZONE[((z % ZONE_COUNT) + ZONE_COUNT) % ZONE_COUNT];
  const b = BEND_SIDE_BY_ZONE[(((z + 1) % ZONE_COUNT) + ZONE_COUNT) % ZONE_COUNT];
  return a + (b - a) * smooth01(ZONE_LENGTH - ZONE_BLEND_LENGTH, ZONE_LENGTH, into);
}

/**
 * The automatic bend for the track distance `s` (true distance, continuous across re-bases):
 * constant drop, sideways swing from smooth noise of distance shaped so that it rests at straight,
 * full left or full right for a while instead of drifting constantly. Allocation-free.
 */
export function autoBend(s: number, out: BendValues): BendValues {
  const n = noise1(s / SIDE_WAVELENGTH + 0.75);
  const m = Math.abs(n);
  const shaped = Math.sign(n) * smooth01(0.12, 0.8, m);
  out.down = BEND_DOWN;
  out.side = shaped * zoneAmp(s);
  return out;
}

/** Write the packed bend into the view's linear fog object (call every frame before rendering). */
export function writeBendUniform(fog: Fog | null, b: Readonly<BendValues>, enabled: boolean): void {
  if (!fog) return;
  if (fog.type !== undefined && fog.type !== 'linear') return; // density is real there: leave it
  fog.density = enabled ? packBend(b.down, b.side) : 0;
}
