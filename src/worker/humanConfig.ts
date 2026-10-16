// Human (https://github.com/vladmandic/human, MIT) configuration for still-image face matching.
// Human provides detection (BlazeFace) and landmarks (FaceMesh). The identity descriptor is
// computed separately (dlibDescriptor.ts); Human's FaceRes descriptor is only enabled for
// evaluation. See THIRD_PARTY_LICENSES.md.
import type { Config } from '@vladmandic/human';
import type { Backend } from '../shared/faceTypes';

export const MAX_FACES_PER_IMAGE = 30;

export function buildHumanConfig(backend: Backend, modelBaseUrl: string, wasmBaseUrl: string, faceresDescriptor = false): Partial<Config> {
  return {
    backend,
    modelBasePath: modelBaseUrl,
    wasmPath: wasmBaseUrl,
    wasmPlatformFetch: false,
    // Models ship inside the extension; don't duplicate them into IndexedDB.
    cacheModels: false,
    debug: false,
    async: true,
    warmup: 'none',
    // Every input is an unrelated still image: never reuse results from a "previous frame".
    cacheSensitivity: 0,
    skipAllowed: false,
    filter: { enabled: false } as Config['filter'],
    gesture: { enabled: false },
    body: { enabled: false } as Config['body'],
    hand: { enabled: false } as Config['hand'],
    object: { enabled: false } as Config['object'],
    segmentation: { enabled: false } as Config['segmentation'],
    face: {
      enabled: true,
      detector: {
        modelPath: 'blazeface.json',
        rotation: true,
        maxDetected: MAX_FACES_PER_IMAGE,
        skipFrames: 0,
        skipTime: 0,
        minConfidence: 0.4,
        minSize: 0,
        iouThreshold: 0.1,
        return: false,
      },
      // Mesh landmarks align faces for the descriptor; keep faces even when mesh confidence is low
      // so small faces in group photos are still compared (alignment then falls back to the box).
      mesh: { enabled: true, modelPath: 'facemesh.json', keepInvalid: true },
      attention: { enabled: false },
      iris: { enabled: false },
      emotion: { enabled: false },
      antispoof: { enabled: false },
      liveness: { enabled: false },
      gear: { enabled: false },
      description: { enabled: faceresDescriptor, modelPath: 'faceres.json', skipFrames: 0, skipTime: 0, minConfidence: 0 },
    } as unknown as Config['face'],
  };
}
