# Privacy notes

DotDial has no analytics or telemetry. Normal use still contacts ChatGPT because this experimental client signs in to your ChatGPT account and uses the current web-call flow for a dot. The app may load its sign-in page in a hidden window at startup to prepare the account session. The demo mode is separate and uses only local synthetic data.

## Account and network

- Sign in yourself in DotDial's own Electron window with an account that already has access to the chosen dot. DotDial does not ask for or store an API key.
- The signed-in browser profile is stored under the DotDial data directory (`${XDG_DATA_HOME:-~/.local/share}/dotdial/profile`). It contains browser session data needed for sign-in. It is protected by local user file permissions, not by a DotDial-managed encryption key. Do not share this directory or copy it into support reports.
- The current voice adapter calls internal ChatGPT web endpoints. They are not a stable public API, and OpenAI can change or disable them. DotDial is not affiliated with or endorsed by OpenAI.
- Network settings let you choose a signaling proxy or process launcher. A media launcher can route media separately. Those values are passed as process arguments; never put passwords, tokens, cookies, or proxy credentials in the config. See [the agent/config guide](AGENT.md).

## Audio and recordings

- During a call, microphone audio is sent to the selected dot while the microphone is enabled. DotDial does not save microphone audio to the missed-reply archive.
- When speakers are muted and local recording is enabled, incoming voice is saved as WAV files under `${XDG_DATA_HOME:-~/.local/share}/dotdial/recordings`. Recording does not create a transcript and is not separately uploaded by DotDial.
- Saved replies play oldest first. A clip is deleted only after full playback. Stopping or interrupting playback keeps the clip for another attempt. Unplayed files remain on disk until played or removed by the user.
- The configured total storage limit defaults to 200 MiB. Keep the data directory private because it may contain spoken content.
- The optional wake-word recognizer runs locally after its model is installed. When enabled, it continues using the microphone locally during calls, including while transmission to the dot is muted. Recognizing the phrase can unmute the call microphone and speakers; a short cue confirms activation. Wake word is off by default. Dependencies and the model are downloaded only when you explicitly start setup from Voice settings or run the installer from a source checkout. The wake input can use the system default or an explicitly selected PortAudio device; scanning lists device and host API names without opening an audio stream. The selected device names are stored in the local settings file.

## Files and retention

Custom connection sounds are read only from the local MP3 or WAV path you choose. They are never uploaded. A decoded PCM copy is held in a private temporary directory under `${XDG_RUNTIME_DIR:-/run/user/<uid>}/dotdial/` and removed on normal exit. On Linux, `/run/user/<uid>` is the fallback when `XDG_RUNTIME_DIR` is unset. After a crash the copy can remain until the runtime directory is cleared, normally at logout or reboot. The original sound file is not modified or deleted.

Defaults follow XDG Base Directory paths:

| Purpose | Path |
| --- | --- |
| Config | `${XDG_CONFIG_HOME:-~/.config}/dotdial/config.json` |
| Logs, call and window state | `${XDG_STATE_HOME:-~/.local/state}/dotdial/` |
| Browser profile, recordings, wake model and environment | `${XDG_DATA_HOME:-~/.local/share}/dotdial/` |
| Cache path used by diagnostics | `${XDG_CACHE_HOME:-~/.cache}/dotdial/` |
| Runtime socket and temporary audio | `${XDG_RUNTIME_DIR:-/run/user/<uid>}/dotdial/` |

DotDial writes technical call state, the floating panel position, and diagnostics locally. The last completed call retains bounded packet-loss, jitter and playout counters so a failed subsequent attempt does not erase them; this summary contains no speech, network addresses or call identifiers. The configuration and log files should not contain passwords or access tokens. Before attaching diagnostics to an issue, review them and remove personal paths or account details. Never attach recordings, browser profile data, cookies, or tokens.

Uninstalling the Debian package or deleting the source checkout does not erase the data directories. To erase local data, first save any replies you want to keep, close DotDial, then remove the DotDial subdirectory from each XDG config, state, data, and cache home. Removing the data directory also deletes the persistent browser profile and all saved recordings. The runtime directory is normally cleared at logout or reboot.

## Demo mode

`npm run demo` opens a local preview with synthetic data. It does not use the signed-in browser profile, contact ChatGPT, make a call, or access the microphone. Screenshots generated in demo mode must be labeled as previews, not as a live call.
