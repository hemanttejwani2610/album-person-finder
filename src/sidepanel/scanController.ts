// Orchestrates one album scan: drives discovery steps in the content script, deduplicates
// photos, and processes them with bounded concurrency. Lives in the side panel page (alive for as
// long as the panel is open), never in the MV3 service worker.
import { DiscoveryLimits, DiscoveryTracker, DEFAULT_LIMITS, StopReason } from '../shared/discoveryPolicy';
import type { DetectResult } from '../shared/faceTypes';
import { scorePhoto } from '../shared/matching';
import type { StepOk, StepResult } from '../shared/messages';
import { PhotoRecord, PhotoRegistry } from '../shared/photoRegistry';
import { isAbortError } from '../shared/retry';
import { ScanLifecycle, ScanState } from '../shared/scanLifecycle';

export interface DiscoveryPort {
  start(albumIdentity: string): Promise<StepResult>;
  step(albumIdentity: string): Promise<StepResult>;
  stop(restoreScroll: boolean): Promise<void>;
}

/** Raised by a processor for photos that are deliberately not processed (not errors). */
export class SkipError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SkipError';
  }
}

/** Raised by a processor for failures that have a known category (shown in diagnostics). */
export class ProcessingError extends Error {
  constructor(
    readonly category: 'image-access' | 'image-decode' | 'inference',
    message: string,
  ) {
    super(message);
    this.name = 'ProcessingError';
  }
}

export interface ProcessedPhoto {
  detect: DetectResult;
  /** Image bytes, offered to the results store for previews; it decides whether to keep them. */
  image: Blob;
}

export interface PhotoProcessor {
  process(rec: PhotoRecord, signal: AbortSignal): Promise<ProcessedPhoto>;
}

export type Notice = 'photo-view' | 'tab-hidden' | null;
export type InterruptReason = 'album-changed' | 'not-album-grid' | 'tab-closed' | 'page-unreachable';

export interface ScanStats {
  state: ScanState;
  phase: 'discovering' | 'processing' | 'finishing' | 'stopped';
  steps: number;
  discovered: number;
  duplicatesSeen: number;
  awaitingImage: number;
  queued: number;
  inFlight: number;
  processed: number;
  withFaces: number;
  facesDetected: number;
  facesCompared: number;
  facesTooSmall: number;
  skipped: number;
  failed: number;
  failuresByCategory: Record<string, number>;
  skipsByReason: Record<string, number>;
  smallImages: number;
  stopReason: StopReason | null;
  interruptReason: InterruptReason | null;
  notice: Notice;
  lastStep: Omit<StepOk, 'photos' | 'ok'> | null;
  error: string | null;
}

export interface ScanOptions {
  albumIdentity: string;
  reference: Float32Array;
  discovery: DiscoveryPort;
  processor: PhotoProcessor;
  concurrency?: number;
  limits?: DiscoveryLimits;
  /** Pause discovery while this many photos are waiting to be processed. */
  highWater?: number;
  /** Images whose shorter side is below this are counted as "small" for resolution diagnostics. */
  smallImagePx?: number;
  discoveryRetries?: number;
  onUpdate?: (stats: ScanStats) => void;
  onProcessed?: (rec: PhotoRecord, processed: ProcessedPhoto, bestFaceIndex: number) => void;
  log?: (msg: string) => void;
}

/** Promise-based wake-up signal. */
class Signal {
  private waiters: Array<() => void> = [];
  wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }
  notify(): void {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((r) => r());
  }
}

export class ScanController {
  readonly lifecycle = new ScanLifecycle();
  readonly registry = new PhotoRegistry();
  private tracker: DiscoveryTracker;
  private inflight = new Map<string, AbortController>();
  private changed = new Signal();
  private discoveryDone = false;
  private stats: ScanStats;
  private opts: Required<Omit<ScanOptions, 'onUpdate' | 'onProcessed' | 'log'>> & Pick<ScanOptions, 'onUpdate' | 'onProcessed' | 'log'>;

  constructor(options: ScanOptions) {
    this.opts = {
      concurrency: 3,
      limits: DEFAULT_LIMITS,
      highWater: 60,
      smallImagePx: 200,
      discoveryRetries: 2,
      ...options,
    };
    this.tracker = new DiscoveryTracker(this.opts.limits);
    this.stats = {
      state: 'idle',
      phase: 'discovering',
      steps: 0,
      discovered: 0,
      duplicatesSeen: 0,
      awaitingImage: 0,
      queued: 0,
      inFlight: 0,
      processed: 0,
      withFaces: 0,
      facesDetected: 0,
      facesCompared: 0,
      facesTooSmall: 0,
      skipped: 0,
      failed: 0,
      failuresByCategory: {},
      skipsByReason: {},
      smallImages: 0,
      stopReason: null,
      interruptReason: null,
      notice: null,
      lastStep: null,
      error: null,
    };
    this.lifecycle.onChange(() => {
      this.changed.notify();
      this.emit();
    });
  }

  get state(): ScanState {
    return this.lifecycle.state;
  }

  snapshot(): ScanStats {
    const c = this.registry.counts();
    return {
      ...this.stats,
      state: this.lifecycle.state,
      discovered: c.total,
      awaitingImage: c['awaiting-image'],
      queued: c.queued,
      inFlight: this.inflight.size,
      processed: c.done,
      skipped: c.skipped,
      failed: c.failed,
      failuresByCategory: { ...this.stats.failuresByCategory },
      skipsByReason: { ...this.stats.skipsByReason },
    };
  }

  private emit() {
    this.opts.onUpdate?.(this.snapshot());
  }

  private log(msg: string) {
    this.opts.log?.(msg);
  }

  pause(): boolean {
    return this.lifecycle.send('pause');
  }

  resume(): boolean {
    this.stats.notice = null;
    return this.lifecycle.send('resume');
  }

  cancel(): boolean {
    if (!this.lifecycle.send('cancel')) return false;
    for (const ac of this.inflight.values()) ac.abort();
    return true;
  }

  /** The scanned tab navigated elsewhere or closed: stop without touching the page further. */
  interrupt(reason: InterruptReason): boolean {
    if (!this.lifecycle.can('interrupt')) return false;
    this.stats.interruptReason = reason;
    for (const ac of this.inflight.values()) ac.abort();
    return this.lifecycle.send('interrupt');
  }

  private autoPause(notice: Notice) {
    this.stats.notice = notice;
    if (this.lifecycle.state === 'running') this.lifecycle.send('pause');
    else this.emit();
  }

  private get running(): boolean {
    return this.lifecycle.state === 'running';
  }

  private get live(): boolean {
    const s = this.lifecycle.state;
    return s === 'running' || s === 'paused' || s === 'starting';
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.lifecycle.state === 'paused') await this.changed.wait();
  }

  private ingest(step: StepOk) {
    const merged = this.registry.merge(step.photos);
    this.stats.duplicatesSeen += merged.duplicates;
    const { photos: _photos, ok: _ok, ...rest } = step;
    this.stats.lastStep = rest;
    if (merged.added || merged.updated) this.changed.notify();
    return merged.added + merged.updated;
  }

  private async callDiscovery(fn: () => Promise<StepResult>): Promise<StepResult | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= this.opts.discoveryRetries || !this.live) {
          this.log(`discovery: page unreachable (${String(err)})`);
          return null;
        }
        this.log(`discovery: retrying after error (${String(err)})`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  /** Runs the scan to a terminal state. Resolves with the final stats; never rejects. */
  async run(): Promise<ScanStats> {
    if (!this.lifecycle.send('start')) throw new Error(`cannot start from state ${this.lifecycle.state}`);
    const id = this.opts.albumIdentity;
    const workers: Promise<void>[] = [];
    try {
      const first = await this.callDiscovery(() => this.opts.discovery.start(id));
      if (!first) {
        this.interrupt('page-unreachable');
      } else if (!first.ok) {
        this.interrupt(first.reason === 'photo-view' ? 'not-album-grid' : 'album-changed');
      } else if (this.lifecycle.send('started')) {
        this.ingest(first);
        for (let i = 0; i < this.opts.concurrency; i++) workers.push(this.worker());
        await this.discoveryLoop(id);
        this.discoveryDone = true;
        const awaiting = this.registry.finalizeAwaiting();
        if (awaiting) this.countSkip('no-image-url', awaiting);
        this.stats.phase = 'processing';
        this.changed.notify();
        this.emit();
        await Promise.all(workers);
        if (this.lifecycle.state === 'running') this.stats.phase = 'finishing';
      }
    } catch (err) {
      this.stats.error = String(err);
      this.log(`scan failed: ${String(err)}`);
      for (const ac of this.inflight.values()) ac.abort();
      this.lifecycle.send('fail');
    }
    this.discoveryDone = true;
    this.changed.notify();
    await Promise.allSettled(workers);
    // Release the content-side session. Scroll is restored only if the user is still on the album.
    const restore = this.lifecycle.state === 'running' || this.lifecycle.state === 'canceling';
    await this.opts.discovery.stop(restore).catch(() => undefined);
    if (this.lifecycle.state === 'running') this.lifecycle.send('end');
    if (this.lifecycle.state === 'canceling') this.lifecycle.send('canceled');
    this.stats.phase = 'stopped';
    this.emit();
    return this.snapshot();
  }

  private async discoveryLoop(id: string) {
    while (this.live) {
      await this.waitWhilePaused();
      if (!this.running) break;
      if (this.registry.queuedCount >= this.opts.highWater) {
        await this.changed.wait(); // a worker finished an item, or the state changed
        continue;
      }
      let res = await this.callDiscovery(() => this.opts.discovery.step(id));
      if (!this.running) {
        if (res?.ok) this.ingest(res); // keep what was captured while pausing
        if (this.lifecycle.state === 'paused') continue;
        break;
      }
      if (res && !res.ok && res.reason === 'no-session') {
        this.log('discovery: content session lost (page reloaded?), restarting it');
        res = await this.callDiscovery(() => this.opts.discovery.start(id));
      }
      if (!res) {
        this.interrupt('page-unreachable');
        break;
      }
      if (!res.ok) {
        if (res.reason === 'photo-view') {
          this.log('discovery: tab shows a single photo; pausing until the album grid is back');
          this.autoPause('photo-view');
          continue;
        }
        this.interrupt('album-changed');
        break;
      }
      const newItems = this.ingest(res);
      this.stats.steps = this.tracker.steps + 1;
      if (!res.visible) {
        this.log('discovery: album tab is hidden; pausing (hidden tabs may not render new tiles)');
        this.autoPause('tab-hidden');
      }
      const stop = this.tracker.record({ newItems, scrolled: res.scrolled, atEnd: res.atEnd });
      this.emit();
      if (stop) {
        this.stats.stopReason = stop;
        this.log(`discovery ended: ${stop} after ${this.tracker.steps} steps`);
        break;
      }
    }
  }

  private countSkip(reason: string, n = 1) {
    this.stats.skipsByReason[reason] = (this.stats.skipsByReason[reason] ?? 0) + n;
  }

  private async worker(): Promise<void> {
    while (true) {
      await this.waitWhilePaused();
      if (!this.running) return;
      const rec = this.registry.take();
      if (!rec) {
        if (this.discoveryDone) return;
        await this.changed.wait();
        continue;
      }
      const ac = new AbortController();
      this.inflight.set(rec.key, ac);
      this.emit();
      try {
        // Race against abort so cancel/interrupt never wait for non-abortable work (inference).
        const processed = await Promise.race([
          this.opts.processor.process(rec, ac.signal),
          new Promise<never>((_, reject) => {
            const fail = () => reject(new DOMException('Aborted', 'AbortError'));
            if (ac.signal.aborted) fail();
            else ac.signal.addEventListener('abort', fail, { once: true });
          }),
        ]);
        if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const score = scorePhoto(this.opts.reference, processed.detect.faces);
        rec.status = 'done';
        rec.score = score.bestScore;
        rec.facesDetected = score.facesDetected;
        rec.facesCompared = score.facesCompared;
        rec.facesTooSmall = score.facesTooSmall;
        rec.imageWidth = processed.detect.width;
        rec.imageHeight = processed.detect.height;
        this.stats.facesDetected += score.facesDetected;
        this.stats.facesCompared += score.facesCompared;
        this.stats.facesTooSmall += score.facesTooSmall;
        if (score.facesDetected > 0) this.stats.withFaces++;
        if (Math.min(rec.imageWidth, rec.imageHeight) < this.opts.smallImagePx) this.stats.smallImages++;
        this.opts.onProcessed?.(rec, processed, score.bestFaceIndex);
      } catch (err) {
        if (isAbortError(err) || ac.signal.aborted) {
          this.registry.requeue(rec.key);
        } else if (err instanceof SkipError) {
          rec.status = 'skipped';
          rec.reason = err.reason;
          this.countSkip(err.reason);
        } else {
          rec.status = 'failed';
          const category = err instanceof ProcessingError ? err.category : 'other';
          rec.reason = category;
          this.stats.failuresByCategory[category] = (this.stats.failuresByCategory[category] ?? 0) + 1;
          this.log(`photo #${rec.order + 1} failed (${category}): ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        this.inflight.delete(rec.key);
        this.changed.notify();
        this.emit();
      }
    }
  }
}
