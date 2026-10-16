// Types shared between the side panel and the face-inference worker.

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedFace {
  /** Box in source-image pixels. */
  box: FaceBox;
  /** Detector confidence (0..1). Not an identity score. */
  detectorScore: number;
  /** Face-mesh confidence (0..1); low values mean alignment was poor. */
  meshScore: number;
  /** Identity embedding, or null when the face was too small to describe reliably. */
  descriptor: Float32Array | null;
  tooSmall: boolean;
}

export interface DetectResult {
  width: number;
  height: number;
  faces: DetectedFace[];
  ms: number;
}

export type Backend = 'webgl' | 'wasm' | 'cpu';

export type WorkerRequest =
  | { type: 'init'; id: number; modelBaseUrl: string; wasmBaseUrl: string; descriptorBaseUrl: string; backends: Backend[] }
  | { type: 'detect'; id: number; bitmap: ImageBitmap; minFaceSize: number };

export interface BackendAttempt {
  backend: Backend;
  ok: boolean;
  error?: string;
  ms: number;
}

export type WorkerResponse =
  | { type: 'init-ok'; id: number; backend: string; humanVersion: string; attempts: BackendAttempt[]; ms: number }
  | { type: 'init-error'; id: number; attempts: BackendAttempt[] }
  | { type: 'detect-ok'; id: number; result: DetectResult }
  | { type: 'detect-error'; id: number; error: string }
  /** Uncaught error inside the worker; id 0 because it is not tied to a request. */
  | { type: 'fatal'; id: 0; error: string };
