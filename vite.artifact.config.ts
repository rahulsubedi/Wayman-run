// Single-file artifact build: `npm run build:artifact` (see scripts/build-artifact.mjs).
// Emits ONE ES bundle + ONE css file into dist-artifact/.tmp/, which build-artifact.mjs folds into
// dist-artifact/wayman-run.html. Nothing is loaded at run time: no chunks, no assets, no eval.
import { defineConfig, type Plugin } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * pixi's eval-free polyfills pick a precompiled upload function for a uniform by its INDEX in
 * `uniformParsers`. `@pixi/3d` pushes four extra parsers (mat4 / mat3 as Matrix4 / Matrix3 `.elements`,
 * vec3 as Vector3 and as Color) whose code exists only as strings for `new Function`, so with the
 * polyfill alone their uniforms have no function ("n[r] is not a function" on the first draw).
 * This appends hand-written equivalents at indices 5..8 (pixi has 5 built-in parsers) to both the
 * plain-uniform and the uniform-buffer function tables. artifact-entry.ts verifies the parser
 * count at start-up, so a pixi / @pixi/3d upgrade that changes it fails loudly instead of drawing wrongly.
 */
function pixi3dUniformPolyfill(): Plugin {
  const plain = `
uniformParserFunctions.push(
  (name, _cu, _cv, _v, ud, uv, gl) => { gl.uniformMatrix4fv(ud[name].location, false, uv[name].elements); },
  (name, _cu, _cv, _v, ud, uv, gl) => { gl.uniformMatrix3fv(ud[name].location, false, uv[name].elements); },
  (name, _cu, cv, v, ud, uv, gl) => {
    cv = ud[name].value; v = uv[name];
    if (cv[0] !== v.x || cv[1] !== v.y || cv[2] !== v.z) { cv[0] = v.x; cv[1] = v.y; cv[2] = v.z; gl.uniform3f(ud[name].location, v.x, v.y, v.z); }
  },
  (name, _cu, cv, v, ud, uv, gl) => {
    cv = ud[name].value; v = uv[name];
    if (cv[0] !== v.r || cv[1] !== v.g || cv[2] !== v.b) { cv[0] = v.r; cv[1] = v.g; cv[2] = v.b; gl.uniform3f(ud[name].location, v.r, v.g, v.b); }
  },
);
`;
  const ubo = `
uboParserFunctions.push(
  (name, data, offset, uv) => { const v = uv[name].elements; for (let i = 0; i < 16; i++) data[offset + i] = v[i]; },
  (name, data, offset, uv) => {
    const v = uv[name].elements;
    data[offset] = v[0]; data[offset + 1] = v[1]; data[offset + 2] = v[2];
    data[offset + 4] = v[3]; data[offset + 5] = v[4]; data[offset + 6] = v[5];
    data[offset + 8] = v[6]; data[offset + 9] = v[7]; data[offset + 10] = v[8];
  },
  (name, data, offset, uv) => { const v = uv[name]; data[offset] = v.x; data[offset + 1] = v.y; data[offset + 2] = v.z; },
  (name, data, offset, uv) => { const v = uv[name]; data[offset] = v.r; data[offset + 1] = v.g; data[offset + 2] = v.b; },
);
`;
  return {
    name: 'wayman-pixi3d-uniform-polyfill',
    enforce: 'post',
    transform(code, id) {
      const file = id.split('?')[0];
      if (/pixi\.js\/lib\/unsafe-eval\/uniforms\/uniformSyncFunctions\.mjs$/.test(file)) return { code: code + plain, map: null };
      if (/pixi\.js\/lib\/unsafe-eval\/ubo\/uboSyncFunctions\.mjs$/.test(file)) return { code: code + ubo, map: null };
      return null;
    },
  };
}

/**
 * The artifact always runs WebGL2 (no `?renderer=` can reach it), so @pixi/3d's WebGPU backend (core/gpu/init), which
 * it only loads (lazily) once a WebGPU renderer is initialised, is replaced by an empty module.
 * Pixi's own WebGPU / Canvas renderers stay in: dropping them needs `skipExtensionImports` plus a
 * hand-kept list of ~40 pixi imports, which is not worth the risk for the bytes.
 */
function dropWebGpuBackend(): Plugin {
  return {
    name: 'wayman-drop-3d-webgpu',
    enforce: 'pre',
    transform(_code, id) {
      return /@pixi\/3d\/dist\/core\/gpu\/init\.mjs$/.test(id.split('?')[0]) ? { code: 'export {};', map: null } : null;
    },
  };
}

export default defineConfig({
  root,
  base: './',
  publicDir: false, // favicon etc.: the host supplies its own
  plugins: [pixi3dUniformPolyfill(), dropWebGpuBackend()],
  build: {
    target: 'es2022',
    outDir: 'dist-artifact/.tmp',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve(root, 'scripts/artifact-entry.ts'),
      output: {
        codeSplitting: false,
        entryFileNames: 'bundle.js',
        assetFileNames: 'bundle[extname]',
      },
    },
  },
});
