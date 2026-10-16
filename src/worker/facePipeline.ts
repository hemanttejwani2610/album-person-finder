// Detection + alignment + description for one still image. Shared by the extension's face worker
// and by the evaluation scripts so the evaluated code path is the shipped one.
import { Human } from '@vladmandic/human';
import type { Backend, DetectResult, DetectedFace } from '../shared/faceTypes';
import { CHIP_SIZE, DlibDescriptor } from './dlibDescriptor';
import { boxTransformTo, estimateSimilarity, fivePointsFromMesh, Similarity, transformFromBox, transformFromMesh } from './faceAlign';
import { buildHumanConfig } from './humanConfig';
import { SFACE_MODEL_FILE, SFACE_SIZE, SFACE_TEMPLATE, SFaceDescriptor } from './sfaceDescriptor';

export interface PipelineUrls {
  /** Folder with blazeface/facemesh(/faceres) Human models. */
  modelBaseUrl: string;
  /** Folder with the TensorFlow.js and ONNX Runtime .wasm binaries. */
  wasmBaseUrl: string;
  /** Folder with the descriptor model files (dlib weights and/or the SFace ONNX file). */
  descriptorBaseUrl: string;
}

export type DescriptorKind = 'sface' | 'dlib' | 'faceres';

export interface PipelineOptions {
  /** 'sface' is shipped; 'dlib' and 'faceres' are kept for evaluation. */
  descriptor: DescriptorKind;
  align: 'mesh' | 'box';
  /** Average each face's descriptor with that of its mirror image. */
  mirrorAverage: boolean;
}

export const DEFAULT_PIPELINE: PipelineOptions = { descriptor: 'sface', align: 'mesh', mirrorAverage: true };

type HumanFace = {
  box: [number, number, number, number];
  boxScore: number;
  faceScore: number;
  mesh?: number[][];
  embedding?: number[];
};

interface ChipDescriber {
  size: number;
  describe(pixels: Uint8ClampedArray, count: number): Promise<Float32Array[]>;
  transform(face: HumanFace, box: DetectedFace['box'], useMesh: boolean): Similarity;
}

export class FacePipeline {
  private chip: OffscreenCanvas;

  private constructor(
    readonly human: Human,
    private describer: ChipDescriber | null,
    readonly options: PipelineOptions,
  ) {
    this.chip = new OffscreenCanvas(describer?.size ?? 1, describer?.size ?? 1);
  }

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
    // Explicitly (re)select the backend: TensorFlow.js is shared by all Human instances, so a
    // fallback attempt after a failed one must switch it rather than reuse the previous backend.
    await human.init();
    await human.load();
    const active = human.tf.getBackend();
    if (active !== backend) throw new Error(`requested ${backend} but TensorFlow.js selected ${active}`);
    const required = options.descriptor === 'faceres' ? ['blazeface', 'facemesh', 'faceres'] : ['blazeface', 'facemesh'];
    const loaded = Object.entries(human.models.models)
      .filter(([, m]) => m)
      .map(([name]) => name);
    for (const r of required) if (!loaded.includes(r)) throw new Error(`model ${r} failed to load`);

    let describer: ChipDescriber | null = null;
    if (options.descriptor === 'dlib') {
      const dlib = await DlibDescriptor.load(human.tf, urls.descriptorBaseUrl);
      describer = {
        size: CHIP_SIZE,
        describe: (p, n) => dlib.describe(p, n),
        transform: (f, box, useMesh) => (useMesh && transformFromMesh(f.mesh)) || transformFromBox(box),
      };
    } else if (options.descriptor === 'sface') {
      const sface = await SFaceDescriptor.load(urls.descriptorBaseUrl + SFACE_MODEL_FILE, urls.wasmBaseUrl);
      describer = {
        size: SFACE_SIZE,
        describe: (p, n) => sface.describe(p, n),
        transform: (f, box, useMesh) => {
          const pts = useMesh ? fivePointsFromMesh(f.mesh) : null;
          return pts ? estimateSimilarity(pts, SFACE_TEMPLATE) : boxTransformTo(box, SFACE_SIZE, 1.15);
        },
      };
    }
    const pipeline = new FacePipeline(human, describer, options);
    // One inference on a blank image surfaces shader/kernel failures now rather than mid-scan.
    const probe = new OffscreenCanvas(64, 64);
    const ctx = probe.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 64, 64);
    await pipeline.detect(probe, 1);
    if (describer) await describer.describe(new Uint8ClampedArray(describer.size * describer.size * 4), 1);
    return pipeline;
  }

  private renderChip(image: CanvasImageSource, t: Similarity, mirror = false): Uint8ClampedArray {
    const size = this.chip.width;
    const ctx = this.chip.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    const [a, b, tx, ty] = t;
    // Mirroring composes x' = size − x' onto the alignment transform.
    if (mirror) ctx.setTransform(-a, b, b, a, size - tx, ty);
    else ctx.setTransform(a, b, -b, a, tx, ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, size, size).data;
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
    const describer = this.describer;
    if (describer) {
      const idx = faces.map((f, i) => (f.tooSmall ? -1 : i)).filter((i) => i >= 0);
      if (idx.length) {
        const views = this.options.mirrorAverage ? 2 : 1;
        const chipBytes = describer.size * describer.size * 4;
        const pixels = new Uint8ClampedArray(idx.length * views * chipBytes);
        idx.forEach((i, k) => {
          const t = describer.transform(raw[i], faces[i].box, this.options.align === 'mesh');
          pixels.set(this.renderChip(image, t), k * views * chipBytes);
          if (views === 2) pixels.set(this.renderChip(image, t, true), (k * 2 + 1) * chipBytes);
        });
        const descriptors = await describer.describe(pixels, idx.length * views);
        idx.forEach((i, k) => {
          if (views === 1) {
            faces[i].descriptor = descriptors[k];
            return;
          }
          const [d1, d2] = [descriptors[2 * k], descriptors[2 * k + 1]];
          faces[i].descriptor = d1.map((v, j) => (v + d2[j]) / 2);
        });
      }
    }
    return { width: image.width, height: image.height, faces, ms: Math.round(performance.now() - t0) };
  }
}
