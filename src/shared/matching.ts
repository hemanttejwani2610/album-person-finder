// Face embedding comparison.
//
// Descriptors come from SFace (see src/worker/sfaceDescriptor.ts). Similarity is the cosine of the
// angle between two descriptors: 1 for identical, around 0 for unrelated faces. OpenCV documents
// 0.363 as its same-person threshold for this model; the default below rounds that and was checked
// on the project benchmark (docs/VALIDATION_REPORT.md). This is a relative similarity score, NOT a
// calibrated probability of a match.
import type { DetectedFace } from './faceTypes';

export const DEFAULT_THRESHOLD = 0.36;
export const MIN_THRESHOLD = 0.15;
export const MAX_THRESHOLD = 0.8;

export type MatchPresetId = 'strict' | 'balanced' | 'loose';

/** User-facing match strictness. "Balanced" is the default threshold; the others bracket it. */
export const MATCH_PRESETS: ReadonlyArray<{ id: MatchPresetId; label: string; value: number; description: string }> = [
  { id: 'strict', label: 'Strict', value: 0.45, description: 'Fewer wrong matches, but may miss some photos of the person.' },
  { id: 'balanced', label: 'Balanced', value: DEFAULT_THRESHOLD, description: 'Recommended starting point.' },
  { id: 'loose', label: 'Loose', value: 0.28, description: 'Finds more photos (side views, small faces), with more wrong matches to review.' },
];

/** The preset a threshold corresponds to, or null for a custom value. */
export function presetForThreshold(value: number): MatchPresetId | null {
  return MATCH_PRESETS.find((p) => Math.abs(p.value - value) < 0.005)?.id ?? null;
}
/** Faces smaller than this (shorter side, source pixels) are reported but not compared. */
export const MIN_FACE_SIZE_PX = 28;
/** Reference faces smaller than this get a "low quality reference" warning. */
export const MIN_REFERENCE_FACE_PX = 64;

/** Similarity score shown to users: cosine similarity of two descriptors (−1..1). */
export function faceSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`descriptor length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
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
