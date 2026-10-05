'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const listener = path.join(__dirname, '..', 'src', 'wake', 'listener.py');
const available = spawnSync('python3', ['--version'], { timeout: 5000 }).status === 0;
function pythonTest(name, source) {
  test(name, { skip: available ? false : 'optional Python 3 unavailable' }, () => {
    const result = spawnSync('python3', ['-B', '-c', source, listener], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

pythonTest('wake stdin PCM reader bounds chunks, accepts a partial final frame and stops at EOF', `
import io, runpy, sys
m = runpy.run_path(sys.argv[1])
chunks = list(m['pcm_chunks'](io.BytesIO(b'\\0' * (6400 * 2 + 12))))
assert [len(chunk) for chunk in chunks] == [6400, 6400, 12]
assert list(m['pcm_chunks'](io.BytesIO(b''))) == []
assert list(m['pcm_chunks'](io.BytesIO(b'\\0' * 6400), lambda: True)) == []
try:
    list(m['pcm_chunks'](io.BytesIO(b'\\0' * 3)))
    raise AssertionError('unaligned PCM accepted')
except ValueError as e:
    assert str(e) == 'wake_audio_protocol_error'
`);

pythonTest('stdin wake detector decodes synthetic PCM without importing sounddevice or starting a mic watcher', `
import builtins, contextlib, io, json, math, runpy, struct, sys, tempfile, types
from pathlib import Path
from unittest import mock
m = runpy.run_path(sys.argv[1])
numpy = types.SimpleNamespace(frombuffer=lambda data, dtype: list(struct.unpack('<' + 'f' * (len(data)//4), data)),
    isfinite=lambda samples: [math.isfinite(value) for value in samples], all=all)
class Stream:
    def accept_waveform(self, rate, samples):
        assert rate == 16000 and len(samples) <= 1600
        self.ready = True
        self.result = 'hey dot' if max(samples) > .5 else ''
class Spotter:
    def __init__(self, **options): assert options['sample_rate'] == 16000
    def create_stream(self): return Stream()
    def is_ready(self, stream): return stream.ready
    def decode_stream(self, stream): stream.ready = False
    def get_result(self, stream): return stream.result
    def reset_stream(self, stream): stream.result = ''
spm = types.SimpleNamespace(SentencePieceProcessor=lambda **options: types.SimpleNamespace(encode=lambda *a, **k: ['HEY', 'DOT']))
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == 'sounddevice': raise AssertionError('Python attempted to own the microphone')
    return original_import(name, *args, **kwargs)
with tempfile.TemporaryDirectory() as directory:
    (Path(directory)/'tokens.txt').write_text('HEY 0\\nDOT 1\\n')
    output = io.StringIO()
    fake_stdin = types.SimpleNamespace(buffer=io.BytesIO(struct.pack('<1600f', *([.9]*1600))))
    with mock.patch.dict(sys.modules, {'numpy': numpy, 'sherpa_onnx': types.SimpleNamespace(KeywordSpotter=Spotter), 'sentencepiece': spm}), \\
         mock.patch.object(sys, 'argv', ['listener.py','--model',directory,'--phrase','Hey Dot','--stdin-audio']), \\
         mock.patch.object(sys, 'stdin', fake_stdin), mock.patch('builtins.__import__', guarded_import), \\
         mock.patch.object(m['threading'], 'Thread', side_effect=AssertionError('stdin reader watcher conflicts with PCM')), \\
         contextlib.redirect_stdout(output):
        assert m['main']() == 0
    events = [json.loads(line)['event'] for line in output.getvalue().splitlines()]
    assert events == ['ready','wake'], events
`);
