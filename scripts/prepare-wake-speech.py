#!/usr/bin/env python3
"""Build pinned Flite privately and generate two offline speech QA fixtures.

The caller supplies a fresh, exact Git checkout; this script never downloads,
installs system-wide, acquires extra voices, or uses an audio device. Build
outputs stay in that disposable checkout. WAVs, bounded logs and provenance
are written to a new output directory owned by the caller.
"""
import argparse
import array
import hashlib
import json
import os
import platform
import selectors
import signal
import subprocess
import sys
import time
import wave
from pathlib import Path


FLITE_COMMIT = "6c9f20dc915b17f5619340069889db0aa007fcdc"
FLITE_REPOSITORY = "https://github.com/festvox/flite"
MAX_LOG_BYTES = 2 * 1024 * 1024
TEXTS = {"positive": "Hey Dot.", "negative": "The weather is calm today."}


def interrupted(signum, _frame):
    # Turn supervisor cancellation into stack unwinding so run_logged can kill
    # the detached make/compiler process group before the helper exits.
    signal.signal(signum, signal.SIG_IGN)
    raise RuntimeError(f"speech_preparation_interrupted:{signal.Signals(signum).name}")


def sha256(filename):
    with filename.open("rb") as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
        return digest.hexdigest()


def kill_group(process):
    # make can own compiler grandchildren; stopping only make would leak them.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=3)


def run_logged(command, cwd, output, label, report, deadline, timeout):
    end = min(deadline, time.monotonic() + timeout)
    if end <= time.monotonic():
        raise RuntimeError("speech_preparation_deadline")
    log_path = output / f"{label}.log"
    stage = {"name": label, "command": command, "log": log_path.name, "result": "failed"}
    report["stages"].append(stage)
    started = time.monotonic()
    process = None
    try:
        with log_path.open("wb") as log, selectors.DefaultSelector() as selector:
            process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            selector.register(process.stdout, selectors.EVENT_READ)
            written = 0
            while selector.get_map():
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(f"{label} timed out")
                for key, _ in selector.select(timeout=min(0.2, remaining)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    if written + len(chunk) > MAX_LOG_BYTES:
                        log.write(chunk[:MAX_LOG_BYTES - written])
                        raise RuntimeError(f"{label} exceeded its {MAX_LOG_BYTES}-byte log bound")
                    log.write(chunk)
                    written += len(chunk)
            stage["exitCode"] = process.wait(timeout=max(0.01, end - time.monotonic()))
            stage["logBytes"] = written
            if stage["exitCode"]:
                raise RuntimeError(f"{label} exited with code {stage['exitCode']}; see {log_path.name}")
            stage["result"] = "passed"
    except BaseException:
        if process is not None:
            kill_group(process)
        raise
    finally:
        if process is not None and process.stdout is not None:
            process.stdout.close()
        stage["elapsedSeconds"] = round(time.monotonic() - started, 3)


def git_value(source, arguments, deadline):
    remaining = min(10, deadline - time.monotonic())
    if remaining <= 0:
        raise RuntimeError("speech_preparation_deadline")
    result = subprocess.run(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(source), *arguments],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=remaining, check=False)
    if result.returncode:
        raise RuntimeError(f"Cannot inspect Flite checkout: {result.stderr.decode(errors='replace')[-2000:]}")
    return result.stdout.decode("utf-8").strip()


def wav_evidence(filename):
    if filename.stat().st_size > 16000 * 15 * 2 + 65536:
        raise RuntimeError(f"{filename.name}: speech fixture exceeds size bound")
    with wave.open(str(filename), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, "NONE"):
            raise RuntimeError(f"{filename.name}: expected mono 16 kHz PCM16 WAV")
        frames = wav.getnframes()
        if not 1600 <= frames <= 16000 * 15:
            raise RuntimeError(f"{filename.name}: duration outside 0.1–15 seconds")
        samples = array.array("h", wav.readframes(frames))
    if len(samples) != frames:
        raise RuntimeError(f"{filename.name}: truncated speech fixture")
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max(abs(sample) for sample in samples) / 32768
    if peak < 0.001:
        raise RuntimeError(f"{filename.name}: silent speech fixture")
    return {"path": str(filename), "sha256": sha256(filename), "sampleRate": 16000,
            "channels": 1, "sampleFormat": "pcm16le", "frames": frames,
            "seconds": round(frames / 16000, 4), "peak": peak}


def prepare(source, output, report, deadline):
    if os.name != "posix":
        raise RuntimeError("POSIX build host required for bounded process-group cleanup")
    if not source.is_dir():
        raise RuntimeError("--flite-source must be an existing Git checkout")
    if source == output or source in output.parents:
        raise RuntimeError("--output-dir must be outside the Flite checkout")
    if Path(git_value(source, ["rev-parse", "--show-toplevel"], deadline)).resolve() != source:
        raise RuntimeError("--flite-source must be the checkout root")
    commit = git_value(source, ["rev-parse", "HEAD"], deadline)
    if commit != FLITE_COMMIT:
        raise RuntimeError(f"Flite HEAD must be {FLITE_COMMIT}; found {commit}")
    # Ignored build outputs are also rejected, preventing reuse of stale objects
    # while reporting the source commit as the provenance of a different binary.
    if git_value(source, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], deadline):
        raise RuntimeError("Flite checkout must be clean, including ignored build outputs")
    report.update(sourceCommit=commit, sourceDirectory=str(source), sourceCleanBeforeBuild=True,
                  sourceLicenseSha256=sha256(source / "COPYING"))
    # This Flite revision does not propagate configure's DEFS into compile
    # rules; CPPFLAGS ensures CST_NO_SOCKETS reaches cst_socket.c as well.
    run_logged([str(source / "configure"), "--with-audio=none", "--disable-shared", "--disable-sockets",
                "CPPFLAGS=-DCST_NO_SOCKETS"],
               source, output, "configure", report, deadline, 60)
    run_logged(["make", "-j2"], source, output, "build", report, deadline, 210)
    binary = source / "bin/flite"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError("Flite build did not produce executable bin/flite")
    report.update(binary=str(binary), binarySha256=sha256(binary))
    run_logged([str(binary), "-lv"], source, output, "voices", report, deadline, 5)
    inventory = (output / "voices.log").read_text(encoding="utf-8").strip()
    if "slt" not in inventory.split():
        raise RuntimeError("Compiled Flite must include slt; unknown voice names silently fall back")
    report["voiceInventory"] = inventory
    for name, text in TEXTS.items():
        wav = output / f"{name}.wav"
        run_logged([str(binary), "-voice", "slt", "-t", text, "-o", str(wav)],
                   source, output, name, report, deadline, 10)
        report["fixtures"][name] = {"text": text, "voice": "slt", **wav_evidence(wav)}
    report.update(success=True, prepareWakeSpeech="passed")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flite-source", type=Path, required=True, help="Fresh checkout of the pinned source commit")
    parser.add_argument("--output-dir", type=Path, required=True, help="New directory for speech fixtures, logs and provenance")
    args = parser.parse_args(argv)
    started = time.monotonic()
    report = {"success": False, "prepareWakeSpeech": "failed", "sourceRepository": FLITE_REPOSITORY,
              "expectedSourceCommit": FLITE_COMMIT, "hostPlatform": sys.platform, "hostMachine": platform.machine(),
              "generator": "Flite", "voice": "slt", "audioBackend": "none", "sharedLibraries": False, "networkSockets": False,
              "networkUsedByHelper": False, "physicalMicrophoneTested": False, "audibleOutputTested": False,
              "fixtures": {}, "stages": []}
    output = None
    previous_handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        if not args.flite_source.is_absolute() or not args.output_dir.is_absolute():
            raise RuntimeError("--flite-source and --output-dir must be absolute paths")
        source = args.flite_source.resolve()
        candidate = args.output_dir.resolve()
        if source == candidate or source in candidate.parents:
            raise RuntimeError("--output-dir must be outside the Flite checkout")
        candidate.mkdir(parents=True, exist_ok=False)
        output = candidate
        prepare(source, output, report, started + 300)
    except (RuntimeError, OSError, ValueError, EOFError, wave.Error, subprocess.SubprocessError) as error:
        report["error"] = str(error)
        print(f"Wake speech preparation failed: {error}", file=sys.stderr)
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    if output is not None:
        try:
            (output / "provenance.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        except OSError as error:
            report.update(success=False, prepareWakeSpeech="failed", error=f"Cannot write provenance: {error}")
    print(json.dumps(report, sort_keys=True))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
