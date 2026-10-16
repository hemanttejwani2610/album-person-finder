// 128-d face descriptor: SFace (Zhong et al., "SFace: Sigmoid-Constrained Hypersphere Loss for
// Robust Face Recognition"), MobileFaceNet weights from OpenCV Zoo (Apache-2.0), run with ONNX
// Runtime Web (MIT) on its single-threaded WASM backend. See THIRD_PARTY_LICENSES.md.
//
// Input: 112×112 RGB chip aligned with the standard 5-point template, values 0..255, NCHW —
// matching OpenCV's FaceRecognizerSF (blobFromImage with scale 1, no mean, RGB order).
import * as ort from 'onnxruntime-web/wasm';
import type { Pt } from './faceAlign';

export const SFACE_SIZE = 112;
export const SFACE_MODEL_FILE = 'face_recognition_sface_2021dec.onnx';

/** OpenCV FaceRecognizerSF alignment targets: eyes, nose tip, mouth corners (image-left first). */
export const SFACE_TEMPLATE: Pt[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export class SFaceDescriptor {
  private constructor(
    private session: ort.InferenceSession,
    private inputName: string,
    private outputName: string,
  ) {}

  static async load(modelUrl: string, wasmBaseUrl: string): Promise<SFaceDescriptor> {
    ort.env.wasm.wasmPaths = wasmBaseUrl;
    // Threads would need cross-origin isolation and blob: workers, which the extension CSP forbids.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    // The model triggers harmless graph-optimisation warnings; keep the console for real errors.
    ort.env.logLevel = 'error';
    const res = await fetch(modelUrl);
    if (!res.ok) throw new Error(`SFace model HTTP ${res.status}`);
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
    return new SFaceDescriptor(session, session.inputNames[0], session.outputNames[0]);
  }

  /** `pixels` holds `count` RGBA chips of SFACE_SIZE×SFACE_SIZE, back to back. */
  async describe(pixels: Uint8ClampedArray, count: number): Promise<Float32Array[]> {
    const plane = SFACE_SIZE * SFACE_SIZE;
    const out: Float32Array[] = [];
    for (let k = 0; k < count; k++) {
      const data = new Float32Array(3 * plane);
      const base = k * plane * 4;
      for (let p = 0; p < plane; p++) {
        data[p] = pixels[base + p * 4];
        data[plane + p] = pixels[base + p * 4 + 1];
        data[2 * plane + p] = pixels[base + p * 4 + 2];
      }
      const input = new ort.Tensor('float32', data, [1, 3, SFACE_SIZE, SFACE_SIZE]);
      const result = await this.session.run({ [this.inputName]: input });
      const t = result[this.outputName];
      out.push(Float32Array.from(t.data as Float32Array));
      t.dispose();
      input.dispose();
    }
    return out;
  }
}
