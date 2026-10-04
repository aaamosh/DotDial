# Contributing

Thanks for taking a look at DotDial. The project has a Linux x86_64 beta and a macOS Apple Silicon/Intel preview, and its ChatGPT dot voice adapter may need updates when OpenAI changes its web client.

## Local checks

Use Node.js 22.12 or later and run:

```sh
npm ci
npm test
npm run check:public
python3 -m py_compile scripts/setup-wake.py
```

The test suite uses local fixtures and synthetic audio. It must not sign in to ChatGPT, start a live call, or access a real microphone. `npm run demo` is safe for a visual preview and uses synthetic data.

`check:public` scans text and filenames for Cyrillic and private data, regardless of extension. It also checks tracked files in directories normally excluded as build output. Text must be UTF-8 or BOM-marked UTF-16. Binary assets require content and metadata review; the scanner pins the exact hashes of reviewed screenshots and call sounds. After changing one, review it again before updating its hash in `scripts/check-public.cjs`.

## Pull requests

- Keep changes small and explain the behavior they change.
- Add or update tests for config validation, persistence, IPC, or media lifecycle changes.
- Keep default settings conservative. Wake word must remain off by default.
- Do not add account identifiers, dot IDs, private home paths, recordings, screenshots of account pages, browser profiles, cookies, passwords, access tokens, API keys, or proxy credentials.
- Never add unreviewed binaries or model files. Add their source, checksum, and license information to `THIRD_PARTY_NOTICES.md` before proposing redistribution.
- If a change depends on an internal ChatGPT route, document that dependency and test it with a dedicated disposable account only outside CI.

Before opening a pull request, read [Privacy](docs/PRIVACY.md), [Security](SECURITY.md), and the configuration guidance in [docs/AGENT.md](docs/AGENT.md).

## macOS builds

Build natively on each architecture with `npm run package:macos`; see
[the macOS build and acceptance guide](docs/MACOS.md#build-and-verify-from-source).
The macOS workflow tests both architectures and emits separate installer and QA
artifacts. Do not describe an ad-hoc signature as Developer ID signing or Apple
notarization. Keep changes compatible with the existing Linux checks.
