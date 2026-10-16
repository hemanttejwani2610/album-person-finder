# Privacy Policy: Album Person Finder

_Last updated: [date you publish]_

Album Person Finder ("the extension") is a Chrome extension that helps you find photos of a person in a Google Photos album you have open. This policy explains what data the extension handles and what it does with it.

**In short:** everything happens on your own device. The extension has no server, does not collect your data, and does not send your photos, face data or any other personal information to anyone, including the developer.

## What the extension handles, and how

### Your reference photo

You choose a photo of the person you want to find. The extension opens it in your browser, finds the faces in it, and computes a face embedding: a list of 128 numbers describing a face, used to compare faces. The photo and the embedding stay in your browser's memory. They are never uploaded or written to disk.

### Album photos

While you run a scan, the extension reads the album page you have open in Google Photos: the links to each photo and the thumbnail images Google Photos already shows you. To analyse the photos, the extension downloads those thumbnail images, or larger versions of the same images, directly from Google's image servers (googleusercontent.com), the same place your browser loads them from when you view the album. It first requests them without cookies. Only if Google's server refuses does it repeat the request the way the page itself would. The extension never reads, stores or sends your cookies or account credentials.

Each image is analysed in your browser. The extension detects faces, computes an embedding for each face, and compares it with your reference face. The embeddings of album faces are discarded immediately after comparison. For photos that look like possible matches, the extension keeps the downloaded image (as a preview) and a similarity score in memory so it can show you the results. Nothing is uploaded.

### Face data (biometric information)

Face embeddings can identify a person and are treated as biometric data. The extension creates them only on your device, only for the purpose you start (finding a person in the album you have open), keeps them only in memory, and never transmits, sells or shares them.

### Settings

The extension stores three settings in Chrome's local extension storage, so they are remembered next time:

- your matching setting (Strict, Balanced, Loose or a custom threshold),
- whether the Diagnostics section is expanded,
- whether to use larger images when available.

These settings contain no personal information.

## What the extension does not do

- It does not upload photos, faces, face data or results anywhere.
- It does not use analytics, tracking, advertising or third-party services.
- It does not store photos or face data on disk.
- It does not read or change anything in your Google account. It never clicks controls in Google Photos, so it cannot delete, share, edit or move photos.
- It does not load code from the internet. All code and face-recognition models are included in the extension.

## How long data is kept

The reference photo, face data, previews and results are kept in memory only while the side panel is open. They are deleted when you click **Clear session**, close the side panel, or close the browser. The three settings remain until you change them or remove the extension.

## Diagnostics reports

The panel's optional **Copy report** button copies a technical summary to your clipboard so you can share it if you need help. It contains the album's title, your browser version, counts, sizes, timing and masked URL shapes, and no images, photo identifiers or full links. Nothing is sent automatically; you decide whether to share it.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| Side panel | Shows the extension's interface next to the album. |
| Scripting | Adds the extension's own page script to a Google Photos tab that was already open. |
| Storage | Saves the three settings listed above. |
| Access to photos.google.com | Reads the album's photo links and thumbnails and scrolls the album. |
| Access to googleusercontent.com | Downloads the album's images so faces can be analysed on your device. |

## Children

The extension is not directed to children and does not knowingly handle data about them beyond the photos a user chooses to scan on their own device.

## Responsibility when scanning other people's photos

Only use the extension on albums you are allowed to view, and respect the privacy of the people in them. Local laws may limit identifying people from photos without their consent.

## Changes to this policy

If the extension's data handling changes, this policy will be updated before the new version is published, and the "Last updated" date will change.

## Contact

Questions about this policy: **[your contact email]**

Album Person Finder is an independent project and is not affiliated with Google. Google Photos is a trademark of Google LLC.
