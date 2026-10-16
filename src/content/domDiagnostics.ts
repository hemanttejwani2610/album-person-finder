// Read-only DOM diagnostics. Never returns full image URLs, photo ids or page text beyond the
// album title: URLs are reduced to their shape with long path tokens masked.
import { collectAlbumPhotos, findFirstTile, findScrollContainer, readAlbumTitle } from '../adapter/googlePhotosDom';
import { parseAlbumLocation } from '../adapter/googlePhotosUrls';
import type { DomDiagnostics, ScrollProbeResult } from '../shared/messages';
import { waitForQuiet } from './discoverySession';

const SIZE_SUFFIX_RE = /=w\d+-h\d+/;

/** "https://host/<token:180>=w320-h240-no?authuser" style shape, safe to show. */
export function maskImageUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .split('/')
      .map((seg) => {
        const m = /^([^=]*)(=.*)?$/.exec(seg);
        const base = m?.[1] ?? seg;
        const tail = m?.[2] ?? '';
        return (base.length > 12 ? `<${base.length} chars>` : base) + tail;
      })
      .join('/');
    const params = Array.from(u.searchParams.keys());
    return `${u.protocol}//${u.host}${path}${params.length ? '?' + params.join('&') : ''}`;
  } catch {
    return '<unparseable>';
  }
}

function describe(el: Element): string {
  if (el === el.ownerDocument.scrollingElement || el === el.ownerDocument.documentElement) return 'document';
  const role = el.getAttribute('role');
  return `<${el.tagName.toLowerCase()}${role ? ` role="${role}"` : ''}>`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

export function diagnoseDom(doc: Document, href: string, dpr: number): DomDiagnostics {
  const loc = parseAlbumLocation(href);
  const anchorsTotal = doc.querySelectorAll('a[href]').length;
  const scroller = findScrollContainer(doc, loc ? findFirstTile(doc, loc.album, href) : null);
  const base: DomDiagnostics = {
    url: { isAlbum: !!loc, kind: loc?.album.kind ?? null, isPhotoView: !!loc?.photoId },
    title: readAlbumTitle(doc),
    anchorsTotal,
    photoLinksThisAlbum: 0,
    photoLinksOtherAlbums: 0,
    tilesWithImageUrl: 0,
    tilesWithoutImageUrl: 0,
    imageHosts: {},
    sampleImageUrlShapes: [],
    sizeSuffixObserved: 0,
    tileDisplaySizes: null,
    devicePixelRatio: dpr,
    scroll: {
      container: describe(scroller),
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: Math.round(scroller.scrollHeight),
      clientHeight: Math.round(scroller.clientHeight),
      isDocumentScroller: scroller === (doc.scrollingElement ?? doc.documentElement),
    },
    sampleTiles: [],
  };
  if (!loc) return base;
  const res = collectAlbumPhotos(doc, loc.album, href);
  base.photoLinksThisAlbum = res.photos.length;
  base.photoLinksOtherAlbums = res.otherAlbumLinks;
  base.tilesWithoutImageUrl = res.withoutThumbnail;
  base.tilesWithImageUrl = res.photos.length - res.withoutThumbnail;
  const shapes = new Set<string>();
  for (const p of res.photos) {
    if (!p.thumbnailUrl) continue;
    const host = new URL(p.thumbnailUrl).host;
    base.imageHosts[host] = (base.imageHosts[host] ?? 0) + 1;
    if (SIZE_SUFFIX_RE.test(p.thumbnailUrl)) base.sizeSuffixObserved++;
    if (shapes.size < 3) shapes.add(maskImageUrl(p.thumbnailUrl));
  }
  base.sampleImageUrlShapes = Array.from(shapes);
  const widths = res.photos.map((p) => p.displayWidth).filter((w) => w > 0);
  const heights = res.photos.map((p) => p.displayHeight).filter((h) => h > 0);
  if (widths.length) {
    base.tileDisplaySizes = {
      minW: Math.min(...widths),
      maxW: Math.max(...widths),
      medianW: median(widths),
      medianH: median(heights),
    };
  }
  base.sampleTiles = res.photos.slice(0, 5).map((p, index) => ({
    index,
    hasImage: !!p.thumbnailUrl,
    w: p.displayWidth,
    h: p.displayHeight,
  }));
  return base;
}

/** Scrolls one step, records what changed, and scrolls back. Read-only apart from scrolling. */
export async function scrollProbe(doc: Document, href: string): Promise<ScrollProbeResult> {
  const loc = parseAlbumLocation(href);
  const scroller = findScrollContainer(doc, loc ? findFirstTile(doc, loc.album, href) : null);
  const keysNow = () => (loc ? collectAlbumPhotos(doc, loc.album, href).photos.map((p) => p.key) : []);
  const beforeKeys = new Set(keysNow());
  const before = { scrollTop: Math.round(scroller.scrollTop), tiles: beforeKeys.size, keys: beforeKeys.size };
  const start = scroller.scrollTop;
  scroller.scrollTop = start + Math.max(200, scroller.clientHeight * 1.5);
  await waitForQuiet(doc.body ?? doc.documentElement, 400, 3000);
  const afterKeys = new Set(keysNow());
  const after = { scrollTop: Math.round(scroller.scrollTop), tiles: afterKeys.size, keys: afterKeys.size };
  let newKeys = 0;
  for (const k of afterKeys) if (!beforeKeys.has(k)) newKeys++;
  let left = 0;
  for (const k of beforeKeys) if (!afterKeys.has(k)) left++;
  scroller.scrollTop = start;
  return {
    container: describe(scroller),
    before,
    after,
    newKeysAfterScroll: newKeys,
    keysThatLeftDom: left,
    restored: Math.abs(scroller.scrollTop - start) < 2,
  };
}
