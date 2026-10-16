"use strict";
(() => {
  // src/adapter/googlePhotosUrls.ts
  var GOOGLE_PHOTOS_ORIGIN = "https://photos.google.com";
  var PATH_RE = /^(?:\/u\/(\d+))?\/(album|share)\/([A-Za-z0-9_-]+)(?:\/photo\/([A-Za-z0-9_-]+))?\/?$/;
  function parseAlbumLocation(href, base) {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "photos.google.com") return null;
    const m = PATH_RE.exec(url.pathname);
    if (!m) return null;
    return {
      album: {
        kind: m[2],
        albumId: m[3],
        userIndex: m[1] ?? null,
        shareKey: url.searchParams.get("key")
      },
      photoId: m[4] ?? null
    };
  }
  function albumIdentity(album) {
    return `${album.kind}:${album.albumId}`;
  }
  function isSameAlbum(a, b) {
    return !!a && !!b && albumIdentity(a) === albumIdentity(b);
  }
  function prefix(album) {
    return album.userIndex !== null ? `/u/${album.userIndex}` : "";
  }
  function suffix(album) {
    return album.shareKey ? `?key=${encodeURIComponent(album.shareKey)}` : "";
  }
  function canonicalPhotoUrl(album, photoId) {
    return `${GOOGLE_PHOTOS_ORIGIN}${prefix(album)}/${album.kind}/${album.albumId}/photo/${photoId}${suffix(album)}`;
  }
  function photoKey(album, photoId) {
    return `${albumIdentity(album)}/${photoId}`;
  }

  // src/adapter/googlePhotosDom.ts
  var MAX_LABEL_LENGTH = 200;
  function extractCssUrl(value) {
    if (!value || value === "none") return null;
    const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
    return m ? m[2] : null;
  }
  function usableImageUrl(raw, baseHref) {
    if (!raw) return null;
    try {
      const u = new URL(raw, baseHref);
      if (u.protocol !== "https:") return null;
      return u.href;
    } catch {
      return null;
    }
  }
  function imageUrlOf(el, baseHref, useComputedStyle) {
    if (el.tagName === "IMG") {
      const img = el;
      const fromImg = usableImageUrl(img.currentSrc || img.getAttribute("src"), baseHref);
      if (fromImg) return fromImg;
    }
    const inline = el.style?.backgroundImage;
    const fromInline = usableImageUrl(extractCssUrl(inline), baseHref);
    if (fromInline) return fromInline;
    if (useComputedStyle) {
      const view = el.ownerDocument.defaultView;
      const computed = view ? view.getComputedStyle(el).backgroundImage : null;
      return usableImageUrl(extractCssUrl(computed), baseHref);
    }
    return null;
  }
  function searchSubtree(root, baseHref) {
    const candidates = [root, ...Array.from(root.querySelectorAll('img, [style*="background"]'))];
    for (const el of candidates) {
      const url = imageUrlOf(el, baseHref, false);
      if (url) return url;
    }
    const all = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 40)];
    for (const el of all) {
      const url = imageUrlOf(el, baseHref, true);
      if (url) return url;
    }
    return null;
  }
  function findThumbnailUrl(anchor, baseHref) {
    const inside = searchSubtree(anchor, baseHref);
    if (inside) return inside;
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const links = node.querySelectorAll('a[href*="/photo/"]');
      if (links.length !== 1) break;
      const url = searchSubtree(node, baseHref);
      if (url) return url;
    }
    return null;
  }
  function resolvedHref(anchor, baseHref) {
    const resolved = anchor.href;
    if (typeof resolved === "string" && resolved) return resolved;
    const raw = anchor.getAttribute("href") ?? "";
    try {
      return new URL(raw, baseHref).href;
    } catch {
      return raw;
    }
  }
  function labelOf(anchor) {
    const raw = anchor.getAttribute("aria-label") ?? anchor.getAttribute("title");
    if (!raw) return null;
    const clean = raw.replace(/\s+/g, " ").trim();
    return clean ? clean.slice(0, MAX_LABEL_LENGTH) : null;
  }
  function collectAlbumPhotos(root, album, baseHref) {
    const anchors = Array.from(root.querySelectorAll("a[href]"));
    const byKey = /* @__PURE__ */ new Map();
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
        displayHeight: Math.round(rect.height)
      });
    }
    const photos = Array.from(byKey.values());
    return {
      photos,
      anchorsSeen: anchors.length,
      otherAlbumLinks,
      withoutThumbnail: photos.filter((p) => !p.thumbnailUrl).length
    };
  }
  function isScrollable(el) {
    const view = el.ownerDocument.defaultView;
    if (!view) return false;
    const oy = view.getComputedStyle(el).overflowY;
    return (oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 8;
  }
  function findScrollContainer(doc, sample) {
    for (let node = sample?.parentElement ?? null; node; node = node.parentElement) {
      if (node === doc.body || node === doc.documentElement) break;
      if (isScrollable(node)) return node;
    }
    return doc.scrollingElement ?? doc.documentElement;
  }
  function findFirstTile(root, album, baseHref) {
    for (const a of Array.from(root.querySelectorAll('a[href*="/photo/"]'))) {
      const loc = parseAlbumLocation(resolvedHref(a, baseHref));
      if (loc?.photoId && isSameAlbum(loc.album, album)) return a;
    }
    return null;
  }
  function readAlbumTitle(doc) {
    const og = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const raw = og || doc.title || "";
    const clean = raw.replace(/\s*[-–]\s*Google Photos\s*$/i, "").replace(/\s+/g, " ").trim();
    if (!clean || /^Google Photos$/i.test(clean)) return null;
    return clean.slice(0, MAX_LABEL_LENGTH);
  }

  // src/content/discoverySession.ts
  function waitForQuiet(root, quietMs, maxMs) {
    return new Promise((resolve) => {
      let quietTimer;
      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style", "href"] });
      quietTimer = setTimeout(finish, quietMs);
      const maxTimer = setTimeout(finish, maxMs);
    });
  }

  // src/content/domDiagnostics.ts
  var SIZE_SUFFIX_RE = /=w\d+-h\d+/;
  function maskImageUrl(raw) {
    try {
      const u = new URL(raw);
      const path = u.pathname.split("/").map((seg) => {
        const m = /^([^=]*)(=.*)?$/.exec(seg);
        const base = m?.[1] ?? seg;
        const tail = m?.[2] ?? "";
        return (base.length > 12 ? `<${base.length} chars>` : base) + tail;
      }).join("/");
      const params = Array.from(u.searchParams.keys());
      return `${u.protocol}//${u.host}${path}${params.length ? "?" + params.join("&") : ""}`;
    } catch {
      return "<unparseable>";
    }
  }
  function describe(el) {
    if (el === el.ownerDocument.scrollingElement || el === el.ownerDocument.documentElement) return "document";
    const role = el.getAttribute("role");
    return `<${el.tagName.toLowerCase()}${role ? ` role="${role}"` : ""}>`;
  }
  function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }
  function diagnoseDom(doc, href, dpr) {
    const loc = parseAlbumLocation(href);
    const anchorsTotal = doc.querySelectorAll("a[href]").length;
    const scroller = findScrollContainer(doc, loc ? findFirstTile(doc, loc.album, href) : null);
    const base = {
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
        isDocumentScroller: scroller === (doc.scrollingElement ?? doc.documentElement)
      },
      sampleTiles: []
    };
    if (!loc) return base;
    const res = collectAlbumPhotos(doc, loc.album, href);
    base.photoLinksThisAlbum = res.photos.length;
    base.photoLinksOtherAlbums = res.otherAlbumLinks;
    base.tilesWithoutImageUrl = res.withoutThumbnail;
    base.tilesWithImageUrl = res.photos.length - res.withoutThumbnail;
    const shapes = /* @__PURE__ */ new Set();
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
        medianH: median(heights)
      };
    }
    base.sampleTiles = res.photos.slice(0, 5).map((p, index) => ({
      index,
      hasImage: !!p.thumbnailUrl,
      w: p.displayWidth,
      h: p.displayHeight
    }));
    return base;
  }
  async function scrollProbe(doc, href) {
    const loc = parseAlbumLocation(href);
    const scroller = findScrollContainer(doc, loc ? findFirstTile(doc, loc.album, href) : null);
    const keysNow = () => loc ? collectAlbumPhotos(doc, loc.album, href).photos.map((p) => p.key) : [];
    const beforeKeys = new Set(keysNow());
    const before = { scrollTop: Math.round(scroller.scrollTop), tiles: beforeKeys.size, keys: beforeKeys.size };
    const start = scroller.scrollTop;
    scroller.scrollTop = start + Math.max(200, scroller.clientHeight * 1.5);
    await waitForQuiet(doc.body ?? doc.documentElement, 400, 3e3);
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
      restored: Math.abs(scroller.scrollTop - start) < 2
    };
  }

  // scripts/eval/consoleDiagnostics.ts
  (async () => {
    const dom = diagnoseDom(document, location.href, window.devicePixelRatio);
    const scroll = dom.url.isAlbum ? await scrollProbe(document, location.href) : null;
    const report = { generatedBy: "Album Person Finder console diagnostics", dom, scroll };
    console.log("[Album Person Finder] diagnostics report:\n" + JSON.stringify(report, null, 2));
  })();
})();
