# Testing DotDial

Keep the unit suite, desktop integration checks and native package checks separate
in reports. A passing synthetic call does not establish access to ChatGPT or a
working physical microphone.

## Fast source checks

Use Node 22.12 or newer with the committed lockfile:

```sh
npm ci
npm test
npm run check:public
python3 -m py_compile scripts/setup-wake.py src/wake/listener.py \
  scripts/prepare-wake-speech.py scripts/smoke-macos-wake-speech.py
```

These checks use local fixtures. Do not add account credentials, live calls or
physical audio capture to CI.

## GitHub Actions

Both workflows run for pull requests, pushes to `main`, version tags matching
`v*`, and manual runs from the Actions tab. Pull-request checks use GitHub's
proposed merge commit, covering the changes together with the target branch.
The Linux workflow runs the source suite and verifies Linux packages. The macOS
workflow runs the same source suite and every native package gate on both
Apple Silicon and Intel.

A push to a feature branch with an open pull request gets one Linux workflow and
one macOS workflow through the pull-request event. It does not launch a second
copy through the push event. For a branch without a pull request, open a draft
pull request or request a manual run. Newer runs cancel older runs only for the
same workflow, event and ref; a manual run does not cancel an automatic run.

These workflows preserve build artifacts and reports. They do not publish
GitHub releases. The completed one-time publisher for the first macOS preview
is retained in the [released source](https://github.com/aaamosh/DotDial/blob/54889c5b04fe3dc32b79084d56bbec6e187a53de/.github/workflows/macos.yml),
and its script and regression tests remain in the repository. Removing that job
from active CI does not change the public tag or released files.

## Linux desktop integration

`scripts/run-linux-integration.py` runs the installed application and source media
smokes under a private Xvfb display, D-Bus session and PulseAudio null sink. It
keeps the real user home and puts test profiles, configuration, sockets and audio
state under a temporary directory. It does not load physical audio devices.

Provision a disposable Linux desktop or VM with Python 3, Xvfb, `dbus-daemon`,
PulseAudio, `pactl`, `parec` and the libraries required by the pinned Electron
runtime. Build with `npm run package` and install the generated Debian package.
Also prepare an **unbundled** copy of the same pinned Electron version for the
standalone source smokes. Electron's npm package may download that distribution
lazily; the explicit download command is:

```sh
node node_modules/electron/install.js
```

Both executables must have a working Chromium sandbox. The installed Debian
package provisions its own sandbox helper. Follow the host's supported sandbox
setup for the development distribution; the runner deliberately has no
`--no-sandbox` fallback. Run it as an ordinary user, with a `/proc` mounted for that
user's PID namespace. It rejects environments where it cannot attribute and
clean up its child processes reliably.

With the installed package at its default path, and a prepared development
Electron at the path below:

```sh
python3 scripts/run-linux-integration.py \
  --electron /opt/dotdial/dotdial-runtime \
  --source-electron /path/to/electron \
  --output-dir build/linux-qa/run-001
```

Use a new output directory for every run. The report distinguishes these stages:

| Stage | What it checks |
| --- | --- |
| `packaged` | Installed GUI, preload, saved settings, panel controls, local WebRTC and fake microphone cleanup. |
| `audio` | Actual synthetic output through the private PulseAudio sink, 0/500 ms playout settings, recording continuity and spectrum, queued reply playback and worker shutdown. |
| `recovery` | A local recovery fixture, challenge/retry behavior and concurrent configuration edits. |
| `wake-pipeline` | Optional real Electron capture/IPC/Python chain using the macOS PCM path, including a stalled reader and restart. |

Select a bounded rerun with `--stage packaged`, or repeat `--stage` to select
several checks. A nonzero child exit, missing/contradictory result, timeout,
oversized log, failed private service or leftover application process fails its
stage. The runner still collects other selected results and performs bounded
cleanup. Its private services are stopped at the end. Keep
`integration-report.json`, the logs and the generated screenshots together.

## Optional offline wake pipeline

Prepare a fresh wake environment before the integration run. This installation
step downloads the pinned model and Python dependencies:

```sh
python3 scripts/setup-wake.py --data-dir /path/to/qa-wake --stdin-audio
```

Add `--wake-data-dir /path/to/qa-wake` to the Linux runner. Subsequent pipeline
checks use the installed local model and environment; the smoke itself does not
install dependencies or contact an account.

Rerunning setup checks that the required model files exist and are nonempty. It
repairs an incomplete model installation from an archive with the pinned SHA-256.
This completeness check does not detect arbitrary byte corruption in an existing,
nonempty model file.

Linux uses a reproducible non-speech WAV containing 440 Hz bursts at 48 kHz.
macOS uses Chromium's built-in fake microphone, which generates 400 Hz beeps
without reading a temporary file through the audio-service sandbox. Both keep
the sandbox and DotDial's actual capture graph enabled. The graph supplies 16 kHz
mono float32 PCM in 6,400-byte chunks. The test checks nonzero finite samples,
acknowledged pipe writes, bounded pending audio, pause/resume, cleanup after a
deliberately stopped Python reader, and a fresh restart. It also requires no
wake event from the non-speech input. The report identifies which fixture ran.

Acknowledged writes establish that the pipe accepted audio. They do not prove
keyword recognition or measure recognition accuracy. The native decoder check
separately loads the real model, consumes synthetic PCM and checks a clean EOF.
The separate native speech check below tests recognition with generated speech;
a phrase spoken through a physical microphone and microphone permission still
need a manual test.

## Offline speech recognition fixtures

`scripts/prepare-wake-speech.py` builds [Flite](https://github.com/festvox/flite)
at commit `6c9f20dc915b17f5619340069889db0aa007fcdc` in a fresh, disposable
checkout. It uses the bundled `slt` voice to generate mono 16 kHz PCM16 WAV files
for **Hey Dot.** and **The weather is calm today.** The helper requires absolute
paths for `--flite-source` and `--output-dir`; the output directory must be new
and outside the Flite checkout. It rejects a different commit or a dirty checkout,
including ignored build outputs.

The generator does not install Flite system-wide, download extra voices, capture
a microphone or play audio. Its private build disables audio output, shared
libraries and network sockets. Cloning Flite is a separate preparation step that
needs network access; fixture generation itself is local. Flite is test tooling,
not text-to-speech functionality in DotDial. See its pinned
[license and provenance notice](../THIRD_PARTY_NOTICES.md).

`native_wake_speech` runs the extracted package's unmodified listener with the
native managed Python environment and pinned local model. At sensitivity **6**,
it requires these three results:

| Input recording | Configured wake phrase | Required result |
| --- | --- | --- |
| `Hey Dot.` | `Hey Dot` | At least one wake event. |
| `The weather is calm today.` | `Hey Dot` | No wake event. |
| The same `Hey Dot.` recording | `Purple Moon` | No wake event. |

Each case must report readiness and exit cleanly after EOF; a listener error fails
the check. Preserve `provenance.json`, generated WAV files and preparation logs
with the recognition report. Provenance records the source revision, license and
binary hashes, voice inventory, fixture text and WAV hashes.

These are recognition regression checks for one synthetic voice and fixed
phrases. They do not measure recognition accuracy across speakers, accents,
background noise or sensitivity settings. The speech test supplies PCM directly
to Python; the separate pipeline test exercises Electron capture and IPC.

## Native macOS acceptance

On a real Mac of the target architecture, use Python 3.10–3.13 and the build
prerequisites in [the macOS guide](MACOS.md#build-and-verify-from-source). From the
repository root, build the package, prepare speech fixtures, then run verification:

```sh
npm run package:macos

flite_source="$(mktemp -d "${TMPDIR:-/tmp}/dotdial-flite.XXXXXX")/source"
git clone --no-checkout https://github.com/festvox/flite.git "$flite_source"
git -C "$flite_source" checkout --detach 6c9f20dc915b17f5619340069889db0aa007fcdc
python3 scripts/prepare-wake-speech.py \
  --flite-source "$flite_source" \
  --output-dir "$PWD/build/qa-wake-speech"

node scripts/verify-macos-package.cjs
```

The example uses the default fixture directory, `build/qa-wake-speech`, which must
not already exist when preparation starts. For another run, use a fresh Flite
checkout and a new absolute output path, then set `DOTDIAL_WAKE_SPEECH_FIXTURES` to
that path when running the verifier. Fixture preparation must finish successfully
**before** `verify-macos-package.cjs`; missing fixtures cannot be treated as a
skipped passing check. Set `DOTDIAL_SMOKE_PYTHON` to an absolute supported Python
path if `python3` is not the interpreter you intend to use. Verification installs
the pinned wake dependencies and model in its temporary environment.

The verifier requires every stage to pass:

| Stage | What it checks |
| --- | --- |
| `electron_notices` | The extracted app contains the exact nonempty Electron MIT and Chromium license files from the pinned runtime. The mounted DMG is checked independently for the same bytes. |
| `deployment_targets` | The native target architecture slice in every Mach-O file in the bundle declares a macOS minimum of 13.0 or earlier. This inspects binary metadata; it does not run the app on Ventura or establish compatibility of unused foreign slices. |
| `signed_entitlements` | The signed identities and entitlements of the main app, generic Electron helper and native configuration-lock helper match their expected roles, including audio-input rights where required. This examines signed code, not only source plist files. |
| `native_config_lock` | The bundled native helper provides the required configuration-lock behavior. |
| `bundled_cli` | The installed CLI reads, saves and diagnoses configuration without system Node. |
| `gui_media_capture` | The packaged GUI, preload, settings, panel and synthetic media capture work together. |
| `packaged_worker` | The packaged media worker handles a local synthetic WebRTC session. |
| `native_wake_decoder` | The packaged installer repairs a deliberately removed required file in isolated test data; its restored hash matches the original. Native Python dependencies then load the real model and the listener consumes synthetic PCM with a clean EOF. |
| `native_wake_pipeline` | Electron capture, IPC and bounded PCM delivery reach the native Python listener, including four pause/resume cycles, stopped-reader cleanup and restart. |
| `native_wake_speech` | Generated speech produces the required positive and two negative recognition results described above. |
| `disk_image` | The DMG is readable and contains the verified application and Applications shortcut. |

The packaged GUI smoke waits for the application to show its settings window
before editing and reloading the form. DOM or preload readiness alone does not
establish that the first window has appeared. After reload, the existing page
readiness wait also requires two fresh animation frames before starting the
capture check. Screenshot capture still requires
settled fonts, the active section's final opacity and nonempty pixels within its
existing deadline. Its report includes bounded window, document and animation
state so a rendering timeout can be diagnosed without bypassing the assertion.

The pipeline loads the extracted package's capture/manager/listener code into a
development Electron of the same pinned version and uses native Python
dependencies. An independently bounded process supervisor cleans up even if its
Electron host crashes while the Python reader is stopped. Forced cleanup fails
the stage. Passing signature and entitlement checks does not grant microphone
permission or turn an ad-hoc signature into Developer ID signing or notarization.

Each resumed capture must deliver 25 acknowledged PCM blocks within seven seconds.
The pipeline measures this deadline with a monotonic clock and records bounded
PCM/acknowledgement timestamps together with the difference from wall-clock time.
These observations distinguish a delayed first block, a stalled stream and a
system-clock adjustment without reducing the required audio or extending the
deadline. The standalone smoke defaults to one resume cycle; use
`--resume-cycles 4` to match the native package verifier.

For a targeted investigation, `--observe-audio-clock` adds a bounded, read-only
Web Audio clock observer through Chromium's debugging protocol. Standard package
acceptance leaves it off: PCM timing remains available without attaching a
debugger to the capture window.

The macOS workflow runs natively on Apple Silicon and Intel. It preserves
`build/macos-qa/<architecture>/` even when a check fails. Its progress report
records every required stage, so one successful check cannot hide a failed one.
This guide defines the acceptance gates; it does not certify that a particular
revision has passed them. Consult that revision's complete native report.
See [the macOS guide](MACOS.md#build-and-verify-from-source) for prerequisites and
the distinction between ad-hoc signing, Developer ID signing and notarization.

Linux checks exercise shared behavior and can exercise the macOS PCM code path;
they cannot verify CoreAudio, TCC, native Login Items, macOS signatures or a DMG.
Native synthetic checks still do not replace an actual session covering first
launch, permission denial/grant, a physical microphone and speakers, sleep/wake,
microphone unplug/reconnect, login startup, a spoken wake phrase and a real account
call. Run that session on macOS 13 Ventura as well as a current supported version;
deployment metadata alone cannot substitute for a minimum-version runtime test.
Keep private account data and recordings out of test artifacts.
