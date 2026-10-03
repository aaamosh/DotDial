# Launch drafts

These are drafts for a later public beta announcement. Do not post them while the repository is private. First complete the [release checklist](RELEASING.md), test the exact public build with a disposable account-owned dot, and check each community's self-promotion rules.

## Reddit — r/linuxapps

**Title:** DotDial: a small Linux tray companion for calling a ChatGPT dot

**Body:**

I built DotDial, a small Linux x86_64 desktop app for calling an existing ChatGPT dot from the tray or a keyboard shortcut. It has separate mic and speaker mute buttons, a floating call panel, and local playback of replies received while speakers are muted. Experimental offline English voice activation is disabled by default; “Hey Dot” is the example phrase, with sensitivity adjusted for your voice and microphone.

This is an experimental beta. It signs in to ChatGPT in its own Electron window, needs an account that already has a dot, and does not use an API key. The current call adapter relies on internal ChatGPT web routes rather than a supported public API, so it can break if those routes change. Recordings stay on the device and are deleted after full playback; microphone audio is not archived.

The screenshots are from a synthetic demo. Source, packages, and known limitations: https://github.com/aaamosh/DotDial.

I would especially value feedback on Linux packaging, audio-device behavior, and the settings flow.

## Reddit — r/OpenAI

**Title:** I made an experimental Linux tray app for calling an existing ChatGPT dot

**Body:**

DotDial is a small Linux desktop companion for calling a dot you already have in ChatGPT. The tray and floating panel can mute the microphone or speakers independently, and replies received while speakers are muted can be saved locally and replayed later. There is an optional offline wake word.

It uses your normal ChatGPT sign-in in its own window; no API key is required. The current adapter follows internal web routes and is not an official OpenAI API integration, so compatibility can change. This is a Linux x86_64 beta, not an OpenAI product.

Preview screenshots use synthetic data. Source, privacy notes, and limitations: https://github.com/aaamosh/DotDial.

## Show HN

**Title:** Show HN: DotDial — a Linux tray phone for an existing ChatGPT dot

**Body:**

DotDial is an experimental Linux x86_64 desktop app for calling a dot through your existing ChatGPT account. It adds tray and hotkey controls, separate microphone/speaker mute, local replay of replies missed while speakers are muted, and an optional offline wake word. No API key is used.

The interesting engineering problem was making the tray, floating panel, call state, and local recording controls work as one small desktop workflow. DotDial currently relies on internal ChatGPT web routes, not a supported public voice API, so this beta can break after service changes. The demo and screenshots use simulated call states.

Source and details: https://github.com/aaamosh/DotDial.

## GitHub Release

**Title:** DotDial v<VERSION> — Linux x86_64 beta

**Short description:** A little phone for your ChatGPT dot — voice activation, quiet mode and missed replies. Unofficial experimental desktop client; internal web routes may change.

Attach the `.deb`, `.tar.gz`, and `SHA256SUMS` after the exact release artifacts pass the clean-install and live-call checks. Include no account details or recordings.

## Launch sequence

1. GitHub: finish the README, screenshots, beta packages, and compatibility notes.
2. Post in r/linuxapps, then r/OpenAI if their current self-promotion rules permit it.
3. Submit Show HN after the first independent installation reports.
4. Expand to other relevant Linux and AI communities based on actual feedback.

These are draft announcements. No community posts have been sent.

Before announcing voice activation, complete a real-voice check of “Hey Dot” at the documented sensitivity. Synthetic speech alone has not validated the default setting.
