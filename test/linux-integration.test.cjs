'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, '..', 'scripts', 'run-linux-integration.py');
const available = spawnSync('python3', ['--version'], { timeout: 5000 }).status === 0;

function pythonTest(name, body) {
  test(name, { skip: available ? false : 'optional Python 3 unavailable' }, () => {
    const prelude = `
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('linux_integration', sys.argv[1])
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

def completed_smoke(log, service_exit=None):
    # Exercise the real run/report boundary with an already-exited child.
    # No /proc access, service, process group, or Linux-only constructor runs.
    supervisor = runner.Supervisor.__new__(runner.Supervisor)
    supervisor.services = {101}
    supervisor.children = {101: SimpleNamespace(poll=lambda: service_exit)}
    child = SimpleNamespace(poll=lambda: 0, returncode=0)
    supervisor.spawn = Mock(return_value=(child, log))
    supervisor.cleanup = Mock(return_value={'forced_cleanup_pids': [], 'surviving_pids': []})
    return supervisor.run('fixture', ['unused'], {}, log.parent, 1, 'packagedSmoke')
`;
    const result = spawnSync('python3', ['-B', '-c', prelude + body, runner], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

pythonTest('Linux integration accepts one successful report from an already-exited smoke', `
with tempfile.TemporaryDirectory() as directory:
    log = Path(directory) / 'smoke.log'
    report = {'packagedSmoke': 'passed', 'packaged': True}
    log.write_text('diagnostic line\\n' + json.dumps(report) + '\\n')
    result = completed_smoke(log)
    assert result['result'] == 'passed', result
    assert result['exit_code'] == 0 and result['smoke'] == report, result
`);

pythonTest('Linux integration rejects contradictory passed and failed reports in either order', `
with tempfile.TemporaryDirectory() as directory:
    log = Path(directory) / 'smoke.log'
    for outcomes in [('passed', 'failed'), ('failed', 'passed')]:
        log.write_text(''.join(json.dumps({'packagedSmoke': outcome}) + '\\n' for outcome in outcomes))
        result = completed_smoke(log)
        assert result['exit_code'] == 0, result
        assert result['result'] == 'failed' and 'exactly one' in result['error'], result
`);

pythonTest('Linux integration rejects a final oversized log even when no running-child poll occurs', `
with tempfile.TemporaryDirectory() as directory:
    log = Path(directory) / 'smoke.log'
    with log.open('wb') as stream:
        stream.write(b'{"packagedSmoke":"passed"}\\n')
        # A sparse file tests the actual size boundary without allocating 32 MiB.
        stream.truncate(runner.MAX_LOG_BYTES + 1)
    result = completed_smoke(log)
    assert result['exit_code'] == 0, result
    assert result['result'] == 'failed' and 'log limit' in result['error'], result
`);

pythonTest('Linux integration rejects a dead private service at the final completed-child boundary', `
with tempfile.TemporaryDirectory() as directory:
    log = Path(directory) / 'smoke.log'
    log.write_text('{"packagedSmoke":"passed"}\\n')
    result = completed_smoke(log, service_exit=0)
    assert result['exit_code'] == 0, result
    assert result['result'] == 'failed' and 'service exited' in result['error'], result
`);
