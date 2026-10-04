# DotDial configuration and local agent

The normal way to change advanced preferences is to edit DotDial's versioned JSON file with a text editor. The desktop app reads and writes the same file and rejects invalid or unknown settings, so keep the JSON valid and use only documented fields. The optional CLI can locate, validate, or update the file; it is also a convenience for local call controls. The agent talks to the desktop process over a private Unix domain socket. It does not send credentials to the shell or store them in the configuration.

## Configuration file

The default location is `${XDG_CONFIG_HOME:-~/.config}/dotdial/config.json`. The directory is created with mode `0700`; files are written atomically with mode `0600`. State, user data, cache, and runtime files use separate XDG locations:

| Purpose | Default |
| --- | --- |
| Configuration | `${XDG_CONFIG_HOME:-~/.config}/dotdial/` |
| State and logs | `${XDG_STATE_HOME:-~/.local/state}/dotdial/` |
| Data, recordings, browser profile, wake model and environment | `${XDG_DATA_HOME:-~/.local/share}/dotdial/` |
| Cache path used by diagnostics | `${XDG_CACHE_HOME:-~/.cache}/dotdial/` |
| Runtime socket | `${XDG_RUNTIME_DIR:-/run/user/<uid>}/dotdial/dotdial.sock` |

Set the corresponding `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, or `XDG_RUNTIME_DIR` variables to relocate those roots. On Linux, when `XDG_RUNTIME_DIR` is unset, DotDial uses `/run/user/<uid>`; the table shows the resulting runtime socket path. The configuration file is fully expanded to version 1 when saved. See [`config.schema.json`](../config.schema.json) for the exact fields, defaults, ranges, and strict unknown-field rules; [`config.example.json`](../config.example.json) is a complete default example. To edit the file, find its location with `dotdial config path` (or `node bin/dotdial.cjs config path` from a source checkout), open that file in a text editor, and validate it with `dotdial config validate` when done. You can also change settings from the app's Settings window.

`dot.url` is empty until configured. Otherwise it must be an HTTPS URL of the form `https://chatgpt.com/dots/<UUID>`. `dot.expectedEmail` is an optional account identity check, not a password. Use the account's normal browser sign-in for authentication. Do not put passwords, access tokens, API keys, cookies, or proxy credentials in this file. Proxy URLs must not contain user information; configure proxy authentication through an operating-system credential store if needed. Launcher arrays are executable and argument prefixes and are started without a shell. They must not contain credentials.

The `signalingProxy` applies only to the signaling path. `signalingLauncher` and `mediaLauncher` provide argv prefixes for their respective processes. Leave them empty for direct local launches. They are executable paths and argument arrays, not shell command lines: no shell expansion or variable substitution occurs. Never put credentials in launcher arguments.

`audio.connectionSound` chooses `modem` (the default), `telephone`, or `custom`. For `custom`, set `audio.customSoundPath` to an absolute local MP3 or WAV path. Files may be up to 30 seconds and 10 MiB; mono and stereo are supported. The original file stays unchanged and is never uploaded. DotDial decodes it locally with its bundled Chromium runtime and keeps a temporary PCM copy in its private runtime directory. Keep the original file available: if it is removed or cannot be decoded, calling falls back to telephone tones. Preview in Voice settings reports file errors and never starts a call. `audio.soundVolume` and `audio.sounds` continue controlling call effects.

## Optional command line

For a source checkout, run the CLI with Node.js 22 or later; in an installed package, use `dotdial` instead of `node bin/dotdial.cjs`:

```sh
node bin/dotdial.cjs config show
node bin/dotdial.cjs config path
node bin/dotdial.cjs config validate
node bin/dotdial.cjs doctor
node bin/dotdial.cjs run
```

`config set` is a shortcut for small changes. For example, to change the display name:

```sh
node bin/dotdial.cjs config set dot.displayName '"Kitchen dot"'
```

`config show` prints one JSON object with the fully merged `config` and a `hash`. The hash is SHA-256 of the exact file bytes; it is `null` before the first save. A UI that edits the same file should retain this hash and pass it back when saving. The CLI supports the same compare-and-swap behavior:

```sh
node bin/dotdial.cjs config set audio.soundVolume 0.7 --if-hash <hash-from-config-show>
```

If another process saved first, the write fails with `DOTDIAL_CONFIG_CONFLICT`; reload and apply the change to the new snapshot. Without `--if-hash`, `config set` reads the latest file and still protects the interval between its read and atomic save. Writers coordinate through the system `flock` utility on a stable lock file; the lock inode is not removed between saves. Older PID-only locks are checked for a live owner before migration. Stop older DotDial processes before upgrading, and use the matching CLI version: older releases can unlink lock files and cannot participate in this kernel-lock protocol. A malformed legacy lock is recovered only after 30 seconds; a legacy process paused between creating its empty lock and writing metadata cannot be distinguished from a crash after that interval. Configuration writes never start the app, sign in, or begin a call.

`config set` takes a dotted field name and a JSON value. Strings therefore need JSON quotes; booleans, numbers, arrays, and objects use ordinary JSON syntax. Unknown fields are rejected. `config validate [FILE]` checks the specified file without changing it; when the default file does not exist, it validates the built-in defaults. `config path` prints the absolute selected path. Pass `--config FILE` to select a different file for configuration commands, `doctor`, or `run`. Live controls always target the default running instance and reject `--config` so a custom file cannot appear to select a different instance.

`doctor` emits JSON checks for local platform, Node, Electron, entry-point, launcher, runtime-directory, socket-path, and enabled wake-word interpreter availability. It does not contact OpenAI, inspect a login profile, prompt for credentials, open a call, or access the microphone. `run` starts the project's pinned Electron binary and `src/main.cjs`, passing `--config=<absolute-path>` and `--profile=<XDG-data>/dotdial/profile`. It uses `network.signalingLauncher` as an argv prefix and never invokes a shell. For a source checkout, `--electron /absolute/path/to/electron` can select a test runtime.

The desktop process creates the private agent socket at `$XDG_RUNTIME_DIR/dotdial/dotdial.sock`. The local commands below send one newline-terminated verb and expect one JSON response line:

| CLI command | Agent verb | Effect |
| --- | --- | --- |
| `status` | `STATUS` | Read current local call state |
| `call` | `WAKE` | Start a call using the configured initial microphone state; during an active call, enable muted microphone and speakers |
| `hangup` | `STOP` | Stop the call |
| `mute` / `unmute` | `MUTE` / `UNMUTE` | Mute or unmute the microphone |
| `speakers-mute` / `speakers-unmute` | `SPEAKERS_MUTE` / `SPEAKERS_UNMUTE` | Mute or unmute incoming voice |
| `replay` | `MISSED_PLAY` | Play queued recordings |

Agent requests have a three-second timeout and responses are limited to 64 KiB. The socket accepts only the local user's process permissions; it is not a network listener. These action commands need a running DotDial desktop process. All commands print JSON except `config path`.

## Reloading and audio devices

The app notices external config edits within about a second. Invalid JSON leaves the last valid settings running and reports a config error. Wake-word edits take effect during calls and recovery without restarting the app or call. Other preferences that would affect a running call apply after it ends; changing `network.signalingLauncher` requires restarting DotDial.

Device choices use `label:<device name>` rather than Chromium's profile-specific IDs. Scan in Settings to choose a device. If it is removed or its name is ambiguous, DotDial reports an error instead of silently choosing another microphone. `default` follows the operating system's default device. Device scanning does not start a microphone stream.
