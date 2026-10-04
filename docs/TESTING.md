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
python3 -m py_compile scripts/setup-wake.py src/wake/listener.py
```

These checks use local fixtures. Do not add account credentials, live calls or
physical audio capture to CI.

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
A positive spoken wake phrase and microphone permission need a manual test.

## Native macOS acceptance

On a real Mac of the target architecture, build and verify the package:

```sh
npm run package:macos
node scripts/verify-macos-package.cjs
```

The verifier requires all stages to pass: native configuration lock, bundled CLI
without system Node, packaged GUI/media capture, packaged media worker, native
wake decoder, native wake pipeline, and DMG verification. The pipeline loads the
extracted package's capture/manager/listener code into a development Electron of
the same pinned version and uses native Python dependencies. An independently
bounded process supervisor cleans up even if its Electron host crashes while
the Python reader is stopped. Forced cleanup fails the stage.

The macOS workflow runs natively on Apple Silicon and Intel. It preserves
`build/macos-qa/<architecture>/` even when a check fails. Its progress report
records every required stage, so one successful check cannot hide a failed one.
See [the macOS guide](MACOS.md#build-and-verify-from-source) for prerequisites and
the distinction between ad-hoc signing, Developer ID signing and notarization.

Linux checks exercise shared behavior and can exercise the macOS PCM code path;
they cannot verify CoreAudio, TCC, native Login Items, macOS signatures or a DMG.
Native synthetic checks still do not replace an actual session covering first
launch, permission denial/grant, a physical microphone and speakers, sleep/wake,
login startup, a spoken wake phrase and a real account call. Keep private account
data and recordings out of test artifacts.
