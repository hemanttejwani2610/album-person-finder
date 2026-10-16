# Third-party components packaged in the extension

All of these are copied into `dist/` at build time and loaded from the extension package. Nothing is fetched from a CDN at runtime.

| Component | Version | Used for | License | Source |
| --- | --- | --- | --- | --- |
| Human (`@vladmandic/human`) | 3.3.6 | Face detection and landmark pipeline, bundled into `faceWorker.js` (includes TensorFlow.js) | MIT | https://github.com/vladmandic/human |
| TensorFlow.js (bundled by Human) | 4.22.0 | Inference runtime (WebGL / WASM / CPU backends) | Apache-2.0 | https://github.com/tensorflow/tfjs |
| `@tensorflow/tfjs-backend-wasm` binaries | 4.22.0 | `dist/wasm/*.wasm` for the WASM fallback backend | Apache-2.0 | https://github.com/tensorflow/tfjs/tree/master/tfjs-backend-wasm |
| BlazeFace model (`models/blazeface.*`, as converted by Human) | from Human 3.3.6 | Face detection | Apache-2.0 (MediaPipe) | https://github.com/google-ai-edge/mediapipe |
| FaceMesh model (`models/facemesh.*`, as converted by Human) | from Human 3.3.6 | Landmarks used to align faces | Apache-2.0 (MediaPipe) | https://github.com/google-ai-edge/mediapipe |
| dlib face recognition ResNet (`models/descriptor/*`) | `dlib_face_recognition_resnet_model_v1` | 128-d face descriptor | Public domain (dlib-models README: "released them into the public domain"; repository license CC0-1.0) | https://github.com/davisking/dlib-models |
| TensorFlow.js conversion of the dlib model + network definition | face-api.js commit `a86f011d72124e5fb93e59d5c4ab98f699dd5c9c` | Weight files downloaded by `npm run fetch-models` (SHA-256 pinned); `src/worker/dlibDescriptor.ts` is a port of face-api.js's `FaceRecognitionNet` forward pass | MIT (Vincent Mühler) | https://github.com/justadudewhohacks/face-api.js |

Notes

- Licenses were checked on 2026-10-16 via the GitHub API and the projects' READMEs. Human states that its bundled models are distributed "under license inherited from the original model source" (https://github.com/vladmandic/human/wiki/Models).
- face-api.js is no longer actively developed. It is not a runtime dependency: only its converted weight files are used, and the small network definition was ported onto the TensorFlow.js copy that Human bundles. Human itself is maintained (last push December 2025 at the time of writing).
- Model weights were trained by their authors on third-party face datasets (for the dlib model: FaceScrub, VGG Face and web images, per the dlib-models README). No datasets are redistributed here. If you plan commercial distribution, review the upstream model and training-data terms yourself; this table is not legal advice.
- Evaluated but not shipped: Human's FaceRes descriptor (Apache-2.0, HSE FaceRec) separated identities poorly on the test set; Human's MobileFaceNet integration produced constant descriptors in this version; InsightFace models were excluded because their weights are licensed for non-commercial research only.
- The full license texts of Human and face-api.js are copied to `dist/licenses/` at build time.
