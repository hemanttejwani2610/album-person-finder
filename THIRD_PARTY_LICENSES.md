# Third-party components packaged in the extension

All of these are copied into `dist/` at build time and loaded from the extension package. Nothing is fetched from a CDN at runtime.

| Component | Version | Used for | License | Source |
| --- | --- | --- | --- | --- |
| Human (`@vladmandic/human`) | 3.3.6 | Face detection and landmark pipeline, bundled into `faceWorker.js` (includes TensorFlow.js) | MIT | https://github.com/vladmandic/human |
| TensorFlow.js (bundled by Human) | 4.22.0 | Inference runtime (WebGL / WASM / CPU backends) | Apache-2.0 | https://github.com/tensorflow/tfjs |
| `@tensorflow/tfjs-backend-wasm` binaries | 4.22.0 | `dist/wasm/*.wasm` for the WASM fallback backend | Apache-2.0 | https://github.com/tensorflow/tfjs/tree/master/tfjs-backend-wasm |
| BlazeFace model (`models/blazeface.*`, as converted by Human) | from Human 3.3.6 | Face detection | Apache-2.0 (MediaPipe) | https://github.com/google-ai-edge/mediapipe |
| FaceMesh model (`models/facemesh.*`, as converted by Human) | from Human 3.3.6 | Landmarks used to align faces | Apache-2.0 (MediaPipe) | https://github.com/google-ai-edge/mediapipe |
| SFace face recognition model (`models/descriptor/face_recognition_sface_2021dec.onnx`) | `face_recognition_sface_2021dec`, opencv_zoo commit `088c3571ec70df15100a5e4c26894d95951e92e9` | 128-d face descriptor (shipped). Downloaded by `npm run fetch-models`, SHA-256 pinned | Apache-2.0 (OpenCV Zoo model folder LICENSE) | https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface |
| ONNX Runtime Web (`onnxruntime-web`) | 1.30.0 | Runs SFace (single-threaded WASM backend); JS bundled into `faceWorker.js`, `dist/wasm/ort-wasm-simd-threaded.{wasm,mjs}` | MIT (Microsoft) | https://github.com/microsoft/onnxruntime |
| dlib face recognition ResNet + face-api.js TF.js conversion | dlib `..._resnet_model_v1`; face-api.js commit `a86f011d72124e5fb93e59d5c4ab98f699dd5c9c` | **Evaluation only, not shipped.** `src/worker/dlibDescriptor.ts` ports face-api.js's `FaceRecognitionNet` for the comparison scripts | Public domain (dlib-models README) / MIT (face-api.js) | https://github.com/davisking/dlib-models, https://github.com/justadudewhohacks/face-api.js |

Notes

- Licenses were checked on 2026-10-16 via the GitHub API and the projects' READMEs. Human states that its bundled models are distributed "under license inherited from the original model source" (https://github.com/vladmandic/human/wiki/Models).
- SFace (Zhong et al., 2021, arXiv:2205.12010) is distributed by OpenCV Zoo under Apache-2.0 (the model folder's LICENSE file, checked 2026-10-16). The paper reports training on CASIA-WebFace, VGGFace2 and MS-Celeb-1M; those datasets have their own terms and are not redistributed here.
- Human is maintained (last push December 2025 at the time of writing); OpenCV Zoo and ONNX Runtime are actively maintained. face-api.js is no longer developed and is used only by the evaluation scripts.
- The onnxruntime-web npm package does not include its license text, so `npm run fetch-models` downloads it from the matching `v1.30.0` tag (checksummed).
- Model weights were trained by their authors on third-party face datasets. No datasets are redistributed here. If you plan commercial distribution, review the upstream model and training-data terms yourself; this table is not legal advice.
- Evaluated but not shipped: dlib ResNet (shipped in 0.1.0; SFace found ~15% more photos at the same false-match level on the project benchmark); SFace int8 (same accuracy as fp32 but ~2× slower in ONNX Runtime Web); Human's FaceRes descriptor (separated identities poorly); Human's MobileFaceNet integration (constant descriptors in this version); InsightFace models (weights licensed for non-commercial research only).
- The full license texts of Human, SFace (OpenCV Zoo) and ONNX Runtime are copied to `dist/licenses/` at build time.
