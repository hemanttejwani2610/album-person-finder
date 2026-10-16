// Deduplicating registry of discovered photos and their processing state.
// Identity is the stable key derived from the photo link (album + photo id). Thumbnail URLs are
// treated as mutable attributes: they can be missing at first and change between renders.
import type { DiscoveredPhoto } from '../adapter/googlePhotosDom';

export type PhotoStatus =
  | 'awaiting-image' // discovered, but no image URL observed yet
  | 'queued'
  | 'processing'
  | 'done'
  | 'skipped'
  | 'failed';

export interface PhotoRecord {
  key: string;
  photoId: string;
  photoUrl: string;
  thumbnailUrl: string | null;
  label: string | null;
  displayWidth: number;
  displayHeight: number;
  /** Discovery order, used as a stable tiebreak. */
  order: number;
  status: PhotoStatus;
  attempts: number;
  /** Short machine-readable reason for skipped/failed. */
  reason: string | null;
  score: number | null;
  facesDetected: number;
  facesCompared: number;
  facesTooSmall: number;
  imageWidth: number;
  imageHeight: number;
}

export interface MergeOutcome {
  added: number;
  /** Existing records that gained or changed their image URL. */
  updated: number;
  duplicates: number;
}

export class PhotoRegistry {
  private records = new Map<string, PhotoRecord>();
  private queue: string[] = [];
  private nextOrder = 0;

  merge(photos: DiscoveredPhoto[]): MergeOutcome {
    const out: MergeOutcome = { added: 0, updated: 0, duplicates: 0 };
    for (const p of photos) {
      const existing = this.records.get(p.key);
      if (!existing) {
        const rec: PhotoRecord = {
          key: p.key,
          photoId: p.photoId,
          photoUrl: p.photoUrl,
          thumbnailUrl: p.thumbnailUrl,
          label: p.label,
          displayWidth: p.displayWidth,
          displayHeight: p.displayHeight,
          order: this.nextOrder++,
          status: p.thumbnailUrl ? 'queued' : 'awaiting-image',
          attempts: 0,
          reason: null,
          score: null,
          facesDetected: 0,
          facesCompared: 0,
          facesTooSmall: 0,
          imageWidth: 0,
          imageHeight: 0,
        };
        this.records.set(p.key, rec);
        if (p.thumbnailUrl) this.queue.push(p.key);
        out.added++;
        continue;
      }
      if (p.thumbnailUrl && p.thumbnailUrl !== existing.thumbnailUrl && (existing.status === 'awaiting-image' || existing.status === 'queued')) {
        existing.thumbnailUrl = p.thumbnailUrl;
        existing.displayWidth = p.displayWidth || existing.displayWidth;
        existing.displayHeight = p.displayHeight || existing.displayHeight;
        if (existing.status === 'awaiting-image') {
          existing.status = 'queued';
          this.queue.push(existing.key);
        }
        out.updated++;
      } else {
        out.duplicates++;
      }
    }
    return out;
  }

  /** Takes the next queued record and marks it processing. */
  take(): PhotoRecord | null {
    while (this.queue.length) {
      const key = this.queue.shift() as string;
      const rec = this.records.get(key);
      if (rec && rec.status === 'queued') {
        rec.status = 'processing';
        rec.attempts++;
        return rec;
      }
    }
    return null;
  }

  /** Puts a processing record back at the front (e.g. it was interrupted by pause/cancel). */
  requeue(key: string): void {
    const rec = this.records.get(key);
    if (rec && rec.status === 'processing') {
      rec.status = 'queued';
      rec.attempts = Math.max(0, rec.attempts - 1);
      this.queue.unshift(key);
    }
  }

  get(key: string): PhotoRecord | undefined {
    return this.records.get(key);
  }

  /** Marks records that never got an image URL as skipped. Called once discovery has ended. */
  finalizeAwaiting(): number {
    let n = 0;
    for (const rec of this.records.values()) {
      if (rec.status === 'awaiting-image') {
        rec.status = 'skipped';
        rec.reason = 'no-image-url';
        n++;
      }
    }
    return n;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  all(): PhotoRecord[] {
    return Array.from(this.records.values());
  }

  counts(): Record<PhotoStatus, number> & { total: number } {
    const c = { 'awaiting-image': 0, queued: 0, processing: 0, done: 0, skipped: 0, failed: 0, total: 0 };
    for (const r of this.records.values()) {
      c[r.status]++;
      c.total++;
    }
    return c;
  }

  clear(): void {
    this.records.clear();
    this.queue = [];
    this.nextOrder = 0;
  }
}
