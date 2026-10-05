#!/usr/bin/env python3
"""Recognize local synthetic speech with the installed, unmodified wake listener.

Requires an existing managed wake environment/model and two externally generated
synthetic speech fixtures from the CI's pinned open-source TTS: "Hey Dot." and
"The weather is calm today." as mono 16 kHz PCM16 WAV. This helper never plays,
records, downloads, or removes those files. It checks recognition, not a physical
microphone, Electron capture, TCC permission, or an account call.
"""
import argparse
import array
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import wave
from pathlib import Path


MODEL = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
PHRASE = "Hey Dot"
OTHER_PHRASE = "Purple Moon"
NEGATIVE_TEXT = "The weather is calm today."
SAMPLE_RATE = 16000
SENSITIVITY = 6
MAX_SECONDS = 15
RUNTIME_PROBE = """
import json, platform, sys
print(json.dumps({"prefix": sys.prefix, "interpreter": sys.executable,
                  "platform": sys.platform, "machine": platform.machine(),
                  "pythonVersion": platform.python_version()}))
"""


def run_bounded(command, deadline, stage, pcm=None, timeout=30):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("wake_speech_deadline")
    try:
        return subprocess.run(command, input=pcm, capture_output=True,
                              stdin=subprocess.DEVNULL if pcm is None else None,
                              timeout=min(timeout, remaining), check=False)
    except subprocess.TimeoutExpired as error:
        # subprocess.run kills and waits for its direct child on timeout.
        raise RuntimeError(f"{stage} timed out") from error
    except OSError as error:
        raise RuntimeError(f"Cannot start {stage}: {error}") from error


def require_success(result, stage):
    if result.returncode:
        details = (result.stderr + b"\n" + result.stdout).decode("utf-8", errors="replace")[-4000:]
        raise RuntimeError(f"{stage} exited with code {result.returncode}: {details.strip()}")


def read_pcm(filename):
    """Validate the rendered fixture and convert PCM16 to the actual stdin format."""
    if filename.stat().st_size > SAMPLE_RATE * MAX_SECONDS * 2 + 65536:
        raise RuntimeError("Rendered speech exceeds the fixture size bound")
    with wave.open(str(filename), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
            raise RuntimeError("Rendered speech must be mono 16 kHz PCM16 WAV")
        frames = wav.getnframes()
        if not SAMPLE_RATE // 10 <= frames <= SAMPLE_RATE * MAX_SECONDS:
            raise RuntimeError("Rendered speech duration is outside the fixture bound")
        raw = wav.readframes(frames)
    if len(raw) != frames * 2:
        raise RuntimeError("Rendered speech is truncated")
    samples = array.array("h", raw)
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max(abs(value) for value in samples) / 32768
    if peak < 0.001:
        raise RuntimeError("Rendered speech is silent")
    normalized = array.array("f", (value / 32768 for value in samples))
    if sys.byteorder != "little":
        normalized.byteswap()
    # Half a second of initial silence and a half-second tail give the streaming
    # model context and time to emit its trailing blank, as live capture does.
    pcm = bytes(SAMPLE_RATE // 2 * 4) + normalized.tobytes() + bytes(SAMPLE_RATE // 2 * 4)
    return pcm, {"speechSeconds": round(frames / SAMPLE_RATE, 4), "speechFrames": frames,
                 "peak": peak, "pcmBytes": len(pcm), "pcmSha256": hashlib.sha256(pcm).hexdigest(),
                 "leadingSilenceSeconds": 0.5, "trailingSilenceSeconds": 0.5}


def validate_events(result, case):
    """Ready alone is never a positive result; any error or extra event fails."""
    case["exitCode"] = result.returncode
    case["stderr"] = result.stderr.decode("utf-8", errors="replace")[-4000:]
    try:
        if len(result.stdout) > 65536:
            raise ValueError("too much output")
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        if any(not isinstance(event, dict) or event.get("event") not in ("ready", "wake") for event in events):
            raise ValueError("unknown event or listener error")
        names = [event["event"] for event in events]
    except (ValueError, TypeError) as error:
        raise RuntimeError(f"{case['name']}: invalid listener events: {result.stdout[-2000:]!r}") from error
    case.update(readyCount=names.count("ready"), wakeCount=names.count("wake"), eofExit=result.returncode == 0)
    require_success(result, case["name"])
    if not names or names[0] != "ready" or case["readyCount"] != 1:
        raise RuntimeError(f"{case['name']}: expected exactly one ready event before detection")
    if case["expectWake"] and not case["wakeCount"]:
        raise RuntimeError(f"{case['name']}: real model did not recognize {case['configuredPhrase']!r}")
    if not case["expectWake"] and case["wakeCount"]:
        raise RuntimeError(f"{case['name']}: negative control produced {case['wakeCount']} unexpected wake events")
    case["result"] = "passed"


def smoke(data, app_source, positive_wav, negative_wav, report, deadline):
    if sys.platform != "darwin":
        raise RuntimeError("This smoke requires native macOS; it cannot pass or skip on another host")
    python = data / "wake-venv/bin/python"
    listener = app_source / "src/wake/listener.py"
    model = data / "models" / MODEL
    report.update(interpreter=str(python), appSource=str(app_source), listener=str(listener), model=str(model))
    if not python.is_file() or not listener.is_file() or not model.is_dir():
        raise RuntimeError("Managed wake Python, model, and application listener are required; run setup-wake.py first")
    runtime = run_bounded([str(python), "-I", "-c", RUNTIME_PROBE], deadline, "private Python", timeout=10)
    require_success(runtime, "private Python")
    report["runtime"] = json.loads(runtime.stdout)
    expected_machine = {"arm64": "arm64", "x64": "x86_64", "x86_64": "x86_64"}.get(
        os.environ.get("DOTDIAL_TARGET_ARCH", platform.machine()))
    if (report["runtime"].get("platform") != "darwin" or not expected_machine
            or report["runtime"].get("machine") != expected_machine
            or Path(report["runtime"].get("prefix", "")).resolve() != (data / "wake-venv").resolve()):
        raise RuntimeError("Recognition must use the selected private Python on the native target architecture")

    report["stage"] = "speech_fixtures"
    fixtures = {}
    for name, filename, text in (("positive", positive_wav, PHRASE + "."),
                                 ("unrelated", negative_wav, NEGATIVE_TEXT)):
        pcm, evidence = read_pcm(filename)
        fixtures[name] = pcm
        report["fixtures"][name] = {"path": str(filename), "expectedText": text,
                                   "wavSha256": hashlib.sha256(filename.read_bytes()).hexdigest(), **evidence}
    if fixtures["positive"] == fixtures["unrelated"]:
        raise RuntimeError("Positive and unrelated speech fixtures must contain different PCM")

    report["stage"] = "recognition"
    for name, fixture, phrase, expect_wake in (
        ("exact_phrase", "positive", PHRASE, True),
        ("unrelated_speech", "unrelated", PHRASE, False),
        ("different_configured_phrase", "positive", OTHER_PHRASE, False),
    ):
        case = {"name": name, "fixture": fixture, "configuredPhrase": phrase,
                "sensitivity": SENSITIVITY, "expectWake": expect_wake, "result": "failed"}
        report["cases"].append(case)
        result = run_bounded([str(python), "-I", str(listener), "--stdin-audio", "--model", str(model),
                              "--phrase", phrase, "--sensitivity", str(SENSITIVITY)],
                             deadline, name, fixtures[fixture], timeout=35)
        validate_events(result, case)
    report.update(stage="complete", success=True, wakeSpeechSmoke="passed")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--app-source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--positive-wav", type=Path, required=True, help="Synthetic speech saying: Hey Dot.")
    parser.add_argument("--negative-wav", type=Path, required=True, help="Synthetic speech saying: The weather is calm today.")
    parser.add_argument("--output", type=Path, help="Also write the JSON QA report here")
    args = parser.parse_args(argv)
    started = time.monotonic()
    report = {"success": False, "wakeSpeechSmoke": "failed", "stage": "preflight",
              "hostPlatform": sys.platform, "hostMachine": platform.machine(),
              "provenance": {"kind": "externally_generated_synthetic_speech",
                             "inputFixturesOwnedByCaller": True, "downloadedBySmoke": False},
              "sampleRate": SAMPLE_RATE, "channels": 1, "sampleFormat": "float32le",
              "physicalMicrophoneTested": False, "electronCaptureTested": False,
              "tccTested": False, "accountCallTested": False, "fixtures": {}, "cases": []}
    try:
        smoke(args.data_dir.resolve(), args.app_source.resolve(), args.positive_wav.resolve(),
              args.negative_wav.resolve(), report, started + 140)
    except (RuntimeError, OSError, ValueError, TypeError, EOFError, wave.Error) as error:
        report["error"] = str(error)
        print(f"Wake speech smoke failed: {error}", file=sys.stderr)
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    if args.output:
        try:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        except OSError as error:
            report.update(success=False, wakeSpeechSmoke="failed", error=f"Cannot write QA report: {error}")
    print(json.dumps(report, sort_keys=True))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
