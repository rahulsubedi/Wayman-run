// Dev-only model gallery (gallery.html). Not part of the game bundle.
// window.__gallery.show(scene, { night }) builds a scene, renders it and resolves when drawn;
// scripts/gallery-shot.mjs screenshots every scene.
import '@pixi/3d';
import { Container3D, DirectionalLight, Material3D, Mesh3D, PlaneGeometry, Vector3, View3D } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { Application, Point, RendererType } from 'pixi.js';
import type { WebGLRenderer } from 'pixi.js';
import { OBSTACLE_DIMS, ROLL_TIME } from '../../sim/config';
import type { ChaserState, ObstacleKind, PlayerAction, PlayerState, PowerupKind, SimState } from '../../sim/types';
import { ChaserRig, createObstacle, createPickup, HeroRig, updateObstacleVisual, updatePickupVisual } from './index';

type Powerups = SimState['powerups'];

interface Label {
  el: HTMLDivElement;
  at: Vector3;
}

interface SceneDef {
  title: string;
  camera: { pos: [number, number, number]; look: [number, number, number]; fov?: number };
  build(root: Container3D, label: (text: string, x: number, y: number, z: number) => void): void;
}

const NO_POWERUPS: Powerups = { magnet: 0, shield: 0, boost: 0, multiplier: 0 };

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    s: 0, x: 0, y: 0, vy: 0, lane: 0, action: 'run', actionTime: 0, grounded: true, speed: 18, lean: 0, runPhase: 0,
    ...over,
  };
}

interface PoseSpec {
  name: string;
  action: PlayerAction;
  /** Seconds into the action at the snapshot. */
  t?: number;
  phase?: number;
  vy?: number;
  y?: number;
  lean?: number;
  speed?: number;
  powerups?: Partial<Powerups>;
}

/** Drive a rig through a short history so blends, springs and the scarf settle naturally. */
function pose(rig: HeroRig, spec: PoseSpec): void {
  const dt = 1 / 60;
  const pw: Powerups = { ...NO_POWERUPS, ...spec.powerups };
  const speed = spec.speed ?? 18;
  const targetPhase = spec.phase ?? 0;
  const lead = 1.2;
  const t = spec.t ?? 0.5;
  // Run-up (phase rewound so it lands on targetPhase at the snapshot when the action is run).
  const p = player({ speed, lean: 0 });
  const total = lead + t;
  const n = Math.round(total / dt);
  for (let i = 0; i <= n; i++) {
    const time = i * dt;
    const into = time - lead;
    const phaseAt = targetPhase - (total - time) * speed * ((Math.PI * 2) / 2.6);
    p.runPhase = ((phaseAt % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    p.lean = (spec.lean ?? 0) * Math.min(1, Math.max(0, (time - (total - 0.3)) / 0.15));
    if (into < 0 || spec.action === 'run') {
      p.action = 'run';
      p.actionTime = time;
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
    } else {
      p.action = spec.action;
      p.actionTime = into;
      p.grounded = spec.action === 'roll' || spec.action === 'stumble' || spec.action === 'dead';
      if (spec.action === 'jump') {
        p.vy = 12.3 - 38 * into;
        p.y = 12.3 * into - 19 * into * into;
      } else if (spec.action === 'fall') {
        p.vy = spec.vy ?? -6;
        p.y = 1.2;
      } else if (spec.action === 'fly') {
        p.vy = 0;
        p.y = spec.y ?? 0.6;
      } else {
        p.vy = 0;
        p.y = 0;
      }
    }
    if (spec.y !== undefined) p.y = spec.y;
    rig.update(p, pw, dt);
  }
}

// ------------------------------------------------------------------- scenes

const OBST_SMALL: ObstacleKind[] = ['hurdle', 'overhead', 'blocker'];

function heroSheet(specs: PoseSpec[], spacing = 1.7): SceneDef {
  const w = (specs.length - 1) * spacing;
  return {
    title: 'Hero poses: back (gameplay) / side / front',
    camera: { pos: [0, 3.6, 13.5], look: [0, 3.3, 0], fov: 40 },
    build(root, label) {
      const rows = [0, -Math.PI / 2, Math.PI];
      rows.forEach((rot, r) => {
        specs.forEach((spec, i) => {
          const holder = new Container3D({ parent: root, position: { x: -w / 2 + i * spacing, y: 0.02 + (2 - r) * 2.25, z: 0 } });
          holder.rotation.y = rot;
          const rig = new HeroRig();
          holder.addChild(rig.node);
          pose(rig, spec);
          // Keep x offsets (lean/lane) out of the sheet.
          rig.node.position.x = 0;
          rig.node.position.y = Math.min(rig.node.position.y, 0.35);
          if (r === 0) label(spec.name, -w / 2 + i * spacing, 4.5 + 2.2, 0);
        });
      });
      // Shelves so the floating rows read as separate.
      for (let r = 1; r < 3; r++) {
        new Mesh3D({ parent: root, geometry: new PlaneGeometry({ width: w + 2, height: 1.6 }), material: shelfMat(), rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: 0, y: r * 2.25, z: 0 } });
      }
    },
  };
}

let shelf: Material3D | null = null;
function shelfMat(): Material3D {
  shelf ??= new Material3D({ baseColor: 0x7d8a99, roughness: 0.9 });
  return shelf;
}

const RUN4: PoseSpec[] = [
  { name: 'run 0', action: 'run', phase: 0 },
  { name: 'run ¼', action: 'run', phase: Math.PI / 2 },
  { name: 'run ½', action: 'run', phase: Math.PI },
  { name: 'run ¾', action: 'run', phase: Math.PI * 1.5 },
  { name: 'lean R', action: 'run', phase: 0.6, lean: 1 },
  { name: 'jump', action: 'jump', t: 0.2 },
  { name: 'fall', action: 'fall', t: 0.15, vy: -7 },
];
const ACTIONS2: PoseSpec[] = [
  { name: 'take-off', action: 'jump', t: 0.04 },
  { name: 'roll 25%', action: 'roll', t: ROLL_TIME * 0.25 },
  { name: 'roll 50%', action: 'roll', t: ROLL_TIME * 0.5 },
  { name: 'fly', action: 'fly', t: 1.2, y: 0.5 },
  { name: 'stumble', action: 'stumble', t: 0.22 },
  { name: 'dead 0.2s', action: 'dead', t: 0.2 },
  { name: 'dead', action: 'dead', t: 2 },
];
const FX: PoseSpec[] = [
  { name: 'shield', action: 'run', phase: 1, powerups: { shield: 1 } },
  { name: 'magnet', action: 'run', phase: 2, powerups: { magnet: 8 } },
  { name: 'boost (fly)', action: 'fly', t: 1, y: 0.4, powerups: { boost: 5 } },
  { name: 'multiplier', action: 'run', phase: 3, powerups: { multiplier: 9 } },
  { name: 'all', action: 'run', phase: 4, powerups: { shield: 1, magnet: 8, multiplier: 9 } },
];

function strip(title: string, specs: PoseSpec[], rot: number): SceneDef {
  const spacing = 1.45;
  const w = (specs.length - 1) * spacing;
  return {
    title,
    camera: { pos: [0, 1.6, 11.5], look: [0, 1.0, 0], fov: 38 },
    build(root, label) {
      specs.forEach((spec, i) => {
        const holder = new Container3D({ parent: root, position: { x: -w / 2 + i * spacing, y: 0, z: 0 } });
        holder.rotation.y = rot;
        const rig = new HeroRig();
        holder.addChild(rig.node);
        pose(rig, spec);
        rig.node.position.x = 0;
        rig.node.position.y = Math.min(rig.node.position.y, 0.35);
        label(spec.name, -w / 2 + i * spacing, 2.25, 0);
      });
    },
  };
}

const SCENES: Record<string, SceneDef> = {
  overview: {
    title: 'Wayman Run models',
    camera: { pos: [9, 9, 17], look: [0, 1, -2], fov: 45 },
    build(root, label) {
      // Back row: vehicles.
      const kinds: [ObstacleKind, number, number][] = [['truck', -7.5, 0], ['bus', -3.7, 0], ['busOncoming', 0, 0], ['ramp', 3.7, 0], ['truck', 7.4, 1], ['bus', 11.1, 2]];
      for (const [k, x, v] of kinds) {
        const n = createObstacle(k, v);
        n.position.set(x, 0, -6);
        root.addChild(n);
        label(k, x, OBSTACLE_DIMS[k].h + 0.4, -6 + OBSTACLE_DIMS[k].len / 2);
      }
      OBST_SMALL.forEach((k, i) => {
        const n = createObstacle(k);
        n.position.set(-5 + i * 3, 0, 2);
        root.addChild(n);
        label(k, -5 + i * 3, OBSTACLE_DIMS[k].h + 0.35, 2);
      });
      const hero = new HeroRig();
      root.addChild(hero.node);
      pose(hero, { name: '', action: 'run', phase: 1.2 });
      hero.node.position.set(4.5, 0, 3);
      label('Wayman', 4.5, 2.1, 3);
      const drone = new ChaserRig();
      root.addChild(drone.node);
      drone.node.position.set(7.5, 0, 4);
      for (let i = 0; i < 40; i++) drone.update({ gap: 4, visible: true }, i / 30, 1 / 30);
      label('Warden', 7.5, 3.3, 4);
      (['coin', 'magnet', 'shield', 'boost', 'multiplier'] as const).forEach((k, i) => {
        const n = createPickup(k);
        n.position.set(-6 + i * 1.5, 0, 6);
        root.addChild(n);
        updatePickupVisual(n, k, 0.3);
        label(k, -6 + i * 1.5, 1.6, 6);
      });
    },
  },
  obstacles: {
    title: 'Small obstacles + ramp (gameplay angle)',
    camera: { pos: [0, 3.9, 9.5], look: [0, 1.0, -2], fov: 58 },
    build(root, label) {
      ['hurdle', 'overhead', 'blocker'].forEach((k, i) => {
        const n = createObstacle(k as ObstacleKind);
        n.position.set((i - 1) * 2.5, 0, 0);
        root.addChild(n);
        updateObstacleVisual(n, k as ObstacleKind, 0.1);
        label(k, (i - 1) * 2.5, OBSTACLE_DIMS[k as ObstacleKind].h + 0.3, 0);
      });
      const r = createObstacle('ramp');
      r.position.set(0, 0, -9);
      root.addChild(r);
      const t = createObstacle('truck', 0);
      t.position.set(0, 0, -15);
      root.addChild(t);
      const r2 = createObstacle('ramp');
      r2.position.set(-2.5, 0, -11);
      root.addChild(r2);
      const b = createObstacle('bus', 0);
      b.position.set(-2.5, 0, -19);
      root.addChild(b);
      const on = createObstacle('busOncoming');
      on.position.set(2.5, 0, -12);
      root.addChild(on);
    },
  },
  obstaclesSide: {
    title: 'Small obstacles (side / three-quarter)',
    camera: { pos: [7.5, 2.6, 6], look: [0, 1.0, 0], fov: 45 },
    build(root, label) {
      ['hurdle', 'overhead', 'blocker', 'ramp'].forEach((k, i) => {
        const n = createObstacle(k as ObstacleKind);
        n.position.set(0, 0, 4 - i * 4.2);
        root.addChild(n);
        label(k, 0, Math.min(3, OBSTACLE_DIMS[k as ObstacleKind].h) + 0.3, 4 - i * 4.2);
      });
    },
  },
  vehicles: {
    title: 'Vehicles: liveries (rear three-quarter, as the player meets them)',
    camera: { pos: [6, 6.5, 16], look: [0, 1.2, -1], fov: 50 },
    build(root, label) {
      const list: [ObstacleKind, number][] = [['truck', 0], ['truck', 1], ['truck', 2], ['bus', 0], ['bus', 1], ['bus', 2], ['busOncoming', 0]];
      list.forEach(([k, v], i) => {
        const n = createObstacle(k, v);
        const x = -7.5 + i * 2.6;
        const z = k === 'truck' ? 2 : 0;
        n.position.set(x, 0, z);
        root.addChild(n);
        label(`${k} ${v + 1}`, x, 3.25, z + OBSTACLE_DIMS[k].len / 2);
      });
    },
  },
  vehiclesFront: {
    title: 'Vehicles (front three-quarter)',
    camera: { pos: [-7, 4.2, -15], look: [0, 1.2, 0], fov: 50 },
    build(root, label) {
      const list: [ObstacleKind, number][] = [['truck', 0], ['truck', 1], ['truck', 2], ['bus', 0], ['busOncoming', 0]];
      list.forEach(([k, v], i) => {
        const n = createObstacle(k, v);
        const x = -5 + i * 2.6;
        n.position.set(x, 0, 0);
        root.addChild(n);
        label(`${k} ${v + 1}`, x, 3.25, -OBSTACLE_DIMS[k].len / 2);
      });
    },
  },
  pickups: {
    title: 'Pickups',
    camera: { pos: [0, 1.6, 6.4], look: [0, 0.85, 0], fov: 40 },
    build(root, label) {
      (['coin', 'magnet', 'shield', 'boost', 'multiplier'] as const).forEach((k, i) => {
        const n = createPickup(k);
        n.position.set(-2.6 + i * 1.3, 0, 0);
        n.rotation.y = k === 'coin' ? 0.35 : 0.3;
        root.addChild(n);
        updatePickupVisual(n, k, 0.4);
        label(k, -2.6 + i * 1.3, 1.62, 0);
      });
      // A coin line as the game shows it (spinning at different angles).
      for (let i = 0; i < 6; i++) {
        const n = createPickup('coin');
        n.position.set(-1.2 + i * 0.5, -0.55, -1.5 - i * 0.6);
        n.rotation.y = i * 0.5;
        root.addChild(n);
      }
    },
  },
  drone: {
    title: 'Warden drone',
    camera: { pos: [3.2, 3.4, 5.5], look: [0, 2.2, 0], fov: 42 },
    build(root, label) {
      const d = new ChaserRig();
      root.addChild(d.node);
      d.node.position.set(-1.2, 0, 0);
      d.setTarget(1.5, -2, -6);
      for (let i = 0; i < 40; i++) d.update({ gap: 6, visible: true }, i / 30, 1 / 30);
      const d2 = new ChaserRig();
      root.addChild(d2.node);
      d2.node.position.set(1.6, 0, -1.5);
      d2.node.rotation.y = Math.PI * 0.85;
      d2.setTarget(0, -2, -4);
      for (let i = 0; i < 43; i++) d2.update({ gap: 4, visible: true }, i / 30 + 0.3, 1 / 30);
      label('Warden (rear)', -1.2, 3.1, 0);
      label('front', 1.6, 3.1, -1.5);
    },
  },
  heroClose: {
    title: 'Wayman close-up: chase view / three-quarter front / side',
    camera: { pos: [0, 2.3, 5.2], look: [0, 1.05, 0], fov: 40 },
    build(root, label) {
      const views: [number, number, string][] = [[-1.5, 0, 'chase view'], [0, Math.PI * 0.8, 'front 3/4'], [1.5, -Math.PI / 2, 'side']];
      for (const [x, rot, name] of views) {
        const holder = new Container3D({ parent: root, position: { x, y: 0, z: 0 } });
        holder.rotation.y = rot;
        const rig = new HeroRig();
        holder.addChild(rig.node);
        pose(rig, { name, action: 'run', phase: 0.9, speed: 22 });
        rig.node.position.x = 0;
        label(name, x, 2.15, 0);
      }
    },
  },
  heroA: heroSheet(RUN4),
  heroB: heroSheet(ACTIONS2),
  heroFx: { ...heroSheet(FX, 2.4), title: 'Hero power-up visuals' },
  runCycle: strip('Run cycle (side), 8 frames', Array.from({ length: 8 }, (_, i) => ({ name: `φ ${i}/8`, action: 'run' as const, phase: (i / 8) * Math.PI * 2 })), -Math.PI / 2),
  roll: strip('Roll (side), 0 → 0.65 s', Array.from({ length: 8 }, (_, i) => ({ name: `${((i / 7) * ROLL_TIME).toFixed(2)}s`, action: 'roll' as const, t: (i / 7) * ROLL_TIME * 0.999 })), -Math.PI / 2),
  heroBack: {
    title: 'Gameplay camera: hero from behind with the drone',
    camera: { pos: [0, 3.9, 6.8], look: [0, 1.0, -9], fov: 58 },
    build(root) {
      const hero = new HeroRig();
      root.addChild(hero.node);
      pose(hero, { name: '', action: 'run', phase: 2.2, powerups: { shield: 1 } });
      hero.node.position.x = 0;
      const drone = new ChaserRig();
      root.addChild(drone.node);
      drone.node.position.set(1.7, 0, 4);
      for (let i = 0; i < 40; i++) drone.update({ gap: 4, visible: true }, i / 30, 1 / 30);
      for (let i = 0; i < 8; i++) {
        const c = createPickup('coin');
        c.position.set(0, 0, -4 - i * 2.4);
        c.rotation.y = i * 0.6;
        root.addChild(c);
      }
      const h = createObstacle('hurdle');
      h.position.set(-2.5, 0, -10);
      root.addChild(h);
      const o = createObstacle('overhead');
      o.position.set(2.5, 0, -14);
      root.addChild(o);
    },
  },
};

// --------------------------------------------------------------------- app

async function main(): Promise<void> {
  const app = new Application();
  await app.init({ preference: 'webgl', resizeTo: window, antialias: true, backgroundColor: 0x9fb2c2, resolution: 1 });
  document.body.prepend(app.canvas);
  app.canvas.style.display = 'block';

  const canFloat = app.renderer.type !== RendererType.WEBGL || Boolean((app.renderer as WebGLRenderer).context?.extensions?.colorBufferFloat);
  let bloom: BloomEffect | null = null;
  if (canFloat) {
    try {
      bloom = new BloomEffect({ intensity: 0.6, radius: 0.6, threshold: 1 });
    } catch {
      bloom = null;
    }
  }
  const env = { skyColor: 0xbfe0ff, groundColor: 0x8a7458, intensity: 0.75 };
  const view = new View3D({
    autoResize: true,
    shadowQuality: 'high',
    shadowFilter: 'pcf',
    toneMapping: 'aces',
    exposure: 1,
    environment: env,
    background: 0x9fb2c2,
    passes: bloom ? [bloom] : [],
  });
  app.stage.addChild(view);
  const sun = new DirectionalLight({ color: 0xfff1d6, intensity: 3.2, castShadow: true, shadow: { cascades: 2, maxDistance: 60, bias: 0.0008, normalBias: 0.04 } });
  view.root.addChild(sun);
  const groundMat = new Material3D({ baseColor: 0x8d99a6, roughness: 0.95 });
  const ground = new Mesh3D({ geometry: new PlaneGeometry({ width: 200, height: 200 }), material: groundMat, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, castShadow: false });
  view.root.addChild(ground);
  let root = new Container3D({ parent: view.root });

  const labelsEl = document.getElementById('labels')!;
  const titleEl = document.getElementById('title')!;
  const nav = document.getElementById('nav')!;
  const labels: Label[] = [];
  const tmp = new Point();

  const layoutLabels = () => {
    for (const l of labels) {
      const p = view.worldToScreen(l.at, tmp);
      l.el.style.display = p ? '' : 'none';
      if (p) {
        l.el.style.left = `${p.x}px`;
        l.el.style.top = `${p.y}px`;
      }
    }
  };

  const setLight = (night: boolean) => {
    const dir = night ? new Vector3(-0.3, -1, 0.2) : new Vector3(-0.45, -1, -0.35);
    sun.position.set(0, 0, 0);
    sun.lookAt(dir);
    sun.color = night ? 0x9bb4ff : 0xfff1d6;
    sun.intensity = night ? 1.3 : 3.2;
    env.skyColor = night ? 0x46609e : 0xbfe0ff;
    env.groundColor = night ? 0x2a2030 : 0x8a7458;
    env.intensity = night ? 0.85 : 0.75;
    view.environment = { ...env };
    view.exposure = night ? 1.25 : 1;
    const bg = night ? 0x1d2342 : 0x9fb2c2;
    view.background = bg;
    groundMat.baseColor = night ? 0x3a4256 : 0x8d99a6;
    if (bloom) bloom.intensity = night ? 1.0 : 0.6;
    document.body.style.background = night ? '#1d2342' : '#9fb2c2';
  };

  const show = async (name: string, opts: { night?: boolean } = {}): Promise<void> => {
    const def = SCENES[name];
    if (!def) throw new Error(`unknown scene ${name}`);
    root.destroy({ children: true });
    root = new Container3D({ parent: view.root });
    labels.length = 0;
    labelsEl.textContent = '';
    setLight(!!opts.night);
    const label = (text: string, x: number, y: number, z: number) => {
      const el = document.createElement('div');
      el.className = 'lbl';
      el.textContent = text;
      labelsEl.append(el);
      labels.push({ el, at: new Vector3(x, y, z) });
    };
    def.build(root, label);
    const cam = view.camera;
    cam.fov = def.camera.fov ?? 50;
    cam.near = 0.1;
    cam.far = 300;
    cam.position.set(...def.camera.pos);
    cam.lookAt({ x: def.camera.look[0], y: def.camera.look[1], z: def.camera.look[2] });
    titleEl.textContent = def.title + (opts.night ? ' (night)' : '');
    app.render();
    layoutLabels();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.render();
  };

  for (const name of Object.keys(SCENES)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => void show(name, { night: false });
    nav.append(b);
  }
  const nb = document.createElement('button');
  nb.textContent = 'night';
  nb.onclick = () => void show(location.hash.slice(1) || 'overview', { night: true });
  nav.append(nb);

  app.ticker.stop(); // render on demand (software GL here is slow)
  const g = window as unknown as { __gallery: unknown };
  g.__gallery = { show, scenes: Object.keys(SCENES), stats: () => stats(root) };
  await show(location.hash.slice(1) || 'overview');
}

function stats(root: Container3D): { meshes: number } {
  let meshes = 0;
  root.traverse((n) => {
    if (n instanceof Mesh3D && n.visible) meshes++;
  });
  return { meshes };
}

const g = window as unknown as { __galleryReady: Promise<void> };
g.__galleryReady = main();
g.__galleryReady.catch((e) => {
  console.error(e);
  document.body.append(String(e));
});

// Unused-type guard (keeps imports honest under noUnusedLocals).
export type { ChaserState, PowerupKind };
