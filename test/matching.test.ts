import { describe, expect, it } from 'vitest';
import type { DetectedFace } from '../src/shared/faceTypes';
import {
  assessReference,
  DEFAULT_THRESHOLD,
  euclideanDistance,
  faceSimilarity,
  formatScore,
  isMatch,
  MIN_REFERENCE_FACE_PX,
  rankMatches,
  scorePhoto,
} from '../src/shared/matching';

const vec = (...xs: number[]) => Float32Array.from(xs);

function face(descriptor: Float32Array | null, side = 100, tooSmall = false): DetectedFace {
  return { box: { x: 0, y: 0, width: side, height: side }, detectorScore: 0.9, meshScore: 0.9, descriptor, tooSmall };
}

describe('distance and similarity', () => {
  it('computes Euclidean distance', () => {
    expect(euclideanDistance(vec(0, 0), vec(3, 4))).toBe(5);
    expect(euclideanDistance(vec(1, 2, 3), vec(1, 2, 3))).toBe(0);
  });

  it('defines similarity as 1 - distance, so identical descriptors score 1', () => {
    expect(faceSimilarity(vec(0.1, 0.2), vec(0.1, 0.2))).toBe(1);
    expect(faceSimilarity(vec(0, 0), vec(0.6, 0))).toBeCloseTo(0.4);
  });

  it('maps dlib distance 0.6 onto the default threshold', () => {
    expect(isMatch(faceSimilarity(vec(0), vec(0.59)), DEFAULT_THRESHOLD)).toBe(true);
    expect(isMatch(faceSimilarity(vec(0), vec(0.61)), DEFAULT_THRESHOLD)).toBe(false);
  });

  it('rejects mismatched or empty descriptors', () => {
    expect(() => euclideanDistance(vec(1), vec(1, 2))).toThrow(/length mismatch/);
    expect(() => euclideanDistance(vec(), vec())).toThrow();
  });

  it('formats scores without implying a probability', () => {
    expect(formatScore(0.456)).toBe('0.46');
    expect(formatScore(0.456)).not.toContain('%');
  });
});

describe('scorePhoto', () => {
  const ref = vec(0, 0, 0);

  it('scores a photo by its best-matching face (group photo case)', () => {
    const faces = [face(vec(0.9, 0, 0)), face(vec(0.2, 0, 0)), face(vec(0.7, 0.1, 0))];
    const s = scorePhoto(ref, faces);
    expect(s.bestFaceIndex).toBe(1);
    expect(s.bestScore).toBeCloseTo(0.8);
    expect(s.facesDetected).toBe(3);
    expect(s.facesCompared).toBe(3);
  });

  it('skips faces without descriptors and counts small faces', () => {
    const faces = [face(null, 10, true), face(vec(0.5, 0, 0))];
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
