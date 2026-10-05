# DotDial for macOS — Preview 2

**Your dot, one shortcut away. A little 1997 while it connects.**

This update improves optional local **Hey Dot** listening on macOS. Wake capture
now combines a silent audio sink with a requested Web Audio latency of **100 ms**
(`latencyHint: 0.1`). Its audio processing does not depend on the system speaker
output clock. The native checks exercise PCM flow, repeated pause/resume,
backpressure and cleanup with synthetic audio.

The menu-bar controls, **Command–Shift–Space** shortcut, local missed-reply
playback and original modem handshake remain available on Apple Silicon and
Intel Macs.

## Downloads

Choose your chip in **Apple menu → About This Mac**. Apple Silicon uses `arm64`;
Intel uses `x64`.

| Your Mac | Installer | ZIP alternative |
| --- | --- | --- |
| Apple Silicon, M-series | [Download DMG](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.2/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-arm64.dmg) | [Download app ZIP](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.2/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-arm64.app.zip) |
| Intel | [Download DMG](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.2/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-x64.dmg) | [Download app ZIP](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.2/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-x64.app.zip) |

Open the DMG, drag **DotDial.app** into **Applications**, then launch the installed
copy. To update from Preview 1, quit DotDial before replacing the application.
Add your dot URL in Settings and sign in through **Sign in / open ChatGPT**.
An existing ChatGPT account with access to a dot is required; no API key is needed.

**These builds are ad-hoc signed, without Apple Developer ID signing or
notarization.** If macOS blocks the first launch, follow
[Apple's instructions](https://support.apple.com/en-us/102445) for **System Settings
→ Privacy & Security → Open Anyway**. DotDial does not disable Gatekeeper.

Local wake recognition is off by default. Enabling it requires Python 3.10–3.13;
ordinary calls and the bundled CLI need no separate Node or Python installation.
When wake is enabled, local recognition continues while call microphone
transmission is muted. See the [installation and wake guide](https://github.com/aaamosh/DotDial/blob/{{SOURCE_COMMIT}}/docs/MACOS.md)
and [privacy guide](https://github.com/aaamosh/DotDial/blob/{{SOURCE_COMMIT}}/docs/PRIVACY.md).

## Verified scope and preview limits

Both architectures are built and checked on native macOS 15 runners. Publication
requires the unit suite, public-source audit and all **11 native package gates**
to pass, including signed entitlements, bundled CLI, synthetic media capture,
wake-model repair, the PCM pipeline, spoken wake recognition, runtime licenses
and DMG verification. See the [exact build and QA run]({{CI_RUN_URL}}).

The GUI test requires four fresh microphone captures in the same application
after its synthetic call closes, with bounded startup diagnostics and immediate
failure if any required capture fails. The original startup deadlines remain.

The PCM pipeline checks initial capture and four pause/resume cycles. It retains
the requirement for 25 acknowledged blocks within seven seconds and additionally
checks their steady cadence: the first-to-last span of 25 consecutive 100 ms
blocks must be **2.4 seconds, within 500 ms**. Acquisition time is excluded from
that cadence measurement. Restart is checked with 10 blocks and an expected
first-to-last span of **0.9 seconds**, with the same tolerance.

The declared minimum deployment target is **macOS 13 Ventura**. Binary metadata
is checked, but Ventura runtime testing remains outstanding. Automated checks
use synthetic audio; physical microphones and speakers, actual permission
denial/grant, sleep and unplug recovery, Login Items in a user session and real
account calls still need hands-on acceptance. Login startup can remain unavailable
in this ad-hoc preview.

DotDial is an unofficial companion using internal ChatGPT web-call routes, which
may change. Please treat this as an early public preview.

## Integrity and feedback

Source: [`{{SOURCE_COMMIT}}`](https://github.com/aaamosh/DotDial/commit/{{SOURCE_COMMIT}}).
Application version: **0.1.0-beta.3**. Each architecture has an attached build
manifest; [SHA256SUMS](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.2/SHA256SUMS)
covers all six distribution files. With those files in one directory, verify
them with `shasum -a 256 -c SHA256SUMS`.

Preview 2 has its own tag and files. The earlier
[Preview 1 release](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1)
is preserved separately.

[Report a problem](https://github.com/aaamosh/DotDial/issues) with your Mac chip,
macOS version, build revision and reproduction steps. Keep account credentials,
browser profiles and conversation recordings out of public reports.
