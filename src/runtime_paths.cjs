'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Shared by the CLI and package tests. A macOS application keeps its executable
// beside Resources, not inside the Linux resources/app layout.
function electronLayout(projectRoot, { platform = process.platform, existsSync = fs.existsSync } = {}) {
  const root = path.resolve(projectRoot);
  const resources = path.dirname(root);
  const mac = platform === 'darwin';
  const bundled = mac
    ? path.resolve(root, '..', '..', 'MacOS', 'DotDial')
    : path.resolve(root, '..', '..', 'dotdial-runtime');
  const packaged = path.basename(root) === 'app' &&
    path.basename(resources) === (mac ? 'Resources' : 'resources') &&
    (!mac || path.basename(path.dirname(resources)) === 'Contents') && existsSync(bundled);
  const development = mac
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', platform === 'win32' ? 'electron.exe' : 'electron');
  return { packaged, electron: packaged ? bundled : development, mainScript: path.join(root, 'src', 'main.cjs') };
}

module.exports = { electronLayout };
