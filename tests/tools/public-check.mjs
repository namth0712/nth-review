#!/usr/bin/env node
// The public artifact check, run before every publish (docs/DEVELOPMENT.md,
// Private evidence and the public repository). It lists the files this
// repository would publish (every file but the private paths) and reports:
//   - a .gitignore that does not list exactly PRIVATE_PATHS;
//   - a missing or unexpected top-level entry (an unexpected one would be published);
//   - an account path, a non-example e-mail address, a session identifier or a credential;
//   - a private term from tests/tools/private.json, when that file is present;
//   - a missing LICENSE or a stale runtime-manifest.json.
// It only reads. Exit 1 when there is a problem.
//
//   node tests/tools/public-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRIVATE_EVIDENCE } from './evidence.mjs';
import { MANIFEST, manifestText } from './runtime-manifest.mjs';

const REVIEW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PRIVATE_PATHS = Object.freeze([...PRIVATE_EVIDENCE, 'tests/tools/private.json', 'private/']);
export const TOP_LEVEL = Object.freeze(['.claude-plugin', '.gitattributes', '.gitignore', 'CHANGELOG.md', 'INSTALL.md', 'LICENSE', 'MIGRATION-VALIDATION.md', 'README.md',
  'RELEASE.md', 'SKILL.md', 'THIRD-PARTY-NOTICES.md', 'VALIDATION.md', 'docs', 'plugin-agents', 'plugin-skills', 'reference', 'runtime-manifest.json', 'scripts', 'tests']);
// Placeholder account names that tests and documents use on purpose.
const PLACEHOLDER_ACCOUNTS = new Set(['x', 'me', 'someone', 'user', 'username', 'you', 'runner', 'runneradmin', 'public', 'default', 'example']);
// Synthetic session-shaped identifiers in the syn-ledger fixture's API document.
const SYNTHETIC_UUIDS = new Set(['2b7e9c41-5d6f-4a8b-9c0d-1e2f3a4b5c6d', '6f1c2d0e-3a4b-4c5d-8e9f-0a1b2c3d4e5f']);
const ACCOUNT = [
  /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)([^\\/\s"'`<>*|]+)/gi,
  /(?<![\w.:-])\/[a-z]\/Users\/([^/\s"'`<>*|]+)/gi,
  /(?<![\w.:/-])\/Users\/([^/\s"'`<>*|]+)/g,
  /(?<![\w.:/-])\/home\/([^/\s"'`<>*|]+)/g,
];
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SECRET = /sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{10,}/;
const exampleDomain = (d) => /\.(invalid|example|test|localhost)$/i.test(d) || /^example\.(com|org|net)$/i.test(d);
// An all-but-one-digit identifier such as 11111111-1111-4111-8111-111111111111 is synthetic.
const syntheticUuid = (u) => SYNTHETIC_UUIDS.has(u.toLowerCase()) || new Set(u.toLowerCase().replace(/-/g, '')).size <= 3;

// A .gitignore pattern (anchored, `*` within one segment, a trailing `/` for a folder) as a test of a forward-slash path.
const matcher = (pattern) => {
  const folder = pattern.endsWith('/');
  const body = pattern.replace(/\/$/, '').split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${body}${folder ? '/' : '$'}`);
};
const PRIVATE_RES = PRIVATE_PATHS.map(matcher);
export const isPrivate = (rel) => PRIVATE_RES.some((re) => re.test(rel));

export function listFiles(root = REVIEW) {
  const files = [];
  const links = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`;
      if (rel === '.git') continue;
      if (e.isSymbolicLink()) links.push(rel);
      else if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/`);
      else files.push(rel);
    }
  };
  walk(root, '');
  return { files: files.sort(), links };
}

// One published file's text: each finding as { line, kind, text }.
export function scanText(text, denyTerms = []) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const at = (kind, value) => out.push({ line: i + 1, kind, text: value });
    for (const re of ACCOUNT) for (const m of line.matchAll(re)) if (!PLACEHOLDER_ACCOUNTS.has(m[1].toLowerCase())) at('account path', m[0]);
    for (const m of line.matchAll(EMAIL)) if (!exampleDomain(m[1])) at('e-mail address', m[0]);
    for (const m of line.matchAll(UUID)) if (!syntheticUuid(m[0])) at('session identifier', m[0]);
    const secret = SECRET.exec(line);
    if (secret) at('credential', secret[0].slice(0, 12));
    const lower = line.toLowerCase();
    for (const term of denyTerms) if (lower.includes(term)) at('private term', term);
  });
  return out;
}

export function publicProblems(root = REVIEW) {
  const problems = [];
  const { files, links } = listFiles(root);
  const published = files.filter((f) => !isPrivate(f));
  for (const l of links) problems.push(`${l}: a symbolic link`);
  // .gitignore names exactly the private paths, in order.
  const ignore = fs.existsSync(path.join(root, '.gitignore'))
    ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/^\//, ''))
    : null;
  if (JSON.stringify(ignore) !== JSON.stringify(PRIVATE_PATHS)) problems.push(`.gitignore must list exactly: ${PRIVATE_PATHS.map((p) => `/${p}`).join(' ')}`);
  // Top-level entries.
  const top = fs.readdirSync(root).filter((n) => n !== '.git' && !isPrivate(fs.statSync(path.join(root, n)).isDirectory() ? `${n}/` : n));
  for (const n of top.filter((x) => !TOP_LEVEL.includes(x))) problems.push(`${n}: an unexpected top-level entry (it would be published)`);
  for (const n of TOP_LEVEL.filter((x) => !top.includes(x))) problems.push(`${n}: missing`);
  if (fs.existsSync(path.join(root, 'LICENSE')) && !fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').startsWith('MIT License\n')) problems.push('LICENSE: not the MIT License');
  try {
    if (fs.readFileSync(path.join(root, MANIFEST), 'utf8') !== manifestText(root)) problems.push(`${MANIFEST}: stale (node tests/tools/runtime-manifest.mjs --write)`);
  } catch (e) { problems.push(`${MANIFEST}: ${e.message}`); }
  // Content.
  const privateFile = path.join(root, 'tests', 'tools', 'private.json');
  const denyTerms = fs.existsSync(privateFile) ? JSON.parse(fs.readFileSync(privateFile, 'utf8')).denyTerms.map((t) => String(t).toLowerCase()) : null;
  let binary = 0;
  for (const f of published) {
    const bytes = fs.readFileSync(path.join(root, ...f.split('/')));
    if (bytes.includes(0)) { binary += 1; problems.push(`${f}: a binary file (not scanned)`); continue; }
    for (const h of scanText(bytes.toString('utf8'), denyTerms ?? [])) problems.push(`${f}:${h.line}: ${h.kind}: ${h.text}`);
  }
  return { published, privateCount: files.length - published.length, denyTerms: denyTerms?.length ?? null, binary, problems };
}

export function main() {
  const r = publicProblems();
  console.log(`${r.published.length} files would be published; ${r.privateCount} private files are kept out.`);
  console.log(r.denyTerms === null ? 'Private terms: NOT checked (tests/tools/private.json is absent).' : `Private terms: ${r.denyTerms} checked.`);
  for (const p of r.problems) console.log(`PROBLEM ${p}`);
  console.log(r.problems.length ? `${r.problems.length} problems.` : 'No problems.');
  return r.problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
