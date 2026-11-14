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
import { Container3D, CubeGeometry, Mesh3D } from '@pixi/3d';
import type { Geometry3D, Material3D } from '@pixi/3d';
import { ZONE_COUNT, ZONE_LENGTH } from '../../sim/config';
import type { Stage } from '../stage';
import { chunkZone, layoutChunk, type AnimKind, type WidthTable } from './layout';
import { CHUNK_LEN } from './layoutConst';
import type { Box } from './buildings';
import { lowTable, moduleDefs, shadowTable, widthTable } from './library';
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
const DETAIL_AHEAD = 100;
/**
 * Mid-size frontage (stalls, cafes, crates, boats...) is hidden beyond this distance: at 120 m+
 * it is a few pixels in heavy fog, and dropping it keeps the next zone's stall kinds out of the
 * draw list while that zone is still far ahead.
 */
const MEDIUM_AHEAD = 125;
/**
 * A chunk whose NEAR end is this far ahead is entirely beyond the fog's far plane and is not drawn
 * at all. The fog ends at 160-200 m depending on the zone (read live from the view's fog; this is
 * the cap), the camera sits ~7 m behind the player, so the margin is the fog far + 12 m.
 */
const HIDE_AHEAD = 212;

interface Module {
  geometry: Geometry3D;
  material: Material3D;
  shadow: boolean;
  /** 0 = always drawn, 1 = small clutter (DETAIL_AHEAD), 2 = mid-size frontage (MEDIUM_AHEAD). */
  tier: 0 | 1 | 2;
  triangles: number;
}

interface AnimSlot {
  mesh: Mesh3D;
  kind: AnimKind;
  phase: number;
  baseY: number;
  tier: number;
}

interface Chunk {
  node: Container3D;
  index: number;
  zone: number;
  statics: Mesh3D[];
  /** Shadow-only unit boxes standing in for the detailed buildings in the shadow pass. */
  proxies: Mesh3D[];
  proxyCount: number;
  /** Distance tier of each static slot (see Module.tier). */
  tier: number[];
  staticCount: number;
  /** Chunk is close enough for small clutter / mid-size frontage / at all. */
  detail: boolean;
  medium: boolean;
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
  private readonly shadows: Map<string, Box[]>;
  private readonly chunks: Chunk[] = [];
  private zoneOffset = 0;
  private lastS = 0;
  private time = 0;

  constructor(stage: Stage) {
    this.stage = stage;
    stage.world.addChild(this.root);
    this.widths = widthTable();
    this.low = lowTable();
    this.shadows = shadowTable();

    // ---- Build the module library (the only geometry building we ever do).
    const main = sceneryMaterial();
    const water = waterMaterial();
    for (const [key, def] of moduleDefs()) {
      const mb = def.build();
      this.modules.set(key, { geometry: mb.build(), material: def.material === 'water' ? water : main, shadow: def.shadow, tier: def.tier ?? 0, triangles: mb.triangleCount });
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
        anims.push({ mesh: new Mesh3D({ parent: node, geometry: anyGeo, material: main, visible: false, castShadow: false }), kind: 'swing', phase: 0, baseY: 0, tier: 0 });
      }
      this.chunks.push({ node, index: Number.NaN, zone: -1, statics, proxies: [], proxyCount: 0, tier: statics.map(() => 0), staticCount: 0, detail: true, medium: true, anims, animCount: 0 });
    }

    stage.onRebase((dz) => {
      for (const ch of this.chunks) ch.node.position.z += dz;
    });

    this.prewarm();

    // Shadow proxies: one shared unit cube, drawn only in the shadow pass (created after the
    // warm-up render so the 'opaque' pass name is registered for disablePass).
    const unit = new CubeGeometry({ width: 1, height: 1, depth: 1 });
    for (const ch of this.chunks) {
      for (let i = 0; i < 40; i++) {
        const p = new Mesh3D({ parent: ch.node, geometry: unit, material: main, visible: false, castShadow: true, receiveShadow: false });
        p.disablePass('opaque');
        ch.proxies.push(p);
      }
    }
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
    const chunks = this.chunks;
    // Index loops only: update() runs every frame and must not allocate.
    for (let k = first; k <= last; k++) {
      let have = false;
      for (let c = 0; c < chunks.length; c++) if (chunks[c].index === k) { have = true; break; }
      if (have) continue;
      for (let c = 0; c < chunks.length; c++) {
        const ch = chunks[c];
        if (!(ch.index >= first && ch.index <= last)) {
          this.place(ch, k);
          break;
        }
      }
    }
    const hide = Math.min(HIDE_AHEAD, (this.stage.view.fog?.far ?? HIDE_AHEAD) + 12);
    for (let c = 0; c < chunks.length; c++) {
      const ch = chunks[c];
      const ahead = ch.index * CHUNK_LEN - playerS;
      ch.node.visible = ahead < hide;
      const detail = ahead < DETAIL_AHEAD, medium = ahead < MEDIUM_AHEAD;
      if (detail !== ch.detail || medium !== ch.medium) this.setDetail(ch, detail, medium);
    }
    this.animate();
  }

  private setDetail(ch: Chunk, detail: boolean, medium: boolean): void {
    ch.detail = detail;
    ch.medium = medium;
    for (let i = 0; i < ch.staticCount; i++) {
      const t = ch.tier[i];
      if (t) ch.statics[i].visible = t === 1 ? detail : medium;
    }
    for (let i = 0; i < ch.animCount; i++) {
      const t = ch.anims[i].tier;
      if (t) ch.anims[i].mesh.visible = t === 1 ? detail : medium;
    }
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
    ch.medium = index * CHUNK_LEN - this.lastS < MEDIUM_AHEAD;
    ch.node.visible = index * CHUNK_LEN - this.lastS < HIDE_AHEAD;
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
      ch.tier[n - 1] = mod.tier;
      m.visible = mod.tier === 0 || (mod.tier === 1 ? ch.detail : ch.medium);
    }
    ch.staticCount = n;
    for (let i = n; i < ch.statics.length; i++) ch.statics[i].visible = false;
    // Shadow proxies for the buildings of this chunk.
    let pc = 0;
    for (const it of lay.items) {
      const boxes = this.shadows.get(it.key);
      if (!boxes) continue;
      const c = Math.cos(it.rot), sn = Math.sin(it.rot);
      for (const b of boxes) {
        if (pc >= ch.proxies.length) break;
        const p = ch.proxies[pc++];
        const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
        p.position.set(it.x + c * cx + sn * cz, it.y + (b[1] + b[4]) / 2, -it.u - sn * cx + c * cz);
        p.rotation.y = it.rot;
        p.scale.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
        p.visible = true;
      }
    }
    ch.proxyCount = pc;
    for (let i = pc; i < ch.proxies.length; i++) ch.proxies[i].visible = false;
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
      slot.tier = mod.tier;
      slot.mesh.visible = mod.tier === 0 || (mod.tier === 1 ? ch.detail : ch.medium);
    }
    for (let i = a; i < ch.anims.length; i++) ch.anims[i].mesh.visible = false;
    ch.animCount = a;
  }

  private animate(): void {
    const t = this.time;
    for (let c = 0; c < this.chunks.length; c++) {
      const ch = this.chunks[c];
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
