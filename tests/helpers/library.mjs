// Test-only package helpers, shared by tests/m4/rehearse.mjs and
// tests/fixtures/build.mjs: an installed nth-review package as Claude Code's
// plugin manager lays it out (INSTALL.md, Enable step 4), from which Enable
// installs the skill into a throwaway project, and the legacy nth-dev-kit
// library receipt, used only to rehearse legacy installations.
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_ENTRIES, buildManifest, lfDigest } from '../tools/runtime-manifest.mjs';
import { REVIEW_DIR } from './tmp.mjs';

export { RUNTIME_ENTRIES, lfDigest };
// The source checkout: this repository. Enable never installs from it.
export const KIT = REVIEW_DIR;
export const PACKAGE_ID = 'nth-review@nth-review';

// Writes <lib>/.nth-dev-kit-library.json for every file under <lib> (a legacy
// nth-dev-kit library, as its Global Install wrote it).
export function writeReceipt(lib) {
  const files = {};
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (rel === '.nth-dev-kit-library.json') continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/`);
      else files[rel] = lfDigest(fs.readFileSync(path.join(dir, e.name)));
    }
  };
  walk(lib, '');
  fs.writeFileSync(path.join(lib, '.nth-dev-kit-library.json'), `${JSON.stringify({ schemaVersion: 1, agent: 'claude', files }, null, 2)}\n`);
}

// An installed package under <config>/plugins/cache/nth-review/nth-review/<version>/,
// holding what Enable reads: INSTALL.md, the runtime files, the plugin manifest
// and runtime-manifest.json. No tests/ and no VALIDATION.md, so nothing about
// fixtures or their answers is ever copied next to a project. `edit(dir)` may
// change the package before its manifest is written. Registered in
// <config>/plugins/installed_plugins.json as `claude plugin install` records it.
export function makePackageCache(config, { version = null, from = REVIEW_DIR, edit = null } = {}) {
  const plugin = JSON.parse(fs.readFileSync(path.join(from, '.claude-plugin', 'plugin.json'), 'utf8'));
  const v = version ?? plugin.version;
  const dir = path.join(config, 'plugins', 'cache', 'nth-review', 'nth-review', v);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ ...plugin, version: v }, null, 2)}\n`);
  fs.copyFileSync(path.join(from, 'INSTALL.md'), path.join(dir, 'INSTALL.md'));
  for (const entry of RUNTIME_ENTRIES) fs.cpSync(path.join(from, entry), path.join(dir, entry), { recursive: true });
  if (edit) edit(dir);
  fs.writeFileSync(path.join(dir, 'runtime-manifest.json'), `${JSON.stringify(buildManifest(dir), null, 2)}\n`);
  registerPackage(config, dir, v);
  return dir;
}

// The plugin manager's record of the install (installed_plugins.json, version 2).
export function registerPackage(config, installPath, version) {
  const file = path.join(config, 'plugins', 'installed_plugins.json');
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 2, plugins: {} };
  const now = '2026-10-29T00:00:00.000Z';
  doc.plugins[PACKAGE_ID] = [{ scope: 'user', installPath, version, installedAt: now, lastUpdated: now }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}
