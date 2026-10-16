import { describe, expect, it } from 'vitest';
import type { DetectedFace } from '../src/shared/faceTypes';
import {
  assessReference,
  DEFAULT_THRESHOLD,
  faceSimilarity,
  formatScore,
  isMatch,
  MATCH_PRESETS,
  MAX_THRESHOLD,
  MIN_REFERENCE_FACE_PX,
  MIN_THRESHOLD,
  presetForThreshold,
  rankMatches,
  scorePhoto,
} from '../src/shared/matching';

const vec = (...xs: number[]) => Float32Array.from(xs);

function face(descriptor: Float32Array | null, side = 100, tooSmall = false): DetectedFace {
  return { box: { x: 0, y: 0, width: side, height: side }, detectorScore: 0.9, meshScore: 0.9, descriptor, tooSmall };
}

describe('similarity', () => {
  it('is the cosine of the angle between descriptors', () => {
    expect(faceSimilarity(vec(1, 0), vec(1, 0))).toBeCloseTo(1);
    expect(faceSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
    expect(faceSimilarity(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1);
    expect(faceSimilarity(vec(2, 0), vec(5, 0))).toBeCloseTo(1); // scale-invariant
    expect(faceSimilarity(vec(0, 0), vec(1, 0))).toBe(0);
  });

  it('uses a default threshold close to OpenCV\'s documented 0.363 for SFace', () => {
    const at = (deg: number) => vec(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180));
    expect(isMatch(faceSimilarity(vec(1, 0), at(68)), DEFAULT_THRESHOLD)).toBe(true); // cos 68° ≈ 0.375
    expect(isMatch(faceSimilarity(vec(1, 0), at(70)), DEFAULT_THRESHOLD)).toBe(false); // cos 70° ≈ 0.342
  });

  it('rejects mismatched or empty descriptors', () => {
    expect(() => faceSimilarity(vec(1), vec(1, 2))).toThrow(/length mismatch/);
    expect(() => faceSimilarity(vec(), vec())).toThrow();
  });

  it('formats scores without implying a probability', () => {
    expect(formatScore(0.456)).toBe('0.46');
    expect(formatScore(0.456)).not.toContain('%');
  });
});

describe('scorePhoto', () => {
  const ref = vec(1, 0);
  const at = (deg: number) => vec(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180));

  it('scores a photo by its best-matching face (group photo case)', () => {
    const faces = [face(at(80)), face(at(20)), face(at(50))];
    const s = scorePhoto(ref, faces);
    expect(s.bestFaceIndex).toBe(1);
    expect(s.bestScore).toBeCloseTo(Math.cos((20 * Math.PI) / 180));
    expect(s.facesDetected).toBe(3);
    expect(s.facesCompared).toBe(3);
  });

  it('skips faces without descriptors and counts small faces', () => {
    const faces = [face(null, 10, true), face(at(40))];
    const s = scorePhoto(ref, faces);
    expect(s.bestFaceIndex).toBe(1);
    expect(s.facesCompared).toBe(1);
    expect(s.facesTooSmall).toBe(1);
  });

  it('returns a null score when no face can be compared', () => {
    expect(scorePhoto(ref, []).bestScore).toBeNull();
    expect(scorePhoto(ref, [face(null, 10, true)]).bestScore).toBeNull();
    expect(isMatch(null, 0)).toBe(false);
  });
});

describe('rankMatches', () => {
  const items = [
    { key: 'a', score: 0.45, order: 2 },
    { key: 'b', score: 0.7, order: 1 },
    { key: 'c', score: 0.39, order: 0 },
    { key: 'd', score: null, order: 3 },
    { key: 'e', score: 0.45, order: 0 },
  ];

  it('filters by threshold and sorts by similarity, ties by discovery order', () => {
    expect(rankMatches(items, 0.4).map((i) => i.key)).toEqual(['b', 'e', 'a']);
  });

  it('re-ranks when the threshold changes', () => {
    expect(rankMatches(items, 0.3).map((i) => i.key)).toEqual(['b', 'e', 'a', 'c']);
    expect(rankMatches(items, 0.8)).toEqual([]);
  });
});

describe('match presets', () => {
  it('orders Strict > Balanced > Loose, with Balanced as the default', () => {
    const [strict, balanced, loose] = MATCH_PRESETS;
    expect([strict.id, balanced.id, loose.id]).toEqual(['strict', 'balanced', 'loose']);
    expect(strict.value).toBeGreaterThan(balanced.value);
    expect(balanced.value).toBe(DEFAULT_THRESHOLD);
    expect(balanced.value).toBeGreaterThan(loose.value);
    for (const p of MATCH_PRESETS) {
      expect(p.value).toBeGreaterThanOrEqual(MIN_THRESHOLD);
      expect(p.value).toBeLessThanOrEqual(MAX_THRESHOLD);
    }
  });

  it('maps thresholds back to presets, or null for custom values', () => {
    expect(presetForThreshold(DEFAULT_THRESHOLD)).toBe('balanced');
    expect(presetForThreshold(0.45)).toBe('strict');
    expect(presetForThreshold(0.281)).toBe('loose'); // slider rounding
    expect(presetForThreshold(0.33)).toBeNull();
  });
});

describe('assessReference', () => {
  it('reports no face', () => {
    expect(assessReference([])).toEqual({ kind: 'no-face' });
  });

  it('reports when all faces are too small', () => {
    expect(assessReference([face(null, 10, true), face(null, 12, true)])).toEqual({ kind: 'only-small-faces', count: 2 });
  });

  it('auto-selects a single usable face and flags small ones', () => {
    expect(assessReference([face(vec(1), 200)])).toEqual({ kind: 'single', faceIndex: 0, lowQuality: false });
    expect(assessReference([face(null, 10, true), face(vec(1), MIN_REFERENCE_FACE_PX - 1)])).toEqual({
      kind: 'single',
      faceIndex: 1,
      lowQuality: true,
    });
  });

  it('asks for a choice when several faces are usable', () => {
    expect(assessReference([face(vec(1)), face(null, 5, true), face(vec(2))])).toEqual({ kind: 'multiple', usableIndexes: [0, 2] });
  });
});
