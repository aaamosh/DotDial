'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { buildManifest } = require('../scripts/package-macos.cjs');
const { validateContext, validateArtifacts, addCombinedChecksums, renderReleaseBody,
  verifyAssets, resolveTag, promoteRelease, REPOSITORY, VERSION, TAG, TITLE, PUBLISH_SUBJECT } = require('../scripts/publish-macos-preview.cjs');

const sourceSha = 'abcde123'.repeat(5);
const electronVersion = '44.5.1';
const context = { sourceSha, runId: '123456', runUrl: `https://github.com/${REPOSITORY}/actions/runs/123456` };
const template = 'Source {{SOURCE_COMMIT}}\nDownload preview-{{SOURCE_SHORT}}.dmg\nChecks {{CI_RUN_URL}}\n';
const body = renderReleaseBody(template, context);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function writeChecksums(directory) {
  const names = fs.readdirSync(directory).filter(name => name !== 'SHA256SUMS').sort();
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), names.map(name =>
    `${digest(fs.readFileSync(path.join(directory, name)))}  ${name}`).join('\n') + '\n');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-release-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'artifacts');
  for (const arch of ['arm64', 'x64']) {
    const archDirectory = path.join(directory, arch);
    fs.mkdirSync(archDirectory, { recursive: true });
    const stem = `DotDial-${VERSION}-preview-${sourceSha.slice(0, 8)}-macos-${arch}`;
    const manifest = buildManifest({ pkg: { version: VERSION, devDependencies: { electron: electronVersion } },
      arch, sourceSha, sourceDirty: false, preview: true });
    fs.writeFileSync(path.join(archDirectory, stem + '.manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(archDirectory, stem + '.dmg'), Buffer.from(`native ${arch} disk image fixture`));
    fs.writeFileSync(path.join(archDirectory, stem + '.app.zip'), Buffer.from(`native ${arch} ZIP fixture`));
    writeChecksums(archDirectory);
  }
  return { root, directory, verify: () => validateArtifacts(directory, { sourceSha, electronVersion }) };
}

test('publication context accepts the exact subject and blocks nearby subjects, forks and other triggers', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sourceSha, GITHUB_RUN_ID: context.runId };
  const event = { head_commit: { id: sourceSha, message: PUBLISH_SUBJECT } };
  assert.deepEqual(validateContext(env, event), context);
  assert.deepEqual(validateContext(env, { head_commit: { ...event.head_commit, message: PUBLISH_SUBJECT + '\n\nReviewed release.' } }), context);
  for (const message of [PUBLISH_SUBJECT + ' later', 'Do not ' + PUBLISH_SUBJECT, 'Routine build', PUBLISH_SUBJECT.toLowerCase(),
    'Publish macOS preview 1 with bundled runtime notices']) {
    assert.throws(() => validateContext(env, { head_commit: { ...event.head_commit, message } }), /exact one-time/);
  }
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REPOSITORY: 'example/DotDial' },
    { GITHUB_REF: 'refs/heads/feat/macos' }, { GITHUB_REF: 'refs/heads/fix/wake-pipeline-timing' },
    { GITHUB_REF: `refs/tags/${TAG}` }, { GITHUB_SHA: 'main' }, { GITHUB_RUN_ID: '' }]) {
    assert.throws(() => validateContext({ ...env, ...change }, event));
  }
  assert.throws(() => validateContext(env, { head_commit: { ...event.head_commit, id: 'f'.repeat(40) } }), /exact one-time/);
});

test('promotion inputs are exactly six current-source distribution files and one combined checksum file', async t => {
  const data = fixture(t);
  const distribution = await data.verify();
  const assets = await addCombinedChecksums(distribution, path.join(data.root, 'output'));
  assert.equal(assets.length, 7);
  assert.equal(assets.at(-1).name, 'SHA256SUMS');
  const sums = fs.readFileSync(assets.at(-1).file, 'utf8').trim().split('\n');
  assert.equal(sums.length, 6);
  for (const asset of distribution) {
    assert.ok(sums.includes(`${digest(fs.readFileSync(asset.file))}  ${asset.name}`));
    assert.ok(asset.size > 0);
  }
  assert.equal(assets.at(-1).sha256, digest(fs.readFileSync(assets.at(-1).file)));
});

test('artifact validation blocks extra files, links and empty binaries before publication', async t => {
  for (const mode of ['extra-root', 'extra-arch', 'linked-root', 'linked-file', 'empty-binary']) {
    const data = fixture(t);
    const arch = path.join(data.directory, 'arm64');
    const binary = path.join(arch, fs.readdirSync(arch).find(name => name.endsWith('.dmg')));
    if (mode === 'extra-root') fs.writeFileSync(path.join(data.directory, 'private-notes.txt'), 'not a release asset');
    if (mode === 'extra-arch') fs.writeFileSync(path.join(arch, 'extra-report.json'), '{}');
    if (mode === 'linked-root') {
      fs.renameSync(arch, path.join(data.root, 'elsewhere'));
      fs.symlinkSync(path.join(data.root, 'elsewhere'), arch);
    }
    if (mode === 'linked-file') {
      const target = path.join(data.root, 'elsewhere.dmg');
      fs.renameSync(binary, target);
      fs.symlinkSync(target, binary);
    }
    if (mode === 'empty-binary') { fs.writeFileSync(binary, ''); writeChecksums(arch); }
    await assert.rejects(data.verify, /distribution artifacts|must not be links|nonempty regular file/, mode);
  }
});

test('artifact validation rejects checksum substitution, traversal, duplicates and changed installer bytes', async t => {
  for (const mode of ['duplicate', 'missing', 'traversal', 'changed-bytes']) {
    const data = fixture(t);
    const arch = path.join(data.directory, 'x64');
    const file = path.join(arch, 'SHA256SUMS');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n');
    if (mode === 'duplicate') rows[1] = rows[0];
    if (mode === 'missing') rows.pop();
    if (mode === 'traversal') rows[1] = `${'a'.repeat(64)}  ../outside.dmg`;
    if (mode === 'changed-bytes') fs.appendFileSync(path.join(arch, fs.readdirSync(arch).find(name => name.endsWith('.dmg'))), 'changed');
    fs.writeFileSync(file, rows.join('\n') + '\n');
    await assert.rejects(data.verify, /exactly three checksums|exactly once|SHA-256 mismatch/, mode);
  }
});

test('a valid checksum cannot legitimize the wrong source, architecture or signature claims', async t => {
  for (const change of [{ sourceCommit: 'f'.repeat(40) }, { sourceDirty: true }, { sourceDirty: undefined },
    { version: '0.1.0-beta.2' }, { architecture: 'x64' }, { distribution: 'beta' },
    { codeSignature: 'Developer ID' }, { developerIDSigned: true }, { notarized: true },
    { electronVersion: '44.5.0' }, { minimumMacOS: '15.0' }]) {
    const data = fixture(t);
    const arch = path.join(data.directory, 'arm64');
    const file = path.join(arch, fs.readdirSync(arch).find(name => name.endsWith('.manifest.json')));
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));
    writeChecksums(arch);
    await assert.rejects(data.verify, /manifest does not describe/, JSON.stringify(change));
  }
});

test('release notes substitute only the reviewed source/run placeholders', () => {
  assert.ok(body.includes(sourceSha));
  assert.ok(body.includes('preview-abcde123.dmg'));
  assert.ok(body.includes(context.runUrl));
  assert.ok(body.includes(`source=${sourceSha} run=${context.runId}`));
  assert.ok(!body.includes('{{'));
  assert.throws(() => renderReleaseBody(template + '{{UNREVIEWED_FIELD}}', context), /Unresolved/);
  assert.throws(() => renderReleaseBody(template.replace('{{SOURCE_COMMIT}}', 'main'), context), /must include/);
});

function remoteAsset(asset) {
  return { name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}`, state: 'uploaded' };
}

function mockGitHub(assets, options = {}) {
  const apiRoot = `/repos/${REPOSITORY}`;
  const baseRelease = { id: 123, tag_name: TAG, name: TITLE, target_commitish: sourceSha,
    prerelease: true, draft: true, author: { login: 'github-actions[bot]' }, body,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`, assets: [] };
  const state = { commands: [], release: options.release ? { ...structuredClone(baseRelease), ...structuredClone(options.release) } : null,
    tag: options.tag || null, otherReleases: structuredClone(options.otherReleases || []) };
  const client = {
    async api(endpoint) {
      if (endpoint === `${apiRoot}/commits/${sourceSha}`) return { sha: sourceSha, commit: { message: options.commitMessage || PUBLISH_SUBJECT } };
      if (endpoint === `${apiRoot}/actions/runs/${context.runId}`) return { id: Number(context.runId),
        head_sha: options.runSha || sourceSha, event: 'push', head_branch: options.runBranch || 'main', path: '.github/workflows/macos.yml',
        repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } };
      if (endpoint === `${apiRoot}/git/ref/tags/${TAG}`) return state.tag ? { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: state.tag } } : null;
      if (endpoint === `${apiRoot}/releases?per_page=100`) return structuredClone([
        ...state.otherReleases, ...(state.release ? [state.release] : []),
      ]);
      if (endpoint === `${apiRoot}/releases/123`) return structuredClone(state.release);
      throw Error('Unexpected API path: ' + endpoint);
    },
    async command(args) {
      state.commands.push([...args]);
      assert.equal(args[0], 'release');
      assert.equal(args[2], TAG);
      assert.ok(args.includes('--repo') && args.includes(REPOSITORY));
      assert.ok(!args.includes('--clobber'), 'no operation may replace release assets');
      if (args[1] === 'create') {
        assert.equal(state.release, null);
        for (const flag of ['--draft', '--prerelease', '--latest=false', '--notes-file']) assert.ok(args.includes(flag));
        assert.equal(args[args.indexOf('--target') + 1], sourceSha);
        state.release = structuredClone(baseRelease);
      } else if (args[1] === 'upload') {
        assert.equal(state.release.draft, true, 'only drafts may receive assets');
        const asset = assets.find(item => item.file === args[3]);
        assert.ok(asset, 'only an explicitly validated path may be uploaded');
        const remote = remoteAsset(asset);
        if (options.corruptUpload) remote.digest = `sha256:${'0'.repeat(64)}`;
        state.release.assets.push(remote);
      } else if (args[1] === 'edit') {
        assert.equal(state.release.draft, true);
        assert.equal(state.release.assets.length, 7);
        for (const flag of ['--draft=false', '--prerelease', '--latest=false']) assert.ok(args.includes(flag));
        state.release.draft = false;
        state.tag ||= sourceSha;
        if (options.publishReportsFailure) throw Error('Synthetic timeout after GitHub accepted publication.');
      } else throw Error('Unexpected mutation: ' + args[1]);
    },
  };
  return { client, state };
}

async function promotionFixture(t) {
  const data = fixture(t);
  const assets = await addCombinedChecksums(await data.verify(), path.join(data.root, 'output'));
  return { assets, notesFile: path.join(data.root, 'release-notes.md'), context, body };
}

test('new publication creates a draft, verifies seven uploads, then publishes with the exact tag source', async t => {
  const input = await promotionFixture(t);
  const { client, state } = mockGitHub(input.assets);
  const result = await promoteRelease({ ...input, client });
  assert.deepEqual(state.commands.map(args => args[1]), ['create', ...Array(7).fill('upload'), 'edit']);
  assert.equal(result.published, true);
  assert.equal(result.alreadyPublished, false);
  assert.equal(state.release.draft, false);
  assert.equal(state.tag, sourceSha);
});

test('Preview 2 leaves the existing published Preview 1 and all of its assets untouched', async t => {
  const input = await promotionFixture(t);
  const previousTag = 'v0.1.0-beta.3-macos-preview.1';
  const previousSha = '54889c5b04fe3dc32b79084d56bbec6e187a53de';
  const previousNames = ['arm64', 'x64'].flatMap(arch => ['.app.zip', '.dmg', '.manifest.json'].map(suffix =>
    `DotDial-${VERSION}-preview-${previousSha.slice(0, 8)}-macos-${arch}${suffix}`));
  previousNames.push('SHA256SUMS');
  const previousRelease = { id: 403612523, tag_name: previousTag, name: 'DotDial for macOS — Preview 1',
    target_commitish: previousSha, draft: false, prerelease: true, immutable: false,
    body: 'The previously published release notes must remain intact.',
    assets: previousNames.map((name, index) => ({ id: 7000 + index, name, state: 'uploaded', size: 1000 + index,
      digest: `sha256:${digest('previous release bytes: ' + name)}` })) };
  assert.equal(TAG, 'v0.1.0-beta.3-macos-preview.2', 'this one-time publisher may address only the new tag');
  const { client, state } = mockGitHub(input.assets, { otherReleases: [previousRelease] });
  const result = await promoteRelease({ ...input, client });
  assert.equal(result.tag, TAG);
  assert.equal(result.alreadyPublished, false);
  assert.deepEqual(state.otherReleases, [previousRelease], 'existing release metadata and every asset stay unchanged');
  assert.equal(state.release.tag_name, TAG);
  assert.deepEqual(state.release.assets, input.assets.map(remoteAsset));
  for (const args of state.commands) {
    assert.equal(args[2], TAG, 'every release mutation targets Preview 2');
    assert.ok(!args.includes(previousTag));
  }
});

test('a matching interrupted draft resumes only missing files without recreating or replacing assets', async t => {
  const input = await promotionFixture(t);
  const { client, state } = mockGitHub(input.assets, { release: { assets: input.assets.slice(0, 3).map(remoteAsset) }, tag: sourceSha });
  await promoteRelease({ ...input, client });
  assert.deepEqual(state.commands.map(args => args[1]), ['upload', 'upload', 'upload', 'upload', 'edit']);
  assert.deepEqual(state.commands.filter(args => args[1] === 'upload').map(args => args[3]), input.assets.slice(3).map(asset => asset.file));
});

test('an already published exact release is verified without any write', async t => {
  const input = await promotionFixture(t);
  const { client, state } = mockGitHub(input.assets, { release: { draft: false, assets: input.assets.map(remoteAsset) }, tag: sourceSha });
  assert.equal((await promoteRelease({ ...input, client })).alreadyPublished, true);
  assert.deepEqual(state.commands, []);
});

test('a publish response lost after remote success is reconciled on retry without repeating a write', async t => {
  const input = await promotionFixture(t);
  const { client, state } = mockGitHub(input.assets, { publishReportsFailure: true });
  await assert.rejects(() => promoteRelease({ ...input, client }), /timeout after GitHub accepted/);
  assert.equal(state.release.draft, false, 'the command result alone cannot prove publication failed');
  const mutationsBeforeRetry = structuredClone(state.commands);
  assert.equal((await promoteRelease({ ...input, client })).alreadyPublished, true);
  assert.deepEqual(state.commands, mutationsBeforeRetry, 'readback reconciles the result without any repeat mutation');
});

test('wrong source, an existing different tag and another draft stop all mutations', async t => {
  const input = await promotionFixture(t);
  for (const options of [{ tag: 'f'.repeat(40) }, { runSha: 'f'.repeat(40) }, { runBranch: 'feat/macos' },
    { commitMessage: 'Routine update' },
    { release: { body: body + 'Changed.' } }, { release: { author: { login: 'another-publisher' } } },
    { release: { target_commitish: 'main' } }, { release: { prerelease: false } }]) {
    const { client, state } = mockGitHub(input.assets, options);
    await assert.rejects(() => promoteRelease({ ...input, client }));
    assert.deepEqual(state.commands, [], JSON.stringify(options));
  }
});

test('a failed upload digest keeps the release private and never attempts publication', async t => {
  const input = await promotionFixture(t);
  const { client, state } = mockGitHub(input.assets, { corruptUpload: true });
  await assert.rejects(() => promoteRelease({ ...input, client }), /assets differ/);
  assert.equal(state.release.draft, true);
  assert.equal(state.commands.some(args => args[1] === 'edit'), false);
});

test('existing mismatched, duplicate, unfinished, extra or missing published assets are never repaired in place', async t => {
  const input = await promotionFixture(t);
  const valid = input.assets.map(remoteAsset);
  const changed = structuredClone(valid); changed[0].digest = `sha256:${'0'.repeat(64)}`;
  const wrongSize = structuredClone(valid); wrongSize[0].size++;
  const unfinished = structuredClone(valid); unfinished[0].state = 'starter';
  const noDigest = structuredClone(valid); noDigest[0].digest = null;
  for (const assets of [changed, wrongSize, unfinished, noDigest, [...valid, valid[0]],
    [...valid, { name: 'extra.json', size: 2, digest: `sha256:${'0'.repeat(64)}`, state: 'uploaded' }], valid.slice(1)]) {
    const { client, state } = mockGitHub(input.assets, { release: { draft: false, assets }, tag: sourceSha });
    await assert.rejects(() => promoteRelease({ ...input, client }), /assets differ|missing validated assets/);
    assert.deepEqual(state.commands, []);
  }
  assert.deepEqual(verifyAssets(valid.slice(1), input.assets, { complete: false }), [input.assets[0]]);
});

test('annotated tags are dereferenced and cyclic or non-commit tag objects are rejected', async () => {
  const annotationSha = 'e'.repeat(40);
  const make = object => ({ api: async endpoint => endpoint.includes('/git/ref/') ?
    { ref: `refs/tags/${TAG}`, object: { type: 'tag', sha: annotationSha } } : { object } });
  assert.equal(await resolveTag(make({ type: 'commit', sha: sourceSha })), sourceSha);
  await assert.rejects(() => resolveTag(make({ type: 'tag', sha: annotationSha })), /cyclic/);
  await assert.rejects(() => resolveTag(make({ type: 'tree', sha: sourceSha })), /resolve to a commit/);
});
