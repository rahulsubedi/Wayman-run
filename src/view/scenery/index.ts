// SceneryView: the static street of Port Solana (ground, facades, furniture, overhead strings,
// gateways, back rows and far hills), assembled from a pre-built module library and recycled in
// CHUNK_LEN chunks ahead of the player.
//
// - Construction builds every module geometry once (library.ts) and pre-allocates a pool of
//   Mesh3D nodes per chunk. During play a chunk is (re)placed by assigning shared geometries to
//   pooled meshes: no geometry is ever built after start-up, and meshes sharing a geometry and
//   the one scenery material are auto-instanced by the engine (one draw per module kind).
// - A chunk's content depends only on its index and the zone at its own start s (plus the debug
//   zone offset), so the next zone is already visible ahead and layout is deterministic.
// - Chunk nodes are placed once with stage.worldZ() and shifted on origin re-base.
import { Container3D, Mesh3D } from '@pixi/3d';
import type { Geometry3D, Material3D } from '@pixi/3d';
import { ZONE_COUNT, ZONE_LENGTH } from '../../sim/config';
import type { Stage } from '../stage';
import { chunkZone, layoutChunk, type AnimKind, type WidthTable } from './layout';
import { CHUNK_LEN } from './layoutConst';
import { lowTable, moduleDefs, widthTable } from './library';
import { sceneryMaterial, waterMaterial } from './material';

/**
 * A chunk retires once its far end is this far behind the player (the camera is ~7 m behind;
 * tall buildings further back still throw low golden-hour shadows forward onto the street).
 */
const BEHIND = 40;
/** Pool size: covers BEHIND + at least ~310 m ahead (far fog ends around 240 m). */
const CHUNK_COUNT = 8;
/**
 * Small clutter (bins, bollards, scooters...) is shown in chunks that start less than this far
 * ahead. Beyond it those props are a few pixels tall inside thick fog; hiding them there keeps
 * the next zone's clutter kinds from adding draw calls while it is still on the horizon.
 */
const DETAIL_AHEAD = 150;

interface Module {
  geometry: Geometry3D;
  material: Material3D;
  shadow: boolean;
  small: boolean;
  triangles: number;
}

interface AnimSlot {
  mesh: Mesh3D;
  kind: AnimKind;
  phase: number;
  baseY: number;
}

interface Chunk {
  node: Container3D;
  index: number;
  zone: number;
  statics: Mesh3D[];
  /** Which static slots hold small clutter (toggled by distance). */
  small: boolean[];
  staticCount: number;
  detail: boolean;
  anims: AnimSlot[];
  animCount: number;
}

export class SceneryView {
  /** Root of all scenery nodes (visible for perf probes). */
  readonly root = new Container3D({ label: 'scenery' });
  private readonly stage: Stage;
  private readonly modules = new Map<string, Module>();
  private readonly widths: WidthTable;
  private readonly low: boolean[][];
  private readonly chunks: Chunk[] = [];
  private zoneOffset = 0;
  private lastS = 0;
  private time = 0;

  constructor(stage: Stage) {
    this.stage = stage;
    stage.world.addChild(this.root);
    this.widths = widthTable();
    this.low = lowTable();

    // ---- Build the module library (the only geometry building we ever do).
    const main = sceneryMaterial();
    const water = waterMaterial();
    for (const [key, def] of moduleDefs()) {
      const mb = def.build();
      this.modules.set(key, { geometry: mb.build(), material: def.material === 'water' ? water : main, shadow: def.shadow, small: !!def.small, triangles: mb.triangleCount });
    }

    // ---- Size the per-chunk pools from a sweep of layouts across all zones.
    let maxStatic = 0, maxAnim = 0;
    for (let z = 0; z < ZONE_COUNT; z++) {
      for (let i = 0; i < 40; i++) {
        const l = layoutChunk(i, z, this.widths, this.low);
        maxStatic = Math.max(maxStatic, l.items.length);
        maxAnim = Math.max(maxAnim, l.anim.length);
      }
    }
    maxStatic += 12;
    maxAnim += 2;
    const anyGeo = this.modules.values().next().value!.geometry;
    for (let c = 0; c < CHUNK_COUNT; c++) {
      const node = new Container3D({ label: `chunk${c}`, parent: this.root });
      const statics: Mesh3D[] = [];
      for (let i = 0; i < maxStatic; i++) statics.push(new Mesh3D({ parent: node, geometry: anyGeo, material: main, visible: false, castShadow: false }));
      const anims: AnimSlot[] = [];
      for (let i = 0; i < maxAnim; i++) {
        anims.push({ mesh: new Mesh3D({ parent: node, geometry: anyGeo, material: main, visible: false, castShadow: false }), kind: 'swing', phase: 0, baseY: 0 });
      }
      this.chunks.push({ node, index: Number.NaN, zone: -1, statics, small: statics.map(() => false), staticCount: 0, detail: true, anims, animCount: 0 });
    }

    stage.onRebase((dz) => {
      for (const ch of this.chunks) ch.node.position.z += dz;
    });

    this.prewarm();
    this.relayout(0);
  }

  /** Triangle count of a module (perf reporting / tests). */
  moduleTriangles(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const [k, m] of this.modules) o[k] = m.triangles;
    return o;
  }

  update(playerS: number, zone: number, _zoneBlend: number, dt: number): void {
    this.time += dt;
    // Debug zone override: shift every chunk's zone by the difference to the positional zone.
    const posZone = Math.floor(playerS / ZONE_LENGTH) % ZONE_COUNT;
    const offset = (((zone - posZone) % ZONE_COUNT) + ZONE_COUNT) % ZONE_COUNT;
    if (offset !== this.zoneOffset || playerS < this.lastS - 1) {
      this.zoneOffset = offset;
      this.relayout(playerS);
    }
    this.lastS = playerS;

    const first = Math.floor((playerS - BEHIND) / CHUNK_LEN);
    const last = first + CHUNK_COUNT - 1;
    for (let k = first; k <= last; k++) {
      let have = false;
      for (const ch of this.chunks) if (ch.index === k) { have = true; break; }
      if (have) continue;
      for (const ch of this.chunks) {
        if (!(ch.index >= first && ch.index <= last)) {
          this.place(ch, k);
          break;
        }
      }
    }
    for (const ch of this.chunks) {
      const want = ch.index * CHUNK_LEN - playerS < DETAIL_AHEAD;
      if (want !== ch.detail) this.setDetail(ch, want);
    }
    this.animate();
  }

  private setDetail(ch: Chunk, on: boolean): void {
    ch.detail = on;
    for (let i = 0; i < ch.staticCount; i++) if (ch.small[i]) ch.statics[i].visible = on;
  }

  // ------------------------------------------------------------------ internal

  private relayout(playerS: number): void {
    const first = Math.floor((playerS - BEHIND) / CHUNK_LEN);
    for (let i = 0; i < this.chunks.length; i++) this.place(this.chunks[i], first + i);
  }

  private place(ch: Chunk, index: number): void {
    const zone = chunkZone(index, this.zoneOffset, ZONE_LENGTH, ZONE_COUNT);
    ch.index = index;
    ch.node.position.z = this.stage.worldZ(index * CHUNK_LEN);
    const lay = layoutChunk(index, zone, this.widths, this.low);
    ch.zone = zone;
    ch.detail = index * CHUNK_LEN - this.lastS < DETAIL_AHEAD;
    let n = 0;
    for (const it of lay.items) {
      const mod = this.modules.get(it.key);
      if (!mod || n >= ch.statics.length) continue;
      const m = ch.statics[n++];
      m.geometry = mod.geometry;
      if (m.material !== mod.material) m.material = mod.material;
      if (m.castShadow !== mod.shadow) m.castShadow = mod.shadow;
      m.position.set(it.x, it.y, -it.u);
      m.rotation.y = it.rot;
      ch.small[n - 1] = mod.small;
      m.visible = !mod.small || ch.detail;
    }
    ch.staticCount = n;
    for (let i = n; i < ch.statics.length; i++) ch.statics[i].visible = false;
    let a = 0;
    for (const it of lay.anim) {
      const mod = this.modules.get(it.key);
      if (!mod || a >= ch.anims.length) continue;
      const slot = ch.anims[a++];
      slot.mesh.geometry = mod.geometry;
      if (slot.mesh.castShadow !== mod.shadow) slot.mesh.castShadow = mod.shadow;
      slot.mesh.position.set(it.x, it.y, -it.u);
      slot.mesh.rotation.set(0, it.rot, 0);
      slot.kind = it.anim;
      slot.phase = it.phase;
      slot.baseY = it.y;
      slot.mesh.visible = true;
    }
    for (let i = a; i < ch.anims.length; i++) ch.anims[i].mesh.visible = false;
    ch.animCount = a;
  }

  private animate(): void {
    const t = this.time;
    for (const ch of this.chunks) {
      for (let i = 0; i < ch.animCount; i++) {
        const s = ch.anims[i];
        const m = s.mesh;
        if (s.kind === 'swing') {
          m.rotation.x = Math.sin(t * 1.25 + s.phase) * 0.07 + Math.sin(t * 2.9 + s.phase * 2) * 0.02;
        } else {
          m.position.y = s.baseY + Math.sin(t * 0.9 + s.phase) * 0.09;
          m.rotation.z = Math.sin(t * 0.75 + s.phase) * 0.035;
          m.rotation.x = Math.sin(t * 0.6 + s.phase * 1.7) * 0.02;
        }
      }
    }
  }

  /** Draw every module once in front of the camera so GPU uploads + shader builds happen now. */
  private prewarm(): void {
    const warm = new Container3D({ label: 'scenery-prewarm', parent: this.root });
    let i = 0;
    for (const mod of this.modules.values()) {
      const m = new Mesh3D({ parent: warm, geometry: mod.geometry, material: mod.material, castShadow: false });
      m.position.set((i % 10) - 5, 0, -40 - Math.floor(i / 10));
      m.scale.set(0.01, 0.01, 0.01);
      i++;
    }
    const cam = this.stage.camera;
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    try {
      this.stage.render();
    } catch {
      // A failed warm-up only costs a hitch later.
    }
    cam.position.set(px, py, pz);
    for (const c of warm.removeChildren()) c.destroy();
    warm.destroy();
  }
}
