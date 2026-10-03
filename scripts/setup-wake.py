#!/usr/bin/env python3
"""Install the optional offline English wake-word engine into user data only."""
import argparse
import hashlib
import inspect
import os
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("XDG_DATA_HOME", Path.home()/".local/share"))/"dotdial")
    parser.add_argument("--archive", type=Path, help="Use a previously downloaded archive; SHA-256 is still required")
    args = parser.parse_args()
    data = args.data_dir.resolve()
    data.mkdir(parents=True,exist_ok=True,mode=0o700)
    venv = data / "wake-venv"
    if not (venv/"bin/python").exists():
        subprocess.run([sys.executable,"-m","venv",str(venv)],check=True)
    subprocess.run([str(venv/"bin/python"),"-m","pip","install","--disable-pip-version-check","-r",str(Path(__file__).with_name("wake-requirements.txt"))],check=True)
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
