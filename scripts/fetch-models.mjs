// Downloads the face descriptor weights into vendor/models/descriptor/ and verifies their SHA-256.
//
// Model: dlib_face_recognition_resnet_model_v1 by Davis King, released into the public domain
//        (https://github.com/davisking/dlib-models, README: "released them into the public domain").
// Format: TensorFlow.js weights converted by face-api.js (MIT, Vincent Mühler),
//         pinned to commit a86f011d72124e5fb93e59d5c4ab98f699dd5c9c.
//
// Run once after cloning: npm run fetch-models   (the build fails with a hint if they are missing)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'vendor/models/descriptor');
const BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/a86f011d72124e5fb93e59d5c4ab98f699dd5c9c/';
// path in the face-api.js repo -> [local file name, sha256]
const FILES = {
  'weights/face_recognition_model-weights_manifest.json': ['face_recognition_model-weights_manifest.json', '6619f4126f845c1f7857f39cbd79565f375734f46e0dd25d9602f8dc21cda9f5'],
  'weights/face_recognition_model-shard1': ['face_recognition_model-shard1', '412566a2b8d814d84c60b8055ec5d3b3b2328ef7cd7853384e03ec3db7b053d8'],
  'weights/face_recognition_model-shard2': ['face_recognition_model-shard2', '69350fdecd845c532e44dd8f7d0521c773505ef46b87cc34f46640a0cc334ecc'],
  LICENSE: ['face-api.js-LICENSE.txt', 'd5480b4d4e46880107a56db666697ec3e90def81a8fc829e530b1c291e3172a5'],
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(outDir, { recursive: true });
for (const [remote, [name, expected]] of Object.entries(FILES)) {
  const dest = path.join(outDir, name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) {
    console.log(`ok (cached)  ${name}`);
    continue;
  }
  const res = await fetch(BASE + remote);
  if (!res.ok) throw new Error(`download failed for ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  writeFileSync(dest, buf);
  console.log(`ok           ${name} (${buf.length} bytes)`);
}
console.log(`Descriptor weights ready in ${path.relative(root, outDir)}`);
