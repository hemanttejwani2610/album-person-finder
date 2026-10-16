import { describe, expect, it } from 'vitest';
import type { DiscoveredPhoto } from '../src/adapter/googlePhotosDom';
import { PhotoRegistry } from '../src/shared/photoRegistry';

function photo(id: string, thumb: string | null = `https://lh3.googleusercontent.com/${id}=w200-h200`): DiscoveredPhoto {
  return {
    key: `album:ALB/${id}`,
    photoId: id,
    photoUrl: `https://photos.google.com/album/ALB/photo/${id}`,
    thumbnailUrl: thumb,
    label: null,
    displayWidth: 200,
    displayHeight: 200,
  };
}

describe('PhotoRegistry deduplication', () => {
  it('deduplicates by stable key, not by thumbnail URL', () => {
    const r = new PhotoRegistry();
    expect(r.merge([photo('A'), photo('B')])).toEqual({ added: 2, updated: 0, duplicates: 0 });
    // Same photo re-rendered with a different (temporary) thumbnail URL.
    const out = r.merge([photo('A', 'https://lh3.googleusercontent.com/A-other=w400-h400')]);
    expect(out.added).toBe(0);
    expect(r.counts().total).toBe(2);
    expect(r.queuedCount).toBe(2);
  });

  it('queues a photo once it gains an image URL', () => {
    const r = new PhotoRegistry();
    r.merge([photo('A', null)]);
    expect(r.counts()['awaiting-image']).toBe(1);
    expect(r.take()).toBeNull();
    expect(r.merge([photo('A')])).toEqual({ added: 0, updated: 1, duplicates: 0 });
    expect(r.take()?.photoId).toBe('A');
  });

  it('does not re-queue photos that are already processed', () => {
    const r = new PhotoRegistry();
    r.merge([photo('A')]);
    const rec = r.take()!;
    rec.status = 'done';
    expect(r.merge([photo('A', 'https://lh3.googleusercontent.com/new')]).duplicates).toBe(1);
    expect(r.take()).toBeNull();
  });

  it('hands out records in discovery order and assigns stable order numbers', () => {
    const r = new PhotoRegistry();
    r.merge([photo('A'), photo('B')]);
    r.merge([photo('C')]);
    expect([r.take()!.photoId, r.take()!.photoId, r.take()!.photoId]).toEqual(['A', 'B', 'C']);
    expect(r.get('album:ALB/C')!.order).toBe(2);
  });

  it('requeues interrupted work at the front without counting the attempt', () => {
    const r = new PhotoRegistry();
    r.merge([photo('A'), photo('B')]);
    const a = r.take()!;
    expect(a.attempts).toBe(1);
    r.requeue(a.key);
    expect(a.status).toBe('queued');
    expect(a.attempts).toBe(0);
    expect(r.take()!.photoId).toBe('A');
  });

  it('marks photos that never got an image as skipped when discovery ends', () => {
    const r = new PhotoRegistry();
    r.merge([photo('A', null), photo('B')]);
    expect(r.finalizeAwaiting()).toBe(1);
    expect(r.get('album:ALB/A')).toMatchObject({ status: 'skipped', reason: 'no-image-url' });
  });

  it('clears everything', () => {
    const r = new PhotoRegistry();
    r.merge([photo('A')]);
    r.clear();
    expect(r.counts().total).toBe(0);
    expect(r.take()).toBeNull();
  });
});
