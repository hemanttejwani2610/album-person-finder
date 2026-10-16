// Side panel UI. Owns the scan (ScanController), the face worker (FaceEngine) and all in-memory
// session data. Only UI preferences are persisted (chrome.storage.local).
import { AlbumRef, albumIdentity, isSameAlbum, parseAlbumLocation } from '../adapter/googlePhotosUrls';
import { STOP_REASON_TEXT } from '../shared/discoveryPolicy';
import { assessReference, DEFAULT_THRESHOLD, formatScore, MAX_THRESHOLD, MIN_THRESHOLD, rankMatches } from '../shared/matching';
import type { DomDiagnostics, PageInfo, ScrollProbeResult } from '../shared/messages';
import { byId, h, setText, show } from './dom';
import { DiagnosticsLog } from './diagnosticsLog';
import { FaceEngine } from './faceEngine';
import {
  imageAccessStats,
  ImageProbe,
  probeImageAccess,
  probeLargerImages,
  ResolutionProbe,
  resetImageAccessStats,
} from './imageAccess';
import { AlbumPhotoProcessor, LARGER_IMAGE_LONG_EDGE } from './photoProcessor';
import { drawFaceCrop, loadReference, LoadedReference, releaseReference } from './reference';
import { Candidate, ResultsStore } from './resultsStore';
import { ScanController, ScanStats } from './scanController';
import { discoveryPort, sendToTab } from './tabBridge';

// ---------- state ----------

const log = new DiagnosticsLog();
const engine = new FaceEngine(
  chrome.runtime.getURL('faceWorker.js'),
  chrome.runtime.getURL('models/'),
  chrome.runtime.getURL('wasm/'),
  chrome.runtime.getURL('models/descriptor/'),
);
const MAX_PREVIEWS = 1500;
let results = new ResultsStore(MIN_THRESHOLD, MAX_PREVIEWS);

let windowId: number | undefined;
let activeTabId: number | null = null;
let page: PageInfo | null = null;
let pageProblem: string | null = null;

let reference: LoadedReference | null = null;
let referenceLoading = false;
let referenceError: string | null = null;
let selectedFace: number | null = null;

let scan: ScanController | null = null;
let scanTabId: number | null = null;
let scanAlbumKey: string | null = null;
let scanAlbum: AlbumRef | null = null;
let stats: ScanStats | null = null;
let threshold = DEFAULT_THRESHOLD;
let renderedResultsKey = '';

let modelState: 'not-loaded' | 'loading' | 'ready' | 'failed' = 'not-loaded';
let lastDom: DomDiagnostics | null = null;
let lastScrollProbe: ScrollProbeResult | null = null;
let lastImageProbe: ImageProbe[] | null = null;
let lastResolutionProbe: ResolutionProbe | null = null;
let largerImagesVerifiedFor: string | null = null;

const el = {
  albumStatus: byId('album-status'),
  refDrop: byId('ref-drop'),
  refInput: byId<HTMLInputElement>('ref-input'),
  refView: byId('ref-view'),
  refImg: byId<HTMLImageElement>('ref-img'),
  refBoxes: byId('ref-boxes'),
  refMessage: byId('ref-message'),
  faceChooser: byId('face-chooser'),
  refChange: byId<HTMLButtonElement>('ref-change'),
  modelStatus: byId('model-status'),
  start: byId<HTMLButtonElement>('btn-start'),
  pause: byId<HTMLButtonElement>('btn-pause'),
  resume: byId<HTMLButtonElement>('btn-resume'),
  cancel: byId<HTMLButtonElement>('btn-cancel'),
  progress: byId('progress'),
  scanStatus: byId('scan-status'),
  counters: byId('counters'),
  matchCount: byId('match-count'),
  threshold: byId<HTMLInputElement>('threshold'),
  thresholdValue: byId<HTMLOutputElement>('threshold-value'),
  results: byId('results'),
  resultsEmpty: byId('results-empty'),
  diagnostics: byId<HTMLDetailsElement>('diagnostics'),
  diagSummary: byId('diag-summary'),
  diagLog: byId('diag-log'),
  useLarger: byId<HTMLInputElement>('use-larger'),
  clear: byId<HTMLButtonElement>('btn-clear'),
  preview: byId<HTMLDialogElement>('preview'),
  previewImg: byId<HTMLImageElement>('preview-img'),
  previewBox: byId('preview-box'),
  previewMeta: byId('preview-meta'),
  previewOpen: byId<HTMLButtonElement>('preview-open'),
  previewClose: byId<HTMLButtonElement>('preview-close'),
};

// ---------- page / album tracking ----------

async function refreshPage(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    activeTabId = tab?.id ?? null;
    page = null;
    pageProblem = null;
    if (!tab?.id || !tab.url) {
      pageProblem = 'Open a Google Photos album in this window.';
    } else if (!parseAlbumLocation(tab.url)) {
      pageProblem = tab.url.startsWith('https://photos.google.com/')
        ? 'This Google Photos page is not an album. Open an album (photos.google.com/album/… or a shared album link).'
        : 'Open a Google Photos album in this window.';
    } else {
      page = await sendToTab(tab.id, { type: 'apf:getPageInfo' });
      if (!page.album) pageProblem = 'This Google Photos page is not an album.';
    }
  } catch (err) {
    pageProblem = 'Could not talk to the Google Photos tab. Reload the tab and try again.';
    log.add('dom', `page info failed: ${String(err)}`);
  }
  render();
}

chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId === windowId) refreshPage();
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tabId === scanTabId && change.url && scan?.lifecycle.isActive) {
    const loc = parseAlbumLocation(change.url);
    if (!loc || albumIdentity(loc.album) !== scanAlbumKey) {
      log.add('scan', 'scanned tab navigated away from the album; stopping');
      scan.interrupt('album-changed');
    }
  }
  if (tab.active && tab.windowId === windowId && (change.url || change.status === 'complete' || change.title)) refreshPage();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === scanTabId && scan?.lifecycle.isActive) {
    log.add('scan', 'scanned tab was closed; stopping');
    scan.interrupt('tab-closed');
  }
});

// ---------- face models ----------

async function ensureModels(): Promise<boolean> {
  if (modelState === 'ready' && engine.info) return true;
  modelState = 'loading';
  render();
  try {
    const info = await engine.init();
    modelState = 'ready';
    log.add('model', `models ready: backend=${info.backend}, human=${info.humanVersion}, ${info.initMs} ms`);
    for (const a of info.attempts) if (!a.ok) log.add('model', `backend ${a.backend} unavailable: ${a.error}`);
  } catch (err) {
    modelState = 'failed';
    log.add('model', String(err));
  }
  render();
  return modelState === 'ready';
}

// ---------- reference ----------

async function onReferenceFile(file: File | undefined) {
  if (!file || scan?.lifecycle.isActive) return;
  releaseReference(reference);
  reference = null;
  selectedFace = null;
  referenceError = null;
  referenceLoading = true;
  render();
  if (!(await ensureModels())) {
    referenceLoading = false;
    referenceError = 'Face models failed to load, so the photo could not be analysed. See Diagnostics.';
    render();
    return;
  }
  try {
    reference = await loadReference(file, engine);
    const a = assessReference(reference.detect.faces);
    if (a.kind === 'single') selectedFace = a.faceIndex;
    log.add('ui', `reference analysed: ${reference.detect.faces.length} face(s), ${reference.detect.ms} ms`);
  } catch (err) {
    referenceError = err instanceof Error ? err.message : String(err);
    log.add('model', `reference failed: ${referenceError}`);
  }
  referenceLoading = false;
  el.refInput.value = '';
  render();
}

el.refInput.addEventListener('change', () => onReferenceFile(el.refInput.files?.[0]));
el.refDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.refDrop.classList.add('dragover');
});
el.refDrop.addEventListener('dragleave', () => el.refDrop.classList.remove('dragover'));
el.refDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  el.refDrop.classList.remove('dragover');
  onReferenceFile(e.dataTransfer?.files?.[0]);
});
el.refChange.addEventListener('click', () => el.refInput.click());

function referenceDescriptor(): Float32Array | null {
  if (!reference || selectedFace === null) return null;
  return reference.detect.faces[selectedFace]?.descriptor ?? null;
}

// ---------- scanning ----------

async function startScan() {
  const descriptor = referenceDescriptor();
  await refreshPage();
  if (!descriptor || !page?.album || activeTabId === null) return;
  if (page.photoId) {
    setStatus(el.scanStatus, 'Go back to the album grid (close the single-photo view), then start the scan.', 'warn');
    return;
  }
  if (!(await ensureModels())) return;
  results.clear();
  results = new ResultsStore(MIN_THRESHOLD, MAX_PREVIEWS);
  renderedResultsKey = '';
  stats = null;
  resetImageAccessStats();
  const album = page.album;
  scanTabId = activeTabId;
  scanAlbumKey = albumIdentity(album);
  scanAlbum = album;
  const useLarger = el.useLarger.checked && largerImagesVerifiedFor === scanAlbumKey;
  const processor = new AlbumPhotoProcessor(engine, { largerImagesVerified: useLarger });
  scan = new ScanController({
    albumIdentity: scanAlbumKey,
    reference: descriptor,
    discovery: discoveryPort(scanTabId),
    processor,
    onUpdate: (s) => {
      stats = s;
      scheduleRender();
    },
    onProcessed: (rec, processed, bestFace) => {
      results.add(rec, processed.image, bestFace >= 0 ? processed.detect.faces[bestFace].box : null);
    },
    log: (m) => log.add('scan', m),
  });
  log.add('scan', `scan started (${album.kind} album${useLarger ? ', larger images' : ''})`);
  const final = await scan.run();
  stats = final;
  log.add(
    'scan',
    `scan finished: state=${final.state}, discovered=${final.discovered}, processed=${final.processed}, skipped=${final.skipped}, failed=${final.failed}` +
      (processor.resizedFallbacks ? `, larger-image fallbacks=${processor.resizedFallbacks}` : ''),
  );
  render();
}

el.start.addEventListener('click', () => {
  startScan().catch((err) => {
    log.add('scan', `could not start: ${String(err)}`);
    render();
  });
});
el.pause.addEventListener('click', () => scan?.pause());
el.resume.addEventListener('click', async () => {
  if (!scan) return;
  if (stats?.notice === 'tab-hidden' && scanTabId !== null) {
    // Bring the album tab back so it keeps rendering new tiles.
    await chrome.tabs.update(scanTabId, { active: true }).catch(() => undefined);
  }
  scan.resume();
});
el.cancel.addEventListener('click', () => scan?.cancel());

// ---------- threshold ----------

el.threshold.min = String(MIN_THRESHOLD);
el.threshold.max = String(MAX_THRESHOLD);
el.threshold.addEventListener('input', () => {
  threshold = Number(el.threshold.value);
  renderResults(true);
  render();
});
el.threshold.addEventListener('change', () => {
  chrome.storage.local.set({ threshold }).catch(() => undefined);
});

// ---------- results ----------

function openPhoto(url: string) {
  if (!url.startsWith('https://photos.google.com/')) return;
  const scanning = scan?.state === 'running';
  chrome.tabs
    .query({ active: true, windowId })
    .then(([tab]) => chrome.tabs.create({ url, active: !scanning, index: tab ? tab.index + 1 : undefined }))
    .then(() => {
      if (scanning) log.add('ui', 'opened photo in a background tab so the scan can continue');
    })
    .catch((err) => log.add('ui', `could not open photo: ${String(err)}`));
}

function openPreview(c: Candidate) {
  const url = results.previewUrl(c.key);
  if (!url) return;
  el.previewImg.src = url;
  if (c.faceBox && c.imageWidth && c.imageHeight) {
    Object.assign(el.previewBox.style, {
      left: `${(c.faceBox.x / c.imageWidth) * 100}%`,
      top: `${(c.faceBox.y / c.imageHeight) * 100}%`,
      width: `${(c.faceBox.width / c.imageWidth) * 100}%`,
      height: `${(c.faceBox.height / c.imageHeight) * 100}%`,
    });
    show(el.previewBox, true);
  } else {
    show(el.previewBox, false);
  }
  setText(
    el.previewMeta,
    `Similarity ${formatScore(c.score ?? 0)} · ${c.facesCompared} face(s) compared · ${c.imageWidth}×${c.imageHeight}px` +
      (c.label ? ` · ${c.label}` : ''),
  );
  el.previewOpen.onclick = () => openPhoto(c.photoUrl);
  el.preview.showModal();
}
el.previewClose.addEventListener('click', () => el.preview.close());
el.preview.addEventListener('close', () => el.previewImg.removeAttribute('src'));

function renderResults(force = false) {
  const ranked = rankMatches(results.candidates(), threshold);
  const key = `${threshold}|${ranked.map((c) => c.key).join(',')}`;
  setText(el.matchCount, ranked.length ? `${ranked.length} match${ranked.length === 1 ? '' : 'es'}` : '');
  if (!force && key === renderedResultsKey) return;
  renderedResultsKey = key;
  el.results.replaceChildren(
    ...ranked.map((c) => {
      const preview = results.previewUrl(c.key);
      const label = `Similarity ${formatScore(c.score ?? 0)}. Open in Google Photos`;
      const open = h(
        'button',
        { class: 'open', type: 'button', title: c.label ?? 'Open in Google Photos', 'aria-label': label },
        preview ? h('img', { src: preview, alt: '', loading: 'lazy' }) : h('span', { class: 'noimg', text: 'Preview not kept' }),
      );
      open.addEventListener('click', () => openPhoto(c.photoUrl));
      const zoom = preview ? h('button', { class: 'zoom', type: 'button', 'aria-label': 'Preview', title: 'Preview', text: '⤢' }) : null;
      zoom?.addEventListener('click', () => openPreview(c));
      return h('div', { class: 'result' }, open, h('span', { class: 'score', text: formatScore(c.score ?? 0) }), zoom);
    }),
  );
}

// ---------- diagnostics ----------

async function collectThumbnailSamples(tabId: number, max: number): Promise<string[]> {
  try {
    return await sendToTab(tabId, { type: 'apf:sampleImageUrls', max });
  } catch (err) {
    log.add('dom', `could not read tile image URLs: ${String(err)}`);
    return [];
  }
}

function requireAlbumTab(): number | null {
  if (activeTabId === null || !page?.album) {
    log.add('dom', 'diagnostics need an open Google Photos album in the active tab');
    render();
    return null;
  }
  return activeTabId;
}

byId('diag-dom').addEventListener('click', async () => {
  await refreshPage();
  const tabId = requireAlbumTab();
  if (tabId === null) return;
  try {
    lastDom = await sendToTab(tabId, { type: 'apf:diagnoseDom' });
    log.add(
      'dom',
      `discovery check: ${lastDom.photoLinksThisAlbum} tile link(s) for this album, ${lastDom.tilesWithImageUrl} with image URL, ` +
        `scroller=${lastDom.scroll.container}`,
    );
  } catch (err) {
    log.add('dom', `discovery check failed: ${String(err)}`);
  }
  render();
});

byId('diag-scroll').addEventListener('click', async () => {
  const tabId = requireAlbumTab();
  if (tabId === null || scan?.lifecycle.isActive) return;
  try {
    lastScrollProbe = await sendToTab(tabId, { type: 'apf:scrollProbe' });
    log.add('dom', `scroll test: +${lastScrollProbe.newKeysAfterScroll} new tiles, ${lastScrollProbe.keysThatLeftDom} left the DOM`);
  } catch (err) {
    log.add('dom', `scroll test failed: ${String(err)}`);
  }
  render();
});

byId('diag-images').addEventListener('click', async () => {
  const tabId = requireAlbumTab();
  if (tabId === null) return;
  const urls = await collectThumbnailSamples(tabId, 3);
  if (!urls.length) {
    log.add('image', 'no tile image URLs found on the page to test');
    render();
    return;
  }
  lastImageProbe = await probeImageAccess(urls);
  for (const p of lastImageProbe) {
    log.add('image', p.ok ? `sample ${p.index + 1}: ok (${p.mode}) ${p.width}×${p.height}, ${p.bytes} bytes` : `sample ${p.index + 1}: failed: ${p.error}`);
  }
  render();
});

byId('diag-larger').addEventListener('click', async () => {
  const tabId = requireAlbumTab();
  if (tabId === null || !page?.album) return;
  const urls = await collectThumbnailSamples(tabId, 3);
  lastResolutionProbe = await probeLargerImages(urls, LARGER_IMAGE_LONG_EDGE);
  largerImagesVerifiedFor = lastResolutionProbe.verified ? albumIdentity(page.album) : null;
  log.add('image', `larger-image test: ${lastResolutionProbe.verified ? 'verified' : 'not verified'} on ${urls.length} sample(s)`);
  render();
});

byId('diag-model').addEventListener('click', () => ensureModels());

byId('diag-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(diagnosticsReport(), null, 2));
    log.add('ui', 'diagnostics report copied to clipboard');
  } catch (err) {
    log.add('ui', `copy failed: ${String(err)}`);
  }
});

el.diagnostics.addEventListener('toggle', () => {
  chrome.storage.local.set({ diagnosticsOpen: el.diagnostics.open }).catch(() => undefined);
});

function diagnosticsReport() {
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    model: { state: modelState, info: engine.info, lastError: engine.lastError },
    page: page ? { albumKind: page.album?.kind ?? null, photoView: !!page.photoId, tilesInDom: page.tilesInDom, visible: page.visible } : { problem: pageProblem },
    domDiagnostics: lastDom,
    scrollProbe: lastScrollProbe,
    imageProbe: lastImageProbe,
    resolutionProbe: lastResolutionProbe,
    imageAccess: imageAccessStats,
    scan: stats ? { ...stats } : null,
    results: { candidatesKept: results.size, liveObjectUrls: results.liveObjectUrls },
    log: log.list().map((e) => `${new Date(e.t).toISOString()} [${e.category}] ${e.message}`),
  };
}

function renderDiagnostics() {
  if (!el.diagnostics.open) return;
  const r = diagnosticsReport();
  const summary = {
    model: r.model,
    page: r.page,
    domDiagnostics: r.domDiagnostics,
    scrollProbe: r.scrollProbe,
    imageProbe: r.imageProbe,
    resolutionProbe: r.resolutionProbe,
    imageAccess: r.imageAccess,
    scanFailures: stats ? { failuresByCategory: stats.failuresByCategory, skipsByReason: stats.skipsByReason, smallImages: stats.smallImages, facesTooSmall: stats.facesTooSmall } : null,
    lastDiscoveryStep: stats?.lastStep ?? null,
  };
  setText(el.diagSummary, JSON.stringify(summary, null, 2));
  setText(el.diagLog, r.log.slice(-80).join('\n'));
}
log.onChange(() => scheduleRender());

// ---------- clear ----------

el.clear.addEventListener('click', () => {
  scan?.cancel();
  scan = null;
  stats = null;
  scanTabId = null;
  scanAlbumKey = null;
  scanAlbum = null;
  releaseReference(reference);
  reference = null;
  selectedFace = null;
  referenceError = null;
  results.clear();
  renderedResultsKey = '';
  el.results.replaceChildren();
  lastDom = null;
  lastScrollProbe = null;
  lastImageProbe = null;
  lastResolutionProbe = null;
  largerImagesVerifiedFor = null;
  el.useLarger.checked = false;
  resetImageAccessStats();
  engine.dispose();
  modelState = 'not-loaded';
  log.clear();
  log.add('ui', 'session cleared');
  render();
});

// ---------- rendering ----------

function setStatus(node: HTMLElement, text: string, tone: '' | 'warn' | 'error' | 'ok' = '') {
  setText(node, text);
  node.className = `${node.classList.contains('msg') ? 'msg' : 'status'}${tone ? ' ' + tone : ''}`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 250);
}

function renderAlbum() {
  if (pageProblem || !page?.album) {
    setStatus(el.albumStatus, pageProblem ?? 'Looking for an album…', pageProblem ? 'warn' : '');
    return;
  }
  const kind = page.album.kind === 'share' ? 'Shared album' : 'Album';
  const title = page.title ? `: ${page.title}` : '';
  const view = page.photoId ? ' (showing a single photo; go back to the grid to scan)' : '';
  const scanningOther = !!scan?.lifecycle.isActive && !isSameAlbum(page.album, scanAlbum);
  setStatus(el.albumStatus, `${kind}${title}${view}${scanningOther ? ' — a scan is running in another tab' : ''}`, page.photoId ? 'warn' : '');
}

function renderReference() {
  const busy = !!scan?.lifecycle.isActive;
  el.refInput.disabled = busy;
  el.refChange.disabled = busy;
  show(el.refDrop, !reference && !referenceLoading);
  show(el.refView, !!reference);
  if (referenceLoading) {
    setStatus(el.modelStatus, modelState === 'loading' ? 'Loading face models (first time can take a few seconds)…' : 'Finding faces in the reference photo…');
  } else if (referenceError) {
    setStatus(el.modelStatus, referenceError, 'error');
  } else if (modelState === 'failed') {
    setStatus(el.modelStatus, 'Face models failed to load. Open Diagnostics for details.', 'error');
  } else {
    setStatus(el.modelStatus, modelState === 'ready' && engine.info ? `Face models ready (${engine.info.backend}).` : '');
  }
  if (!reference) {
    el.faceChooser.replaceChildren();
    el.refBoxes.replaceChildren();
    return;
  }
  if (el.refImg.getAttribute('src') !== reference.previewUrl) el.refImg.src = reference.previewUrl;
  const { faces, width, height } = reference.detect;
  el.refBoxes.replaceChildren(
    ...faces.map((f, i) =>
      h('div', {
        class: `face-box${i === selectedFace ? ' selected' : ''}${f.descriptor ? '' : ' unusable'}`,
        style: `left:${(f.box.x / width) * 100}%;top:${(f.box.y / height) * 100}%;width:${(f.box.width / width) * 100}%;height:${(f.box.height / height) * 100}%`,
      }),
    ),
  );
  const a = assessReference(faces);
  switch (a.kind) {
    case 'no-face':
      setStatus(el.refMessage, 'No face was found in this photo. Try a clearer, front-facing photo where the face is not too small.', 'error');
      break;
    case 'only-small-faces':
      setStatus(el.refMessage, `Found ${a.count} face(s), but all are too small to describe reliably. Use a closer or higher-resolution photo.`, 'error');
      break;
    case 'single':
      setStatus(
        el.refMessage,
        a.lowQuality ? 'One face found, but it is small. Results will be less reliable; a closer photo works better.' : 'One face found. Ready to search.',
        a.lowQuality ? 'warn' : 'ok',
      );
      break;
    case 'multiple':
      setStatus(el.refMessage, selectedFace === null ? `Found ${faces.length} faces. Choose the person to search for:` : 'Face selected. Ready to search.', selectedFace === null ? 'warn' : 'ok');
      break;
  }
  if (a.kind === 'multiple') {
    el.faceChooser.replaceChildren(
      ...faces.map((f, i) => {
        const usable = !!f.descriptor;
        const btn = h(
          'button',
          { type: 'button', class: 'face-option', role: 'radio', 'aria-checked': String(i === selectedFace), 'aria-label': `Face ${i + 1}${usable ? '' : ' (too small)'}`, disabled: !usable || busy },
          drawFaceCrop(reference!.bitmap, f.box, 128),
          usable ? null : h('small', { text: 'too small' }),
        );
        btn.addEventListener('click', () => {
          selectedFace = i;
          render();
        });
        return btn;
      }),
    );
  } else {
    el.faceChooser.replaceChildren();
  }
}

const STATE_TEXT: Record<string, string> = {
  starting: 'Starting…',
  canceling: 'Canceling…',
  canceled: 'Scan canceled. Matches found so far are shown below.',
};

function renderScan() {
  const s = scan?.state ?? 'idle';
  const active = !!scan?.lifecycle.isActive;
  const ready = !!referenceDescriptor() && !!page?.album && !page.photoId && !pageProblem;
  el.start.disabled = active || !ready || referenceLoading;
  el.pause.disabled = s !== 'running';
  el.resume.disabled = s !== 'paused';
  el.cancel.disabled = !(s === 'running' || s === 'paused' || s === 'starting');
  show(el.pause, s !== 'paused');
  show(el.resume, s === 'paused');
  show(el.progress, s === 'running' || s === 'starting' || s === 'canceling');

  if (s === 'idle') {
    if (!referenceDescriptor()) setStatus(el.scanStatus, 'Add a reference photo (and choose a face) to start.');
    else if (!page?.album || pageProblem) setStatus(el.scanStatus, 'Open the album you want to search in this window.');
    else setStatus(el.scanStatus, 'Ready. The scan scrolls the album page automatically; keep the tab open and visible.');
  } else if (s === 'running') {
    const phase =
      stats?.phase === 'processing' || stats?.phase === 'finishing'
        ? 'Finished scrolling; checking the remaining photos…'
        : 'Scanning: scrolling the album and checking photos…';
    setStatus(el.scanStatus, phase);
  } else if (s === 'paused') {
    const notice =
      stats?.notice === 'photo-view'
        ? 'Paused: the tab is showing a single photo. Go back to the album grid, then Resume.'
        : stats?.notice === 'tab-hidden'
          ? 'Paused: the album tab is in the background, where it may stop loading photos. Resume brings it back to the front.'
          : 'Paused. Resume to continue from where the scan stopped.';
    setStatus(el.scanStatus, notice, stats?.notice ? 'warn' : '');
  } else if (s === 'ended') {
    const why = stats?.stopReason ? STOP_REASON_TEXT[stats.stopReason] : '';
    setStatus(
      el.scanStatus,
      `Scan ended (best effort). ${why} Google Photos does not report how many photos an album holds, so complete coverage cannot be verified.`,
      'ok',
    );
  } else if (s === 'interrupted') {
    const r = stats?.interruptReason;
    const text =
      r === 'tab-closed'
        ? 'Scan stopped: the album tab was closed.'
        : r === 'page-unreachable'
          ? 'Scan stopped: the album page stopped responding. Reload it and try again.'
          : r === 'not-album-grid'
            ? 'Scan not started: the tab is showing a single photo. Go back to the album grid first.'
            : 'Scan stopped: the tab moved to a different page or album. Matches found so far are shown below.';
    setStatus(el.scanStatus, text, 'warn');
  } else if (s === 'error') {
    setStatus(el.scanStatus, `Scan stopped because of an error: ${stats?.error ?? 'unknown'}. See Diagnostics.`, 'error');
  } else {
    setStatus(el.scanStatus, STATE_TEXT[s] ?? '');
  }

  const matches = rankMatches(results.candidates(), threshold).length;
  const rows: Array<[string, number | string]> = stats
    ? [
        ['Discovered', stats.discovered],
        ['Processed', stats.processed],
        ['With faces', stats.withFaces],
        ['Waiting', stats.queued + stats.inFlight + stats.awaitingImage],
        ['Skipped', stats.skipped],
        ['Failed', stats.failed],
        ['Matches', matches],
        ['Scroll steps', stats.steps],
        ['Faces too small', stats.facesTooSmall],
      ]
    : [];
  el.counters.replaceChildren(...rows.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: String(v) }))));
}

function renderResultsSection() {
  setText(el.thresholdValue, formatScore(threshold));
  if (el.threshold.value !== String(threshold)) el.threshold.value = String(threshold);
  renderResults();
  const ranked = rankMatches(results.candidates(), threshold).length;
  let empty = '';
  if (!stats) empty = 'Matches will appear here, highest similarity first.';
  else if (!ranked) {
    const s = scan?.state;
    empty =
      s === 'running' || s === 'paused' || s === 'starting'
        ? 'No matches yet.'
        : stats.processed === 0
          ? 'No photos could be processed. Check Diagnostics for discovery or image-access problems.'
          : `No photos reached the threshold. Try lowering it${results.size ? ` (${results.size} candidate(s) are just below)` : ''}.`;
  }
  setText(el.resultsEmpty, empty);
  show(el.resultsEmpty, !!empty);
}

function renderLargerToggle() {
  const verified = !!page?.album && largerImagesVerifiedFor === albumIdentity(page.album);
  el.useLarger.disabled = !verified || !!scan?.lifecycle.isActive;
  if (!verified) el.useLarger.checked = false;
}

function render() {
  renderAlbum();
  renderReference();
  renderScan();
  renderResultsSection();
  renderLargerToggle();
  renderDiagnostics();
}

// ---------- boot ----------

(async () => {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const prefs = await chrome.storage.local.get(['threshold', 'diagnosticsOpen']).catch(() => ({}) as Record<string, unknown>);
  if (typeof prefs.threshold === 'number' && prefs.threshold >= MIN_THRESHOLD && prefs.threshold <= MAX_THRESHOLD) threshold = prefs.threshold;
  if (prefs.diagnosticsOpen === true) el.diagnostics.open = true;
  render();
  await refreshPage();
})();

window.addEventListener('pagehide', () => {
  scan?.cancel();
  results.clear();
  releaseReference(reference);
  engine.dispose();
});
