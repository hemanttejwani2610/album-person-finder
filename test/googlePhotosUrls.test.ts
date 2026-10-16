import { describe, expect, it } from 'vitest';
import {
  albumIdentity,
  canonicalAlbumUrl,
  canonicalPhotoUrl,
  isSameAlbum,
  parseAlbumLocation,
  photoKey,
} from '../src/adapter/googlePhotosUrls';

describe('parseAlbumLocation', () => {
  it('parses an album URL', () => {
    expect(parseAlbumLocation('https://photos.google.com/album/AF1QipABC_-123')).toEqual({
      album: { kind: 'album', albumId: 'AF1QipABC_-123', userIndex: null, shareKey: null },
      photoId: null,
    });
  });

  it('parses account-indexed albums and photo views', () => {
    const loc = parseAlbumLocation('https://photos.google.com/u/2/album/ALB/photo/PH0T0');
    expect(loc?.album).toMatchObject({ albumId: 'ALB', userIndex: '2' });
    expect(loc?.photoId).toBe('PH0T0');
  });

  it('parses shared-album links and keeps the share key in memory', () => {
    const loc = parseAlbumLocation('https://photos.google.com/share/SHR?key=k3y');
    expect(loc?.album).toEqual({ kind: 'share', albumId: 'SHR', userIndex: null, shareKey: 'k3y' });
  });

  it('resolves relative tile links against a base', () => {
    expect(parseAlbumLocation('./album/ALB/photo/P1', 'https://photos.google.com/')?.photoId).toBe('P1');
  });

  it('rejects other pages, hosts and schemes', () => {
    for (const u of [
      'https://photos.google.com/',
      'https://photos.google.com/albums',
      'https://photos.google.com/photo/P1',
      'https://photos.google.com/album/',
      'https://evil.example/album/ALB',
      'http://photos.google.com/album/ALB',
      'https://photos.google.com/album/ALB/edit',
      'not a url',
    ]) {
      expect(parseAlbumLocation(u), u).toBeNull();
    }
  });
});

describe('album identity and canonical links', () => {
  const a = parseAlbumLocation('https://photos.google.com/u/1/album/ALB')!.album;
  const b = parseAlbumLocation('https://photos.google.com/album/ALB/photo/X')!.album;
  const s = parseAlbumLocation('https://photos.google.com/share/ALB?key=K')!.album;

  it('treats the same album under different accounts/views as the same album', () => {
    expect(isSameAlbum(a, b)).toBe(true);
    expect(albumIdentity(a)).toBe('album:ALB');
  });

  it('distinguishes shared albums from personal albums with the same id', () => {
    expect(isSameAlbum(a, s)).toBe(false);
    expect(isSameAlbum(a, null)).toBe(false);
  });

  it('builds canonical album and photo URLs', () => {
    expect(canonicalAlbumUrl(a)).toBe('https://photos.google.com/u/1/album/ALB');
    expect(canonicalPhotoUrl(a, 'P9')).toBe('https://photos.google.com/u/1/album/ALB/photo/P9');
    expect(canonicalPhotoUrl(s, 'P9')).toBe('https://photos.google.com/share/ALB/photo/P9?key=K');
  });

  it('derives dedupe keys from album identity and photo id only', () => {
    expect(photoKey(a, 'P1')).toBe(photoKey(b, 'P1'));
    expect(photoKey(a, 'P1')).not.toBe(photoKey(a, 'P2'));
  });
});
