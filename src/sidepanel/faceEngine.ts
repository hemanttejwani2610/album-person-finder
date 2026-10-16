// Side-panel client for the face worker: request/response correlation, timeouts, and bounded
// automatic restarts if the worker crashes or hangs.
import type { Backend, BackendAttempt, DetectResult, WorkerRequest, WorkerResponse } from '../shared/faceTypes';
import { ProcessingError } from './scanController';

export interface EngineInfo {
  backend: string;
  humanVersion: string;
  attempts: BackendAttempt[];
  initMs: number;
  restarts: number;
}

type Pending = { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const INIT_TIMEOUT_MS = 180_000;
const DETECT_TIMEOUT_MS = 60_000;
const MAX_RESTARTS = 2;
// Backend preference order, injected at build time (scripts/build.mjs); normally webgl → wasm → cpu.
declare const __APF_BACKENDS__: Backend[];
const BACKENDS: Backend[] = __APF_BACKENDS__;

export class FaceEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private initPromise: Promise<EngineInfo> | null = null;
  private restarts = 0;
  info: EngineInfo | null = null;
  lastError: string | null = null;

  constructor(
    private workerUrl: string,
    private modelBaseUrl: string,
    private wasmBaseUrl: string,
    private descriptorBaseUrl: string,
  ) {}

  private spawn(): Worker {
    const w = new Worker(this.workerUrl, { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'fatal') {
        this.lastError = e.data.error;
        console.warn('[Album Person Finder] face worker error:', e.data.error);
        return;
      }
      const p = this.pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(e.data.id);
      p.resolve(e.data);
    };
    w.onerror = (e) => {
      e.preventDefault();
      this.crash(`worker error: ${this.lastError ?? (e.message || 'unknown')}`);
    };
    return w;
  }

  private crash(reason: string) {
    this.lastError = reason;
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.info = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private request(msg: WorkerRequest, timeoutMs: number, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const w = this.worker;
    if (!w) return Promise.reject(new Error('face worker not running'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        // A hung inference leaves the worker in an unknown state; replace it.
        this.crash(`face worker timed out after ${timeoutMs} ms`);
        reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      w.postMessage(msg, transfer);
    });
  }

  /** Loads the models once; concurrent callers share the same initialization. */
  init(): Promise<EngineInfo> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.worker = this.spawn();
      const res = await this.request(
        {
          type: 'init',
          id: this.nextId++,
          modelBaseUrl: this.modelBaseUrl,
          wasmBaseUrl: this.wasmBaseUrl,
          descriptorBaseUrl: this.descriptorBaseUrl,
          backends: BACKENDS,
        },
        INIT_TIMEOUT_MS,
      );
      if (res.type === 'init-ok') {
        this.info = { backend: res.backend, humanVersion: res.humanVersion, attempts: res.attempts, initMs: res.ms, restarts: this.restarts };
        this.lastError = null;
        return this.info;
      }
      const detail = res.type === 'init-error' ? res.attempts.map((a) => `${a.backend}: ${a.error ?? 'failed'}`).join('; ') : 'unexpected reply';
      this.crash(`model initialization failed (${detail})`);
      throw new Error(`model initialization failed (${detail})`);
    })();
    this.initPromise.catch(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  /** Runs detection + description. The bitmap is transferred (and closed) by the worker. */
  async detect(bitmap: ImageBitmap, minFaceSize: number): Promise<DetectResult> {
    if (!this.worker || !this.initPromise) {
      if (this.restarts >= MAX_RESTARTS && this.lastError) {
        bitmap.close();
        throw new ProcessingError('inference', `face worker unavailable: ${this.lastError}`);
      }
      if (this.lastError) this.restarts++;
      try {
        await this.init();
      } catch (err) {
        bitmap.close();
        throw new ProcessingError('inference', err instanceof Error ? err.message : String(err));
      }
    } else {
      await this.initPromise;
    }
    let res: WorkerResponse;
    try {
      res = await this.request({ type: 'detect', id: this.nextId++, bitmap, minFaceSize }, DETECT_TIMEOUT_MS, [bitmap]);
    } catch (err) {
      throw new ProcessingError('inference', err instanceof Error ? err.message : String(err));
    }
    if (res.type === 'detect-ok') return res.result;
    throw new ProcessingError('inference', res.type === 'detect-error' ? res.error : 'unexpected reply');
  }

  dispose(): void {
    this.crash('disposed');
    this.lastError = null;
    this.restarts = 0;
  }
}
