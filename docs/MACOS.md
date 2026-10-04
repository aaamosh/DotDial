# DotDial for macOS

The macOS preview uses the same call, saved-reply and configuration implementation
as the Linux app. It adds native menu-bar controls, macOS microphone permission,
Login Items, local audio cues and application bundles for both Mac architectures.

## Requirements and downloads

- macOS 13 Ventura or newer, as required by the pinned Electron 44.5.1 runtime.
- Apple Silicon (`arm64`, M-series chips) or Intel (`x64`). Choose the matching
  download in **Apple menu → About This Mac**; Rosetta is not needed for the native
  Apple Silicon build.
- A ChatGPT account that already has access to a dot. Calls use ChatGPT online and
  the existing internal web-call adapter. DotDial is an unofficial companion.
- Python is optional and is used only for the wake-word recognizer. Normal calls,
  hotkeys, sounds and saved replies do not need a system Node or Python install.

Preview installers are produced by the [macOS workflow](../.github/workflows/macos.yml).
Open the successful run for the branch/commit being tested and download the
`dotdial-macos-arm64-preview-<revision>` or
`dotdial-macos-x64-preview-<revision>` artifact. Each contains a `.dmg`, an
application `.zip`, `SHA256SUMS` and a build manifest. The file name contains the
source revision so a preview cannot be mistaken for a tagged release.

These builds have a local **ad-hoc code signature**. They do **not** have an Apple
Developer ID certificate and are **not notarized**. The signature is checked during
packaging; it does not establish publisher identity or make Gatekeeper approval
automatic. Use only an installer from the intended repository/run and compare its
SHA-256 with the accompanying checksums.

## Install and make the first call

1. Open the matching DMG and drag **DotDial.app** into **Applications**. Eject the
   disk image, then open the installed copy. A ZIP download is an alternative:
   unpack it and move the app into Applications.
2. If macOS blocks this unnotarized preview, use **System Settings → Privacy &
   Security → Open Anyway** after attempting to open it, following [Apple's
   instructions](https://support.apple.com/en-us/102445). This is approval for this
   application. The installer does not disable Gatekeeper or remove quarantine.
3. Open DotDial settings from the menu bar. Paste your dot profile URL, save it,
   and sign in through **Sign in / open ChatGPT**.
4. Start a call from the menu or press **Command–Shift–Space** (the macOS default
   `Command+Shift+Space` shortcut). Grant the native microphone prompt when
   requested. A call that starts with its microphone muted need not request capture
   until you unmute it.
5. The floating panel controls microphone, speakers and hangup separately. Closing
   settings keeps DotDial available in the menu bar. Use **Quit DotDial** to exit.

If microphone access was denied, enable **DotDial** under **System Settings →
Privacy & Security → Microphone**, then quit and reopen the app. A managed Mac can
restrict this permission. The ordinary call shortcut does not require a blanket
Accessibility grant. If macOS or another app owns your shortcut, select a different
one in DotDial settings. Existing configured shortcuts are retained. In particular,
`CommandOrControl+Alt+Space` inherited from Linux becomes Command–Option–Space on
Mac, which conflicts with the standard Finder search shortcut; change it if needed.

A command received through the local CLI cannot wait indefinitely for a native
permission dialog. If it reports `microphone_permission_required`, finish granting
permission in DotDial, then issue the command again. A failed CLI command must not
start a call later when a prompt finally resolves.

## Optional local wake word

Wake is off by default. On macOS, DotDial's Electron audio layer captures the
selected microphone locally and sends bounded PCM audio to its local Python
recognizer. Python does not open a separate CoreAudio microphone. The recognizer
uses the same pinned English model as Linux; its audio is not sent to a cloud
recognition service.

Install **Python 3.10–3.13** if you want wake support. Python 3.12 is a suitable
choice. DotDial looks for a supported Homebrew interpreter when launched from
Finder; you can also select an absolute interpreter path in **Settings → Voice**.
This selects the Python used to create DotDial's private wake environment; after
installation, the recognizer runs from that environment with its pinned packages.
For an existing Homebrew installation:

```sh
brew install python@3.12
```

DotDial does not install Homebrew or modify the system Python. Python 3.14 is not
accepted by this pinned dependency set. If you use another Python distribution,
enter the path to its supported interpreter explicitly.

In Voice settings, enable wake, choose the input/phrase, **save the settings**, then
select **Install or check wake-word support**. The installer downloads the pinned
dependencies and model only on request. Wait for the listening indication and test
the phrase. Check the displayed permission or interpreter error if setup cannot
start. Device and wake changes during a busy call follow the app's existing live
configuration rules.

When enabled, wake continues listening locally during calls even if transmission
to the dot is muted. The wake phrase can re-enable microphone and speakers. Turn
wake off and save if you do not want local listening. See [Privacy](PRIVACY.md).

## Start at login

Enable **Start at login** in the installed application. DotDial uses macOS Login
Items and reports when the operating system requires approval. Check **System
Settings → General → Login Items & Extensions** if necessary.

Reliable native Login Items require a Developer ID signed and notarized application,
according to [Electron documentation](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows).
This ad-hoc preview can remain unavailable for login startup; the UI reports the
observed system status rather than treating a saved checkbox as success.

Source checkouts and custom command-line configurations/launchers are not silently
registered as ordinary login items. The setting shows a specific explanation for
these cases. Install the standard `.app` and use its normal configuration for
native login startup.

## Local files and CLI

| Purpose | macOS default |
| --- | --- |
| Settings | `~/Library/Application Support/DotDial/config.json` |
| Call/window state and diagnostics | `~/Library/Application Support/DotDial/state/` |
| Browser profile | `~/Library/Application Support/DotDial/data/profile/` |
| Saved replies | `~/Library/Application Support/DotDial/data/recordings/` |
| Wake model and Python environment | `~/Library/Application Support/DotDial/data/` |
| Cache | `~/Library/Caches/DotDial/` |
| Socket and temporary audio | `<per-user temporary directory>/dotdial-<uid>/` |

Explicit XDG root overrides retain their Linux semantics on macOS for isolated
tests and custom launches. Persistent data is not written inside the `.app`.

The bundled CLI does not require a system Node install. From Terminal:

```sh
/Applications/DotDial.app/Contents/Resources/dotdial-cli config path
/Applications/DotDial.app/Contents/Resources/dotdial-cli doctor
/Applications/DotDial.app/Contents/Resources/dotdial-cli status
```

An optional signaling launcher is applied by `dotdial-cli run`; opening the app
directly from Finder does not wrap it in an external launcher. Leave launcher
prefixes empty for the standard native app. The signaling proxy and media launcher
still use their own explicit settings.

The ordinary call-control commands require a running desktop instance. See the
[CLI/configuration guide](AGENT.md) for supported verbs and concurrent config edits.
Config reports and doctor do not open a call or capture audio.

## Update, rollback and remove

Quit DotDial before replacing the `.app`. Keep the last working installer until
you have checked the new version. Replace only the application, then reopen it;
settings and saved replies remain in Application Support. This port does not
introduce a configuration-schema migration. If a later release introduces one,
follow that release's migration and rollback instructions before downgrading.

To uninstall, turn off Start at login, quit DotDial and move the application to the
Trash. User data remains. If you also want to delete the browser session, model,
settings and saved replies, first preserve any replies you need, then remove the
DotDial Application Support and Caches directories above. Do not delete the whole
Library or the shared temporary directory.

## Build and verify from source

Use a real Mac of the target architecture with Node 22.12 or newer:

```sh
npm ci
npm test
npm run check:public
npm run demo
npm run package:macos
```

The packaging script uses the pinned Electron/Packager dependencies, native
`codesign`, `ditto` and `hdiutil`. It refuses Linux cross-packaging and an architecture
that does not match the build host. The normal `npm run package` dispatches to the
host platform; the Linux packaging path remains available on Linux.

Native CI checks both architectures, executable metadata, signatures, archive
contents, bundled CLI without system Node, local synthetic GUI and media behavior,
and the DMG contents. The small QA artifact contains the corresponding results.
Synthetic checks do not establish that real ChatGPT authentication, a microphone
permission prompt, physical audio hardware or Login Items will work on every Mac.
Before a public release, test those with an actual user session on the minimum
supported macOS and a current version. Do not put account data or recordings in CI.

The application icon is derived from `src/assets/dotdial-macos.svg`, using the
existing DotDial mark. The reviewed ICNS file is included in source and pinned by
the public-source scanner; icon generation tools are not needed to build the app.
