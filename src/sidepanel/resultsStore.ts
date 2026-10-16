// In-memory store of candidate matches and their preview images. Only photos whose best score is
// at or above `floor` keep their image bytes, bounded by `maxPreviews`. Object URLs are created
// lazily and always revoked on eviction or clear.
import type { FaceBox } from '../shared/faceTypes';
import type { PhotoRecord } from '../shared/photoRegistry';

export interface Candidate {
  key: string;
  order: number;
  score: number | null;
  photoUrl: string;
  label: string | null;
  faceBox: FaceBox | null;
  imageWidth: number;
  imageHeight: number;
  facesCompared: number;
  blob: Blob | null;
}

export class ResultsStore {
  private items = new Map<string, Candidate>();
  private urls = new Map<string, string>();

  constructor(
    private floor: number,
    private maxPreviews: number,
    private createUrl: (b: Blob) => string = (b) => URL.createObjectURL(b),
    private revokeUrl: (u: string) => void = (u) => URL.revokeObjectURL(u),
  ) {}

  add(rec: PhotoRecord, image: Blob, faceBox: FaceBox | null): void {
    if (rec.score === null || rec.score < this.floor) return;
    this.items.set(rec.key, {
      key: rec.key,
      order: rec.order,
      score: rec.score,
      photoUrl: rec.photoUrl,
      label: rec.label,
      faceBox,
      imageWidth: rec.imageWidth,
      imageHeight: rec.imageHeight,
      facesCompared: rec.facesCompared,
      blob: image,
    });
    this.enforceCap();
  }

  /** Keeps image bytes only for the highest-scoring `maxPreviews` candidates. */
  private enforceCap() {
    const withBlob = Array.from(this.items.values()).filter((c) => c.blob);
    if (withBlob.length <= this.maxPreviews) return;
    withBlob.sort((a, b) => (a.score as number) - (b.score as number));
    for (const c of withBlob.slice(0, withBlob.length - this.maxPreviews)) this.dropPreview(c.key);
  }

  private dropPreview(key: string) {
    const c = this.items.get(key);
    if (c) c.blob = null;
    const u = this.urls.get(key);
    if (u) {
      this.revokeUrl(u);
      this.urls.delete(key);
    }
  }

  previewUrl(key: string): string | null {
    const existing = this.urls.get(key);
    if (existing) return existing;
    const c = this.items.get(key);
    if (!c?.blob) return null;
    const u = this.createUrl(c.blob);
    this.urls.set(key, u);
    return u;
  }

  candidates(): Candidate[] {
    return Array.from(this.items.values());
  }

  get size(): number {
    return this.items.size;
  }

  get liveObjectUrls(): number {
    return this.urls.size;
  }

  clear(): void {
    for (const u of this.urls.values()) this.revokeUrl(u);
    this.urls.clear();
    this.items.clear();
  }
}
