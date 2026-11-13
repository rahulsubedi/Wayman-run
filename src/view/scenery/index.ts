// SceneryView (placeholder art, final API): road, lane markings, sidewalks and simple buildings,
// built in fixed-length chunks that recycle ahead of the player.
//
// Chunks are positioned once (when recycled) with stage.worldZ() and shifted on origin re-base
// through stage.onRebase(): that is the pattern for any node placed once rather than per frame.
import { Container3D, Mesh3D } from '@pixi/3d';
import type { Geometry3D } from '@pixi/3d';
import { LANE_WIDTH, ROAD_HALF_WIDTH, SIDEWALK_OUTER } from '../../sim/config';
import { hash01 } from '../../sim/rng';
import { shadeHex as shade } from '../geom/color';
import { MeshBuilder } from '../geom/meshBuilder';
import { vertexColorMaterial } from '../geom/materials';
import type { Stage } from '../stage';

const CHUNK_LEN = 40;
const CHUNKS_BEHIND = 1;
const CHUNK_COUNT = 7; // 1 behind + 6 ahead = 240 m of street
const LOTS_PER_SIDE = 4; // building slots per side per chunk (10 m each)
const BUILDING_VARIANTS = 8;

const WALLS = [0xe8c9a0, 0xd9825b, 0xf1e4cc, 0xc96f4a, 0xe3b26a, 0xf4efe6, 0xd6a77a, 0xb8d4cf];
const TRIMS = [0x2a9d8f, 0xe76f51, 0xe9c46a, 0xffffff, 0x264653];

function roadGeometry(): Geometry3D {
  const mb = new MeshBuilder({ seed: 21, jitter: 0.02 });
  const L = CHUNK_LEN;
  // Chunk spans local z from 0 (near) to -L (far).
  mb.block(-ROAD_HALF_WIDTH, -0.1, -L, ROAD_HALF_WIDTH, 0, 0, 0x55606e);
  // Lane dashes between lanes.
  for (const x of [-LANE_WIDTH / 2, LANE_WIDTH / 2]) {
    for (let z = 0; z < L; z += 5) mb.block(x - 0.07, 0, -z - 3, x + 0.07, 0.012, -z, 0xf2efe6);
  }
  // Edge lines.
  for (const x of [-ROAD_HALF_WIDTH + 0.25, ROAD_HALF_WIDTH - 0.25]) mb.block(x - 0.06, 0, -L, x + 0.06, 0.012, 0, 0xf0d36a);
  // Kerbs + sidewalks.
  for (const side of [-1, 1]) {
    const x0 = side * ROAD_HALF_WIDTH, x1 = side * SIDEWALK_OUTER;
    mb.block(Math.min(x0, x0 + side * 0.25), 0, -L, Math.max(x0, x0 + side * 0.25), 0.18, 0, 0xc9c3b6);
    for (let z = 0; z < L; z += 2.5) {
      const shade = (z / 2.5) % 2 ? 0xd8cdb8 : 0xcfc2aa;
      mb.block(Math.min(x0 + side * 0.25, x1), 0, -z - 2.5, Math.max(x0 + side * 0.25, x1), 0.15, -z, shade);
    }
    // Ground beyond the lots.
    mb.block(Math.min(side * 30, side * 60), -0.2, -L, Math.max(side * 30, side * 60), -0.05, 0, 0x8a7a62);
  }
  return mb.build();
}

/** A building on a 10 m lot, street face at local x = 0 facing -X (right side; `side = -1` mirrors it for the left). */
function buildingGeometry(variant: number, side: 1 | -1): Geometry3D {
  const r = (k: number) => hash01(variant, k);
  const mb = new MeshBuilder({ seed: 100 + variant, jitter: 0.03 });
  mb.scale(side, 1, 1); // left-side copies are mirrored at build time (keeps winding/normals right)
  const wall = WALLS[variant % WALLS.length];
  const trim = TRIMS[Math.floor(r(1) * TRIMS.length)];
  const floors = 2 + Math.floor(r(2) * 3);
  const h = floors * 3.2;
  const depth = 8 + r(3) * 6;
  const w = 9.4;
  mb.block(0, 0, -w / 2, depth, h, w / 2, { color: wall, bottom: shade(wall, 0.8) });
  mb.block(-0.15, h, -w / 2 - 0.15, depth + 0.15, h + 0.35, w / 2 + 0.15, trim); // cornice
  // Windows and a door on the street face (x = 0).
  for (let f = 0; f < floors; f++) {
    for (let i = 0; i < 3; i++) {
      const z = -w / 2 + 1.7 + i * 3;
      if (f === 0 && i === 1) {
        mb.block(-0.06, 0, z - 0.7, 0.02, 2.4, z + 0.7, 0x5a3b28); // door
        continue;
      }
      mb.block(-0.06, f * 3.2 + 1.1, z - 0.6, 0.02, f * 3.2 + 2.5, z + 0.6, 0x2b4152);
      mb.block(-0.2, f * 3.2 + 1.0, z - 0.75, 0.02, f * 3.2 + 1.1, z + 0.75, 0xf4efe6); // sill
    }
  }
  // Awning on some.
  if (r(4) > 0.4) {
    const a = TRIMS[Math.floor(r(5) * TRIMS.length)];
    mb.push().translate(-0.8, 2.9, 0).rotateZ(-0.35).block(-0.9, -0.05, -w / 2 + 0.5, 0.9, 0.05, w / 2 - 0.5, a).pop();
  }
  return mb.build();
}

interface Chunk {
  node: Container3D;
  index: number;
  lots: Mesh3D[];
}

export class SceneryView {
  private readonly stage: Stage;
  private readonly root = new Container3D({ label: 'scenery' });
  private readonly chunks: Chunk[] = [];
  private readonly buildings: Record<1 | -1, Geometry3D[]> = { 1: [], [-1]: [] };
  private lastS = 0;

  constructor(stage: Stage) {
    this.stage = stage;
    stage.world.addChild(this.root);
    const road = roadGeometry();
    for (let v = 0; v < BUILDING_VARIANTS; v++) {
      this.buildings[1].push(buildingGeometry(v, 1));
      this.buildings[-1].push(buildingGeometry(v, -1));
    }
    const mat = vertexColorMaterial();
    for (let c = 0; c < CHUNK_COUNT; c++) {
      const node = new Container3D({ parent: this.root });
      new Mesh3D({ parent: node, geometry: road, material: mat, castShadow: false });
      const lots: Mesh3D[] = [];
      for (const side of [-1, 1] as const) {
        for (let i = 0; i < LOTS_PER_SIDE; i++) {
          const m = new Mesh3D({ parent: node, geometry: this.buildings[side][0], material: mat });
          m.position.set(side * (SIDEWALK_OUTER + 0.3), 0, -(i + 0.5) * (CHUNK_LEN / LOTS_PER_SIDE));
          lots.push(m);
        }
      }
      this.chunks.push({ node, index: -1, lots });
    }
    stage.onRebase((dz) => {
      for (const ch of this.chunks) ch.node.position.z += dz;
    });
    this.layout(0);
  }

  update(playerS: number, _zone: number, _zoneBlend: number, _dt: number): void {
    if (playerS < this.lastS - 1) this.layout(playerS); // new run: rebuild from scratch
    this.lastS = playerS;
    const first = Math.floor(playerS / CHUNK_LEN) - CHUNKS_BEHIND;
    for (const ch of this.chunks) {
      if (ch.index < first) this.place(ch, ch.index + CHUNK_COUNT * Math.ceil((first - ch.index) / CHUNK_COUNT));
    }
  }

  private layout(playerS: number): void {
    const first = Math.floor(playerS / CHUNK_LEN) - CHUNKS_BEHIND;
    this.chunks.forEach((ch, i) => this.place(ch, first + i));
  }

  private place(ch: Chunk, index: number): void {
    ch.index = index;
    ch.node.position.z = this.stage.worldZ(index * CHUNK_LEN);
    ch.lots.forEach((m, i) => {
      const side = i < LOTS_PER_SIDE ? -1 : 1;
      m.geometry = this.buildings[side][Math.floor(hash01(index, i + 7) * BUILDING_VARIANTS)];
    });
  }
}
