# Manual test checklist: real Google Photos album

Use a **test album** you own, ideally 30–200 photos, with:

- several photos of one person alone, at different angles;
- several group photos that include that person;
- photos of other people only, and a few with no people.

Note the album's approximate photo count before you start. Record results in the "Result" column, and paste the redacted report from **Diagnostics → Copy report** for anything that fails.

## Setup

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 1 | `npm ci && npm run fetch-models && npm run build`, load `dist/` via `chrome://extensions` → Load unpacked | Extension loads with no errors on the card | |
| 2 | Open the album grid, click the toolbar icon | Side panel opens; Album card shows "Album: <title>" (or "Shared album") | |
| 3 | Open a non-album page (e.g. photos.google.com home) | Panel says the page is not an album; Find is disabled | |

## Feasibility diagnostics (do these first)

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 4 | Diagnostics → **Check page discovery** | `photoLinksThisAlbum` > 0, `tilesWithImageUrl` > 0, `imageHosts` lists a `*.googleusercontent.com` host | |
| 5 | Same report | `photoLinksOtherAlbums` small/zero; `scroll.container` is plausible; `sizeSuffixObserved` noted | |
| 6 | **Test scrolling** | `newKeysAfterScroll` > 0; `restored: true`; page is back where it was | |
| 7 | **Test image access** | All 3 samples `ok`; note `mode` (`omit` or `include`) and decoded sizes | |
| 8 | **Test larger images** | Either "verified" (decoded sizes grow) or "not verified" with a reason. Either is acceptable; record which. The same check runs automatically before each scan | |
| 9 | **Load face models** | "Face models ready (webgl)" (or `wasm`) | |

If 4, 6 or 7 fail, stop and file the report: the scan cannot work until the adapter is updated.

## Reference photo

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 10 | Upload a landscape/object photo with no people | "No face was found…" message; Find stays disabled | |
| 11 | Upload a group photo | "Found N faces. Choose…" with face crops; Find disabled until one is chosen | |
| 12 | Choose the person's face | Box highlighted green; "Face selected. Ready to search." | |
| 13 | Upload a clear single-face photo of the person | "One face found. Ready to search." | |

## Scan

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 14 | Click **Find in this album**, keep the tab visible | Brief "Checking whether this album provides larger images…", then the album scrolls by itself; counters rise; matches appear sorted by score | |
| 15 | Wait for the end | "Scan ended (best effort)" with a reason; page scroll restored | |
| 16 | Compare **Discovered** with the known photo count | Equal or close. Record the difference | |
| 17 | Check **Skipped** / **Failed** | Zero or explained (Diagnostics shows reasons/categories) | |
| 18 | Check results at the default threshold | Most solo photos of the person present; note misses and false matches | |
| 19 | Check group photos | Group photos containing the person present; preview (⤢) outlines the right face | |
| 20 | Switch Matching between Strict, Balanced and Loose (and try the Advanced slider) | Results update immediately; Strict shows the fewest, Loose the most; scores never shown as percentages | |
| 21 | Click a result thumbnail | The correct photo opens in a new tab | |

## Controls and safety

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 22 | Start, then **Pause** | Status "Paused"; counters stop after in-flight photos finish; scrolling stops | |
| 23 | **Resume** | Scan continues; no duplicate photos (Discovered does not jump unexpectedly) | |
| 24 | Start, then **Cancel** | "Scan canceled"; results so far stay; scroll restored | |
| 25 | Start, then switch to another tab | Scan pauses with a "background" notice; Resume returns to the album tab | |
| 26 | Start, then click a photo in the album (single-photo view) | Scan pauses with a "single photo" notice; going back + Resume continues | |
| 27 | Start, then open a different album in the same tab | "Scan stopped: the tab moved…" | |
| 28 | Start, then close the album tab | "Scan stopped: the album tab was closed." | |
| 29 | After all of the above, inspect the album | No photos deleted, moved, shared, or edited; album unchanged | |
| 30 | **Clear session** | Reference, results and counters cleared | |
| 31 | Reopen the panel later | Threshold remembered; no reference photo or results restored | |

## Privacy spot checks

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 32 | DevTools on the side panel (right-click panel → Inspect) → Network during a scan | Requests only to `chrome-extension://…` and the album's image host; nothing else | |
| 33 | `chrome://extensions` → extension → "Inspect views" → Application → Storage | Only `threshold.sface`, `diagnosticsOpen`, `useLargerImages` in `chrome.storage.local`; no IndexedDB data | |
| 34 | Copy report and read it | No full image URLs, no photo IDs, no image data | |
