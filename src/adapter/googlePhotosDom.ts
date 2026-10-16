// DOM discovery for the Google Photos album grid.
//
// This module deliberately avoids Google's generated class names. It relies only on:
//   1. tile links (<a href>) that resolve to <album>/photo/<photoId> URLs (googlePhotosUrls.ts),
//   2. an image URL found on an <img> or a CSS background-image inside (or around) that link,
//   3. a generic "nearest scrollable ancestor" search for the scroll container.
// All three are UNVERIFIED against the live site until the diagnostics confirm them.

import { AlbumRef, canonicalPhotoUrl, isSameAlbum, parseAlbumLocation, photoKey } from './googlePhotosUrls';

export interface DiscoveredPhoto {
  /** Stable dedupe key derived from album identity + photo id (never the thumbnail URL). */
  key: string;
  photoId: string;
  photoUrl: string;
  /** Image URL as rendered by the page at discovery time; may be null while the tile is still loading. */
  thumbnailUrl: string | null;
  /** Page-provided accessible label, if any. Treated as untrusted text. */
  label: string | null;
  /** Rendered tile size in CSS px, for diagnosing resolution problems. */
  displayWidth: number;
  displayHeight: number;
}

export interface CollectResult {
  photos: DiscoveredPhoto[];
  /** Number of <a> elements inspected. */
  anchorsSeen: number;
  /** Photo links that belong to a different album (e.g. suggestions); ignored. */
  otherAlbumLinks: number;
  /** Photo tiles found without any usable image URL yet. */
  withoutThumbnail: number;
}

const MAX_LABEL_LENGTH = 200;

/** Extracts the first url(...) from a CSS background-image value. */
export function extractCssUrl(value: string | null | undefined): string | null {
  if (!value || value === 'none') return null;
  const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
  return m ? m[2] : null;
}

function usableImageUrl(raw: string | null | undefined, baseHref: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, baseHref);
    // data:/blob: placeholders are not fetchable from the extension and are usually spinners.
    if (u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

function imageUrlOf(el: Element, baseHref: string, useComputedStyle: boolean): string | null {
  if (el.tagName === 'IMG') {
    const img = el as HTMLImageElement;
    const fromImg = usableImageUrl(img.currentSrc || img.getAttribute('src'), baseHref);
    if (fromImg) return fromImg;
  }
  const inline = (el as HTMLElement).style?.backgroundImage;
  const fromInline = usableImageUrl(extractCssUrl(inline), baseHref);
  if (fromInline) return fromInline;
  if (useComputedStyle) {
    const view = el.ownerDocument.defaultView;
    const computed = view ? view.getComputedStyle(el).backgroundImage : null;
    return usableImageUrl(extractCssUrl(computed), baseHref);
  }
  return null;
}

function searchSubtree(root: Element, baseHref: string): string | null {
  const candidates = [root, ...Array.from(root.querySelectorAll('img, [style*="background"]'))];
  for (const el of candidates) {
    const url = imageUrlOf(el, baseHref, false);
    if (url) return url;
  }
  // Fall back to computed styles (class-based backgrounds), bounded to keep this cheap.
  const all = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 40)];
  for (const el of all) {
    const url = imageUrlOf(el, baseHref, true);
    if (url) return url;
  }
  return null;
}

/**
 * Finds the image URL for a tile link. Looks inside the link first, then inside the nearest
 * ancestor that wraps exactly one photo link (so we never borrow a neighbouring tile's image).
 */
export function findThumbnailUrl(anchor: Element, baseHref: string): string | null {
  const inside = searchSubtree(anchor, baseHref);
  if (inside) return inside;
  let node: Element | null = anchor.parentElement;
  for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    const links = node.querySelectorAll('a[href*="/photo/"]');
    if (links.length !== 1) break;
    const url = searchSubtree(node, baseHref);
    if (url) return url;
  }
  return null;
}

/** The link target as the browser resolves it (honours <base href>), falling back to the raw attribute. */
function resolvedHref(anchor: Element, baseHref: string): string {
  const resolved = (anchor as HTMLAnchorElement).href;
  if (typeof resolved === 'string' && resolved) return resolved;
  const raw = anchor.getAttribute('href') ?? '';
  try {
    return new URL(raw, baseHref).href;
  } catch {
    return raw;
  }
}

function labelOf(anchor: Element): string | null {
  const raw = anchor.getAttribute('aria-label') ?? anchor.getAttribute('title');
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_LABEL_LENGTH) : null;
}

/** Collects every photo tile of `album` currently present in the DOM under `root`. */
export function collectAlbumPhotos(root: ParentNode, album: AlbumRef, baseHref: string): CollectResult {
  const anchors = Array.from(root.querySelectorAll('a[href]'));
  const byKey = new Map<string, DiscoveredPhoto>();
  let otherAlbumLinks = 0;
  for (const a of anchors) {
    const loc = parseAlbumLocation(resolvedHref(a, baseHref));
    if (!loc || !loc.photoId) continue;
    if (!isSameAlbum(loc.album, album)) {
      otherAlbumLinks++;
      continue;
    }
    const key = photoKey(album, loc.photoId);
    const thumbnailUrl = findThumbnailUrl(a, baseHref);
    const existing = byKey.get(key);
    if (existing && existing.thumbnailUrl) continue;
    const rect = a.getBoundingClientRect();
    byKey.set(key, {
      key,
      photoId: loc.photoId,
      photoUrl: canonicalPhotoUrl(album, loc.photoId),
      thumbnailUrl,
      label: labelOf(a),
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
    });
  }
  const photos = Array.from(byKey.values());
  return {
    photos,
    anchorsSeen: anchors.length,
    otherAlbumLinks,
    withoutThumbnail: photos.filter((p) => !p.thumbnailUrl).length,
  };
}

function isScrollable(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const oy = view.getComputedStyle(el).overflowY;
  return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 8;
}

/** Nearest scrollable ancestor of a tile, else the document scroller. */
export function findScrollContainer(doc: Document, sample: Element | null): Element {
  for (let node = sample?.parentElement ?? null; node; node = node.parentElement) {
    if (node === doc.body || node === doc.documentElement) break;
    if (isScrollable(node)) return node;
  }
  return doc.scrollingElement ?? doc.documentElement;
}

/** First tile link for the album, used to locate the grid. */
export function findFirstTile(root: ParentNode, album: AlbumRef, baseHref: string): Element | null {
  for (const a of Array.from(root.querySelectorAll('a[href*="/photo/"]'))) {
    const loc = parseAlbumLocation(resolvedHref(a, baseHref));
    if (loc?.photoId && isSameAlbum(loc.album, album)) return a;
  }
  return null;
}

/** Best-effort album title. Page text is untrusted and must be rendered with textContent. */
export function readAlbumTitle(doc: Document): string | null {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const raw = og || doc.title || '';
  const clean = raw.replace(/\s*[-–]\s*Google Photos\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (!clean || /^Google Photos$/i.test(clean)) return null;
  return clean.slice(0, MAX_LABEL_LENGTH);
}
