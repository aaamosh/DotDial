'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('wake device matching is exact, host-aware, and fails closed on missing or ambiguous inputs', t => {
  const wakeDir = path.resolve(__dirname, '../src/wake');
  const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from device_selection import WakeDeviceError, enumerate_input_devices, resolve_input_device

class Devices:
    @staticmethod
    def query_hostapis():
        return [{'name': 'ALSA'}, {'name': 'PulseAudio'}]
    @staticmethod
    def query_devices():
        return [
            {'name': 'Built-in Mic', 'hostapi': 0, 'max_input_channels': 1},
            {'name': 'USB Headset Mic', 'hostapi': 1, 'max_input_channels': 1},
            {'name': 'Duplicate', 'hostapi': 0, 'max_input_channels': 1},
            {'name': 'Duplicate', 'hostapi': 0, 'max_input_channels': 1},
            {'name': 'Output only', 'hostapi': 0, 'max_input_channels': 0},
        ]

rows = enumerate_input_devices(Devices)
assert rows == [
    {'name': 'Built-in Mic', 'hostApi': 'ALSA', 'ambiguous': False},
    {'name': 'Duplicate', 'hostApi': 'ALSA', 'ambiguous': True},
    {'name': 'USB Headset Mic', 'hostApi': 'PulseAudio', 'ambiguous': False},
]
assert resolve_input_device(Devices, '', '') is None
assert resolve_input_device(Devices, 'USB Headset Mic', 'PulseAudio') == 1
for pair, code in [
    (('Missing', 'PulseAudio'), 'wake_device_unavailable'),
    (('Duplicate', 'ALSA'), 'wake_device_ambiguous'),
    (('USB Headset Mic', ''), 'wake_device_invalid'),
]:
    try:
        resolve_input_device(Devices, *pair)
    except WakeDeviceError as error:
        assert error.code == code
    else:
        raise AssertionError('device selection unexpectedly succeeded')
print('ok')
`;
  const result = spawnSync('python3', ['-c', script, wakeDir], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') { t.skip('Python 3 is unavailable'); return; }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'ok');
});
