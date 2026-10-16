import { describe, expect, it, vi } from 'vitest';
import { isAllowedImageHost, parseSizeSuffix, withLongEdge } from '../src/adapter/googlePhotosImages';
import { HttpError, defaultRetryable, withRetry } from '../src/shared/retry';
import { applySimilarity, estimateSimilarity, TEMPLATE, transformFromBox, transformFromMesh, Pt } from '../src/worker/faceAlign';
import { ResultsStore } from '../src/sidepanel/resultsStore';
import { scrub } from '../src/sidepanel/diagnosticsLog';
import type { PhotoRecord } from '../src/shared/photoRegistry';

describe('image URL helpers', () => {
  it('only allows googleusercontent hosts over https', () => {
    expect(isAllowedImageHost('https://lh3.googleusercontent.com/x')).toBe(true);
    expect(isAllowedImageHost('https://googleusercontent.com/x')).toBe(true);
    expect(isAllowedImageHost('http://lh3.googleusercontent.com/x')).toBe(false);
    expect(isAllowedImageHost('https://googleusercontent.com.evil.example/x')).toBe(false);
    expect(isAllowedImageHost('nope')).toBe(false);
  });

  it('scales a size suffix up, keeping aspect ratio and trailing options', () => {
    expect(parseSizeSuffix('https://h/x=w300-h200-no?authuser=0')).toEqual({ w: 300, h: 200 });
    expect(withLongEdge('https://h/x=w300-h200-no?authuser=0', 1200)).toBe('https://h/x=w1200-h800-no?authuser=0');
    expect(withLongEdge('https://h/x=w2000-h1000', 1024)).toBeNull(); // would not get larger
    expect(withLongEdge('https://h/x.jpg', 1024)).toBeNull(); // no suffix: never guessed
  });
});

describe('withRetry', () => {
  const sleep = vi.fn(async () => undefined);

  it('retries transient failures a bounded number of times', async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw new HttpError(503);
        return 'ok';
      },
      { retries: 2, baseDelayMs: 10, sleep },
    );
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new TypeError('network'); }, { retries: 2, baseDelayMs: 1, sleep })).rejects.toThrow('network');
    expect(n).toBe(3);
  });

  it('does not retry permanent errors or aborts', async () => {
    expect(defaultRetryable(new HttpError(404))).toBe(false);
    expect(defaultRetryable(new HttpError(403))).toBe(false);
    expect(defaultRetryable(new HttpError(429))).toBe(true);
    expect(defaultRetryable(new DOMException('x', 'AbortError'))).toBe(false);
    let n = 0;
    await expect(withRetry(async () => { n++; throw new HttpError(404); }, { retries: 5, baseDelayMs: 1, sleep })).rejects.toThrow();
    expect(n).toBe(1);
  });
});

describe('face alignment', () => {
  it('recovers a known similarity transform', () => {
    const t: [number, number, number, number] = [0.8, 0.3, 12, -7];
    const src: Pt[] = [[10, 20], [60, 25], [35, 80]];
    const dst = src.map((p) => applySimilarity(t, p));
    estimateSimilarity(src, dst).forEach((v, i) => expect(v).toBeCloseTo(t[i], 6));
  });

  it('maps mesh eye/mouth centres onto the chip template', () => {
    // Build a face whose landmarks are the template scaled ×3, rotated 20° and shifted.
    const ang = (20 * Math.PI) / 180;
    const fwd: [number, number, number, number] = [3 * Math.cos(ang), 3 * Math.sin(ang), 400, 250];
    const place = (p: Pt) => applySimilarity(fwd, p);
    const mesh = Array.from({ length: 468 }, () => [0, 0, 0]);
    const set = (a: number, b: number, centre: Pt) => {
      const [x, y] = place(centre);
      mesh[a] = [x - 1, y, 0];
      mesh[b] = [x + 1, y, 0];
    };
    set(33, 133, TEMPLATE.leftEye);
    set(362, 263, TEMPLATE.rightEye);
    set(61, 291, TEMPLATE.mouth);
    const t = transformFromMesh(mesh)!;
    for (const p of [TEMPLATE.leftEye, TEMPLATE.rightEye, TEMPLATE.mouth]) {
      const back = applySimilarity(t, place(p));
      expect(back[0]).toBeCloseTo(p[0], 6);
      expect(back[1]).toBeCloseTo(p[1], 6);
    }
  });

  it('rejects missing or degenerate meshes and falls back to the box', () => {
    expect(transformFromMesh(undefined)).toBeNull();
    expect(transformFromMesh([])).toBeNull();
    const t = transformFromBox({ x: 100, y: 50, width: 40, height: 40 });
    const centre = applySimilarity(t, [120, 70]);
    expect(centre[0]).toBeCloseTo(75);
    expect(centre[1]).toBeCloseTo(75);
  });
});

describe('ResultsStore memory handling', () => {
  const rec = (key: string, score: number | null): PhotoRecord =>
    ({ key, order: 0, score, photoUrl: 'https://photos.google.com/album/A/photo/' + key, label: null, imageWidth: 10, imageHeight: 10, facesCompared: 1 }) as PhotoRecord;

  it('keeps only candidates above the floor and evicts the lowest previews past the cap', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const store = new ResultsStore(0.2, 2, () => `blob:${created.push('u')}`, (u) => revoked.push(u));
    store.add(rec('low', 0.1), new Blob(['a']), null);
    expect(store.size).toBe(0);
    store.add(rec('a', 0.5), new Blob(['a']), null);
    store.add(rec('b', 0.3), new Blob(['b']), null);
    const urlB = store.previewUrl('b');
    store.add(rec('c', 0.6), new Blob(['c']), null);
    expect(store.previewUrl('b')).toBeNull(); // evicted: lowest score
    expect(revoked).toEqual([urlB]);
    expect(store.size).toBe(3); // the candidate stays listed, only its image is dropped
    store.previewUrl('a');
    store.clear();
    expect(store.size).toBe(0);
    expect(store.liveObjectUrls).toBe(0);
    expect(revoked).toHaveLength(2);
  });
});

describe('diagnostics log scrubbing', () => {
  it('replaces URLs with their host', () => {
    expect(scrub('failed https://lh3.googleusercontent.com/abc=w1 now')).toBe('failed <lh3.googleusercontent.com url> now');
  });
});
