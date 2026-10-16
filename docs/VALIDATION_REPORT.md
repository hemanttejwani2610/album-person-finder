# Validation report

Date: 2026-10-16 · Version 0.1.0 · macOS 26.6.1 (arm64), Node 24.20.0

**Bottom line.** The extension's own machinery (MV3 wiring, side panel, content script, controlled scrolling over a virtualized grid, image fetching from the extension, on-device face detection plus embeddings under the extension CSP, matching, and scan lifecycle) works end to end in a real Chrome against a **simulated** album. Face matching was evaluated on a small public-domain photo set. **Nothing has been run against a real Google Photos album yet**, so it is not yet known whether the extension works on photos.google.com. That is the next step: the diagnostics and [MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md).

## 1. Tested automatically (unit tests)

`npm test`: **81 / 81 passing** (Vitest; jsdom for DOM tests).

| Area | File | What it covers |
| --- | --- | --- |
| Matching | `test/matching.test.ts` | distance/similarity, dlib 0.6 ↔ threshold 0.40 mapping, best-face-per-photo (group photos), small/undescribed faces, ranking and re-ranking on threshold change, reference assessment (no face / only small / single / multiple) |
| Deduplication | `test/photoRegistry.test.ts` | identity by album + photo id (not thumbnail URL), late image URLs, no re-queue after processing, discovery order, requeue on interruption, finalize "no image" skips |
| Scan lifecycle | `test/scanLifecycle.test.ts`, `test/scanController.test.ts` | state machine and illegal transitions; stop policy (bottom reached, not scrolling, empty run, step cap); controller with fake discovery/processor: full run, dedupe across steps, concurrency bound, back-pressure, pause/resume, cancel aborting non-abortable work, album change, external interrupt (tab closed), photo-view and hidden-tab auto-pause, lost content session restart, bounded retries then "page unreachable", skip vs failure accounting, double start |
| Album adapter | `test/googlePhotosUrls.test.ts`, `test/googlePhotosDom.test.ts`, `test/discoverySession.test.ts` | URL parsing (album, `/u/N`, shared `?key=`, photo view, rejects other hosts/paths), canonical links; tile discovery on a **synthetic** grid (`<img>`, inline background, single-tile wrapper, placeholders, no neighbour borrowing, `<base href>`, other-album links, label sanitising); controlled scrolling over a **simulated** virtualized grid (captures all 40 tiles while ≤ 8 are mounted, reports each once, late thumbnails, scroll restore, refuses to scroll after navigation) |
| Support | `test/support.test.ts` | image-host allow-list, size-suffix scaling (and refusing to guess), retry policy, face-alignment math, preview cap and object-URL revocation, log URL scrubbing, diagnostics URL masking |

`npm run typecheck` (src with Chrome types only; tests with Node types) passes.

## 2. Tested in a real browser

Chrome for Testing 155.0.8059.79 (headless) driven by Puppeteer 25.14.0, `dist/` installed as an unpacked extension. `scripts/browser-smoke.mjs`:

- opens the **real side panel** through the toolbar action;
- serves `test/fixtures/fake-album.html` at `https://photos.google.com/album/FIXTUREALBUM1` and test images at `https://lh3.googleusercontent.com/fixture/…` via request interception. **This page is a simulation written for this project, not Google Photos markup.** It reproduces only the behaviours the adapter relies on: tile links, late-loading CSS background thumbnails, an inner scroll container, and virtualization that unmounts off-screen tiles;
- maps every other hostname to "not found" (`--host-resolver-rules`), so the run also shows that nothing is loaded from a CDN or any other server;
- album: 48 photos (12 public-domain images × 4, shuffled, distinct photo ids) served as 512 px thumbnails.

Results (normal build, WebGL backend): **25 / 25 checks passed** in each of 3 consecutive runs after the final code change. Full scan of 48 photos: 8.0–8.7 s.

Checks: extension installs; toolbar opens side panel; album and title detected; DOM diagnostics find tiles and ignore the other-album link; scroll probe sees virtualization and restores position; image probe fetches and decodes thumbnails without cookies; larger-image probe verifies only when the server returns bigger images; no-face reference message; models load under the extension CSP with all external network blocked; multi-face reference requires a choice; Find disabled until then; single-face reference accepted; all 48 photos discovered and processed with none skipped or failed; results sorted; no photo of other people at the default threshold; at most one photo of the person missed; identical images under different ids score identically; clicking a result opens the canonical photo URL in a new tab; pause stops processing; resume continues; cancel ends "canceled" and restores scroll; navigating to another album stops the scan; clear session empties everything; no uncaught panel errors.

WASM fallback: `npm run build -- --backends wasm` then `--expect-backend wasm`: **25 / 25 passed**, identical match results, 5–7 s for 48 photos across runs. (WebGL was slower here because headless Chrome renders WebGL in software; a real GPU should reverse that.)

## 3. Face matching evaluation

`scripts/eval-models.mjs` runs the shipped `FacePipeline` code in Chrome on test photos at 384, 512 and 1,280 px (long edge).

**Test set.** 13 NASA photos from Wikimedia Commons, all marked public domain (`npm run fetch-test-images -- <dir>`; titles listed in `scripts/fetch-test-images.mjs`). Reference: an official portrait of astronaut Kate Rubins. Positives: 6 photos containing her, including 4 crew/group portraits with 3–7 faces. Negatives: 5 photos of other astronauts, including 2 groups. One photo with no people. **This is a single identity and 12 album photos. It is a sanity check, not a benchmark.**

Best similarity (1 − descriptor distance) per photo, shipped pipeline (dlib ResNet + FaceMesh alignment):

| Photo | 384 px | 512 px | 1,280 px | Face size at 512 px |
| --- | --- | --- | --- | --- |
| pos: Expedition 49 group (3 faces) | 0.59 | 0.64 | 0.74 | 75 px |
| pos: Soyuz MS-01 crew (3) | 0.58 | 0.60 | 0.71 | 76 px |
| pos: Expedition 49 crew (6) | 0.52 | 0.56 | 0.69 | 60 px |
| pos: Expedition 64 crew (7) | 0.44 | 0.50 | 0.59 | 66 px |
| pos: inside BEAM module | 0.47 | 0.44 | 0.52 | 59 px |
| pos: Destiny lab (**near-profile**, headband) | 0.28 | 0.26 | 0.24 | 119 px |
| neg: Koch portrait | 0.26 | 0.27 | 0.26 | 248 px |
| neg: Expedition 61 crew (6) | 0.27 | 0.24 | 0.26 | 47 px |
| neg: spacewalk crew (4) | 0.23 | 0.19 | 0.25 | 44 px |
| neg: Meir portrait (two photos) | 0.14–0.19 | 0.14–0.15 | 0.15–0.16 | 151–194 px |
| no-face ISS photo | no faces | no faces | no faces | — |

At the default threshold of **0.40**, all 5 frontal or three-quarter photos of the person match (including all 4 group photos, with faces as small as 46 px), none of the 5 negative photos match, and the near-profile photo is missed. The gap between the weakest frontal positive (0.44) and the strongest negative (0.27) is consistent with the dlib model's documented 0.6 distance threshold, which is why 0.40 was chosen.

Descriptors compared on the same images:

| Pipeline | Weakest positive (excl. profile) vs strongest negative, 512 px | Outcome |
| --- | --- | --- |
| dlib ResNet + FaceMesh alignment (**shipped**) | 0.44 vs 0.27 | separable |
| dlib ResNet + plain box crop | 0.44 vs 0.69 | not separable; alignment matters |
| Human FaceRes (cosine) | 0.46 vs 0.47 (and the profile at 0.24) | not separable; rejected |

Human's MobileFaceNet option returned identical descriptors for every face in this version and was not usable.

## 4. Issues found during validation and fixed

- Relative tile links were resolved against the page URL, ignoring `<base href>`. They now use the browser-resolved `anchor.href`.
- Human's FaceRes descriptor gave overlapping scores for the person and for strangers. It was replaced with the dlib ResNet descriptor plus landmark alignment (section 3).
- Human's bundled TensorFlow.js lacks the chained tensor API; the ported network uses functional ops.
- The WASM backend tried to start helper threads from `blob:` scripts, which the extension CSP blocks. It is now forced to the single-threaded SIMD build. Verified under the real CSP.
- Cancel and interrupt waited for in-flight inference, which cannot be aborted. They now return immediately and late results are discarded.
- Starting a second scan briefly showed the previous scan's counters. Stats now reset on start.
- Worker crashes surfaced as `[object ErrorEvent]`. The worker now reports readable errors to the diagnostics log.
- DOM diagnostics included a 4-character photo-id prefix. Removed, so reports contain no photo IDs.

## 5. Not verified

- **Anything on real photos.google.com**: tile link shapes, thumbnail rendering, image host, whether thumbnails load without cookies, the scroll container and lazy-loading trigger, behaviour of the size suffix, album title source, shared-album links, single-photo URLs. All are assumptions; see [FEASIBILITY.md](FEASIBILITY.md). The built-in browser was not signed in to Google, and Claude in Chrome was not connected, so no live album could be inspected.
- Headful Chrome with a real GPU (performance and side-panel rendering were only exercised headless).
- Large albums (only 48 photos tested), memory over long scans, and the preview cap under load.
- Face matching beyond one identity and 12 photos: children, age gaps, varied skin tones, low light, masks and sunglasses were not evaluated.
- Windows and Linux; multiple Chrome windows; Chrome versions other than 155.
- An accessibility audit of the side panel (keyboard and labels were considered in the design but not tested with assistive technology).

## Reproducing

```bash
npm ci && npm run fetch-models && npm run check
```

```bash
npx puppeteer browsers install chrome
```

```bash
npm run fetch-test-images -- /tmp/apf-faces
```

```bash
npm run test:browser -- --images /tmp/apf-faces --out /tmp/apf-smoke.json
```

```bash
npm run eval:models -- --images /tmp/apf-faces --sizes 384,512,1280
```

The image-resizing step in the browser test and the evaluation uses macOS `sips`.
