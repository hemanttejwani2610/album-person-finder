// Image URL handling for Google Photos thumbnails.
//
// UNVERIFIED ASSUMPTION: thumbnail URLs served from *.googleusercontent.com end with a size
// suffix such as "=w320-h240-no" and the server honours other sizes. This is NOT relied on by
// default. The extension only uses a resized URL after the in-panel "resolution probe" has shown,
// on the user's own album and in the current session, that the resized URL actually returns a
// larger decodable image. Otherwise the exact URL observed in the page is used.

const SIZE_RE = /=w(\d+)-h(\d+)([^/?#]*)/;

/** Hosts the extension is allowed to fetch from (must match manifest host_permissions). */
export function isAllowedImageHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'googleusercontent.com' || u.hostname.endsWith('.googleusercontent.com'));
  } catch {
    return false;
  }
}

export function parseSizeSuffix(url: string): { w: number; h: number } | null {
  const m = SIZE_RE.exec(url);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/**
 * Returns the URL with its size suffix scaled so the longer side is `longEdge`, keeping the aspect
 * ratio and any trailing options. Returns null if the URL has no recognisable size suffix or if
 * it would not get larger.
 */
export function withLongEdge(url: string, longEdge: number): string | null {
  const m = SIZE_RE.exec(url);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  const scale = longEdge / Math.max(w, h);
  if (scale <= 1) return null;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  return url.replace(SIZE_RE, `=w${nw}-h${nh}${m[3]}`);
}
