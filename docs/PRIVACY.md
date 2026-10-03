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
- The optional wake-word recognizer runs locally after its model is installed. The model installer downloads dependencies and the model only when you explicitly run it. Wake word is off by default.

## Files and retention

Defaults follow XDG Base Directory paths:

| Purpose | Path |
| --- | --- |
| Config | `~/.config/dotdial/config.json` |
| Logs and call state | `~/.local/state/dotdial/` |
| Browser profile, recordings, wake model | `~/.local/share/dotdial/` |
| Cache | `~/.cache/dotdial/` |

DotDial writes technical call state and diagnostics locally. The configuration and log files should not contain passwords or access tokens. Before attaching diagnostics to an issue, review them and remove personal paths or account details. Never attach recordings, browser profile data, cookies, or tokens.

Uninstalling the Debian package or deleting the source checkout does not erase the data directories. To erase local data, first save any replies you want to keep, close DotDial, then remove the DotDial subdirectory from each XDG config, state, data, and cache home. Removing the data directory also deletes the persistent browser profile and all saved recordings.

## Demo mode

`npm run demo` opens a local preview with synthetic data. It does not use the signed-in browser profile, contact ChatGPT, make a call, or access the microphone. Screenshots generated in demo mode must be labeled as previews, not as a live call.
