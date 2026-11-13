// Port Solana colour palette (sRGB hex). Warm sandstone / terracotta / cream facades with teal,
// coral, mustard and white accents; cool blue-grey asphalt so obstacles and coins pop.

export const ASPHALT = 0x5d6675;
export const ASPHALT_DARK = 0x4f5866;
export const ASPHALT_PATCH = 0x57606e;
export const ASPHALT_LIGHT = 0x626b7b;
export const PAINT_WHITE = 0xeeeae0;
export const PAINT_YELLOW = 0xe8c35a;
export const CURB = 0xc9c4b8;
export const CURB_FACE = 0xa9a396;
export const PAVING = [0xd9cdb5, 0xd2c4a8, 0xdcd2bd, 0xcbbd9f, 0xd6c9ae] as const;
export const PAVING_BAND = 0xb59f80;
export const IRON = 0x2f3a3f;
export const IRON_LIGHT = 0x4a575e;

/** Facade wall colours by zone family. */
export const WALLS_MARKET = [
  0xe9cfa3, // sandstone
  0xd98a5f, // terracotta
  0xf3e7cf, // cream
  0xe6b56b, // ochre
  0xf2d9c4, // blush
  0xc9714f, // brick red
  0xf6f0e3, // whitewash
  0xdcc08f, // honey
  0xb9d6cc, // sea-glass
  0xf0c6a8, // apricot
] as const;

export const WALLS_HARBOR = [
  0x5f8f8b, // weathered teal
  0xa65141, // oxide red
  0xd7b46a, // ochre
  0xe8e1d0, // salt white
  0x6d7f95, // slate blue
  0xc7a27c, // tan
  0x8a9a7a, // sage
  0xd06c48, // rust orange
] as const;

export const TRIMS = [0x2a9d8f, 0xe76f51, 0xe9c46a, 0xffffff, 0x264653, 0x3c7fa6, 0x5c946e] as const;
export const SHUTTERS = [0x2a8f86, 0x3f7fb0, 0x5f9e6e, 0xd8a03c, 0x9a4f3b, 0x6aa9b8, 0xe2725b] as const;
export const AWNING_PAIRS: readonly [number, number][] = [
  [0xe76f51, 0xfbf3e4], // coral / cream
  [0x2a9d8f, 0xfbf3e4], // teal / cream
  [0xe9b949, 0xfbf3e4], // mustard / cream
  [0x3c7fa6, 0xffffff], // blue / white
  [0x2a9d8f, 0xe9c46a], // teal / mustard
  [0xd1495b, 0xfbf3e4], // raspberry / cream
  [0x5c946e, 0xf4eadb], // sage / cream
];
export const GLASS_TOP = 0x7fa6bd;
export const GLASS_BOTTOM = 0x2c4556;
export const ROOF_TILE = 0xc0583a;
export const ROOF_TILE_DARK = 0x9c4229;
export const WOOD = 0x8a5a3b;
export const WOOD_DARK = 0x5e3b26;
export const LEAF = 0x5f9a4a;
export const LEAF_DARK = 0x3f7236;
export const FLOWERS = [0xe94f64, 0xf2b134, 0xf7f0ea, 0xc04bb0, 0xff7b54] as const;

/** Night glow colours (used with glowPaint). */
export const LIGHT_WARM = 0xffc27a;
export const LIGHT_AMBER = 0xffa64d;
export const LIGHT_CREAM = 0xfff0c8;
export const NEON = [0xff4f8b, 0x3ff2e1, 0xffd23f, 0x9d7bff, 0x6dff8a, 0xff7a3d] as const;
export const LANTERN = [0xff5a3c, 0xffb13b, 0xff7f50, 0xffd36b] as const;
