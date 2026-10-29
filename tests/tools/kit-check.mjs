#!/usr/bin/env node
// nth-dev-kit's side of the move (MIGRATION-VALIDATION.md): the kit holds no
// copy of nth-review's engine, names nth-review only in its pointer, the two
// Global prompts and the two READMEs, pins this repository's version and
// runtime digest, and never enables the package or runs a review. Read-only:
// it lists the kit's files with `git ls-files` and reads them.
//
//   node tests/tools/kit-check.mjs --kit <nth-dev-kit checkout> [--self-test]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildManifest } from './runtime-manifest.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const ALLOWED = ['agents/claude/integrations/review.md', 'README.md', 'agents/claude/README.md', 'prompts/claude/global/install.md', 'prompts/claude/global/update.md'];
const POINTER = 'agents/claude/integrations/review.md';
const flat = (t) => t.replace(/\s+/g, ' ');

// This repository's pin values: its version and the runtime digest Enable records as `library`.
export function pinOf(root = ROOT) {
  const m = buildManifest(root);
  const rt = Object.keys(m.files).filter((k) => k !== 'INSTALL.md').sort();
  return { version: m.version, runtimeDigest: sha(rt.map((r) => `${r} ${m.files[r]}`).join('\n')), runtimeHashes: new Set(rt.map((r) => sha(fs.readFileSync(path.join(root, ...r.split('/')))))) };
}

export function kitFiles(kit) {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: kit, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ls-files in the kit: ${r.stderr}`);
  const out = new Map();
  for (const rel of r.stdout.split('\0').filter(Boolean)) {
    const file = path.join(kit, ...rel.split('/'));
    if (!fs.existsSync(file) || fs.statSync(file).size > 2 * 1024 * 1024) continue; // deleted in the working tree, or large
    out.set(rel, fs.readFileSync(file));
  }
  return out;
}

export function kitProblems(files, pin) {
  const problems = [];
  const text = (rel) => (files.has(rel) ? files.get(rel).toString('utf8') : '');
  const need = (rel, re, label) => { if (!re.test(flat(text(rel)))) problems.push(`${rel}: ${label}`); };
  for (const [rel, bytes] of files) {
    if (rel.startsWith('agents/claude/integrations/review/')) problems.push(`the engine is still in the kit: ${rel}`);
    else if (/(^|\/)nthr\.mjs$/.test(rel) || pin.runtimeHashes.has(sha(bytes))) problems.push(`a copy of an nth-review runtime file: ${rel}`);
    if (!bytes.includes(0) && !ALLOWED.includes(rel) && bytes.toString('utf8').includes('nth-review')) problems.push(`${rel}: names nth-review`);
  }
  // The pointer: the pin, and the Package step's never-rules.
  need(POINTER, new RegExp(`\\| Version \\| \`${pin.version.replace(/\./g, '\\.')}\``), 'pins this version');
  need(POINTER, new RegExp(`\\| Runtime digest \\| \`${pin.runtimeDigest}\` \\|`), 'pins this runtime digest');
  need(POINTER, /It never enables nth-review anywhere and never runs a review\./, 'never enables, never reviews');
  need(POINTER, /independently managed\. Never touch it\./, 'leaves an independent installation alone');
  need(POINTER, /the user uninstalled it, which is an opt-out\. Do not reinstall it/, 'honours an uninstall');
  need(POINTER, /run `claude plugin enable`, or write `enabledPlugins` anywhere;/, 'never enables the plugin');
  need(POINTER, /Never run it from Project Start bootstrap or Project Update\./, 'not from Project Start or Project Update');
  if (/agents\/claude\/integrations\/review\//.test(text(POINTER).replace(/Until 2026-10-29 it lived here, under `agents\/claude\/integrations\/review\/`; that copy is gone\./, '').replace(/`<config>\/nth-dev-kit\/agents\/claude\/integrations\/review\/`/g, ''))) {
    problems.push(`${POINTER}: refers to the removed module`);
  }
  // The Global prompts run the Package step and keep nth-review inactive.
  const install = 'prompts/claude/global/install.md';
  need(install, /nth-review is an external package, not library data: never copy it into `<config>\/skills\/` or into any project, never enable it, and never run a review\./, 'external, never enabled');
  need(install, /run the "Package step" in the installed library's `agents\/claude\/integrations\/review\.md`/, 'runs the Package step');
  need(install, /When invoked as Project Start bootstrap, skip this step too\./, 'bootstrap skips it');
  const update = 'prompts/claude/global/update.md';
  need(update, /Never refresh, enable, or copy it into `<config>\/skills\/` or any project, and never run a review\./, 'never refreshed or enabled');
  need(update, /never touches an independently managed or uninstalled one/, 'leaves an independent installation alone');
  need(update, /existing project installations are NOT refreshed automatically: each project needs its own explicit Update/, 'reports per-project Update');
  if (/review\.state\.json/.test(text(update))) problems.push(`${update}: reads project state`);
  // The lifecycle states the rule generically; Project Start/Update never touch it.
  need('docs/lifecycle.md', /an adapter may document an external, independently versioned package that Global Install\/Update install, inactive, at a version the adapter pins/, 'the external-package rule');
  need('docs/lifecycle.md', /never enable it, never touch an installation they did not make, and never inspect projects/, 'never enabled by the lifecycle');
  for (const rel of ['docs/lifecycle.md', 'prompts/claude/project/start.md', 'prompts/claude/project/update.md']) {
    if (/nth-review|integrations\/review|review\.state/.test(text(rel))) problems.push(`${rel}: names the review integration`);
  }
  for (const [rel, link] of [['README.md', 'agents/claude/integrations/review.md'], ['agents/claude/README.md', 'integrations/review.md']]) {
    need(rel, new RegExp(`\\[nth-review\\]\\(${link.replace(/[./]/g, '\\$&')}\\)`), 'links the pointer');
    need(rel, /manually as `\/nth-review`/, 'manual invocation');
    need(rel, /external, independently versioned package/, 'external package');
    need(rel, /never enable it/, 'never enabled by Global Install/Update');
    need(rel, /Project Start\/Update never enable it/, 'Project Start/Update never enable');
    need(rel, /Enable, Update, (?:and|or) Disable/, 'explicit Enable, Update and Disable');
  }
  return problems;
}

// Each rule fails on a deliberate break of the real kit text.
function selfTest(files, pin) {
  const variant = (rel, from, to) => {
    const t = files.get(rel).toString('utf8');
    if (!(from instanceof RegExp) && !t.includes(from)) throw new Error(`self-test mutation does not apply in ${rel}`);
    return new Map([...files, [rel, Buffer.from(t.replace(from, to))]]);
  };
  const cases = [
    ['an engine file back in the kit', new Map([...files, ['agents/claude/integrations/review/scripts/nthr.mjs', Buffer.from('x')]]), /the engine is still in the kit/],
    ['a runtime file copied elsewhere', new Map([...files, ['managed/skills/nth-review/SKILL.md', fs.readFileSync(path.join(ROOT, 'SKILL.md'))]]), /a copy of an nth-review runtime file/],
    ['another pin', variant(POINTER, `\`${pin.version}\``, '`9.9.9`'), /pins this version/],
    ['the Package step enables', variant(POINTER, 'run `claude plugin enable`, or write `enabledPlugins` anywhere;', 'write `enabledPlugins` only for the current project;'), /never enables the plugin/],
    ['an independent install overwritten', variant(POINTER, 'independently managed. Never touch it.', 'independently managed. Update it to the pin.'), /leaves an independent installation alone/],
    ['Project Start names it', variant('prompts/claude/project/start.md', /\n$/, '\nAlso enable nth-review.\n'), /start\.md: names the review integration/],
    ['Global Update refreshes projects', variant('prompts/claude/global/update.md', 'NOT refreshed automatically', 'refreshed automatically'), /reports per-project Update/],
    ['another kit file names it', new Map([...files, ['managed/rules/x.md', Buffer.from('see nth-review')]]), /managed\/rules\/x\.md: names nth-review/],
  ];
  return cases.map(([label, world, expect]) => ({ label, caught: kitProblems(world, pin).some((p) => expect.test(p)) }));
}

function main(argv) {
  const at = argv.indexOf('--kit');
  if (at === -1 || !argv[at + 1]) { process.stderr.write('usage: kit-check.mjs --kit <nth-dev-kit checkout> [--self-test]\n'); return 2; }
  const kit = path.resolve(argv[at + 1]);
  const files = kitFiles(kit);
  const pin = pinOf();
  const problems = kitProblems(files, pin);
  process.stdout.write(`${files.size} kit files scanned; pin ${pin.version} ${pin.runtimeDigest}\n`);
  for (const p of problems) process.stdout.write(`PROBLEM ${p}\n`);
  let ok = problems.length === 0;
  if (argv.includes('--self-test')) {
    const results = selfTest(files, pin);
    for (const r of results) process.stdout.write(`${r.caught ? 'CAUGHT ' : 'MISSED '} ${r.label}\n`);
    ok = ok && results.every((r) => r.caught);
    process.stdout.write(`${results.filter((r) => r.caught).length}/${results.length} mutations caught\n`);
  }
  process.stdout.write(ok ? 'kit check: PASS\n' : 'kit check: FAIL\n');
  return ok ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
