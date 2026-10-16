// Face embedding comparison.
//
// Descriptors come from dlib's ResNet face model, which was trained so that faces of the same
// person lie within Euclidean distance 0.6 of each other. We show `similarity = 1 − distance`:
// higher is more similar, and the default threshold 0.40 corresponds to dlib's documented 0.6.
// This is a relative similarity score, NOT a calibrated probability of a match.
import type { DetectedFace } from './faceTypes';

/** Default threshold (≙ dlib distance 0.6). See docs/VALIDATION_REPORT.md for the local experiment. */
export const DEFAULT_THRESHOLD = 0.4;
export const MIN_THRESHOLD = 0.2;
export const MAX_THRESHOLD = 0.8;
/** Faces smaller than this (shorter side, source pixels) are reported but not compared. */
export const MIN_FACE_SIZE_PX = 28;
/** Reference faces smaller than this get a "low quality reference" warning. */
export const MIN_REFERENCE_FACE_PX = 64;

export function euclideanDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`descriptor length mismatch: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/** Similarity score shown to users: 1 − Euclidean distance between descriptors (can be negative). */
export function faceSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return 1 - euclideanDistance(a, b);
}

export interface PhotoScore {
  /** Highest similarity among compared faces, or null when no face could be compared. */
  bestScore: number | null;
  bestFaceIndex: number;
  facesDetected: number;
  facesCompared: number;
  facesTooSmall: number;
}

/** Compares every usable face in a photo with the reference; the photo scores as its best face. */
export function scorePhoto(reference: ArrayLike<number>, faces: DetectedFace[]): PhotoScore {
  let bestScore: number | null = null;
  let bestFaceIndex = -1;
  let facesCompared = 0;
  let facesTooSmall = 0;
  faces.forEach((face, i) => {
    if (face.tooSmall) facesTooSmall++;
    if (!face.descriptor) return;
    facesCompared++;
    const s = faceSimilarity(reference, face.descriptor);
    if (bestScore === null || s > bestScore) {
      bestScore = s;
      bestFaceIndex = i;
    }
  });
  return { bestScore, bestFaceIndex, facesDetected: faces.length, facesCompared, facesTooSmall };
}

export function isMatch(score: number | null, threshold: number): boolean {
  return score !== null && score >= threshold;
}

/** Items at or above the threshold, sorted by similarity (desc), ties broken by discovery order. */
export function rankMatches<T extends { score: number | null; order: number }>(items: Iterable<T>, threshold: number): T[] {
  return Array.from(items)
    .filter((i) => isMatch(i.score, threshold))
    .sort((a, b) => (b.score as number) - (a.score as number) || a.order - b.order);
}

export type ReferenceAssessment =
  | { kind: 'no-face' }
  | { kind: 'only-small-faces'; count: number }
  | { kind: 'single'; faceIndex: number; lowQuality: boolean }
  | { kind: 'multiple'; usableIndexes: number[] };

/** Decides what the UI must ask the user after detecting faces in the reference photo. */
export function assessReference(faces: DetectedFace[]): ReferenceAssessment {
  if (faces.length === 0) return { kind: 'no-face' };
  const usable = faces.map((f, i) => (f.descriptor ? i : -1)).filter((i) => i >= 0);
  if (usable.length === 0) return { kind: 'only-small-faces', count: faces.length };
  if (usable.length === 1) {
    const f = faces[usable[0]];
    return { kind: 'single', faceIndex: usable[0], lowQuality: Math.min(f.box.width, f.box.height) < MIN_REFERENCE_FACE_PX };
  }
  return { kind: 'multiple', usableIndexes: usable };
}

/** Formats a similarity score for display without implying a probability. */
export function formatScore(score: number): string {
  return score.toFixed(2);
}
