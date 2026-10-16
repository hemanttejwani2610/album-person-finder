// Turns a discovered photo into face detections: fetch → decode → worker inference.
import { MIN_FACE_SIZE_PX } from '../shared/matching';
import type { PhotoRecord } from '../shared/photoRegistry';
import type { FaceEngine } from './faceEngine';
import { chooseImageUrl, decode, fetchImage, FetchedImage } from './imageAccess';
import { PhotoProcessor, ProcessedPhoto, ProcessingError, SkipError } from './scanController';

export const LARGER_IMAGE_LONG_EDGE = 1024;

export interface ProcessorSettings {
  /** True only after probeLargerImages() verified larger variants on this album. */
  largerImagesVerified: boolean;
}

export class AlbumPhotoProcessor implements PhotoProcessor {
  resizedFallbacks = 0;

  constructor(
    private engine: FaceEngine,
    private settings: ProcessorSettings,
  ) {}

  async process(rec: PhotoRecord, signal: AbortSignal): Promise<ProcessedPhoto> {
    if (!rec.thumbnailUrl) throw new SkipError('no-image-url');
    const choice = chooseImageUrl(rec.thumbnailUrl, this.settings.largerImagesVerified, LARGER_IMAGE_LONG_EDGE);
    let fetched: FetchedImage;
    try {
      fetched = await fetchImage(choice.url, signal);
    } catch (err) {
      if (!choice.resized || !(err instanceof ProcessingError)) throw err;
      // The larger variant failed for this photo; fall back to the exact observed URL.
      this.resizedFallbacks++;
      fetched = await fetchImage(rec.thumbnailUrl, signal);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const bitmap = await decode(fetched.blob);
    if (signal.aborted) {
      bitmap.close();
      throw new DOMException('Aborted', 'AbortError');
    }
    const detect = await this.engine.detect(bitmap, MIN_FACE_SIZE_PX);
    return { detect, image: fetched.blob };
  }
}
