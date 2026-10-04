# DotDial 0.1.0-beta.2

**Linux fix:** Right-clicking the floating call panel now opens its context menu.

**Say "Hey Dot." Leave the keyboard behind.**

Cooking, stretching, or thinking out loud on the sofa? DotDial lets you call your ChatGPT dot with your voice, from wherever your microphone can hear you. Set up the optional **Hey Dot** wake phrase and leave this small Linux app running in the tray. ChatGPT and Codex do not need to be installed or open; no API key is required.

## A few reasons to give it a call

- **Your voice is the call button.** Start a conversation without touching the keyboard. Choose your own supported English wake phrase; changes take effect even during a call.
- **Mute now. Catch up later.** While speakers are muted, incoming replies can be saved locally and played back in order. A reply deletes itself after full playback. It is a little answering machine for the moments when you need quiet.
- **Rejoin without reaching for the laptop.** During a call, the wake phrase turns muted microphone and speakers back on, with a brief confirmation sound.
- **Three buttons, right where you left them.** The floating panel has separate mic and speaker controls and a hang-up button, and remembers its screen position.
- **Friendly to your coding agent.** Settings live in one ordinary JSON file. Agents can edit it with their usual tools and control a running call through the local CLI.

## Your AI has a dial-up phase

The default connection sound is **a real 14.4 kbps modem handshake recorded in 1997**. A small piece of internet history plays while your dot connects and stops when the call is ready.

Love it? Keep it. Prefer something else? Choose telephone tones, your own **MP3 or WAV**, or switch call sounds off in **Settings → Voice**. Preview and volume controls are included. [Recording credits and CC0 license](https://github.com/aaamosh/DotDial/blob/v0.1.0-beta.2/THIRD_PARTY_NOTICES.md).

## Get started

Download the `.deb` for Debian/Ubuntu or the Linux x86_64 `.tar.gz` below. [Follow the installation and first-call guide](https://github.com/aaamosh/DotDial#install-the-beta), paste your existing dot's URL, and sign in with the account that has access to it.

Wake-word detection is off by default and requires the optional English model setup. It runs locally, including during calls with microphone transmission muted; range and sensitivity depend on your microphone, voice, and room. Saved replies stay on your device. DotDial does not archive microphone audio or create transcripts.

Defaults use direct networking and no extra audio buffering. Additional buffering and separate network routes are available in settings when needed. The beta has passed a live two-way call, muted-speaker recording and replay with completed-playback deletion, and real-voice **Hey Dot** activation on a separate Linux installation; wider hardware and desktop feedback is welcome.

DotDial is an unofficial, experimental community project, not an OpenAI product. It requires an account that already has a dot and uses internal ChatGPT web routes rather than a supported public voice API. Those routes may change or stop working.
