#!/usr/bin/env node
'use strict';

// This is a deliberately one-time promotion, not a release-on-every-push rule.
// The native jobs must finish before this script receives their current-run
// distribution artifacts. No dependency installation or build runs with write
// permission, and no existing release asset is replaced.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPOSITORY = 'aaamosh/DotDial';
const VERSION = '0.1.0-beta.4';
const TAG = 'v0.1.0-beta.4-macos-preview.1';
const TITLE = 'DotDial for macOS 0.1.0-beta.4 - Hands-free preview';
const PUBLISH_SUBJECT = 'Publish macOS beta 4 preview with voice commands';
const ARCHITECTURES = ['arm64', 'x64'];
const API_ROOT = `/repos/${REPOSITORY}`;
const SOURCE_PATTERN = /^[a-f0-9]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw Error(message);
}

function subject(message) {
  return typeof message === 'string' ? message.split('\n', 1)[0] : '';
}

function validateContext(env, event) {
  requireValue(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main',
  'Only the authorized repository branch push may publish this preview.');
  requireValue(SOURCE_PATTERN.test(env.GITHUB_SHA || '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || ''),
    'The exact source commit and Actions run are required.');
  requireValue(event?.head_commit?.id === env.GITHUB_SHA && subject(event.head_commit.message) === PUBLISH_SUBJECT,
    'The head commit must contain the exact one-time publication subject.');
  return { sourceSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` };
}

function regularFile(file, maximumSize = Number.MAX_SAFE_INTEGER) {
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && stat.size > 0 && stat.size <= maximumSize,
    `Expected a nonempty regular file: ${path.basename(file)}`);
  return stat;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function exactDirectory(directory, expected) {
  requireValue(fs.lstatSync(directory).isDirectory(), 'Artifact directories must not be links.');
  const actual = fs.readdirSync(directory).sort();
  requireValue(JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `Unexpected or missing files in ${path.basename(directory)}; only distribution artifacts are allowed.`);
}

async function validateArtifacts(directory, { sourceSha, electronVersion }) {
  requireValue(SOURCE_PATTERN.test(sourceSha || '') && /^\d+\.\d+\.\d+$/.test(electronVersion || ''),
    'Invalid expected build identity.');
  exactDirectory(directory, ARCHITECTURES);
  const assets = [];
  for (const arch of ARCHITECTURES) {
    const artifactDirectory = path.join(directory, arch);
    const stem = `DotDial-${VERSION}-preview-${sourceSha.slice(0, 8)}-macos-${arch}`;
    const names = ['.app.zip', '.dmg', '.manifest.json'].map(suffix => stem + suffix);
    exactDirectory(artifactDirectory, [...names, 'SHA256SUMS']);
    const checksumFile = path.join(artifactDirectory, 'SHA256SUMS');
    regularFile(checksumFile, 32 * 1024);
    const rows = fs.readFileSync(checksumFile, 'utf8').trimEnd().split(/\r?\n/);
    requireValue(rows.length === names.length, 'Each architecture must list exactly three checksums.');
    const checksums = new Map();
    for (const row of rows) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(row);
      requireValue(match && names.includes(match[2]) && !checksums.has(match[2]),
        'Checksums must name each expected artifact exactly once.');
      checksums.set(match[2], match[1]);
    }
    const manifestFile = path.join(artifactDirectory, stem + '.manifest.json');
    regularFile(manifestFile, 64 * 1024);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const identity = { schemaVersion: 1, product: 'DotDial', version: VERSION,
      platform: 'darwin', architecture: arch, minimumMacOS: '13.0',
      bundleIdentifier: 'org.dotdial.DotDial', electronVersion, sourceCommit: sourceSha,
      sourceDirty: false, distribution: 'preview', codeSignature: 'ad-hoc',
      developerIDSigned: false, notarized: false };
    requireValue(manifest && !Array.isArray(manifest) && Object.entries(identity).every(([key, value]) => manifest[key] === value),
      `The ${arch} manifest does not describe the exact clean ad-hoc preview being published.`);
    for (const name of names) {
      const file = path.join(artifactDirectory, name);
      const stat = regularFile(file);
      const digest = await sha256(file);
      requireValue(checksums.get(name) === digest, `SHA-256 mismatch: ${name}`);
      assets.push({ name, file, size: stat.size, sha256: digest });
    }
  }
  return assets.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function addCombinedChecksums(assets, outputDirectory) {
  requireValue(assets.length === 6 && new Set(assets.map(asset => asset.name)).size === 6,
    'Exactly six validated distribution files are required.');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const file = path.join(outputDirectory, 'SHA256SUMS');
  const contents = assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n';
  fs.writeFileSync(file, contents, { mode: 0o644 });
  return [...assets, { name: 'SHA256SUMS', file, size: Buffer.byteLength(contents), sha256: await sha256(file) }];
}

function renderReleaseBody(template, context) {
  const replacements = { SOURCE_COMMIT: context.sourceSha, SOURCE_SHORT: context.sourceSha.slice(0, 8), CI_RUN_URL: context.runUrl };
  let body = template;
  for (const [key, value] of Object.entries(replacements)) {
    requireValue(body.includes(`{{${key}}}`), `Release notes must include {{${key}}}.`);
    body = body.replaceAll(`{{${key}}}`, value);
  }
  requireValue(!/\{\{|\}\}/.test(body), 'Unresolved release-note placeholder.');
  return body.trimEnd() + `\n\n<!-- dotdial-macos-preview-publisher:v1 source=${context.sourceSha} run=${context.runId} -->\n`;
}

function verifyAssets(remoteAssets, expected, { complete = true } = {}) {
  requireValue(Array.isArray(remoteAssets), 'GitHub did not return the release asset list.');
  const missing = new Map(expected.map(asset => [asset.name, asset]));
  for (const remote of remoteAssets) {
    const local = missing.get(remote.name);
    requireValue(local && remote.state === 'uploaded' && remote.size === local.size && remote.digest === `sha256:${local.sha256}`,
      'Existing release assets differ from the validated files; nothing will be replaced.');
    missing.delete(remote.name);
  }
  requireValue(!complete || missing.size === 0, 'The release is missing validated assets.');
  return [...missing.values()];
}

async function resolveTag(client) {
  const ref = await client.api(`${API_ROOT}/git/ref/tags/${TAG}`, { allow404: true });
  if (ref === null) return null;
  requireValue(ref.ref === `refs/tags/${TAG}`, 'GitHub returned a different tag.');
  let object = ref.object;
  const seen = new Set();
  for (let depth = 0; depth < 8; depth++) {
    requireValue(object && SOURCE_PATTERN.test(object.sha || '') && !seen.has(object.sha), 'Invalid or cyclic release tag.');
    if (object.type === 'commit') return object.sha;
    requireValue(object.type === 'tag', 'The release tag must resolve to a commit.');
    seen.add(object.sha);
    object = (await client.api(`${API_ROOT}/git/tags/${object.sha}`)).object;
  }
  throw Error('The release tag exceeds the allowed annotated-tag depth.');
}

async function verifyTag(client, sourceSha, required = false) {
  const target = await resolveTag(client);
  requireValue(target === sourceSha || (!required && target === null), 'The release tag does not point to the exact tested commit.');
}

async function findRelease(client) {
  // The tag endpoint omits unpublished drafts. Use the authenticated list so
  // an interrupted draft can resume without creating a second release.
  const releases = await client.api(`${API_ROOT}/releases?per_page=100`);
  requireValue(Array.isArray(releases) && releases.length < 100, 'Cannot safely enumerate releases for this one-time publisher.');
  const matches = releases.filter(release => release.tag_name === TAG);
  requireValue(matches.length <= 1, 'Multiple releases use the fixed preview tag.');
  if (!matches.length) return null;
  requireValue(Number.isSafeInteger(matches[0].id) && matches[0].id > 0, 'Invalid release identifier.');
  return client.api(`${API_ROOT}/releases/${matches[0].id}`);
}

function verifyRelease(release, context, body, { requireDraft = false } = {}) {
  requireValue(release && release.tag_name === TAG && release.prerelease === true &&
    release.target_commitish === context.sourceSha && typeof release.draft === 'boolean',
  'Existing release metadata does not match the authorized macOS preview.');
  if (release.draft || requireDraft) {
    requireValue(release.draft === true && release.name === TITLE && release.body === body &&
      release.author?.login === 'github-actions[bot]',
    'Only an unchanged draft created by this exact publication run may be resumed.');
  }
}

async function verifySource(client, context) {
  const commit = await client.api(`${API_ROOT}/commits/${context.sourceSha}`);
  requireValue(commit.sha === context.sourceSha && subject(commit.commit?.message) === PUBLISH_SUBJECT,
    'GitHub source readback does not match the authorized publication commit.');
  const run = await client.api(`${API_ROOT}/actions/runs/${context.runId}`);
  requireValue(String(run.id) === context.runId && run.head_sha === context.sourceSha && run.event === 'push' &&
    run.head_branch === 'main' && run.path === '.github/workflows/macos.yml' &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
  'The artifacts must come from the native workflow for this exact repository push.');
}

async function promoteRelease({ client, context, assets, body, notesFile }) {
  await verifySource(client, context);
  await verifyTag(client, context.sourceSha);
  let release = await findRelease(client);
  if (release) {
    verifyRelease(release, context, body);
    if (!release.draft) {
      await verifyTag(client, context.sourceSha, true);
      verifyAssets(release.assets, assets);
      return { published: true, alreadyPublished: true, tag: TAG, sourceCommit: context.sourceSha, url: release.html_url };
    }
  } else {
    await client.command(['release', 'create', TAG, '--repo', REPOSITORY, '--draft',
      '--target', context.sourceSha, '--prerelease', '--latest=false', '--title', TITLE, '--notes-file', notesFile]);
    release = await findRelease(client);
    verifyRelease(release, context, body, { requireDraft: true });
  }
  // Resume only missing files. In particular, never use gh's --clobber option.
  const missing = verifyAssets(release.assets, assets, { complete: false });
  for (const asset of missing) {
    await client.command(['release', 'upload', TAG, asset.file, '--repo', REPOSITORY]);
  }
  release = await findRelease(client);
  verifyRelease(release, context, body, { requireDraft: true });
  verifyAssets(release.assets, assets);
  await verifyTag(client, context.sourceSha);
  // The draft becomes public only after both local checksums and GitHub's
  // stored byte counts / SHA-256 digests agree for all seven assets.
  await client.command(['release', 'edit', TAG, '--repo', REPOSITORY, '--draft=false', '--prerelease', '--latest=false']);
  release = await findRelease(client);
  verifyRelease(release, context, body);
  requireValue(release.draft === false, 'The verified release is still a draft.');
  await verifyTag(client, context.sourceSha, true);
  verifyAssets(release.assets, assets);
  return { published: true, alreadyPublished: false, tag: TAG, sourceCommit: context.sourceSha, url: release.html_url };
}

function githubClient(env) {
  requireValue(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'The workflow-scoped GitHub token is required.');
  return {
    async api(endpoint, { allow404 = false } = {}) {
      requireValue(endpoint.startsWith(API_ROOT + '/'), 'Only this repository may be queried.');
      const response = await fetch('https://api.github.com' + endpoint, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dotdial-macos-preview-publisher' },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (allow404 && response.status === 404) return null;
      requireValue(response.ok, `GitHub read failed with HTTP ${response.status}.`);
      return response.json();
    },
    async command(args) {
      const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 1024 * 1024,
        env: { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: '' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      // Do not echo credentials, HTTP traces, or CLI environment on failure.
      requireValue(!result.error && result.status === 0,
        `GitHub release ${args[1]} did not complete; inspect remote state before retrying.`);
    },
  };
}

async function main(env = process.env) {
  const root = path.resolve(__dirname, '..');
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const context = validateContext(env, event);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  requireValue(pkg.name === 'dotdial' && pkg.version === VERSION, 'This publisher is restricted to the beta.4 macOS preview application version.');
  const distribution = await validateArtifacts(path.join(root, 'build', 'macos-release'),
    { ...context, electronVersion: pkg.devDependencies.electron });
  const output = path.join(root, 'build', 'macos-promotion');
  const assets = await addCombinedChecksums(distribution, output);
  const body = renderReleaseBody(fs.readFileSync(path.join(root, 'docs', 'releases', 'macos-beta4-preview-1.md'), 'utf8'), context);
  const notesFile = path.join(output, 'release-notes.md');
  fs.writeFileSync(notesFile, body, { mode: 0o644 });
  const result = await promoteRelease({ client: githubClient(env), context, assets, body, notesFile });
  console.log(JSON.stringify({ ...result, assets: assets.map(({ name, size, sha256: digest }) => ({ name, size, sha256: digest })) }, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    `## Published macOS preview\n\n[${TITLE}](${result.url})\n\nSource: \`${context.sourceSha}\`. Seven assets verified against GitHub SHA-256 digests.\n`);
}

if (require.main === module) main().catch(error => { console.error('macOS preview publication failed:', error.message); process.exitCode = 1; });
module.exports = { validateContext, validateArtifacts, addCombinedChecksums, renderReleaseBody,
  verifyAssets, resolveTag, verifyRelease, verifySource, promoteRelease, githubClient,
  REPOSITORY, VERSION, TAG, TITLE, PUBLISH_SUBJECT };
