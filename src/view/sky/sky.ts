// Sky: gradient dome, sun disc + glow, moon, twinkling stars and drifting low-poly clouds.
//
// Everything lives under one `root` that follows the camera position (never its rotation), so the
// sky sits "at infinity". It is placed just inside the camera far plane and every material has
// `fog: false`; the dome's lowest band IS the fog colour, so fogged street geometry melts into the
// horizon haze with no seam. Colours are pushed by Atmosphere with `apply()` (only when the zone
// blend changes); `update(dt)` animates (twinkle, cloud drift) and allocates nothing.
import { Container3D, FlatMaterial, Geometry3D, Material3D, Mesh3D, ParticleContainer3D, PlaneGeometry } from '@pixi/3d';
import { hexToLinear, type RGB } from '../geom/color';
import { MeshBuilder } from '../geom/meshBuilder';
import { CAMERA_FAR, type Stage } from '../stage';
import { glowTexture, moonTexture, starTexture } from './textures';

/** Resolved (already blended) sky look. Colours are sRGB hex. Angles in degrees. */
export interface SkyState {
  zenith: number;
  upper: number;
  horizon: number;
  /** Haze band at and below the horizon: must equal the fog colour. */
  haze: number;
  /** Warm scattering tint around the sun/moon direction, and its strength 0..1. */
  glow: number;
  glowStrength: number;
  /** Sky-object direction (azimuth: 0 = straight down the street (-Z), + to the right). */
  sunAz: number;
  sunEl: number;
  sunColor: number;
  /** 0..1 visibility of the sun disc + halo. */
  sun: number;
  moonAz: number;
  moonEl: number;
  moon: number;
  /** 0..1 star visibility. */
  stars: number;
  /** Cloud tint (multiplies white-topped vertex colours) and 0..1 coverage. */
  cloudTint: number;
  clouds: number;
}

export const DOME_RADIUS = CAMERA_FAR * 0.9;
const SUN_DIST = DOME_RADIUS * 0.92;
const STAR_DIST = DOME_RADIUS * 0.88;

/** Ring elevations of the dome (deg): dense around the horizon where the gradient lives. */
const RINGS = [-90, -20, -4, 0, 1.5, 3.5, 6, 9, 13, 18, 25, 34, 45, 58, 72, 90];
const SEGMENTS = 40;
const STAR_COUNT = 240;

const D2R = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Direction from azimuth/elevation (deg) in our world: az 0 = -Z, + toward +X. */
function dirFrom(az: number, el: number, out: RGB): RGB {
  const a = az * D2R, e = el * D2R;
  out[0] = Math.sin(a) * Math.cos(e);
  out[1] = Math.sin(e);
  out[2] = -Math.cos(a) * Math.cos(e);
  return out;
}

function rand(seed: { v: number }): number {
  seed.v = (seed.v * 16807) % 2147483647;
  return seed.v / 2147483647;
}

export class Sky {
  readonly root = new Container3D({ label: 'sky' });
  private readonly stage: Stage;

  readonly dome: Mesh3D;
  private readonly domeGeo: Geometry3D;
  private readonly domeDirs: Float32Array; // unit directions per vertex
  private domeColors: Float32Array;

  private readonly sunDisc: Mesh3D;
  private readonly sunDiscMat: Material3D;
  private readonly sunHalo: Mesh3D;
  private readonly sunHaloMat: FlatMaterial;
  private readonly sunGlare: Mesh3D;
  private readonly sunGlareMat: FlatMaterial;
  private readonly moonDisc: Mesh3D;
  private readonly moonMat: FlatMaterial;
  private readonly moonHalo: Mesh3D;
  private readonly moonHaloMat: FlatMaterial;

  private readonly stars: ParticleContainer3D;
  private readonly starPos: Float32Array; // x, y, z, size, freq, phase
  private starLevel = 0;

  private readonly cloudLayers: Container3D[] = [];
  private readonly cloudMat: FlatMaterial;
  private readonly cloudMeshes: Mesh3D[] = [];
  private readonly cloudBaseScale: number[] = [];

  private time = 0;
  private readonly c0: RGB = [0, 0, 0];
  private readonly c1: RGB = [0, 0, 0];
  private readonly c2: RGB = [0, 0, 0];
  private readonly c3: RGB = [0, 0, 0];
  private readonly cg: RGB = [0, 0, 0];
  private readonly cs: RGB = [0, 0, 0];
  private readonly dSun: RGB = [0, 0, 0];
  private readonly dMoon: RGB = [0, 0, 0];

  constructor(stage: Stage) {
    this.stage = stage;
    stage.view.root.addChild(this.root);

    // ---- dome (dynamic vertex colours, recoloured on apply())
    const rings = RINGS.length;
    const cols = SEGMENTS + 1;
    const n = rings * cols;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    this.domeDirs = new Float32Array(n * 3);
    this.domeColors = new Float32Array(n * 4);
    for (let r = 0; r < rings; r++) {
      const e = RINGS[r] * D2R;
      for (let c = 0; c < cols; c++) {
        const a = (c / SEGMENTS) * Math.PI * 2;
        const i = r * cols + c;
        const dx = Math.sin(a) * Math.cos(e), dy = Math.sin(e), dz = -Math.cos(a) * Math.cos(e);
        this.domeDirs.set([dx, dy, dz], i * 3);
        positions.set([dx * DOME_RADIUS, dy * DOME_RADIUS, dz * DOME_RADIUS], i * 3);
        normals.set([-dx, -dy, -dz], i * 3);
        uvs.set([c / SEGMENTS, r / (rings - 1)], i * 2);
        this.domeColors[i * 4 + 3] = 1;
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < rings - 1; r++) {
      for (let c = 0; c < SEGMENTS; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e2 = d + 1;
        idx.push(a, d, b, b, d, e2);
      }
    }
    this.domeGeo = new Geometry3D({
      positions, normals, uvs, colors: this.domeColors, indices: new Uint16Array(idx), dynamic: true,
    });
    // Write colours straight into the attribute's own array (the geometry may have copied ours).
    const attr = this.domeGeo.attributes.aColor;
    if (attr && attr.buffer.data instanceof Float32Array && attr.buffer.data.length === this.domeColors.length) {
      this.domeColors = attr.buffer.data;
    }
    this.dome = new Mesh3D({
      parent: this.root,
      label: 'skyDome',
      geometry: this.domeGeo,
      material: new FlatMaterial({ baseColor: 0xffffff, vertexColors: true, fog: false, doubleSided: true }),
      castShadow: false,
      receiveShadow: false,
    });

    // ---- sun: emissive disc (blooms) + additive halo + wide soft glare
    const discGeo = new MeshBuilder().push().rotateX(Math.PI / 2).cylinder(1, 0.01, 28).pop().build();
    this.sunDiscMat = new Material3D({ baseColor: 0x000000, roughness: 1, fog: false, emissive: { color: 0xffffff, strength: 6 } });
    this.sunDisc = new Mesh3D({ parent: this.root, geometry: discGeo, material: this.sunDiscMat, castShadow: false, receiveShadow: false });
    const quad = new PlaneGeometry({ width: 2, height: 2 });
    const additive = (tex = glowTexture()) => {
      const m = new FlatMaterial({ baseColorTexture: tex, alphaMode: 'blend', fog: false, doubleSided: true });
      m.state.blendMode = 'add';
      return m;
    };
    this.sunHaloMat = additive();
    this.sunHalo = new Mesh3D({ parent: this.root, geometry: quad, material: this.sunHaloMat, castShadow: false, receiveShadow: false });
    this.sunGlareMat = additive();
    this.sunGlare = new Mesh3D({ parent: this.root, geometry: quad, material: this.sunGlareMat, castShadow: false, receiveShadow: false });

    // ---- moon: textured disc + cool halo
    this.moonMat = new FlatMaterial({ baseColorTexture: moonTexture(), alphaMode: 'blend', fog: false, doubleSided: true });
    this.moonDisc = new Mesh3D({ parent: this.root, geometry: quad, material: this.moonMat, castShadow: false, receiveShadow: false });
    this.moonHaloMat = additive();
    this.moonHalo = new Mesh3D({ parent: this.root, geometry: quad, material: this.moonHaloMat, castShadow: false, receiveShadow: false });

    // ---- stars (biased toward the view down the street, where the sky actually shows)
    this.stars = new ParticleContainer3D({ texture: starTexture(), capacity: STAR_COUNT, blendMode: 'add', space: 'local' });
    this.root.addChild(this.stars);
    this.starPos = new Float32Array(STAR_COUNT * 6);
    const seed = { v: 9173 };
    for (let i = 0; i < STAR_COUNT; i++) {
      const forward = i < STAR_COUNT * 0.6;
      const az = forward ? (rand(seed) - 0.5) * 120 : rand(seed) * 360;
      const el = 4 + Math.pow(rand(seed), 1.3) * (forward ? 55 : 80);
      dirFrom(az, el, this.c0);
      const o = i * 6;
      this.starPos[o] = this.c0[0] * STAR_DIST;
      this.starPos[o + 1] = this.c0[1] * STAR_DIST;
      this.starPos[o + 2] = this.c0[2] * STAR_DIST;
      const big = rand(seed);
      this.starPos[o + 3] = 0.9 + big * big * big * 2.6;
      this.starPos[o + 4] = 0.6 + rand(seed) * 2.6;
      this.starPos[o + 5] = rand(seed) * Math.PI * 2;
    }
    this.stars.visible = false;

    // ---- clouds: chunky faceted puffs, two layers drifting at different speeds
    this.cloudMat = new FlatMaterial({ baseColor: 0xffffff, vertexColors: true, fog: false });
    const variants = [0, 1, 2, 3, 4].map((v) => cloudGeometry(v));
    const cseed = { v: 4242 };
    for (let layer = 0; layer < 2; layer++) {
      const node = new Container3D({ label: `clouds${layer}`, parent: this.root });
      this.cloudLayers.push(node);
      const count = layer === 0 ? 11 : 9;
      const dist = layer === 0 ? DOME_RADIUS * 0.8 : DOME_RADIUS * 0.66;
      for (let i = 0; i < count; i++) {
        const az = (i / count) * 360 + (rand(cseed) - 0.5) * 22;
        const el = (layer === 0 ? 7 : 11) + rand(cseed) * (layer === 0 ? 8 : 14);
        dirFrom(az, el, this.c0);
        const s = (layer === 0 ? 15 : 11) * (0.7 + rand(cseed) * 0.7);
        const mesh = new Mesh3D({
          parent: node,
          geometry: variants[Math.floor(rand(cseed) * variants.length)],
          material: this.cloudMat,
          castShadow: false,
          receiveShadow: false,
        });
        mesh.position.set(this.c0[0] * dist, this.c0[1] * dist, this.c0[2] * dist);
        mesh.rotation.y = -az * D2R + (rand(cseed) - 0.5) * 0.6;
        mesh.scale.set(s, s * (0.8 + rand(cseed) * 0.3), s);
        this.cloudMeshes.push(mesh);
        this.cloudBaseScale.push(s);
      }
      node.rotation.y = layer * 0.7;
    }

    // Follow the camera at the last moment of the frame (after the camera rig and any re-base).
    stage.onBeforeRender(() => {
      const p = this.stage.camera.position;
      this.root.position.set(p.x, p.y, p.z);
    });
  }

  /** Recolour / reposition for a new blended look (cheap; call when the zone blend changes). */
  apply(s: SkyState): void {
    // dome colours (linear)
    const zen = hexToLinear(s.zenith, this.c0);
    const up = hexToLinear(s.upper, this.c1);
    const hor = hexToLinear(s.horizon, this.c2);
    const haze = hexToLinear(s.haze, this.c3);
    const glow = hexToLinear(s.glow, this.cg);
    const sunD = dirFrom(s.sunAz, s.sunEl, this.dSun);
    const moonD = dirFrom(s.moonAz, s.moonEl, this.dMoon);
    const glowDir = s.sun >= s.moon ? sunD : moonD;
    const dirs = this.domeDirs, cols = this.domeColors;
    const out = this.cs;
    for (let i = 0, n = dirs.length / 3; i < n; i++) {
      const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
      // haze -> horizon -> upper -> zenith by height
      const t1 = smooth(0.0, 0.09, dy);
      const t2 = smooth(0.06, 0.42, dy);
      const t3 = smooth(0.35, 1.0, dy);
      for (let k = 0; k < 3; k++) {
        let v = haze[k] + (hor[k] - haze[k]) * t1;
        v += (up[k] - v) * t2;
        v += (zen[k] - v) * t3;
        out[k] = v;
      }
      // forward scattering around the sun/moon, strongest low in the sky
      const cos = Math.max(0, dx * glowDir[0] + dy * glowDir[1] + dz * glowDir[2]);
      const g = s.glowStrength * (Math.pow(cos, 5) * 0.75 + Math.pow(cos, 40) * 0.5) * (1 - 0.5 * Math.max(0, dy)) * (dy > -0.02 ? 1 : 0);
      const gg = Math.min(1, g);
      for (let k = 0; k < 3; k++) cols[i * 4 + k] = out[k] + (glow[k] - out[k]) * gg;
    }
    this.domeGeo.attributes.aColor.buffer.update();

    // sun
    const sunVis = s.sun > 0.01;
    this.sunDisc.visible = this.sunHalo.visible = this.sunGlare.visible = sunVis;
    if (sunVis) {
      this.placeBillboard(this.sunDisc, sunD, SUN_DIST, 7);
      this.placeBillboard(this.sunHalo, sunD, SUN_DIST * 0.995, 34);
      this.placeBillboard(this.sunGlare, sunD, SUN_DIST * 0.99, 120);
      if (this.sunDiscMat.emissive) {
        this.sunDiscMat.emissive.color = s.sunColor;
        this.sunDiscMat.emissive.strength = 7 * s.sun;
      }
      this.sunHaloMat.baseColor = s.sunColor;
      this.sunHaloMat.alpha = 0.9 * s.sun;
      this.sunGlareMat.baseColor = s.glow;
      this.sunGlareMat.alpha = 0.45 * s.sun;
    }
    // moon
    const moonVis = s.moon > 0.01;
    this.moonDisc.visible = this.moonHalo.visible = moonVis;
    if (moonVis) {
      this.placeBillboard(this.moonDisc, moonD, SUN_DIST, 9);
      this.placeBillboard(this.moonHalo, moonD, SUN_DIST * 0.995, 60);
      this.moonMat.alpha = s.moon;
      this.moonHaloMat.baseColor = 0x9fb8ff;
      this.moonHaloMat.alpha = 0.55 * s.moon;
    }
    this.starLevel = s.stars;
    this.stars.visible = s.stars > 0.01;

    this.cloudMat.baseColor = s.cloudTint;
    const cov = Math.max(0, Math.min(1, s.clouds));
    for (let i = 0; i < this.cloudMeshes.length; i++) {
      // coverage: hide clouds in a fixed order as coverage drops
      const keep = (i * 0.618) % 1 < cov;
      this.cloudMeshes[i].visible = keep;
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.cloudLayers[0].rotation.y += dt * 0.0042;
    this.cloudLayers[1].rotation.y += dt * 0.0075;

    if (this.stars.visible) {
      const sp = this.starPos, lvl = this.starLevel, t = this.time;
      for (let i = 0; i < STAR_COUNT; i++) {
        const o = i * 6;
        const tw = 0.55 + 0.45 * Math.sin(t * sp[o + 4] + sp[o + 5]);
        this.stars.setParticleAt(i, sp[o], sp[o + 1], sp[o + 2], sp[o + 3] * (0.85 + 0.15 * tw), 0, 0xf2f4ff, lvl * tw);
      }
      this.stars.upload();
    }
  }

  private placeBillboard(mesh: Mesh3D, d: RGB, dist: number, size: number): void {
    mesh.position.set(d[0] * dist, d[1] * dist, d[2] * dist);
    mesh.scale.set(size, size, size);
    // Faces the sky centre (= the camera); the root only translates, so this stays valid.
    mesh.rotation.set(0, 0, 0);
    const r = this.root.position;
    mesh.lookAt({ x: r.x, y: r.y, z: r.z });
  }
}

/** One low-poly cloud: a flat-bottomed cluster of faceted puffs, white tops, cool undersides. */
function cloudGeometry(variant: number): Geometry3D {
  const seed = { v: 777 + variant * 131 };
  const mb = new MeshBuilder({ seed: 50 + variant, jitter: 0.05 });
  const paint = { color: 0xffffff, bottom: 0xaebcd2 };
  const puffs = 4 + (variant % 3);
  let x = -1.4;
  for (let i = 0; i < puffs; i++) {
    const r = 0.55 + rand(seed) * 0.55 * (i === 1 || i === 2 ? 1.3 : 1);
    mb.push().translate(x, r * 0.35, (rand(seed) - 0.5) * 0.6).sphere(r, r * 0.8, r * 0.85, 7, 4, paint).pop();
    x += 2.8 / puffs + rand(seed) * 0.2;
  }
  // flat base slab
  mb.push().translate(0, 0.05, 0).sphere(1.9, 0.28, 0.7, 8, 3, { color: 0xe4ebf5, bottom: 0xa2b2cc }).pop();
  return mb.build();
}
