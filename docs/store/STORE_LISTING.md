# Chrome Web Store submission texts (v0.2.0)

Copy each block into the matching field of the Developer Dashboard. Items in **[brackets]** are yours to fill in.

---

## Store listing tab

### Name

```
Album Person Finder
```

### Summary (max 132 characters)

```
Find photos of a person in the Google Photos album you have open. Face matching runs on your device; nothing is uploaded.
```

### Description

```
Looking for every photo of one person in a big shared album? Album Person Finder scans the Google Photos album you have open and lists the photos that person appears in, including group photos.

HOW IT WORKS
1. Open an album on photos.google.com.
2. Click the extension icon to open the side panel.
3. Upload a clear photo of the person. If it shows several people, pick the face to search for.
4. Click "Find in this album". The extension scrolls through the album for you and checks every photo it can see.
5. Matches appear as they are found, best first. Click one to open that photo in Google Photos.

Choose Strict, Balanced or Loose matching to show fewer or more candidates. Results update instantly, without rescanning. You can pause, resume or cancel a scan at any time.

PRIVATE BY DESIGN
• Face detection and matching run entirely in your browser. Your photos, the reference photo and face data are never uploaded anywhere.
• No account, no server, no analytics, no ads.
• Face data is kept in memory only and is deleted when you click "Clear session" or close the panel.
• The extension only reads the album page and scrolls it. It never clicks anything in Google Photos, so it cannot delete, share or edit your photos.

GOOD TO KNOW
• Matching is approximate. Side views, faces looking down, sunglasses, masks, blur, small faces and large age differences can cause missed photos or wrong matches, so please review the results.
• Keep the album tab open and visible while scanning.
• Google Photos does not report how many photos an album has, so a finished scan is described as "best effort".
• Works with albums you own and shared albums you can open.

Album Person Finder is an independent project and is not affiliated with, endorsed by, or sponsored by Google. Google Photos is a trademark of Google LLC.
```

### Category

```
Productivity → Tools
```

(Lifestyle → Art & Design would also fit.)

### Language

```
English
```

### Graphics

| Asset | Requirement | Source |
| --- | --- | --- |
| Store icon | 128×128 PNG | `static/icons/icon128.png` |
| Screenshots | At least 1, 1280×800 or 640×400 | Take them yourself: an album with the side panel open showing results |
| Small promo tile (optional) | 440×280 | Not created |

Screenshots will show faces. Use photos of yourself, of people who agreed to it, or public-domain photos (for example the NASA set from `npm run fetch-test-images`) in an album you own.

### Support / homepage (optional)

```
[your support page or email, e.g. a GitHub repository URL]
```

---

## Privacy practices tab

### Single purpose description

```
Find the photos that contain a chosen person within the Google Photos album the user has open, by comparing faces on the user's device against a reference photo the user provides.
```

### Permission justifications

**sidePanel**

```
The extension's entire user interface (reference photo upload, scan controls, progress and results) is a Chrome side panel shown next to the user's Google Photos album.
```

**scripting**

```
Used only to inject the extension's own bundled content script into a photos.google.com tab that was already open before the extension was installed or updated, so the user does not have to reload the album. No remote or dynamically generated code is injected.
```

**storage**

```
Stores three user interface preferences locally (chrome.storage.local): the chosen matching setting, whether the diagnostics section is expanded, and whether to use larger images. No photos, face data or personal data are stored.
```

**Host permission: https://photos.google.com/***

```
The content script runs on Google Photos album pages to read the album's photo links and thumbnails that are already displayed to the user, and to scroll the album so more photos load. It also lets the side panel detect which album is open and stop a scan if the user navigates away. It never clicks controls, so it cannot change, delete or share photos.
```

**Host permission: https://*.googleusercontent.com/***

```
Google Photos displays album thumbnails from googleusercontent.com. The side panel downloads those same images (or larger versions of the same images) so it can run face detection and matching locally in the browser. Requests are made without cookies first. The images are processed in memory and are never uploaded or stored.
```

### Are you using remote code?

```
No, I am not using remote code.
```

Justification, if asked:

```
All JavaScript, WebAssembly and machine-learning model files are bundled in the extension package. Nothing is loaded from a CDN or server at runtime.
```

### Data usage

**What user data does this item collect or use?** Tick:

- [x] **Website content** (the album images it reads to find faces)

Leave the other categories unticked: personally identifiable information, health, financial, authentication, personal communications, location, web history and user activity.

Face-matching data is biometric. The form has no separate biometric box, and the face data never leaves the device, but say so explicitly in the privacy policy (already included in `PRIVACY_POLICY.md`). If a reviewer asks, it is reasonable to also tick **Personally identifiable information**. Being over-transparent is safer than under-declaring.

**Certify all three:**

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
[public URL where you host docs/store/PRIVACY_POLICY.md]
```

---

## Distribution tab

- Visibility: start with **Unlisted** (only people with the link can find it), then switch to Public once you are happy.
- Regions: all regions, unless you want to limit it.

## Before each submission

1. Bump `"version"` in `package.json` (the store rejects a version it has already seen).
2. Run `npm run package`, then upload `album-person-finder-<version>.zip`.
3. If you changed permissions, data handling or network access, update these texts and the privacy policy first.
