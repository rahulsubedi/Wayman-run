// Small obstacles (hurdle, overhead gantry, road-works blocker) and the ramp.
// Each fits OBSTACLE_DIMS exactly: origin at road level, centred in x and length, length along Z.
// The player runs toward -Z, so the face they see is the +Z face.
import { OBSTACLE_DIMS } from '../../sim/config';
import { MeshBuilder } from '../geom/meshBuilder';
import { diagonalStripes, faceToward, loft, taper, type V3 } from './kit';

/** Geometry builders for one model: body (lit vertex colours), lamps (blinking glow), etc. */
export interface ObstacleBuilders {
  body: MeshBuilder;
  /** Transparent window panes. */
  glass?: MeshBuilder;
  /** Steady emissive parts (headlights, signs). */
  glow?: MeshBuilder;
  glowColor?: number;
  glowStrength?: number;
  /** Blinking lamps (toggled by updateObstacleVisual). */
  lamps?: MeshBuilder;
  lampColor?: number;
  /** One axle (both wheels), spun by updateObstacleVisual; placed at each `axleZ`. */
  axle?: MeshBuilder;
  axleZ?: number[];
  axleY?: number;
}

export const C = {
  steel: 0x5d6673,
  steelDark: 0x3a414c,
  steelLight: 0x9aa4b1,
  white: 0xf6f4ee,
  red: 0xe63b2e,
  redDark: 0xa82418,
  yellow: 0xffc81f,
  yellowDark: 0xd99a00,
  black: 0x1e2026,
  orange: 0xff7a1a,
  orangeDark: 0xc9520a,
  amber: 0xffb020,
  sand: 0xc9a46a,
  sandDark: 0x9c7a46,
  green: 0x3fb85c,
  greenDark: 0x23803c,
  rubber: 0x23262c,
} as const;

/** Small warning lamp housing (body) at (x, y, z): a dark cup the glowing dome sits in. */
function lampHousing(mb: MeshBuilder, x: number, y: number, z: number, r: number): void {
  mb.push().translate(x, y, z).cylinder(r * 1.15, r * 0.6, 6, { radiusTop: r * 1.05, capTop: false }, C.black).pop();
}

/** Glowing lamp dome (lamps mesh). */
function lampDome(mb: MeshBuilder, x: number, y: number, z: number, r: number): void {
  mb.push().translate(x, y, z).sphere(r, r * 0.9, r, 6, 3, 0xffffff).pop();
}

// ------------------------------------------------------------------- hurdle

function hurdle(): ObstacleBuilders {
  const d = OBSTACLE_DIMS.hurdle; // 2.0 x 0.9 x 0.4
  const mb = new MeshBuilder({ seed: 101, jitter: 0.03 });
  const lamps = new MeshBuilder({ seed: 102 });
  const px = d.w / 2 - 0.1;
  for (const s of [-1, 1]) {
    const x = s * px;
    // Inverted-T foot with rubber end caps.
    mb.push().translate(x, 0.04, 0).bevelBox(0.16, 0.08, d.len - 0.02, 0.02, { color: C.steel, bottom: C.steelDark }).pop();
    mb.block(x - 0.085, 0, d.len / 2 - 0.07, x + 0.085, 0.09, d.len / 2 - 0.005, C.yellow);
    mb.block(x - 0.085, 0, -d.len / 2 + 0.005, x + 0.085, 0.09, -d.len / 2 + 0.07, C.yellow);
    // Upright with a reflective band.
    mb.push().translate(x, 0.47, 0).box(0.09, 0.78, 0.09, { color: C.steelLight, bottom: C.steel }).pop();
    mb.block(x - 0.05, 0.16, -0.05, x + 0.05, 0.22, 0.05, C.red);
    lampHousing(mb, x, 0.85, 0, 0.055);
    lampDome(lamps, x, 0.88, 0, 0.05);
  }
  // Top board: white with diagonal red stripes on both faces.
  const bx = px - 0.05;
  mb.push().translate(0, 0.72, 0).bevelBox(bx * 2, 0.24, 0.07, 0.02, C.white).pop();
  diagonalStripes(mb, -bx + 0.02, bx - 0.02, 0.61, 0.83, 0.036, C.red, 0.32, 1);
  diagonalStripes(mb, -bx + 0.02, bx - 0.02, 0.61, 0.83, -0.036, C.red, 0.32, -1);
  // Lower rail: straight red/white blocks.
  const n = 6;
  const w = (bx * 2) / n;
  for (let i = 0; i < n; i++) mb.block(-bx + i * w, 0.34, -0.025, -bx + (i + 1) * w, 0.44, 0.025, i % 2 ? C.white : C.red);
  // Small hanging plate in the middle.
  mb.push().translate(0, 0.39, 0.03).bevelBox(0.3, 0.16, 0.02, 0.01, C.yellow).pop();
  faceToward(mb, [[-0.06, 0.34, 0.042], [0.06, 0.34, 0.042], [0, 0.44, 0.042]], [0, 0, 1], C.black);
  return { body: mb, lamps, lampColor: 0xff5a2a };
}

// ----------------------------------------------------------------- overhead

function overhead(): ObstacleBuilders {
  const d = OBSTACLE_DIMS.overhead; // 2.2 x 2.6 x 0.5, solid from 1.2
  const mb = new MeshBuilder({ seed: 201, jitter: 0.03 });
  const lamps = new MeshBuilder({ seed: 202 });
  const px = d.w / 2 - 0.08;
  for (const s of [-1, 1]) {
    const x = s * px;
    // Base plate + slim post with black/yellow bands at the bottom.
    mb.push().translate(x, 0.03, 0).box(0.16, 0.06, d.len - 0.02, C.steelDark).pop();
    mb.push().translate(x, 1.3, 0).box(0.13, 2.5, 0.13, { color: C.steelLight, bottom: C.steel }).pop();
    for (let i = 0; i < 3; i++) mb.block(x - 0.072, 0.1 + i * 0.2, -0.072, x + 0.072, 0.2 + i * 0.2, 0.072, i % 2 ? C.black : C.yellow);
    // Gusset where the beam meets the post.
    taper(mb, 2.2, 2.42, 0.13, 0.1, 0.3, 0.1, C.steel, 0, -s * 0.085);
  }
  // Top beam.
  mb.push().translate(0, 2.51, 0).bevelBox(d.w - 0.02, 0.18, 0.22, 0.03, { color: C.steel, top: C.steelLight }).pop();
  // Hanging sign board 1.22 .. 2.36: yellow frame, hazard bands top and bottom, black centre panel.
  const sx = px - 0.08;
  const y0 = 1.22, y1 = 2.38;
  mb.push().translate(0, (y0 + y1) / 2, 0).bevelBox(sx * 2, y1 - y0, 0.16, 0.035, C.yellow).pop();
  for (const f of [1, -1] as const) {
    const z = f * 0.081;
    diagonalStripes(mb, -sx + 0.03, sx - 0.03, y0 + 0.03, y0 + 0.22, z, C.black, 0.3, f, f);
    diagonalStripes(mb, -sx + 0.03, sx - 0.03, y1 - 0.22, y1 - 0.03, z, C.black, 0.3, f, f);
    // Centre panel with three downward chevrons ("go under").
    const pz = z + f * 0.004;
    faceToward(mb, [[-sx + 0.1, y0 + 0.28, pz], [sx - 0.1, y0 + 0.28, pz], [sx - 0.1, y1 - 0.28, pz], [-sx + 0.1, y1 - 0.28, pz]], [0, 0, f], C.black);
    const cz = pz + f * 0.004;
    const cy = (y0 + y1) / 2;
    for (const cx of [-0.55, 0, 0.55]) {
      const ww = 0.2, hh = 0.2, t = 0.08;
      // A "V" made of two slanted bars meeting at the bottom.
      faceToward(mb, [[cx - ww, cy + hh / 2, cz], [cx - ww + t, cy + hh / 2, cz], [cx + t * 0.5, cy - hh / 2 + t, cz], [cx, cy - hh / 2, cz]], [0, 0, f], C.yellow);
      faceToward(mb, [[cx + ww, cy + hh / 2, cz], [cx, cy - hh / 2, cz], [cx - t * 0.5, cy - hh / 2 + t, cz], [cx + ww - t, cy + hh / 2, cz]], [0, 0, f], C.yellow);
    }
  }
  // Short chains from the beam to the board.
  for (const s of [-1, 1]) mb.block(s * 0.62 - 0.02, 2.36, -0.02, s * 0.62 + 0.02, 2.43, 0.02, C.steelDark);
  // Lamps on top of the beam.
  for (const s of [-1, 1]) {
    lampHousing(mb, s * 0.75, 2.58, 0, 0.04);
    lampDome(lamps, s * 0.75, 2.58, 0.0, 0.042);
  }
  return { body: mb, lamps, lampColor: C.amber };
}

// ------------------------------------------------------------------ blocker

function sandbag(mb: MeshBuilder, x: number, y: number, z: number, rot: number): void {
  mb.push().translate(x, y, z).rotateY(rot);
  loft(mb, [
    { y: -0.06, rx: 0.14, rz: 0.09 },
    { y: 0.0, rx: 0.18, rz: 0.12 },
    { y: 0.07, rx: 0.11, rz: 0.07 },
  ], { sides: 6, bands: [C.sandDark, C.sand] });
  mb.pop();
}

function blocker(): ObstacleBuilders {
  const d = OBSTACLE_DIMS.blocker; // 2.0 x 2.4 x 0.6
  const mb = new MeshBuilder({ seed: 301, jitter: 0.03 });
  const lamps = new MeshBuilder({ seed: 302 });
  const px = d.w / 2 - 0.1;
  for (const s of [-1, 1]) {
    const x = s * px;
    // Foot frame along Z with sandbags.
    mb.push().translate(x, 0.04, 0).box(0.14, 0.08, d.len - 0.02, C.steelDark).pop();
    sandbag(mb, x - s * 0.06, 0.14, 0.15, 0);
    sandbag(mb, x - s * 0.06, 0.14, -0.15, 0);
    // Post, white with red bands.
    mb.push().translate(x, 1.16, 0).box(0.1, 2.12, 0.1, C.white).pop();
    for (let i = 0; i < 3; i++) mb.block(x - 0.054, 0.3 + i * 0.7, -0.054, x + 0.054, 0.5 + i * 0.7, 0.054, C.red);
    lampHousing(mb, x, 2.27, 0, 0.06);
    lampDome(lamps, x, 2.31, 0, 0.065);
  }
  const bx = px - 0.03;
  // Two striped rails.
  for (const [y0, y1] of [[0.42, 0.68], [0.86, 1.12]]) {
    mb.push().translate(0, (y0 + y1) / 2, 0).box(bx * 2, y1 - y0, 0.06, C.white).pop();
    diagonalStripes(mb, -bx + 0.02, bx - 0.02, y0 + 0.02, y1 - 0.02, 0.031, C.orange, 0.34, 1, 1);
    diagonalStripes(mb, -bx + 0.02, bx - 0.02, y0 + 0.02, y1 - 0.02, -0.031, C.orange, 0.34, -1, 1);
  }
  // Big sign board with "< >" chevrons: go around either side.
  const y0 = 1.3, y1 = 2.16;
  mb.push().translate(0, (y0 + y1) / 2, 0).bevelBox(bx * 2 + 0.04, y1 - y0, 0.08, 0.03, { color: C.orange, bottom: C.orangeDark }).pop();
  for (const f of [1, -1] as const) {
    const z = f * 0.042;
    const cy = (y0 + y1) / 2;
    // White border strip.
    for (const yy of [y0 + 0.05, y1 - 0.09]) faceToward(mb, [[-bx + 0.04, yy, z], [bx - 0.04, yy, z], [bx - 0.04, yy + 0.04, z], [-bx + 0.04, yy + 0.04, z]], [0, 0, f], C.white);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const tip = side * (0.86 - k * 0.32); // chevron tip points outward
        const back = tip - side * 0.18;
        const t = 0.1 * side;
        const hh = 0.24;
        faceToward(mb, [[back, cy + hh, z], [back + t, cy + hh, z], [tip + t, cy, z], [tip, cy, z]], [0, 0, f], C.white);
        faceToward(mb, [[back, cy - hh, z], [tip, cy, z], [tip + t, cy, z], [back + t, cy - hh, z]], [0, 0, f], C.white);
      }
    }
    // Centre "works" diamond.
    faceToward(mb, [[0, cy + 0.2, z], [-0.2, cy, z], [0, cy - 0.2, z], [0.2, cy, z]], [0, 0, f], C.black);
    faceToward(mb, [[0, cy + 0.14, z + f * 0.003], [-0.14, cy, z + f * 0.003], [0, cy - 0.14, z + f * 0.003], [0.14, cy, z + f * 0.003]], [0, 0, f], C.yellow);
  }
  return { body: mb, lamps, lampColor: C.amber };
}

// --------------------------------------------------------------------- ramp

function ramp(): ObstacleBuilders {
  const d = OBSTACLE_DIMS.ramp; // 2.1 x 2.8 x 6, rises toward -Z
  const mb = new MeshBuilder({ seed: 701, jitter: 0.025 });
  const glow = new MeshBuilder({ seed: 702 });
  const hw = d.w / 2;
  const zf = d.len / 2, zb = -d.len / 2;
  const slope = d.h / d.len;
  const yAt = (z: number) => (zf - z) * slope; // deck top height at z
  const th = 0.14; // deck thickness
  // Deck slab: top surface exactly on the walkable slope.
  const deck = (x0: number, x1: number, top: number, col: number, under: number) => {
    const P = (x: number, z: number, dy: number): V3 => [x, Math.max(0, yAt(z) + dy), z];
    const c: V3[] = [P(x0, zf, -th), P(x1, zf, -th), P(x1, zb, -th), P(x0, zb, -th), P(x0, zf, top), P(x1, zf, top), P(x1, zb, top), P(x0, zb, top)];
    // Use explicit faces so the nose (z = zf) tapers to a sharp lip at road level.
    const cen: V3 = [(x0 + x1) / 2, d.h / 2 - 0.3, 0];
    const fc = (pts: V3[], p: number) => {
      // Skip degenerate faces.
      const a = pts[0], b = pts[1], e = pts[2];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = e[0] - a[0], vy = e[1] - a[1], vz = e[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-6 && pts.length === 3) return;
      faceTowardOut(mb, pts, cen, p);
    };
    fc([c[4], c[5], c[6], c[7]], col); // top (slope)
    fc([c[0], c[1], c[2], c[3]], under); // underside
    fc([c[3], c[2], c[6], c[7]], under); // back end
    fc([c[0], c[4], c[7], c[3]], under); // left edge
    fc([c[1], c[2], c[6], c[5]], under); // right edge
  };
  deck(-hw + 0.12, hw - 0.12, 0, C.green, C.greenDark);
  // Kerbs along both edges (yellow/black blocks following the slope).
  const segs = 8;
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? hw - 0.12 : -hw, x1 = s > 0 ? hw : -hw + 0.12;
    for (let i = 0; i < segs; i++) {
      const za = zf - (i / segs) * d.len, zb2 = zf - ((i + 1) / segs) * d.len;
      const ya = yAt(za), yb = yAt(zb2);
      const top = 0.06;
      const col = i % 2 ? C.black : C.yellow;
      const pts: V3[] = [
        [x0, Math.max(0, ya - th), za], [x1, Math.max(0, ya - th), za], [x1, Math.max(0, yb - th), zb2], [x0, Math.max(0, yb - th), zb2],
        [x0, ya + top, za], [x1, ya + top, za], [x1, yb + top, zb2], [x0, yb + top, zb2],
      ];
      hull8Safe(mb, pts, col);
    }
  }
  // Chevrons pointing up the slope (-Z), painted on the deck.
  const ang = Math.atan2(d.h, d.len);
  for (let i = 0; i < 4; i++) {
    const zc = zf - 0.9 - i * 1.35;
    mb.push().translate(0, yAt(zc) + 0.006, zc).rotateX(ang);
    const t = 0.22, ww = 0.62, hh = 0.42;
    // In deck space: x across, -z = up the slope. Apex at -z.
    faceToward(mb, [[-ww, 0, hh / 2], [-ww + t, 0, hh / 2 + 0.0001], [0, 0, -hh / 2 + t], [0, 0, -hh / 2]], [0, 1, 0], C.yellow);
    faceToward(mb, [[ww, 0, hh / 2], [0, 0, -hh / 2], [0, 0, -hh / 2 + t], [ww - t, 0, hh / 2]], [0, 1, 0], C.yellow);
    mb.pop();
  }
  // Steel lip at the nose, with a hazard strip.
  mb.block(-hw + 0.12, 0, zf - 0.22, hw - 0.12, 0.02, zf - 0.02, C.steelLight);
  // Support structure: posts + braces under the deck on both sides, a base rail on the ground.
  for (const s of [-1, 1]) {
    const x = s * (hw - 0.2);
    mb.block(x - 0.06, 0, zb + 0.05, x + 0.06, 0.1, zf - 1.2, C.steelDark);
    const posts = [zb + 0.12, zb + 1.5, zb + 2.9, zb + 4.1];
    for (const z of posts) {
      const top = yAt(z) - th;
      if (top < 0.25) continue;
      mb.push().translate(x, top / 2, z).box(0.11, top, 0.11, { color: C.steel, top: C.steelLight }).pop();
    }
    for (let k = 0; k < posts.length - 1; k++) {
      const za = posts[k], zb3 = posts[k + 1];
      const ya = 0.1, yb = yAt(zb3) - th - 0.05;
      // Diagonal brace from the bottom of one post to the top of the next.
      const len = Math.hypot(zb3 - za, yb - ya);
      const a = Math.atan2(yb - ya, -(zb3 - za));
      mb.push().translate(x + s * 0.01, (ya + yb) / 2, (za + zb3) / 2).rotateX(a).box(0.05, 0.06, len, C.steelLight).pop();
    }
  }
  // Green side skirts (shallow, under the deck edge) so the silhouette still reads as a wedge.
  for (const s of [-1, 1]) {
    const x = s * (hw - 0.06);
    // A skirt band just under the kerb.
    for (let i = 0; i < segs; i++) {
      const za = zf - (i / segs) * d.len, zb2 = zf - ((i + 1) / segs) * d.len;
      const ya = Math.max(0, yAt(za) - th - 0.28), yb = Math.max(0, yAt(zb2) - th - 0.28);
      const yat = Math.max(0, yAt(za) - th), ybt = Math.max(0, yAt(zb2) - th);
      if (yat - ya < 0.02 && ybt - yb < 0.02) continue;
      faceToward(mb, [[x, ya, za], [x, yb, zb2], [x, ybt, zb2], [x, yat, za]], [s, 0, 0], C.greenDark);
    }
  }
  // Back face (vertical, usually hidden by the vehicle behind it).
  faceToward(mb, [[-hw, 0, zb], [hw, 0, zb], [hw, d.h - th, zb], [-hw, d.h - th, zb]], [0, 0, -1], C.steelDark);
  // Little glowing studs along the kerbs (bloom at night, guide the eye up the slope).
  for (const s of [-1, 1]) {
    for (let i = 1; i < 6; i++) {
      const z = zf - i * 0.95;
      glow.push().translate(s * (hw - 0.06), yAt(z) + 0.062, z).rotateX(Math.atan2(d.h, d.len)).plane(0.05, 0.14, 0xffffff).pop();
    }
  }
  return { body: mb, glow, glowColor: 0xfff1a0, glowStrength: 2.2 };
}

/** Face oriented away from an interior point (wrapper kept local for the ramp deck). */
function faceTowardOut(mb: MeshBuilder, pts: V3[], interior: V3, paint: number): void {
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) {
    cx += p[0] / pts.length;
    cy += p[1] / pts.length;
    cz += p[2] / pts.length;
  }
  faceToward(mb, pts, [cx - interior[0], cy - interior[1], cz - interior[2]], paint);
}

/** hull8 that tolerates collapsed bottom corners (where the slope meets the road). */
function hull8Safe(mb: MeshBuilder, c: V3[], paint: number): void {
  const cen: V3 = [0, 0, 0];
  for (const p of c) {
    cen[0] += p[0] / 8;
    cen[1] += p[1] / 8;
    cen[2] += p[2] / 8;
  }
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  for (const q of quads) {
    const pts = q.map((i) => c[i]);
    // Drop duplicate points.
    const uniq: V3[] = [];
    for (const p of pts) if (!uniq.some((u) => Math.abs(u[0] - p[0]) + Math.abs(u[1] - p[1]) + Math.abs(u[2] - p[2]) < 1e-6)) uniq.push(p);
    if (uniq.length < 3) continue;
    faceTowardOut(mb, uniq, cen, paint);
  }
}

export function buildSmallObstacle(kind: 'hurdle' | 'overhead' | 'blocker' | 'ramp'): ObstacleBuilders {
  switch (kind) {
    case 'hurdle':
      return hurdle();
    case 'overhead':
      return overhead();
    case 'blocker':
      return blocker();
    case 'ramp':
      return ramp();
  }
}
