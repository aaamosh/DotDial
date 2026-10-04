# DotDial 0.1.0-beta.1

An experimental Linux x86_64 desktop companion for calling a ChatGPT dot already available to your account. Builds are provided as Debian/Ubuntu `.deb` and `.tar.gz` packages.

The beta adds tray and keyboard controls, a floating call panel, separate microphone and speaker mute, and call-state sounds. Optional offline English wake-word support is included; **Hey Dot** is an example phrase. When speakers are muted and recording is enabled, incoming replies can be saved as local WAV files and replayed oldest first. A clip is deleted only after it finishes playing; DotDial does not archive microphone audio or create transcripts.

Defaults use direct networking, no extra audio buffering, and wake-word detection turned off. Wake recognition requires a separate model setup and sensitivity calibration for your voice and microphone. **Live-call acceptance and real-voice wake-word calibration are still pending**, so reliability has not been confirmed for general use.

DotDial is an unofficial community project, not an OpenAI product. It signs in to ChatGPT in its own window and uses internal ChatGPT web routes rather than a supported public voice API. Those routes may change or stop working. No API key is required.
