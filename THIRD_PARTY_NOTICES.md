# Third-party notices

DotDial is MIT-licensed; the following components keep their own licenses. Packaged builds must preserve the license files shipped with their bundled runtimes and must not remove upstream model notices.

| Component | Version / use | License and notices |
| --- | --- | --- |
| Electron | 44.5.1; application runtime | MIT. The npm package includes `LICENSE`. |
| Chromium | Bundled inside Electron | Multiple upstream licenses. Preserve Electron's `LICENSES.chromium.html` in binary releases. |
| Node.js and V8 | Bundled inside Electron | Preserve the notices distributed with Electron. |
| Electron Packager | 20.3.0; build tooling | BSD-2-Clause; source package and transitive package notices are in npm metadata. |
| sherpa-onnx | 1.13.8; optional offline wake word | Apache-2.0. [Upstream project](https://github.com/k2-fsa/sherpa-onnx). |
| sounddevice | 0.5.6; optional wake-word audio input | MIT. [Upstream project](https://github.com/spatialaudio/python-sounddevice). |
| SentencePiece | 0.2.2; optional wake-word text model | Apache-2.0. [Upstream project](https://github.com/google/sentencepiece). |
| NumPy | 2.2.6; optional wake-word processing | BSD-3-Clause. [Upstream project](https://github.com/numpy/numpy). |
| Zipformer GigaSpeech wake-word model | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`; separately downloaded on request | Apache-2.0 according to the upstream archive metadata. [Model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models). The setup script verifies SHA-256 `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a` and extracts the upstream notice files. |

The wake-word model and Python environment are not included in the default application package. Installing that optional feature downloads the pinned packages and the model into the user's data directory. Python packages may include transitive dependencies with their own licenses; their installed distribution metadata and notices remain in that environment.

The source tree does not vendor Electron, Chromium, or the optional model. When preparing a release, compare this file with `package-lock.json`, the bundled Electron notice files, and the model archive actually used by the setup script.

The three telephone-style call cues in `src/sounds/` are original generated tones distributed under the project MIT license. They contain no third-party sound recordings.
