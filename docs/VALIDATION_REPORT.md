# Validation report

Date: 2026-10-16 · Version 0.2.0 · macOS 26.6.1 (arm64), Node 24.20.0

**Real Google Photos album (2026-10-16, v0.2.0).** The user ran a full scan of one of their shared albums in Chrome 155 on macOS and shared the redacted diagnostics report. It is the first evidence from photos.google.com itself: the album was detected as a shared album; **204 photos were discovered and all 204 processed** (none skipped or failed) over 42 scroll steps, ending with "reached-end" while only 12–15 tiles were ever in the page; **210 / 210 thumbnail requests succeeded without cookies**; the larger-image check **verified** on 3 samples (e.g. 328×246 → 1024×768), so the scan used 1,024 px images; models loaded on WebGL in 0.5 s; 127 photos had faces (308 faces compared); the whole scan took about 78 s. Asked to check the album's photo count, the 16 matches at the default (Balanced) setting, and opening a result, the user replied "all are correct". See section 7.

**Before that run:** the extension's own machinery (MV3 wiring, side panel, content script, controlled scrolling over a virtualized grid, image fetching from the extension, on-device face detection plus embeddings under the extension CSP, matching, and scan lifecycle) works end to end in a real Chrome against a **simulated** album. Face matching was evaluated on a 3-person, 46-photo public-domain benchmark (section 3). **Nothing has been run against a real Google Photos album yet**, so it is not yet known whether the extension works on photos.google.com. That is the next step: the diagnostics and [MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md).

## 1. Tested automatically (unit tests)

`npm test`: **83 / 83 passing** (Vitest; jsdom for DOM tests).

| Area | File | What it covers |
| --- | --- | --- |
| Matching | `test/matching.test.ts` | cosine similarity, default threshold vs OpenCV's 0.363, Strict/Balanced/Loose presets, best-face-per-photo (group photos), small/undescribed faces, ranking and re-ranking on threshold change, reference assessment (no face / only small / single / multiple) |
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

Results with the current (SFace) build, WebGL detection: **26 / 26 checks passed** (the 26th covers the Strict / Balanced / Loose presets) after the final code change; earlier runs of the other 25 checks also passed. Full scan of 48 photos: about 17 s, using larger images, which the automatic check verified against the simulated server. With the previous dlib build: 25 / 25, 8.0–8.7 s at thumbnail size.

The harness retries the toolbar click up to 4 times, because in headless Chrome the first click occasionally arrives before the service worker has enabled "open panel on click".

Checks: extension installs; toolbar opens side panel; album and title detected; DOM diagnostics find tiles and ignore the other-album link; scroll probe sees virtualization and restores position; image probe fetches and decodes thumbnails without cookies; larger-image probe verifies only when the server returns bigger images; no-face reference message; models load under the extension CSP with all external network blocked; multi-face reference requires a choice; Find disabled until then; single-face reference accepted; all 48 photos discovered and processed with none skipped or failed; results sorted; no photo of other people at the default threshold; at most one photo of the person missed; identical images under different ids score identically; clicking a result opens the canonical photo URL in a new tab; pause stops processing; resume continues; cancel ends "canceled" and restores scroll; navigating to another album stops the scan; clear session empties everything; no uncaught panel errors.

WASM fallback: `npm run build -- --backends wasm` then `--expect-backend wasm`: **25 / 25 passed** with the SFace build, same match results, about 12.5 s for 48 photos. (WebGL was slower here because headless Chrome renders WebGL in software; a real GPU should reverse that.)

## 3. Recognition benchmark (current model)

After user feedback that recognition was too weak on a real album ("misses photos and matches wrong people"), the model was re-evaluated on a harder benchmark: `scripts/benchmark/` (fetch + run). It uses **46 public-domain NASA photos of 3 women astronauts of similar age** (Kate Rubins, Christina Koch, Jessica Meir). That includes solo shots in varied poses and lighting, group photos where two of them appear together, crew portraits, and photos without them. For each person, the album is every photo except that person's references (39 positive and 90 negative person/photo pairs in total). A photo scores as its best-matching face, exactly as in the extension.

Single reference photo, no mirror averaging:

| Model | Album image size | Photos of the person found | Wrong photos matched | AUC | Found with zero wrong matches |
| --- | --- | --- | --- | --- | --- |
| dlib ResNet (0.1.0) | 384 px | 26 / 39 | 2 / 90 | 0.891 | 59 % |
| **SFace** | 384 px | 28 / 39 | 2 / 90 | 0.885 | 71 % |
| dlib ResNet (0.1.0) | 512 px | 27 / 39 | 1 / 90 | 0.924 | 63 % |
| **SFace** | 512 px | **31 / 39** | 2 / 90 | 0.917 | 77 % |
| dlib ResNet (0.1.0) | 1,024 px | 32 / 39 | 3 / 90 | 0.934 | 77 % |
| **SFace** | 1,024 px | **33 / 39** | 3 / 90 | 0.958 | 85 % |

Thresholds: dlib 0.40 (= distance 0.6), SFace 0.363 (OpenCV's documented value; the extension uses 0.36).

Other options measured and not adopted:

- **Mirror averaging** (describe each face and its mirror image): small gain for dlib, none for SFace.
- **Three reference photos** (max or averaged): +1–3 photos found, but 3–4× more wrong matches at the same threshold.
- **dlib + SFace combined**: no better than SFace alone.
- **SFace int8**: same accuracy as fp32 (31/39 and 33/39), but about 2× slower in ONNX Runtime Web (464 vs 238 ms per image), so fp32 ships.

Why the remaining photos are missed (SFace, 512 px): every miss had a detected face. Looking at the aligned face crops, the misses are profiles, a face turned down at the edge of the frame, a face behind a floating water bubble, and small faces in a crew photo. In two photos the detector also picked up a non-face (equipment, an arm), which is why some misses score near 0. These are pose and occlusion limits rather than an alignment bug: the aligned crops of frontal faces are correctly framed.

Resulting changes: SFace replaced dlib as the descriptor, and larger images are now requested automatically. The scan first verifies on the user's album that a bigger image really comes back, and otherwise uses the page's thumbnails. Image resolution was the largest single factor in this benchmark.

**Limits of this evidence:** 3 identities and 46 photos, all adult women, mostly on the ISS. It is a much better check than the original 12-photo set, but it is still not a benchmark that predicts accuracy on your album.

## 4. Original face matching evaluation (0.1.0, dlib)

This section is kept for history; the shipped model is now SFace (section 3).

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

## 5. Issues found during validation and fixed

- Relative tile links were resolved against the page URL, ignoring `<base href>`. They now use the browser-resolved `anchor.href`.
- Human's FaceRes descriptor gave overlapping scores for the person and for strangers. It was replaced with the dlib ResNet descriptor plus landmark alignment (section 3).
- Human's bundled TensorFlow.js lacks the chained tensor API; the ported network uses functional ops.
- The WASM backend tried to start helper threads from `blob:` scripts, which the extension CSP blocks. It is now forced to the single-threaded SIMD build. Verified under the real CSP.
- Cancel and interrupt waited for in-flight inference, which cannot be aborted. They now return immediately and late results are discarded.
- Starting a second scan briefly showed the previous scan's counters. Stats now reset on start.
- Worker crashes surfaced as `[object ErrorEvent]`. The worker now reports readable errors to the diagnostics log.
- DOM diagnostics included a 4-character photo-id prefix. Removed, so reports contain no photo IDs.
- (0.2) ONNX Runtime Web loads a small `.mjs` glue module next to its WASM at runtime; it is now shipped in `dist/wasm/`.
- (0.2) Backend fallback did not actually switch TensorFlow.js backends after a failed first attempt (it is shared by all Human instances). It now calls Human's explicit `init()` per attempt.
- (0.2) ONNX Runtime logged harmless graph-optimisation warnings as console errors; its log level is now "error".
- (0.2) A threshold saved for the old model would have been misread on the new score scale; the preference key is now versioned.

## 6. Not verified

- On photos.google.com: personal (non-shared) albums, the album title source, pause/resume/cancel and navigation handling on the real site, very large albums, and other people's albums and faces. Recall on the real album (photos of the person that were *not* listed) was not measured separately. See section 7 for what the real run did confirm.
- Headful Chrome with a real GPU (performance and side-panel rendering were only exercised headless).
- Large albums (only 48 photos tested), memory over long scans, and the preview cap under load.
- Face matching beyond one identity and 12 photos: children, age gaps, varied skin tones, low light, masks and sunglasses were not evaluated.
- Windows and Linux; multiple Chrome windows; Chrome versions other than 155.
- An accessibility audit of the side panel (keyboard and labels were considered in the design but not tested with assistive technology).

## 7. Real-album evidence (user run, shared album)

| Feasibility question | Result on the real album |
| --- | --- |
| Tile links / thumbnails discoverable | Yes: 204 photos discovered for the album, 0 links to other albums, 0 tiles without an image URL at the last step |
| Scrolling and virtualization | Programmatic scrolling loaded the whole grid: 42 steps, stop reason `reached-end`, 0 duplicates, 12–15 tiles in the DOM at a time |
| Image bytes from the extension | 210 / 210 fetches OK with `credentials: omit`; no HTTP or network errors |
| Higher resolution | Size-suffix variant verified on 3/3 samples (198–437 px → 768–1,024 px) |
| Model initialization | WebGL, 532 ms |
| Throughput | ~0.38 s per photo including scrolling (204 photos in ~78 s) |

| User check | After being asked to verify the album's photo count (204), the 16 matches at the default setting, and that a result opens the right photo, the user reported "all are correct" |

Source: the redacted "Copy report" output the user pasted (no photo IDs or URLs) and the user's own check of the results.

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

```bash
node scripts/benchmark/fetch.mjs /tmp/apf-bench
```

```bash
node scripts/benchmark/run.mjs --images /tmp/apf-bench --sizes 384,512,1024 --explain
```

The image-resizing step in the browser test and the evaluation uses macOS `sips`.
