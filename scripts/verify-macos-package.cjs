#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256, verifyBundle, verifyElectronNotices, BUNDLE_ID, MICROPHONE_DESCRIPTION } = require('./package-macos.cjs');
const { runPosixSmoke } = require('./posix-smoke-supervisor.cjs');
const { verifyDeploymentTargets } = require('./macos-deployment-targets.cjs');
const { verifySignatures } = require('./macos-signatures.cjs');

const ROOT = path.resolve(__dirname, '..');
const FLITE_COMMIT = '6c9f20dc915b17f5619340069889db0aa007fcdc';

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) {
    throw Error(`${path.basename(file)} failed (${result.status ?? result.signal ?? result.error?.code}):\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return result;
}

function exactlyOne(directory, suffix) {
  const matches = fs.readdirSync(directory).filter(name => name.endsWith(suffix));
  if (matches.length !== 1) throw Error(`Expected one ${suffix} in ${directory}.`);
  return path.join(directory, matches[0]);
}

async function verifyArtifactChecksums(directory, artifacts) {
  const expected = artifacts.map(file => path.basename(file)).sort();
  assert.equal(new Set(expected).size, expected.length, 'expected artifacts have unique names');
  assert.ok(expected.length > 0, 'artifact checksums require an explicit expected set');
  const rows = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const entries = rows.map(row => {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(row);
    assert.ok(match, 'checksum entries are bounded artifact basenames');
    return { name: match[2], sha256: match[1] };
  });
  // A three-line file can otherwise contain the manifest three times and
  // leave both downloadable installers unchecked.
  assert.deepEqual(entries.map(entry => entry.name).sort(), expected,
    'SHA256SUMS must contain each expected artifact exactly once');
  for (const entry of entries) {
    assert.equal(await sha256(path.join(directory, entry.name)), entry.sha256, `${entry.name}: SHA-256 mismatch`);
  }
  return entries;
}

async function verifySpeechFixtures(directory, architecture) {
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'provenance.json'), 'utf8'));
  assert.equal(provenance.prepareWakeSpeech, 'passed', 'speech fixture preparation passed');
  assert.equal(provenance.success, true);
  assert.equal(provenance.sourceRepository, 'https://github.com/festvox/flite');
  assert.equal(provenance.sourceCommit, FLITE_COMMIT);
  assert.equal(provenance.sourceCleanBeforeBuild, true);
  assert.equal(provenance.generator, 'Flite');
  assert.equal(provenance.voice, 'slt');
  assert.equal(provenance.hostPlatform, 'darwin');
  assert.ok(['arm64', 'x64'].includes(architecture), 'speech fixtures require a native Mac architecture');
  assert.equal(provenance.hostMachine, architecture === 'x64' ? 'x86_64' : 'arm64');
  for (const [name, text] of [['positive', 'Hey Dot.'], ['negative', 'The weather is calm today.']]) {
    const fixture = provenance.fixtures?.[name];
    assert.equal(fixture?.text, text, `${name}: exact synthetic speech text`);
    assert.equal(fixture.voice, 'slt');
    assert.equal(fixture.sampleRate, 16000);
    assert.equal(fixture.channels, 1);
    assert.equal(fixture.sampleFormat, 'pcm16le');
    assert.equal(await sha256(path.join(directory, `${name}.wav`)), fixture.sha256,
      `${name}: rendered speech agrees with its provenance`);
  }
  return provenance;
}

function verifyHelpers(bundle) {
  const frameworks = path.join(bundle, 'Contents', 'Frameworks');
  const helpers = fs.readdirSync(frameworks).filter(name => name.startsWith('DotDial Helper') && name.endsWith('.app'));
  assert.ok(helpers.length >= 3, 'Electron helper apps are bundled');
  for (const helper of helpers) {
    const file = path.join(frameworks, helper, 'Contents', 'Info.plist');
    const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]).stdout);
    assert.equal(plist.NSMicrophoneUsageDescription, MICROPHONE_DESCRIPTION, `${helper} has its microphone usage explanation`);
    assert.ok(plist.CFBundleIdentifier.startsWith(BUNDLE_ID + '.helper'), `${helper} uses the DotDial identity`);
  }
  return helpers;
}

function parseJsonLine(stdout, expectedField) {
  const reports = [];
  for (const line of stdout.trim().split('\n')) {
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === 'object' && Object.hasOwn(value, expectedField)) reports.push(value);
    } catch {}
  }
  if (reports.length !== 1) throw Error(`Expected exactly one smoke result ${expectedField}; got ${reports.length}:\n${stdout}`);
  return reports[0];
}

function verifyLockHelper(lockHelper, temporary, env) {
  assert.equal(fs.readdirSync(env.PATH).length, 0, 'lock verification has no system tools on PATH');
  const file = path.join(temporary, 'native-config-lock-check');
  let owner, contender;
  try {
    owner = fs.openSync(file, 'wx+', 0o600);
    const invoke = fd => ({ encoding: 'utf8', timeout: 5000, env, stdio: ['ignore', 'pipe', 'pipe', fd] });
    run(lockHelper, ['--timeout-ms', '0'], invoke(owner));
    contender = fs.openSync(file, 'r+');
    const blocked = spawnSync(lockHelper, ['--timeout-ms', '100'], invoke(contender));
    assert.equal(blocked.error, undefined, 'contention returns a bounded helper status');
    assert.equal(blocked.status, 75, 'the caller keeps the kernel lock after the acquiring helper exits');
    fs.closeSync(owner); owner = undefined;
    run(lockHelper, ['--timeout-ms', '0'], invoke(contender));
    return { inherited_descriptor: true, retained_after_helper_exit: true,
      contention_exit_code: blocked.status, released_on_last_close: true, empty_path: true };
  } finally {
    if (owner !== undefined) fs.closeSync(owner);
    if (contender !== undefined) fs.closeSync(contender);
    fs.rmSync(file, { force: true });
  }
}

async function runRequiredStages(stages, evidence, record = () => {}) {
  assert.ok(stages.length > 0, 'package verification requires checks');
  assert.equal(new Set(stages.map(([name]) => name)).size, stages.length, 'required stage names must be unique');
  const failed = [];
  evidence.stages = {};
  evidence.macOSPackageVerified = false;
  for (const [name, action] of stages) {
    const started = Date.now();
    try {
      await action();
      evidence.stages[name] = { status: 'passed', elapsedMs: Date.now() - started };
    } catch (error) {
      failed.push(name);
      evidence.stages[name] = { status: 'failed', elapsedMs: Date.now() - started,
        error: String(error.stack || error.message || error).slice(-20_000) };
    }
    record(name, evidence.stages[name]);
  }
  if (failed.length) throw Error(`Required macOS package checks failed: ${failed.join(', ')}`);
  evidence.macOSPackageVerified = true;
}

async function main() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw Error('Run package verification on its native macOS architecture.');
  const directory = path.join(ROOT, 'dist', `macos-${process.arch}`);
  const zip = exactlyOne(directory, '.app.zip');
  const dmg = exactlyOne(directory, '.dmg');
  const sidecar = exactlyOne(directory, '.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.equal(manifest.architecture, process.arch);
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.codeSignature, 'ad-hoc');
  assert.equal(manifest.developerIDSigned, false);
  assert.equal(manifest.notarized, false);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.electronVersion, pkg.devDependencies.electron, 'notice provenance uses the pinned runtime');
  const electronDirectory = path.join(ROOT, 'node_modules', 'electron');
  if (process.env.GITHUB_SHA) assert.equal(manifest.sourceCommit, process.env.GITHUB_SHA);
  if (process.env.CI) assert.equal(manifest.sourceDirty, false, 'CI must package the committed tree');
  const checksums = await verifyArtifactChecksums(directory, [zip, dmg, sidecar]);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-package-check-'));
  const reportDirectory = path.join(ROOT, 'build', 'macos-qa', process.arch);
  fs.mkdirSync(reportDirectory, { recursive: true });
  let mounted = false;
  const mount = path.join(temporary, 'disk');
  const evidence = { manifest, checksums: true, checksumEntries: checksums, macOSPackageVerified: false };
  try {
    const unpacked = path.join(temporary, 'unpacked');
    run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    const bundle = path.join(unpacked, 'DotDial.app');
    const { executable, launcher, lockHelper, architecture } = verifyBundle(bundle, manifest);
    evidence.architecture = architecture;
    evidence.helpers = verifyHelpers(bundle);
    const signing = run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
    assert.match(signing.stderr, /Signature=adhoc/, 'preview is accurately classified as ad-hoc signed');
    const embedded = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'dotdial-build.json'), 'utf8'));
    assert.deepEqual(embedded, manifest);

    const noNode = path.join(temporary, 'path-without-node');
    fs.mkdirSync(noNode);
    const env = { ...process.env, PATH: noNode, TMPDIR: temporary,
      XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_STATE_HOME: path.join(temporary, 'state'),
      XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
      XDG_RUNTIME_DIR: path.join(temporary, 'run') };
    delete env.ELECTRON_RUN_AS_NODE;
    const guiEnv = { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', DOTDIAL_SMOKE_OUTPUT_DIR: reportDirectory };
    delete guiEnv.ELECTRON_RUN_AS_NODE;
    // GitHub's Intel macOS VM has no usable EGL display. Use its software
    // compositor for CI screenshots; normal application launches are unchanged.
    const graphicsArgs = process.arch === 'x64' ? ['--disable-gpu'] : [];
    const packagedSource = path.join(bundle, 'Contents', 'Resources', 'app');
    const wakeData = path.join(temporary, 'wake');
    const speechFixtures = path.resolve(process.env.DOTDIAL_WAKE_SPEECH_FIXTURES || path.join(ROOT, 'build', 'qa-wake-speech'));
    // Collect every required result. The pipeline uses the decoder stage's
    // managed environment; a failed prerequisite cannot turn that gate green.
    await runRequiredStages([
      ['electron_notices', async () => {
        evidence.electronNotices = verifyElectronNotices(bundle, electronDirectory, manifest.electronVersion);
      }],
      ['deployment_targets', async () => {
        evidence.deploymentTargets = verifyDeploymentTargets(bundle, {
          architecture: manifest.architecture, minimumMacOS: manifest.minimumMacOS,
        });
      }],
      ['signed_entitlements', async () => {
        evidence.signatures = verifySignatures(bundle);
      }],
      ['native_config_lock', async () => {
        evidence.nativeConfigLock = verifyLockHelper(lockHelper, temporary, env);
      }],
      ['bundled_cli', async () => {
        const configFile = path.join(env.XDG_CONFIG_HOME, 'dotdial', 'config.json');
        assert.equal(run(launcher, ['config', 'path'], { env }).stdout.trim(), configFile);
        const initial = JSON.parse(run(launcher, ['config', 'show'], { env }).stdout);
        assert.equal(initial.hash, null);
        assert.equal(initial.config.wakeWord.enabled, false);
        assert.equal(initial.config.wakeWord.commandsEnabled, false);
        assert.equal(Object.keys(initial.config.wakeWord.commands).length, 7);
        assert.equal(initial.config.general.hotkey, 'Command+Shift+Space');
        const commandSave = JSON.parse(run(launcher, ['config', 'set', 'wakeWord.commands.microphoneOff', '"Disable microphone"'], { env }).stdout);
        assert.equal(commandSave.saved, true);
        const commandReadback = JSON.parse(run(launcher, ['config', 'show'], { env }).stdout);
        assert.equal(commandReadback.config.wakeWord.commands.microphoneOff, 'Disable microphone');
        assert.equal(commandReadback.config.wakeWord.commandsEnabled, false);
        const save = JSON.parse(run(launcher, ['config', 'set', 'dot.displayName', '"macOS package smoke"'], { env }).stdout);
        assert.equal(save.saved, true);
        const readback = JSON.parse(run(launcher, ['config', 'show'], { env }).stdout);
        assert.equal(readback.config.dot.displayName, 'macOS package smoke');
        const diagnostic = JSON.parse(run(launcher, ['doctor'], { env }).stdout);
        assert.equal(diagnostic.ok, true, 'installed CLI resolves its bundled macOS runtime without system Node');
        evidence.bundledCliWithoutSystemNode = true;
        evidence.cliLauncher = 'Contents/Resources/dotdial-cli';
        evidence.doctor = diagnostic.checks;
      }],
      ['gui_media_capture', async () => {
        const gui = run(executable, [...graphicsArgs, '--demo', '--smoke-test', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'], { env: guiEnv });
        evidence.gui = parseJsonLine(gui.stdout, 'packagedSmoke');
        assert.equal(evidence.gui.packagedSmoke, 'passed');
      }],
      ['packaged_worker', async () => {
        const worker = run(executable, [path.join(__dirname, 'smoke-macos-worker.cjs'), bundle], { env: { ...guiEnv, ELECTRON_RUN_AS_NODE: '1' } });
        evidence.worker = parseJsonLine(worker.stdout, 'packagedWorkerSmoke');
        assert.equal(evidence.worker.packagedWorkerSmoke, 'passed');
      }],
      ['native_wake_decoder', async () => {
        // Use this extracted package's installer/listener, real native wheels
        // and local model. The helper feeds synthetic PCM, without a microphone.
        const python = process.env.DOTDIAL_SMOKE_PYTHON || run('python3', ['-c', 'import sys; print(sys.executable)']).stdout.trim();
        assert.ok(path.isAbsolute(python), 'wake validation requires a native Python 3.10-3.13 executable');
        run(python, [path.join(packagedSource, 'scripts', 'setup-wake.py'), '--data-dir', wakeData, '--stdin-audio'], { timeout: 300_000 });
        // Reproduce a partial installation only inside this verifier's newly
        // created data directory. The packaged installer must repair it from
        // the checksum-verified archive before real recognition can pass.
        const bpe = path.join(wakeData, 'models', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01', 'bpe.model');
        evidence.wakeModelRepair = { removedRequiredFile: 'bpe.model', originalSha256: await sha256(bpe), restored: false };
        fs.unlinkSync(bpe);
        run(python, [path.join(packagedSource, 'scripts', 'setup-wake.py'), '--data-dir', wakeData, '--stdin-audio'], { timeout: 300_000 });
        evidence.wakeModelRepair.restoredSha256 = await sha256(bpe);
        assert.equal(evidence.wakeModelRepair.restoredSha256, evidence.wakeModelRepair.originalSha256);
        evidence.wakeModelRepair.restored = true;
        const wakeReport = path.join(reportDirectory, 'wake-check.json');
        try {
          run(python, [path.join(__dirname, 'smoke-macos-wake.py'), '--data-dir', wakeData, '--app-source', packagedSource, '--output', wakeReport], { timeout: 120_000 });
        } finally {
          if (fs.existsSync(wakeReport)) evidence.wake = JSON.parse(fs.readFileSync(wakeReport, 'utf8'));
        }
        assert.equal(evidence.wake?.wakeSmoke, 'passed');
      }],
      ['native_wake_pipeline', async () => {
        // A development Electron host loads the extracted package's actual
        // capture/manager/listener code. Fake audio avoids TCC and hardware,
        // while the native Python process, IPC, pipe and signals remain real.
        const pipelineReport = path.join(reportDirectory, 'wake-pipeline.json');
        fs.rmSync(pipelineReport, { force: true });
        let emittedReport;
        try {
          const result = await runPosixSmoke(require('electron'), [path.join(__dirname, 'smoke-wake-pipeline.cjs'),
            '--data-dir', wakeData, '--app-source', packagedSource, '--output', pipelineReport, '--resume-cycles', '4'],
          { env: guiEnv, timeout: 180_000 });
          evidence.wakePipelineSupervision = result.supervision;
          emittedReport = parseJsonLine(result.stdout, 'wakePipelineSmoke');
        } catch (error) {
          if (error.supervision) evidence.wakePipelineSupervision = error.supervision;
          throw error;
        } finally {
          if (fs.existsSync(pipelineReport)) evidence.wakePipeline = JSON.parse(fs.readFileSync(pipelineReport, 'utf8'));
        }
        assert.deepEqual(evidence.wakePipeline, emittedReport, 'the new file and single stdout pipeline report agree');
        assert.equal(evidence.wakePipeline?.wakePipelineSmoke, 'passed');
        assert.equal(evidence.wakePipeline.hostPlatform, 'darwin');
        assert.equal(evidence.wakePipeline.hostArch, process.arch);
        assert.equal(evidence.wakePipeline.electron, manifest.electronVersion);
        assert.equal(evidence.wakePipeline.sourceRoot, packagedSource);
      }],
      ['native_wake_speech', async () => {
        // Separate from the capture/IPC fixture: the actual unmodified listener
        // must recognize fixed open-source speech and reject both controls.
        evidence.wakeSpeechPreparation = await verifySpeechFixtures(speechFixtures, process.arch);
        const speechReport = path.join(reportDirectory, 'wake-speech.json');
        fs.rmSync(speechReport, { force: true });
        let emittedReport;
        try {
          const result = await runPosixSmoke(path.join(wakeData, 'wake-venv', 'bin', 'python'),
            [path.join(__dirname, 'smoke-macos-wake-speech.py'), '--data-dir', wakeData,
              '--app-source', packagedSource, '--positive-wav', path.join(speechFixtures, 'positive.wav'),
              '--negative-wav', path.join(speechFixtures, 'negative.wav'), '--output', speechReport],
            { env: guiEnv, timeout: 180_000 });
          evidence.wakeSpeechSupervision = result.supervision;
          emittedReport = parseJsonLine(result.stdout, 'wakeSpeechSmoke');
        } catch (error) {
          if (error.supervision) evidence.wakeSpeechSupervision = error.supervision;
          throw error;
        } finally {
          if (fs.existsSync(speechReport)) evidence.wakeSpeech = JSON.parse(fs.readFileSync(speechReport, 'utf8'));
        }
        const speech = evidence.wakeSpeech;
        assert.deepEqual(speech, emittedReport, 'the new file and single stdout speech report agree');
        assert.equal(speech?.wakeSpeechSmoke, 'passed');
        assert.equal(speech.success, true);
        assert.equal(speech.hostPlatform, 'darwin');
        assert.equal(speech.hostMachine, process.arch === 'x64' ? 'x86_64' : 'arm64');
        assert.equal(speech.appSource, fs.realpathSync(packagedSource));
        assert.equal(speech.fixtures.positive.wavSha256, evidence.wakeSpeechPreparation.fixtures.positive.sha256);
        assert.equal(speech.fixtures.unrelated.wavSha256, evidence.wakeSpeechPreparation.fixtures.negative.sha256);
        assert.deepEqual(speech.cases.map(item => [item.name, item.result, item.expectWake]), [
          ['exact_phrase', 'passed', true], ['unrelated_speech', 'passed', false],
          ['different_configured_phrase', 'passed', false],
        ]);
      }],
      ['native_voice_commands', async () => {
        // Real native Python and packaged routing; synthetic speech and isolated
        // dispatch, not hardware or an authenticated account call.
        const voiceReport = path.join(reportDirectory, 'voice-commands.json');
        fs.rmSync(voiceReport, { force: true });
        let emittedReport;
        try {
          const result = await runPosixSmoke(executable,
            [path.join(__dirname, 'smoke-macos-voice.cjs'), packagedSource, wakeData, speechFixtures, voiceReport],
            { env: { ...guiEnv, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180_000 });
          evidence.voiceCommandsSupervision = result.supervision;
          emittedReport = parseJsonLine(result.stdout, 'nativeVoiceCommands');
        } catch (error) {
          if (error.supervision) evidence.voiceCommandsSupervision = error.supervision;
          throw error;
        } finally {
          if (fs.existsSync(voiceReport)) evidence.voiceCommands = JSON.parse(fs.readFileSync(voiceReport, 'utf8'));
        }
        const voice = evidence.voiceCommands;
        assert.deepEqual(voice, emittedReport, 'file and stdout voice reports agree');
        assert.equal(voice.nativeVoiceCommands, 'passed');
        assert.equal(voice.sourceCommit, manifest.sourceCommit);
        assert.equal(voice.hostPlatform, 'darwin'); assert.equal(voice.hostArch, process.arch);
        assert.equal(voice.sourceRoot, packagedSource);
        assert.equal(voice.cases.length, 12);
        assert.ok(voice.cases.every(item => item.result === 'passed' && item.decoderReaped && item.captureClosed));
      }],
      ['disk_image', async () => {
        fs.mkdirSync(mount);
        run('/usr/bin/hdiutil', ['verify', dmg]);
        run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
        mounted = true;
        const diskBundle = path.join(mount, 'DotDial.app');
        verifyBundle(diskBundle, manifest);
        const electronNotices = verifyElectronNotices(diskBundle, electronDirectory, manifest.electronVersion);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(diskBundle, 'Contents', 'Resources', 'dotdial-build.json'), 'utf8')), manifest);
        assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications');
        evidence.diskImage = { readable: true, signedAppVerified: true, applicationsShortcut: true, electronNotices };
        run('/usr/bin/hdiutil', ['detach', mount]);
        mounted = false;
      }],
    ], evidence, (stage, result) => {
      fs.writeFileSync(path.join(reportDirectory, 'verification-progress.json'), JSON.stringify(evidence, null, 2) + '\n');
      console.log('MACOS_PACKAGE_STAGE ' + JSON.stringify({ stage, ...result }));
    });
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    fs.writeFileSync(path.join(reportDirectory, 'package-check.json'), JSON.stringify(evidence, null, 2) + '\n');
    fs.writeFileSync(path.join(reportDirectory, 'verification-progress.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (mounted) { try { run('/usr/bin/hdiutil', ['detach', mount]); } catch {} }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error('MACOS_PACKAGE_CHECK_FAILED', error.stack || error.message); process.exitCode = 1; });
module.exports = { main, runRequiredStages, verifyLockHelper, parseJsonLine, verifyArtifactChecksums, verifySpeechFixtures };
