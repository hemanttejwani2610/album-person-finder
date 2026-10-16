# Feasibility: scanning an open Google Photos album

## What could be checked, and what could not

The feasibility questions require a live, signed-in Google Photos album. During development:

- The desktop app's built-in browser was **not signed in** to Google (photos.google.com redirected to the Google sign-in page).
- Claude in Chrome (to inspect an album in your own Chrome) was **not connected** on three attempts.

So no live Google Photos page was inspected during development. **Update (v0.2.0):** a user scan of a real shared album later confirmed questions 1–4 end to end. See section 7 of [VALIDATION_REPORT.md](VALIDATION_REPORT.md). The user also reported that the matches, the photo count and opening a result were all correct. Personal (non-shared) albums have not been tried yet. Every Google-Photos-specific behaviour below is an **assumption**, implemented in a way that tolerates variation, isolated in `src/adapter/`, and paired with an in-extension diagnostic that verifies or refutes it on your album. Nothing here claims a successful test against Google Photos.

The extension-side mechanics that do not depend on Google's markup *were* verified in a real Chrome (Chrome for Testing 155, extension loaded from `dist/`) against a simulated album page. See [VALIDATION_REPORT.md](VALIDATION_REPORT.md).

## The five questions

### 1. Discovering photo links and thumbnails from the rendered page

| | |
| --- | --- |
| Assumption | Album grid tiles are `<a>` elements whose (resolved) `href` is `…/album/<albumId>/photo/<photoId>` (or `…/share/<albumId>/photo/<photoId>` for shared albums). Each tile renders its thumbnail as an `<img>` or a CSS `background-image` inside the link or in a wrapper that contains only that link. |
| Why this design | It relies on link targets and standard rendering, not Google's generated class names, which change frequently. No selectors were invented: the only selectors used are `a[href]`, `img`, and inline/computed `background-image`. |
| Where | `src/adapter/googlePhotosUrls.ts`, `src/adapter/googlePhotosDom.ts` |
| Verified | Against synthetic fixtures (unit tests) and a simulated album in real Chrome. |
| Unverified | Whether Google Photos actually uses these link shapes and thumbnail rendering. |
| Diagnostic | **Check page discovery**: `photoLinksThisAlbum`, `photoLinksOtherAlbums`, `tilesWithImageUrl`, `tilesWithoutImageUrl`, `imageHosts`, masked `sampleImageUrlShapes`. Zero tile links ⇒ DOM discovery failure. |

### 2. Scrolling and virtualized rendering

| | |
| --- | --- |
| Assumption | The grid lazily loads tiles while scrolling and may remove off-screen tiles. Setting `scrollTop` on the nearest scrollable ancestor of a tile (or the document scroller) triggers that loading. |
| Design | The content script scrolls ~0.8 viewport per step, waits for the DOM to go quiet (350 ms quiet, 2.5 s max), and also runs a MutationObserver so tiles that appear and disappear between steps are still captured. Photos are recorded the moment they are seen, so later unmounting does not lose them. Dedupe uses `album identity + photo id` from the link, never the thumbnail URL. A tile first seen without an image URL is re-reported once its image appears. |
| Stop rule | Bottom reached with nothing new for 3 steps; or no scrolling and nothing new for 6 steps; or 30 scrolled steps with nothing new; or 5,000 steps. Always reported as "scan ended (best effort)". |
| Verified | On a simulated virtualized grid (tiles unmounted off-screen, thumbnails arriving late) in jsdom and in real Chrome: all 48 photos discovered, each once, scroll position restored. |
| Unverified | Google Photos' real scroll container and whether programmatic scrolling triggers its loader. |
| Diagnostic | **Test scrolling**: scrolls 1.5 screens, reports how many new tiles appeared and how many left the DOM (evidence of virtualization), then scrolls back. `newKeysAfterScroll: 0` ⇒ scrolling does not load more tiles. |

### 3. Getting image bytes for face detection

| | |
| --- | --- |
| Approach | The side panel (an extension page with host permission for `*.googleusercontent.com`) fetches the exact image URL the page rendered. Extension pages with host permission are not subject to CORS, so the bytes can be decoded with `createImageBitmap` and sent to the face worker. Requests omit cookies; only on 401/403 are they retried with the browser's normal credentials. No cookies or tokens are read by the extension, and no Google API is called. |
| Alternatives rejected | Drawing the page's own `<img>` onto a canvas in the content script (cross-origin canvases are tainted); screenshots via `captureVisibleTab` (only the visible viewport, rate-limited, lower quality). |
| Verified | In real Chrome, the side panel fetched and decoded thumbnails served at an `lh3.googleusercontent.com` URL (intercepted), with cookies omitted. |
| Unverified | Whether Google Photos' thumbnail URLs are served from `*.googleusercontent.com`, and whether they load without cookies or need them. |
| Diagnostic | **Test image access**: fetches 3 tile images; reports HTTP status / credential mode used / content type / bytes / decoded size. During scans the same stats are kept (`imageAccess` in the report). Images from other hosts are skipped as `unsupported-image-host` and their host is shown. |

### 4. Higher-resolution images

| | |
| --- | --- |
| Assumption | Thumbnail URLs end with a size suffix like `=w300-h200-…` and the server returns other sizes when the suffix changes. This is a widely seen convention but was **not observed** here, so it is **not used by default**. |
| Design | Before each scan (and from the **Test larger images** button), the extension requests a variant with a 1,024 px long edge for 3 of the album's tiles and compares decoded sizes. Only if all samples come back larger does that scan use larger images; otherwise it uses the exact URLs the page rendered. During a scan, a failed larger variant falls back to the observed URL. The behaviour can be switched off in Diagnostics. |
| Verified | The gating logic, in real Chrome against a simulated server that does honour sizes. |
| Unverified | Google's behaviour. |
| Evidence that it matters | On the 46-photo benchmark, going from 512 px to 1,024 px images raised the share of a person's photos found with zero wrong matches from 77 % to 85 % (SFace), the largest single improvement measured. |

### 5. Linking results back to the photo

| | |
| --- | --- |
| Approach | Each result keeps the canonical photo URL built from the album reference and the photo id seen in the tile link (`https://photos.google.com[/u/N]/album/<id>/photo/<photoId>`, plus `?key=` for shared links). Clicking a result opens it in a new tab. |
| Verified | In real Chrome against the simulated album: clicking a result opened `…/album/FIXTUREALBUM1/photo/P0xx`. |
| Unverified | That Google Photos opens a photo from that URL (expected, since it is the URL the tile link pointed to). |
| Manual check | Checklist item "Open original". |

## If direct scanning turns out to be blocked

The diagnostics are designed to name the failing step: DOM discovery (no tile links / no image URLs), scrolling (no new tiles), image access (HTTP status per sample), resolution (faces too small / larger-image probe), or model initialization (per-backend errors). Adapter changes are confined to `src/adapter/` (URL patterns, tile/thumbnail discovery, image-host rules) and `src/content/discoverySession.ts` (scrolling strategy).
