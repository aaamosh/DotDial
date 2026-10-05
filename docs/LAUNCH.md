# Launch kit

Factual copy and reusable media for the Linux beta and first public macOS preview. Platform availability was verified on October 5, 2026. Each community's current rules still apply. A submission or editorial pitch is not an accepted listing.

## Scope to preserve

- Linux x86_64 **0.1.0-beta.3** and **macOS Preview 1** for Apple Silicon (`arm64`) and Intel (`x64`) are available. An existing ChatGPT account with access to a dot is required.
- Unofficial community client using internal ChatGPT web routes; compatibility may change.
- Optional offline **English wake-word recognition**, off by default. Calls themselves are not offline.
- Local saved-reply playback requires recording to be enabled.
- No API key or installed ChatGPT/Codex desktop app is required by DotDial.
- macOS downloads are **ad-hoc signed, without Apple Developer ID signing or notarization**. They are early previews; startup at login may remain unavailable.
- macOS 13 is the binary deployment target. Native automated checks passed on macOS 15 for both architectures, using synthetic audio. Ventura runtime behavior, physical audio hardware, real permission prompts, sleep/unplug recovery, Login Items and real ChatGPT account calls still need hands-on acceptance. Linux live-call evidence must not be presented as macOS validation.
- The source tree supports both Linux and macOS. The published Mac binaries come from `54889c5b04fe3dc32b79084d56bbec6e187a53de`; later source changes are not part of Preview 1. Use the [current macOS guide](MACOS.md) for development and the pinned guide below for the released preview.

## Release links

| Platform | Release and installation |
| --- | --- |
| Linux x86_64 beta | [0.1.0-beta.3: Debian/Ubuntu package, Linux archive and checksums](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3) |
| macOS Apple Silicon and Intel preview | [Preview 1: DMGs, app ZIPs, source manifests and checksums](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1) |
| macOS setup and limitations | [Guide for the exact published source](https://github.com/aaamosh/DotDial/blob/54889c5b04fe3dc32b79084d56bbec6e187a53de/docs/MACOS.md) |

Use the specific release links above. The Linux beta and Mac preview are separate prereleases; a generic latest-release link does not identify both distributions.

## Reusable media

- [1200 × 630 Linux and macOS share card](media/dotdial-platforms-card.png)
- [Original Linux-only share card](media/dotdial-social-card.png)
- [18-second Linux synthetic UI preview with the 1997 modem recording](media/dotdial-preview-18s.mp4)
- [Source provenance, credits and alt text](media/README.md)

The original card, screenshots and video show the Linux synthetic UI, not a live conversation or a recorded macOS call. Preserve their synthetic-preview labels. Use the new platform card when announcing availability on both systems.

## Short original X posts

### macOS Preview 1 announcement

DotDial now has a macOS preview for Apple Silicon + Intel: menu-bar calls to your existing ChatGPT dot, Command-Shift-Space, local saved replies and a 1997 modem handshake. Built with Codex. Ad-hoc signed, not notarized.
https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1

### Linux beta announcement

DotDial is out: an MIT Linux tray app to call your existing ChatGPT dot by hotkey or optional wake word. Replay saved replies, with a real 1997 modem handshake while connecting. Built with Codex. Unofficial beta.
https://github.com/aaamosh/DotDial

Check [X automation rules](https://help.x.com/en/rules-and-policies/x-automation) before posting. They require the API for automated publishing and constrain automated mentions/replies. These drafts have no unsolicited mentions.

## General project description and Showcase draft

**Title:** DotDial - call your dot from the desktop

**Short description:** An open-source companion for calling an existing ChatGPT dot: Linux tray beta and macOS menu-bar preview for Apple Silicon and Intel, with optional local English wake recognition, saved replies and a real 1997 modem handshake.

**Maintainer introduction:**

I built DotDial with Codex so I can call my existing ChatGPT dot from the desktop, with a keyboard shortcut or an optional local English wake phrase. It runs in the Linux tray or, with the first Mac preview, the macOS menu bar. A small floating panel controls microphone, speakers and hangup. With recording enabled, muted-speaker replies can be saved locally and played back in order. The default connection sound is an authentic modem handshake recorded in 1997.

The Linux x86_64 beta is available as a Debian/Ubuntu package and archive. The first macOS preview has separate Apple Silicon and Intel DMGs and app ZIPs, plus manifests and checksums. Mac builds are ad-hoc signed and not notarized. Native macOS 15 package checks passed on both architectures; physical-device and real-account-call acceptance are still outstanding, and startup at login may remain unavailable.

DotDial is MIT-licensed and unofficial. It requires an account that already has access to a dot and uses internal ChatGPT web-call routes, which may change. No API key is needed. Codex was used to build the application; the runtime is not based on a supported public OpenAI voice API. Wake recognition is off by default; on Mac it needs optional Python 3.10-3.13 setup. The shared screenshots and video are synthetic Linux previews, with no real account or conversation shown.

Project: https://github.com/aaamosh/DotDial

Mac preview: https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1

These are maintainer drafts prepared with AI assistance. Preserve affiliation and any destination-required AI disclosure when adapting them. For Showcase, use the updated platform card and distinguish the fixed Preview 1 downloads from subsequent source changes.

## OpenAI community

The [Community category](https://community.openai.com/c/community/21) welcomes relevant projects. Use one substantive introduction with the actual use case, both release links, beta/preview limitations and a specific feedback request. Linux desktop feedback and Mac first-run, microphone and hardware feedback are useful; identify the user's OS, chip and downloaded revision. Do not repeat the same promotion across threads. The [official Showcase form](https://openai.com/form/showcase-submission/) also accepts projects built with Codex; submission requires the program agreement.

## Reddit: r/linuxapps

**Title:** DotDial: call your ChatGPT dot with “Hey Dot” while you step away from the keyboard

**Body:**

I built DotDial so I can talk to my dot while I'm making coffee or sitting on the sofa, instead of going back to the keyboard. With DotDial running in the tray, an optional wake phrase like “Hey Dot” can start a call whenever the laptop microphone can hear me. I don't need the ChatGPT or Codex app open; I sign in to my existing ChatGPT account inside DotDial's own window.

When I mute the speakers with recording enabled, DotDial can act like a little answering machine: replies are saved as local audio, queued oldest first, and deleted after I listen to each one. The default connection sound is an authentic recording of a 1997 modem handshake; I can switch to telephone tones or a local MP3/WAV. Settings are available in the app or one ordinary JSON file, and no API key is needed.

This is an experimental Linux x86_64 beta for people who already have access to a dot. Wake word is off by default, and the call adapter follows internal ChatGPT web routes that may change.

Source, packages, and privacy notes: https://github.com/aaamosh/DotDial

The project also has a separate [macOS preview for Apple Silicon and Intel](https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1), released with ad-hoc signatures and without notarization. This introduction is focused on feedback for the Linux beta. I maintain the project and built it with Codex; this draft was prepared with AI assistance.

## Reddit: r/OpenAI

**Title:** DotDial: call an existing ChatGPT dot from Linux or the new macOS preview

**Body:**

I maintain DotDial, a small open-source companion I built with Codex for calling my existing ChatGPT dot. It runs in the Linux tray, and a first macOS preview is now available for Apple Silicon and Intel. On Mac, the default shortcut is Command-Shift-Space. Optional local English wake recognition lets a phrase such as “Hey Dot” start a call within the microphone's range. Wake starts off; the ChatGPT or Codex desktop app does not need to be installed or open. DotDial signs in through its own window with an account that already has access to a dot.

It also has a quiet mode: mute the speakers with recording enabled, and replies can wait in a local audio queue like voicemail until I'm ready to listen. The default call sound is a real recording of a 1997 modem handshake, with telephone and custom MP3/WAV choices. There is no API key; settings live in the app or a plain JSON file.

The Linux x86_64 beta has packages; the Mac preview has DMGs and app ZIPs for both chip families. Mac builds are ad-hoc signed, without Developer ID signing or notarization. Both architectures passed native macOS 15 package checks, but real-device and real-account-call acceptance remain outstanding. Wake on Mac needs the optional Python 3.10-3.13 setup, and startup at login may remain unavailable.

DotDial is unofficial, and its call flow depends on internal ChatGPT web routes that can change. Screenshots and the short video use a synthetic Linux demo. This maintainer introduction was prepared with AI assistance.

Project and privacy notes: https://github.com/aaamosh/DotDial

Mac preview and installation notes: https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1

## Hacker News

The [HN Guidelines](https://news.ycombinator.com/newsguidelines.html) checked on October 4, 2026 prohibit generated text and automated posting. A maintainer who chooses to submit a Show HN should write their own post and participate personally. Do not reuse AI-written launch copy there.

## Linux release short copy

This copy describes the existing Linux release only. Use the separate Mac announcement below for Preview 1.

**Title:** DotDial v0.1.0-beta.3 — say “Hey Dot” to call your ChatGPT dot

**Description:** A little Linux tray phone for an existing ChatGPT dot. Start an optional hands-free call, then catch replies later with local quiet-mode recordings. No API key or ChatGPT/Codex app required.

**Highlights:**

- Say “Hey Dot” from the sofa or kitchen when the laptop microphone can hear you. Wake-word support is optional and off by default.
- With recording enabled, mute the speakers to save incoming replies locally and play them back oldest first, like an answering machine.
- Hear an authentic 1997 modem handshake while DotDial calls. Switch to telephone tones or a local MP3/WAV.
- Change settings in the app or a plain JSON file; no API key is needed.

Requires the installed app to be running and a ChatGPT account that already has access to a dot. This unofficial Linux x86_64 beta uses internal ChatGPT web routes, which may change.

Attach the `.deb`, `.tar.gz`, and `SHA256SUMS` from the exact release build. Do not include account details or recordings.

## macOS Preview 1 announcement

**Title:** DotDial for macOS - first public preview for Apple Silicon and Intel

DotDial now has a macOS menu-bar preview for calling an existing ChatGPT dot. Use Command-Shift-Space, the menu or optional local English wake recognition; catch up on locally saved replies when recording is enabled. The original 1997 modem handshake is here too.

Choose the Apple Silicon (`arm64`) or Intel (`x64`) DMG, drag DotDial.app into Applications and launch the installed copy. App ZIPs, source manifests and checksums are also available. Ordinary calls and the bundled CLI need no separate Node or Python installation. Optional wake setup requires Python 3.10-3.13 and starts disabled.

These are ad-hoc signed, unnotarized preview builds, without an Apple Developer ID certificate. macOS can require first-launch approval in Privacy & Security. Both architectures passed native package checks on macOS 15; the binary deployment target is macOS 13, whose runtime acceptance is still outstanding. Physical hardware, actual permission prompts, sleep/unplug recovery, Login Items and real ChatGPT account calls also need hands-on testing. Startup at login may remain unavailable.

DotDial is MIT-licensed, built with Codex and unofficial. An existing ChatGPT account with access to a dot is required; its internal web-call routes can change. No API key is needed.

Download and exact release notes: https://github.com/aaamosh/DotDial/releases/tag/v0.1.0-beta.3-macos-preview.1

Public source: https://github.com/aaamosh/DotDial/commit/54889c5b04fe3dc32b79084d56bbec6e187a53de

## Publication notes

1. Link to the verified public release and keep platform claims current.
2. Match the audience: Linux app communities for the Linux beta, Mac app communities for the early Mac preview, and Dots-specific communities for the common use case. Keep the Mac signing and acceptance limitations visible.
3. For curated directories, disclose maintainer affiliation and distinguish a submitted suggestion from an accepted entry.
4. Editorial pitches should be short, relevant to the publication, and sent once. When a new public release materially changes an existing submission, add one concise update to that submission or conversation rather than starting duplicate pitches.
5. The current [DEV AI guidelines](https://dev.to/guidelines-for-ai-assisted-articles-on-dev) do not permit AI-assisted promotional articles. The [Discord rules on self-bots](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) prohibit automating ordinary user accounts. Do not treat a working login as permission for a prohibited publication method.

Rules above were checked on October 4, 2026; recheck them before a later campaign.
