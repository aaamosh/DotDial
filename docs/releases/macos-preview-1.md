# DotDial for macOS — first public preview

**Your dot, one shortcut away. A little 1997 while it connects.**

DotDial is now available as a native macOS preview for Apple Silicon and Intel.
Keep it in the menu bar, call with **Command–Shift–Space**, and catch up on locally
saved replies when you are ready. The original 1997 modem handshake is here too.

## Downloads

Choose your chip in **Apple menu → About This Mac**. Apple Silicon uses the native
`arm64` build; Intel uses `x64`.

| Your Mac | Installer | ZIP alternative |
| --- | --- | --- |
| Apple Silicon, M-series | [Download DMG](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-arm64.dmg) | [Download app ZIP](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-arm64.app.zip) |
| Intel | [Download DMG](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-x64.dmg) | [Download app ZIP](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-{{SOURCE_SHORT}}-macos-x64.app.zip) |

Open the DMG, drag **DotDial.app** into **Applications**, then launch the installed
copy. Add your dot URL in Settings and sign in through **Sign in / open ChatGPT**.
An existing ChatGPT account with access to a dot is required; no API key is needed.

**These builds are ad-hoc signed, without Apple Developer ID signing or
notarization.** If macOS blocks the first launch, follow
[Apple's instructions](https://support.apple.com/en-us/102445) for **System Settings
→ Privacy & Security → Open Anyway**. DotDial does not disable Gatekeeper.

## What's included

- Native menu-bar controls and the default **Command–Shift–Space** shortcut.
- Separate microphone, speaker and hangup controls in a floating panel.
- Local missed-reply playback and the original modem sounds, with sound choices
  and volume controls in Settings.
- Optional local **Hey Dot** wake recognition. It is off by default and requires
  Python 3.10–3.13; ordinary calls and the bundled CLI need no separate Node or
  Python installation.
- macOS microphone permission handling, native configuration locking, and Login
  Item status reporting. Login startup can remain unavailable in this ad-hoc preview.
- Electron and Chromium license texts included in each application bundle.

## Verified scope and preview limits

Both architectures are built and checked on native macOS 15 runners. Publication
requires the unit suite, public-source audit and all **11 native package gates**
to pass, including signed entitlements, bundled CLI, synthetic media capture,
wake-model repair, the PCM pipeline, spoken wake recognition, runtime licenses
and DMG verification. See the [exact build and QA run]({{CI_RUN_URL}}).

The minimum deployment target is **macOS 13 Ventura**. Binary metadata is checked,
but Ventura runtime testing is still outstanding. Automated checks use synthetic
audio; physical microphones and speakers, actual permission denial/grant, sleep
and unplug recovery, Login Items in a user session and real account calls still
need hands-on acceptance. Please treat this as an early public preview.

DotDial is an unofficial companion using internal ChatGPT web-call routes, which
may change. When wake is enabled, local recognition continues while call microphone
transmission is muted. Read the [installation and wake guide](https://github.com/aaamosh/DotDial/blob/{{SOURCE_COMMIT}}/docs/MACOS.md)
and [privacy guide](https://github.com/aaamosh/DotDial/blob/{{SOURCE_COMMIT}}/docs/PRIVACY.md)
before enabling it.

## Integrity and feedback

Source: [`{{SOURCE_COMMIT}}`](https://github.com/aaamosh/DotDial/commit/{{SOURCE_COMMIT}}).
Application version: **0.1.0-beta.3**. Each architecture has an attached build
manifest; [SHA256SUMS](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/SHA256SUMS)
covers every distribution file. With all six files in one directory, verify them
with `shasum -a 256 -c SHA256SUMS`.

[Report a problem](https://github.com/aaamosh/DotDial/issues) with your Mac chip,
macOS version, build revision and reproduction steps. Keep account credentials,
browser profiles and conversation recordings out of public reports.
