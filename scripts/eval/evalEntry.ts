// Browser entry for scripts/eval-models.mjs. Runs the shipped FacePipeline on test images and
// reports, per image and size, the best match against the reference face.
import { FacePipeline, PipelineOptions } from '../../src/worker/facePipeline';
import { faceSimilarity } from '../../src/shared/matching';

interface Images {
  ref: string;
  album: string[];
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return d / Math.sqrt(x * y);
}

async function bitmap(url: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(url)).blob());
}

(window as unknown as { run: unknown }).run = async (options: PipelineOptions, images: Images, sizes: number[]) => {
  const pipeline = await FacePipeline.create('webgl', { modelBaseUrl: '/models/', wasmBaseUrl: '/wasm/', descriptorBaseUrl: '/models/descriptor/' }, options);
  const refBmp = await bitmap(`/img/1280/${images.ref}`);
  const ref = await pipeline.detect(refBmp, 28);
  refBmp.close();
  const refFace = [...ref.faces].filter((f) => f.descriptor).sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  if (!refFace?.descriptor) throw new Error('no usable face in reference');
  const out: Record<string, Record<number, unknown>> = {};
  let totalMs = 0;
  let runs = 0;
  for (const img of images.album) {
    out[img] = {};
    for (const s of sizes) {
      const bmp = await bitmap(`/img/${s}/${img}`);
      const r = await pipeline.detect(bmp, 28);
      bmp.close();
      totalMs += r.ms;
      runs++;
      const scored = r.faces
        .filter((f) => f.descriptor)
        .map((f) => ({
          sim: +faceSimilarity(refFace.descriptor as Float32Array, f.descriptor as Float32Array).toFixed(3),
          cos: +cosine(refFace.descriptor as Float32Array, f.descriptor as Float32Array).toFixed(3),
          side: Math.round(Math.min(f.box.width, f.box.height)),
        }))
        .sort((a, b) => b.sim - a.sim);
      out[img][s] = { faces: r.faces.length, tooSmall: r.faces.filter((f) => f.tooSmall).length, best: scored[0] ?? null, all: scored.map((x) => x.sim) };
    }
  }
  return { backend: pipeline.backend, dims: refFace.descriptor.length, avgDetectMs: Math.round(totalMs / runs), images: out };
};
(window as unknown as { ready: boolean }).ready = true;
