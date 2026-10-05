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

The [workflow at the released source](https://github.com/aaamosh/DotDial/blob/54889c5b04fe3dc32b79084d56bbec6e187a53de/.github/workflows/macos.yml)
used a narrow, one-time promotion gate: a push to this repository's
`feat/macos` branch whose commit-message first line is exactly
`Publish macOS preview 1 with bundled runtime notices`. Promotion depended on both native matrix
jobs passing every required stage in [the testing guide](TESTING.md#native-macos-acceptance).
The build jobs had read-only repository permissions; only the promotion job could
write release contents. That completed job has been removed from active CI.

Regular workflows build and verify packages for pull requests, `main` pushes,
`v*` tags and manual runs, then preserve artifacts and reports. Both completed beta.3 macOS promotion jobs have been removed. The separately
gated beta.4 hands-free publication is described below; normal CI runs cannot
invoke it. The original workflows, publishers and regression tests remain available
at their respective released source commits for provenance.

The first promotion downloaded the distribution artifacts from that same workflow
run, checked their complete file inventories, manifests and SHA-256 values, and
prepared a draft release targeting that exact commit. It attached both DMGs, both
app ZIPs, both manifests and one combined `SHA256SUMS`, then verified the uploaded
assets before publishing as a prerelease without selecting it as the latest stable
release. The publisher rejects mismatched tags or assets instead of overwriting them.

## Second macOS preview publication

Preview 2 was published as `v0.1.0-beta.3-macos-preview.2` from source
[`0b9924b014d4c46271647e95d97806811fb45229`](https://github.com/aaamosh/DotDial/commit/0b9924b014d4c46271647e95d97806811fb45229)
through [native release run 37342159498](https://github.com/aaamosh/DotDial/actions/runs/37342159498).
It retains application version `0.1.0-beta.3`. Its [release notes](releases/macos-preview-2.md)
describe local wake capture's silent audio sink and requested 100 ms Web Audio
latency hint: the released runtime uses both `sinkId: { type: 'none' }` and
`latencyHint: 0.1`. Preview 1's tag, release notes and downloaded files are
preserved separately.

The [workflow at the released source](https://github.com/aaamosh/DotDial/blob/0b9924b014d4c46271647e95d97806811fb45229/.github/workflows/macos.yml)
used a one-time promotion gate for a push to `aaamosh/DotDial` on `main`, with
this exact commit-message first line:

```text
Publish macOS preview 2 with silent wake audio sink
```

The historical `publish-preview-2` job depended on both native matrix jobs
passing the unit suite, public-source audit and every required package gate.
It downloaded only that same run's Apple Silicon and Intel distribution artifacts.
The build jobs had read-only permissions; only the promotion job had
`contents: write` and `actions: read`, using the workflow-scoped token. No project
dependencies were installed and no application build ran in the write job.

The native pipeline gate retained the 25 acknowledged PCM blocks within seven
seconds requirement for initial capture and four pause/resume cycles. It also
required a first-to-last span of 2400 ms, within 500 ms, for those 25 consecutive
100 ms blocks. The restart check used 10 blocks with a 900 ms expected span and
the same tolerance. Acquisition time was excluded from these cadence measurements.
Both architectures had to satisfy these checks before promotion.

The [publisher at the released source](https://github.com/aaamosh/DotDial/blob/0b9924b014d4c46271647e95d97806811fb45229/scripts/publish-macos-preview.cjs)
required the exact source SHA in both manifests, a clean source tree, the expected
preview/signature metadata, exactly three distribution files per architecture
and matching SHA-256 checksums. It created a draft targeting the exact release
commit, uploaded those six files and one combined `SHA256SUMS`, and checked
GitHub's uploaded sizes and digests before publishing with `--latest=false`.
Its fixed tag and conflict checks prevent replacement of mismatched tags or assets.

The first promotion attempt stopped during the immediate readback of its newly
created draft, before any asset upload. A later readback matched the exact source,
notes, author and empty asset inventory. Only the promotion job was resumed;
[job 111878337803](https://github.com/aaamosh/DotDial/actions/runs/37342159498/job/111878337803)
published the same run's original artifacts after all seven remote sizes and
digests matched. The native jobs were not rebuilt for this recovery. The first
readback response was not retained, so its precise mismatch is undetermined.

The completed one-time job has been removed from active CI, and the ordinary
workflow/event/ref concurrency group has been restored. The source, workflow run
and checksum evidence above are the provenance of the published packages; this
historical gate does not authorize publication from a new commit.

Replay and recovery apply only to the archived `publish-preview-2` job in
[run 37342159498](https://github.com/aaamosh/DotDial/actions/runs/37342159498),
while that run's original artifacts remain available. If its upload were
interrupted, only the original promotion job should be rerun: an unchanged draft
owned by that run resumes missing uploads, and matching published files are
verified without writes. Rebuilding packages can produce different bytes and
must not be used to overwrite an existing draft or published release. Preserve
the original source, run and checksum evidence with the release verification
record.

## macOS distribution acceptance

Both downloaded formats must contain Electron's `LICENSE` and
`LICENSES.chromium.html` under `DotDial.app/Contents/Resources/electron-licenses/`.
The packager copies them from the pinned runtime before signing, and native
acceptance verifies their bytes in the ZIP and DMG.

Complete the physical microphone, real account, TCC, Login Items and minimum-macOS
session checks before promoting this preview to a more general release. Preserve
the explicit preview classification until that acceptance and the planned Apple
signing/notarization work are complete.

## macOS beta.4 hands-free preview

The next explicit publication uses the separate tag
`v0.1.0-beta.4-macos-preview.1` and application version `0.1.0-beta.4`. The
reviewed main commit's first line must be exactly
`Publish macOS beta 4 preview with voice commands`. The one-time workflow job
waits for both architectures and all twelve required package gates, then promotes
only those same-run artifacts with matching manifests and SHA-256. It does not
rebuild packages or download Release assets. Earlier previews and Linux beta.4
are outside its mutation target.

The publisher retains strict draft identity, fixed-tag and no-overwrite checks.
After successful readback, retire this one-time job and link the new downloads.
The archived beta.3 publisher remains accessible at its original source; ordinary
pushes, pull requests and workflow dispatches do not authorize publication.
