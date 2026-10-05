# DotDial 0.1.0-beta.4

**Leave the controls to your voice.** Start a call with your wake phrase, control your microphone and speakers, end the call, and catch up on missed replies without reaching for the keyboard.

- Enable **Hands-free call commands** in **Settings → Voice**. Each action has its own short English phrase, editable in Settings or `wakeWord.commands` in the single JSON config.
- Phrases take effect during a call without restarting DotDial or reconnecting. The app rejects overlapping phrases so a control command cannot first trigger the wake phrase.
- Commands use the existing local English recognizer. No extra account, API key, speech upload, or microphone recording is added.
- Microphone and speaker choices remain independent. Voice controls also stop missed-reply playback, and hanging up cancels unfinished audio actions.
- Call commands are opt-in. Existing wake phrases, profiles, audio buffering, routes, three-button panel and saved panel position are retained on upgrade.

Enable the optional local wake model first. Call microphone mute stops transmission to Dot; the local listener remains on while wake listening is enabled. Speech said before mute takes effect may reach Dot. Loudspeaker output can also be picked up by your microphone: choose distinct phrases or use a headset.

This Linux x86_64 beta includes automated configuration, command routing, cancellation, desktop and audio checks, plus offline recognition checks with synthetic English speech. Synthetic speech is a regression check, not a measure of accuracy across speakers, accents or rooms. The separately published [macOS Preview 2](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.2) remains available.

Download the Debian/Ubuntu `.deb` or Linux `.tar.gz` and check `SHA256SUMS`. Follow the [setup guide](https://github.com/aaamosh/DotDial#install-the-beta) for sign-in and your first call.

DotDial is unofficial and experimental. It requires a ChatGPT account with an existing dot and uses internal web routes that may change.
