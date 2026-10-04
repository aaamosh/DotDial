<p align="center"><img src="src/assets/dotdial.svg" width="80" height="80" alt="DotDial"></p>

# DotDial

**A little phone for your ChatGPT dot. Say "Hey Dot" and start talking.**

[![CI](https://github.com/aaamosh/DotDial/actions/workflows/ci.yml/badge.svg)](https://github.com/aaamosh/DotDial/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-7de0bb)](LICENSE) ![Linux x64 beta](https://img.shields.io/badge/Linux-x64_beta-91b7d5)

[Download the Debian/Ubuntu package](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.1/dotdial_0.1.0-beta.1_amd64.deb) · [Download the Linux x86_64 archive](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.1/DotDial-0.1.0-beta.1-linux-x64.tar.gz) · [Release page](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.1) · [SHA-256 checksums](https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.1/SHA256SUMS)

DotDial is a small Linux tray app with voice activation, quiet mode, and missed replies. One ordinary JSON file holds all settings, so your coding agent can configure it with its usual file tools. ChatGPT and Codex do not need to be installed or running.

This is an experimental, unofficial companion. It signs in to your existing ChatGPT account in its own window and calls a dot already available to that account. It is not an OpenAI product. The call adapter uses internal ChatGPT web routes, not a supported public voice API, so it can stop working when the web client changes. No API key is required.

## Preview

These images show the local synthetic demo. They are not live calls or real account screens.

![DotDial settings](docs/images/settings.png)

![Voice controls](docs/images/voice.png)

![Floating call panel](docs/images/panel.png)

## Features

- Start calls from the tray or the default `Ctrl+Alt+Space` shortcut. Optional offline English wake-word support is off by default.
- Mute the microphone and speakers independently from the tray or floating call panel.
- Save incoming replies as local WAV files while speakers are muted and recording is enabled. Replay them oldest first; a clip is removed only after full playback. DotDial does not archive microphone audio or create transcripts.
- Hear a real 1997 modem handshake while connecting. Choose telephone tones or your own local MP3/WAV in settings if you prefer. Custom sounds are not uploaded.
- Configure everything through the settings window or one [versioned JSON file](docs/AGENT.md). Agents can also inspect and control a running call through the local CLI.

When wake-word support is enabled, its recognizer continues to listen locally during calls, even while microphone transmission is muted. A recognized phrase can unmute the microphone and speakers. Review the [privacy notes](docs/PRIVACY.md) before enabling it.

## Install the beta

DotDial 0.1.0-beta.1 is built for Linux x86_64. Electron 44.5.1 provides the desktop runtime. The `.deb` is for Debian/Ubuntu; the archive installer works on Linux distributions with the required Electron desktop libraries.

### Debian or Ubuntu

```sh
curl -fL -o dotdial_0.1.0-beta.1_amd64.deb https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.1/dotdial_0.1.0-beta.1_amd64.deb
sudo apt install ./dotdial_0.1.0-beta.1_amd64.deb
```

### Other Linux x86_64 distributions

```sh
curl -fL -o DotDial-0.1.0-beta.1-linux-x64.tar.gz https://github.com/aaamosh/DotDial/releases/download/v0.1.0-beta.1/DotDial-0.1.0-beta.1-linux-x64.tar.gz
tar -xzf DotDial-0.1.0-beta.1-linux-x64.tar.gz
./DotDial-linux-x64/install.sh
```

The archive installer requests `sudo`, installs under `/opt/dotdial`, and adds a desktop-menu entry and the `dotdial` command. After installation, launch DotDial from the desktop menu or run `dotdial`. Do not launch the binary directly from the extracted archive: the archive cannot preserve the root-owned Chromium sandbox file required on Ubuntu. The archive installer only supports a clean install; use the Debian package manager for upgrades.

### First call

Open **Settings**, paste your dot profile URL, and choose **Save and continue**. Sign in through **Sign in / open ChatGPT** using an account that has access to the dot. Start a call from the tray menu or use the configured hotkey.

### Optional wake word

Wake-word support is disabled by default. To enable it, open **Settings → Voice**, enable the wake word, and choose **Install or check wake-word support**. This downloads the pinned Python dependencies and English model only when requested. Setup requires Python 3, a virtual-environment package, and PortAudio; on Debian/Ubuntu, install them with:

```sh
sudo apt install python3 python3-venv libportaudio2
```

The example phrase is **Hey Dot**. Phrase and sensitivity changes apply immediately, including during a call. Sensitivity may need adjustment for your microphone and voice. From a source checkout, `npm run wake:setup` runs the same installer. See [third-party notices](THIRD_PARTY_NOTICES.md) for model and dependency details.

## Run from source

Requirements: Node.js 22.12 or later, npm, and a Linux x86_64 desktop session.

```sh
git clone https://github.com/aaamosh/DotDial.git
cd DotDial
npm ci
npm run demo
```

The demo is a credential-free visual preview. It uses synthetic data and does not sign in, contact ChatGPT, start a call, or access a microphone. To run the actual desktop app from the checkout, use `npm start`.

## Local files and uninstall

DotDial keeps settings, its sign-in profile, recordings, and diagnostics on your device. Default paths follow `config.cjs` and the XDG Base Directory variables:

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
