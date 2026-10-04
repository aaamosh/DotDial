# Beta.3 review follow-up

An external review of `v0.1.0-beta.1` identified 16 issues. The affected implementation was still present in beta.2. This update addresses the bugs; the review's broader feature proposals are separate from this release.

| ID | Correction | Verification |
| --- | --- | --- |
| D01 | Microphone acquisition is revocable across device lookup, capture and track attachment. An unknown RPC outcome retires the media worker and stops the call. | Delayed capture and track attachment, cancellation, replacement capture and worker timeout tests. |
| D02 | Hangup revokes the call before stopping replay, so replay cleanup cannot restore its microphone. | Ordered hangup/replay regression and call-controller cancellation tests. |
| D03 | Recorded speech splits at the exact sample limit and preserves the remainder. Segment delivery is serialized so a short tail cannot overtake the preceding reply. | A 128-sample partial frame followed by 60 seconds of synthetic speech preserves all 2,880,128 samples in FIFO order. |
| D04 | Allocation distinguishes a request that was not sent, a definite rejection, an unknown outcome and a known created call. The browser bridge preserves evidence of a pre-fetch identity failure. | Identity and browser-request failures, HTTP rejection, missing allocation metadata and successful retry after a provably unsent request. Unknown allocations stay locked against duplication. |
| D05 | Live CLI controls reject `--config` instead of silently sending to an instance with a different configuration. | CLI argument and socket-command tests. |
| D06 | Status publication and diagnostic writes cannot prevent cleanup. A failed journal write still permits stopping the known remote call while retaining recovery state. | Injected status and journal `ENOSPC` failures. |
| D07 | Wake recognition has an explicit input selector, separate from Chromium's call microphone. It resolves a unique PortAudio device name and host API without silently choosing a missing or ambiguous device. | Device-selection fixtures and wake process arguments. Hardware-specific selection still needs testing on the user's devices. |
| D08 | Replay cancellation begins before output-device lookup. Late completion cannot start stopped playback or clear a replacement player's handlers. | Delayed device lookup, delayed sink selection and late rejected playback. |
| D09 | The parent clears recording state on worker failure and shutdown, including an unavailable final-flush RPC. Late notifications cannot reactivate it. | Worker crash and failed-close tests with recording active. |
| D10 | Saving a custom config preserves permissions on its existing parent directory. The config itself remains private. | Save into an existing mode-0755 directory and verify file mode 0600. |
| D11 | Config writers use a kernel lock on a stable file instead of deleting stale locks during acquisition. Recognized live legacy owners remain busy; concurrent writes from old and new releases are unsupported. | Malformed legacy lock recovery, active legacy owner, persistent lock and concurrent writer tests. |
| D12 | `doctor` and wake use the same effective Python and model paths. Readiness requires a directory with the model's readable, nonempty required files. | Default/custom paths, installed Python, empty/incomplete directories and plain-file rejection. |
| D13 | Shutdown terminates the wake installer's owned process group and waits for cleanup; in-flight input scans are stopped too. | Local process-tree termination and device-scan shutdown tests; no installer downloads required. |
| D14 | Install/check saves the current settings before starting wake setup. | Electron UI check of the saved configuration at command dispatch. |
| D15 | The settings sidebar shows a verified account identity instead of treating the optional expected email as proof of sign-in. | Verified, unverified and invalidated identity UI states. |
| D16 | The first setup save button says "Save settings", matching its action. | Electron UI check. |

## Validation scope

The regression tests exercise production modules with controlled delays, failures, synthetic audio and temporary files. The Electron checks use an isolated display and local fixtures. Audio playback, muted recording, FIFO replay, interrupted replay retention and completed-playback deletion are also checked with the real Electron runtime and a private PulseAudio null sink, with both zero and 500 ms of buffering.

These checks do not sign in to a real account, place cloud calls or capture a physical microphone. They do not replace testing different headsets, Linux desktops, suspend/resume or changes to ChatGPT's internal web integration.

## Compatibility

Existing config files retain their defaults. Empty wake-device fields keep the previous system-default input. Network routes, buffer settings, the three-button panel and saved panel position are unchanged by the upgrade.

Config locking requires the standard `flock` utility from `util-linux`, now included in the Debian package dependencies and checked by `dotdial doctor`. The `.lock` file remains beside the config; the operating system releases its lock when a process exits. Its presence does not mean settings are busy. Do not run older and newer DotDial versions against the same configuration simultaneously.
