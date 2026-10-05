<p align="center"><img src="src/assets/dotdial.svg" width="80" height="80" alt="DotDial"></p>

# DotDial

**Say "Hey Dot." Leave the keyboard behind.**

[![CI](https://github.com/aaamosh/DotDial/actions/workflows/ci.yml/badge.svg)](https://github.com/aaamosh/DotDial/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-7de0bb)](LICENSE) ![Linux x64 beta](https://img.shields.io/badge/Linux-x64_beta-91b7d5) [![macOS preview](https://img.shields.io/badge/macOS-Apple_Silicon_%26_Intel_preview-91b7d5)](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1)

| Platform | Release | Downloads |
| --- | --- | --- |
| Linux x86_64 | [0.1.0-beta.3](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3) | [Debian/Ubuntu package](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/dotdial_0.1.0-beta.3_amd64.deb) · [Linux archive](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/DotDial-0.1.0-beta.3-linux-x64.tar.gz) |
| macOS, Apple Silicon (`arm64`) | [Preview 1](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1) | [DMG](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-54889c5b-macos-arm64.dmg) · [App ZIP](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-54889c5b-macos-arm64.app.zip) |
| macOS, Intel (`x64`) | [Preview 1](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1) | [DMG](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-54889c5b-macos-x64.dmg) · [App ZIP](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/DotDial-0.1.0-beta.3-preview-54889c5b-macos-x64.app.zip) |

SHA-256 checksums: [Linux](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/SHA256SUMS) · [macOS](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3-macos-preview.1/SHA256SUMS). The macOS builds are early previews with ad-hoc signatures, without Apple Developer ID signing or notarization. See the [macOS installation notes](#macos-preview) before downloading.

Cooking, stretching, or thinking out loud on the sofa? Call your ChatGPT dot without reaching for your laptop. Once voice activation is set up, say **"Hey Dot"** from wherever your microphone can hear you. DotDial starts the call; you keep doing what you were doing.

DotDial lives in your Linux tray or, with the new macOS preview, your Mac's menu bar. ChatGPT and Codex do not need to be installed or running. Sign in with the account that already has your dot; no API key is required.

**Voice when your hands are busy. Saved replies when your ears are busy. A little 1997 while the call connects.**

## More conversation, less reaching for the laptop

- **Your voice is the call button.** Enable the optional offline English wake word and call from the kitchen counter, the sofa, or across the room, within your microphone's range. Use **Hey Dot** or choose your own supported English phrase. Tray, menu-bar and hotkey controls are there too.
- **Mute now. Catch up later.** Need the room quiet? Mute DotDial's speakers and let it save incoming replies locally while recording is enabled. Play them all back in order when you are ready. Fully played replies delete themselves, like an answering machine that tidies up after you.
- **Come back with a word.** During a call, the wake phrase turns a muted microphone and speakers back on, with a short confirmation sound. You can rejoin the conversation without touching the laptop.
- **Three buttons, right where you left them.** A small floating panel gives you microphone mute, speaker mute, and hang up. Drag it where it suits you; it remembers its position next time.
- **Easy for you. Easy for your agent.** Use the settings window or let your coding agent edit one ordinary [JSON file](docs/AGENT.md) with its usual tools. The local CLI can also check call status, call, hang up, mute, and replay missed replies.

Wake-word support is off by default. [Set it up once](#optional-wake-word), then leave DotDial running in the tray or menu bar. Recognition happens on your device; how far away you can speak depends on your microphone and the room. While enabled, the recognizer also listens during calls with microphone transmission muted. See the [Linux privacy guide](docs/PRIVACY.md) or the [macOS preview privacy guide](https://github.com/aaamosh/DotDial/blob/54889c5b04fe3dc32b79084d56bbec6e187a53de/docs/PRIVACY.md) for details.

## Your AI has a dial-up phase

That sound while the call connects? **A real 14.4 kbps modem handshake, recorded in 1997.** The original recording plays by default, bringing a small piece of dial-up history to your next conversation. It stops as soon as the call connects.

Love the nostalgia? Leave it on. Prefer something else? In **Settings → Voice**, switch to telephone tones, choose your own **MP3 or WAV**, or turn call sounds off. There is a preview and volume control, so you can find a sound you actually enjoy.

[Listen to the original recording](https://archive.org/details/14400_201912) · [Recording credits and CC0 license](THIRD_PARTY_NOTICES.md)

## A small app for the way you talk

The screenshots below and the 18-second video use the Linux synthetic demo. They show no real account or conversation and are not a recording of a macOS call. The new share card describes availability on both platforms.

[Watch the 18-second Linux UI preview](docs/media/dotdial-preview-18s.mp4) · [Download the Linux and macOS share card](docs/media/dotdial-platforms-card.png) · [Media credits](docs/media/README.md)

![Floating call panel: microphone, speakers, and hang up](docs/images/panel.png)

![DotDial settings](docs/images/settings.png)

![Voice activation and sound choices](docs/images/voice.png)

## Install the beta

Choose the **Linux x86_64 beta** or the **macOS preview for Apple Silicon or Intel**, and use a ChatGPT account that already has a dot. DotDial is an unofficial community project, not an OpenAI product. It uses internal ChatGPT web routes rather than a supported public voice API, so service changes can affect compatibility.

Both releases use application version 0.1.0-beta.3 and bundle Electron 44.5.1. The Linux `.deb` is for Debian/Ubuntu; the Linux archive installer works on distributions with the required Electron desktop libraries.

For an upgrade, choose **Quit** in the tray or menu bar before installing, then relaunch DotDial. Use the CLI from the same release as the desktop app; older and newer versions must not write the same config concurrently.

### macOS preview

Choose **Apple Silicon (`arm64`)** or **Intel (`x64`)** in the download table. Open the DMG, drag **DotDial.app** into **Applications**, eject the image, then launch the installed copy. The ZIP contains the same application as an alternative. Ordinary calls and the bundled CLI need no separate Node or Python installation.

These builds are **ad-hoc signed, without Apple Developer ID signing or notarization**. If the first launch is blocked, follow [Apple's instructions](https://support.apple.com/en-us/102445) for **System Settings → Privacy & Security → Open Anyway**. DotDial does not disable Gatekeeper. Grant microphone access when prompted. Start a call from the menu bar or use the default **Command–Shift–Space** shortcut.

The minimum binary deployment target is **macOS 13 Ventura**. Both architectures passed [native build and package checks on macOS 15](https://github.com/aaamosh/DotDial/actions/runs/37298082128); Ventura runtime behavior, physical audio devices, real permission prompts, sleep/unplug recovery and real ChatGPT account calls still need hands-on acceptance. **Start at login may remain unavailable** with this preview's signature. Treat this as an early public preview.

Read the [macOS installation, wake setup, local files and CLI guide](https://github.com/aaamosh/DotDial/blob/54889c5b04fe3dc32b79084d56bbec6e187a53de/docs/MACOS.md) for the exact published source. The [preview release notes](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1) include build manifests and the remaining acceptance checks.

### Debian or Ubuntu

```sh
curl -fL -o dotdial_0.1.0-beta.3_amd64.deb https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/dotdial_0.1.0-beta.3_amd64.deb
sudo apt install ./dotdial_0.1.0-beta.3_amd64.deb
```

### Other Linux x86_64 distributions

```sh
curl -fL -o DotDial-0.1.0-beta.3-linux-x64.tar.gz https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/DotDial-0.1.0-beta.3-linux-x64.tar.gz
tar -xzf DotDial-0.1.0-beta.3-linux-x64.tar.gz
./DotDial-linux-x64/install.sh
```

The archive installer requests `sudo`, installs under `/opt/dotdial`, and adds a desktop-menu entry and the `dotdial` command. After installation, launch DotDial from the desktop menu or run `dotdial`. Do not launch the binary directly from the extracted archive: the archive cannot preserve the root-owned Chromium sandbox file required on Ubuntu. The archive installer only supports a clean install; use the Debian package manager for upgrades.

### First call

Open **Settings**, paste your dot profile URL, and choose **Save settings**. Sign in through **Sign in / open ChatGPT** using an account that has access to the dot. Start a call from the tray or menu bar, or use the configured hotkey.

### Optional wake word

On macOS, follow the [published preview's wake setup guide](https://github.com/aaamosh/DotDial/blob/54889c5b04fe3dc32b79084d56bbec6e187a53de/docs/MACOS.md#optional-local-wake-word). Wake requires Python **3.10–3.13** and the optional English model; Python 3.14 is not supported by this dependency set. macOS captures wake audio through the app's Electron audio layer. The instructions below are for **Linux**.

Wake-word support is disabled by default. To enable it, open **Settings → Voice**, enable the wake word, choose **Save changes**, then choose **Install or check wake-word support**. Saving enables listening after the local model and dependencies are installed; installation alone does not turn wake listening on. The tray indicates when local listening is active. Under **Audio devices**, you can choose a wake input separately from the call microphone; scanning reads PortAudio device names without opening a microphone stream. Setup downloads the pinned Python dependencies and English model only when requested. Setup requires Python 3, a virtual-environment package, and PortAudio; on Debian/Ubuntu, install them with:

```sh
sudo apt install python3 python3-venv libportaudio2
```

The example phrase is **Hey Dot**. Phrase and sensitivity changes apply immediately, including during a call. Sensitivity may need adjustment for your microphone and voice. From a source checkout, `npm run wake:setup` runs the same installer. See [third-party notices](THIRD_PARTY_NOTICES.md) for model and dependency details.

## Run from source

The source tree supports Linux and macOS. See the [macOS source-build guide](docs/MACOS.md#build-and-verify-from-source) for native packaging and verification. The published macOS Preview 1 was built from revision [`54889c5b04fe3dc32b79084d56bbec6e187a53de`](https://github.com/aaamosh/DotDial/commit/54889c5b04fe3dc32b79084d56bbec6e187a53de); later source changes are not part of those downloads.

Requirements: Node.js 22.12 or later, npm, and a Linux x86_64 or macOS 13+ desktop session.
Linux also requires `flock` from util-linux.
macOS source builds also require Apple's command-line developer tools (`cc`); the packaged app does not.

```sh
git clone https://github.com/aaamosh/DotDial.git
cd DotDial
npm ci
npm run demo
```

The demo is a credential-free visual preview. It uses synthetic data and does not sign in, contact ChatGPT, start a call, or access a microphone. To run the actual desktop app from the checkout, use `npm start`.

## Local files and uninstall

DotDial keeps settings, its sign-in profile, recordings, and diagnostics on your device. The **Linux** default paths follow `config.cjs` and the XDG Base Directory variables:

| Data | Default path |
| --- | --- |
| Settings | `${XDG_CONFIG_HOME:-~/.config}/dotdial/config.json` |
| Logs and call/window state | `${XDG_STATE_HOME:-~/.local/state}/dotdial/` |
| Browser profile, recordings, wake model and environment | `${XDG_DATA_HOME:-~/.local/share}/dotdial/` |
| Diagnostic cache path | `${XDG_CACHE_HOME:-~/.cache}/dotdial/` |
| Runtime socket and temporary audio | `${XDG_RUNTIME_DIR:-/run/user/<uid>}/dotdial/` |

The package manager removes the Debian/Ubuntu install with `sudo apt remove dotdial`. To remove an archive install, quit DotDial and remove the paths created by the installer: `/opt/dotdial`, `/usr/bin/dotdial`, `/usr/share/applications/dotdial.desktop`, and `/usr/share/icons/hicolor/scalable/apps/dotdial.svg`. Uninstalling does not erase user data or recordings. See [Privacy](docs/PRIVACY.md) for retention and deletion details, and the [configuration guide](docs/AGENT.md) for paths, settings, and the local CLI.

On **macOS**, settings and saved replies live under `~/Library/Application Support/DotDial/`, and cache under `~/Library/Caches/DotDial/`. To remove the app, turn off Start at login, quit DotDial and move the application to Trash. User data remains. Follow the [macOS update, rollback and removal guide](https://github.com/aaamosh/DotDial/blob/54889c5b04fe3dc32b79084d56bbec6e187a53de/docs/MACOS.md#update-rollback-and-remove) for the exact paths and optional data deletion.

## Contributing and security

See [Contributing](CONTRIBUTING.md) for local checks and [Security](SECURITY.md) for private vulnerability reports. DotDial is distributed under the [MIT License](LICENSE); third-party components keep their own notices and licenses.
