# Contributing

Thanks for taking a look at DotDial. The project is an experimental Linux x86_64 beta, and its ChatGPT dot voice adapter may need updates when OpenAI changes its web client.

## Local checks

Use Node.js 22.12 or later and run:

```sh
npm ci
npm test
npm run check:public
python3 -m py_compile scripts/setup-wake.py
```

The test suite uses local fixtures and synthetic audio. It must not sign in to ChatGPT, start a live call, or access a real microphone. `npm run demo` is safe for a visual preview and uses synthetic data.

## Pull requests

- Keep changes small and explain the behavior they change.
- Add or update tests for config validation, persistence, IPC, or media lifecycle changes.
- Keep default settings conservative. Wake word must remain off by default.
- Do not add account identifiers, dot IDs, private home paths, recordings, screenshots of account pages, browser profiles, cookies, passwords, access tokens, API keys, or proxy credentials.
- Never add unreviewed binaries or model files. Add their source, checksum, and license information to `THIRD_PARTY_NOTICES.md` before proposing redistribution.
- If a change depends on an internal ChatGPT route, document that dependency and test it with a dedicated disposable account only outside CI.

Before opening a pull request, read [Privacy](docs/PRIVACY.md), [Security](SECURITY.md), and the configuration guidance in [docs/AGENT.md](docs/AGENT.md).
