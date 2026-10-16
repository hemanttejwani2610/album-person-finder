// Reference photo handling: decode, bound the size, detect faces, and produce face crops for the
// selection UI. Everything stays in memory.
import type { DetectResult, FaceBox } from '../shared/faceTypes';
import { MIN_FACE_SIZE_PX } from '../shared/matching';
import type { FaceEngine } from './faceEngine';

export const MAX_REFERENCE_EDGE = 1600;

export interface LoadedReference {
  /** Downscaled copy kept for drawing face crops; closed on clear. */
  bitmap: ImageBitmap;
  previewUrl: string;
  detect: DetectResult;
}

async function boundedBitmap(file: Blob): Promise<ImageBitmap> {
  const original = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_REFERENCE_EDGE / Math.max(original.width, original.height));
  if (scale === 1) return original;
  const w = Math.round(original.width * scale);
  const h = Math.round(original.height * scale);
  const resized = await createImageBitmap(original, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  original.close();
  return resized;
}

export async function loadReference(file: File, engine: FaceEngine): Promise<LoadedReference> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await boundedBitmap(file);
  } catch {
    throw new Error('Could not read that image. Try a JPEG or PNG file.');
  }
  // The worker takes ownership of (and closes) the bitmap it receives, so send a copy.
  const forWorker = await createImageBitmap(bitmap);
  const detect = await engine.detect(forWorker, MIN_FACE_SIZE_PX);
  return { bitmap, previewUrl: URL.createObjectURL(file), detect };
}

/** Draws a square-ish crop around a face (with margin) into a canvas for the chooser. */
export function drawFaceCrop(bitmap: ImageBitmap, box: FaceBox, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const side = Math.max(box.width, box.height) * 1.4;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const sx = Math.max(0, cx - side / 2);
  const sy = Math.max(0, cy - side / 2);
  const sw = Math.min(side, bitmap.width - sx);
  const sh = Math.min(side, bitmap.height - sy);
  ctx.fillStyle = '#ddd';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, (sw / side) * size, (sh / side) * size);
  return canvas;
}

export function releaseReference(ref: LoadedReference | null): void {
  if (!ref) return;
  ref.bitmap.close();
  URL.revokeObjectURL(ref.previewUrl);
}
