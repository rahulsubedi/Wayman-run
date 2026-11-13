// Colour helpers. Vertex colours are LINEAR light: convert sRGB picks (hex from a palette) first,
// or mid tones come out pale.

/** One sRGB channel (0..1) to linear light (0..1). Same curve as @pixi/3d's `srgbToLinear`. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** One linear channel (0..1) back to sRGB (0..1). */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export type RGB = [number, number, number];

/** 0xRRGGBB (sRGB) -> linear [r, g, b]. Writes into `out` when given. */
export function hexToLinear(hex: number, out: RGB = [0, 0, 0]): RGB {
  out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[2] = srgbToLinear((hex & 255) / 255);
  return out;
}

/** Mix two 0xRRGGBB colours in sRGB space (good enough for palette blends). */
export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Scale an sRGB hex colour's brightness (k < 1 darkens, k > 1 lightens, clamped). */
export function shadeHex(hex: number, k: number): number {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (f((hex >> 16) & 255) << 16) | (f((hex >> 8) & 255) << 8) | f(hex & 255);
}
