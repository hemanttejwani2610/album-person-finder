// Browser entry for scripts/benchmark/run.mjs: returns raw face descriptors for each image so
// scoring variants (single vs multiple references, thresholds) can be computed in Node.
import { FacePipeline, PipelineOptions } from '../../src/worker/facePipeline';
import { MIN_FACE_SIZE_PX } from '../../src/shared/matching';

(window as unknown as { run: unknown }).run = async (options: PipelineOptions, urls: string[]) => {
  const pipeline = await FacePipeline.create('webgl', { modelBaseUrl: '/models/', wasmBaseUrl: '/wasm/', descriptorBaseUrl: '/models/descriptor/' }, options);
  const out = [];
  for (const url of urls) {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const r = await pipeline.detect(bmp, MIN_FACE_SIZE_PX);
    bmp.close();
    out.push({
      w: r.width,
      h: r.height,
      faces: r.faces.map((f) => ({ side: Math.round(Math.min(f.box.width, f.box.height)), mesh: +f.meshScore.toFixed(2), d: f.descriptor ? Array.from(f.descriptor) : null })),
    });
  }
  return out;
};
(window as unknown as { ready: boolean }).ready = true;

// Debug: aligned chips (as PNG data URLs) for every face in one image, using pipeline internals.
(window as unknown as { chips: unknown }).chips = async (options: PipelineOptions, url: string) => {
  const pipeline = await FacePipeline.create('webgl', { modelBaseUrl: '/models/', wasmBaseUrl: '/wasm/', descriptorBaseUrl: '/models/descriptor/' }, options);
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const res = await pipeline.human.detect(bmp);
  const p = pipeline as unknown as {
    describer: { size: number; transform: (f: unknown, box: unknown, mesh: boolean) => unknown };
    renderChip: (img: ImageBitmap, t: unknown) => Uint8ClampedArray;
  };
  const urls: string[] = [];
  for (const f of res.face as unknown as Array<{ box: number[] }>) {
    const [x, y, width, height] = f.box;
    const t = p.describer.transform(f, { x, y, width, height }, true);
    const data = p.renderChip(bmp, t);
    const c = new OffscreenCanvas(p.describer.size, p.describer.size);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), p.describer.size), 0, 0);
    const blob = await c.convertToBlob();
    urls.push(await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); }));
  }
  return urls;
};
