// 128-d face descriptor network: dlib's "dlib_face_recognition_resnet_model_v1" (Davis King,
// released into the public domain), as converted to TensorFlow.js weights by face-api.js
// (Vincent Mühler, MIT). The forward pass below is a port of face-api.js's FaceRecognitionNet
// (src/faceRecognitionNet/*.ts) onto the TensorFlow.js instance bundled with Human, so no second
// copy of TensorFlow.js is shipped. See THIRD_PARTY_LICENSES.md.
import type { Human } from '@vladmandic/human';

type TF = Human['tf'];
// The bundled tf namespace is typed loosely by Human; keep the tensor type local and minimal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type T = any;

interface WeightSpec {
  name: string;
  shape: number[];
  dtype: string;
  quantization?: { dtype: string; scale?: number; min?: number };
}

interface ScaleParams { weights: T; biases: T }
interface ConvParams { filters: T; bias: T; scale: ScaleParams }
interface ResidualParams { conv1: ConvParams; conv2: ConvParams }

export const CHIP_SIZE = 150;
const MEAN_RGB = [122.782, 117.001, 104.298];

export class DlibDescriptor {
  private constructor(
    private tf: TF,
    private w: Record<string, T>,
  ) {}

  /** Loads face_recognition_model-weights_manifest.json and its shards from `baseUrl`. */
  static async load(tf: TF, baseUrl: string): Promise<DlibDescriptor> {
    const manifestRes = await fetch(`${baseUrl}face_recognition_model-weights_manifest.json`);
    if (!manifestRes.ok) throw new Error(`descriptor manifest HTTP ${manifestRes.status}`);
    const manifest = (await manifestRes.json()) as Array<{ paths: string[]; weights: WeightSpec[] }>;
    const buffers: ArrayBuffer[] = [];
    const specs: WeightSpec[] = [];
    for (const group of manifest) {
      for (const p of group.paths) {
        const r = await fetch(`${baseUrl}${p}`);
        if (!r.ok) throw new Error(`descriptor weights HTTP ${r.status}`);
        buffers.push(await r.arrayBuffer());
      }
      specs.push(...group.weights);
    }
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const b of buffers) {
      joined.set(new Uint8Array(b), offset);
      offset += b.byteLength;
    }
    const map = tf.io.decodeWeights(joined.buffer, specs as never) as Record<string, T>;
    for (const required of ['conv32_down/conv/filters', 'conv256_down_out/conv2/scale/biases', 'fc']) {
      if (!map[required]) throw new Error(`descriptor weights missing ${required}`);
    }
    return new DlibDescriptor(tf, map);
  }

  private conv(prefix: string): ConvParams {
    const w = this.w;
    return {
      filters: w[`${prefix}/conv/filters`],
      bias: w[`${prefix}/conv/bias`],
      scale: { weights: w[`${prefix}/scale/weights`], biases: w[`${prefix}/scale/biases`] },
    };
  }

  private res(prefix: string): ResidualParams {
    return { conv1: this.conv(`${prefix}/conv1`), conv2: this.conv(`${prefix}/conv2`) };
  }

  private convLayer(x: T, p: ConvParams, strides: [number, number], relu: boolean, padding: 'valid' | 'same' = 'same'): T {
    const tf = this.tf;
    let out = tf.conv2d(x, p.filters, strides, padding);
    out = tf.add(out, p.bias);
    out = tf.add(tf.mul(out, p.scale.weights), p.scale.biases);
    return relu ? tf.relu(out) : out;
  }

  private residual(x: T, p: ResidualParams): T {
    const tf = this.tf;
    let out = this.convLayer(x, p.conv1, [1, 1], true);
    out = this.convLayer(out, p.conv2, [1, 1], false);
    return tf.relu(tf.add(out, x));
  }

  private residualDown(x: T, p: ResidualParams): T {
    const tf = this.tf;
    let out = this.convLayer(x, p.conv1, [2, 2], true, 'valid');
    out = this.convLayer(out, p.conv2, [1, 1], false);
    let pooled = tf.avgPool(x, 2, 2, 'valid');
    const zeros = tf.zeros(pooled.shape);
    const isPad = pooled.shape[3] !== out.shape[3];
    const isAdjustShape = pooled.shape[1] !== out.shape[1] || pooled.shape[2] !== out.shape[2];
    if (isAdjustShape) {
      const padX = [...out.shape];
      padX[1] = 1;
      out = tf.concat([out, tf.zeros(padX)], 1);
      const padY = [...out.shape];
      padY[2] = 1;
      out = tf.concat([out, tf.zeros(padY)], 2);
    }
    pooled = isPad ? tf.concat([pooled, zeros], 3) : pooled;
    return tf.relu(tf.add(pooled, out));
  }

  /**
   * Computes descriptors for a batch of CHIP_SIZE×CHIP_SIZE RGB chips.
   * `pixels` is RGBA bytes for `count` chips laid out one after another.
   */
  async describe(pixels: Uint8ClampedArray, count: number): Promise<Float32Array[]> {
    if (count === 0) return [];
    const tf = this.tf;
    const out: T = tf.tidy(() => {
      const rgba = tf.tensor4d(pixels, [count, CHIP_SIZE, CHIP_SIZE, 4], 'int32');
      const rgb = tf.cast(tf.slice(rgba, [0, 0, 0, 0], [count, CHIP_SIZE, CHIP_SIZE, 3]), 'float32');
      const mean = tf.tensor1d(MEAN_RGB);
      const x = tf.div(tf.sub(rgb, mean), tf.scalar(256));
      let o = this.convLayer(x, this.conv('conv32_down'), [2, 2], true, 'valid');
      o = tf.maxPool(o, 3, 2, 'valid');
      o = this.residual(o, this.res('conv32_1'));
      o = this.residual(o, this.res('conv32_2'));
      o = this.residual(o, this.res('conv32_3'));
      o = this.residualDown(o, this.res('conv64_down'));
      o = this.residual(o, this.res('conv64_1'));
      o = this.residual(o, this.res('conv64_2'));
      o = this.residual(o, this.res('conv64_3'));
      o = this.residualDown(o, this.res('conv128_down'));
      o = this.residual(o, this.res('conv128_1'));
      o = this.residual(o, this.res('conv128_2'));
      o = this.residualDown(o, this.res('conv256_down'));
      o = this.residual(o, this.res('conv256_1'));
      o = this.residual(o, this.res('conv256_2'));
      o = this.residualDown(o, this.res('conv256_down_out'));
      return tf.matMul(tf.mean(o, [1, 2]), this.w.fc);
    });
    const data = (await out.data()) as Float32Array;
    out.dispose();
    const dims = data.length / count;
    return Array.from({ length: count }, (_, i) => data.slice(i * dims, (i + 1) * dims));
  }
}
