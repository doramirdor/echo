#!/usr/bin/env node
// Installs the latest Echo.app from GitHub Releases into /Applications.
// Zero deps: shells out to curl/tar/ditto/xattr — all present on macOS.
'use strict';
const { execSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

if (process.platform !== 'darwin') {
  console.error('Echo is macOS-only.');
  process.exit(1);
}

// Unversioned, stable release asset -> always resolves to the newest release.
const TARBALL =
  'https://github.com/doramirdor/echo/releases/latest/download/Echo_universal.app.tar.gz';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-'));
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

console.log('Downloading the latest Echo…');
try {
  run(`curl -fSL --retry 3 -o "${tmp}/echo.tgz" "${TARBALL}" && tar -xzf "${tmp}/echo.tgz" -C "${tmp}"`);
} catch {
  // fall through to the existence check below for a clean message
}

const src = path.join(tmp, 'Echo.app');
// Never touch an existing install until the download is on disk and intact:
// a half-finished download must leave the current Echo.app alone.
if (!fs.existsSync(src)) {
  console.error('Download failed — nothing was installed.');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
let dest = '/Applications/Echo.app';
try {
  run(`rm -rf "${dest}" && ditto "${src}" "${dest}"`);
} catch {
  // /Applications not writable (non-admin) -> fall back to ~/Applications.
  dest = path.join(os.homedir(), 'Applications', 'Echo.app');
  run(`mkdir -p "${path.dirname(dest)}" && rm -rf "${dest}" && ditto "${src}" "${dest}"`);
}
// curl downloads aren't quarantined, but strip it defensively so Gatekeeper
// never blocks the ad-hoc-signed build.
try { execSync(`xattr -dr com.apple.quarantine "${dest}"`); } catch {}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`Installed ${dest}`);
run(`open "${dest}"`);
console.log('Echo lives in the menu bar. Grant the permissions it prompts for on first launch.');
