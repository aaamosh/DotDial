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
        self.result = 'wake' if max(samples) > .5 else ''
class Spotter:
    def __init__(self, **options): assert options['sample_rate'] == 16000 and options['max_active_paths'] == 4
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

pythonTest('voice command phrases normalize strictly, reject overlap and duplicate JSON keys, and use fixed labels', `
import json, runpy, sys
m = runpy.run_path(sys.argv[1])
keys = m['COMMAND_KEYS']
commands = {
    'microphoneOff':'  Microphone   off  ', 'microphoneOn':'Microphone on',
    'speakersOff':'Radio silence', 'speakersOn':'Sound on please',
    'hangUp':'Hang up', 'playMissedReplies':'Replay messages', 'stopPlayback':'Stop the replay'
}
parsed = m['parse_commands_json'](json.dumps(commands), 'Hey Dot')
assert parsed['microphoneOff'] == 'MICROPHONE OFF'
assert tuple(parsed) == keys
assert m['parse_commands_json'](None, 'Hey Dot') is None
for bad in ['Mic', 'one two three four five six seven', 'mic\\toff', 'café off', 'mic-off', "d'on't now"]:
    try: m['normalize_command_phrase'](bad)
    except ValueError: pass
    else: raise AssertionError('unsafe command accepted: ' + repr(bad))
try:
    m['parse_commands_json'](json.dumps({**commands, 'hangUp':'Hey Dot turn off'}), 'Hey-Dot')
except ValueError as e: assert str(e) == 'wake_phrases_overlap'
else: raise AssertionError('hyphenated wake overlap accepted')
try:
    m['parse_commands_json']('{"microphoneOff":"Mic off","microphoneOff":"Sound off"}', 'Hey Dot')
except ValueError as e: assert str(e) == 'wake_commands_invalid'
else: raise AssertionError('duplicate JSON field accepted')
assert m['_phrase_words']('Hey-Dot 2') == ['HEY','DOT','2']
class Tokens:
    def encode(self, phrase, out_type): return phrase.split()
all_words = set('HEY DOT MICROPHONE OFF ON RADIO SILENCE SOUND PLEASE HANG UP REPLAY MESSAGES STOP THE'.split())
lines = m['build_keyword_lines']('HEY DOT', parsed, Tokens(), all_words)
assert len(lines) == 8 and lines[0] == 'HEY DOT @wake'
assert any(line.endswith(' @microphoneOff') for line in lines)
assert not any('@hey' in line.lower() for line in lines)
`);

pythonTest('voice-command cooldowns use audio time and keep opposite actions independent', `
import runpy, sys
gate = runpy.run_path(sys.argv[1])['EventCooldown']()
assert gate.allow('wake', .1, 3)
assert not gate.allow('wake', 2.9, 3)
assert gate.allow('wake', 3.1, 3)
assert gate.allow('microphoneOn', .2, 1)
assert gate.allow('microphoneOff', .3, 1)
assert not gate.allow('microphoneOff', .4, 1)
assert gate.allow('microphoneOff', 1.31, 1)
`);

const commandsJson = JSON.stringify({
  microphoneOff: 'Microphone off', microphoneOn: 'Microphone on',
  speakersOff: 'Radio silence', speakersOn: 'Sound on please',
  hangUp: 'Hang up', playMissedReplies: 'Replay messages', stopPlayback: 'Stop the replay',
});
pythonTest('stdin combined wake and command stream emits fixed allowlisted events', `
import builtins, contextlib, io, json, math, runpy, struct, sys, tempfile, types
from pathlib import Path
from unittest import mock
m = runpy.run_path(sys.argv[1])
numpy = types.SimpleNamespace(frombuffer=lambda data, dtype: list(struct.unpack('<' + 'f' * (len(data)//4), data)),
    isfinite=lambda samples: [math.isfinite(value) for value in samples], all=all)
class Stream:
    def __init__(self): self.ready=False; self.result=''; self.index=0
    def accept_waveform(self, rate, samples):
        assert rate == 16000 and len(samples) <= 1600
        self.ready=True
        results=['wake','microphoneOff','untrusted-label']
        self.result=results[self.index]
        self.index+=1
class Spotter:
    def __init__(self, **options):
        assert options['max_active_paths'] == 4
        entries=Path(options['keywords_file']).read_text().splitlines()
        assert len(entries) == 8 and entries[0] == 'HEY DOT @wake'
        assert {entry.rsplit(' @',1)[1] for entry in entries} == {'wake', *m['COMMAND_KEYS']}
    def create_stream(self): return Stream()
    def is_ready(self, stream): return stream.ready
    def decode_stream(self, stream): stream.ready=False
    def get_result(self, stream): return stream.result
    def reset_stream(self, stream): stream.result=''
spm = types.SimpleNamespace(SentencePieceProcessor=lambda **options: types.SimpleNamespace(encode=lambda text, **k: text.split()))
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == 'sounddevice': raise AssertionError('Python attempted to own the microphone')
    return original_import(name, *args, **kwargs)
with tempfile.TemporaryDirectory() as directory:
    (Path(directory)/'tokens.txt').write_text('HEY 0\\nDOT 1\\nMICROPHONE 2\\nOFF 3\\nON 4\\nRADIO 5\\nSILENCE 6\\nSOUND 7\\nPLEASE 8\\nHANG 9\\nUP 10\\nREPLAY 11\\nMESSAGES 12\\nSTOP 13\\nTHE 14\\n')
    output = io.StringIO()
    samples=[([.9]*1600),([.7]*1600),([.4]*1600)]
    fake_stdin = types.SimpleNamespace(buffer=io.BytesIO(b''.join(struct.pack('<1600f', *chunk) for chunk in samples)))
    argv = ['listener.py','--model',directory,'--phrase','Hey Dot','--stdin-audio','--commands-json',${JSON.stringify(commandsJson)}]
    with mock.patch.dict(sys.modules, {'numpy': numpy, 'sherpa_onnx': types.SimpleNamespace(KeywordSpotter=Spotter), 'sentencepiece': spm}), \\
         mock.patch.object(sys, 'argv', argv), mock.patch.object(sys, 'stdin', fake_stdin), \\
         mock.patch('builtins.__import__', guarded_import), contextlib.redirect_stdout(output):
        assert m['main']() == 0
    events = [json.loads(line) for line in output.getvalue().splitlines()]
    assert events == [{'event':'ready'}, {'event':'wake'}, {'event':'command','command':'microphoneOff'}], events
`);
