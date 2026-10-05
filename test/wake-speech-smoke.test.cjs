'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, '..', 'scripts', 'smoke-macos-wake-speech.py');
const available = spawnSync('python3', ['--version'], { timeout: 5000 }).status === 0;
function pythonTest(name, body) {
  test(name, { skip: available ? false : 'optional Python 3 unavailable' }, () => {
    const prelude = `
import json, runpy, struct, subprocess, sys, tempfile, time, wave
from pathlib import Path
from unittest import mock
m = runpy.run_path(sys.argv[1])
def rejects(action, contains):
    try:
        action()
    except RuntimeError as error:
        assert contains in str(error), error
    else:
        raise AssertionError('invalid evidence accepted')
def result(events, status=0):
    return subprocess.CompletedProcess([], status, stdout=b'\\n'.join(json.dumps(e).encode() for e in events), stderr=b'')
def case(positive=True, name='exact_phrase'):
    return {'name': name, 'configuredPhrase': 'Hey Dot', 'expectWake': positive}
`;
    const result = spawnSync('python3', ['-B', '-c', prelude + body, script], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

pythonTest('speech acceptance requires a real wake after ready and a successful EOF exit', `
validate = m['validate_events']
ready, wake = {'event':'ready'}, {'event':'wake'}
rejects(lambda: validate(result([ready]), case()), 'did not recognize')
rejects(lambda: validate(result([wake, ready]), case()), 'before detection')
rejects(lambda: validate(result([ready, ready, wake]), case()), 'exactly one ready')
rejects(lambda: validate(result([ready, wake], 2), case()), 'exited with code 2')
rejects(lambda: validate(result([ready, {'event':'error', 'code':'wake_audio_or_model_failed'}]), case()), 'invalid listener events')
accepted = case()
validate(result([ready, wake]), accepted)
assert accepted['wakeCount'] == 1 and accepted['eofExit'] and accepted['result'] == 'passed'
`);

pythonTest('both spoken negative controls fail on any wake and reject malformed protocol output', `
validate = m['validate_events']
for name in ['unrelated_speech', 'different_configured_phrase']:
    rejects(lambda: validate(result([{'event':'ready'}, {'event':'wake'}]), case(False, name)), 'unexpected wake')
    accepted = case(False, name)
    validate(result([{'event':'ready'}]), accepted)
    assert accepted['wakeCount'] == 0 and accepted['result'] == 'passed'
for payload in [b'not json', b'[]', b'{"event":"complete"}', b'x' * 65537]:
    rejects(lambda: validate(subprocess.CompletedProcess([], 0, stdout=payload, stderr=b''), case()), 'invalid listener events')
`);

pythonTest('speech conversion preserves signed samples in float32 stdin and adds bounded silence context', `
with tempfile.TemporaryDirectory() as root:
    filename = Path(root) / 'speech.wav'
    with wave.open(str(filename), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(struct.pack('<4h', -32768, -16384, 0, 32767) * 400)
    pcm, evidence = m['read_pcm'](filename)
    assert len(pcm) == (1600 + 16000) * 4
    assert pcm[:32000] == bytes(32000) and pcm[-32000:] == bytes(32000)
    assert struct.unpack('<4f', pcm[32000:32016]) == (-1.0, -0.5, 0.0, 32767 / 32768)
    assert evidence['speechSeconds'] == 0.1 and evidence['peak'] == 1.0
    assert evidence['pcmBytes'] == len(pcm) and len(evidence['pcmSha256']) == 64
`);

pythonTest('silent, misformatted, truncated and excessively long speech cannot count as a generated fixture', `
with tempfile.TemporaryDirectory() as root:
    filename = Path(root) / 'speech.wav'
    def make(rate=16000, channels=1, frames=1600, sample=2000):
        with wave.open(str(filename), 'wb') as wav:
            wav.setnchannels(channels); wav.setsampwidth(2); wav.setframerate(rate)
            wav.writeframes(struct.pack('<h', sample) * frames * channels)
    make(sample=0)
    rejects(lambda: m['read_pcm'](filename), 'silent')
    make(rate=44100)
    rejects(lambda: m['read_pcm'](filename), 'mono 16 kHz')
    make(channels=2)
    rejects(lambda: m['read_pcm'](filename), 'mono 16 kHz')
    make(frames=16000 * 16)
    rejects(lambda: m['read_pcm'](filename), 'bound')
    make()
    filename.write_bytes(filename.read_bytes()[:-2])
    rejects(lambda: m['read_pcm'](filename), 'truncated')
`);

pythonTest('speech smoke reaps a timed-out real subprocess and fails before spawning after its deadline', `
started = time.monotonic()
rejects(lambda: m['run_bounded']([sys.executable, '-c', 'import time; time.sleep(10)'], started + 5,
                               'blocked detector', timeout=0.1), 'timed out')
assert time.monotonic() - started < 3
with mock.patch.object(m['subprocess'], 'run') as run:
    rejects(lambda: m['run_bounded'](['must-not-start'], time.monotonic() - 1, 'late detector'), 'wake_speech_deadline')
    run.assert_not_called()
`);
