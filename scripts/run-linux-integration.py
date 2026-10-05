#!/usr/bin/env python3
"""Run existing Linux integration smokes with private X11/audio services.

Requires an installed DotDial executable (--electron), an unbundled Electron
distribution (--source-electron), Xvfb, dbus-daemon, PulseAudio and pactl/parec.
Both Electron distributions must have a working sandbox. This runner never
installs software, disables sandboxing, loads physical audio devices, or uses
an account. The installed package and source smokes are reported separately.
Electron's npm package can require running its install.js download step before
the unbundled distribution exists; provisioning is the caller's responsibility.
"""
import argparse
import ctypes
import json
import os
import secrets
import select
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from xml.sax.saxutils import escape


MAX_LOG_BYTES = 32 * 1024 * 1024


def process_table():
    """PID identity includes start ticks, so cleanup cannot signal a reused PID."""
    result = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            raw = (entry / 'stat').read_text()
            fields = raw[raw.rfind(')') + 2:].split()
            result[int(entry.name)] = (int(fields[1]), fields[0], int(fields[19]))
        except (OSError, ValueError, IndexError):
            pass
    return result


def descendants(table, roots):
    found = set(roots)
    while True:
        added = {pid for pid, (parent, _, _) in table.items() if parent in found} - found
        if not added:
            return found - set(roots)
        found.update(added)


def describe_processes(snapshot):
    """Capture minimal identity before cleanup, never argv or environment."""
    records = []
    for pid, (parent, state, started) in sorted(snapshot.items()):
        record = {'pid': pid, 'ppid': parent, 'state': state, 'comm': None, 'exe': None}
        try:
            comm = (Path('/proc') / str(pid) / 'comm').read_text().strip()
        except OSError:
            comm = None
        try:
            executable_path = os.readlink(Path('/proc') / str(pid) / 'exe')
        except OSError:
            executable_path = None
        current = process_table().get(pid)
        if current and current[2] == started:
            record.update(ppid=current[0], state=current[1], comm=comm, exe=executable_path,
                          identity_status='matched')
        else:
            # Do not attach the identity of a reused PID to the original child.
            record['identity_status'] = 'exited_or_pid_reused'
        records.append(record)
    return records


def collect_report(log, success_key, name):
    # A child may fill its log and exit between polls. Check the final size,
    # then bound the read as well in case an inherited writer is still active.
    if log.stat().st_size > MAX_LOG_BYTES:
        raise RuntimeError(f'{name} exceeded the 32 MiB log limit')
    with log.open('rb') as stream:
        data = stream.read(MAX_LOG_BYTES + 1)
    if len(data) > MAX_LOG_BYTES:
        raise RuntimeError(f'{name} exceeded the 32 MiB log limit')
    reports = []
    for line in data.decode(errors='replace').splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and success_key in value:
            reports.append(value)
    if len(reports) != 1:
        raise RuntimeError(f'{name} must emit exactly one JSON report containing {success_key}')
    if reports[0][success_key] != 'passed':
        raise RuntimeError(f'{name} did not report {success_key}=passed')
    return reports[0]


class Supervisor:
    def __init__(self, output):
        # Some remote executors expose a host /proc inside another PID
        # namespace. PID ancestry there cannot safely identify our children.
        proc_self = int(Path('/proc/self/stat').read_text().split(' ', 1)[0])
        if proc_self != os.getpid():
            raise RuntimeError('The /proc PID namespace does not match this process; cannot safely supervise children')
        # Electron workers create their own sessions. Adopting orphaned
        # descendants keeps them attributable after their original parent dies.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0):  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), 'Cannot become a child subreaper')
        self.output = output
        self.children = {}
        self.services = set()

    def spawn(self, name, argv, env, cwd, service=False, pass_fds=()):
        log_path = self.output / (name + '.log')
        with log_path.open('wb') as log:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True, pass_fds=pass_fds)
        self.children[child.pid] = child
        if service:
            self.services.add(child.pid)
        return child, log_path

    def owned(self, include_services=False):
        table = process_table()
        pids = descendants(table, {os.getpid()})
        if not include_services:
            pids -= self.services | descendants(table, self.services)
        return {pid: table[pid] for pid in pids if table[pid][1] != 'Z'}

    def reap(self):
        for child in self.children.values():
            child.poll()
        for pid, (parent, _, _) in process_table().items():
            if parent == os.getpid() and pid not in self.children:
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass

    def check_services(self):
        dead = [pid for pid in self.services if self.children[pid].poll() is not None]
        if dead:
            raise RuntimeError(f'Private display/audio/session-bus service exited: {dead}')

    def cleanup(self, include_services=False, grace=2.0):
        deadline = time.monotonic() + grace
        while self.owned(include_services) and time.monotonic() < deadline:
            self.reap()
            time.sleep(0.05)
        leaked = self.owned(include_services)
        leaked_processes = describe_processes(leaked)
        for sig, seconds in ((signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0)):
            deadline = time.monotonic() + seconds
            while True:
                alive = self.owned(include_services)
                if not alive:
                    break
                for pid, (_, _, start) in alive.items():
                    current = process_table().get(pid)
                    if current and current[2] == start:
                        try:
                            os.kill(pid, sig)
                        except ProcessLookupError:
                            pass
                self.reap()
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
        self.reap()
        surviving = self.owned(include_services)
        return {'forced_cleanup_pids': sorted(leaked),
                'forced_cleanup_processes': leaked_processes,
                'surviving_pids': sorted(surviving),
                'surviving_processes': describe_processes(surviving)}

    def run(self, name, argv, env, cwd, timeout, success_key):
        started = time.monotonic()
        result = {'stage': name, 'command': list(map(str, argv)), 'result': 'failed'}
        try:
            child, log = self.spawn(name, argv, env, cwd)
            result['log'] = str(log)
            while child.poll() is None:
                if time.monotonic() - started >= timeout:
                    raise RuntimeError(f'{name} exceeded {timeout} seconds')
                if log.stat().st_size > MAX_LOG_BYTES:
                    raise RuntimeError(f'{name} exceeded the 32 MiB log limit')
                self.check_services()
                time.sleep(0.05)
            result['exit_code'] = child.returncode
            if child.returncode != 0:
                raise RuntimeError(f'{name} exited with code {child.returncode}; see {log.name}')
            smoke = collect_report(log, success_key, name)
            self.check_services()
            result.update(result='passed', smoke=smoke)
        except Exception as error:
            result['error'] = str(error)
        finally:
            cleanup = self.cleanup()
            result.update(cleanup, elapsed_seconds=round(time.monotonic() - started, 3))
            if cleanup['forced_cleanup_pids'] or cleanup['surviving_pids']:
                result['result'] = 'failed'
                result.setdefault('error', 'Smoke left owned processes running after exit')
        return result


def xauthority(path):
    # FamilyWild works for the display assigned atomically by Xvfb -displayfd.
    def field(value):
        return struct.pack('!H', len(value)) + value
    path.write_bytes(struct.pack('!H', 65535) + field(b'') + field(b'') +
                     field(b'MIT-MAGIC-COOKIE-1') + field(secrets.token_bytes(16)))


def start_services(supervisor, work, env, cwd):
    # GTK must not autolaunch a session bus that outlives a smoke. This bus is
    # foreground, private to our mode-0700 work directory, and reaped finally.
    bus_socket = work / 'dbus.sock'
    # The host session config can activate portals and accessibility services
    # which outlive Electron and look like leaked app workers. A private bus
    # must also have private service discovery; keep the leak checks intact.
    bus_services = work / 'dbus-services'
    bus_services.mkdir(mode=0o700)
    bus_config = work / 'dbus-session.conf'
    bus_config.write_text(
        '<busconfig><type>session</type>'
        f'<listen>unix:path={escape(str(bus_socket))}</listen>'
        '<auth>EXTERNAL</auth>'
        f'<servicedir>{escape(str(bus_services))}</servicedir>'
        '<policy context="default">'
        '<allow send_destination="*" eavesdrop="true"/>'
        '<allow eavesdrop="true"/><allow own="*"/>'
        '</policy></busconfig>\n')
    read_fd, write_fd = os.pipe()
    try:
        bus, _ = supervisor.spawn('dbus-daemon', ['dbus-daemon', '--nofork',
            '--nopidfile', '--config-file=' + str(bus_config), '--print-address=' + str(write_fd)],
            env, cwd, service=True, pass_fds=(write_fd,))
        os.close(write_fd)
        write_fd = None
        deadline = time.monotonic() + 15
        address = b''
        while b'\n' not in address:
            if bus.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('Private session bus did not become ready; see dbus-daemon.log')
            if select.select([read_fd], [], [], 0.1)[0]:
                chunk = os.read(read_fd, 1024)
                if not chunk or len(address) + len(chunk) > 4096:
                    raise RuntimeError('Private session bus returned invalid readiness data')
                address += chunk
        address = address.decode().strip()
        socket_stat = bus_socket.lstat()
        if (address.split(',', 1)[0] != 'unix:path=' + str(bus_socket) or
                not stat.S_ISSOCK(socket_stat.st_mode) or socket_stat.st_uid != os.getuid()):
            raise RuntimeError('Private session bus did not bind its owned UNIX socket')
        env['DBUS_SESSION_BUS_ADDRESS'] = address
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)

    authority = work / 'Xauthority'
    xauthority(authority)
    env['XAUTHORITY'] = str(authority)
    read_fd, write_fd = os.pipe()
    try:
        xvfb, _ = supervisor.spawn('xvfb', ['Xvfb', '-displayfd', str(write_fd),
            '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', str(authority)],
            env, cwd, service=True, pass_fds=(write_fd,))
        os.close(write_fd)
        write_fd = None
        deadline = time.monotonic() + 15
        display = b''
        while b'\n' not in display:
            if xvfb.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('Private Xvfb did not become ready; see xvfb.log')
            if select.select([read_fd], [], [], 0.1)[0]:
                chunk = os.read(read_fd, 64)
                if not chunk:
                    raise RuntimeError('Private Xvfb closed its readiness pipe')
                display += chunk
        if not display.strip().isdigit():
            raise RuntimeError('Private Xvfb returned an invalid display number')
        env['DISPLAY'] = ':' + display.decode().strip()
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)

    sink = 'dotdial_qa_' + secrets.token_hex(8)
    socket = work / 'pulse.sock'
    pulse_config = work / 'pulse.pa'
    cookie = work / 'pulse-config/cookie'
    cookie.parent.mkdir(parents=True, exist_ok=True)
    cookie.write_bytes(secrets.token_bytes(256))
    client_config = cookie.parent / 'client.conf'
    client_config.write_text('autospawn = no\n')
    # The media worker intentionally forwards PULSE_SERVER but not PULSE_COOKIE.
    # This UNIX socket is reachable only through our owned mode-0700 directory;
    # anonymous protocol auth here grants access to that same user, never TCP.
    pulse_config.write_text(
        f'load-module module-native-protocol-unix socket={socket} auth-cookie={cookie} auth-anonymous=1\n'
        f'load-module module-null-sink sink_name={sink} rate=48000 channels=2 '
        f'sink_properties=device.description={sink}\n'
        f'set-default-sink {sink}\nset-default-source {sink}.monitor\n')
    env.update(PULSE_SERVER='unix:' + str(socket), PULSE_SINK=sink,
               PULSE_SOURCE=sink + '.monitor', PULSE_COOKIE=str(cookie),
               PULSE_CLIENTCONFIG=str(client_config), DOTDIAL_QA_SINK=sink)
    pulse, _ = supervisor.spawn('pulseaudio', ['pulseaudio', '-n', '-F', str(pulse_config),
        '--daemonize=no', '--use-pid-file=no', '--exit-idle-time=-1', '--log-target=stderr'],
        env, cwd, service=True)
    deadline = time.monotonic() + 15
    while True:
        if pulse.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError('Private PulseAudio did not become ready; see pulseaudio.log')
        try:
            probe = subprocess.run(['pactl', 'info'], env=env, capture_output=True, timeout=1)
        except subprocess.TimeoutExpired:
            probe = None
        if probe is not None and probe.returncode == 0:
            break
        time.sleep(0.1)
    return {'display': env['DISPLAY'], 'sink': sink,
            'session_bus': env['DBUS_SESSION_BUS_ADDRESS'], 'physical_devices_loaded': False}


def executable(value):
    path = Path(value).expanduser().resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise argparse.ArgumentTypeError(f'Executable is missing or not executable: {path}')
    return path


def write_report(output, report):
    temporary = output / 'integration-report.json.tmp'
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(output / 'integration-report.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--electron', required=True, type=executable,
                        help='Installed packaged DotDial runtime, e.g. /opt/dotdial/dotdial-runtime')
    parser.add_argument('--source-electron', required=True, type=executable,
                        help='Unbundled Electron distribution; standalone source smoke entrypoints')
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--wake-data-dir', type=Path,
                        help='Already installed managed wake environment/model; enables PCM pipeline smoke')
    parser.add_argument('--stage', action='append', choices=('packaged', 'audio', 'recovery', 'wake-pipeline'),
                        help='Run only a selected stage; repeat to select more than one')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.getuid() == 0:
        parser.error('Run on Linux as an unprivileged user')
    if args.electron == args.source_electron:
        parser.error('Packaged DotDial and unbundled source Electron must be distinct executables')
    if args.stage and 'wake-pipeline' in args.stage and not args.wake_data_dir:
        parser.error('--stage wake-pipeline requires --wake-data-dir')
    for command in ('Xvfb', 'dbus-daemon', 'pulseaudio', 'pactl', 'parec'):
        if shutil.which(command) is None:
            parser.error(f'Required program is missing: {command}')
    source = Path(__file__).resolve().parent.parent
    if args.wake_data_dir:
        args.wake_data_dir = args.wake_data_dir.expanduser().resolve()
        if not (args.wake_data_dir / 'wake-venv/bin/python').is_file():
            parser.error('--wake-data-dir must contain an already installed wake-venv')
        if not (source / 'scripts/smoke-wake-pipeline.cjs').is_file():
            parser.error('The optional wake pipeline smoke is missing from this checkout')
    output = args.output_dir.expanduser().absolute()
    if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
        parser.error('--output-dir must be a new or empty real directory')
    os.umask(0o077)
    output.mkdir(parents=True, exist_ok=True)
    if output.stat().st_uid != os.getuid():
        parser.error('--output-dir must belong to the current user')
    report = {'linuxIntegrationSmoke': 'failed', 'stages': [], 'source': str(source),
              'packagedElectron': str(args.electron), 'sourceElectron': str(args.source_electron),
              'physical_microphone_tested': False, 'account_call_tested': False,
              'macos_tcc_tested': False}
    work = Path(tempfile.mkdtemp(prefix='dd-qa-'))
    supervisor = None
    interrupted = False
    previous_handlers = {}

    def stop(signum, frame):
        raise KeyboardInterrupt(f'Received signal {signum}')

    for sig in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[sig] = signal.signal(sig, stop)
    try:
        env = dict(os.environ)
        for name in ('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DISPLAY',
                     'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'PULSE_SERVER',
                     'PULSE_SINK', 'PULSE_SOURCE', 'PULSE_COOKIE', 'XAUTHORITY'):
            env.pop(name, None)
        for name, relative in (('XDG_CONFIG_HOME', 'config'),
                               ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'),
                               ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'run'),
                               ('TMPDIR', 'tmp'), ('PULSE_RUNTIME_PATH', 'pulse-run'),
                               ('PULSE_STATE_PATH', 'pulse-state')):
            directory = work / relative
            directory.mkdir(parents=True, exist_ok=True)
            env[name] = str(directory)
        supervisor = Supervisor(output)
        report['services'] = start_services(supervisor, work, env, source)
        screenshots = output / 'packaged'
        screenshots.mkdir()
        packaged_env = dict(env, DOTDIAL_SMOKE_OUTPUT_DIR=str(screenshots))
        stages = [
            ('packaged', [str(args.electron), '--demo', '--smoke-test',
                '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                '--mute-audio', '--disable-gpu'], packaged_env, 120, 'packagedSmoke'),
            ('audio', [str(args.source_electron), '--disable-logging',
                str(source / 'scripts/smoke-audio.cjs')], env, 120, 'result'),
            ('recovery', [str(args.source_electron), '--disable-gpu',
                str(source / 'scripts/smoke-recovery.cjs')], env, 45, 'result'),
        ]
        if args.wake_data_dir:
            stages.append(('wake-pipeline', [str(args.source_electron),
                str(source / 'scripts/smoke-wake-pipeline.cjs'), '--data-dir', str(args.wake_data_dir),
                '--app-source', str(source), '--output', str(output / 'wake-pipeline.json')],
                env, 180, 'wakePipelineSmoke'))
        if args.stage:
            stages = [stage for stage in stages if stage[0] in args.stage]
        report['requested_stages'] = [stage[0] for stage in stages]
        for name, argv, stage_env, timeout, key in stages:
            result = supervisor.run(name, argv, stage_env, source, timeout, key)
            report['stages'].append(result)
            write_report(output, report)
            print(json.dumps({'stage': name, 'result': result['result'],
                              'elapsed_seconds': result['elapsed_seconds']}), flush=True)
        if all(stage['result'] == 'passed' for stage in report['stages']):
            report['linuxIntegrationSmoke'] = 'passed'
    except KeyboardInterrupt as error:
        interrupted = True
        report['error'] = str(error) or 'Interrupted'
    except Exception as error:
        report['error'] = str(error)
    finally:
        # Repeated termination requests must not interrupt bounded cleanup.
        for sig in previous_handlers:
            signal.signal(sig, signal.SIG_IGN)
        if supervisor:
            report['service_cleanup'] = supervisor.cleanup(include_services=True, grace=0)
            if report['service_cleanup']['surviving_pids']:
                report['linuxIntegrationSmoke'] = 'failed'
        shutil.rmtree(work, ignore_errors=True)
        write_report(output, report)
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
    print(json.dumps({'linuxIntegrationSmoke': report['linuxIntegrationSmoke'],
                      'report': str(output / 'integration-report.json')}), flush=True)
    return 130 if interrupted else (0 if report['linuxIntegrationSmoke'] == 'passed' else 1)


if __name__ == '__main__':
    raise SystemExit(main())
