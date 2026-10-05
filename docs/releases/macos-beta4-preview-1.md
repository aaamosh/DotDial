# DotDial for macOS 0.1.0-beta.4

**Your voice has the controls.** This native Mac preview includes the hands-free
commands already published in Linux beta.4, using the same configuration,
recognizer and call-control implementation.

## Turn it on

In **Settings → Voice**, set up local wake support, enable **Hands-free call
commands**, and save. Commands are off by default and use short English phrases.
Each phrase can be edited without restarting DotDial or reconnecting a call.

| Action | Default phrase |
| --- | --- |
| Microphone off | Microphone off |
| Microphone on | Microphone on |
| Speakers off | Radio silence |
| Speakers on | Sound on please |
| End the call | Hang up |
| Play saved replies | Replay messages |
| Stop saved-reply playback | Stop the replay |

Your existing wake phrase still starts a call. Overlapping command/wake phrases
are rejected. Microphone and speakers remain independent; hangup cancels pending
audio actions, and playback can be stopped by voice even after a call has ended.
On macOS the selected Electron microphone feeds the local Python recognizer over
its existing bounded audio pipe. No second Python microphone or cloud recognition
service is introduced. Muting the call stops transmission, not the local listener.
Speech spoken before mute takes effect may reach the dot. Speaker output can be
picked up by the microphone; use distinct phrases or a headset.

## Downloads and provenance

Use the `arm64` download on Apple Silicon and `x64` on Intel. Names contain
`preview-{{SOURCE_SHORT}}`; each architecture has a DMG, an app ZIP and a source
manifest. `SHA256SUMS` covers those six files.

Source: `{{SOURCE_COMMIT}}`.
[Native build and acceptance]({{CI_RUN_URL}}).

These packages are published only after both native jobs pass all **12 required
package gates**. The new command gate uses the real packaged listener,
WakeManager and command router with synthetic English speech: seven commands,
wake with commands enabled, unrelated speech, commands disabled, a custom phrase
and rejection of its replaced phrase. It checks exact events, dispatch and
process cleanup. Its microphone input and call dispatch are isolated fixtures,
not a hardware or real-account call test. Existing Electron PCM, GUI, four-resume,
backpressure, saved-reply, permission-policy and package checks remain required.

## Upgrade and limitations

Quit DotDial, replace the app in Applications and reopen it. Existing profiles,
shortcuts, sounds and saved replies stay in Application Support. Voice commands
remain off until explicitly enabled. Back up `config.json` before upgrading:
once beta.4 saves its new command fields, the older beta.3 strict parser will not
accept them. Restore the pre-upgrade config when rolling back; keep the data and
recordings directories intact. See [the Mac guide](https://github.com/aaamosh/DotDial/blob/{{SOURCE_COMMIT}}/docs/MACOS.md).

This is an **ad-hoc signed preview, without Apple Developer ID or notarization**.
Native tests run on macOS 15 for both architectures; macOS 13 is the binary
minimum, not a verified runtime result. Physical audio devices, real permission
prompts, sleep/unplug recovery, user-session Login Items and authenticated ChatGPT
calls still require hands-on acceptance. Synthetic speech is a regression check,
not an accuracy measurement across accents, speakers or rooms.

The application remains unofficial and uses internal web-call routes. An existing
ChatGPT dot is required. Earlier macOS previews and the Linux beta.4 release are
preserved unchanged.
