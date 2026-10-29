// `fresh` (M2-T4): history outcomes, changed files and obligation classes of
// an Incremental run against its base, on disposable multi-repository
// projects (a root repository with a nested `api` repository). Each test
// builds a base task run with real footprint identities, changes the tree,
// opens an incremental run on it and runs `fresh`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { freshRun, parseHunks, touches } from '../scripts/lib/fresh.mjs';
import {
  addThenDelete, commitOnTop, diverge, insertAfter, numbered, removeLines, replaceLine, rewriteHead,
} from './helpers/history.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, closeRun, nthr, readRecords, recordsFile, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const NS = 'experiments/fresh';

// A root repository holding `files` (plus src/a.js), and a nested `api`. The
// root ignores its nested repositories, as a real project would (otherwise
// `git add -A` would record them as embedded gitlinks).
function project(t, files = {}, { api = { 'x.js': numbered(10, 'x') } } = {}) {
  const base = makeTempDir(t);
  const root = fs.realpathSync.native(makeRepo(path.join(base, 'p'), {
    '.gitignore': 'api/\nweb/\n', 'src/a.js': numbered(30, 'a'), ...files,
  }));
  if (api) makeRepo(path.join(root, 'api'), api);
  return root;
}

const ob = (id, { evidence = [], deps = [], intent = [] } = {}) => ({
  id, checks: ['FRESH'], claim: `${id} claim`, scope: 'scope', acceptance: 'acceptance',
  coverage: 'named-subset', coverage_method: 'read', status: 'held', open_reason: null, source_trace: 'consistent',
  evidence: evidence.map((anchor) => ({ anchor, note: 'evidence' })), intent,
  assumptions: deps.map((anchor) => ({ kind: 'dependency', anchor, fact: null, observed: null, note: 'helper' })), links: [],
});

// A closed base task run citing `obligations`, with its real footprint.
function closedBase(root, obligations, { intent = [], edit, findings = [] } = {}) {
  const opened = nthr(['new-run', '--ns', NS, '--mode', 'task', '--slug', 'base', '--change', '.'], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.scope.intent = intent;
  doc.obligations = obligations;
  doc.findings = findings;
  writeRecords(root, runDir, doc);
  const fp = nthr(['footprint', '--run', runDir], { cwd: root });
  assert.equal(fp.code, EXIT.OK, JSON.stringify(fp.json));
  closeRun(root, runDir, { edit });
  return doc.run.id;
}

function incremental(root, baseId, { slug = 'inc', now = at(2) } = {}) {
  const opened = nthr(['new-run', '--ns', NS, '--mode', 'incremental', '--slug', slug, '--base', baseId], { cwd: root, now });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  return opened.json.result.run_dir;
}

const fresh = (root, runDir) => nthr(['fresh', '--run', runDir], { cwd: root });
function freshness(root, runDir) {
  const r = fresh(root, runDir);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  return readRecords(root, runDir).freshness;
}
const classes = (f) => Object.fromEntries(f.obligations.map((o) => [o.id, o.class]));
const changes = (f) => Object.fromEntries(f.changed_files.map((c) => [c.path, c.from ? `${c.change} from ${c.from}` : c.change]));
const outcomes = (f) => Object.fromEntries(f.repos.map((r) => [r.path, r.outcome]));
const reason = (f, id) => f.obligations.find((o) => o.id === id).reason;

// Every file under `root` (Git metadata included): path, size, mtime, digest.
function treeState(root, except) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => file !== except)
    .map((file) => {
      const stats = fs.statSync(file);
      return `${path.relative(root, file)} ${stats.size} ${stats.mtimeMs} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    })
    .sort();
}

test('golden: direct and indirect changes, negative controls, every change kind, two repositories', (t) => {
  const root = project(t, {
    'src/endpoint.js': numbered(6, 'e'), 'src/guard.js': numbered(10, 'g'), 'src/stable.js': numbered(5, 's'),
    'src/old.js': numbered(5, 'o'), 'src/gone.js': numbered(5, 'd'), 'src/other.js': numbered(5, 't'),
    'docs/spec.md': '# Spec\n\n## Rules\n\nrule\n', 'docs/notes.md': 'notes\n',
  });
  const baseId = closedBase(root, [
    ob('OB-1', { evidence: ['src/a.js:10-12'] }), // direct
    ob('OB-2', { evidence: ['src/endpoint.js:1-3'], deps: ['src/guard.js:2-3'] }), // indirect: the endpoint never changes
    ob('OB-3', { evidence: ['src/endpoint.js:4-6'], deps: ['src/guard.js:9'] }), // indirect, outside the cited lines
    ob('OB-4', { evidence: ['src/stable.js:1-5'] }), // control: unchanged
    ob('OB-5', { evidence: ['src/a.js:20-21'] }), // control: same file, far from the change
    ob('OB-6', { evidence: ['src/old.js:2'] }),
    ob('OB-7', { evidence: ['src/gone.js:1'] }),
    ob('OB-8', { evidence: ['api/x.js:5'] }), // the other repository, unchanged
    ob('OB-9', { evidence: ['src/stable.js:1'], intent: ['I1'] }),
  ], { intent: [{ id: 'I1', anchor: 'docs/spec.md#Rules', note: 'rules' }] });

  // Committed: an ancestor history.
  replaceLine(root, 'src/a.js', 11, 'a 11 changed');
  replaceLine(root, 'src/guard.js', 3, 'g 3 changed');
  rawGit(root, ['mv', 'src/old.js', 'src/new.js']);
  fs.rmSync(path.join(root, 'src', 'gone.js'));
  write(root, 'docs/spec.md', '# Spec\n\n## Rules\n\nrule\nrule two\n');
  write(root, 'src/added.js', 'added\n');
  commitAll(root, 'change');
  addThenDelete(root, 'src/t.js');
  addThenDelete(root, 'src/t2.js');
  commitOnTop(root, { 'src/t2.js': 'back\n' }); // re-added: present at the end, so not transient
  // Staged, unstaged and untracked.
  replaceLine(root, 'src/other.js', 2, 't 2 staged');
  rawGit(root, ['add', 'src/other.js']);
  write(root, 'docs/notes.md', 'notes changed\n');
  write(root, 'scratch.txt', 'scratch\n');

  const inc = incremental(root, baseId);
  const before = treeState(root, recordsFile(root, inc));
  const r = fresh(root, inc);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  assert.deepEqual(treeState(root, recordsFile(root, inc)), before, 'only the run records change; Git metadata included');
  const f = readRecords(root, inc).freshness;
  assert.deepEqual(f, {
    base_run: baseId,
    repos: [{ path: '.', outcome: 'ancestor' }, { path: 'api', outcome: 'equal' }],
    changed_files: [
      { path: 'docs/notes.md', change: 'modified', from: null },
      { path: 'docs/spec.md', change: 'modified', from: null },
      { path: 'scratch.txt', change: 'untracked', from: null },
      { path: 'src/a.js', change: 'modified', from: null },
      { path: 'src/added.js', change: 'added', from: null },
      { path: 'src/gone.js', change: 'deleted', from: null },
      { path: 'src/guard.js', change: 'modified', from: null },
      { path: 'src/new.js', change: 'renamed', from: 'src/old.js' },
      { path: 'src/other.js', change: 'modified', from: null },
      { path: 'src/t.js', change: 'transient', from: null },
      { path: 'src/t2.js', change: 'added', from: null },
    ],
    obligations: [
      { id: 'OB-1', class: 'touched', reason: 'evidence src/a.js:10-12: base lines 10-12 changed (hunk 11)' },
      { id: 'OB-2', class: 'touched', reason: 'dependency src/guard.js:2-3: base lines 2-3 changed (hunk 3)' },
      { id: 'OB-3', class: 'file-changed', reason: 'dependency src/guard.js:9: changed at base lines 3; none within 3 lines of 9-9' },
      { id: 'OB-4', class: 'current', reason: '1 cited file unchanged' },
      { id: 'OB-5', class: 'file-changed', reason: 'evidence src/a.js:20-21: changed at base lines 11; none within 3 lines of 20-21' },
      { id: 'OB-6', class: 'touched', reason: 'evidence src/old.js:2: renamed to src/new.js' },
      { id: 'OB-7', class: 'touched', reason: 'evidence src/gone.js:1: deleted' },
      { id: 'OB-8', class: 'current', reason: '1 cited file unchanged' },
      { id: 'OB-9', class: 'touched', reason: 'intent docs/spec.md#Rules: heading anchor; content changed' },
    ],
  });
  assert.deepEqual(r.json.result.obligations, {
    touched: ['OB-1', 'OB-2', 'OB-6', 'OB-7', 'OB-9'], 'file-changed': ['OB-3', 'OB-5'], 'assumption-changed': [], current: 2,
  });
  assert.deepEqual(r.json.result.repos, [{ path: '.', outcome: 'ancestor', detail: 'history ancestor' }, { path: 'api', outcome: 'equal', detail: 'history equal' }]);
  assert.equal(r.json.result.changed_files.total, 11);

  // Deterministic: a second run writes the same bytes. Every git call is
  // allowlisted, read-only and runs no external program.
  const records = fs.readFileSync(recordsFile(root, inc));
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push(args);
    return spawnSync(cmd, args, options);
  };
  assert.deepEqual(freshRun(root, NS, inc.split('/').at(-1), { gitOptions: { spawn } }).errors, []);
  assert.ok(fs.readFileSync(recordsFile(root, inc)).equals(records), 'idempotent');
  // After the 28 global arguments come `-c` pairs disabling filter drivers, then the subcommand.
  const subcommandOf = (args) => args.find((a, i) => i >= 28 && a !== '-c' && args[i - 1] !== '-c');
  const allowed = ['config', 'version', 'rev-parse', 'status', 'ls-files', 'check-attr', 'hash-object', 'cat-file', 'merge-base', 'diff', 'log'];
  const used = new Set();
  for (const args of calls) {
    const sub = subcommandOf(args);
    used.add(sub);
    assert.ok(allowed.includes(sub), sub);
    assert.ok(args.includes('log.showSignature=false') && args.includes('diff.algorithm=myers'), 'global pins on every call');
    if (sub === 'diff' || sub === 'log') assert.ok(args.includes('--no-ext-diff') && args.includes('--no-textconv'), args.join(' '));
    if (sub === 'hash-object') assert.ok(!args.includes('-w'));
  }
  for (const sub of ['diff', 'log', 'cat-file', 'merge-base', 'status', 'hash-object']) assert.ok(used.has(sub), `fresh used ${sub}`);
});

test('unchanged history and a clean tree: every repository equal, nothing changed, everything current', (t) => {
  const root = project(t);
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:1-2'] }), ob('OB-2', { evidence: ['api/x.js'] })]);
  const inc = incremental(root, baseId);
  const f = freshness(root, inc);
  assert.deepEqual(f.repos, [{ path: '.', outcome: 'equal' }, { path: 'api', outcome: 'equal' }]);
  assert.deepEqual(f.changed_files, []);
  assert.deepEqual(f.obligations, [
    { id: 'OB-1', class: 'current', reason: '1 cited file unchanged' },
    { id: 'OB-2', class: 'current', reason: '1 cited file unchanged' },
  ]);
});

test('the 3-line margin: edits, insertions and deletions at the boundary; whitespace counts; committed and working-tree content', (t) => {
  const names = ['e25', 'e26', 'e17', 'e16', 'i25', 'i26', 'i16', 'i15', 'd25', 'd26', 'ws', 'wt30', 'wt23'];
  const root = project(t, Object.fromEntries(names.map((n) => [`b/${n}.js`, numbered(40, n)])));
  const baseId = closedBase(root, names.map((n) => ob(n.toUpperCase(), { evidence: [`b/${n}.js:20-22`] })));
  // Committed (compared blob to blob): cited lines 20-22, margin 17-25.
  replaceLine(root, 'b/e25.js', 25, 'edited');
  replaceLine(root, 'b/e26.js', 26, 'edited');
  replaceLine(root, 'b/e17.js', 17, 'edited');
  replaceLine(root, 'b/e16.js', 16, 'edited');
  insertAfter(root, 'b/i25.js', 25, 'inserted');
  insertAfter(root, 'b/i26.js', 26, 'inserted');
  insertAfter(root, 'b/i16.js', 16, 'inserted'); // next to line 17
  insertAfter(root, 'b/i15.js', 15, 'inserted');
  removeLines(root, 'b/d25.js', 25);
  removeLines(root, 'b/d26.js', 26, 2);
  commitAll(root, 'boundaries');
  // Working tree only (compared with the base commit's file).
  replaceLine(root, 'b/ws.js', 21, 'ws 21 '); // whitespace only
  replaceLine(root, 'b/wt30.js', 30, 'edited');
  replaceLine(root, 'b/wt23.js', 23, 'edited');
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(classes(f), {
    E25: 'touched', E26: 'file-changed', E17: 'touched', E16: 'file-changed',
    I25: 'touched', I26: 'file-changed', I16: 'touched', I15: 'file-changed',
    D25: 'touched', D26: 'file-changed', WS: 'touched', WT30: 'file-changed', WT23: 'touched',
  });
  assert.equal(reason(f, 'I25'), 'evidence b/i25.js:20-22: base lines 20-22 changed (hunk insertion after 25)');
  assert.equal(reason(f, 'D26'), 'evidence b/d26.js:20-22: changed at base lines 26-27; none within 3 lines of 20-22');
  assert.equal(reason(f, 'WS'), 'evidence b/ws.js:20-22: base lines 20-22 changed (hunk 21)');
});

test('hunk parsing and the margin rule', () => {
  assert.deepEqual(parseHunks('@@ -2 +2 @@ one\n-a\n+b\n@@ -3,0 +4 @@\n+c\n@@ -7,2 +8,0 @@\n'), {
    hunks: [{ start: 2, count: 1 }, { start: 3, count: 0 }, { start: 7, count: 2 }],
  });
  assert.deepEqual(parseHunks('Binary files a/x and b/x differ\n'), { why: 'binary content changed' });
  assert.deepEqual(parseHunks('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n'), { why: 'content differs but no hunk was located' });
  assert.equal(touches({ start: 0, count: 0 }, 1, 1), true, 'an insertion at the top touches line 1');
  assert.equal(touches({ start: 0, count: 0 }, 5, 5), false);
  assert.equal(touches({ start: 1, count: 0 }, 5, 5), true, 'between lines 1 and 2: next to line 2, within 3 of line 5');
});

test('staged, unstaged and untracked files; intent-to-add; a staged rename deleted from the working tree', (t) => {
  const files = Object.fromEntries(['s1', 's2', 'r1', 'cached', 'wdel'].map((n) => [`${n}.js`, numbered(5, n)]));
  const root = project(t, files);
  const baseId = closedBase(root, [ob('OB-S1', { evidence: ['s1.js:1'] }), ob('OB-S2', { evidence: ['s2.js:1'] }), ob('OB-R', { evidence: ['r1.js:1'] })]);
  replaceLine(root, 's1.js', 1, 'staged');
  rawGit(root, ['add', 's1.js']); // staged: its blob is in the object database
  replaceLine(root, 's2.js', 1, 'unstaged'); // working tree only
  write(root, 'new.txt', 'new\n');
  write(root, 'ita.js', 'intent\n');
  rawGit(root, ['add', '-N', 'ita.js']);
  rawGit(root, ['mv', 'r1.js', 'r2.js']);
  fs.rmSync(path.join(root, 'r2.js'));
  write(root, 'staged-new.js', 'gone again\n');
  rawGit(root, ['add', 'staged-new.js']);
  fs.rmSync(path.join(root, 'staged-new.js')); // absent at both ends: not a change
  rawGit(root, ['rm', '-q', '--cached', 'cached.js']); // still on disk, now untracked
  fs.rmSync(path.join(root, 'wdel.js'));
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(changes(f), {
    'cached.js': 'untracked', 'ita.js': 'added', 'new.txt': 'untracked', 'r1.js': 'deleted',
    's1.js': 'modified', 's2.js': 'modified', 'wdel.js': 'deleted',
  });
  assert.deepEqual(outcomes(f), { '.': 'equal', api: 'equal' });
  assert.deepEqual(classes(f), { 'OB-S1': 'touched', 'OB-S2': 'touched', 'OB-R': 'touched' });
  assert.equal(reason(f, 'OB-R'), 'evidence r1.js:1: deleted');
});

test('files Git is told not to look at (assume-unchanged, skip-worktree) are compared by hash, not trusted', (t) => {
  const root = project(t, { 'au.js': numbered(5, 'au'), 'sw.js': numbered(5, 'sw'), 'sparse.js': numbered(5, 'sp'), 'quiet.js': numbered(5, 'q') });
  const baseId = closedBase(root, [ob('OB-AU', { evidence: ['au.js:1'] }), ob('OB-Q', { evidence: ['quiet.js:1'] })]);
  rawGit(root, ['update-index', '--assume-unchanged', 'au.js', 'quiet.js']);
  rawGit(root, ['update-index', '--skip-worktree', 'sw.js', 'sparse.js']);
  replaceLine(root, 'au.js', 1, 'hidden edit');
  replaceLine(root, 'sw.js', 1, 'hidden edit');
  fs.rmSync(path.join(root, 'sparse.js')); // as a sparse checkout leaves it: not a change
  assert.equal(rawGit(root, ['status', '--porcelain', '--', 'au.js', 'sw.js', 'sparse.js', 'quiet.js']).trim(), '', 'control: git status shows none of it');
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(changes(f), { 'au.js': 'modified', 'sw.js': 'modified' });
  assert.deepEqual(classes(f), { 'OB-AU': 'touched', 'OB-Q': 'current' });
});

test('a base whose working tree held a flagged file is base-dirty: its commit cannot reproduce what was reviewed', (t) => {
  const root = project(t, { 'h.js': numbered(5, 'h') });
  rawGit(root, ['update-index', '--assume-unchanged', 'h.js']);
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:1'] })]);
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(outcomes(f), { '.': 'base-dirty', api: 'equal' });
  assert.deepEqual(classes(f), { 'OB-1': 'current' });
});

test('the integration\'s untracked installed files are never changed files and never make the base dirty (root repository only)', (t) => {
  const root = project(t);
  write(root, '.claude/skills/nth-review/SKILL.md', 'skill\n');
  write(root, '.claude/nth-dev-kit-hooks/review.state.json', '{}\n');
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:1'] })]);
  write(root, '.claude/skills/nth-review/SKILL.md', 'updated skill\n');
  write(root, '.claude/skills/nth-review/reference/protocol.md', 'protocol\n');
  write(root, '.claude/settings.json', '{}\n');
  write(path.join(root, 'api'), '.claude/skills/nth-review/SKILL.md', 'skill\n');
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(outcomes(f), { '.': 'equal', api: 'equal' });
  assert.deepEqual(changes(f), { '.claude/settings.json': 'untracked', 'api/.claude/skills/nth-review/SKILL.md': 'untracked' });
  assert.deepEqual(classes(f), { 'OB-1': 'current' });
});

test('diverged history: still classified by content', (t) => {
  const root = project(t);
  commitOnTop(root, { 'src/b.js': numbered(5, 'b') });
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:5'] }), ob('OB-2', { evidence: ['src/b.js:1'] }), ob('OB-3', { evidence: ['src/a.js:25'] })]);
  diverge(root, {}); // from HEAD~1: src/b.js is not there
  replaceLine(root, 'src/a.js', 5, 'diverged');
  commitAll(root, 'diverged edit');
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(outcomes(f), { '.': 'diverged', api: 'equal' });
  assert.deepEqual(changes(f), { 'src/a.js': 'modified', 'src/b.js': 'deleted' });
  assert.deepEqual(classes(f), { 'OB-1': 'touched', 'OB-2': 'touched', 'OB-3': 'file-changed' });
});

test('rewritten history (amend + gc): base-missing; every anchor in that repository is touched; its files are listed', (t) => {
  const root = project(t, { 'src/b.js': numbered(5, 'b') });
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:1'] }), ob('OB-2', { evidence: ['api/x.js:1'] })]);
  rewriteHead(root);
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(outcomes(f), { '.': 'base-missing', api: 'equal' });
  assert.deepEqual(changes(f), { '.gitignore': 'added', 'src/a.js': 'added', 'src/b.js': 'added' });
  assert.deepEqual(f.obligations, [
    { id: 'OB-1', class: 'touched', reason: 'evidence src/a.js:1: history base-missing in .' },
    { id: 'OB-2', class: 'current', reason: '1 cited file unchanged' },
  ]);
});

test('dirty base: the blob identity decides when it can; base content that Git never stored is touched', (t) => {
  const root = project(t, { 'd1.js': numbered(10, 'd1'), 'd2.js': numbered(10, 'd2'), 'd3.js': numbered(10, 'd3') });
  for (const n of ['d1', 'd2', 'd3']) replaceLine(root, `${n}.js`, 1, `${n} dirty at base`);
  const baseId = closedBase(root, [
    ob('OB-1', { evidence: ['d1.js:5'] }), ob('OB-2', { evidence: ['d2.js:5'] }), ob('OB-3', { evidence: ['d3.js:5'] }), ob('OB-4', { evidence: ['src/a.js:1'] }),
  ]);
  rawGit(root, ['add', 'd1.js']);
  rawGit(root, ['commit', '-q', '-m', 'commit d1 as it was at base']);
  replaceLine(root, 'd2.js', 9, 'changed again');
  rawGit(root, ['checkout', '--', 'd3.js']); // restored to the commit: Git shows no change
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(outcomes(f), { '.': 'base-dirty', api: 'equal' });
  assert.deepEqual(changes(f), { 'd1.js': 'modified', 'd2.js': 'modified', 'd3.js': 'modified' });
  assert.deepEqual(classes(f), { 'OB-1': 'current', 'OB-2': 'touched', 'OB-3': 'touched', 'OB-4': 'current' });
  assert.equal(reason(f, 'OB-2'), 'evidence d2.js:5: base content unavailable (dirty at base, not in the object database)');
});

test('unverified identities are never current: a filter now, a secret, a base source-changed entry', (t) => {
  const root = project(t, { 'f.flt': numbered(5, 'f'), 'config/secrets.json': '{}\n' });
  const baseId = closedBase(root, [
    ob('OB-F', { evidence: ['f.flt:1'] }), ob('OB-S', { evidence: ['config/secrets.json:1'] }), ob('OB-C', { evidence: ['src/a.js:1'] }), ob('OB-OK', { evidence: ['api/x.js:1'] }),
  ], { edit: (doc) => { doc.footprint['src/a.js'] = { blob: null, state: 'unverified', reason: 'source-changed' }; } });
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), '*.flt filter=custom\n');
  rawGit(root, ['config', 'filter.custom.clean', 'cat']);
  const f = freshness(root, incremental(root, baseId));
  assert.deepEqual(f.obligations, [
    { id: 'OB-F', class: 'touched', reason: 'evidence f.flt:1: target identity unverified (filter)' },
    { id: 'OB-S', class: 'touched', reason: 'evidence config/secrets.json:1: base identity unverified (secret)' },
    { id: 'OB-C', class: 'touched', reason: 'evidence src/a.js:1: base identity unverified (source-changed)' },
    { id: 'OB-OK', class: 'current', reason: '1 cited file unchanged' },
  ]);
});

test('binary content, a mode-only change, and repositories added and removed', (t) => {
  const root = project(t, { 'img.bin': Buffer.from([0, 1, 2, 3, 0, 5]), 'm.js': numbered(5, 'm') });
  const baseId = closedBase(root, [
    ob('OB-B', { evidence: ['img.bin:1'] }), ob('OB-M', { evidence: ['m.js:1'] }), ob('OB-API', { evidence: ['api/x.js:1'] }),
  ]);
  write(root, 'img.bin', Buffer.from([0, 9, 9, 9, 0, 5]));
  rawGit(root, ['add', 'img.bin']);
  rawGit(root, ['update-index', '--chmod=+x', 'm.js']); // works where core.fileMode is false
  rawGit(root, ['commit', '-q', '-m', 'binary and mode']);
  fs.rmSync(path.join(root, 'api'), { recursive: true, force: true });
  makeRepo(path.join(root, 'web'), { 'w.js': 'web\n' });
  const inc = incremental(root, baseId);
  const r = fresh(root, inc);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const f = readRecords(root, inc).freshness;
  assert.deepEqual(outcomes(f), { '.': 'ancestor', api: 'base-missing', web: 'base-missing' });
  assert.deepEqual(changes(f), { 'img.bin': 'modified', 'm.js': 'modified', 'web/w.js': 'added' });
  assert.deepEqual(f.obligations, [
    { id: 'OB-B', class: 'touched', reason: 'evidence img.bin:1: binary content changed' },
    { id: 'OB-M', class: 'file-changed', reason: 'evidence m.js:1: content unchanged; mode or type changed' },
    { id: 'OB-API', class: 'touched', reason: 'evidence api/x.js:1: owning repository changed (api -> .)' },
  ]);
  assert.deepEqual(r.json.result.repos.map((x) => x.detail), ['history ancestor', 'repository removed since base', 'repository added since base']);
});

test('refusals change nothing: a closed run, a task run, an unrecordable path, an invalid base, a tracked change since Open', (t) => {
  const root = project(t);
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:1'] })]);
  const refused = (runDir, pattern) => {
    const before = fs.readFileSync(recordsFile(root, runDir));
    const r = fresh(root, runDir);
    assert.equal(r.code, EXIT.USAGE, JSON.stringify(r.json));
    assert.match(r.json.errors[0], pattern);
    assert.ok(fs.readFileSync(recordsFile(root, runDir)).equals(before), 'records unchanged');
  };
  refused(`.nth-review/${NS}/runs/${baseId}`, /is complete; only an open run gets freshness/);
  const task = nthr(['new-run', '--ns', 'experiments/other', '--mode', 'task', '--slug', 't', '--change', '.'], { cwd: root, now: at(3) });
  refused(task.json.result.run_dir, /is a task run; freshness is only for incremental runs/);

  const inc = incremental(root, baseId);
  write(root, 'odd#name.txt', 'a record cannot name this\n');
  refused(inc, /changed files that a record cannot name .*odd#name\.txt/);
  fs.rmSync(path.join(root, 'odd#name.txt'));

  const doc = readRecords(root, inc);
  writeRecords(root, inc, { ...doc, run: { ...doc.run, base: '20261026-090009-task-nope' } });
  refused(inc, /20261026-090009-task-nope is not a run in experiments\/fresh/);
  writeRecords(root, inc, doc);

  replaceLine(root, 'src/a.js', 2, 'changed after Open');
  refused(inc, /the tracked source changed since Open \(\.\)/);
});

// The incremental run's own records, made check-valid for close: an Opus High
// lead, a census item for every changed file (C11) and the touched OB-1
// re-recorded and reassessed (its evidence recorded again, not copied).
function reviewIncremental(root, runDir) {
  const doc = readRecords(root, runDir);
  doc.scope.summary = 'incremental review';
  doc.run.runtime.lead_model = 'claude-opus-5-5';
  doc.run.runtime.lead_effort = 'high';
  doc.census.items = doc.freshness.changed_files.map((c, i) => ({
    id: `CI-${i + 1}`, path: c.path, mechanism: 'module', status: 'classified', reason: null, affects: ['OB-1'],
  }));
  doc.obligations = [ob('OB-1', { evidence: ['src/a.js:10'] })];
  doc.obligations[0].coverage = 'all-enumerated';
  doc.obligations[0].evidence[0].note = 'reassessed: the changed line still enforces the rule';
  writeRecords(root, runDir, doc);
  return doc;
}

test('close: freshness must match the tree; a hand-edited class is refused; assumption-changed is the lead\'s and is kept', (t) => {
  const root = project(t);
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:10'] }), ob('OB-2', { evidence: ['api/x.js:1'] })]);
  commitOnTop(root, { 'src/b.js': 'new\n' });
  replaceLine(root, 'src/a.js', 10, 'a 10 changed');
  commitAll(root, 'edit');
  const inc = incremental(root, baseId);
  assert.deepEqual(classes(freshness(root, inc)), { 'OB-1': 'touched', 'OB-2': 'current' });
  const reviewed = reviewIncremental(root, inc);
  const close = () => nthr(['close', '--run', inc, '--status', 'complete'], { cwd: root, now: at(30) });

  // A downgrade by hand (touched -> current) is refused, and nothing changes.
  const tampered = structuredClone(reviewed);
  tampered.freshness.obligations[0] = { id: 'OB-1', class: 'current', reason: '1 cited file unchanged' };
  writeRecords(root, inc, tampered);
  const before = fs.readFileSync(recordsFile(root, inc));
  const refused = close();
  assert.equal(refused.code, EXIT.USAGE, JSON.stringify(refused.json));
  assert.match(refused.json.errors[0], /recorded freshness is not the one the tree gives now/);
  assert.ok(fs.readFileSync(recordsFile(root, inc)).equals(before));

  // The lead marks OB-2 assumption-changed (a fact outside Git): fresh keeps it, close accepts it
  // once OB-2 is re-recorded and reassessed in this run.
  const marked = structuredClone(reviewed);
  marked.freshness.obligations[1] = { id: 'OB-2', class: 'assumption-changed', reason: 'the deployment config changed' };
  const reassessed = ob('OB-2', { evidence: ['api/x.js:1'] });
  reassessed.evidence[0].note = 'reassessed against the new deployment config';
  marked.obligations.push(reassessed);
  writeRecords(root, inc, marked);
  assert.deepEqual(fresh(root, inc).json.result.obligations['assumption-changed'], ['OB-2']);
  assert.deepEqual(readRecords(root, inc).freshness.obligations[1], { id: 'OB-2', class: 'assumption-changed', reason: 'the deployment config changed' });
  const closed = close();
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  assert.equal(nthr(['check', '--run', inc], { cwd: root }).code, EXIT.OK);
  // The report shows the freshness table: both base obligations re-recorded.
  const report = fs.readFileSync(path.join(root, ...inc.split('/'), 'report.md'), 'utf8');
  assert.match(report, new RegExp(`^### Freshness against base ${baseId}$`, 'm'));
  assert.match(report, /^\| OB-1 \| touched \| .* \| re-recorded: held \|$/m);
  assert.match(report, /^\| OB-2 \| assumption-changed \| the deployment config changed \| re-recorded: held \|$/m);
});

test('close: a non-current base obligation is never carried forward: dropping it or copying its held evidence is refused', (t) => {
  const root = project(t);
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:10'] }), ob('OB-2', { evidence: ['api/x.js:1'] })]);
  replaceLine(root, 'src/a.js', 10, 'a 10 changed');
  commitAll(root, 'edit');
  const inc = incremental(root, baseId);
  assert.deepEqual(classes(freshness(root, inc)), { 'OB-1': 'touched', 'OB-2': 'current' });
  const reviewed = reviewIncremental(root, inc);
  const attempt = (edit) => {
    const doc = structuredClone(reviewed);
    edit(doc);
    writeRecords(root, inc, doc);
    const before = fs.readFileSync(recordsFile(root, inc));
    const result = nthr(['close', '--run', inc, '--status', 'complete'], { cwd: root, now: at(30) });
    assert.ok(fs.readFileSync(recordsFile(root, inc)).equals(before), 'a refused close writes nothing');
    return result;
  };
  // The touched OB-1 dropped: refused.
  const dropped = attempt((d) => { d.obligations = []; d.census.items.forEach((i) => { i.affects = null; i.reason = 'nothing to reassess'; }); });
  assert.equal(dropped.code, EXIT.INVALID, JSON.stringify(dropped.json));
  assert.ok(dropped.json.errors.some((e) => /\$\.freshness\.obligations\[0\]: base obligation OB-1 is touched; re-record it in this run and reassess it \(C11\)/.test(e)), JSON.stringify(dropped.json.errors));
  // OB-1 held on the base's evidence, copied unchanged: refused.
  const copied = attempt((d) => { d.obligations[0].evidence = [{ anchor: 'src/a.js:10', note: 'evidence' }]; });
  assert.equal(copied.code, EXIT.INVALID, JSON.stringify(copied.json));
  assert.ok(copied.json.errors.some((e) => /OB-1 is touched since the base, yet held on the base's evidence unchanged/.test(e)), JSON.stringify(copied.json.errors));
  // The current OB-2 stays concluded in the base: not re-recording it is fine, and the report says so.
  writeRecords(root, inc, reviewed);
  const closed = nthr(['close', '--run', inc, '--status', 'complete'], { cwd: root, now: at(31) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const report = fs.readFileSync(path.join(root, ...inc.split('/'), 'report.md'), 'utf8');
  assert.match(report, new RegExp(`^\\| OB-2 \\| current \\| .* \\| concluded in ${baseId} \\|$`, 'm'));
});

test('continuing an Incremental run (protocol §11): new-run refuses, resume continues and fresh gives the same classes; after a tracked change the continuation is classified against the same base', (t) => {
  const root = project(t);
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:10'] }), ob('OB-2', { evidence: ['api/x.js:1'] })]);
  replaceLine(root, 'src/a.js', 10, 'a 10 changed');
  commitAll(root, 'edit');
  const inc = incremental(root, baseId);
  const first = classes(freshness(root, inc));
  assert.deepEqual(first, { 'OB-1': 'touched', 'OB-2': 'current' });

  // A later invocation: new-run refuses, resume answers continue and writes nothing, fresh again is stable.
  const again = nthr(['new-run', '--ns', NS, '--mode', 'incremental', '--slug', 'again', '--base', baseId], { cwd: root, now: at(20) });
  assert.equal(again.code, EXIT.USAGE);
  assert.match(again.json.errors[0], /is still open in experiments\/fresh/);
  const bytes = fs.readFileSync(recordsFile(root, inc));
  const resumed = nthr(['resume', '--ns', NS], { cwd: root, now: at(21) });
  assert.equal(resumed.json.result.action, 'continue', JSON.stringify(resumed.json));
  assert.equal(resumed.json.result.run, inc.split('/').pop());
  assert.ok(fs.readFileSync(recordsFile(root, inc)).equals(bytes), 'continue writes nothing');
  assert.deepEqual(classes(freshness(root, inc)), first);

  // The source moves: abandoning needs records that pass check, so a changed file without a census item
  // is refused (exit 1) and nothing changes; with the census recorded, the plan writes nothing and
  // --apply opens the continuation on the same base.
  replaceLine(root, 'src/a.js', 20, 'a 20 changed');
  commitAll(root, 'more');
  const unclassified = fs.readFileSync(recordsFile(root, inc));
  const refusedPlan = nthr(['resume', '--ns', NS], { cwd: root, now: at(22) });
  assert.equal(refusedPlan.code, EXIT.INVALID, JSON.stringify(refusedPlan.json));
  assert.match(refusedPlan.json.errors[0], /src\/a\.js has no census item \(C11\)/);
  assert.ok(fs.readFileSync(recordsFile(root, inc)).equals(unclassified), 'a refused plan writes nothing');
  const doc = readRecords(root, inc);
  doc.census.items = [{ id: 'CI-1', path: 'src/a.js', mechanism: 'module', status: 'unknown', reason: 'not classified before the source moved', affects: null }];
  writeRecords(root, inc, doc);
  const recorded = fs.readFileSync(recordsFile(root, inc));
  const plan = nthr(['resume', '--ns', NS], { cwd: root, now: at(22) });
  assert.equal(plan.code, EXIT.OK, JSON.stringify(plan.json));
  assert.deepEqual([plan.json.result.action, plan.json.result.cause], ['abandon', 'tracked-changed']);
  assert.ok(fs.readFileSync(recordsFile(root, inc)).equals(recorded), 'the plan writes nothing');
  const applied = nthr(['resume', '--ns', NS, '--apply'], { cwd: root, now: at(23) });
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  const cont = applied.json.result.run_dir;
  assert.deepEqual([readRecords(root, cont).run.base, readRecords(root, cont).run.continues], [baseId, inc.split('/').pop()]);
  assert.deepEqual(classes(freshness(root, cont)), { 'OB-1': 'touched', 'OB-2': 'current' }, 'the base obligations, classified again');
  assert.equal(readRecords(root, inc).run.status, 'abandoned', 'the abandoned records stay as history');
});

test('hostile Git configuration changes nothing and runs nothing: external diff, textconv, fsmonitor, signatures, diff options', (t) => {
  const root = project(t, { 'src/guard.js': numbered(10, 'g') });
  const baseId = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:10'], deps: ['src/guard.js:2'] }), ob('OB-2', { evidence: ['src/a.js:28'] })]);
  replaceLine(root, 'src/a.js', 11, 'a 11 changed');
  rawGit(root, ['mv', 'src/guard.js', 'src/guard2.js']);
  commitAll(root, 'change');
  replaceLine(root, 'src/a.js', 26, 'a 26 unstaged');
  const inc = incremental(root, baseId);
  const clean = freshness(root, inc);

  const marker = path.join(path.dirname(root), 'marker.log');
  const script = write(path.dirname(root), 'logger.mjs', "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], `${process.argv[3]}\\n`);\nprocess.stdin.resume();\n");
  const posix = (p) => p.replaceAll('\\', '/');
  const logger = (label) => `node "${posix(script)}" "${posix(marker)}" ${label}`;
  fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), '*.js diff=hostile\n');
  for (const [key, value] of [
    ['diff.external', logger('external')], ['diff.hostile.command', logger('command')], ['diff.hostile.textconv', logger('textconv')],
    ['core.fsmonitor', logger('fsmonitor')], ['log.showSignature', 'true'], ['gpg.program', logger('gpg')],
    ['diff.algorithm', 'patience'], ['diff.renames', 'false'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'],
    ['diff.interHunkContext', '10'], ['color.ui', 'always'],
  ]) rawGit(root, ['config', key, value]);

  const before = treeState(root, recordsFile(root, inc));
  assert.deepEqual(freshness(root, inc), clean, 'the same result under hostile configuration');
  assert.equal(fs.existsSync(marker), false, 'no configured program ran');
  assert.deepEqual(treeState(root, recordsFile(root, inc)), before);
  // Control: the configuration is live, and raw git runs it (the attribute's
  // diff driver takes precedence over diff.external).
  rawGit(root, ['diff', 'HEAD~1', '--', 'src/a.js']);
  assert.deepEqual(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).sort(), ['command', 'fsmonitor']);
});

// ---------------------------------------------------------------- effective baseline (the Incremental chain)

// An obligation re-recorded after reassessment: the same anchors, with notes
// saying what this run re-read.
const again = (id, evidence, run) => {
  const o = ob(id, { evidence });
  for (const e of o.evidence) e.note = `re-read in ${run}`;
  return o;
};
// The open incremental run's records, check-valid for close: an Opus High
// lead, every changed file in the census (affecting the re-recorded
// obligations), and `recorded` as its obligations.
function recordIncremental(root, runDir, recorded) {
  const doc = readRecords(root, runDir);
  doc.scope.summary = 'incremental review';
  doc.run.runtime.lead_model = 'claude-opus-5-5';
  doc.run.runtime.lead_effort = 'high';
  const ids = recorded.map((o) => o.id);
  doc.census.items = doc.freshness.changed_files.map((c, i) => ({
    id: `CI-${i + 1}`, path: c.path, mechanism: 'module', status: 'classified', reason: ids.length ? null : 'no obligation rests on it', affects: ids.length ? ids : null,
  }));
  doc.obligations = recorded;
  writeRecords(root, runDir, doc);
}
const closeAt = (root, runDir, seconds) => nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(seconds) });
const runIdOf = (runDir) => runDir.split('/').pop();
const origins = (f) => f.obligations.map((o) => [o.id, o.class, o.origin ?? null]);
const reportOf = (root, runDir) => fs.readFileSync(path.join(root, ...runDir.split('/'), 'report.md'), 'utf8');

test('the effective baseline: R1 verifies O1-O3, R2 changes only O1, R3 changes O2 and must find and reassess it; O3 stays current against R1', (t) => {
  const root = project(t, { 'src/b.js': numbered(30, 'b'), 'src/guard.js': numbered(10, 'g') });
  const r1 = closedBase(root, [
    ob('OB-1', { evidence: ['src/a.js:5'] }),
    ob('OB-2', { evidence: ['src/b.js:20'] }),
    ob('OB-3', { evidence: ['api/x.js:1'], deps: ['src/guard.js:2'] }),
  ]);

  // R2 (on R1): only OB-1 changes. Every obligation's origin is the base, so none is written.
  replaceLine(root, 'src/a.js', 5, 'a 5 changed');
  commitAll(root, 'r2');
  const r2 = incremental(root, r1, { slug: 'r2', now: at(2) });
  assert.deepEqual(origins(freshness(root, r2)), [['OB-1', 'touched', null], ['OB-2', 'current', null], ['OB-3', 'current', null]]);
  recordIncremental(root, r2, [again('OB-1', ['src/a.js:5'], 'r2')]);
  const closed2 = closeAt(root, r2, 30);
  assert.equal(closed2.code, EXIT.OK, JSON.stringify(closed2.json));
  assert.match(reportOf(root, r2), new RegExp(`^\\| OB-2 \\| current \\| .* \\| concluded in ${r1} \\|$`, 'm'));

  // R3 (on R2): only OB-2 changes. R2 never recorded it; R3 still finds it, compared with R1.
  replaceLine(root, 'src/b.js', 20, 'b 20 changed');
  commitAll(root, 'r3');
  const r3 = incremental(root, runIdOf(r2), { slug: 'r3', now: at(40) });
  const f3 = freshness(root, r3);
  // OB-1 is current only because it is compared with R2 (a.js:5 changed since R1).
  assert.deepEqual(origins(f3), [['OB-1', 'current', null], ['OB-2', 'touched', r1], ['OB-3', 'current', r1]]);
  assert.match(reason(f3, 'OB-2'), new RegExp(`^evidence src/b\\.js:20: origin ${r1} lines 20-20 changed`));
  assert.equal(readRecords(root, r3).budget.obligations_max, 3 + 15, 'the cap covers the whole effective baseline');

  // Closing without reassessing OB-2, or with R1's conclusion copied, is refused, and nothing is written.
  const refusedClose = (recorded, pattern) => {
    recordIncremental(root, r3, recorded);
    const before = fs.readFileSync(recordsFile(root, r3));
    const r = closeAt(root, r3, 50);
    assert.equal(r.code, EXIT.INVALID, JSON.stringify(r.json));
    assert.ok(r.json.errors.some((e) => pattern.test(e)), JSON.stringify(r.json.errors));
    assert.ok(fs.readFileSync(recordsFile(root, r3)).equals(before), 'a refused close writes nothing');
  };
  refusedClose([], new RegExp(`inherited obligation OB-2 \\(last recorded in ${r1}\\) is touched; re-record it in this run and reassess it \\(C11\\)`));
  refusedClose([ob('OB-2', { evidence: ['src/b.js:20'] })], new RegExp(`OB-2 is touched since ${r1}, yet held on ${r1}'s evidence unchanged`));

  // Reassessed: R3 closes; the report names where each current conclusion stands.
  recordIncremental(root, r3, [again('OB-2', ['src/b.js:20'], 'r3')]);
  const closed3 = closeAt(root, r3, 51);
  assert.equal(closed3.code, EXIT.OK, JSON.stringify(closed3.json));
  assert.equal(nthr(['check', '--run', r3], { cwd: root }).code, EXIT.OK);
  const report = reportOf(root, r3);
  assert.match(report, new RegExp(`^\\| OB-1 \\| current \\| .* \\| concluded in ${runIdOf(r2)} \\|$`, 'm'));
  assert.match(report, /^\| OB-2 \| touched \| .* \| re-recorded: held \|$/m);
  assert.match(report, new RegExp(`^\\| OB-3 \\| current \\| .* \\| concluded in ${r1} \\|$`, 'm'));

  // R4 (on R3), nothing changed: each obligation resolves to its latest version across three runs.
  const r4 = incremental(root, runIdOf(r3), { slug: 'r4', now: at(60) });
  assert.deepEqual(origins(freshness(root, r4)), [['OB-2', 'current', null], ['OB-1', 'current', runIdOf(r2)], ['OB-3', 'current', r1]]);
});

test('the effective baseline: dependency and finding changes, a dirty origin, an open origin, and assumption-changed keep their origin', (t) => {
  const root = project(t, {
    'src/b.js': numbered(30, 'b'), 'src/c.js': numbered(10, 'c'), 'src/d.js': numbered(10, 'd'), 'src/guard.js': numbered(10, 'g'),
  });
  // R1 cites src/d.js while it is dirty (uncommitted): its content at R1 is in no commit.
  replaceLine(root, 'src/d.js', 3, 'd 3 dirty at R1');
  const violated = { ...ob('OB-4', { evidence: ['src/b.js:1'] }), status: 'violated', links: ['F-4'] };
  const open = { ...ob('OB-6', { evidence: ['src/b.js:10'] }), status: 'open', open_reason: 'frontier' };
  const r1 = closedBase(root, [
    ob('OB-1', { evidence: ['src/a.js:5'] }),
    ob('OB-3', { evidence: ['api/x.js:1'], deps: ['src/guard.js:2'] }),
    violated,
    ob('OB-5', { evidence: ['src/d.js:3'] }),
    open,
    ob('OB-7', { evidence: ['src/b.js:25'] }),
  ], {
    findings: [{
      id: 'F-4', fingerprint: 'fresh/f4', kind: 'defect', verdict: 'confirmed', severity: 'medium', impact_dimension: 'correctness',
      obligation: 'OB-4', summary: 'c.js line 3 is wrong.', trace: [{ role: 'sink', anchor: 'src/c.js:3', note: 'the write' }],
      counterevidence: [], validation_plan: null, verification: { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }, decision: 'pending',
    }],
  });

  // R2 (on R1): a.js changes (committed alone; d.js stays dirty with the same content).
  replaceLine(root, 'src/a.js', 5, 'a 5 changed');
  rawGit(root, ['add', 'src/a.js']);
  rawGit(root, ['commit', '-q', '-m', 'r2']);
  const r2 = incremental(root, r1, { slug: 'r2', now: at(2) });
  const f2 = freshness(root, r2);
  // An obligation still open in its origin was never concluded: never current.
  assert.deepEqual(origins(f2), [
    ['OB-1', 'touched', null], ['OB-3', 'current', null], ['OB-4', 'current', null], ['OB-5', 'current', null], ['OB-6', 'touched', null], ['OB-7', 'current', null],
  ]);
  assert.equal(reason(f2, 'OB-6'), `open in ${r1}; never concluded`);
  recordIncremental(root, r2, [again('OB-1', ['src/a.js:5'], 'r2'), again('OB-6', ['src/b.js:10'], 'r2')]);
  const closed2 = closeAt(root, r2, 30);
  assert.equal(closed2.code, EXIT.OK, JSON.stringify(closed2.json));

  // R3 (on R2): the dependency of OB-3 and the finding trace of OB-4 change (committed); d.js gets new
  // dirty content, so R1's version of it is no longer available to compare with.
  replaceLine(root, 'src/guard.js', 2, 'g 2 changed');
  replaceLine(root, 'src/c.js', 3, 'c 3 changed');
  rawGit(root, ['add', 'src/guard.js', 'src/c.js']);
  rawGit(root, ['commit', '-q', '-m', 'r3']);
  replaceLine(root, 'src/d.js', 3, 'd 3 changed again');
  const r3 = incremental(root, runIdOf(r2), { slug: 'r3', now: at(40) });
  const f3 = freshness(root, r3);
  assert.deepEqual(origins(f3), [
    ['OB-1', 'current', null], ['OB-6', 'current', null],
    ['OB-3', 'touched', r1], ['OB-4', 'touched', r1], ['OB-5', 'touched', r1], ['OB-7', 'current', r1],
  ]);
  assert.match(reason(f3, 'OB-3'), new RegExp(`dependency src/guard\\.js:2: origin ${r1} lines 2-2 changed`));
  assert.match(reason(f3, 'OB-4'), new RegExp(`trace src/c\\.js:3: origin ${r1} lines 3-3 changed`));
  assert.match(reason(f3, 'OB-5'), new RegExp(`origin ${r1} content unavailable \\(dirty at origin ${r1}, not in the object database\\)`));

  // The lead marks the inherited OB-7 assumption-changed, even naming a wrong origin: fresh keeps
  // the class with the resolved origin.
  const doc = readRecords(root, r3);
  const at7 = doc.freshness.obligations.findIndex((o) => o.id === 'OB-7');
  doc.freshness.obligations[at7] = { id: 'OB-7', class: 'assumption-changed', reason: 'the deployment changed', origin: runIdOf(r2) };
  writeRecords(root, r3, doc);
  assert.deepEqual(freshness(root, r3).obligations[at7], { id: 'OB-7', class: 'assumption-changed', reason: 'the deployment changed', origin: r1 });
});

test('the effective baseline: missing or corrupt ancestry is refused at Open, fresh, close and check; nothing is written', (t) => {
  const root = project(t);
  const r1 = closedBase(root, [ob('OB-1', { evidence: ['src/a.js:5'] }), ob('OB-2', { evidence: ['api/x.js:1'] })]);
  replaceLine(root, 'src/a.js', 5, 'a 5 changed');
  commitAll(root, 'r2');
  const r2 = incremental(root, r1, { slug: 'r2', now: at(2) });
  freshness(root, r2);
  recordIncremental(root, r2, [again('OB-1', ['src/a.js:5'], 'r2')]);
  assert.equal(closeAt(root, r2, 30).code, EXIT.OK);

  // R1 removed: no Incremental run can open on R2, and check reports the broken base.
  const r1Dir = path.join(root, '.nth-review', ...NS.split('/'), 'runs', r1);
  const moved = path.join(root, 'moved-r1');
  fs.renameSync(r1Dir, moved);
  const refusedOpen = nthr(['new-run', '--ns', NS, '--mode', 'incremental', '--slug', 'r3', '--base', runIdOf(r2)], { cwd: root, now: at(40) });
  assert.equal(refusedOpen.code, EXIT.USAGE);
  assert.match(refusedOpen.json.errors[0], new RegExp(`^ancestor ${r1} of base ${runIdOf(r2)}: --base ${r1} is not a run in ${NS}`));
  const checked = nthr(['check', '--run', r2], { cwd: root });
  assert.equal(checked.code, EXIT.INVALID);
  assert.ok(checked.json.errors.some((e) => e.startsWith('$.run.base:')), JSON.stringify(checked.json.errors));
  fs.renameSync(moved, r1Dir);

  // R3 opened, then R1's records corrupted: fresh and close refuse, and write nothing.
  const r3 = incremental(root, runIdOf(r2), { slug: 'r3', now: at(41) });
  freshness(root, r3);
  recordIncremental(root, r3, []);
  const r1Records = path.join(r1Dir, 'records.json');
  const good = fs.readFileSync(r1Records);
  fs.writeFileSync(r1Records, '{"schema":');
  const before = fs.readFileSync(recordsFile(root, r3));
  const refusedFresh = fresh(root, r3);
  assert.equal(refusedFresh.code, EXIT.USAGE, JSON.stringify(refusedFresh.json));
  assert.match(refusedFresh.json.errors[0], new RegExp(`^ancestor ${r1} of base ${runIdOf(r2)}: --base ${r1} fails validation`));
  const refusedClose = closeAt(root, r3, 50);
  assert.notEqual(refusedClose.code, EXIT.OK, JSON.stringify(refusedClose.json));
  assert.ok(fs.readFileSync(recordsFile(root, r3)).equals(before), 'nothing written');
  fs.writeFileSync(r1Records, good);
  const restored = closeAt(root, r3, 51);
  assert.equal(restored.code, EXIT.OK, JSON.stringify(restored.json));
});
