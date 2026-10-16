// Detection + alignment + description for one still image. Shared by the extension's face worker
// and by scripts/eval-models.mjs so the evaluated code path is the shipped one.
import { Human } from '@vladmandic/human';
import type { Backend, DetectResult, DetectedFace } from '../shared/faceTypes';
import { CHIP_SIZE, DlibDescriptor } from './dlibDescriptor';
import { Similarity, transformFromBox, transformFromMesh } from './faceAlign';
import { buildHumanConfig } from './humanConfig';

export interface PipelineUrls {
  /** Folder with blazeface/facemesh(/faceres) Human models. */
  modelBaseUrl: string;
  wasmBaseUrl: string;
  /** Folder with face_recognition_model-weights_manifest.json and shards. */
  descriptorBaseUrl: string;
}

export interface PipelineOptions {
  /** 'dlib' is the shipped descriptor; 'faceres' (Human's own) is kept for evaluation only. */
  descriptor: 'dlib' | 'faceres';
  align: 'mesh' | 'box';
}

export const DEFAULT_PIPELINE: PipelineOptions = { descriptor: 'dlib', align: 'mesh' };

type HumanFace = {
  box: [number, number, number, number];
  boxScore: number;
  faceScore: number;
  mesh?: number[][];
  embedding?: number[];
};

export class FacePipeline {
  private chip = new OffscreenCanvas(CHIP_SIZE, CHIP_SIZE);

  private constructor(
    readonly human: Human,
    private dlib: DlibDescriptor | null,
    readonly options: PipelineOptions,
  ) {}

  get backend(): string {
    return this.human.tf.getBackend();
  }

  static async create(backend: Backend, urls: PipelineUrls, options: PipelineOptions = DEFAULT_PIPELINE): Promise<FacePipeline> {
    const human = new Human(buildHumanConfig(backend, urls.modelBaseUrl, urls.wasmBaseUrl, options.descriptor === 'faceres'));
    if (backend === 'wasm') {
      // The multithreaded WASM build starts helper threads from blob: URLs, which the extension's
      // script-src 'self' CSP blocks. Use the single-threaded (SIMD) build instead.
      human.tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
    }
    await human.load();
    const active = human.tf.getBackend();
    if (active !== backend) throw new Error(`requested ${backend} but TensorFlow.js selected ${active}`);
    const required = options.descriptor === 'faceres' ? ['blazeface', 'facemesh', 'faceres'] : ['blazeface', 'facemesh'];
    const loaded = Object.entries(human.models.models)
      .filter(([, m]) => m)
      .map(([name]) => name);
    for (const r of required) if (!loaded.includes(r)) throw new Error(`model ${r} failed to load`);
    const dlib = options.descriptor === 'dlib' ? await DlibDescriptor.load(human.tf, urls.descriptorBaseUrl) : null;
    const pipeline = new FacePipeline(human, dlib, options);
    // One inference on a blank image surfaces shader/kernel failures now rather than mid-scan.
    const probe = new OffscreenCanvas(64, 64);
    const ctx = probe.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 64, 64);
    await pipeline.detect(probe, 1);
    if (dlib) await dlib.describe(new Uint8ClampedArray(CHIP_SIZE * CHIP_SIZE * 4), 1);
    return pipeline;
  }

  private renderChip(image: CanvasImageSource, t: Similarity): Uint8ClampedArray {
    const ctx = this.chip.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CHIP_SIZE, CHIP_SIZE);
    const [a, b, tx, ty] = t;
    ctx.setTransform(a, b, -b, a, tx, ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, CHIP_SIZE, CHIP_SIZE).data;
  }

  async detect(image: ImageBitmap | OffscreenCanvas, minFaceSize: number): Promise<DetectResult> {
    const t0 = performance.now();
    const res = await this.human.detect(image);
    if (res.error) throw new Error(String(res.error));
    const raw = res.face as unknown as HumanFace[];
    const faces: DetectedFace[] = raw.map((f) => {
      const [x, y, width, height] = f.box;
      const tooSmall = Math.min(width, height) < minFaceSize;
      const faceres = this.options.descriptor === 'faceres' && !tooSmall && f.embedding?.length ? Float32Array.from(f.embedding) : null;
      return { box: { x, y, width, height }, detectorScore: f.boxScore, meshScore: f.faceScore, descriptor: faceres, tooSmall };
    });
    if (this.dlib) {
      const idx = faces.map((f, i) => (f.tooSmall ? -1 : i)).filter((i) => i >= 0);
      if (idx.length) {
        const pixels = new Uint8ClampedArray(idx.length * CHIP_SIZE * CHIP_SIZE * 4);
        idx.forEach((i, k) => {
          const t = (this.options.align === 'mesh' && transformFromMesh(raw[i].mesh)) || transformFromBox(faces[i].box);
          pixels.set(this.renderChip(image, t), k * CHIP_SIZE * CHIP_SIZE * 4);
        });
        const descriptors = await this.dlib.describe(pixels, idx.length);
        idx.forEach((i, k) => (faces[i].descriptor = descriptors[k]));
      }
    }
    return { width: image.width, height: image.height, faces, ms: Math.round(performance.now() - t0) };
  }
}
