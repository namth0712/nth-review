// Static consistency guards for the project-scoped lifecycle (M4-T2): the
// lifecycle document (INSTALL.md) matches the module it installs. Each check is
// a pure function over text: the real documents pass it, and a deliberate
// mutation of its invariant makes it fail. (nth-dev-kit's own wiring, which
// keeps the package inactive, is checked by tests/tools/kit-check.mjs.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { COMMANDS } from '../scripts/lib/cli.mjs';
import { REVIEW_DIR } from './helpers/tmp.mjs';

const KIT = REVIEW_DIR;
const kitRead = (rel) => fs.readFileSync(path.join(KIT, ...rel.split('/')), 'utf8');
const DOC = 'INSTALL.md';
const doc = kitRead(DOC);
const flat = (text) => text.replace(/\s+/g, ' ');

// Mutates text and checks that the mutation applied.
function mutate(text, from, to = '') {
  const out = text.replace(from, to);
  assert.notEqual(out, text, `mutation applies: ${from}`);
  return out;
}

// ---------------------------------------------------------------- the module and its document

// Everything in the repository except the development and package files is a
// runtime file: an entry not named here counts as runtime, so a new top-level
// file fails the drift check until it is listed in one place or the other.
const NOT_RUNTIME = new Set(['tests', 'docs', 'plugin-agents', 'plugin-skills', 'VALIDATION.md', 'RELEASE.md', 'MIGRATION-VALIDATION.md', 'README.md', 'INSTALL.md',
  'CHANGELOG.md', 'LICENSE', 'runtime-manifest.json', 'private']);
function moduleFiles(dir = REVIEW_DIR, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (NOT_RUNTIME.has(rel)) continue; // development and package files, never installed
    if (!prefix && rel.startsWith('.')) continue; // hidden top-level entries: package metadata (.claude-plugin, .gitattributes, .gitignore) and local tooling (.git), never runtime
    if (entry.isDirectory()) out.push(...moduleFiles(path.join(dir, entry.name), `${rel}/`));
    else out.push(rel);
  }
  return out.sort();
}

// The runtime-file table row: groups separated by <br>, where a bare name
// takes the directory of the last path named before it in its group.
function documentedFiles(text) {
  const row = text.split('\n').find((line) => line.startsWith('| `<P>/.claude/skills/nth-review/`'));
  if (!row) return [];
  const files = [];
  for (const group of row.split('|')[1].split('<br>').slice(1)) {
    let dir = '';
    for (const [, name] of group.matchAll(/`([^`]+)`/g)) {
      if (name.includes('/')) dir = name.slice(0, name.lastIndexOf('/') + 1);
      files.push(name.includes('/') ? name : dir + name);
    }
  }
  return files.sort();
}

// The Validation rule for state-file keys, as a regular expression.
function stateKeyPattern(text) {
  const rule = /The allowed keys are (.+?), where a name is lowercase letters, digits and hyphens/.exec(text);
  if (!rule) return null;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = [...rule[1].matchAll(/`([^`]+)`/g)].map(([, key]) => key.split('<name>').map(escape).join('[a-z0-9-]+'));
  return new RegExp(`^(?:${alternatives.join('|')})$`);
}

function driftProblems(text, files) {
  const documented = documentedFiles(text);
  const problems = [
    ...files.filter((f) => !documented.includes(f)).map((f) => `not documented: ${f}`),
    ...documented.filter((f) => !files.includes(f)).map((f) => `documented but absent: ${f}`),
  ];
  const counts = [...text.matchAll(/\b[Tt]he (?:skill's )?(\d+) (?:runtime files|manifest entries|receipt entries|lines|files)\b/g)].map((m) => Number(m[1]));
  if (counts.length < 4) problems.push('the document no longer states the file count');
  for (const n of counts.filter((c) => c !== files.length)) problems.push(`stated count ${n}, actual ${files.length}`);
  const keys = stateKeyPattern(text);
  if (!keys) problems.push('no state-key rule');
  else for (const f of files.filter((name) => !keys.test(name))) problems.push(`not an allowed state key: ${f}`);
  return problems;
}

test('M4-T2 runtime files: the document lists exactly the module files, with the right count and allowed state keys; drift fails', () => {
  const files = moduleFiles();
  assert.equal(files.length, 27);
  assert.deepEqual(driftProblems(doc, files), []);
  assert.ok(driftProblems(mutate(doc, '`render.mjs`, '), files).includes('not documented: scripts/lib/render.mjs'));
  assert.ok(driftProblems(doc, [...files, 'scripts/lib/extra.mjs'].sort()).some((p) => p.startsWith('not documented: scripts/lib/extra.mjs')));
  assert.ok(driftProblems(doc, files.filter((f) => f !== 'reference/census.md')).includes('documented but absent: reference/census.md'));
  assert.ok(driftProblems(mutate(doc, 'the 27 manifest entries', 'the 26 manifest entries'), files).includes('stated count 26, actual 27'));
  assert.ok(driftProblems(doc, [...files, 'scripts/lib/Upper.mjs'].sort()).includes('not an allowed state key: scripts/lib/Upper.mjs'));
  assert.ok(driftProblems(mutate(doc, '`reference/<name>.md`, '), files).includes('not an allowed state key: reference/census.md'));
});

test('M4-T2 runtime bytes: every installed file is LF-only UTF-8 without a BOM, so its receipt digest is the installed hash', () => {
  for (const rel of moduleFiles()) {
    const bytes = fs.readFileSync(path.join(REVIEW_DIR, ...rel.split('/')));
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes), `${rel} is valid UTF-8`);
    assert.ok(!bytes.includes(13), `${rel} has no CR`);
    assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${rel} has no BOM`);
  }
});

// GitHub-style heading anchors, outside code fences.
function anchors(markdown) {
  const out = new Set();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^#{1,6} (.+)$/.exec(line);
    if (heading) out.add(heading[1].trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-'));
  }
  return out;
}

function brokenLinks(rel, text, only = () => true) {
  const broken = [];
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target) || !only(target)) continue;
    const [file, anchor] = target.split('#');
    const targetRel = file ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), file)) : rel;
    const abs = path.join(KIT, ...targetRel.split('/'));
    if (!fs.existsSync(abs)) broken.push(target);
    else if (anchor && !(fs.statSync(abs).isFile() && anchors(fs.readFileSync(abs, 'utf8')).has(anchor))) broken.push(target);
  }
  return broken;
}

test('M4-T2 links: every link and anchor in INSTALL.md and the README resolves, and the README links INSTALL.md; a broken one fails', () => {
  assert.deepEqual(brokenLinks(DOC, doc), []);
  const readme = kitRead('README.md');
  assert.ok([...readme.matchAll(/\]\(([^)\s]+)\)/g)].some(([, t]) => /^INSTALL\.md(#|$)/.test(t)), 'README.md links INSTALL.md');
  assert.deepEqual(brokenLinks('README.md', readme), []);
  assert.deepEqual(brokenLinks(DOC, mutate(doc, '(#writing-a-file)', '(#writing-files)')), ['#writing-files']);
  assert.deepEqual(brokenLinks(DOC, mutate(doc, '(#package-install-update-uninstall)', '(#package)')), ['#package']);
  assert.deepEqual(brokenLinks('README.md', mutate(readme, '](INSTALL.md', '](INSTAL.md')).length > 0, true);
  // The other public documents.
  for (const rel of PUBLIC_DOCS) assert.deepEqual(brokenLinks(rel, kitRead(rel)), [], rel);
  assert.deepEqual(brokenLinks('docs/USAGE.md', mutate(kitRead('docs/USAGE.md'), '(../INSTALL.md#the-four-steps)', '(../INSTALL.md#four-steps)')), ['../INSTALL.md#four-steps']);
});

// Every command example in the public documents names a real helper command and
// options it takes, and every typed review command uses only new-run's options.
const PUBLIC_DOCS = ['docs/USAGE.md', 'docs/ARCHITECTURE.md', 'docs/DEVELOPMENT.md', 'CHANGELOG.md'];
function exampleProblems(texts) {
  const problems = [];
  for (const [rel, text] of texts) {
    for (const [, command, rest] of text.matchAll(/nthr\.mjs"? ([a-z-]+)([^`\n]*)/g)) {
      if (!Object.hasOwn(COMMANDS, command)) { problems.push(`${rel}: no helper command ${command}`); continue; }
      for (const [, option] of rest.matchAll(/--([a-z-]+)/g)) if (!Object.hasOwn(COMMANDS[command].options, option)) problems.push(`${rel}: ${command} has no --${option}`);
    }
    for (const [, mode, rest] of text.matchAll(/\/nth-review (task|incremental|flow) ([^`\n]*)/g)) {
      for (const [, option] of rest.matchAll(/--([a-z-]+)/g)) if (!Object.hasOwn(COMMANDS['new-run'].options, option)) problems.push(`${rel}: /nth-review ${mode} has no --${option}`);
    }
    for (const [, op] of text.matchAll(/\/nth-review:project ([a-z]+)/g)) if (!['enable', 'update', 'disable'].includes(op)) problems.push(`${rel}: /nth-review:project has no ${op}`);
  }
  return problems;
}

test('public docs: every command example names a real helper command, review option and project operation; mutations fail', () => {
  const texts = new Map(['README.md', DOC, ...PUBLIC_DOCS, 'plugin-skills/project/SKILL.md'].map((rel) => [rel, kitRead(rel)]));
  assert.deepEqual(exampleProblems(texts), []);
  const examples = [...texts.values()].join('\n');
  assert.ok((examples.match(/nthr\.mjs"? [a-z-]+/g) ?? []).length >= 6 && (examples.match(/\/nth-review (task|incremental|flow) /g) ?? []).length >= 6, 'the examples are checked');
  const variant = (rel, from, to) => new Map([...texts, [rel, mutate(texts.get(rel), from, to)]]);
  assert.deepEqual(exampleProblems(variant('docs/USAGE.md', 'preview --ns', 'preview --namespace')), ['docs/USAGE.md: preview has no --namespace']);
  assert.deepEqual(exampleProblems(variant('README.md', '--change .:main..HEAD', '--range .:main..HEAD')), ['README.md: /nth-review task has no --range']);
  assert.deepEqual(exampleProblems(variant('README.md', '/nth-review:project enable', '/nth-review:project on')), ['README.md: /nth-review:project has no on']);
});

// What review.md says about the skill and its helper is what they do.
function claimProblems(text, skill, helper) {
  const problems = [];
  if (!/frontmatter sets `disable-model-invocation: true`/.test(text)) problems.push('doc: explicit invocation');
  if (!/^disable-model-invocation: true$/m.test(skill)) problems.push('SKILL.md: explicit invocation');
  if (!/`OFFICIAL_AUDITS_ENABLED` is `false`/.test(text)) problems.push('doc: audits disabled');
  if (!/^export const OFFICIAL_AUDITS_ENABLED = false;$/m.test(helper)) problems.push('nthr.mjs: audits disabled');
  if (!/Node\.js 20 or later/.test(text) || !/`node --version` must report v20 or later/.test(skill)) problems.push('Node.js 20');
  for (const [, command, rest] of text.matchAll(/nthr\.mjs" ([a-z-]+)([^`]*)`/g)) {
    if (!Object.hasOwn(COMMANDS, command)) { problems.push(`no helper command ${command}`); continue; }
    for (const [, option] of rest.matchAll(/--([a-z-]+)/g)) {
      if (!Object.hasOwn(COMMANDS[command].options, option)) problems.push(`${command} has no --${option}`);
    }
  }
  return problems;
}

test('M4-T2 claims: explicit invocation, disabled audits, Node.js 20 and the helper commands match the module; mutations fail', () => {
  const skill = fs.readFileSync(path.join(REVIEW_DIR, 'SKILL.md'), 'utf8');
  const helper = fs.readFileSync(path.join(REVIEW_DIR, 'scripts', 'nthr.mjs'), 'utf8');
  assert.deepEqual(claimProblems(doc, skill, helper), []);
  assert.equal([...doc.matchAll(/nthr\.mjs" ([a-z-]+)/g)].length >= 3, true, 'the helper commands are checked');
  assert.deepEqual(claimProblems(doc, mutate(skill, 'disable-model-invocation: true', 'disable-model-invocation: false'), helper), ['SKILL.md: explicit invocation']);
  assert.deepEqual(claimProblems(doc, skill, mutate(helper, 'OFFICIAL_AUDITS_ENABLED = false;', 'OFFICIAL_AUDITS_ENABLED = true;')), ['nthr.mjs: audits disabled']);
  assert.deepEqual(claimProblems(mutate(doc, '--slug p', '--name p'), skill, helper), ['new-run has no --name']);
});

// ---------------------------------------------------------------- lifecycle order and Git

// True when the patterns all match, in this order, within the text.
function inOrder(text, patterns) {
  let from = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text.slice(from));
    if (!match) return false;
    from += match.index + match[0].length;
  }
  return true;
}

// The write order that makes an interrupted operation safe to rerun: an intent
// record (`pending`) before any skill file changes, SKILL.md deleted first and
// written last, and the final state write last.
function orderProblems(text) {
  const section = (name) => flat(text.split(/\n(?=## )/).find((s) => s.startsWith(`## ${name}\n`)) ?? '');
  const problems = [];
  const enable = section('Enable');
  if (!inOrder(enable, [/\*\*write the state file first\*\*, as an intent record/, /a `pending` entry for every file to write or replace/,
    /with \*\*`SKILL\.md` last\*\*/, /Then write the state file again, last: [^.]*no `pending`/])) {
    problems.push('Enable: intent record first, SKILL.md last, final state file last');
  }
  if (!/If any file is to be replaced or deleted, `SKILL\.md` is also to write: it is deleted first and written last/.test(enable)) {
    problems.push('Enable: SKILL.md deleted before any replacement');
  }
  const update = section('Update');
  if (!inOrder(update, [/write the state file first, as an intent record: in `files`, each present kit-owned file's verified hash; a `pending` entry for every file to write/,
    /if any file is to be written or deleted, delete `SKILL\.md` first/, /write and delete the other planned files/,
    /write `SKILL\.md` last/, /then write the state file again, last: [^.]*no `pending`/])) {
    problems.push('Update: intent record first, SKILL.md first and last, state file last');
  }
  if (!/On any conflict write nothing at all/.test(update)) problems.push('Update: all or nothing');
  if (!/recorded but absent → to write if it has a `pending` entry[^.]*\. Otherwise it is a conflict/.test(update)) {
    problems.push('Update: a deleted file is a conflict unless an unfinished operation planned it');
  }
  const disable = section('Disable');
  if (!/Delete `SKILL\.md` first, if it is kit-owned/.test(disable)) problems.push('Disable: SKILL.md deleted first');
  if (!/its bytes hash to its `files` or `pending` entry/.test(disable)) problems.push('Disable: removes what an unfinished operation wrote');
  if (!/A temporary name never ends in `SKILL\.md`/.test(section('Writing a file'))) problems.push('temporary names never load');
  return problems;
}

test('M4-T3 recovery order: an intent record first, SKILL.md last and the final state last at Enable and Update; mutations fail', () => {
  assert.deepEqual(orderProblems(doc), []);
  assert.deepEqual(orderProblems(mutate(doc, ' If any file is to be replaced or deleted, `SKILL.md` is also to write: it is deleted first and written last.')),
    ['Enable: SKILL.md deleted before any replacement']);
  assert.deepEqual(orderProblems(mutate(doc, '   - a `pending` entry for every file to write or replace;\n')),
    ['Enable: intent record first, SKILL.md last, final state file last']);
  const skillLine = "   - write `SKILL.md` last, as the library's LF bytes;\n";
  const stateLine = '   - then write the state file again, last: each file\'s verified hash in `files`, no `pending`, and dropped records removed.\n';
  assert.deepEqual(orderProblems(mutate(doc, skillLine + stateLine, stateLine + skillLine)),
    ['Update: intent record first, SKILL.md first and last, state file last'], 'swapped lines fail, not only missing ones');
  assert.deepEqual(orderProblems(mutate(doc, "   - write the state file first, as an intent record: in `files`, each present kit-owned file's verified hash; a `pending` entry for every file to write; and the new `library` digest;\n")),
    ['Update: intent record first, SKILL.md first and last, state file last'], 'Update without an intent record fails');
  assert.deepEqual(orderProblems(mutate(doc, 'On any conflict write nothing at all', 'On a conflict skip that file')), ['Update: all or nothing']);
  assert.deepEqual(orderProblems(mutate(doc, /recorded but absent → to write if it has a `pending` entry[^\n]*/, 'recorded but absent → to write;')),
    ['Update: a deleted file is a conflict unless an unfinished operation planned it']);
  assert.deepEqual(orderProblems(mutate(doc, 'its bytes hash to its `files` or `pending` entry', 'its bytes hash to its `files` entry')),
    ['Disable: removes what an unfinished operation wrote']);
});

// Ownership is byte-exact: no normalization, and any other bytes are preserved.
function ownershipProblems(text) {
  const problems = [];
  if (!/A file is kit-owned only while it is present and the sha256 of its exact bytes equals its `files` entry or its `pending` entry\. Nothing in the project is normalized before hashing\./.test(text)) {
    problems.push('ownership is not byte-exact');
  }
  if (!/That includes a line-ending-only change, an added or removed final newline, and a file present without a record\. Such a file is reported as a conflict and never overwritten, deleted or re-recorded\./.test(text)) {
    problems.push('a line-ending change is not a preserved modification');
  }
  for (const [, phrase] of text.matchAll(/(canonically (?:equal|match\w*)|library-equal)/g)) problems.push(`normalized comparison: ${phrase}`);
  // Found by the M4-T3 manual pass: a locale sort gave a different library digest.
  if (!/sorted by path in byte order \(as `LC_ALL=C sort` does[^)]*\) and joined with LF, with no final newline/.test(text)) problems.push('library digest order unspecified');
  if (!/Whether the state changed is judged by its parsed content, never by its JSON formatting\./.test(text)) problems.push('no-op judged by formatting');
  return problems;
}

test('M4-T3 ownership: byte-exact hashes only; a normalized comparison or an adopted line-ending change fails', () => {
  assert.deepEqual(ownershipProblems(doc), []);
  assert.deepEqual(ownershipProblems(mutate(doc, '   - kit-owned and already the library\'s bytes → keep;', '   - canonically equal to the library copy → keep;')),
    ['normalized comparison: canonically equal']);
  assert.deepEqual(ownershipProblems(mutate(doc, ' Nothing in the project is normalized before hashing.', ' Line endings are normalized before hashing.')),
    ['ownership is not byte-exact']);
  assert.deepEqual(ownershipProblems(mutate(doc, 'a line-ending-only change, ', '')), ['a line-ending change is not a preserved modification']);
  assert.deepEqual(ownershipProblems(mutate(doc, /sorted by path in byte order \([^)]*\) and joined with LF, with no final newline/, 'sorted by path and joined with LF')),
    ['library digest order unspecified']);
  assert.deepEqual(ownershipProblems(mutate(doc, ' Whether the state changed is judged by its parsed content, never by its JSON formatting.')), ['no-op judged by formatting']);
});

// M4-T3 observed that a running session keeps a cached skill for seconds after
// SKILL.md is deleted, so Update and Disable must not rely on the deletion alone.
function sessionProblems(text) {
  const section = (name) => flat(text.split(/\n(?=## )/).find((s) => s.startsWith(`## ${name}\n`)) ?? '');
  const problems = [];
  if (!/\*\*Close every other Claude Code session in the project first\*\*/.test(section('Update'))) problems.push('Update: other sessions may stay open');
  if (!/Close every other Claude Code session in the project first/.test(section('Disable'))) problems.push('Disable: other sessions may stay open');
  if (!/A \*\*running\*\* session does not drop it at once/.test(section('Interruption and recovery'))) problems.push('claims a running session drops the skill at once');
  if (/stops offering it at its next turn|picks it up at its next turn/.test(text)) problems.push('claims next-turn reload');
  return problems;
}

test('M4-T3 sessions: deleting SKILL.md is not trusted to stop a running session; mutations fail', () => {
  assert.deepEqual(sessionProblems(doc), []);
  assert.deepEqual(sessionProblems(mutate(doc, ' Close every other Claude Code session in the project first, as for Update.')), ['Disable: other sessions may stay open']);
  assert.deepEqual(sessionProblems(mutate(doc, /A \*\*running\*\* session does not drop it at once:[^\n]*?Interactive sessions were not observed\./, 'A running headless session stops offering it at its next turn.')),
    ['claims a running session drops the skill at once', 'claims next-turn reload']);
});

// The optional exclude names only this integration's own paths (M4 owner decision 4).
const OWN_PATHS = ['/.nth-review/', '/.claude/skills/nth-review/', '/.claude/nth-dev-kit-hooks/review.state.json'];

function gitProblems(text) {
  const bullet = /\n- \*\*Optional local exclude \(manual\)\.\*\*[\s\S]*?(?=\n- \*\*)/.exec(text)?.[0];
  const block = bullet && /```\n([\s\S]*?)\n\s*```/.exec(bullet);
  if (!block) return ['no optional exclude block'];
  const lines = block[1].split('\n').map((line) => line.trim());
  const problems = lines.filter((line) => !OWN_PATHS.includes(line)).map((line) => `not an own path: ${line}`);
  for (const own of OWN_PATHS.filter((p) => !lines.includes(p))) problems.push(`missing ${own}`);
  if (/recommend|should add|must add/i.test(bullet)) problems.push('the exclude is presented as recommended');
  if (!/The owner may add exactly these lines/.test(bullet)) problems.push('the exclude is not optional');
  if (!/nth-review never edits `\.gitignore` or `info\/exclude`/.test(bullet)) problems.push('nth-review may edit exclude files');
  if (!/Report:[\s\S]*?- the optional local exclude \(see Git\)\./.test(text)) problems.push('Enable reports the exclude as more than optional');
  if (!/The only Git commands are `rev-parse` and `ls-files`, which never write\. Never run `git status` here/.test(text)) problems.push('a Git command that can write the index');
  if (/read-only Git commands only \([^)]*`status`/i.test(text)) problems.push('git status listed as read-only');
  if (!/Only Git's own "not a git repository" answer means that\. Any other failure of `rev-parse` or `ls-files`[^.]*is a conflict/.test(text)) {
    problems.push('a Git failure skips the tracked check');
  }
  if (!/Tracked copies are not supported in v1\.\*\* A target that Git already tracks is a conflict/.test(text)) problems.push('tracked copies');
  if (!/Nothing changes the index or the working tree to resolve it/.test(text)) problems.push('index untouched on conflict');
  if (!/Tracked files elsewhere in `\.claude\/`, such as a team's `settings\.json` or other skills, are user-owned and never block it/.test(text)) {
    problems.push('tracked user files elsewhere in .claude block Enable');
  }
  return problems;
}

test('M4-T2 Git: the exclude is optional and manual, names only own paths, and tracked copies are refused; mutations fail', () => {
  assert.deepEqual(gitProblems(doc), []);
  assert.deepEqual(gitProblems(mutate(doc, '/.claude/nth-dev-kit-hooks/review.state.json\n', '/.claude/nth-dev-kit-hooks/\n')),
    ['not an own path: /.claude/nth-dev-kit-hooks/', 'missing /.claude/nth-dev-kit-hooks/review.state.json']);
  assert.deepEqual(gitProblems(mutate(doc, '  /.nth-review/\n', '  /.nth-review/\n  /.claude/\n')), ['not an own path: /.claude/']);
  assert.deepEqual(gitProblems(mutate(doc, 'The owner may add exactly these lines', 'The owner should add exactly these lines')),
    ['the exclude is presented as recommended', 'the exclude is not optional']);
  assert.deepEqual(gitProblems(mutate(doc, 'the optional local exclude (see Git)', 'the recommended local exclude')), ['Enable reports the exclude as more than optional']);
  assert.deepEqual(gitProblems(mutate(doc, 'Tracked copies are not supported in v1.** A target that Git already tracks is a conflict', 'Tracked copies are adopted.** A target that Git already tracks is kept')), ['tracked copies']);
  assert.deepEqual(gitProblems(mutate(doc, /The only Git commands are[^\n]*?\(observed in M4-T3\)\./, 'Read-only Git commands only (`rev-parse`, `ls-files`, `status`).')),
    ['a Git command that can write the index', 'git status listed as read-only']);
  assert.deepEqual(gitProblems(mutate(doc, / Only Git's own "not a git repository" answer means that\.[^\n]*?the tracked check could not run\./)),
    ['a Git failure skips the tracked check'], 'found in M4-T3: any rev-parse failure used to count as "no work tree"');
  assert.deepEqual(gitProblems(mutate(doc, / Tracked files elsewhere in `\.claude\/`[^;]*never block it/)), ['tracked user files elsewhere in .claude block Enable']);
});
