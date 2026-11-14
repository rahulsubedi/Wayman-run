# Wayman Run

Wayman Run is a three-lane endless runner for desktop and mobile browsers. You play Wayman, a parcel courier sprinting down the main street of Port Solana, a coastal market town, while a patrol drone chases him.

## Quick start

You need Node.js and npm. See [Technical notes](#technical-notes) for the Node versions the dependencies require.

```sh
npm ci            # install the exact versions in package-lock.json
npm run dev       # start the Vite dev server and open the URL it prints
npm run build     # type-check (tsc --noEmit), then build into dist/
npm run preview   # serve the built dist/ locally
npm test          # run the unit tests once (vitest run)
```

The dev server also serves `gallery.html` at `/gallery.html`, a development-only gallery of the 3D models. It is not part of the game bundle.

The build uses relative URLs, so `dist/` can be served from any folder.

## How to play

Run as far as you can. Points come from distance run, coins collected and near misses. The multiplier power-up doubles all three while it is active.

The run ends on a head-on hit, or on a second stumble within 6 seconds (the drone catches up). Shields and stumbles are described below.

### Controls

| Action | Keyboard | Touch and mouse | Gamepad |
|---|---|---|---|
| Change lane | Left or Right arrow, A or D | Swipe left or right | D-pad left or right, left stick left or right |
| Jump | Up arrow, W or Space | Swipe up | D-pad up, A, X, or left stick up |
| Roll (pressed in the air: dive) | Down arrow or S | Swipe down | D-pad down, B, Y, or left stick down |
| Pause | P or Escape | Pause button on the HUD | Start |
| Start, or restart after game over | Space or Enter | PLAY or PLAY AGAIN button | Not available |

- A swipe fires once the finger moves about 6% of the shorter screen side, between 22 and 42 px. Dragging with the left mouse button works the same way. A tap does nothing.
- The left stick counts when pushed past about 60%.
- Gamepad input only controls the run. The menus need a keyboard or a pointer.
- A roll on the ground lasts 0.65 seconds.
- Game-over restart input is ignored for 650 ms after the game-over screen appears.
- Resuming from pause counts down 3, 2, 1.

### Obstacles

| Obstacle | What it is | What to do |
|---|---|---|
| Hurdle | Low barrier, 0.9 m high, one lane | Jump over it. Running into it on the ground ends the run. Clipping its top in mid-jump is a stumble. |
| Overhead gantry | Frame 2.6 m high, solid above 1.2 m | Roll under it. Standing into it ends the run. |
| Road-works blocker | Solid block 2.4 m high, cannot be stood on | Change lane. |
| Truck, bus | Vehicles 6 m and 10 m long, roof at 2.8 m | Change lane to pass the body. The roof can be run across, but a plain jump cannot reach it. Climb a ramp, or use a boost. |
| Ramp | Sloped approach up to a roof, 6 m long | Run straight at it to climb onto the roof. Coming at it from the side is a stumble. |
| Oncoming bus | 10 m bus driving toward you at 8 m/s in one lane | Change lane. |

Stumbles and crashes:

- A sideways hit, landing on an obstacle from above, or clipping a hurdle makes Wayman stumble for 0.6 seconds. A sideways stumble also bounces him back to the lane he came from.
- A second stumble within 6 seconds ends the run as "caught".
- A head-on hit ends the run at once.
- A shield absorbs a head-on hit, or the stumble that would have ended the run.

### Power-ups

Power-ups appear every 150 to 250 metres. Coins are worth 10 points each, multiplied while the multiplier is active.

| Power-up | Effect | Duration |
|---|---|---|
| Magnet | Coins within 6 m are pulled toward Wayman | 10 s |
| Shield | Absorbs one head-on hit, or one stumble that would have ended the run. Gives 1 s of invulnerability after a hit. | Held until used |
| Boost | Wayman flies up to 7 m, then descends at 8 m/s. He is invulnerable during the descent and for 1.5 s after landing. | 7 s of flight, then about 0.9 s of descent |
| Multiplier | Doubles points from distance, coins and near misses | 12 s |

## Features

- Three zones of 500 m that repeat: Market Street (midday), Harbor Front (golden hour) and Night Bazaar (night). Each zone blends into the next over its last 80 m.
- A curved world: the street bends away toward the horizon and swings sideways with distance. It is on by default.
- Procedural art: models, scenery and textures are built in code. Sound effects and music are synthesized with WebAudio. The game uses no image, model or audio files.
- Quality tiers Low, Med and High, which set shadows, post effects and resolution. Until you choose a tier, the game steps down a tier during runs when frames are slow.
- WebGL2 rendering by default. WebGPU is opt-in with `?renderer=webgpu`.
- Touch, keyboard and gamepad controls. The UI has screenshot checks at desktop, portrait and landscape sizes.
- Sound and quality choices are saved in the browser's `localStorage` under `wayman-run.settings`.
- The simulation is deterministic: a seed always produces the same track, and a built-in autopilot can play it.

## URL parameters

The game reads these query parameters on load, for example `/?autostart=1&seed=7&mute=1`.

| Name | Values | Effect |
|---|---|---|
| `autostart` | `1` | Starts a run as soon as the game is ready, using `seed`. |
| `seed` | Any number (default `1`) | Seed for the track generator. A value that is not a number is treated as `1`. |
| `autopilot` | `1` | Plays the run with the built-in autopilot from the start. |
| `quality` | `low`, `medium`, `high` | Fixes the quality tier. Other values are ignored. Fixing it turns off automatic quality. |
| `zone` | `0`, `1`, `2` | Forces the visual zone (0 Market Street, 1 Harbor Front, 2 Night Bazaar). Other values are ignored. |
| `mute` | `1` | Starts with sound muted. |
| `renderer` | `webgl`, `webgpu` | `webgl` uses WebGL2. `webgpu` asks for WebGPU and falls back to WebGL2 if it fails. Any other value, or no value, uses the default (WebGL2). |
| `bend` | `0`, `1`, or `down,side` | `0` turns the curved world off and `1` turns it on. A pair such as `15,-30` sets fixed bend amounts in metres at 100 m, and also turns the effect on. |

For scripts and ad-hoc checks, the page also sets `window.__wayman`. It exposes `ready`, `state()`, `start()`, `advance(seconds)`, `setAutopilot(on)`, `errors`, `game`, `mode()`, `pause()`, `resume()`, `home()`, `forceStumble()`, `forceCrash()`, `forcePickup(kind)`, `setZone(zone)`, `bend(on)` and `stats()`. This hook is not a stable API.

## Project structure

```
src/
  main.ts            Entry point: reads URL parameters, creates the Game, attaches the debug hook
  game.ts            Orchestrator: modes (menu, running, paused, gameover), frame loop,
                     and routing of sim events to the view, UI and audio
  debug.ts           URL parameter parsing and the window.__wayman hook
  sim/               Gameplay with no rendering, DOM or wall-clock access
    config.ts          Tuning constants: speeds, lanes, obstacle sizes, power-up durations, zone length
    types.ts           Shared types: entities, player and sim state, input actions, events, quality
    sim.ts             GameSim: the deterministic step (movement, collisions, pickups, power-ups, zones)
    generator.ts       Track generator: hand-authored patterns mixed by difficulty tier
    entity.ts          Entity pool and ramp geometry
    events.ts          Double-buffered queue of sim events
    rng.ts             Seeded PRNG (mulberry32). The sim never calls Math.random
    fairness.ts        Checks that a track has a survivable path that needs no reaction faster than the minimum
    autopilot.ts       Bot that reads only public state (used by ?autopilot=1 and the tests)
    index.ts           Re-exports the public sim API
  input/             Keyboard, swipe and gamepad input as edge-triggered actions
    index.ts           Input class: keys, pointer and touch swipes, gamepad polling
    swipe.ts           SwipeRecognizer: pure swipe-direction detection
  view/              Rendering with PixiJS 3D
    stage.ts           Owns the Application and View3D, picks the backend, quality tiers, world rebasing, curved world
    gpuFallback.ts     WebGPU safety net: fault flag and reload onto WebGL2
    cameraRig.ts       Chase camera with menu, run and game-over modes
    trackView.ts       Maps sim entities to pooled model nodes
    atmosphere.ts      Lights, fog, exposure and bloom for each zone, blended by position
    sky/               Sky dome, sun, moon, stars and clouds, with procedural canvas textures
    scenery/           The procedural street: ground, facades, buildings, props, overhead strings,
                       backdrop, deterministic layout and palette
    models/            Wayman (hero), the Warden drone, obstacles, vehicles and pickups.
                       gallery.ts is the development gallery.
    geom/              MeshBuilder (merged low-poly geometry), cached materials, colour helpers, curved-world warp
    fx/                Particles, procedural particle atlas and full-screen flash feedback
  audio/             WebAudio: synthesized sound effects, procedural music, mix chain, looping sounds
    index.ts           AudioEngine: plays sounds and music
    synth.ts           Sound-effect voices
    music.ts           Music scheduler: a 16-bar A and B form in C major
    loops.ts           Sustained (looping) sounds
    chain.ts           Master signal chain, shared by live and offline rendering
    offline.ts         Offline rendering of the same synthesis, used by scripts/audio-verify.mjs
  ui/                DOM overlay
    index.ts           Title menu, HUD, pause with countdown, game-over screen, toasts and popups
    icons.ts           Inline SVG icons
    settings.ts        Saved sound and quality settings in localStorage
    ui.css             Overlay styles
```

## Testing and tooling

### Unit tests

`npm test` runs Vitest on every `src/**/*.test.ts` file. The tests cover the swipe recogniser, the simulation rules, the track generator, long autopilot runs (`fuzz.test.ts`), the mesh builder, the curved-world warp, the 3D models and the scenery.

### Helper scripts

Browser scripts drive the game in Chromium through Playwright. Those that load the game expect `npm run build` to have run first, so they test `dist/`.

- `npm run build:artifact`: builds `dist-artifact/wayman-run.html`, the whole game as one self-contained HTML fragment (inline CSS and one inline module script, no external requests, no `eval`; for hosts that wrap a single file in their own page under a strict CSP). Config: `vite.artifact.config.ts`, `scripts/build-artifact.mjs`.
- `scripts/artifact-check.mjs`: loads that file in headless Chromium inside a sandboxed iframe (with and without `allow-same-origin`, at 1280x720 and 390x844) behind a strict CSP and fails on any CSP violation, console error or extra network request, or if the menu, Play, canvas, layout or HUD are wrong. Screenshots go to `shots/artifact/`.
- `scripts/shot.mjs`: screenshot and boot check of the game, with a JSON summary. Serves `dist/`, or a running server with `--url`.
- `scripts/fxshot.mjs`: scripted screenshots of effects. Runs steps such as `advance`, `js`, `jsfile` and `shot`.
- `scripts/fx/*.js`: page snippets for `fxshot.mjs`, run with a `jsfile:` step. `autoq.js` exercises the quality watchdog, `fly.js` fakes boost flight with the magnet, `perf.js` times ticks and renders, and `untilOver.js` runs until game over.
- `scripts/gpucompare.mjs`: renders the same frames on WebGL2 and WebGPU, compares them pixel by pixel, and writes a diff image.
- `scripts/gpufault.mjs`: forces each WebGPU failure path and checks that the game ends up on WebGL2.
- `scripts/input-check.mjs`: checks that real keyboard presses and swipes drive the running game.
- `scripts/integration.mjs`: QA driver with three modes: `shots` (review screenshots), `soak` (long runs over several seeds) and `restart` (crash and play again).
- `scripts/ui-shots.mjs`: screenshots every UI state at desktop, portrait and landscape sizes. Serves `dist/`.
- `scripts/gallery-shot.mjs`: screenshots each scene of `gallery.html`. Starts its own Vite dev server.
- `scripts/audio-verify.mjs`: renders every sound effect and about 16 s of each music mode offline, checks level, length, NaNs, spectral distinctness and rhythm, and exits non-zero on failure. Bundles `scripts/audio-entry.ts` with Vite.
- `scripts/audio-entry.ts`: the bundle entry for `audio-verify.mjs`. It re-exports `src/audio/offline.ts`.

The scripts load Playwright with `require('playwright')` and launch Chromium through it. Playwright and a Chromium build must already be installed on the machine. They are not listed in `package.json`. The WebGPU runs use Chromium's software (SwiftShader) adapter.

## Technical notes

- **Engine versions.** `pixi.js` is 8.23.0 (`^8.23.0` in `package.json`, locked at 8.23.0). `@pixi/3d` is pinned at 0.1.0. That is a pre-1.0 release, so its API can change between versions.
- **Renderer.** The default backend is WebGL2 (`DEFAULT_BACKEND` in `src/view/stage.ts`). WebGPU is opt-in with `?renderer=webgpu`. Its frames match WebGL2 frame by frame, but it has only been run on a software adapter, and it has not been measured on real GPUs. If WebGPU fails during setup, the game falls back to WebGL2. If a WebGPU device is lost or GPU errors occur, the game stores a flag and reloads onto WebGL2.
- **Quality tiers.** Low uses hard shadows, no post effects, no antialiasing and a resolution cap of 1. Medium and High use PCF shadows, post effects, antialiasing and a vignette. Medium has a resolution cap of 1.5, and High has a cap of 2. The default tier is High. The frame-time watchdog works only when you have not chosen a tier. It samples real frames during a run and steps down one tier when the average is slower than about 42 fps.
- **Browser support.** The game uses WebGL2, WebGPU (opt-in), WebAudio, Pointer Events, the Gamepad API and `localStorage`. The automated checks run in headless Chromium. The game has not been tested on real phones or on Safari.
- **Node versions.** `package.json` has no `engines` field. The installed packages require Vite 8.3.8: Node `^20.19.0` or `>=22.12.0`. Vitest 5.1.0 requires Node `^22.12.0`, `^24.0.0` or `>=26.0.0`. The build and tests above were run on Node 22.
- **Build.** `npm run build` type-checks with TypeScript 7.0.2 and bundles with Vite 8.3.8.
