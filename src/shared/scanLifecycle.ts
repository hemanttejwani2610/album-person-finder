// Explicit scan state machine. Every UI control maps onto one event; illegal transitions are
// rejected rather than silently producing inconsistent state.

export type ScanState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'canceling'
  | 'canceled'
  | 'ended' // discovery stopped and all queued photos processed: "scan ended", best effort
  | 'interrupted' // tab navigated away / closed
  | 'error';

export type ScanEvent = 'start' | 'started' | 'pause' | 'resume' | 'cancel' | 'canceled' | 'end' | 'interrupt' | 'fail' | 'reset';

const TABLE: Record<ScanState, Partial<Record<ScanEvent, ScanState>>> = {
  idle: { start: 'starting' },
  starting: { started: 'running', cancel: 'canceling', interrupt: 'interrupted', fail: 'error' },
  running: { pause: 'paused', cancel: 'canceling', end: 'ended', interrupt: 'interrupted', fail: 'error' },
  paused: { resume: 'running', cancel: 'canceling', interrupt: 'interrupted', fail: 'error' },
  canceling: { canceled: 'canceled', fail: 'error' },
  canceled: { start: 'starting', reset: 'idle' },
  ended: { start: 'starting', reset: 'idle' },
  interrupted: { start: 'starting', reset: 'idle' },
  error: { start: 'starting', reset: 'idle' },
};

export const TERMINAL_STATES: ReadonlySet<ScanState> = new Set(['idle', 'canceled', 'ended', 'interrupted', 'error']);

export class ScanLifecycle {
  private current: ScanState = 'idle';
  private listeners = new Set<(s: ScanState, prev: ScanState) => void>();

  get state(): ScanState {
    return this.current;
  }

  get isActive(): boolean {
    return !TERMINAL_STATES.has(this.current);
  }

  can(event: ScanEvent): boolean {
    return TABLE[this.current][event] !== undefined;
  }

  /** Applies an event. Returns false (and changes nothing) if the transition is not allowed. */
  send(event: ScanEvent): boolean {
    const next = TABLE[this.current][event];
    if (!next) return false;
    const prev = this.current;
    this.current = next;
    for (const l of this.listeners) l(next, prev);
    return true;
  }

  onChange(listener: (s: ScanState, prev: ScanState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
