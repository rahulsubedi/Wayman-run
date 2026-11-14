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
import type { Quality } from '../../sim/types';
import { chunkZone, layoutChunk, type AnimKind, type WidthTable } from './layout';
import { CHUNK_LEN } from './layoutConst';
import type { Box } from './buildings';
import { lowTable, moduleDefs, shadowTable, widthTable } from './library';
import { sceneryMaterial, waterMaterial } from './material';
import { buildGlint } from './ground';

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
 * Props do not pop at those distances: each one grows in over the last FADE_LEN metres before its
 * own threshold (per prop, not per chunk, so a chunk's props appear one by one, staggered by their
 * position along the street).
 */
const FADE_LEN = 12;
/**
 * Mid-size frontage (stalls, cafes, crates, boats...) is hidden beyond this distance: at 110 m+
 * it is a few pixels in heavy fog, and dropping it keeps the next zone's stall kinds out of the
 * draw list while that zone is still far ahead.
 */
const MEDIUM_AHEAD = 110;
/**
 * A chunk whose NEAR end is this far ahead is entirely beyond the fog's far plane and is not drawn
 * at all. The fog ends at 160-200 m depending on the zone (read live from the view's fog; this is
 * the cap), the camera sits ~7 m behind the player, so the margin is the fog far + 12 m.
 */
const HIDE_AHEAD = 212;

/**
 * Per quality tier: prop distances (small clutter, mid-size frontage) and the cap on whole-chunk
 * distance. Lower tiers also pull the fog in (Atmosphere), so the shorter reach stays invisible.
 */
const REACH: Record<Quality, { detail: number; medium: number; hide: number }> = {
  low: { detail: 52, medium: 66, hide: 168 },
  medium: { detail: 75, medium: 88, hide: 190 },
  high: { detail: DETAIL_AHEAD, medium: MEDIUM_AHEAD, hide: HIDE_AHEAD },
};

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
  /** Distance of the slot from its chunk start along the street. */
  u: number;
  /** Scale last written by the distance fade (1 = fully grown, 0 = hidden). */
  fade: number;
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
  /** Per static slot: distance from the chunk start along the street, and the last fade scale. */
  su: number[];
  fade: number[];
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
  /** Sun glitter on the harbour sea, kept level with the player (see buildGlint). */
  private readonly glint: Mesh3D;

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
        anims.push({ mesh: new Mesh3D({ parent: node, geometry: anyGeo, material: main, visible: false, castShadow: false }), u: 0, fade: 1, kind: 'swing', phase: 0, baseY: 0, tier: 0 });
      }
      this.chunks.push({ node, index: Number.NaN, zone: -1, statics, proxies: [], proxyCount: 0, tier: statics.map(() => 0), su: statics.map(() => 0), fade: statics.map(() => 1), staticCount: 0, detail: true, medium: true, anims, animCount: 0 });
    }

    stage.onRebase((dz) => {
      for (const ch of this.chunks) ch.node.position.z += dz;
    });

    this.glint = new Mesh3D({ parent: this.root, geometry: buildGlint().build(), material: main, castShadow: false, label: 'glint' });
    this.glint.receiveShadow = false;

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

  update(playerS: number, zone: number, zoneBlend: number, dt: number): void {
    this.time += dt;
    // Glitter: shown around the harbour (the town lots hide it elsewhere), shimmering sideways.
    const g = this.glint;
    g.visible = zone === 1 || (zone === 0 && zoneBlend > 0.02);
    if (g.visible) {
      g.position.z = this.stage.worldZ(playerS);
      g.scale.x = 1 + Math.sin(this.time * 2.3) * 0.025;
      g.scale.z = 1 + Math.sin(this.time * 1.7 + 1) * 0.02;
    }
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
    const reach = REACH[this.stage.quality];
    const hide = Math.min(reach.hide, (this.stage.view.fog?.far ?? HIDE_AHEAD) + 12);
    for (let c = 0; c < chunks.length; c++) {
      const ch = chunks[c];
      const ahead = ch.index * CHUNK_LEN - playerS;
      ch.node.visible = ahead < hide;
      if (ch.node.visible) this.fadeProps(ch, ahead, reach.detail, reach.medium);
    }
    this.animate();
  }

  /** Grow tiered props in (and hide them) by their own distance ahead. No allocation. */
  private fadeProps(ch: Chunk, ahead: number, detail: number, medium: number): void {
    if (ahead > medium || ahead + CHUNK_LEN < Math.min(detail, medium) - FADE_LEN) {
      // Entirely beyond or entirely inside both thresholds: settle every slot once.
      const far = ahead > medium;
      if (far ? ch.detail || ch.medium : !(ch.detail && ch.medium)) {
        ch.detail = ch.medium = !far;
        for (let i = 0; i < ch.staticCount; i++) if (ch.tier[i]) this.setFade(ch.statics[i], far ? 0 : 1, ch.fade, i);
        for (let i = 0; i < ch.animCount; i++) {
          const a = ch.anims[i];
          if (a.tier) a.fade = this.applyFade(a.mesh, far ? 0 : 1, a.fade);
        }
      }
      return;
    }
    ch.detail = ch.medium = false; // mixed: re-evaluated every frame while it straddles a threshold
    for (let i = 0; i < ch.staticCount; i++) {
      const t = ch.tier[i];
      if (!t) continue;
      const d = (t === 1 ? detail : medium) - (ahead + ch.su[i]);
      this.setFade(ch.statics[i], d >= FADE_LEN ? 1 : d <= 0 ? 0 : d / FADE_LEN, ch.fade, i);
    }
    for (let i = 0; i < ch.animCount; i++) {
      const a = ch.anims[i];
      if (!a.tier) continue;
      const d = (a.tier === 1 ? detail : medium) - (ahead + a.u);
      a.fade = this.applyFade(a.mesh, d >= FADE_LEN ? 1 : d <= 0 ? 0 : d / FADE_LEN, a.fade);
    }
  }

  private setFade(m: Mesh3D, f: number, store: number[], i: number): void {
    store[i] = this.applyFade(m, f, store[i]);
  }

  private applyFade(m: Mesh3D, f: number, prev: number): number {
    if (f === prev) return prev;
    m.visible = f > 0;
    if (f > 0) {
      const e = f * f * (3 - 2 * f);
      m.scale.set(e, e, e);
    }
    return f;
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
    // Freshly placed slots start fully grown; the next update() fades them by distance.
    ch.detail = ch.medium = true;
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
      m.scale.set(1, 1, 1);
      ch.tier[n - 1] = mod.tier;
      ch.su[n - 1] = it.u;
      ch.fade[n - 1] = 1;
      m.visible = true;
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
      slot.u = it.u;
      slot.fade = 1;
      slot.mesh.scale.set(1, 1, 1);
      slot.mesh.visible = true;
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
