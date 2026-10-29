// Snapshot correction (owner decision, 2026-10-26): tracked files marked
// assume-unchanged or skip-worktree never appear in `git status`, so an edit
// to one went unseen and `close` succeeded as unchanged. The snapshot now
// observes them itself (`flagged`, tracked-key@3). Disposable repositories.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { validateStructure } from '../scripts/lib/schema.mjs';
import { EMPTY_SHA256, compareSnapshots, readFlagged, takeSnapshot } from '../scripts/lib/snapshot.mjs';
import { validRecords } from './helpers/records.mjs';
import { linkDirectory, makeRepo, write } from './helpers/repo.mjs';
import { at, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const repoOf = (snapshot) => snapshot.repos.find((r) => r.path === '.');
const valid = (snapshot) => assert.deepEqual(validateStructure({ ...validRecords(), snapshot }), []);
const status = (root, files) => rawGit(root, ['status', '--porcelain', '--', ...files]).trim();
// A repository whose committed `files` are then given `flag` (git update-index).
function flaggedRepo(t, files, flags = {}) {
  const root = fs.realpathSync.native(makeRepo(path.join(makeTempDir(t), 'p'), files));
  for (const [flag, list] of Object.entries(flags)) rawGit(root, ['update-index', `--${flag}`, ...list]);
  return root;
}

test('regression: an edit to an assume-unchanged or skip-worktree file is a tracked change although git status shows nothing', (t) => {
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    const root = flaggedRepo(t, { 'a.txt': 'aaaa\n', 'b.txt': 'b\n' }, { [flag]: ['a.txt'] });
    const before = takeSnapshot(root);
    write(root, 'a.txt', 'AAAA\n'); // same size
    assert.equal(status(root, ['a.txt']), '', `control (${flag}): git status reports nothing`);
    const after = takeSnapshot(root);
    for (const field of ['porcelain_sha256', 'staged_sha256', 'unstaged_sha256']) {
      assert.equal(repoOf(after)[field], repoOf(before)[field], `the @2 fields alone could not see it (${field})`);
    }
    const compared = compareSnapshots(before, after);
    assert.equal(compared.tracked, 'changed', flag);
    assert.equal(compared.action, 'abandon');
    assert.deepEqual(compared.repos.tracked, ['.']);
    valid(before);
    valid(after);
  }
});

test('regression: close refuses a run whose flagged file changed after Open; snapshot-changed is the explicit way out', (t) => {
  const root = flaggedRepo(t, { 'src/a.js': 'a\n', 'src/hidden.js': 'hidden\n' }, { 'skip-worktree': ['src/hidden.js'] });
  const opened = nthr(['new-run', '--ns', 'experiments/flagged', '--mode', 'task', '--slug', 'f', '--change', '.'], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.scope.summary = 'flagged regression';
  // A flagged file in the working tree makes the size unverified: Opus High is required.
  assert.deepEqual([opened.json.result.size.class, opened.json.result.required_lead_model], ['unverified', 'opus-high']);
  doc.run.runtime.lead_model = 'claude-opus-5-5';
  doc.run.runtime.lead_effort = 'high';
  doc.scope.intent = [];
  writeRecords(root, runDir, doc);

  write(root, 'src/hidden.js', 'edited after Open\n');
  assert.equal(status(root, ['src/hidden.js']), '', 'control: git status reports nothing');
  const before = fs.readFileSync(path.join(root, ...runDir.split('/'), 'records.json'));
  const refused = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(9) });
  assert.equal(refused.code, EXIT.USAGE, JSON.stringify(refused.json));
  assert.match(refused.json.errors[0], /the tracked source changed since Open \(\.\)/);
  assert.ok(fs.readFileSync(path.join(root, ...runDir.split('/'), 'records.json')).equals(before), 'nothing written');

  const explicit = nthr(['close', '--run', runDir, '--status', 'incomplete', '--reason', 'snapshot-changed'], { cwd: root, now: at(9) });
  assert.equal(explicit.code, EXIT.OK, JSON.stringify(explicit.json));
  assert.match(readRecords(root, runDir).checks.at(-1).result, /^tracked changed;/);
});

test('an unchanged flagged file is equal, even when touched; a present flagged file is never reconstructible', (t) => {
  const root = flaggedRepo(t, { 'a.txt': 'a\n' }, { 'assume-unchanged': ['a.txt'] });
  const before = takeSnapshot(root);
  assert.deepEqual(repoOf(before).flagged, {
    count: 1, sha256: repoOf(before).flagged.sha256, hashed: 1, missing: 0, sparse: 0,
    skipped: { secret: 0, size: 0, budget: 0, link: 0, unreadable: 0 },
  });
  assert.notEqual(repoOf(before).flagged.sha256, EMPTY_SHA256);
  assert.equal(before.tracked_complete, true);
  assert.equal(before.reconstructible, false);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, 'a.txt'), later, later);
  const compared = compareSnapshots(before, takeSnapshot(root));
  assert.equal(compared.tracked, 'equal');
  assert.equal(compared.action, 'continue');
});

test('flag transitions are tracked changes: set, cleared, switched', (t) => {
  const root = flaggedRepo(t, { 'a.txt': 'a\n' });
  const states = [takeSnapshot(root)];
  rawGit(root, ['update-index', '--assume-unchanged', 'a.txt']);
  states.push(takeSnapshot(root));
  rawGit(root, ['update-index', '--no-assume-unchanged', 'a.txt']);
  states.push(takeSnapshot(root));
  rawGit(root, ['update-index', '--assume-unchanged', 'a.txt']);
  const assumed = takeSnapshot(root);
  rawGit(root, ['update-index', '--no-assume-unchanged', 'a.txt']); // one flag change per command
  rawGit(root, ['update-index', '--skip-worktree', 'a.txt']);
  const skipped = takeSnapshot(root);
  assert.equal(compareSnapshots(states[0], states[1]).tracked, 'changed', 'set');
  assert.equal(compareSnapshots(states[1], states[2]).tracked, 'changed', 'cleared');
  assert.equal(compareSnapshots(states[0], states[2]).tracked, 'equal', 'back to the start');
  assert.equal(compareSnapshots(assumed, skipped).tracked, 'changed', 'switched');
  assert.deepEqual(readFlagged(root).map((f) => [f.rel, f.tag, f.skipWorktree]), [['a.txt', 'S', true]]);
});

test('a sparse skip-worktree file is stable and not a change; a missing assume-unchanged file is a deletion', (t) => {
  const root = flaggedRepo(t, { 'sparse.txt': 's\n', 'gone.txt': 'g\n' }, { 'skip-worktree': ['sparse.txt'], 'assume-unchanged': ['gone.txt'] });
  const base = takeSnapshot(root);
  fs.rmSync(path.join(root, 'sparse.txt'));
  const sparse = takeSnapshot(root);
  assert.equal(repoOf(sparse).flagged.sparse, 1);
  assert.equal(compareSnapshots(sparse, takeSnapshot(root)).tracked, 'equal', 'a sparse checkout is stable');
  write(root, 'sparse.txt', 's\n');
  assert.equal(compareSnapshots(sparse, takeSnapshot(root)).tracked, 'changed', 'reappearing');
  assert.equal(compareSnapshots(base, sparse).tracked, 'changed', 'leaving the working tree');
  fs.rmSync(path.join(root, 'gone.txt'));
  const missing = takeSnapshot(root);
  assert.equal(repoOf(missing).flagged.missing, 1);
  assert.equal(compareSnapshots(base, missing).tracked, 'changed');
  valid(missing);
});

test('a mode-only change to a flagged file is a tracked change where git tracks the executable bit', {
  skip: process.platform === 'win32' && 'Windows has no executable bit (core.fileMode is false)',
}, (t) => {
  const root = flaggedRepo(t, { 'run.sh': 'echo run\n' }, { 'assume-unchanged': ['run.sh'] });
  rawGit(root, ['config', 'core.fileMode', 'true']);
  const before = takeSnapshot(root);
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  assert.equal(status(root, ['run.sh']), '', 'control: git status reports nothing');
  assert.equal(compareSnapshots(before, takeSnapshot(root)).tracked, 'changed');
  rawGit(root, ['config', 'core.fileMode', 'false']);
  const ignored = takeSnapshot(root);
  fs.chmodSync(path.join(root, 'run.sh'), 0o644);
  assert.equal(compareSnapshots(ignored, takeSnapshot(root)).tracked, 'equal', 'git ignores the bit here, and so does the snapshot');
});

test('a flagged secret is never opened: unverified, never equal', (t) => {
  const root = flaggedRepo(t, { 'keys/dev.pem': 'dummy fixture, not a key\n', 'a.txt': 'a\n' }, { 'skip-worktree': ['keys/dev.pem'] });
  const opened = t.mock.method(fs, 'openSync');
  const before = takeSnapshot(root);
  assert.ok(!opened.mock.calls.some((c) => String(c.arguments[0]).endsWith('dev.pem')), 'never opened');
  assert.equal(repoOf(before).flagged.skipped.secret, 1);
  assert.equal(before.tracked_complete, false);
  assert.deepEqual(before.limitations, [{ code: 'flagged-not-hashed', path: 'keys/dev.pem' }]);
  write(root, 'keys/dev.pem', 'other dummy content!!\n');
  const compared = compareSnapshots(before, takeSnapshot(root));
  assert.equal(compared.tracked, 'unverified');
  assert.equal(compared.action, 'reassess');
  valid(before);
});

test('a flagged file with a filter attribute is hashed raw; the filter never runs', (t) => {
  const base = makeTempDir(t);
  const marker = path.join(base, 'marker.log');
  const script = write(base, 'filter.mjs', "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], 'ran\\n');\nprocess.stdin.pipe(process.stdout);\n");
  const posix = (p) => p.replaceAll('\\', '/');
  const root = fs.realpathSync.native(makeRepo(path.join(base, 'p'), { '.gitattributes': '*.flt filter=marker\n', 'f.flt': 'flt\n' }));
  rawGit(root, ['config', 'filter.marker.clean', `node "${posix(script)}" "${posix(marker)}"`]);
  rawGit(root, ['config', 'filter.marker.smudge', `node "${posix(script)}" "${posix(marker)}"`]);
  rawGit(root, ['update-index', '--assume-unchanged', 'f.flt']);
  fs.rmSync(marker, { force: true });
  const before = takeSnapshot(root);
  assert.equal(repoOf(before).flagged.hashed, 1);
  write(root, 'f.flt', 'FLT\n');
  assert.equal(compareSnapshots(before, takeSnapshot(root)).tracked, 'changed');
  assert.equal(fs.existsSync(marker), false, 'the filter never ran');
});

test('limits: size and budget skips are limitations and leave the state unverified; a link is never followed', (t) => {
  const base = makeTempDir(t);
  const root = fs.realpathSync.native(makeRepo(path.join(base, 'p'), {
    'big.txt': '0123456789\n', 'one.txt': 'ab\n', 'two.txt': 'cd\n', 'dir/x.txt': 'x\n',
  }));
  rawGit(root, ['update-index', '--assume-unchanged', 'big.txt', 'one.txt', 'two.txt', 'dir/x.txt']);
  const limits = { files: 1, fileBytes: 4, totalBytes: 8 };
  const before = takeSnapshot(root, { flaggedLimits: limits });
  assert.deepEqual(repoOf(before).flagged.skipped, { secret: 0, size: 1, budget: 2, link: 0, unreadable: 0 });
  assert.equal(repoOf(before).flagged.hashed, 1);
  assert.deepEqual(before.limitations.map((l) => l.code), ['flagged-not-hashed', 'flagged-not-hashed', 'flagged-not-hashed']);
  assert.equal(before.tracked_complete, false);
  write(root, 'big.txt', '9876543210\n'); // same size, never read
  assert.equal(compareSnapshots(before, takeSnapshot(root, { flaggedLimits: limits })).tracked, 'unverified');
  valid(before);

  // A flagged file reached through a junction or symbolic link directory.
  const elsewhere = path.join(base, 'elsewhere');
  write(elsewhere, 'x.txt', 'x\n');
  fs.rmSync(path.join(root, 'dir'), { recursive: true });
  linkDirectory(elsewhere, path.join(root, 'dir'));
  assert.equal(repoOf(takeSnapshot(root)).flagged.skipped.link, 1);
});

test('an ordinary repository: no flagged files, an empty digest; equality as before', (t) => {
  const root = flaggedRepo(t, { 'a.txt': 'a\n' });
  const before = takeSnapshot(root);
  assert.deepEqual(repoOf(before).flagged, { count: 0, sha256: EMPTY_SHA256, hashed: 0, missing: 0, sparse: 0, skipped: { secret: 0, size: 0, budget: 0, link: 0, unreadable: 0 } });
  assert.equal(before.reconstructible, true);
  assert.equal(compareSnapshots(before, takeSnapshot(root)).tracked, 'equal');
  write(root, 'a.txt', 'changed\n');
  assert.equal(compareSnapshots(before, takeSnapshot(root)).tracked, 'changed');
});

test('a snapshot written before tracked-key@3 stays valid and is never equal to a new one', (t) => {
  const root = flaggedRepo(t, { 'a.txt': 'a\n' });
  const current = takeSnapshot(root);
  const legacy = structuredClone(current);
  for (const repo of legacy.repos) delete repo.flagged;
  legacy.tracked_key = createHash('sha256').update(JSON.stringify(['nth-review/tracked-key@2', legacy.repos.map((r) => [
    r.path, r.head, r.branch, r.unborn, r.is_worktree, r.is_submodule, r.porcelain_sha256, r.staged_sha256, r.unstaged_sha256,
  ])])).digest('hex');
  valid(legacy);
  assert.deepEqual(validateStructure(validRecords()), [], 'the shared legacy fixture is still valid');
  const same = compareSnapshots(legacy, takeSnapshot(root));
  assert.deepEqual([same.tracked, same.action, same.repos.unverified, same.repos.tracked], ['unverified', 'reassess', ['.'], []]);
  write(root, 'a.txt', 'visible to status\n');
  assert.equal(compareSnapshots(legacy, takeSnapshot(root)).tracked, 'changed');
});

test('schema: flagged counts must add up, and the coverage flags cannot claim more than they show', () => {
  const root = { ...validRecords() };
  const withFlagged = (flagged, edit = () => {}) => {
    const doc = structuredClone(root);
    for (const repo of doc.snapshot.repos) repo.flagged = structuredClone(flagged);
    edit(doc);
    return validateStructure(doc);
  };
  const zero = { count: 0, sha256: EMPTY_SHA256, hashed: 0, missing: 0, sparse: 0, skipped: { secret: 0, size: 0, budget: 0, link: 0, unreadable: 0 } };
  assert.deepEqual(withFlagged(zero), []);
  assert.match(withFlagged({ ...zero, count: 2, hashed: 1 }).join('\n'), /flagged: hashed, missing, sparse and all skipped counts must equal count/);
  assert.match(withFlagged({ ...zero, count: 1, skipped: { ...zero.skipped, secret: 1 } }, (d) => { d.snapshot.tracked_complete = true; }).join('\n'), /tracked_complete: must be true exactly when no tracked entry or flagged file is unverified/);
  assert.match(withFlagged({ ...zero, count: 1, hashed: 1 }, (d) => { d.snapshot.reconstructible = true; }).join('\n'), /reconstructible: requires .*no flagged file in the working tree/);
  assert.match(withFlagged({ ...zero, extra: 1 }).join('\n'), /flagged\.extra: is not a records@1 field/);
});
