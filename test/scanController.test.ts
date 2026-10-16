import { describe, expect, it } from 'vitest';
import type { DiscoveredPhoto } from '../src/adapter/googlePhotosDom';
import type { DetectResult } from '../src/shared/faceTypes';
import type { StepResult } from '../src/shared/messages';
import type { PhotoRecord } from '../src/shared/photoRegistry';
import {
  DiscoveryPort,
  PhotoProcessor,
  ProcessedPhoto,
  ProcessingError,
  ScanController,
  ScanOptions,
  SkipError,
} from '../src/sidepanel/scanController';

const REF = Float32Array.from([1, 0]);
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
};

function photo(id: string, thumb = true): DiscoveredPhoto {
  return {
    key: `album:ALB/${id}`,
    photoId: id,
    photoUrl: `https://photos.google.com/album/ALB/photo/${id}`,
    thumbnailUrl: thumb ? `https://lh3.googleusercontent.com/${id}` : null,
    label: id,
    displayWidth: 200,
    displayHeight: 200,
  };
}

function ok(photos: DiscoveredPhoto[], extra: Partial<Extract<StepResult, { ok: true }>> = {}): StepResult {
  return {
    ok: true,
    photos,
    scrolled: true,
    atEnd: false,
    visible: true,
    tilesInDom: photos.length,
    anchorsSeen: photos.length,
    otherAlbumLinks: 0,
    withoutThumbnail: 0,
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    ...extra,
  };
}

/** Scripted album: each step returns the next page; afterwards it reports the bottom. */
class FakeDiscovery implements DiscoveryPort {
  stepCalls = 0;
  starts = 0;
  stopped: boolean[] = [];
  constructor(
    private pages: StepResult[],
    private first: StepResult = ok([]),
  ) {}
  async start() {
    this.starts++;
    return this.first;
  }
  async step() {
    const page = this.pages[this.stepCalls++];
    await tick();
    return page ?? ok([], { scrolled: false, atEnd: true });
  }
  async stop(restore: boolean) {
    this.stopped.push(restore);
  }
}

/** Each photo id maps to a 2-d descriptor; its cosine with REF decides the score. */
class FakeProcessor implements PhotoProcessor {
  inflight = 0;
  maxInflight = 0;
  calls: string[] = [];
  gate: Promise<void> | null = null;
  constructor(private behaviour: (rec: PhotoRecord) => 'match' | 'nomatch' | 'noface' | Error = () => 'nomatch') {}
  async process(rec: PhotoRecord, signal: AbortSignal): Promise<ProcessedPhoto> {
    this.calls.push(rec.photoId);
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      await tick();
      // Deliberately ignores the abort signal while gated, like a non-abortable inference call.
      if (this.gate) await this.gate;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const b = this.behaviour(rec);
      if (b instanceof Error) throw b;
      const faces =
        b === 'noface'
          ? []
          : [{ box: { x: 0, y: 0, width: 80, height: 80 }, detectorScore: 0.9, meshScore: 0.9, descriptor: Float32Array.from(b === 'match' ? [0.8, 0.6] : [0, 1]), tooSmall: false }];
      const detect: DetectResult = { width: 400, height: 300, faces, ms: 1 };
      return { detect, image: new Blob(['x']) };
    } finally {
      this.inflight--;
    }
  }
}

function controller(discovery: DiscoveryPort, processor: PhotoProcessor, extra: Partial<ScanOptions> = {}) {
  return new ScanController({
    albumIdentity: 'album:ALB',
    reference: REF,
    discovery,
    processor,
    concurrency: 2,
    limits: { maxSteps: 50, endIdleSteps: 2, stuckSteps: 3, emptyScrollSteps: 10 },
    ...extra,
  });
}

describe('ScanController', () => {
  it('discovers across steps, deduplicates, processes everything and ends', async () => {
    const d = new FakeDiscovery([ok([photo('A'), photo('B')]), ok([photo('B'), photo('C')]), ok([photo('C'), photo('D')])], ok([photo('A')]));
    const p = new FakeProcessor((r) => (r.photoId === 'C' ? 'match' : 'nomatch'));
    const processed: string[] = [];
    const c = controller(d, p, { onProcessed: (rec) => processed.push(rec.photoId) });
    const stats = await c.run();
    expect(stats.state).toBe('ended');
    expect(stats.stopReason).toBe('reached-end');
    expect(stats.discovered).toBe(4);
    expect(stats.processed).toBe(4);
    expect(stats.duplicatesSeen).toBe(3); // A, B and C were each seen again in a later step
    expect(p.calls.sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(processed.sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(c.registry.get('album:ALB/C')!.score).toBeCloseTo(0.8);
    expect(c.registry.get('album:ALB/A')!.score).toBeCloseTo(0);
    expect(d.stopped).toEqual([true]);
  });

  it('never exceeds the configured processing concurrency', async () => {
    const many = Array.from({ length: 20 }, (_, i) => photo(`P${i}`));
    const d = new FakeDiscovery([ok(many)]);
    const p = new FakeProcessor();
    await controller(d, p, { concurrency: 3 }).run();
    expect(p.maxInflight).toBeLessThanOrEqual(3);
    expect(p.calls).toHaveLength(20);
  });

  it('applies backpressure: discovery waits while the queue is full', async () => {
    const pages = Array.from({ length: 5 }, (_, s) => ok(Array.from({ length: 10 }, (_, i) => photo(`S${s}_${i}`))));
    const d = new FakeDiscovery(pages);
    const p = new FakeProcessor();
    let stepsWhileFull = 0;
    const c = controller(d, p, {
      highWater: 10,
      onUpdate: (s) => {
        if (s.queued > 20) stepsWhileFull++;
      },
    });
    await c.run();
    expect(stepsWhileFull).toBe(0);
    expect(c.snapshot().processed).toBe(50);
  });

  it('pauses processing and resumes it', async () => {
    const many = Array.from({ length: 10 }, (_, i) => photo(`P${i}`));
    const d = new FakeDiscovery([ok(many)]);
    const p = new FakeProcessor();
    let release!: () => void;
    p.gate = new Promise((r) => (release = r));
    const c = controller(d, p);
    const run = c.run();
    await until(() => p.inflight === 2);
    expect(c.pause()).toBe(true);
    release();
    await until(() => p.inflight === 0);
    const doneWhilePaused = c.snapshot().processed;
    await new Promise((r) => setTimeout(r, 20));
    expect(c.snapshot().processed).toBe(doneWhilePaused); // nothing new starts while paused
    expect(c.state).toBe('paused');
    expect(c.resume()).toBe(true);
    const stats = await run;
    expect(stats.state).toBe('ended');
    expect(stats.processed).toBe(10);
  });

  it('cancels: aborts in-flight work and ends in the canceled state', async () => {
    const d = new FakeDiscovery([ok([photo('A'), photo('B'), photo('C')])]);
    const p = new FakeProcessor();
    p.gate = new Promise(() => undefined); // never resolves; only abort ends it
    const c = controller(d, p);
    const run = c.run();
    await until(() => p.inflight === 2);
    expect(c.cancel()).toBe(true);
    const stats = await run;
    expect(stats.state).toBe('canceled');
    expect(stats.processed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(d.stopped).toEqual([true]);
  });

  it('stops safely when the page reports a different album', async () => {
    const d = new FakeDiscovery([ok([photo('A')]), { ok: false, reason: 'album-changed' }]);
    const stats = await controller(d, new FakeProcessor()).run();
    expect(stats.state).toBe('interrupted');
    expect(stats.interruptReason).toBe('album-changed');
    expect(d.stopped).toEqual([false]); // never scroll a page that is no longer the album
  });

  it('can be interrupted externally (tab navigated / closed)', async () => {
    const d = new FakeDiscovery(Array.from({ length: 30 }, (_, i) => ok([photo(`P${i}`)])));
    const c = controller(d, new FakeProcessor());
    const run = c.run();
    await until(() => d.stepCalls >= 2);
    expect(c.interrupt('tab-closed')).toBe(true);
    const stats = await run;
    expect(stats.state).toBe('interrupted');
    expect(stats.interruptReason).toBe('tab-closed');
  });

  it('auto-pauses when the tab shows a single photo, and continues on resume', async () => {
    const d = new FakeDiscovery([ok([photo('A')]), { ok: false, reason: 'photo-view' }, ok([photo('B')])]);
    const c = controller(d, new FakeProcessor());
    const run = c.run();
    await until(() => c.state === 'paused');
    expect(c.snapshot().notice).toBe('photo-view');
    c.resume();
    const stats = await run;
    expect(stats.state).toBe('ended');
    expect(stats.discovered).toBe(2);
  });

  it('auto-pauses when the album tab is hidden', async () => {
    const d = new FakeDiscovery([ok([photo('A')], { visible: false })]);
    const c = controller(d, new FakeProcessor());
    const run = c.run();
    await until(() => c.state === 'paused');
    expect(c.snapshot().notice).toBe('tab-hidden');
    c.resume();
    expect((await run).state).toBe('ended');
  });

  it('restarts the content-side session if the page script lost it', async () => {
    const d = new FakeDiscovery([ok([photo('A')]), { ok: false, reason: 'no-session' }]);
    const stats = await controller(d, new FakeProcessor()).run();
    expect(d.starts).toBe(2);
    expect(stats.state).toBe('ended');
  });

  it('interrupts when the page stops answering after bounded retries', async () => {
    let calls = 0;
    const d: DiscoveryPort = {
      start: async () => ok([photo('A')]),
      step: async () => {
        calls++;
        throw new Error('Could not establish connection');
      },
      stop: async () => undefined,
    };
    const stats = await controller(d, new FakeProcessor(), { discoveryRetries: 2 }).run();
    expect(calls).toBe(3);
    expect(stats.state).toBe('interrupted');
    expect(stats.interruptReason).toBe('page-unreachable');
  });

  it('reports skipped and failed photos separately, by reason and category', async () => {
    const d = new FakeDiscovery([ok([photo('A'), photo('B'), photo('C'), photo('D'), photo('E', false)])]);
    const p = new FakeProcessor((r) =>
      r.photoId === 'A'
        ? new SkipError('unsupported-image-host')
        : r.photoId === 'B'
          ? new ProcessingError('image-access', 'HTTP 403')
          : r.photoId === 'C'
            ? new ProcessingError('inference', 'boom')
            : 'noface',
    );
    const stats = await controller(d, p).run();
    expect(stats.state).toBe('ended');
    expect(stats.skipped).toBe(2);
    expect(stats.skipsByReason).toEqual({ 'unsupported-image-host': 1, 'no-image-url': 1 });
    expect(stats.failed).toBe(2);
    expect(stats.failuresByCategory).toEqual({ 'image-access': 1, inference: 1 });
    expect(stats.processed).toBe(1);
    expect(stats.withFaces).toBe(0);
  });

  it('refuses to start twice', async () => {
    const c = controller(new FakeDiscovery([]), new FakeProcessor());
    const run = c.run();
    await expect(c.run()).rejects.toThrow(/cannot start/);
    await run;
  });
});
