import { describe, expect, it } from 'vitest';
import { DiscoveryTracker } from '../src/shared/discoveryPolicy';
import { ScanLifecycle } from '../src/shared/scanLifecycle';

describe('ScanLifecycle', () => {
  it('follows start → run → pause → resume → end', () => {
    const l = new ScanLifecycle();
    const seen: string[] = [];
    l.onChange((s) => seen.push(s));
    expect(l.send('start')).toBe(true);
    expect(l.send('started')).toBe(true);
    expect(l.send('pause')).toBe(true);
    expect(l.send('resume')).toBe(true);
    expect(l.send('end')).toBe(true);
    expect(seen).toEqual(['starting', 'running', 'paused', 'running', 'ended']);
    expect(l.isActive).toBe(false);
  });

  it('rejects illegal transitions without changing state', () => {
    const l = new ScanLifecycle();
    expect(l.send('pause')).toBe(false);
    expect(l.send('resume')).toBe(false);
    expect(l.send('end')).toBe(false);
    expect(l.state).toBe('idle');
    l.send('start');
    l.send('started');
    expect(l.send('resume')).toBe(false);
    expect(l.state).toBe('running');
  });

  it('allows canceling from running, paused and starting, via canceling', () => {
    for (const path of [['start'], ['start', 'started'], ['start', 'started', 'pause']] as const) {
      const l = new ScanLifecycle();
      path.forEach((e) => l.send(e));
      expect(l.send('cancel')).toBe(true);
      expect(l.state).toBe('canceling');
      expect(l.isActive).toBe(true);
      expect(l.send('pause')).toBe(false);
      expect(l.send('canceled')).toBe(true);
      expect(l.state).toBe('canceled');
    }
  });

  it('can be interrupted (navigation) and restarted afterwards', () => {
    const l = new ScanLifecycle();
    l.send('start');
    l.send('started');
    l.send('pause');
    expect(l.send('interrupt')).toBe(true);
    expect(l.state).toBe('interrupted');
    expect(l.send('start')).toBe(true);
  });
});

describe('DiscoveryTracker stopping condition', () => {
  it('stops after N idle steps at the bottom', () => {
    const t = new DiscoveryTracker({ maxSteps: 100, endIdleSteps: 3, stuckSteps: 5, emptyScrollSteps: 50 });
    expect(t.record({ newItems: 5, scrolled: true, atEnd: false })).toBeNull();
    expect(t.record({ newItems: 0, scrolled: false, atEnd: true })).toBeNull();
    expect(t.record({ newItems: 0, scrolled: false, atEnd: true })).toBeNull();
    expect(t.record({ newItems: 0, scrolled: false, atEnd: true })).toBe('reached-end');
  });

  it('resets the idle count when late items load at the bottom', () => {
    const t = new DiscoveryTracker({ maxSteps: 100, endIdleSteps: 2, stuckSteps: 5, emptyScrollSteps: 50 });
    expect(t.record({ newItems: 0, scrolled: false, atEnd: true })).toBeNull();
    expect(t.record({ newItems: 4, scrolled: false, atEnd: true })).toBeNull();
    expect(t.record({ newItems: 0, scrolled: false, atEnd: true })).toBeNull();
    expect(t.record({ newItems: 0, scrolled: false, atEnd: true })).toBe('reached-end');
  });

  it('stops when the page will not scroll and nothing new appears', () => {
    const t = new DiscoveryTracker({ maxSteps: 100, endIdleSteps: 3, stuckSteps: 2, emptyScrollSteps: 50 });
    expect(t.record({ newItems: 0, scrolled: false, atEnd: false })).toBeNull();
    expect(t.record({ newItems: 0, scrolled: false, atEnd: false })).toBe('not-scrolling');
  });

  it('stops after a long run of scrolling without new photos', () => {
    const t = new DiscoveryTracker({ maxSteps: 100, endIdleSteps: 3, stuckSteps: 5, emptyScrollSteps: 3 });
    t.record({ newItems: 0, scrolled: true, atEnd: false });
    t.record({ newItems: 0, scrolled: true, atEnd: false });
    expect(t.record({ newItems: 0, scrolled: true, atEnd: false })).toBe('no-new-photos');
  });

  it('enforces a hard step limit', () => {
    const t = new DiscoveryTracker({ maxSteps: 3, endIdleSteps: 3, stuckSteps: 5, emptyScrollSteps: 50 });
    t.record({ newItems: 1, scrolled: true, atEnd: false });
    t.record({ newItems: 1, scrolled: true, atEnd: false });
    expect(t.record({ newItems: 1, scrolled: true, atEnd: false })).toBe('step-limit');
  });
});
