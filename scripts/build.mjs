// Builds the unpacked extension into dist/.
// All executable code, WASM and model files are copied locally; nothing is loaded from a CDN.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
// --release: no source maps (store package). Normal builds keep them for debugging.
const release = process.argv.includes('--release');
// Test-only: `--backends wasm` (comma list) restricts the inference backends, e.g. to verify the
// WASM fallback under the extension CSP. Normal builds try webgl → wasm → cpu.
const backendsArg = process.argv.includes('--backends') ? process.argv[process.argv.indexOf('--backends') + 1] : null;
const backends = backendsArg ? backendsArg.split(',') : ['webgl', 'wasm', 'cpu'];

// Only the Human models the face pipeline actually uses (see src/worker/humanConfig.ts).
const MODELS = ['blazeface', 'facemesh'];
const humanDir = path.join(root, 'node_modules/@vladmandic/human');
const wasmDir = path.join(root, 'node_modules/@tensorflow/tfjs-backend-wasm/dist');
const WASM_FILES = ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm', 'tfjs-backend-wasm-threaded-simd.wasm'];
// ONNX Runtime Web's WASM binary and the small ES module glue it imports at runtime (both served
// from the extension, so script-src 'self' allows them). Used for the SFace descriptor.
const ortDir = path.join(root, 'node_modules/onnxruntime-web/dist');
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
// Face descriptor model, downloaded and checksum-verified by `npm run fetch-models`.
const descriptorDir = path.join(root, 'vendor/models/descriptor');
const DESCRIPTOR_FILES = ['face_recognition_sface_2021dec.onnx'];

async function copyAssets() {
  await cp(path.join(root, 'static'), dist, { recursive: true });
  await mkdir(path.join(dist, 'models'), { recursive: true });
  for (const m of MODELS) {
    for (const ext of ['json', 'bin']) {
      await copyFile(path.join(humanDir, 'models', `${m}.${ext}`), path.join(dist, 'models', `${m}.${ext}`));
    }
  }
  await mkdir(path.join(dist, 'models/descriptor'), { recursive: true });
  for (const f of DESCRIPTOR_FILES) {
    const src = path.join(descriptorDir, f);
    if (!existsSync(src)) throw new Error(`Missing ${path.relative(root, src)}. Run: npm run fetch-models`);
    await copyFile(src, path.join(dist, 'models/descriptor', f));
  }
  await mkdir(path.join(dist, 'wasm'), { recursive: true });
  for (const f of WASM_FILES) await copyFile(path.join(wasmDir, f), path.join(dist, 'wasm', f));
  for (const f of ORT_FILES) await copyFile(path.join(ortDir, f), path.join(dist, 'wasm', f));
  await mkdir(path.join(dist, 'licenses'), { recursive: true });
  await copyFile(path.join(humanDir, 'LICENSE'), path.join(dist, 'licenses', 'human-LICENSE.txt'));
  await copyFile(path.join(root, 'THIRD_PARTY_LICENSES.md'), path.join(dist, 'licenses', 'THIRD_PARTY_LICENSES.md'));
  const sfaceLicense = path.join(descriptorDir, 'sface-LICENSE.txt');
  if (!existsSync(sfaceLicense)) throw new Error('Missing SFace license. Run: npm run fetch-models');
  await copyFile(sfaceLicense, path.join(dist, 'licenses', 'sface-LICENSE.txt'));
  await copyFile(path.join(descriptorDir, 'onnxruntime-LICENSE.txt'), path.join(dist, 'licenses', 'onnxruntime-LICENSE.txt'));
  // Keep manifest version in sync with package.json.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifestPath = path.join(dist, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = pkg.version;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

const common = {
  bundle: true,
  define: { __APF_BACKENDS__: JSON.stringify(backends) },
  sourcemap: !release,
  target: 'chrome120',
  logLevel: 'info',
  legalComments: 'linked',
};

const configs = [
  { ...common, entryPoints: { background: 'src/background/serviceWorker.ts' }, format: 'esm', outdir: dist },
  // Content scripts are classic scripts, so bundle as an IIFE.
  { ...common, entryPoints: { content: 'src/content/index.ts' }, format: 'iife', outdir: dist },
  { ...common, entryPoints: { sidepanel: 'src/sidepanel/main.ts' }, format: 'esm', outdir: dist },
  { ...common, entryPoints: { faceWorker: 'src/worker/faceWorker.ts' }, format: 'esm', outdir: dist },
  // Not part of the extension: a paste-into-DevTools copy of the adapter diagnostics.
  { ...common, entryPoints: { 'console-diagnostics': 'scripts/eval/consoleDiagnostics.ts' }, format: 'iife', sourcemap: false, outdir: path.join(root, 'tools') },
];

if (existsSync(dist)) await rm(dist, { recursive: true });
await mkdir(dist, { recursive: true });
await copyAssets();

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  console.log('watching… (static assets copied once; re-run build after changing static/)');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log('Built extension into', dist, release ? '(release)' : '', backendsArg ? `(TEST BUILD: backends ${backends.join(',')})` : '');
}
