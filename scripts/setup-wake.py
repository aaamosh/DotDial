#!/usr/bin/env python3
"""Install the optional offline English wake-word engine into user data only."""
import argparse
import hashlib
import inspect
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

MODEL = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{MODEL}.tar.bz2"
SHA256 = "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"


def require_supported_python(version_info=None):
    version_info = sys.version_info if version_info is None else version_info
    if not (3, 10) <= tuple(version_info[:2]) < (3, 14):
        detected = ".".join(str(part) for part in version_info[:3])
        raise RuntimeError(
            f"Wake-word setup requires Python 3.10-3.13; found Python {detected}. "
            "The pinned NumPy 2.2.6 supports Python >=3.10,<3.14. "
            "Run this script with a supported interpreter, for example python3.13."
        )


def default_data_dir(platform=None, environ=None, home=None):
    platform = sys.platform if platform is None else platform
    environ = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    if environ.get("XDG_DATA_HOME"):
        return Path(environ["XDG_DATA_HOME"]) / "dotdial"
    if platform == "darwin":
        return home / "Library/Application Support/DotDial/data"
    return home / ".local/share/dotdial"


def dependency_args(stdin_audio=False, platform=None):
    platform = sys.platform if platform is None else platform
    requirements = Path(__file__).with_name("wake-requirements.txt")
    if not stdin_audio or platform != "darwin":
        return ["-r", str(requirements)]
    # Electron captures microphone audio on macOS. Keep a single set of pins,
    # but avoid installing PortAudio bindings into its PCM-only recognizer.
    packages = []
    for raw_line in requirements.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)", line)
        if not match:
            raise RuntimeError("Wake dependencies must use exact package==version pins")
        if match.group(1).lower() != "sounddevice":
            packages.append(line)
    return packages


def check_existing_venv(python):
    try:
        result = subprocess.run(
            [str(python), "-c", 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
            check=True, capture_output=True, text=True, timeout=5,
        )
        parts = result.stdout.strip().split(".")
        if len(parts) != 3 or not all(part.isdigit() for part in parts):
            raise ValueError("Unexpected Python version output")
        version = tuple(int(part) for part in parts)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise RuntimeError(
            f"Cannot check the existing wake environment at {python.parent.parent}. "
            "Recreate it with Python 3.10-3.13 or choose another --data-dir."
        ) from error
    try:
        require_supported_python(version)
    except RuntimeError as error:
        raise RuntimeError(
            f"Existing wake environment at {python.parent.parent}: {error} "
            "Recreate this environment or choose another --data-dir."
        ) from error


def extract_checked_model(source, destination):
    destination = destination.resolve()
    members = source.getmembers()
    for member in members:
        relative = Path(member.name)
        parts = relative.parts
        target = (destination / relative).resolve()
        if (not parts or parts[0] != MODEL or ".." in parts or relative.is_absolute() or
                not target.is_relative_to(destination) or not (member.isfile() or member.isdir())):
            raise RuntimeError("Unexpected wake archive entry")

    if "filter" in inspect.signature(source.extractall).parameters:
        source.extractall(destination, members=members, filter="data")
        return

    # Python versions before tarfile's data filter are still safe here because
    # links and special files are rejected above and every member is confined
    # below a new private staging directory.
    for member in members:
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        member.mode = 0o755 if member.isdir() else 0o644
    source.extractall(destination, members=members)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    parser.add_argument("--archive", type=Path, help="Use a previously downloaded archive; SHA-256 is still required")
    parser.add_argument("--stdin-audio", action="store_true", help="On macOS, omit microphone bindings when Electron supplies PCM audio")
    args = parser.parse_args(argv)
    try:
        require_supported_python()
        requirements = dependency_args(args.stdin_audio)
    except RuntimeError as error:
        parser.error(str(error))
    data = args.data_dir.resolve()
    venv = data / "wake-venv"
    python = venv / "bin/python"
    if python.exists():
        try:
            check_existing_venv(python)
        except RuntimeError as error:
            parser.error(str(error))
    data.mkdir(parents=True,exist_ok=True,mode=0o700)
    if not python.exists():
        subprocess.run([sys.executable,"-m","venv",str(venv)],check=True)
    subprocess.run([str(python),"-m","pip","install","--disable-pip-version-check",*requirements],check=True)
    models = data/"models";models.mkdir(exist_ok=True,mode=0o700)
    if not (models/MODEL/"tokens.txt").exists():
        with tempfile.TemporaryDirectory(prefix=".dotdial-wake-",dir=data) as temporary:
            stage = Path(temporary); archive = stage/"model.tar.bz2"
            if args.archive: shutil.copyfile(args.archive,archive)
            else:
                with urllib.request.urlopen(URL,timeout=60) as response, archive.open("wb") as target:
                    shutil.copyfileobj(response,target)
            if hashlib.sha256(archive.read_bytes()).hexdigest()!=SHA256:
                raise RuntimeError("Wake model checksum mismatch")
            with tarfile.open(archive,"r:bz2") as source:
                extract_checked_model(source, stage)
            os.replace(stage/MODEL,models/MODEL)
    print("Offline wake-word engine installed. Enable it in DotDial settings.")


if __name__=="__main__":
    main()
