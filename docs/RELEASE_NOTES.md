# DotDial 0.1.0-beta.1

An experimental Linux x86_64 desktop companion for calling a ChatGPT dot already available to your account. Builds are provided as Debian/Ubuntu `.deb` and `.tar.gz` packages.

The beta adds tray and keyboard controls, a floating call panel, separate microphone and speaker mute, and call-state sounds. Optional offline English wake-word support is included; **Hey Dot** is an example phrase. When speakers are muted and recording is enabled, incoming replies can be saved as local WAV files and replayed oldest first. A clip is deleted only after it finishes playing; DotDial does not archive microphone audio or create transcripts.

The compact three-button panel remembers its screen position. During calls, the wake phrase enables any muted microphone or speakers and gives a brief confirmation cue. An already enabled microphone keeps sending speech normally. The default connection sound uses a real 1997 modem recording, shared under CC0; choose telephone tones or your own local MP3/WAV instead in Voice settings. Preview the selection before saving. The sound stops when the call connects. See [Third-party notices](../THIRD_PARTY_NOTICES.md) for the recording source and license.

Settings use a compact, scrollable window that stays inside the monitor work area. Wake phrase changes apply during calls without restarting them. Explicit web-verification rejections trigger one same-session refresh; unresolved verification is shown clearly in the tray.

Defaults use direct networking, no extra audio buffering, and wake-word detection turned off. Wake recognition requires a separate model setup and sensitivity calibration for your voice and microphone. A separate Linux installation has passed a live two-way call, muted-speaker recording and replay with completed-playback deletion, and real-voice **Hey Dot** activation. These single-user checks do not establish reliability across accounts, microphones, networks or desktop environments.

DotDial is an unofficial community project, not an OpenAI product. It signs in to ChatGPT in its own window and uses internal ChatGPT web routes rather than a supported public voice API. Those routes may change or stop working. No API key is required.
