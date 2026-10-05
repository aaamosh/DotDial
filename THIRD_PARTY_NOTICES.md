# Third-party notices

DotDial is MIT-licensed; the following components keep their own licenses. Packaged builds must preserve the license files shipped with their bundled runtimes and must not remove upstream model notices.

| Component | Version / use | License and notices |
| --- | --- | --- |
| Electron | 44.5.1; application runtime | MIT. The npm package includes `LICENSE`. |
| Chromium | Bundled inside Electron | Multiple upstream licenses. Preserve Electron's `LICENSES.chromium.html` in binary releases. |
| Node.js and V8 | Bundled inside Electron | Preserve the notices distributed with Electron. |
| Electron Packager | 20.3.0; build tooling | BSD-2-Clause; source package and transitive package notices are in npm metadata. |
| Flite and its bundled `slt` voice | Commit `6c9f20dc915b17f5619340069889db0aa007fcdc`; test-only speech fixture generation | Upstream license and credits in [`COPYING` at the pinned commit](https://github.com/festvox/flite/blob/6c9f20dc915b17f5619340069889db0aa007fcdc/COPYING). [Upstream project](https://github.com/festvox/flite). |
| sherpa-onnx | 1.13.8; optional offline wake word | Apache-2.0. [Upstream project](https://github.com/k2-fsa/sherpa-onnx). |
| sounddevice | 0.5.6; optional wake-word audio input | MIT. [Upstream project](https://github.com/spatialaudio/python-sounddevice). |
| SentencePiece | 0.2.2; optional wake-word text model | Apache-2.0. [Upstream project](https://github.com/google/sentencepiece). |
| NumPy | 2.2.6; optional wake-word processing | BSD-3-Clause. [Upstream project](https://github.com/numpy/numpy). |
| Zipformer GigaSpeech wake-word model | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`; separately downloaded on request | Apache-2.0 according to the upstream archive metadata. [Model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models). The setup script verifies SHA-256 `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a` and extracts the upstream notice files. |

The wake-word model and Python environment are not included in the default application package. Installing that optional feature downloads the pinned packages and the model into the user's data directory. Python packages may include transitive dependencies with their own licenses; their installed distribution metadata and notices remain in that environment.

The source tree does not vendor Electron, Chromium, or the optional model. When preparing a release, compare this file with `package-lock.json`, the bundled Electron notice files, and the model archive actually used by the setup script.

Native wake-recognition QA uses Flite only to generate the synthetic phrases
`Hey Dot.` and `The weather is calm today.`. `scripts/prepare-wake-speech.py`
requires a clean checkout of the exact commit above and builds its bundled `slt`
voice privately, with audio output and network sockets disabled. It does not
download additional voices, install Flite system-wide or add text-to-speech to
DotDial. Flite source, build products and voices are not bundled in the application.
The generated fixture directory includes `provenance.json` with the source
revision, upstream `COPYING` hash, generator binary hash, selected voice, fixture
texts and WAV hashes. Preserve that provenance and the applicable upstream
license notices with redistributed test tooling or fixture artifacts.

`src/sounds/calling.wav` is a bit-for-bit copy of the full recorded 14.4 kbps modem negotiation `14400.WAV` by Ektoras Karagiannis (1997). `connected.wav` is a 0.30-second excerpt from the same recording (approximately 4.75–5.05 seconds). Internet Archive's item metadata declares the source CC0 1.0: [source item](https://archive.org/details/14400_201912), [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). `telephone.wav` preserves the former project telephone-style calling cue, `activated.wav` preserves the former connected cue, and `ended.wav` remains unchanged; these project-owned cues are distributed under the MIT license.

The original [WAV download](https://archive.org/download/14400_201912/14400.WAV) has SHA-256 `0359ba1636107f1ee5cef6c87c2293d90391dad3580f3a51834a37ac44ba14ce`. It contains mono 16-bit PCM at 11,025 Hz. The connected excerpt copies samples 52,370 through 55,675 without gain changes or resampling.
