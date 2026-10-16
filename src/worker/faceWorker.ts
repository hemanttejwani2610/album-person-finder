// Dedicated worker that owns the face models. Spawned by the side panel (an extension page), so a
// long scan never depends on the MV3 service worker staying alive. Requests are processed one at
// a time in arrival order.
/// <reference lib="webworker" />
import type { BackendAttempt, WorkerRequest, WorkerResponse } from '../shared/faceTypes';
import { FacePipeline } from './facePipeline';

declare const self: DedicatedWorkerGlobalScope;

let pipeline: FacePipeline | null = null;
let queue: Promise<void> = Promise.resolve();

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function init(msg: Extract<WorkerRequest, { type: 'init' }>) {
  const start = performance.now();
  const attempts: BackendAttempt[] = [];
  for (const backend of msg.backends) {
    const t0 = performance.now();
    try {
      pipeline = await FacePipeline.create(backend, msg);
      attempts.push({ backend, ok: true, ms: Math.round(performance.now() - t0) });
      post({
        type: 'init-ok',
        id: msg.id,
        backend: pipeline.backend,
        humanVersion: pipeline.human.version,
        attempts,
        ms: Math.round(performance.now() - start),
      });
      return;
    } catch (err) {
      attempts.push({ backend, ok: false, error: errorText(err), ms: Math.round(performance.now() - t0) });
    }
  }
  pipeline = null;
  post({ type: 'init-error', id: msg.id, attempts });
}

async function detect(msg: Extract<WorkerRequest, { type: 'detect' }>) {
  try {
    if (!pipeline) throw new Error('face models are not initialized');
    const result = await pipeline.detect(msg.bitmap, msg.minFaceSize);
    const transfer = result.faces.flatMap((f) => (f.descriptor ? [f.descriptor.buffer as ArrayBuffer] : []));
    post({ type: 'detect-ok', id: msg.id, result }, transfer);
  } catch (err) {
    post({ type: 'detect-error', id: msg.id, error: errorText(err) });
  } finally {
    msg.bitmap.close();
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value && typeof value === 'object' && 'message' in value) return String((value as { message: unknown }).message);
  return String(value);
}

// Report otherwise-opaque failures (e.g. from WASM glue code) with a readable message.
self.addEventListener('error', (e) => {
  post({ type: 'fatal', id: 0, error: describe(e.error ?? e.message) });
});
self.addEventListener('unhandledrejection', (e) => {
  post({ type: 'fatal', id: 0, error: `unhandled rejection: ${describe(e.reason)}` });
});

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  queue = queue.then(() => (msg.type === 'init' ? init(msg) : detect(msg)));
};
