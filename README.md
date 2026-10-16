# Album Person Finder

A Chrome (Manifest V3) extension that finds photos of a person inside the Google Photos album you have open. You upload a reference photo, pick the face, and the extension scrolls the album, checks every photo it can see, and lists likely matches — including group photos — sorted by similarity. Face detection, face embeddings and comparison all run locally in your browser.

> **Status:** the extension has been tested end to end in a real Chrome against a *simulated* album page, and its face matching has been evaluated on a small set of public-domain photos. **It has not yet been run against a real Google Photos album.** Selectors, image URLs and scrolling behaviour on photos.google.com are documented assumptions that the built-in diagnostics are designed to confirm or refute. See [docs/VALIDATION_REPORT.md](docs/VALIDATION_REPORT.md) and [docs/FEASIBILITY.md](docs/FEASIBILITY.md).

## Install and build

Requirements: Node.js 20+ (tested with 24), npm, Chrome 116+.

```bash
npm ci
```

```bash
npm run fetch-models
```

```bash
npm run build
```

`fetch-models` downloads the face-descriptor weights (6.4 MB) from a pinned commit and verifies their SHA-256 checksums (details in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)). The other models and the WASM binaries come from the locked npm packages. The build writes the unpacked extension to `dist/` (about 16 MB). Everything the extension executes is in that folder; nothing is fetched from a CDN at runtime.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript checks for `src/` and `test/` |
| `npm test` | Unit tests (Vitest, jsdom fixtures) |
| `npm run check` | typecheck + tests + build |
| `npm run test:browser -- --images <dir>` | Real-browser smoke test (see below) |
| `npm run eval:models -- --images <dir>` | Compare descriptor models on your own test photos |
| `npm run watch` | Rebuild on source changes |

## Load the unpacked extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist/` folder.
4. Pin “Album Person Finder” from the puzzle-piece menu if you like.

After rebuilding, click the reload icon on the extension card. If a Google Photos tab was already open, the side panel re-injects its page script automatically; reloading the tab also works.

## Scan an album

1. Open an album on `photos.google.com` (your own album `…/album/…` or a shared album link `…/share/…`). Stay on the album grid, not a single photo.
2. Click the extension's toolbar icon to open the side panel. It shows the album it found.
3. Under **Reference photo**, choose or drop a clear photo of the person. The face models load on first use (a few seconds).
   - One face: it is selected automatically.
   - Several faces: click the face to search for.
   - No usable face: you get a message explaining why.
4. Click **Find in this album**. The extension scrolls the album page in steps, collects each photo link before Google Photos removes it from the page, fetches the thumbnail it rendered, and compares every face in it with your reference.
5. Keep the album tab visible. If you switch away, the scan pauses itself (background tabs may stop rendering new photos); **Resume** brings the tab back.
6. Matches appear as they are found, highest similarity first. Use the **Similarity threshold** slider to show more or fewer candidates. Click a thumbnail to open that photo in Google Photos (in a new tab; a background tab while a scan is running). Use the ⤢ button for an in-panel preview with the matched face outlined.
7. **Pause**, **Resume** and **Cancel** work at any time. Navigating the scanned tab to another page or album stops the scan safely.

When the scan finishes it says **“Scan ended (best effort)”** with the reason it stopped. Google Photos does not expose how many photos an album contains, so the extension cannot prove it saw all of them. The counters show what was discovered, processed, skipped and failed.

### Similarity scores

Scores are `1 − distance` between 128-dimensional face embeddings (dlib's ResNet face model). Higher means more similar. They are **not probabilities**. The default threshold, 0.40, corresponds to the 0.6 distance the model was trained around. Lower it to catch more photos (with more wrong ones), raise it for fewer false matches.

Accuracy depends heavily on the photos. Lighting, head pose (profiles in particular), blur, occlusion (sunglasses, masks, hands), small or distant faces, low-resolution thumbnails and age differences all reduce it. Expect missed photos and some false matches, and review the results.

## Permissions and privacy

| Permission | Why |
| --- | --- |
| `sidePanel` | The main interface is a Chrome side panel. |
| `scripting` | Re-injects the page script into a Google Photos tab that was open before the extension was installed or reloaded. |
| `storage` | Remembers two UI preferences: the threshold and whether Diagnostics is expanded. |
| Host `https://photos.google.com/*` | Runs the page script that reads album tile links and scrolls the album; lets the panel see the tab's URL to detect the album and navigation. |
| Host `https://*.googleusercontent.com/*` | Lets the side panel download the thumbnail images the album page displays, so it can run face detection on them. |

Privacy properties:

- No backend, no analytics, no external recognition service. Images, faces and embeddings never leave your browser. The only network requests are to the image URLs the album page itself shows.
- Image requests go out **without cookies** first. Only if the image host refuses (HTTP 401/403) is the request repeated with the browser's normal credentials, the same way the page's own image would load. The extension never reads, extracts or stores cookies or tokens, and it does not call any Google API.
- The reference photo, face embeddings and match previews live in memory only. Embeddings of album faces are discarded right after scoring; only scores (and preview images for candidates above the minimum threshold, up to 1,500) are kept. **Clear session** releases everything, including object URLs and the face worker. Closing the panel does the same.
- Only UI preferences are persisted. No biometric data is stored.
- Page-derived text (album title, photo labels) is always rendered as text, never as HTML.
- The page script only reads the DOM and scrolls the grid. It never clicks anything, so it cannot delete, share or edit photos.
- Diagnostics show counts, sizes and masked URL shapes; they never include images, full links or photo IDs. “Copy report” copies that same redacted information.

## Architecture

```
src/
  adapter/          Google Photos specifics, isolated so they can be updated in one place
    googlePhotosUrls.ts    album/photo URL patterns, canonical links, dedupe keys
    googlePhotosDom.ts     tile discovery, thumbnail URL extraction, scroll container
    googlePhotosImages.ts  image host allow-list, (gated) size-suffix handling
  content/          page script: discovery session (controlled scrolling + MutationObserver capture), diagnostics
  sidepanel/        UI + scan orchestration (ScanController), image fetching, face worker client
  worker/           dedicated Web Worker: Human (BlazeFace + FaceMesh) + dlib ResNet descriptor
  shared/           matching, dedupe registry, scan state machine, stop policy, retry, message types
  background/       minimal MV3 service worker (opens the side panel on toolbar click)
```

The scan runs in the side panel page (alive while the panel is open) and inference runs in a dedicated worker spawned by it, so a long scan never depends on the MV3 service worker staying alive. Discovery uses back-pressure (it pauses scrolling while 60 photos wait to be processed), three concurrent image fetches with bounded retries, one inference queue, and an explicit stop rule (bottom reached with nothing new for three steps, or the page stopped scrolling, or a long run of empty steps, or a hard step cap).

Face pipeline: BlazeFace detects every face (up to 30 per image), FaceMesh landmarks align each face with a similarity transform onto a 150×150 chip, and dlib's ResNet produces a 128-d descriptor. Faces smaller than 28 px are counted but not compared. Inference uses WebGL, falling back to single-threaded WASM, then CPU.

## Known limitations

- **Unverified on real Google Photos.** The DOM, URL, image-host and scrolling assumptions have only been exercised against a simulated album. Run the diagnostics first (below).
- **Thumbnail resolution.** The extension analyses the thumbnail the grid renders. Small faces in group photos may be too small to match. An optional “Use larger images” mode exists, but it is enabled only after the **Test larger images** diagnostic proves on your album that requesting a larger size returns a larger image.
- **Coverage is best effort.** If Google Photos changes how it virtualizes or lazy-loads the grid, some photos may never be seen. The counters and stop reason help spot this.
- **Videos** are analysed via their thumbnail only.
- **Matching quality.** Profile views and strong age differences are frequently missed (see the validation report). The model was trained on adult faces from public datasets and may be less accurate for some groups of people.
- **Speed.** Roughly 0.2–0.5 s per photo in testing, so a 1,000-photo album takes several minutes.
- The scanned tab must stay open and visible on the album grid.

## Troubleshooting

Open **Diagnostics** in the panel; each button isolates one stage.

| Symptom | Check | Meaning |
| --- | --- | --- |
| Panel says “not an album” | URL | The URL must match `/album/<id>` or `/share/<id>`. If your album URL looks different, the URL patterns in `src/adapter/googlePhotosUrls.ts` need updating. |
| 0 discovered | **Check page discovery** | `photoLinksThisAlbum: 0` means tile links were not recognised: a **DOM discovery failure**. |
| Tiles found but no image URL | **Check page discovery** | `tilesWithoutImageUrl` high and `imageHosts` empty: thumbnails are rendered in a way the adapter does not read. |
| Discovery stops early | **Test scrolling** | `newKeysAfterScroll: 0` means programmatic scrolling did not load more tiles; the scroll container guess may be wrong. |
| Many failed photos | **Test image access** | Failures here (HTTP status shown) are **image access failures**. `unsupported-image-host` skips mean images come from a host outside `*.googleusercontent.com`. |
| Few faces found / many “faces too small” | Counters, `smallImages` | **Insufficient image resolution**. Try **Test larger images**. |
| “Face models failed to load” | **Load face models**, event log | **Model initialization failure**; the log lists each backend that was tried and its error. |
| Scan paused by itself | Status line | The tab went to the background or opened a single photo. Go back to the grid and Resume. |

“Copy report” puts a redacted JSON report on the clipboard that is safe to share in an issue.

Without loading the extension, you can run the same discovery and scroll checks by pasting `tools/console-diagnostics.js` (created by `npm run build`) into DevTools on the album grid. It is read-only apart from one scroll that it undoes, and it prints the same redacted report.

## Testing

- `npm test` — 81 unit tests: matching and thresholding, dedupe registry, scan state machine and stop policy, ScanController lifecycle (pause/resume/cancel/interrupt/back-pressure/concurrency/error categories) with fakes, the DOM adapter against synthetic fixtures, controlled scrolling over a simulated virtualized grid, retry policy, face alignment math, preview memory handling.
- `npm run test:browser -- --images <dir>` — launches Chrome for Testing with `dist/` loaded, opens the real side panel through the toolbar action, serves a simulated album at a `photos.google.com` URL via request interception, blocks all other network, and runs 25 checks (discovery under virtualization, image fetching, model loading under the extension CSP, matching, open-original, pause/resume/cancel, navigation interruption, clear session). Add `--expect-backend wasm` after `npm run build -- --backends wasm` to verify the WASM fallback. The image folder needs `ref_*.jpg`, `pos_*.jpg`, `neg_*.jpg`, `noface_*.jpg`; the set used for the report is listed in the validation report. First run: `npx puppeteer browsers install chrome`.
- Real Google Photos: follow [docs/MANUAL_TEST_CHECKLIST.md](docs/MANUAL_TEST_CHECKLIST.md).

## Licenses

Project code: MIT. Bundled third-party code and models: see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
