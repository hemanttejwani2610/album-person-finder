// Google Photos URL conventions.
//
// UNVERIFIED ASSUMPTIONS (not yet observed against a live album from this project; see
// docs/FEASIBILITY.md). Everything Google-Photos-specific about URLs lives in this file so it
// can be corrected in one place after running the in-extension diagnostics:
//   - Albums live at  https://photos.google.com[/u/N]/album/<albumId>
//   - Shared albums at https://photos.google.com[/u/N]/share/<albumId>[?key=<shareKey>]
//   - A photo opened from an album lives at <albumUrl>/photo/<photoId>
//   - Album grid tiles are <a> elements whose href resolves to such a photo URL.

export type AlbumKind = 'album' | 'share';

export interface AlbumRef {
  kind: AlbumKind;
  albumId: string;
  /** The "/u/N" account index, if present in the URL. */
  userIndex: string | null;
  /** The ?key= of a shared-album link. Kept in memory only so photo links keep working. */
  shareKey: string | null;
}

export interface PhotosLocation {
  album: AlbumRef;
  /** Set when the URL points at a single photo inside the album rather than the album grid. */
  photoId: string | null;
}

export const GOOGLE_PHOTOS_ORIGIN = 'https://photos.google.com';

const PATH_RE = /^(?:\/u\/(\d+))?\/(album|share)\/([A-Za-z0-9_-]+)(?:\/photo\/([A-Za-z0-9_-]+))?\/?$/;

/** Parses an album or album-photo URL. Returns null for anything else (including other hosts). */
export function parseAlbumLocation(href: string, base?: string): PhotosLocation | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'photos.google.com') return null;
  const m = PATH_RE.exec(url.pathname);
  if (!m) return null;
  return {
    album: {
      kind: m[2] as AlbumKind,
      albumId: m[3],
      userIndex: m[1] ?? null,
      shareKey: url.searchParams.get('key'),
    },
    photoId: m[4] ?? null,
  };
}

/** Identity of an album, independent of account index or share key. */
export function albumIdentity(album: AlbumRef): string {
  return `${album.kind}:${album.albumId}`;
}

export function isSameAlbum(a: AlbumRef | null | undefined, b: AlbumRef | null | undefined): boolean {
  return !!a && !!b && albumIdentity(a) === albumIdentity(b);
}

function prefix(album: AlbumRef): string {
  return album.userIndex !== null ? `/u/${album.userIndex}` : '';
}

function suffix(album: AlbumRef): string {
  return album.shareKey ? `?key=${encodeURIComponent(album.shareKey)}` : '';
}

export function canonicalAlbumUrl(album: AlbumRef): string {
  return `${GOOGLE_PHOTOS_ORIGIN}${prefix(album)}/${album.kind}/${album.albumId}${suffix(album)}`;
}

/** Canonical link to one photo inside an album. Used both for dedupe and for "Open original". */
export function canonicalPhotoUrl(album: AlbumRef, photoId: string): string {
  return `${GOOGLE_PHOTOS_ORIGIN}${prefix(album)}/${album.kind}/${album.albumId}/photo/${photoId}${suffix(album)}`;
}

/** Stable dedupe key: album identity plus the photo id observed in the tile link. */
export function photoKey(album: AlbumRef, photoId: string): string {
  return `${albumIdentity(album)}/${photoId}`;
}
