'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const setup = path.join(__dirname, '..', 'scripts', 'setup-wake.py');
const { MODEL_FILES } = require('../src/wake-runtime.cjs');
const available = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0;
const pythonTest = (name, body) => test(name, { skip: available ? false : 'optional Python 3 is not installed' }, () => {
  const prelude = `
import contextlib
import hashlib
import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import tarfile
from pathlib import Path
from unittest import mock
m = runpy.run_path(sys.argv[1])
model_files = json.loads(sys.argv[2])

def populate_model(model, missing=(), empty=(), content=b"existing model"):
    model.mkdir(parents=True, exist_ok=True)
    for name in model_files:
        if name not in missing:
            (model / name).write_bytes(b"" if name in empty else content)

def fixture_archive(root, missing=(), empty=()):
    archive = root / "fixture-model.tar.bz2"
    with tarfile.open(archive, "w:bz2") as target:
        for name in model_files:
            if name in missing:
                continue
            content = b"" if name in empty else ("replacement " + name).encode()
            entry = tarfile.TarInfo(m["MODEL"] + "/" + name)
            entry.size = len(content)
            entry.mode = 0o644
            target.addfile(entry, io.BytesIO(content))
    return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

def local_setup(data, archive, digest):
    with mock.patch.object(sys, "version_info", (3, 12, 0)), \\
         mock.patch.object(m["subprocess"], "run"), \\
         mock.patch.object(m["urllib"].request, "urlopen", side_effect=AssertionError("Unexpected download")), \\
         mock.patch.dict(m["main"].__globals__, {"SHA256": digest}), \\
         contextlib.redirect_stdout(io.StringIO()):
        m["main"](["--data-dir", str(data), "--archive", str(archive)])
`;
  const result = spawnSync('python3', ['-B', '-c', prelude + body, setup, JSON.stringify(MODEL_FILES)], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

pythonTest('wake setup accepts Python 3.10-3.13 and refuses other versions before side effects', `
for version in [(3, 10, 0), (3, 11, 9), (3, 12, 14), (3, 13, 9)]:
    m["require_supported_python"](version)
for version in [(3, 9, 21), (3, 14, 0), (4, 0, 0)]:
    with tempfile.TemporaryDirectory() as root:
        data = Path(root) / "must-not-exist"
        errors = io.StringIO()
        with mock.patch.object(sys, "version_info", version), \\
             mock.patch.object(Path, "mkdir") as mkdir, \\
             mock.patch.object(m["subprocess"], "run") as run, \\
             mock.patch.object(m["urllib"].request, "urlopen") as download, \\
             contextlib.redirect_stderr(errors):
            try:
                m["main"](["--data-dir", str(data)])
                raise AssertionError("Unsupported Python accepted")
            except SystemExit as error:
                assert error.code == 2
            mkdir.assert_not_called()
            run.assert_not_called()
            download.assert_not_called()
        assert "Python 3.10-3.13" in errors.getvalue(), errors.getvalue()
        assert ".".join(map(str, version)) in errors.getvalue(), errors.getvalue()
        assert "python3.13" in errors.getvalue(), errors.getvalue()
        assert not data.exists()
`);

pythonTest('wake setup data defaults agree with native macOS and explicit XDG paths', `
home = Path("/Users/example")
default = m["default_data_dir"]
assert default("darwin", {}, home) == home / "Library/Application Support/DotDial/data"
assert default("linux", {}, home) == home / ".local/share/dotdial"
for platform in ["darwin", "linux"]:
    assert default(platform, {"XDG_DATA_HOME": "/relocated/data"}, home) == Path("/relocated/data/dotdial")
    assert default(platform, {"XDG_DATA_HOME": ""}, home) == default(platform, {}, home)
`);

pythonTest('only explicit macOS stdin audio omits sounddevice and preserves other exact pins', `
requirements = str(Path(sys.argv[1]).with_name("wake-requirements.txt"))
args = m["dependency_args"]
assert args(False, "linux") == ["-r", requirements]
assert args(True, "linux") == ["-r", requirements]
assert args(False, "darwin") == ["-r", requirements]
assert args(True, "darwin") == ["sherpa-onnx==1.13.8", "sentencepiece==0.2.2", "numpy==2.2.6"]
`);

pythonTest('wake setup passes the selected dependency mode to pip with no real installs or downloads', `
for platform in ["darwin", "linux"]:
    with tempfile.TemporaryDirectory() as root:
        data = Path(root) / "chosen data"
        model = data / "models" / m["MODEL"]
        populate_model(model)
        # Setup canonicalizes --data-dir, including macOS /var -> /private/var.
        resolved_data = data.resolve()
        with mock.patch.object(sys, "version_info", (3, 12, 0)), \\
             mock.patch.object(sys, "platform", platform), \\
             mock.patch.object(m["subprocess"], "run") as run, \\
             mock.patch.object(m["urllib"].request, "urlopen") as download, \\
             contextlib.redirect_stdout(io.StringIO()):
            m["main"](["--data-dir", str(data), "--stdin-audio"])
            download.assert_not_called()
        assert run.call_count == 2, run.call_args_list
        assert run.call_args_list[0].args[0] == [sys.executable, "-m", "venv", str(resolved_data / "wake-venv")]
        assert run.call_args_list[1].args[0] == [
            str(resolved_data / "wake-venv/bin/python"), "-m", "pip", "install", "--disable-pip-version-check",
            *m["dependency_args"](True, platform),
        ]
`);

pythonTest('an existing wake environment is checked before pip and incompatible or broken Python fails clearly', `
scenarios = [
    (subprocess.CompletedProcess([], 0, stdout="3.14.0\\n"), "Existing wake environment"),
    (subprocess.CompletedProcess([], 0, stdout="unrecognized\\n"), "Cannot check"),
    (subprocess.TimeoutExpired("python", 5), "Cannot check"),
]
for outcome, expected in scenarios:
    with tempfile.TemporaryDirectory() as root:
        data = Path(root)
        python = data / "wake-venv/bin/python"
        python.parent.mkdir(parents=True)
        python.write_text("not a real interpreter")
        errors = io.StringIO()
        with mock.patch.object(sys, "version_info", (3, 12, 0)), \\
             mock.patch.object(Path, "mkdir") as mkdir, \\
             mock.patch.object(m["subprocess"], "run") as run, \\
             mock.patch.object(m["urllib"].request, "urlopen") as download, \\
             contextlib.redirect_stderr(errors):
            if isinstance(outcome, BaseException):
                run.side_effect = outcome
            else:
                run.return_value = outcome
            try:
                m["main"](["--data-dir", str(data)])
                raise AssertionError("Incompatible environment accepted")
            except SystemExit as error:
                assert error.code == 2
            mkdir.assert_not_called()
            download.assert_not_called()
        assert run.call_count == 1, run.call_args_list
        assert run.call_args.kwargs["timeout"] == 5
        assert run.call_args.args[0][:2] == [str(data.resolve() / "wake-venv/bin/python"), "-c"]
        assert expected in errors.getvalue(), errors.getvalue()
        assert "Recreate" in errors.getvalue(), errors.getvalue()
        assert "--data-dir" in errors.getvalue(), errors.getvalue()
`);

pythonTest('a compatible existing wake Python is reused only after its bounded version probe', `
with tempfile.TemporaryDirectory() as root:
    data = Path(root)
    python = data / "wake-venv/bin/python"
    python.parent.mkdir(parents=True)
    python.write_text("not a real interpreter")
    model = data / "models" / m["MODEL"]
    populate_model(model)
    with mock.patch.object(sys, "version_info", (3, 12, 0)), \\
         mock.patch.object(m["subprocess"], "run", return_value=subprocess.CompletedProcess([], 0, stdout="3.13.2\\n")) as run, \\
         mock.patch.object(m["urllib"].request, "urlopen") as download, \\
         contextlib.redirect_stdout(io.StringIO()):
        m["main"](["--data-dir", str(data)])
        download.assert_not_called()
    assert run.call_count == 2
    assert run.call_args_list[0].args[0][:2] == [str(data.resolve() / "wake-venv/bin/python"), "-c"]
    assert run.call_args_list[0].kwargs["timeout"] == 5
    assert run.call_args_list[1].args[0][:4] == [str(data.resolve() / "wake-venv/bin/python"), "-m", "pip", "install"]
`);

pythonTest('a supplied wake archive still must match SHA-256 before extraction or model publication', `
with tempfile.TemporaryDirectory() as root:
    data = Path(root) / "data"
    archive = Path(root) / "wrong.tar.bz2"
    archive.write_bytes(b"invalid model archive")
    with mock.patch.object(sys, "version_info", (3, 12, 0)), \\
         mock.patch.object(m["subprocess"], "run"), \\
         mock.patch.object(m["urllib"].request, "urlopen") as download, \\
         mock.patch.object(m["tarfile"], "open") as extract, \\
         mock.patch.object(m["os"], "replace") as publish:
        try:
            m["main"](["--data-dir", str(data), "--archive", str(archive)])
            raise AssertionError("Mismatched archive accepted")
        except RuntimeError as error:
            assert "checksum mismatch" in str(error)
        download.assert_not_called()
        extract.assert_not_called()
        publish.assert_not_called()
    assert not (data / "models" / m["MODEL"]).exists()
`);

pythonTest('wake setup installs a full model and repairs tokens-only, missing-BPE and empty-encoder models', `
assert tuple(m["MODEL_FILES"]) == tuple(model_files), "installer and runtime readiness contracts differ"
for damage in ["absent", "tokens-only", "missing-bpe", "empty-encoder"]:
    with tempfile.TemporaryDirectory() as root:
        root = Path(root)
        data = root / "data"
        model = data / "models" / m["MODEL"]
        if damage == "absent":
            data.mkdir()
        else:
            populate_model(model,
                missing=[name for name in model_files if name != "tokens.txt"] if damage == "tokens-only" else
                        ["bpe.model"] if damage == "missing-bpe" else [],
                empty=[model_files[2]] if damage == "empty-encoder" else [])
        outside = data / "other-user-file"
        outside.write_text("preserve unrelated data")
        archive, digest = fixture_archive(root)
        local_setup(data, archive, digest)
        for name in model_files:
            assert (model / name).read_bytes() == ("replacement " + name).encode(), (damage, name)
        assert outside.read_text() == "preserve unrelated data"
        assert sorted(path.name for path in (data / "models").iterdir()) == [m["MODEL"]]
`);

pythonTest('wake setup preserves a complete installed model instead of replacing it', `
with tempfile.TemporaryDirectory() as root:
    root = Path(root)
    data = root / "data"
    model = data / "models" / m["MODEL"]
    populate_model(model, content=b"keep valid installed model")
    identity = (model / "tokens.txt").stat().st_ino
    archive, digest = fixture_archive(root)
    local_setup(data, archive, digest)
    assert (model / "tokens.txt").stat().st_ino == identity
    assert all((model / name).read_bytes() == b"keep valid installed model" for name in model_files)
`);

pythonTest('wake setup validates every staged required file before touching an invalid installed model', `
for missing, empty in [(["bpe.model"], []), ([], [model_files[2]])]:
    with tempfile.TemporaryDirectory() as root:
        root = Path(root)
        data = root / "data"
        model = data / "models" / m["MODEL"]
        populate_model(model, missing=["bpe.model"], content=b"old partial model")
        before = {file.name: file.read_bytes() for file in model.iterdir()}
        archive, digest = fixture_archive(root, missing=missing, empty=empty)
        with mock.patch.object(m["os"], "replace", wraps=os.replace) as replace:
            try:
                local_setup(data, archive, digest)
                raise AssertionError("Incomplete staged model accepted")
            except RuntimeError as error:
                assert "required model files" in str(error), error
            replace.assert_not_called()
        assert {file.name: file.read_bytes() for file in model.iterdir()} == before
        assert not list(data.glob(".dotdial-wake-*"))
`);

pythonTest('wake setup rolls back the previous model when publishing its prepared replacement fails', `
with tempfile.TemporaryDirectory() as root:
    root = Path(root)
    data = root / "data"
    model = data / "models" / m["MODEL"]
    populate_model(model, missing=["bpe.model"], content=b"old partial model")
    before = {file.name: file.read_bytes() for file in model.iterdir()}
    archive, digest = fixture_archive(root)
    original = os.replace
    def fail_commit(source, destination):
        if Path(destination) == model.resolve() and Path(source).parent.name.startswith(".dotdial-wake-"):
            raise OSError("injected model commit failure")
        return original(source, destination)
    with mock.patch.object(m["os"], "replace", side_effect=fail_commit):
        try:
            local_setup(data, archive, digest)
            raise AssertionError("Injected commit failure was ignored")
        except OSError as error:
            assert "injected model commit failure" in str(error), error
    assert {file.name: file.read_bytes() for file in model.iterdir()} == before
    assert sorted(file.name for file in model.parent.iterdir()) == [m["MODEL"]]
`);

pythonTest('wake setup preserves recoverable backup data if both replacement and rollback fail', `
with tempfile.TemporaryDirectory() as root:
    root = Path(root)
    data = root / "data"
    model = data / "models" / m["MODEL"]
    populate_model(model, missing=["bpe.model"], content=b"preserve rollback data")
    before = {file.name: file.read_bytes() for file in model.iterdir()}
    archive, digest = fixture_archive(root)
    original = os.replace
    def fail_publish_and_restore(source, destination):
        if Path(destination) == model.resolve():
            raise OSError("injected replacement/rollback failure")
        return original(source, destination)
    with mock.patch.object(m["os"], "replace", side_effect=fail_publish_and_restore):
        try:
            local_setup(data, archive, digest)
            raise AssertionError("Failed rollback was ignored")
        except RuntimeError as error:
            assert "previous model preserved at" in str(error), error
    backups = list(model.parent.glob("." + m["MODEL"] + "-previous-*"))
    assert len(backups) == 1 and not model.exists(), backups
    preserved = backups[0] / m["MODEL"]
    assert {file.name: file.read_bytes() for file in preserved.iterdir()} == before
    assert not list(data.glob(".dotdial-wake-*")), "archive staging is still cleaned"
`);

pythonTest('wake setup rejects model-root and required-file symlinks without touching their targets', `
for kind in ["models-parent", "model-root", "required-file", "special-file"]:
    with tempfile.TemporaryDirectory() as root:
        root = Path(root)
        data = root / "data"
        data.mkdir()
        model = data / "models" / m["MODEL"]
        outside = root / "outside"
        populate_model(outside, content=b"outside data")
        if kind == "models-parent":
            (data / "models").symlink_to(outside, target_is_directory=True)
        elif kind == "model-root":
            model.parent.mkdir()
            model.symlink_to(outside, target_is_directory=True)
        else:
            populate_model(model)
            (model / "bpe.model").unlink()
            if kind == "required-file":
                (model / "bpe.model").symlink_to(outside / "bpe.model")
            else:
                os.mkfifo(model / "bpe.model")
        archive, digest = fixture_archive(root)
        try:
            local_setup(data, archive, digest)
            raise AssertionError("Unsafe model state accepted: " + kind)
        except RuntimeError as error:
            assert "Unsafe wake model" in str(error), error
        assert all((outside / name).read_bytes() == b"outside data" for name in model_files)
`);
