// Entry of the single-file artifact build (vite.artifact.config.ts). Same game as src/main.ts, but
// pixi's eval-free code paths are installed first, for pages whose CSP forbids `new Function`.
import 'pixi.js/unsafe-eval';
import { uniformParsers } from 'pixi.js';
import '@pixi/3d'; // registers its extra uniform parsers (see pixi3dUniformPolyfill in the config)

// The eval-free uniform uploaders are looked up by parser index: 5 from pixi + 4 from @pixi/3d.
if (uniformParsers.length !== 9) {
  throw new Error(`artifact build: expected 9 uniform parsers, found ${uniformParsers.length}; update pixi3dUniformPolyfill`);
}

await import('../src/main');
