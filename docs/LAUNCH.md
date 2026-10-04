# Launch drafts

English copy ideas for a DotDial release or community post. They are drafts only; no community posts have been sent. Check the current rules for each community before posting.

## Reddit: r/linuxapps

**Title:** DotDial: call your ChatGPT dot with “Hey Dot” while you step away from the keyboard

**Body:**

I built DotDial so I can talk to my dot while I'm making coffee or sitting on the sofa, instead of going back to the keyboard. With DotDial running in the tray, an optional wake phrase like “Hey Dot” can start a call whenever the laptop microphone can hear me. I don't need the ChatGPT or Codex app open; I sign in to my existing ChatGPT account inside DotDial's own window.

When I mute the speakers with recording enabled, DotDial can act like a little answering machine: replies are saved as local audio, queued oldest first, and deleted after I listen to each one. The default connection sound is an authentic recording of a 1997 modem handshake; I can switch to telephone tones or a local MP3/WAV. Settings are available in the app or one ordinary JSON file, and no API key is needed.

This is an experimental Linux x86_64 beta for people who already have access to a dot. Wake word is off by default, and the call adapter follows internal ChatGPT web routes that may change.

Source, packages, and privacy notes: https://github.com/aaamosh/DotDial

## Reddit: r/OpenAI

**Title:** I made a small Linux tray app for talking to an existing ChatGPT dot

**Body:**

DotDial lets me call my dot without sitting at the keyboard. When the app is running, I can say “Hey Dot” from the kitchen or sofa as long as the laptop mic picks it up. Wake-word activation is optional and starts off; the regular ChatGPT or Codex app does not need to be installed or open. DotDial signs in through its own window with an account that already has access to a dot.

It also has a quiet mode: mute the speakers with recording enabled, and replies can wait in a local audio queue like voicemail until I'm ready to listen. The default call sound is a real recording of a 1997 modem handshake, with telephone and custom MP3/WAV choices. There is no API key; settings live in the app or a plain JSON file.

This is an unofficial Linux x86_64 beta, and its call flow depends on internal ChatGPT web routes that can change.

Project and privacy notes: https://github.com/aaamosh/DotDial

## Show HN

**Title:** Show HN: DotDial — a hands-free Linux tray phone for your ChatGPT dot

**Body:**

DotDial is a small Linux app for talking to a dot you already use in ChatGPT. I wanted to start a conversation while cooking or relaxing away from the keyboard, so I added an optional local “Hey Dot” wake phrase, separate mic and speaker controls, and a compact floating call panel. You can keep the conversation going without the ChatGPT or Codex desktop app; DotDial uses its own sign-in window and your existing account.

When the speakers are muted and recording is enabled, replies are kept as local audio and replayed oldest first, like a tiny answering machine. A reply is deleted only after full playback. The default connection sound is an authentic recording of a 1997 modem handshake; telephone tones and custom local MP3/WAV files are also supported. The app's settings are in the UI or a plain JSON file, with no API key.

The wake word is off by default, and calls require DotDial to be running plus an account with access to a dot. This experimental Linux x86_64 beta uses internal ChatGPT web routes, so compatibility may change.

Source, packages, screenshots, and privacy notes: https://github.com/aaamosh/DotDial

## GitHub release short copy

**Title:** DotDial v0.1.0-beta.1 — say “Hey Dot” to call your ChatGPT dot

**Description:** A little Linux tray phone for an existing ChatGPT dot. Start an optional hands-free call, then catch replies later with local quiet-mode recordings. No API key or ChatGPT/Codex app required.

**Highlights:**

- Say “Hey Dot” from the sofa or kitchen when the laptop microphone can hear you. Wake-word support is optional and off by default.
- Mute the speakers to save incoming replies locally and play them back oldest first, like an answering machine.
- Hear an authentic 1997 modem handshake while DotDial calls. Switch to telephone tones or a local MP3/WAV.
- Change settings in the app or a plain JSON file; no API key is needed.

Requires the installed app to be running and a ChatGPT account that already has access to a dot. This unofficial Linux x86_64 beta uses internal ChatGPT web routes, which may change.

Attach the `.deb`, `.tar.gz`, and `SHA256SUMS` from the exact release build. Do not include account details or recordings.

## Posting order

1. Publish and verify the GitHub source and beta download links.
2. Consider r/linuxapps, then r/OpenAI if their current self-promotion rules allow it.
3. Consider Show HN after independent installation feedback.
