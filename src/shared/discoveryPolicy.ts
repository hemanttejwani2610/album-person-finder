// Explicit stopping condition for scroll-driven discovery. Google Photos does not tell us how
// many photos an album holds, so "done" is inferred and always reported as best effort.

export interface DiscoveryLimits {
  /** Hard cap on scroll steps. */
  maxSteps: number;
  /** Consecutive steps at the bottom with nothing new before we conclude the end is reached. */
  endIdleSteps: number;
  /** Consecutive steps where scrolling did not move and nothing new appeared (but not at the bottom). */
  stuckSteps: number;
  /** Consecutive steps that scrolled but surfaced nothing new. */
  emptyScrollSteps: number;
}

export const DEFAULT_LIMITS: DiscoveryLimits = { maxSteps: 5000, endIdleSteps: 3, stuckSteps: 6, emptyScrollSteps: 30 };

export type StopReason = 'reached-end' | 'not-scrolling' | 'no-new-photos' | 'step-limit';

export interface StepObservation {
  /** New photos or photos that gained an image URL in this step. */
  newItems: number;
  scrolled: boolean;
  atEnd: boolean;
}

export class DiscoveryTracker {
  steps = 0;
  private idleAtEnd = 0;
  private stuck = 0;
  private emptyScrolls = 0;

  constructor(private limits: DiscoveryLimits = DEFAULT_LIMITS) {}

  /** Records one step and returns a stop reason, or null to keep going. */
  record(o: StepObservation): StopReason | null {
    this.steps++;
    const progressed = o.newItems > 0;
    this.idleAtEnd = o.atEnd && !progressed ? this.idleAtEnd + 1 : 0;
    this.stuck = !o.atEnd && !o.scrolled && !progressed ? this.stuck + 1 : 0;
    this.emptyScrolls = o.scrolled && !progressed ? this.emptyScrolls + 1 : 0;
    if (this.idleAtEnd >= this.limits.endIdleSteps) return 'reached-end';
    if (this.stuck >= this.limits.stuckSteps) return 'not-scrolling';
    if (this.emptyScrolls >= this.limits.emptyScrollSteps) return 'no-new-photos';
    if (this.steps >= this.limits.maxSteps) return 'step-limit';
    return null;
  }
}

export const STOP_REASON_TEXT: Record<StopReason, string> = {
  'reached-end': 'Reached the bottom of the album and no new photos appeared.',
  'not-scrolling': 'The album stopped scrolling before reaching the bottom.',
  'no-new-photos': 'Scrolling continued but no new photos appeared for a long stretch.',
  'step-limit': 'Hit the safety limit on scroll steps.',
};
