// Shared scenery layout constants (pure numbers, no engine imports).

/** Length of one recycled street chunk (metres). ZONE_LENGTH (500) is a multiple of it. */
export const CHUNK_LEN = 50;
/** Building fronts stand on this line (|x|), the sidewalk's outer edge. */
export const FRONT_X = 8;
/** Harbour quay edge (|x|) on the sea side: water beyond. */
export const QUAY_EDGE = 22;
/** Gameplay volume nothing of ours may enter: |x| < ROAD_CLEAR_X while y < ROAD_CLEAR_Y. */
export const ROAD_CLEAR_X = 4.6;
export const ROAD_CLEAR_Y = 11;
