// Face alignment for the descriptor network: a least-squares similarity transform (rotation,
// uniform scale, translation) that maps eye and mouth centres onto a fixed chip template, in the
// spirit of dlib's get_face_chip_details (size 150, padding 0.25).
import type { FaceBox } from '../shared/faceTypes';
import { CHIP_SIZE } from './dlibDescriptor';

export type Pt = [number, number];

/** [a, b, tx, ty] for x' = a·x − b·y + tx, y' = b·x + a·y + ty. */
export type Similarity = [number, number, number, number];

// Template positions in a 150×150 chip, derived from dlib's mean face shape with 0.25 padding:
// eye centres at normalised (0.225, 0.216) / (0.755, 0.216), mouth centre at (0.49, 0.80).
const pad = (v: number) => ((v + 0.25) / 1.5) * CHIP_SIZE;
export const TEMPLATE: { leftEye: Pt; rightEye: Pt; mouth: Pt } = {
  leftEye: [pad(0.2254), pad(0.216)],
  rightEye: [pad(0.7548), pad(0.216)],
  mouth: [pad(0.49), pad(0.8)],
};

/** Closed-form least-squares similarity transform mapping src points onto dst points. */
export function estimateSimilarity(src: Pt[], dst: Pt[]): Similarity {
  const n = src.length;
  if (n < 2 || n !== dst.length) throw new Error('need at least two point pairs');
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1];
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - msx, sy = src[i][1] - msy;
    const dx = dst[i][0] - mdx, dy = dst[i][1] - mdy;
    num1 += sx * dx + sy * dy;
    num2 += sx * dy - sy * dx;
    den += sx * sx + sy * sy;
  }
  if (den === 0) throw new Error('degenerate source points');
  const a = num1 / den;
  const b = num2 / den;
  return [a, b, mdx - (a * msx - b * msy), mdy - (b * msx + a * msy)];
}

export function applySimilarity([a, b, tx, ty]: Similarity, [x, y]: Pt): Pt {
  return [a * x - b * y + tx, b * x + a * y + ty];
}

const mean = (pts: Pt[]): Pt => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

// MediaPipe FaceMesh landmark indices (468-point topology).
const MESH = { eyeA: [33, 133], eyeB: [362, 263], mouth: [61, 291] };

/** Transform from image pixels to chip pixels using FaceMesh landmarks, or null if unusable. */
export function transformFromMesh(mesh: ArrayLike<ArrayLike<number>> | undefined): Similarity | null {
  if (!mesh || mesh.length < 468) return null;
  const pt = (i: number): Pt => [mesh[i][0], mesh[i][1]];
  const eyeA = mean(MESH.eyeA.map(pt));
  const eyeB = mean(MESH.eyeB.map(pt));
  const mouth = mean(MESH.mouth.map(pt));
  if (![...eyeA, ...eyeB, ...mouth].every(Number.isFinite)) return null;
  const eyeDist = Math.hypot(eyeB[0] - eyeA[0], eyeB[1] - eyeA[1]);
  if (eyeDist < 2) return null;
  return estimateSimilarity([eyeA, eyeB, mouth], [TEMPLATE.leftEye, TEMPLATE.rightEye, TEMPLATE.mouth]);
}

/** Fallback: axis-aligned square crop around the detector box with dlib-style padding. */
export function transformFromBox(box: FaceBox): Similarity {
  const side = Math.max(box.width, box.height) * 1.5;
  const s = CHIP_SIZE / side;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [s, 0, CHIP_SIZE / 2 - s * cx, CHIP_SIZE / 2 - s * cy];
}
