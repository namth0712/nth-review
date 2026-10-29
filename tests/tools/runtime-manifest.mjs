#!/usr/bin/env node
// The package manifest, `runtime-manifest.json` at the repository root: the
// LF-content sha256 of INSTALL.md and of every runtime file Enable installs,
// so Enable can verify an installed package (INSTALL.md, Enable step 4).
//
//   node tests/tools/runtime-manifest.mjs --check   exit 1 if the file is stale
//   node tests/tools/runtime-manifest.mjs --write   rewrite it from the files
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST = 'runtime-manifest.json';
export const DOC = 'INSTALL.md';
// The runtime entries: what Enable installs into <P>/.claude/skills/nth-review/.
export const RUNTIME_ENTRIES = Object.freeze(['SKILL.md', 'THIRD-PARTY-NOTICES.md', 'reference', 'scripts']);

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const lfDigest = (bytes) => sha(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8'));

// INSTALL.md and every file under the runtime entries, by forward-slash path.
export function packageFiles(root = ROOT) {
  const out = [DOC];
  const walk = (rel) => {
    const abs = path.join(root, ...rel.split('/'));
    if (fs.statSync(abs).isDirectory()) for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`);
    else out.push(rel);
  };
  for (const entry of RUNTIME_ENTRIES) walk(entry);
  return out.sort();
}

export function buildManifest(root = ROOT) {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const files = Object.fromEntries(packageFiles(root).map((rel) => [rel, lfDigest(fs.readFileSync(path.join(root, ...rel.split('/'))))]));
  return { schemaVersion: 1, package: plugin.name, version: plugin.version, files };
}
export const manifestText = (root = ROOT) => `${JSON.stringify(buildManifest(root), null, 2)}\n`;

function main(argv) {
  const file = path.join(ROOT, MANIFEST);
  if (argv[0] === '--write') { fs.writeFileSync(file, manifestText()); return 0; }
  if (argv[0] === '--check') {
    const ok = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === manifestText();
    process.stdout.write(ok ? `${MANIFEST} is current\n` : `${MANIFEST} is stale: run with --write\n`);
    return ok ? 0 : 1;
  }
  process.stderr.write('usage: runtime-manifest.mjs --check | --write\n');
  return 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
