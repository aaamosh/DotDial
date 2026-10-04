'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const setup = path.join(__dirname, '..', 'scripts', 'setup-wake.py');
const available = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0;
const pythonTest = (name, body) => test(name, { skip: available ? false : 'optional Python 3 is not installed' }, () => {
  const prelude = `
import contextlib
import io
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock
m = runpy.run_path(sys.argv[1])
`;
  const result = spawnSync('python3', ['-B', '-c', prelude + body, setup], { encoding: 'utf8', timeout: 10000 });
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
        model.mkdir(parents=True)
        (model / "tokens.txt").write_text("existing model")
        with mock.patch.object(sys, "version_info", (3, 12, 0)), \\
             mock.patch.object(sys, "platform", platform), \\
             mock.patch.object(m["subprocess"], "run") as run, \\
             mock.patch.object(m["urllib"].request, "urlopen") as download, \\
             contextlib.redirect_stdout(io.StringIO()):
            m["main"](["--data-dir", str(data), "--stdin-audio"])
            download.assert_not_called()
        assert run.call_count == 2, run.call_args_list
        assert run.call_args_list[0].args[0] == [sys.executable, "-m", "venv", str(data / "wake-venv")]
        assert run.call_args_list[1].args[0] == [
            str(data / "wake-venv/bin/python"), "-m", "pip", "install", "--disable-pip-version-check",
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
        assert run.call_args.args[0][:2] == [str(python), "-c"]
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
    model.mkdir(parents=True)
    (model / "tokens.txt").write_text("existing model")
    with mock.patch.object(sys, "version_info", (3, 12, 0)), \\
         mock.patch.object(m["subprocess"], "run", return_value=subprocess.CompletedProcess([], 0, stdout="3.13.2\\n")) as run, \\
         mock.patch.object(m["urllib"].request, "urlopen") as download, \\
         contextlib.redirect_stdout(io.StringIO()):
        m["main"](["--data-dir", str(data)])
        download.assert_not_called()
    assert run.call_count == 2
    assert run.call_args_list[0].args[0][:2] == [str(python), "-c"]
    assert run.call_args_list[0].kwargs["timeout"] == 5
    assert run.call_args_list[1].args[0][:4] == [str(python), "-m", "pip", "install"]
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
