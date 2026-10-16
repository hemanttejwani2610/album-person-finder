// Offline evaluation of face-descriptor configurations in a real Chrome (Chrome for Testing via
// Puppeteer). Prints, for every image, the best similarity (1 − distance) to the reference face, at a
// thumbnail-like size and at full size. Used to choose the descriptor model and default
// threshold (see docs/VALIDATION_REPORT.md). Not part of the extension.
//
// Usage: node scripts/eval-models.mjs --images <dir> [--sizes 384,512,1280] [--out file.json]
//   <dir> contains ref_*.jpg (exactly one face), pos_*.jpg (contain that person), neg_*.jpg, noface_*.jpg.
//   Requires `npm run fetch-models`. Uses macOS `sips` to make the downscaled copies.
import puppeteer from 'puppeteer';
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const imagesDir = arg('--images');
const extraDir = arg('--extra-models');
const sizes = arg('--sizes', '512,1280').split(',').map(Number);
const outPath = arg('--out');
if (!imagesDir) throw new Error('--images required');

const humanDir = path.join(root, 'node_modules/@vladmandic/human');
const work = mkdtempSync(path.join(tmpdir(), 'apf-eval-'));
const files = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
function sized(file, edge) {
  const out = path.join(work, `${edge}_${file}`);
  if (!existsSync(out)) execFileSync('sips', ['-Z', String(edge), path.join(imagesDir, file), '--out', out], { stdio: 'ignore' });
  return out;
}

const VARIANTS = [
  { name: 'SFace + 5-point alignment (shipped)', options: { descriptor: 'sface', align: 'mesh', mirrorAverage: false } },
  { name: 'dlib + mesh alignment (previous)', options: { descriptor: 'dlib', align: 'mesh', mirrorAverage: false } },
];

// Bundle the shipped pipeline for the page.
const bundle = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/eval/evalEntry.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  target: 'chrome120',
  logLevel: 'error',
});
const evalJs = bundle.outputFiles[0].contents;
const page_html = '<!doctype html><meta charset="utf-8"><script type="module" src="/eval.js"></script>';
const descriptorDir = path.join(root, 'vendor/models/descriptor');
const wasmDir = path.join(root, 'node_modules/@tensorflow/tfjs-backend-wasm/dist');
const ortDir = path.join(root, 'node_modules/onnxruntime-web/dist');

const browser = await puppeteer.launch({ headless: true, pipe: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.hostname !== 'eval.test') return req.abort();
    if (u.pathname === '/') return req.respond({ contentType: 'text/html', body: page_html });
    if (u.pathname === '/eval.js') return req.respond({ contentType: 'text/javascript', body: Buffer.from(evalJs) });
    let m = /^\/wasm\/(.+)$/.exec(u.pathname);
    if (m) {
      const p = [path.join(wasmDir, m[1]), path.join(ortDir, m[1])].find(existsSync);
      return p ? req.respond({ contentType: m[1].endsWith('.mjs') ? 'text/javascript' : 'application/wasm', body: readFileSync(p) }) : req.respond({ status: 404, body: '' });
    }
    m = /^\/models\/(.+)$/.exec(u.pathname);
    if (m) {
      const p = [
        m[1].startsWith('descriptor/') && path.join(descriptorDir, m[1].slice('descriptor/'.length)),
        path.join(humanDir, 'models', m[1]),
        extraDir && path.join(extraDir, m[1]),
      ].find((x) => x && existsSync(x));
      return p ? req.respond({ contentType: m[1].endsWith('.json') ? 'application/json' : 'application/octet-stream', body: readFileSync(p) }) : req.respond({ status: 404, body: '' });
    }
    m = /^\/img\/(\d+)\/(.+)$/.exec(u.pathname);
    if (m) return req.respond({ contentType: 'image/jpeg', body: readFileSync(sized(decodeURIComponent(m[2]), Number(m[1]))) });
    return req.respond({ status: 404, body: '' });
  });
  page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
  const images = { ref: files.find((f) => f.startsWith('ref_')), album: files.filter((f) => !f.startsWith('ref_')) };
  // Human caches loaded models per module instance, so each variant gets a fresh page load.
  const result = {};
  for (const v of VARIANTS) {
    await page.goto('https://eval.test/');
    await page.waitForFunction(() => window.ready === true);
    result[v.name] = await page.evaluate((o, i, s) => window.run(o, i, s), v.options, images, sizes);
  }
  if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
  for (const [name, r] of Object.entries(result)) {
    console.log(`\n=== ${name} (${r.dims}-d, backend ${r.backend}, ~${r.avgDetectMs} ms/image) ===`);
    for (const s of sizes) {
      const pos = [], neg = [];
      for (const [img, per] of Object.entries(r.images)) {
        if (img.startsWith('noface_')) continue;
        (img.startsWith('pos_') ? pos : neg).push(per[s].best?.sim ?? -1);
      }
      const f = (x) => x.toFixed(3);
      console.log(`size ${s}: positives min=${f(Math.min(...pos))} mean=${f(pos.reduce((a, b) => a + b, 0) / pos.length)} | negatives max=${f(Math.max(...neg))} mean=${f(neg.reduce((a, b) => a + b, 0) / neg.length)} | margin=${f(Math.min(...pos) - Math.max(...neg))}`);
    }
    for (const [img, per] of Object.entries(r.images)) {
      console.log('  ', img.padEnd(26), sizes.map((s) => `${s}: sim=${per[s].best?.sim ?? '-'} cos=${per[s].best?.cos ?? '-'} (${per[s].faces}f, face ${per[s].best?.side ?? '-'}px)`).join('   '));
    }
  }
} finally {
  await browser.close();
}
