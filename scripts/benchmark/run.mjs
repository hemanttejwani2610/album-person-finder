// Face-matching benchmark over scripts/benchmark/manifest.json (3 identities, public-domain).
// Runs the shipped FacePipeline in Chrome for Testing and reports, per configuration:
//   AUC, recall and false-match rate at a threshold, and recall at zero false matches.
// Usage: node scripts/benchmark/run.mjs --images <dir from fetch.mjs> [--sizes 384,512,1024] [--descriptors dlib,sface]
import puppeteer from 'puppeteer';
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const imagesDir = arg('--images');
const sizes = arg('--sizes', '384,512,1024').split(',').map(Number);
// Per-descriptor operating points: dlib's documented 0.6 distance (similarity 0.4); OpenCV's
// documented cosine 0.363 for SFace.
const THRESHOLDS = { dlib: 0.4, sface: 0.363, fusion: 0.38 };
const sfaceDir = arg('--sface-dir', path.join(root, 'vendor/models/descriptor'));
if (!imagesDir) throw new Error('--images required');

const { identities, photos } = JSON.parse(readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const work = mkdtempSync(path.join(tmpdir(), 'apf-bench-'));
const sized = (i, edge) => {
  const src = path.join(imagesDir, `${String(i).padStart(3, '0')}.jpg`);
  if (edge >= 1280) return src;
  const out = path.join(work, `${edge}_${i}.jpg`);
  if (!existsSync(out)) execFileSync('sips', ['-Z', String(edge), src, '--out', out], { stdio: 'ignore' });
  return out;
};

const humanDir = path.join(root, 'node_modules/@vladmandic/human');
const descriptorDir = path.join(root, 'vendor/models/descriptor');
const wasmDir = path.join(root, 'node_modules/@tensorflow/tfjs-backend-wasm/dist');
const ortDir = path.join(root, 'node_modules/onnxruntime-web/dist');
const js = (await esbuild.build({ entryPoints: [path.join(here, 'entry.ts')], bundle: true, format: 'esm', write: false, target: 'chrome120', logLevel: 'error' })).outputFiles[0].contents;

const browser = await puppeteer.launch({ headless: true, pipe: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = new URL(req.url());
  if (u.hostname !== 'bench.test') return req.abort();
  if (u.pathname === '/') return req.respond({ contentType: 'text/html', body: '<!doctype html><script type="module" src="/e.js"></script>' });
  if (u.pathname === '/e.js') return req.respond({ contentType: 'text/javascript', body: Buffer.from(js) });
  let m = /^\/img\/(\d+)\/(\d+)$/.exec(u.pathname);
  if (m) return req.respond({ contentType: 'image/jpeg', body: readFileSync(sized(Number(m[2]), Number(m[1]))) });
  m = /^\/wasm\/(.+)$/.exec(u.pathname);
  if (m) {
    const p = [path.join(wasmDir, m[1]), path.join(ortDir, m[1])].find(existsSync);
    return p ? req.respond({ contentType: m[1].endsWith('.mjs') ? 'text/javascript' : 'application/wasm', body: readFileSync(p) }) : req.respond({ status: 404, body: '' });
  }
  m = /^\/models\/descriptor\/(.+)$/.exec(u.pathname);
  if (m) {
    const p = [path.join(descriptorDir, m[1]), path.join(sfaceDir, m[1])].find(existsSync);
    return p ? req.respond({ body: readFileSync(p) }) : req.respond({ status: 404, body: '' });
  }
  m = /^\/models\/(.+)$/.exec(u.pathname);
  if (m) return req.respond({ body: readFileSync(path.join(humanDir, 'models', m[1])) });
  req.respond({ status: 404, body: '' });
});

const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
const cosine = (a, b) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / Math.sqrt(x * y);
};
// Same scores the extension shows: dlib → 1 − distance, SFace → cosine.
const similarity = (kind, a, b) =>
  kind === 'sface' ? cosine(a, b) : kind === 'fusion' ? (cosine(a.sface, b.sface) + 1 - dist(a.dlib, b.dlib)) / 2 : 1 - dist(a, b);
const mean = (ds) => ds[0].map((_, j) => ds.reduce((s, d) => s + d[j], 0) / ds.length);

function auc(pos, neg) {
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

async function describeAll(options, edge) {
  const key = `${options.descriptor}|${options.mirrorAverage}|${edge}`;
  if (cache.has(key)) return cache.get(key);
  if (options.descriptor === 'fusion') {
    // Same detector, so faces line up by index; concatenate per-model similarity inputs.
    const a = await describeAll({ ...options, descriptor: 'dlib' }, edge);
    const b = await describeAll({ ...options, descriptor: 'sface' }, edge);
    const fused = a.map((img, i) => ({ ...img, faces: img.faces.map((f, k) => ({ ...f, d: f.d && b[i].faces[k]?.d ? { dlib: f.d, sface: b[i].faces[k].d } : null })) }));
    cache.set(key, fused);
    return fused;
  }
  await page.goto('https://bench.test/');
  await page.waitForFunction(() => window.ready === true);
  const out = await page.evaluate((o, urls) => window.run(o, urls), options, photos.map((_, i) => `/img/${edge}/${i}`));
  cache.set(key, out);
  return out;
}

const rows = [];
if (arg('--chips')) {
  // Debug: write aligned chips for the given photo indexes (comma list) to --out-dir, then exit.
  const outDir = arg('--out-dir');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  for (const kind of arg('--descriptors', 'sface').split(',')) {
    for (const i of arg('--chips').split(',').map(Number)) {
      await page.goto('https://bench.test/');
      await page.waitForFunction(() => window.ready === true);
      const urls = await page.evaluate((o, u) => window.chips(o, u), { descriptor: kind, align: 'mesh', mirrorAverage: false }, `/img/${sizes[0]}/${i}`);
      urls.forEach((u, k) => writeFileSync(path.join(outDir, `${kind}_${i}_${k}.png`), Buffer.from(u.split(',')[1], 'base64')));
    }
  }
  await browser.close();
  process.exit(0);
}
const descriptors = arg('--descriptors', 'dlib,sface').split(',');
const explain = args.includes('--explain');
const cache = new Map(); // descriptor|mirror|edge -> per-photo faces
for (const descriptor of descriptors) for (const mirrorAverage of [false, true]) {
  const threshold = THRESHOLDS[descriptor];
  const options = { descriptor, align: 'mesh', mirrorAverage };
  const full = await describeAll(options, 1280); // references come from full-size uploads
  for (const edge of sizes) {
    const album = edge === 1280 ? full : await describeAll(options, edge);
    for (const refCount of [1, 3]) {
      for (const combine of refCount === 1 ? ['single'] : descriptor === 'fusion' ? ['max'] : ['max', 'centroid']) {
        const agg = { pos: [], neg: [], tp: 0, fp: 0, P: 0, N: 0, aucs: [], recallAt0FP: [] };
        for (const id of identities) {
          const refs = photos
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => p.people.includes(id) && p.ref && p.ref <= refCount)
            .map(({ i }) => [...full[i].faces].filter((f) => f.d).sort((a, b) => b.side - a.side)[0].d);
          const centroid = descriptor === 'fusion' ? null : mean(refs);
          const sim = (d) => (combine === 'centroid' ? similarity(descriptor, centroid, d) : Math.max(...refs.map((r) => similarity(descriptor, r, d))));
          const pos = [], neg = [];
          photos.forEach((p, i) => {
            if (p.people.includes(id) && p.ref) return; // this identity's references are not album photos
            const scores = album[i].faces.filter((f) => f.d).map((f) => sim(f.d));
            const best = scores.length ? Math.max(...scores) : -Infinity;
            (p.people.includes(id) ? pos : neg).push(best);
            if (explain && refCount === 1 && !mirrorAverage && edge === sizes[0]) {
              const isPos = p.people.includes(id);
              if ((isPos && best < threshold) || (!isPos && best >= threshold)) {
                const sides = album[i].faces.map((f) => f.side).join(',');
                console.log(`${isPos ? 'MISS ' : 'FALSE'} ${descriptor} ${id.padEnd(6)} best=${Number.isFinite(best) ? best.toFixed(3) : 'no face'} faces=[${sides}] ${p.file.slice(0, 70)}`);
              }
            }
          });
          agg.aucs.push(auc(pos, neg));
          const maxNeg = Math.max(...neg);
          agg.recallAt0FP.push(pos.filter((s) => s > maxNeg).length / pos.length);
          agg.tp += pos.filter((s) => s >= threshold).length;
          agg.fp += neg.filter((s) => s >= threshold).length;
          agg.P += pos.length;
          agg.N += neg.length;
        }
        rows.push({
          model: descriptor,
          mirror: mirrorAverage ? 'yes' : 'no',
          size: edge,
          refs: refCount === 1 ? '1' : `3 (${combine})`,
          auc: (agg.aucs.reduce((a, b) => a + b) / agg.aucs.length).toFixed(3),
          threshold,
          recall: `${agg.tp}/${agg.P}`,
          falseMatches: `${agg.fp}/${agg.N}`,
          'recall@0FP': (agg.recallAt0FP.reduce((a, b) => a + b) / agg.recallAt0FP.length).toFixed(2),
        });
      }
    }
  }
}
await browser.close();
console.table(rows);
