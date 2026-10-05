# Release checklist

DotDial has a Linux x86_64 beta and a native macOS preview for Apple Silicon and
Intel. The Linux checklist below remains the standard for Linux releases. macOS
preview promotion is described separately at the end of this guide.

## Before tagging

1. Confirm the release version in `package.json`; commit the updated lockfile.
2. From a clean checkout, run `npm ci`, `npm test`, `npm run check:public`, and `python3 -m py_compile scripts/setup-wake.py`.
3. Review the public-source audit and search the staged tree for account emails, dot URLs/IDs, local home paths, session data, cookies, logs, and audio files. Do not include user-specific installation receipts or test recordings.
4. Build on Linux x86_64 with `npm run package`. Attach the generated `.deb` and `.tar.gz`, and publish SHA-256 checksums alongside them. Preserve Electron's MIT and Chromium license notices in the application bundle.
5. Verify the archive and Debian package install and launch on a clean Linux x86_64 account. Confirm uninstall leaves data as documented.
6. Run the separate live test with an account-owned disposable dot: sign in, connect, verify two-way audio, microphone mute, speaker mute, FIFO playback, and deletion only after a clip completes. Check that a restart does not unnecessarily request a new login. Never put the live account, route, or recordings into CI or public evidence.
7. Review the screenshots in `docs/images/`. They must come from `--demo`, contain no real account or live-call information, and be captioned as synthetic previews.
8. Confirm `THIRD_PARTY_NOTICES.md` matches the exact bundled Electron notices and the optional model archive metadata.

## Build and tag

```sh
npm ci
npm test
npm run check:public
python3 -m py_compile scripts/setup-wake.py
npm run package
```

Review the files produced by the packager before creating a tag. Tag the reviewed commit as `v<version>`, create a draft GitHub Release, attach the `.deb`, `.tar.gz`, checksums, and release notes, then install those exact artifacts on a clean test account. Publish the draft only when these checks pass and the planned release date arrives.

## Release notes template

```markdown
## DotDial v<VERSION> — beta

Linux x86_64 builds: Debian/Ubuntu `.deb` and `.tar.gz`.

### Highlights
- <user-visible change>

### Compatibility
- Uses an existing ChatGPT account and a dot already available to that account.
- The current voice adapter uses internal ChatGPT web routes. It is unofficial and may break if those routes change.

### Privacy
- Incoming audio is saved locally only while speakers are muted and recording is enabled.
- DotDial does not record microphone audio or create transcripts.

### Checksums
See `SHA256SUMS` attached to this release.
```

## Rollback

If a build fails to install, sign in, connect, or safely stop a call, mark the release as withdrawn, provide the prior known-good version if available, and keep the repository issue tracker open for the failure. Do not ask users to upload browser profiles, cookies, credentials, or audio recordings for diagnosis.

## First macOS preview publication

The first public macOS preview is `v0.1.0-beta.3-macos-preview.1`. It retains the
application version `0.1.0-beta.3`; its artifact names and embedded manifests also
identify the exact source commit. This is an ad-hoc signed prerelease, without
Developer ID signing or notarization. The [release notes](releases/macos-preview-1.md)
explicitly describe the remaining manual acceptance checks.

The macOS workflow has a narrow, one-time promotion gate: a push to this repository's
`feat/macos` branch whose commit-message first line is exactly
`Publish macOS preview 1 with bundled runtime notices`. Ordinary pushes and pull
requests only build and verify packages. Promotion depends on both native matrix
jobs passing every required stage in [the testing guide](TESTING.md#native-macos-acceptance).
The build jobs retain read-only repository permissions; only the promotion job can
write release contents.

Promotion downloads the distribution artifacts from that same workflow run,
checks their complete file inventories, manifests and SHA-256 values, and prepares
a draft release targeting that exact commit. It attaches both DMGs, both app ZIPs,
both manifests and one combined `SHA256SUMS`. It verifies the uploaded assets before
publishing as a prerelease without selecting it as the latest stable release.
Existing mismatched tags or assets fail the operation instead of being overwritten.

Both downloaded formats must contain Electron's `LICENSE` and
`LICENSES.chromium.html` under `DotDial.app/Contents/Resources/electron-licenses/`.
The packager copies them from the pinned runtime before signing, and native
acceptance verifies their bytes in the ZIP and DMG.

Complete the physical microphone, real account, TCC, Login Items and minimum-macOS
session checks before promoting this preview to a more general release. Preserve
the explicit preview classification until that acceptance and the planned Apple
signing/notarization work are complete.
