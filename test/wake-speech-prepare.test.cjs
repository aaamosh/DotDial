'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, '..', 'scripts', 'prepare-wake-speech.py');
const available = spawnSync('python3', ['--version'], { timeout: 5000 }).status === 0;
function pythonTest(name, body) {
  test(name, { skip: available ? false : 'optional Python 3 unavailable' }, () => {
    const prelude = `
import contextlib, io, json, os, runpy, signal, struct, sys, tempfile, time, wave
from pathlib import Path
from unittest import mock
m = runpy.run_path(sys.argv[1])
def rejects(action, contains):
    try:
        action()
    except RuntimeError as error:
        assert contains in str(error), error
    else:
        raise AssertionError('invalid preparation accepted')
`;
    const result = spawnSync('python3', ['-B', '-c', prelude + body, script], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

pythonTest('speech preparation rejects a different or dirty source before running build commands', `
with tempfile.TemporaryDirectory() as root:
    source = Path(root).resolve() / 'source'; source.mkdir()
    output = Path(root).resolve() / 'speech'; output.mkdir()
    for values, message in [([str(source), '0' * 40], 'Flite HEAD must be'),
                             ([str(source), m['FLITE_COMMIT'], '!! obj/stale.o'], 'including ignored build outputs')]:
        with mock.patch.dict(m['prepare'].__globals__, {'git_value': mock.Mock(side_effect=values),
                                                      'run_logged': mock.Mock()}) as patched:
            rejects(lambda: m['prepare'](source, output, {'stages': []}, time.monotonic() + 10), message)
            patched['run_logged'].assert_not_called()
`);

pythonTest('speech preparation cannot overwrite output or create files inside the source checkout', `
with tempfile.TemporaryDirectory() as root:
    source = Path(root).resolve() / 'source'; source.mkdir()
    existing = Path(root).resolve() / 'existing'; existing.mkdir()
    marker = existing / 'must-stay'; marker.write_text('preserve')
    for destination in [existing, source / 'new-output']:
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(io.StringIO()):
            code = m['main'](['--flite-source', str(source), '--output-dir', str(destination)])
        assert code == 1 and json.loads(captured.getvalue())['prepareWakeSpeech'] == 'failed'
    assert marker.read_text() == 'preserve'
    assert list(existing.iterdir()) == [marker]
    assert not (source / 'new-output').exists()
`);

pythonTest('speech preparation kills a timed-out process group and bounds logs from a noisy real child', `
if os.name != 'posix':
    sys.exit(0)
with tempfile.TemporaryDirectory() as root:
    output = Path(root)
    report = {'stages': []}
    sleeper = "import os,time; print(os.getpid(),flush=True); time.sleep(10)"
    rejects(lambda: m['run_logged']([sys.executable, '-c', sleeper], output, output, 'timeout', report,
                                   time.monotonic() + 5, 0.15), 'timed out')
    pid = int((output / 'timeout.log').read_text().strip())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise AssertionError('timed-out process still exists')
    noisy = "import os; data=b'x'*65536; [os.write(1,data) for _ in range(40)]"
    rejects(lambda: m['run_logged']([sys.executable, '-c', noisy], output, output, 'noisy', report,
                                   time.monotonic() + 5, 3), 'log bound')
    assert (output / 'noisy.log').stat().st_size == m['MAX_LOG_BYTES']
    assert all(stage['result'] == 'failed' for stage in report['stages'])
`);

pythonTest('speech fixture provenance requires actual nonzero mono PCM16 at 16 kHz', `
with tempfile.TemporaryDirectory() as root:
    wav_path = Path(root) / 'positive.wav'
    def make(sample, channels=1, rate=16000):
        with wave.open(str(wav_path), 'wb') as wav:
            wav.setnchannels(channels); wav.setsampwidth(2); wav.setframerate(rate)
            wav.writeframes(struct.pack('<h', sample) * 1600 * channels)
    make(0)
    rejects(lambda: m['wav_evidence'](wav_path), 'silent')
    make(1000, rate=22050)
    rejects(lambda: m['wav_evidence'](wav_path), 'mono 16 kHz')
    make(1000, channels=2)
    rejects(lambda: m['wav_evidence'](wav_path), 'mono 16 kHz')
    make(1000)
    evidence = m['wav_evidence'](wav_path)
    assert evidence['frames'] == 1600 and evidence['sampleRate'] == 16000
    assert evidence['peak'] == 1000 / 32768 and len(evidence['sha256']) == 64
    wav_path.write_bytes(wav_path.read_bytes()[:-2])
    rejects(lambda: m['wav_evidence'](wav_path), 'truncated')
`);

pythonTest('supervisor SIGTERM interrupts preparation and reaps the active detached build child', `
import threading
if os.name != 'posix':
    sys.exit(0)
with tempfile.TemporaryDirectory() as root:
    output = Path(root)
    pidfile = output / 'child.pid'
    sleeper = "import os,time; from pathlib import Path; Path(" + repr(str(pidfile)) + ").write_text(str(os.getpid())); time.sleep(10)"
    def cancel_when_started():
        end = time.monotonic() + 3
        while time.monotonic() < end:
            if pidfile.exists() and pidfile.read_text().strip():
                break
            time.sleep(0.01)
        os.kill(os.getpid(), signal.SIGTERM)
    previous = signal.signal(signal.SIGTERM, m['interrupted'])
    canceller = threading.Thread(target=cancel_when_started)
    canceller.start()
    try:
        rejects(lambda: m['run_logged']([sys.executable, '-c', sleeper], output, output, 'cancelled', {'stages': []},
                                       time.monotonic() + 5, 4), 'interrupted:SIGTERM')
    finally:
        canceller.join(timeout=4)
        signal.signal(signal.SIGTERM, previous)
    pid = int(pidfile.read_text())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise AssertionError('interrupted build child still exists')
`);
