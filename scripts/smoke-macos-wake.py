#!/usr/bin/env python3
"""Check installed wake wheels and the packaged PCM listener without a microphone.

Run after setup-wake.py --stdin-audio. This helper uses only the standard
library; imports and inference run in the selected private wake environment.
It does not install dependencies, download models, or use an account.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


MODEL = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
EXPECTED_VERSIONS = {"numpy": "2.2.6", "sherpa-onnx": "1.13.8", "sentencepiece": "0.2.2"}
SAMPLE_RATE = 16000
SAMPLES = SAMPLE_RATE * 2
IMPORT_PROBE = """
import importlib.metadata
import json
import platform
import sys
import numpy
import sherpa_onnx
import sentencepiece
print(json.dumps({
    "interpreter": sys.executable,
    "prefix": sys.prefix,
    "pythonVersion": platform.python_version(),
    "platform": sys.platform,
    "machine": platform.machine(),
    "versions": {name: importlib.metadata.version(name)
                 for name in ("numpy", "sherpa-onnx", "sentencepiece")},
    "sounddeviceLoaded": "sounddevice" in sys.modules,
}))
"""


def output_text(value):
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value or ""


def run_bounded(command, timeout, stage, pcm=None):
    try:
        return subprocess.run(command, input=pcm, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"{stage} exceeded its {timeout}-second timeout") from error
    except OSError as error:
        raise RuntimeError(f"Cannot start {stage}: {error}") from error


def process_failure(result, stage):
    details = (output_text(result.stderr) + "\n" + output_text(result.stdout)).strip()[-4000:]
    raise RuntimeError(f"{stage} exited with code {result.returncode}: {details}")


def smoke(data, app_source, report):
    python = data / "wake-venv/bin/python"
    listener = app_source / "src/wake/listener.py"
    model = data / "models" / MODEL
    report.update(interpreter=str(python), appSource=str(app_source), listener=str(listener))
    if not python.is_file():
        raise RuntimeError(f"Wake interpreter is missing: {python}; run setup-wake.py first")
    if not listener.is_file():
        raise RuntimeError(f"Packaged wake listener is missing: {listener}")
    if not model.is_dir():
        raise RuntimeError(f"Wake model is missing: {model}; run setup-wake.py first")

    # -I prevents caller PYTHONPATH and user-site packages from substituting for
    # the wheels installed into this private environment.
    report["stage"] = "imports"
    result = run_bounded([str(python), "-I", "-c", IMPORT_PROBE], 30, "wake dependency imports")
    if result.returncode:
        process_failure(result, "wake dependency imports")
    try:
        runtime = json.loads(output_text(result.stdout))
        report.update({key: runtime[key] for key in
                       ("interpreter", "pythonVersion", "platform", "machine", "versions")})
        prefix = runtime["prefix"]
        sounddevice_loaded = runtime["sounddeviceLoaded"]
    except (ValueError, TypeError, KeyError) as error:
        raise RuntimeError("Wake dependency probe returned invalid runtime information") from error
    if Path(prefix).resolve() != (data / "wake-venv").resolve():
        raise RuntimeError("Dependency imports did not run in the selected private wake environment")
    if report["versions"] != EXPECTED_VERSIONS:
        raise RuntimeError(f"Unexpected wake dependency versions: {report['versions']}; expected {EXPECTED_VERSIONS}")
    if sounddevice_loaded:
        raise RuntimeError("PCM-only dependency imports unexpectedly loaded sounddevice")
    target_arch = os.environ.get("DOTDIAL_TARGET_ARCH")
    if target_arch:
        report["targetArch"] = target_arch
        expected_machine = {"arm64": "arm64", "x64": "x86_64", "x86_64": "x86_64"}.get(target_arch)
        if expected_machine is None:
            raise RuntimeError(f"Unsupported DOTDIAL_TARGET_ARCH: {target_arch}; expected arm64, x64, or x86_64")
        if report["machine"] != expected_machine:
            raise RuntimeError(f"Private wake Python uses {report['machine']}; expected native {expected_machine}")

    report["stage"] = "listener"
    # Positive float32 zero is all-zero bytes in little endian. Two seconds
    # exercise actual model decoding; stdin is closed after all input is sent.
    pcm = bytes(SAMPLES * 4)
    result = run_bounded(
        [str(python), "-I", str(listener), "--stdin-audio", "--model", str(model), "--phrase", "Hey Dot"],
        60, "wake PCM listener", pcm,
    )
    report["listenerExitCode"] = result.returncode
    try:
        events = [json.loads(line) for line in output_text(result.stdout).splitlines() if line.strip()]
        if any(not isinstance(event, dict) or not isinstance(event.get("event"), str) for event in events):
            raise ValueError("Invalid event shape")
    except (ValueError, TypeError) as error:
        raise RuntimeError("Wake PCM listener returned invalid JSON events") from error
    report["readyCount"] = sum(event["event"] == "ready" for event in events)
    report["wakeCount"] = sum(event["event"] == "wake" for event in events)
    errors = [event for event in events if event["event"] == "error"]
    if errors:
        raise RuntimeError(f"Wake PCM listener reported errors: {errors}")
    if result.returncode:
        process_failure(result, "wake PCM listener")
    if report["readyCount"] != 1:
        raise RuntimeError(f"Expected exactly one ready event, received {report['readyCount']}")
    if report["wakeCount"]:
        raise RuntimeError(f"Synthetic silence unexpectedly produced {report['wakeCount']} wake events")
    if any(event["event"] not in ("ready", "wake") for event in events):
        raise RuntimeError("Wake PCM listener returned an unexpected event")
    report.update(stage="complete", success=True, wakeSmoke="passed", eofExit=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True, help="Data directory already populated by setup-wake.py")
    parser.add_argument("--app-source", type=Path, default=Path(__file__).resolve().parents[1],
                        help="Application source root; for a built macOS app use Contents/Resources/app")
    parser.add_argument("--output", type=Path, help="Also write the JSON QA report here, creating parent directories")
    args = parser.parse_args(argv)
    report = {
        "success": False, "wakeSmoke": "failed", "stage": "preflight",
        "expectedVersions": EXPECTED_VERSIONS, "sampleRate": SAMPLE_RATE,
        "channels": 1, "sampleFormat": "float32le", "samples": SAMPLES,
        "seconds": 2, "signal": "silence", "readyCount": 0, "wakeCount": 0,
    }
    started = time.monotonic()
    try:
        smoke(args.data_dir.resolve(), args.app_source.resolve(), report)
    except (RuntimeError, OSError, ValueError, TypeError) as error:
        report["error"] = str(error)
        print(f"Wake smoke failed: {error}", file=sys.stderr)
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    if args.output:
        try:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        except OSError as error:
            report.update(success=False, wakeSmoke="failed", error=f"Cannot write QA report: {error}")
            print(report["error"], file=sys.stderr)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
