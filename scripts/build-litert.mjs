#!/usr/bin/env node
// Build the LiteRT.js files the app loads for the litert tool: android/proj/assets/litert/
//   litert.bundle.js                     @litertjs/core + @litertjs/wasm-utils 2.5.3 in one script (window.LiteRTJS),
//                                        with one change: an int8 entry in core's data-type table (int8 models)
//   litert_wasm_internal.{js,wasm}       the WebAssembly runtime (SIMD)
//   litert_wasm_compat_internal.{js,wasm} the same without SIMD, for older devices
// The browser build takes the same packages from jsDelivr instead (W_CDN in app/modules/world.js).
// Needs the devDependencies (npm install). Run from anywhere: node scripts/build-litert.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = process.env.JV_NODE_MODULES || path.join(ROOT, 'node_modules');
const CORE = path.join(NM, '@litertjs', 'core');
const OUT = path.join(ROOT, 'android', 'proj', 'assets', 'litert');
if (!fs.existsSync(CORE)) {
  console.error('build-litert: @litertjs/core is not installed (npm install), so the litert assets were not built.');
  process.exit(1);
}
const { build } = await import(new URL('file:///' + path.join(NM, 'esbuild', 'lib', 'main.js').replace(/\\/g, '/')).href);

// the one change to @litertjs/core: int8 in the data-type table (LiteRT's ElementType already has INT8)
const ANCHOR = `    dtype: "uint8",
    typedArrayConstructor: Uint8Array,
    elementType: ElementType.UINT8
  }`;
const INT8 = `,
  {
    dtype: "int8",
    typedArrayConstructor: Int8Array,
    elementType: ElementType.INT8
  }`;
const coreIndex = path.join(CORE, 'dist', 'index.js');
const int8 = {
  name: 'litert-int8',
  setup(b) {
    b.onLoad({ filter: /[\\/]@litertjs[\\/]core[\\/]dist[\\/]index\.js$/ }, () => {
      const src = fs.readFileSync(coreIndex, 'utf8').replace(/\r\n/g, '\n');
      if (src.split(ANCHOR).length !== 2) throw new Error('build-litert: the data-type table in @litertjs/core has changed; update ANCHOR');
      return { contents: src.replace(ANCHOR, ANCHOR + INT8), loader: 'js', resolveDir: path.dirname(coreIndex) };
    });
  },
};

fs.mkdirSync(OUT, { recursive: true });
await build({
  stdin: { contents: "import * as L from '@litertjs/core';\nwindow.LiteRTJS = L;\n", resolveDir: ROOT, loader: 'js' },
  nodePaths: [NM],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'inline',
  outfile: path.join(OUT, 'litert.bundle.js'),
  plugins: [int8],
  logLevel: 'warning',
});
for (const f of ['litert_wasm_internal.js', 'litert_wasm_internal.wasm', 'litert_wasm_compat_internal.js', 'litert_wasm_compat_internal.wasm'])
  fs.copyFileSync(path.join(CORE, 'wasm', f), path.join(OUT, f));
console.log('litert assets:', fs.readdirSync(OUT).map(f => `${f} ${fs.statSync(path.join(OUT, f)).size}`).join(', '));
