// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://photos.google.com/album/ALB"}
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectAlbumPhotos,
  extractCssUrl,
  findFirstTile,
  findScrollContainer,
  findThumbnailUrl,
  readAlbumTitle,
} from '../src/adapter/googlePhotosDom';
import { parseAlbumLocation } from '../src/adapter/googlePhotosUrls';
import { maskImageUrl } from '../src/content/domDiagnostics';

const fixture = readFileSync(path.join(__dirname, 'fixtures/album-grid.html'), 'utf8');
const HREF = 'https://photos.google.com/album/ALB';
const album = parseAlbumLocation(HREF)!.album;

function load(html: string) {
  document.open();
  document.write(html);
  document.close();
}

describe('extractCssUrl', () => {
  it('handles quoted, unquoted and missing urls', () => {
    expect(extractCssUrl('url("https://a/b")')).toBe('https://a/b');
    expect(extractCssUrl("url('https://a/b')")).toBe('https://a/b');
    expect(extractCssUrl('url(https://a/b)')).toBe('https://a/b');
    expect(extractCssUrl('none')).toBeNull();
    expect(extractCssUrl('')).toBeNull();
    expect(extractCssUrl(undefined)).toBeNull();
  });
});

describe('collectAlbumPhotos on the synthetic grid', () => {
  beforeEach(() => load(fixture));

  it('collects each album photo once, keyed by photo id', () => {
    const res = collectAlbumPhotos(document, album, HREF);
    expect(res.photos.map((p) => p.photoId).sort()).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);
    expect(new Set(res.photos.map((p) => p.key)).size).toBe(res.photos.length);
  });

  it('ignores links to other albums and non-photo links', () => {
    const res = collectAlbumPhotos(document, album, HREF);
    expect(res.otherAlbumLinks).toBe(1);
    expect(res.photos.some((p) => p.photoId === 'X1')).toBe(false);
  });

  it('honours <base href> when resolving relative tile links', () => {
    const p1 = collectAlbumPhotos(document, album, HREF).photos.find((p) => p.photoId === 'P1')!;
    expect(p1.photoUrl).toBe('https://photos.google.com/album/ALB/photo/P1');
  });

  it('finds images on <img>, inline background-image, and single-tile wrappers', () => {
    const byId = Object.fromEntries(collectAlbumPhotos(document, album, HREF).photos.map((p) => [p.photoId, p]));
    expect(byId.P1.thumbnailUrl).toBe('https://lh3.googleusercontent.com/img1=w300-h200-no');
    expect(byId.P2.thumbnailUrl).toBe('https://lh3.googleusercontent.com/img2=w300-h200-no?authuser=0');
    expect(byId.P3.thumbnailUrl).toBe('https://lh3.googleusercontent.com/img3=w300-h200');
  });

  it('treats placeholders as "no image yet" and never borrows a neighbour image', () => {
    const res = collectAlbumPhotos(document, album, HREF);
    const byId = Object.fromEntries(res.photos.map((p) => [p.photoId, p]));
    expect(byId.P4.thumbnailUrl).toBeNull();
    expect(byId.P5.thumbnailUrl).toBeNull();
    expect(byId.P6.thumbnailUrl).toBeNull();
    expect(res.withoutThumbnail).toBe(3);
  });

  it('prefers the record that has an image when a photo is linked twice', () => {
    const p1 = collectAlbumPhotos(document, album, HREF).photos.find((p) => p.photoId === 'P1')!;
    expect(p1.thumbnailUrl).not.toBeNull();
  });

  it('normalises page labels to plain, bounded text', () => {
    const p7 = collectAlbumPhotos(document, album, HREF).photos.find((p) => p.photoId === 'P7')!;
    expect(p7.label).toBe('<img src=x onerror=alert(1)> evil');
  });

  it('returns nothing for a different album', () => {
    const other = parseAlbumLocation('https://photos.google.com/album/NOPE')!.album;
    expect(collectAlbumPhotos(document, other, HREF).photos).toEqual([]);
  });

  it('locates the first tile and a scroll container', () => {
    const tile = findFirstTile(document, album, HREF);
    expect(tile?.getAttribute('href')).toBe('./album/ALB/photo/P1');
    // jsdom has no layout, so the generic search falls back to the document scroller.
    expect(findScrollContainer(document, tile)).toBe(document.scrollingElement ?? document.documentElement);
  });

  it('reads the album title from the document title', () => {
    expect(readAlbumTitle(document)).toBe('Summer trip');
  });
});

describe('findThumbnailUrl edge cases', () => {
  it('rejects non-https image URLs', () => {
    load('<a href="./album/ALB/photo/P1"><img src="http://insecure.example/x.jpg"></a>');
    expect(findThumbnailUrl(document.querySelector('a')!, HREF)).toBeNull();
  });

  it('returns null for an empty title page', () => {
    load('<html><head><title>Google Photos</title></head><body></body></html>');
    expect(readAlbumTitle(document)).toBeNull();
  });
});

describe('maskImageUrl', () => {
  it('keeps only URL shape, masking long tokens and query values', () => {
    const masked = maskImageUrl('https://lh3.googleusercontent.com/pw/AP1GczPabcdefghijklmnopqrstuvwxyz0123456789=w300-h200-no?authuser=0');
    expect(masked).toBe('https://lh3.googleusercontent.com/pw/<43 chars>=w300-h200-no?authuser');
    expect(masked).not.toContain('AP1Gcz');
  });
});
