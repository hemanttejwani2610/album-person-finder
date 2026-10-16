// Controlled scrolling + capture of album tiles before virtualization removes them from the DOM.
import {
  CollectResult,
  DiscoveredPhoto,
  collectAlbumPhotos,
  findFirstTile,
  findScrollContainer,
} from '../adapter/googlePhotosDom';
import { AlbumRef, isSameAlbum, parseAlbumLocation } from '../adapter/googlePhotosUrls';
import type { StepOk, StepResult } from '../shared/messages';

export interface DiscoveryEnv {
  doc: Document;
  getHref(): string;
  /** Wait until the DOM has been quiet for quietMs (bounded by maxMs). */
  quietMs: number;
  maxSettleMs: number;
  /** Fraction of the viewport height scrolled per step. */
  stepFraction: number;
}

export const defaultEnv = (): DiscoveryEnv => ({
  doc: document,
  getHref: () => location.href,
  quietMs: 350,
  maxSettleMs: 2500,
  stepFraction: 0.8,
});

export function waitForQuiet(root: Node, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'href'] });
    quietTimer = setTimeout(finish, quietMs);
    const maxTimer = setTimeout(finish, maxMs);
  });
}

export class DiscoverySession {
  /** key -> whether the reported record already had a thumbnail URL. */
  private reported = new Map<string, boolean>();
  /** Captured (e.g. by the mutation observer) but not yet handed to the side panel. */
  private pending = new Map<string, DiscoveredPhoto>();
  private observer: MutationObserver | null = null;
  private observerTimer: ReturnType<typeof setTimeout> | null = null;
  private scroller: Element | null = null;
  private initialScrollTop = 0;
  private last: CollectResult | null = null;

  constructor(
    readonly album: AlbumRef,
    private env: DiscoveryEnv,
  ) {}

  private locationProblem(): 'album-changed' | 'photo-view' | null {
    const loc = parseAlbumLocation(this.env.getHref());
    if (!loc || !isSameAlbum(loc.album, this.album)) return 'album-changed';
    if (loc.photoId) return 'photo-view';
    return null;
  }

  private ensureScroller(): Element {
    const doc = this.env.doc;
    const docScroller = doc.scrollingElement ?? doc.documentElement;
    if (this.scroller && this.scroller.isConnected && this.scroller !== docScroller) return this.scroller;
    const tile = findFirstTile(doc, this.album, this.env.getHref());
    this.scroller = findScrollContainer(doc, tile);
    return this.scroller;
  }

  private collect(): void {
    const result = collectAlbumPhotos(this.env.doc, this.album, this.env.getHref());
    this.last = result;
    for (const p of result.photos) {
      const had = this.reported.get(p.key);
      if (had === undefined || (had === false && p.thumbnailUrl)) {
        const prev = this.pending.get(p.key);
        if (!prev || (!prev.thumbnailUrl && p.thumbnailUrl)) this.pending.set(p.key, p);
      }
    }
  }

  private drain(): DiscoveredPhoto[] {
    const out = Array.from(this.pending.values());
    for (const p of out) this.reported.set(p.key, !!p.thumbnailUrl);
    this.pending.clear();
    return out;
  }

  private snapshot(photos: DiscoveredPhoto[], scrolled: boolean): StepOk {
    const s = this.ensureScroller();
    const doc = this.env.doc;
    return {
      ok: true,
      photos,
      scrolled,
      atEnd: s.scrollTop + s.clientHeight >= s.scrollHeight - 4,
      visible: doc.visibilityState !== 'hidden',
      tilesInDom: this.last?.photos.length ?? 0,
      anchorsSeen: this.last?.anchorsSeen ?? 0,
      otherAlbumLinks: this.last?.otherAlbumLinks ?? 0,
      withoutThumbnail: this.last?.withoutThumbnail ?? 0,
      scrollTop: Math.round(s.scrollTop),
      scrollHeight: Math.round(s.scrollHeight),
      clientHeight: Math.round(s.clientHeight),
    };
  }

  start(): StepResult {
    const problem = this.locationProblem();
    if (problem) return { ok: false, reason: problem };
    const scroller = this.ensureScroller();
    this.initialScrollTop = scroller.scrollTop;
    // Capture tiles that appear and disappear between our own steps.
    this.observer = new MutationObserver(() => {
      if (this.observerTimer) return;
      this.observerTimer = setTimeout(() => {
        this.observerTimer = null;
        if (!this.locationProblem()) this.collect();
      }, 120);
    });
    this.observer.observe(this.env.doc.body ?? this.env.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'style', 'href'],
    });
    this.collect();
    return this.snapshot(this.drain(), false);
  }

  async step(): Promise<StepResult> {
    const problem = this.locationProblem();
    if (problem) return { ok: false, reason: problem };
    this.collect();
    const s = this.ensureScroller();
    const before = s.scrollTop;
    const delta = Math.max(200, Math.round(s.clientHeight * this.env.stepFraction));
    s.scrollTop = before + delta;
    await waitForQuiet(this.env.doc.body ?? this.env.doc.documentElement, this.env.quietMs, this.env.maxSettleMs);
    const after = this.locationProblem();
    if (after) return { ok: false, reason: after };
    this.collect();
    return this.snapshot(this.drain(), s.scrollTop > before + 1);
  }

  stop(restoreScroll: boolean): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.observerTimer) clearTimeout(this.observerTimer);
    this.observerTimer = null;
    if (restoreScroll && this.scroller?.isConnected && !this.locationProblem()) {
      this.scroller.scrollTop = this.initialScrollTop;
    }
    this.pending.clear();
  }
}
