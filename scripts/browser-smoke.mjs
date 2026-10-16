// Real-browser smoke test: loads dist/ as an unpacked extension in Chrome for Testing, opens the
// real side panel through the toolbar action, and scans a SIMULATED album page
// (test/fixtures/fake-album.html) served at a photos.google.com URL via request interception.
//
// This verifies the extension's own plumbing (MV3 wiring, side panel, content script injection,
// controlled scrolling over a virtualized grid, image fetching from an extension page, model
// loading under the extension CSP, matching, lifecycle controls). It does NOT verify Google
// Photos' real DOM or image behaviour; see docs/VALIDATION_REPORT.md.
//
// All network access outside the intercepted fixture hosts is disabled with
// --host-resolver-rules, so a passing run also shows nothing is fetched from a CDN.
//
// Usage: npm run build && node scripts/browser-smoke.mjs --images <dir> [--out report.json] [--headful] [--expect-backend wasm]
// <dir> must contain ref_*.jpg, pos_*.jpg (contain the reference person), neg_*.jpg, noface_*.jpg.
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const imagesDir = arg('--images') ?? process.env.FACE_FIXTURES;
const outPath = arg('--out');
const headful = args.includes('--headful');
// --expect-backend wasm: assert the models ran on this backend (use with `npm run build -- --backends wasm`).
const expectBackend = arg('--expect-backend') ?? 'webgl';
if (!imagesDir || !existsSync(imagesDir)) {
  console.error('Pass --images <dir> with ref_*, pos_*, neg_*, noface_* JPEGs (see docs/VALIDATION_REPORT.md).');
  process.exit(2);
}
const dist = path.join(root, 'dist');
if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('Run npm run build first.');
  process.exit(2);
}

// ---------- fixture data ----------

const files = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const refFile = files.find((f) => f.startsWith('ref_'));
const albumImages = files.filter((f) => /^(pos|neg|noface)_/.test(f));
const work = mkdtempSync(path.join(tmpdir(), 'apf-smoke-'));
function resized(file, edge) {
  const out = path.join(work, `${edge}_${file}`);
  if (!existsSync(out)) execFileSync('sips', ['-Z', String(edge), path.join(imagesDir, file), '--out', out], { stdio: 'ignore' });
  return out;
}
// 4 copies of every album image, deterministically shuffled, each with its own photo id.
const photos = [];
for (let copy = 0; copy < 4; copy++) for (const f of albumImages) photos.push(f);
for (let i = photos.length - 1; i > 0; i--) {
  const j = (i * 7919) % (i + 1);
  [photos[i], photos[j]] = [photos[j], photos[i]];
}
const ALBUM = 'FIXTUREALBUM1';
const fixture = {
  albumId: ALBUM,
  photos: photos.map((f, i) => ({ id: `P${String(i + 1).padStart(3, '0')}`, file: f, image: `https://lh3.googleusercontent.com/fixture/${encodeURIComponent(f)}=w512-h512-no` })),
};
const albumHtml = readFileSync(path.join(root, 'test/fixtures/fake-album.html'), 'utf8').replace(
  '<script>',
  `<script>window.__FIXTURE__ = ${JSON.stringify({ albumId: ALBUM, photos: fixture.photos.map(({ id, image }) => ({ id, image })) })};</script>\n    <script>`,
);

async function serveFixtures(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname === 'photos.google.com') {
      const m = /^\/album\/([A-Z0-9]+)(\/photo\/\w+)?$/.exec(url.pathname);
      if (!m) return req.respond({ status: 404, body: 'not found' });
      const html = m[2] ? `<!doctype html><title>Photo - Google Photos</title><p>Single photo view (fixture)</p>` : albumHtml.replaceAll(ALBUM, m[1]);
      return req.respond({ status: 200, contentType: 'text/html', body: html });
    }
    if (url.hostname === 'lh3.googleusercontent.com' && url.pathname.startsWith('/fixture/')) {
      const m = /^\/fixture\/(.+)=w(\d+)-h(\d+)-no$/.exec(url.pathname);
      if (!m) return req.respond({ status: 404, body: '' });
      const edge = Math.max(Number(m[2]), Number(m[3])) >= 1024 ? 1024 : 512;
      return req.respond({ status: 200, contentType: 'image/jpeg', body: readFileSync(resized(decodeURIComponent(m[1]), edge)) });
    }
    return req.continue();
  });
}

// ---------- helpers ----------

const report = { startedAt: new Date().toISOString(), checks: [], fixture: { photos: fixture.photos.length, images: albumImages } };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}
const textOf = (page, sel) => page.$eval(sel, (e) => e.textContent ?? '');
const waitText = (page, sel, re, timeout = 60000) =>
  page.waitForFunction((s, r) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ''), { timeout, polling: 250 }, sel, re.source);
async function counters(panel) {
  return panel.$$eval('#counters div', (divs) => Object.fromEntries(divs.map((d) => [d.querySelector('dt').textContent, Number(d.querySelector('dd').textContent)])));
}
async function setThreshold(panel, v) {
  await panel.$eval('#threshold', (el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
}

// ---------- run ----------

const browser = await puppeteer.launch({
  headless: !headful,
  enableExtensions: true,
  pipe: true,
  defaultViewport: { width: 1000, height: 800 },
  args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--no-first-run'],
});
let exitCode = 0;
let panelForDebug = null;
try {
  const extId = await browser.installExtension(dist);
  check('extension installs from dist/', !!extId, { extId });

  const album = (await browser.pages())[0] ?? (await browser.newPage());
  await serveFixtures(album);
  await album.goto(`https://photos.google.com/album/${ALBUM}`, { waitUntil: 'domcontentloaded' });
  await album.waitForSelector('a.tile');

  const extensions = await browser.extensions();
  const ext = [...extensions.values()].find((e) => e.id === extId);
  await album.triggerExtensionAction(ext);
  const panelTarget = await browser.waitForTarget((t) => t.url().startsWith(`chrome-extension://${extId}/sidepanel.html`), { timeout: 15000 });
  const panel = await panelTarget.asPage();
  panelForDebug = panel;
  check('toolbar action opens the side panel', !!panel);
  await serveFixtures(panel);
  const consoleErrors = [];
  panel.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  panel.on('pageerror', (e) => consoleErrors.push(String(e)));

  await waitText(panel, '#album-status', /Album: Fixture album/, 15000);
  check('panel detects the album page and reads its title', true, await textOf(panel, '#album-status'));

  // Diagnostics against the fixture page.
  await panel.$eval('#diagnostics', (d) => (d.open = true));
  await panel.click('#diag-dom');
  await waitText(panel, '#diag-log', /discovery check:/);
  await panel.click('#diag-scroll');
  await waitText(panel, '#diag-log', /scroll test:/);
  await panel.click('#diag-images');
  await waitText(panel, '#diag-log', /sample 3:/);
  await panel.click('#diag-larger');
  await waitText(panel, '#diag-log', /larger-image test:/);
  const diag = JSON.parse(await textOf(panel, '#diag-summary'));
  report.diagnostics = diag;
  check('DOM diagnostics find album tiles and ignore other-album links', diag.domDiagnostics.photoLinksThisAlbum > 0 && diag.domDiagnostics.photoLinksOtherAlbums === 1, {
    tiles: diag.domDiagnostics.photoLinksThisAlbum,
    other: diag.domDiagnostics.photoLinksOtherAlbums,
    scroller: diag.domDiagnostics.scroll.container,
  });
  check('scroll probe observes virtualization (tiles leave the DOM)', diag.scrollProbe.newKeysAfterScroll > 0 && diag.scrollProbe.keysThatLeftDom > 0 && diag.scrollProbe.restored, diag.scrollProbe);
  check('image access probe fetches + decodes thumbnails from the panel', diag.imageProbe.every((p) => p.ok), diag.imageProbe);
  check('larger-image probe verifies only when the server returns bigger images', diag.resolutionProbe.verified === true, diag.resolutionProbe.samples);

  // Error states for the reference photo.
  const input = await panel.$('#ref-input');
  const noface = albumImages.find((f) => f.startsWith('noface_'));
  if (noface) {
    await input.uploadFile(path.join(imagesDir, noface));
    await waitText(panel, '#ref-message', /No face was found/, 180000);
    check('no-face reference shows a clear message', true, await textOf(panel, '#ref-message'));
    const modelStatus = await textOf(panel, '#model-status');
    report.modelStatus = modelStatus;
    check(`face models load inside the extension on ${expectBackend} (CSP, local assets, offline)`, modelStatus.includes(`Face models ready (${expectBackend})`), modelStatus);
  }
  const group = albumImages.find((f) => f.startsWith('pos_') && f.includes('group'));
  if (group) {
    await panel.click('#ref-change');
    await (await panel.$('#ref-input')).uploadFile(path.join(imagesDir, group));
    await waitText(panel, '#ref-message', /Found \d+ faces/, 60000);
    const options = await panel.$$eval('.face-option', (b) => b.length);
    check('multi-face reference asks the user to choose a face', options > 1, { options });
    const startDisabled = await panel.$eval('#btn-start', (b) => b.disabled);
    check('scan cannot start until a face is chosen', startDisabled === true);
  }

  // Real reference.
  await panel.click('#ref-change');
  await (await panel.$('#ref-input')).uploadFile(path.join(imagesDir, refFile));
  await waitText(panel, '#ref-message', /One face found/, 60000);
  check('single-face reference is accepted', true, await textOf(panel, '#ref-message'));

  // Full scan at the lowest threshold so all candidate scores are visible.
  await panel.$eval('#use-larger', (c) => {
    c.checked = false;
  });
  await setThreshold(panel, 0.2);
  const t0 = Date.now();
  await panel.click('#btn-start');
  await waitText(panel, '#scan-status', /Scan ended/, 600000);
  const scanMs = Date.now() - t0;
  const c1 = await counters(panel);
  report.fullScan = { ms: scanMs, counters: c1, status: await textOf(panel, '#scan-status') };
  check('full scan discovers every simulated photo despite virtualization', c1.Discovered === fixture.photos.length, c1);
  check('every discovered photo is processed (none failed/skipped)', c1.Processed === fixture.photos.length && c1.Failed === 0 && c1.Skipped === 0, c1);

  const results = await panel.$$eval('.result', (rs) => rs.map((r) => ({ score: Number(r.querySelector('.score').textContent), label: r.querySelector('.open').title })));
  const byLabel = (label) => fixture.photos[Number(label.replace(/\D/g, '')) - 1];
  const scored = results.map((r) => ({ ...r, file: byLabel(r.label).file, id: byLabel(r.label).id }));
  report.scores = scored;
  const sortedDesc = scored.every((r, i) => i === 0 || scored[i - 1].score >= r.score);
  check('results are sorted by similarity', sortedDesc);
  // Expectations for the bundled public-domain test set: every photo of the reference person
  // except near-profile shots should pass the default threshold, and no photo without them should.
  const DEFAULT = 0.4;
  const posFiles = [...new Set(fixture.photos.filter((p) => p.file.startsWith('pos_')).map((p) => p.file))];
  const best = (file) => Math.max(-1, ...scored.filter((r) => r.file === file).map((r) => r.score));
  const posAbove = posFiles.filter((f) => best(f) >= DEFAULT);
  const negAbove = [...new Set(scored.filter((r) => !r.file.startsWith('pos_') && r.score >= DEFAULT).map((r) => r.file))];
  report.separation = { posImages: posFiles.length, posImagesAboveDefault: posAbove.length, missed: posFiles.filter((f) => !posAbove.includes(f)), negImagesAboveDefault: negAbove };
  check('no photo without the reference person reaches the default threshold', negAbove.length === 0, report.separation);
  check('all but at most one photo of the reference person reach the default threshold', posAbove.length >= posFiles.length - 1, report.separation);
  const dupScoresConsistent = posFiles.every((f) => new Set(scored.filter((r) => r.file === f).map((r) => r.score)).size <= 1);
  check('identical images under different photo ids get identical scores', dupScoresConsistent);

  // Default threshold result counts.
  await setThreshold(panel, DEFAULT);
  report.atDefaultThreshold = await panel.$$eval('.result', (rs) => rs.length);

  // Open original.
  const before = (await browser.pages()).length;
  await panel.click('.result .open');
  const opened = await browser.waitForTarget((t) => /photos\.google\.com\/album\/FIXTUREALBUM1\/photo\/P\d+/.test(t.url()), { timeout: 10000 }).catch(() => null);
  check('clicking a result opens the canonical photo URL in a new tab', !!opened && (await browser.pages()).length > before, opened?.url());
  if (opened) await (await opened.asPage()).close();
  await album.bringToFront();

  // Pause / resume / cancel.
  await panel.click('#btn-start');
  await waitText(panel, '#scan-status', /Scanning/, 30000);
  await panel.waitForFunction(() => Number(document.querySelector('#counters div:nth-child(2) dd')?.textContent ?? 0) >= 3, { timeout: 120000, polling: 200 });
  await panel.click('#btn-pause');
  await waitText(panel, '#scan-status', /^Paused/, 10000);
  await new Promise((r) => setTimeout(r, 2000));
  const p1 = (await counters(panel)).Processed;
  await new Promise((r) => setTimeout(r, 3000));
  const p2 = (await counters(panel)).Processed;
  check('pause stops processing (in-flight items may finish)', p1 === p2, { p1, p2 });
  await panel.click('#btn-resume');
  await waitText(panel, '#scan-status', /Scanning|Finished scrolling/, 10000);
  check('resume continues the scan', true);
  await panel.click('#btn-cancel');
  await waitText(panel, '#scan-status', /Scan canceled/, 30000);
  const scrollTop = await album.$eval('#scroller', (s) => s.scrollTop);
  check('cancel ends in the canceled state and restores scroll position', scrollTop === 0, { scrollTop });

  // Navigation to another album interrupts the scan.
  await panel.click('#btn-start');
  await waitText(panel, '#scan-status', /Scanning/, 30000);
  await panel.waitForFunction(() => Number(document.querySelector('#counters div:nth-child(1) dd')?.textContent ?? 0) >= 4, { timeout: 60000, polling: 200 });
  await album.goto('https://photos.google.com/album/FIXTUREALBUM2', { waitUntil: 'domcontentloaded' });
  await waitText(panel, '#scan-status', /moved to a different page or album/, 30000);
  check('navigating to another album stops the scan safely', true, await textOf(panel, '#scan-status'));

  // Clear session.
  await panel.click('#btn-clear');
  await panel.waitForFunction(() => document.querySelectorAll('.result').length === 0 && document.querySelector('#ref-view').hidden, { timeout: 5000 });
  check('clear session removes reference and results', true);

  check('no uncaught errors in the side panel', consoleErrors.length === 0, consoleErrors.slice(0, 5));
} catch (err) {
  check('smoke test completed without exceptions', false, String(err?.message ?? err));
  if (panelForDebug) {
    report.failureContext = await panelForDebug
      .evaluate(() => ({
        model: document.querySelector('#model-status')?.textContent,
        ref: document.querySelector('#ref-message')?.textContent,
        scan: document.querySelector('#scan-status')?.textContent,
        log: document.querySelector('#diag-log')?.textContent?.split('\n').slice(-15),
      }))
      .catch(() => null);
    console.log('failure context:', JSON.stringify(report.failureContext, null, 2));
  }
} finally {
  report.finishedAt = new Date().toISOString();
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  exitCode = report.checks.every((c) => c.ok) ? 0 : 1;
  await browser.close();
}
console.log(`\n${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks passed`);
process.exit(exitCode);
