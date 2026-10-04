<p align="center"><img src="src/assets/dotdial.svg" width="80" height="80" alt="DotDial"></p>

# DotDial

**Say "Hey Dot." Leave the keyboard behind.**

[![CI](https://github.com/aaamosh/DotDial/actions/workflows/ci.yml/badge.svg)](https://github.com/aaamosh/DotDial/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-7de0bb)](LICENSE) ![Linux x64 beta](https://img.shields.io/badge/Linux-x64_beta-91b7d5) [![macOS preview](https://img.shields.io/badge/macOS-Apple_Silicon_%26_Intel_preview-91b7d5)](docs/MACOS.md)

[Download the Debian/Ubuntu package](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/dotdial_0.1.0-beta.3_amd64.deb) · [Download the Linux x86_64 archive](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/DotDial-0.1.0-beta.3-linux-x64.tar.gz) · [Release page](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3) · [SHA-256 checksums](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.3/SHA256SUMS)

Cooking, stretching, or thinking out loud on the sofa? Call your ChatGPT dot without reaching for your laptop. Once voice activation is set up, say **"Hey Dot"** from wherever your microphone can hear you. DotDial starts the call; you keep doing what you were doing.

DotDial lives in your Linux tray or macOS menu bar, ready when you are. ChatGPT and Codex do not need to be installed or running. Sign in with the account that already has your dot; no API key is required.

**Voice when your hands are busy. Saved replies when your ears are busy. A little 1997 while the call connects.**

## More conversation, less reaching for the laptop

- **Your voice is the call button.** Enable the optional offline English wake word and call from the kitchen counter, the sofa, or across the room, within your microphone's range. Use **Hey Dot** or choose your own supported English phrase. Tray and hotkey controls are there too.
- **Mute now. Catch up later.** Need the room quiet? Mute DotDial's speakers and let it save incoming replies locally while recording is enabled. Play them all back in order when you are ready. Fully played replies delete themselves, like an answering machine that tidies up after you.
- **Come back with a word.** During a call, the wake phrase turns a muted microphone and speakers back on, with a short confirmation sound. You can rejoin the conversation without touching the laptop.
- **Three buttons, right where you left them.** A small floating panel gives you microphone mute, speaker mute, and hang up. Drag it where it suits you; it remembers its position next time.
- **Easy for you. Easy for your agent.** Use the settings window or let your coding agent edit one ordinary [JSON file](docs/AGENT.md) with its usual tools. The local CLI can also check call status, call, hang up, mute, and replay missed replies.

Wake-word support is off by default. [Set it up once](#optional-wake-word), then leave DotDial running in the tray. Recognition happens on your device; how far away you can speak depends on your microphone and the room. While enabled, the recognizer also listens during calls with microphone transmission muted. See [Privacy](docs/PRIVACY.md) for details.

## Your AI has a dial-up phase

That sound while the call connects? **A real 14.4 kbps modem handshake, recorded in 1997.** The original recording plays by default, bringing a small piece of dial-up history to your next conversation. It stops as soon as the call connects.

Love the nostalgia? Leave it on. Prefer something else? In **Settings → Voice**, switch to telephone tones, choose your own **MP3 or WAV**, or turn call sounds off. There is a preview and volume control, so you can find a sound you actually enjoy.

[Listen to the original recording](https://archive.org/details/14400_201912) · [Recording credits and CC0 license](THIRD_PARTY_NOTICES.md)

## A small app for the way you talk

These previews use the local synthetic demo, so no real account or conversation is shown.

![Floating call panel: microphone, speakers, and hang up](docs/images/panel.png)

![DotDial settings](docs/images/settings.png)

![Voice activation and sound choices](docs/images/voice.png)

## Install the beta

You need **Linux x86_64** or **macOS 13+** (Apple Silicon or Intel), and a ChatGPT account that already has a dot. DotDial is an unofficial community project, not an OpenAI product. This beta uses internal ChatGPT web routes rather than a supported public voice API, so service changes can affect compatibility.

DotDial 0.1.0-beta.3 bundles Electron 44.5.1. The `.deb` is for Debian/Ubuntu; the archive installer works on Linux distributions with the required Electron desktop libraries.

For an upgrade, choose **Quit** in the tray before installing, then relaunch DotDial. Use the CLI from the same release as the desktop app; older and newer versions must not write the same config concurrently.

### macOS preview

Native `.app.zip` and `.dmg` previews are built for Apple Silicon and Intel. See
[macOS installation, microphone permission and wake setup](docs/MACOS.md). These
preview builds are ad-hoc signed, not Developer ID signed or notarized. Linux
release downloads above remain unchanged.

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

Open **Settings**, paste your dot profile URL, and choose **Save settings**. Sign in through **Sign in / open ChatGPT** using an account that has access to the dot. Start a call from the tray menu or use the configured hotkey.

### Optional wake word

For macOS, follow the [native wake setup](docs/MACOS.md#optional-local-wake-word).
The instructions below are for Linux.

Wake-word support is disabled by default. To enable it, open **Settings → Voice**, enable the wake word, choose **Save changes**, then choose **Install or check wake-word support**. Saving enables listening after the local model and dependencies are installed; installation alone does not turn wake listening on. The tray indicates when local listening is active. Under **Audio devices**, you can choose a wake input separately from the call microphone; scanning reads PortAudio device names without opening a microphone stream. Setup downloads the pinned Python dependencies and English model only when requested. Setup requires Python 3, a virtual-environment package, and PortAudio; on Debian/Ubuntu, install them with:

```sh
sudo apt install python3 python3-venv libportaudio2
```

The example phrase is **Hey Dot**. Phrase and sensitivity changes apply immediately, including during a call. Sensitivity may need adjustment for your microphone and voice. From a source checkout, `npm run wake:setup` runs the same installer. See [third-party notices](THIRD_PARTY_NOTICES.md) for model and dependency details.

## Run from source

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

DotDial keeps settings, its sign-in profile, recordings, and diagnostics on your device. Linux defaults follow `config.cjs` and the XDG Base Directory variables.
macOS uses Application Support and Caches; see [macOS files and CLI](docs/MACOS.md#local-files-and-cli).

| Data | Default path |
| --- | --- |
| Settings | `${XDG_CONFIG_HOME:-~/.config}/dotdial/config.json` |
| Logs and call/window state | `${XDG_STATE_HOME:-~/.local/state}/dotdial/` |
| Browser profile, recordings, wake model and environment | `${XDG_DATA_HOME:-~/.local/share}/dotdial/` |
| Diagnostic cache path | `${XDG_CACHE_HOME:-~/.cache}/dotdial/` |
| Runtime socket and temporary audio | `${XDG_RUNTIME_DIR:-/run/user/<uid>}/dotdial/` |

The package manager removes the Debian/Ubuntu install with `sudo apt remove dotdial`. To remove an archive install, quit DotDial and remove the paths created by the installer: `/opt/dotdial`, `/usr/bin/dotdial`, `/usr/share/applications/dotdial.desktop`, and `/usr/share/icons/hicolor/scalable/apps/dotdial.svg`. Uninstalling does not erase user data or recordings. See [Privacy](docs/PRIVACY.md) for retention and deletion details, and the [configuration guide](docs/AGENT.md) for paths, settings, and the local CLI.

## Contributing and security

See [Contributing](CONTRIBUTING.md) for local checks and [Security](SECURITY.md) for private vulnerability reports. DotDial is distributed under the [MIT License](LICENSE); third-party components keep their own notices and licenses.
