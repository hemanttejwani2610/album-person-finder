// Downloads face-descriptor models into vendor/models/descriptor/ and verifies their SHA-256.
//
// Shipped:  SFace (fp32) from OpenCV Zoo, Apache-2.0, pinned to opencv_zoo commit 088c357.
//           (The int8 variant matched it on the benchmark but ran ~2× slower in ONNX Runtime Web.)
// Eval only: dlib_face_recognition_resnet_model_v1 (public domain), TF.js conversion by
//            face-api.js (MIT), pinned to face-api.js commit a86f011. Used by scripts/eval-models.mjs
//            and scripts/benchmark/run.mjs for comparison; not copied into dist/.
//
// Run once after cloning: npm run fetch-models   (the build fails with a hint if they are missing)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'vendor/models/descriptor');
const SFACE = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/088c3571ec70df15100a5e4c26894d95951e92e9/models/face_recognition_sface/';
const SFACE_LICENSE = 'https://raw.githubusercontent.com/opencv/opencv_zoo/088c3571ec70df15100a5e4c26894d95951e92e9/models/face_recognition_sface/';
const FACEAPI = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/a86f011d72124e5fb93e59d5c4ab98f699dd5c9c/';

// local file name -> [url, sha256]
const FILES = {
  'face_recognition_sface_2021dec.onnx': [SFACE + 'face_recognition_sface_2021dec.onnx', '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'],
  'sface-LICENSE.txt': [SFACE_LICENSE + 'LICENSE', 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
  // The onnxruntime-web npm package does not include its license text; take it from the matching tag.
  'onnxruntime-LICENSE.txt': ['https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE', '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'],
  'face_recognition_model-weights_manifest.json': [FACEAPI + 'weights/face_recognition_model-weights_manifest.json', '6619f4126f845c1f7857f39cbd79565f375734f46e0dd25d9602f8dc21cda9f5'],
  'face_recognition_model-shard1': [FACEAPI + 'weights/face_recognition_model-shard1', '412566a2b8d814d84c60b8055ec5d3b3b2328ef7cd7853384e03ec3db7b053d8'],
  'face_recognition_model-shard2': [FACEAPI + 'weights/face_recognition_model-shard2', '69350fdecd845c532e44dd8f7d0521c773505ef46b87cc34f46640a0cc334ecc'],
  'face-api.js-LICENSE.txt': [FACEAPI + 'LICENSE', 'd5480b4d4e46880107a56db666697ec3e90def81a8fc829e530b1c291e3172a5'],
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(outDir, { recursive: true });
for (const [name, [url, expected]] of Object.entries(FILES)) {
  const dest = path.join(outDir, name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) {
    console.log(`ok (cached)  ${name}`);
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed for ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  writeFileSync(dest, buf);
  console.log(`ok           ${name} (${buf.length} bytes)`);
}
console.log(`Descriptor models ready in ${path.relative(root, outDir)}`);
