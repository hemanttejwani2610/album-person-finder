// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://photos.google.com/album/ALB"}
// Exercises controlled scrolling over a synthetic *virtualized* grid. jsdom has no layout, so the
// grid fakes scroll geometry and re-renders on scrollTop changes, like a real virtual list.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscoverySession, DiscoveryEnv } from '../src/content/discoverySession';
import { parseAlbumLocation } from '../src/adapter/googlePhotosUrls';

const TOTAL = 40;
const PER_SCREEN = 8;
const ROW_PX = 100; // one tile per 100px
let href = 'https://photos.google.com/album/ALB';

function buildVirtualGrid(opts: { lateThumbs?: boolean } = {}) {
  document.body.innerHTML = '<div id="scroller" style="overflow-y:auto"><div id="inner"></div></div>';
  const scroller = document.getElementById('scroller')!;
  const inner = document.getElementById('inner')!;
  let top = 0;
  const render = () => {
    const first = Math.floor(top / ROW_PX);
    inner.replaceChildren();
    for (let i = first; i < Math.min(TOTAL, first + PER_SCREEN); i++) {
      const a = document.createElement('a');
      a.setAttribute('href', `/album/ALB/photo/P${i}`);
      const img = document.createElement('img');
      if (!opts.lateThumbs) img.setAttribute('src', `https://lh3.googleusercontent.com/t${i}=w200-h200`);
      else setTimeout(() => img.setAttribute('src', `https://lh3.googleusercontent.com/t${i}=w200-h200`), 5);
      a.appendChild(img);
      inner.appendChild(a);
    }
  };
  Object.defineProperty(scroller, 'clientHeight', { get: () => PER_SCREEN * ROW_PX, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => TOTAL * ROW_PX, configurable: true });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, TOTAL * ROW_PX - PER_SCREEN * ROW_PX));
      render();
    },
    configurable: true,
  });
  // Make the generic scroll-container search find our element despite jsdom's lack of layout.
  const realGCS = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element) => (el === scroller ? ({ overflowY: 'auto', backgroundImage: 'none' } as CSSStyleDeclaration) : realGCS(el))) as typeof window.getComputedStyle;
  render();
  return { scroller };
}

const env = (): DiscoveryEnv => ({ doc: document, getHref: () => href, quietMs: 10, maxSettleMs: 60, stepFraction: 0.8 });
const album = () => parseAlbumLocation('https://photos.google.com/album/ALB')!.album;

describe('DiscoverySession over a virtualized grid', () => {
  beforeEach(() => {
    href = 'https://photos.google.com/album/ALB';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('captures every tile before it is unmounted and reaches the end', async () => {
    buildVirtualGrid();
    const s = new DiscoverySession(album(), env());
    const first = s.start();
    if (!first.ok) throw new Error('start failed');
    const seen = new Set(first.photos.map((p) => p.photoId));
    let atEnd = false;
    for (let i = 0; i < 20 && !atEnd; i++) {
      const r = await s.step();
      if (!r.ok) throw new Error(r.reason);
      r.photos.forEach((p) => seen.add(p.photoId));
      atEnd = r.atEnd;
      expect(r.tilesInDom).toBeLessThanOrEqual(PER_SCREEN); // proves virtualization is in effect
    }
    expect(atEnd).toBe(true);
    expect(seen.size).toBe(TOTAL);
    s.stop(true);
  });

  it('reports each photo only once (session-level dedupe)', async () => {
    buildVirtualGrid();
    const s = new DiscoverySession(album(), env());
    const all: string[] = [];
    const first = s.start();
    if (first.ok) all.push(...first.photos.map((p) => p.photoId));
    for (let i = 0; i < 10; i++) {
      const r = await s.step();
      if (r.ok) all.push(...r.photos.map((p) => p.photoId));
    }
    expect(all.length).toBe(new Set(all).size);
    s.stop(false);
  });

  it('re-reports a tile once its late thumbnail arrives', async () => {
    buildVirtualGrid({ lateThumbs: true });
    const s = new DiscoverySession(album(), env());
    const first = s.start();
    if (!first.ok) throw new Error('start failed');
    expect(first.photos.every((p) => p.thumbnailUrl === null)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20)); // thumbnails arrive before the next step
    const r = await s.step();
    if (!r.ok) throw new Error(r.reason);
    const late = r.photos.filter((p) => p.photoId === 'P0');
    expect(late).toHaveLength(1);
    expect(late[0].thumbnailUrl).toContain('t0=');
    s.stop(false);
  });

  it('restores the original scroll position on stop', async () => {
    const { scroller } = buildVirtualGrid();
    scroller.scrollTop = 300;
    const s = new DiscoverySession(album(), env());
    s.start();
    await s.step();
    await s.step();
    expect(scroller.scrollTop).toBeGreaterThan(300);
    s.stop(true);
    expect(scroller.scrollTop).toBe(300);
  });

  it('refuses to scroll after navigation to another album or into a photo', async () => {
    const { scroller } = buildVirtualGrid();
    const s = new DiscoverySession(album(), env());
    s.start();
    href = 'https://photos.google.com/album/OTHER';
    expect(await s.step()).toEqual({ ok: false, reason: 'album-changed' });
    href = 'https://photos.google.com/album/ALB/photo/P3';
    expect(await s.step()).toEqual({ ok: false, reason: 'photo-view' });
    expect(scroller.scrollTop).toBe(0);
    s.stop(true);
    expect(scroller.scrollTop).toBe(0);
  });
});
