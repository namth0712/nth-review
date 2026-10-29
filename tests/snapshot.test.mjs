import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DiscoveryError } from '../scripts/lib/discover.mjs';
import { EMPTY_SHA256, UNTRACKED_LIMITS, compareSnapshots, isSecretPath, takeSnapshot } from '../scripts/lib/snapshot.mjs';
import { validateStructure } from '../scripts/lib/schema.mjs';
import { validRecords } from './helpers/records.mjs';
import { buildProject, commitAll, linkDirectory, makeRepo, write } from './helpers/repo.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const NO_SKIPS = Object.freeze({ secret: 0, size: 0, budget: 0, repository: 0, link: 0, unreadable: 0 });
const NO_FLAGGED_SKIPS = Object.freeze({ secret: 0, size: 0, budget: 0, link: 0, unreadable: 0 });

// The list digest the snapshot must produce for these repository-relative names.
function listDigest(names) {
  const hash = createHash('sha256');
  for (const name of names.map((n) => Buffer.from(n, 'utf8')).sort(Buffer.compare)) {
    hash.update(name);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

const repoAt = (snapshot, p) => snapshot.repos.find((r) => r.path === p);

function assertValid(snapshot) {
  assert.deepEqual(validateStructure({ ...validRecords(), snapshot }), []);
}

// Paths, relative to `root` with '/' separators, that fs.openSync was called with.
function openedPaths(spy, root) {
  return spy.mock.calls.map((call) => path.relative(root, String(call.arguments[0])).split(path.sep).join('/'));
}

test('T1: a clean repository has empty-input digests and is reconstructible', (t) => {
  const root = makeRepo(makeTempDir(t));
  const snapshot = takeSnapshot(root);
  assert.deepEqual(snapshot, {
    reconstructible: true,
    tracked_key: snapshot.tracked_key,
    untracked_key: snapshot.untracked_key,
    tracked_complete: true,
    discovery_complete: true,
    untracked_complete: true,
    limitations: [],
    repos: [{
      path: '.',
      head: rawGit(root, ['rev-parse', 'HEAD']).trim(),
      branch: 'main',
      unborn: false,
      is_worktree: false,
      is_submodule: false,
      porcelain_sha256: EMPTY_SHA256,
      staged_sha256: EMPTY_SHA256,
      unstaged_sha256: EMPTY_SHA256,
      unverified: { filter: 0, secret: 0, unreadable: 0, sha256: EMPTY_SHA256 },
      flagged: { count: 0, sha256: EMPTY_SHA256, hashed: 0, missing: 0, sparse: 0, skipped: NO_FLAGGED_SKIPS },
      untracked: { count: 0, list_sha256: EMPTY_SHA256, sample: [], content_sha256: EMPTY_SHA256, hashed: 0, skipped: NO_SKIPS },
    }],
  });
  assert.match(snapshot.tracked_key, /^[0-9a-f]{64}$/);
  assertValid(snapshot);
});

test('T2: staged, unstaged and untracked changes, each detected separately', (t) => {
  const root = makeRepo(makeTempDir(t), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  write(root, 'a.txt', 'a changed\n');
  write(root, 'b.txt', 'b staged\n');
  rawGit(root, ['add', 'b.txt']);
  write(root, 'notes/new.md', 'draft 1\n');

  const first = takeSnapshot(root);
  const r1 = first.repos[0];
  assert.equal(first.reconstructible, false);
  assert.notEqual(r1.porcelain_sha256, EMPTY_SHA256);
  assert.notEqual(r1.staged_sha256, EMPTY_SHA256);
  assert.notEqual(r1.unstaged_sha256, EMPTY_SHA256);
  assert.deepEqual(r1.untracked, {
    count: 1, list_sha256: listDigest(['notes/new.md']), sample: ['notes/new.md'],
    content_sha256: r1.untracked.content_sha256, hashed: 1, skipped: NO_SKIPS,
  });
  assertValid(first);
  assert.deepEqual(takeSnapshot(root), first, 'stable across calls');

  // More unstaged edits to an already-modified file: only the unstaged digest moves.
  write(root, 'a.txt', 'a changed again\n');
  const second = takeSnapshot(root);
  const r2 = second.repos[0];
  assert.equal(r2.porcelain_sha256, r1.porcelain_sha256);
  assert.equal(r2.staged_sha256, r1.staged_sha256);
  assert.notEqual(r2.unstaged_sha256, r1.unstaged_sha256);
  assert.notEqual(second.tracked_key, first.tracked_key);

  // Untracked content change: same names, new content digest, same tracked_key.
  write(root, 'notes/new.md', 'draft 2\n');
  const third = takeSnapshot(root);
  assert.equal(third.tracked_key, second.tracked_key);
  assert.equal(third.repos[0].untracked.list_sha256, r2.untracked.list_sha256);
  assert.notEqual(third.repos[0].untracked.content_sha256, r2.untracked.content_sha256);

  // Untracked rename: the list changes, the tracked_key does not.
  fs.renameSync(path.join(root, 'notes', 'new.md'), path.join(root, 'notes', 'renamed.md'));
  const fourth = takeSnapshot(root);
  assert.equal(fourth.tracked_key, second.tracked_key);
  assert.notEqual(fourth.repos[0].untracked.list_sha256, r2.untracked.list_sha256);

  // Staging changes the staged digest.
  rawGit(root, ['add', 'a.txt']);
  const fifth = takeSnapshot(root);
  assert.notEqual(fifth.repos[0].staged_sha256, r2.staged_sha256);
  assert.equal(fifth.repos[0].unstaged_sha256, EMPTY_SHA256);
});

test('writes under .nth-review/ change nothing, even when it is tracked', (t) => {
  const root = makeRepo(makeTempDir(t), { 'src.js': '1\n', '.nth-review/README.md': 'tracked by mistake\n' });
  const before = takeSnapshot(root);
  write(root, '.nth-review/README.md', 'edited\n');
  write(root, '.nth-review/experiments/demo/runs/20261025-120000-task-demo/records.json', '{}\n');
  makeRepo(path.join(root, '.nth-review', 'nested'));
  assert.deepEqual(takeSnapshot(root), before);
  assert.equal(before.reconstructible, true);
});

test('unborn HEAD: head null, branch kept, staged files still recorded', (t) => {
  const root = makeRepo(makeTempDir(t), {});
  const empty = takeSnapshot(root);
  assert.equal(empty.repos[0].head, null);
  assert.equal(empty.repos[0].unborn, true);
  assert.equal(empty.repos[0].branch, 'main');
  assert.equal(empty.reconstructible, true);
  assertValid(empty);
  write(root, 'first.txt', '1\n');
  rawGit(root, ['add', 'first.txt']);
  const staged = takeSnapshot(root);
  assert.notEqual(staged.repos[0].staged_sha256, EMPTY_SHA256);
  assert.equal(staged.repos[0].untracked.count, 0);
  assertValid(staged);
});

test('detached HEAD: branch null, head kept', (t) => {
  const root = makeRepo(makeTempDir(t));
  rawGit(root, ['checkout', '-q', '--detach']);
  const snapshot = takeSnapshot(root);
  assert.equal(snapshot.repos[0].branch, null);
  assert.equal(snapshot.repos[0].head, rawGit(root, ['rev-parse', 'HEAD']).trim());
  assertValid(snapshot);
});

test('non-ASCII names are recorded exactly and in byte order', (t) => {
  const root = makeRepo(makeTempDir(t), { 'tài liệu.md': 'v1\n' });
  write(root, 'tài liệu.md', 'v2\n');
  const names = ['ghi chú/日本語.txt', 'B.txt', 'Z/x.txt', 'a-b.txt', 'a.txt', 'a/b.txt', 'é.txt'];
  for (const name of names) write(root, name, `${name}\n`);
  const snapshot = takeSnapshot(root);
  const { untracked } = snapshot.repos[0];
  assert.deepEqual(untracked.sample, ['B.txt', 'Z/x.txt', 'a-b.txt', 'a.txt', 'a/b.txt', 'ghi chú/日本語.txt', 'é.txt']);
  assert.equal(untracked.list_sha256, listDigest(names));
  assert.equal(untracked.hashed, names.length);
  assert.notEqual(snapshot.repos[0].unstaged_sha256, EMPTY_SHA256);
  assert.deepEqual(takeSnapshot(root), snapshot);
  assertValid(snapshot);
});

test('core.autocrlf=true: a stable tracked_key across calls, clean and dirty', (t) => {
  const root = makeRepo(makeTempDir(t), {});
  rawGit(root, ['config', 'core.autocrlf', 'true']);
  write(root, 'crlf.txt', 'one\r\ntwo\r\n');
  write(root, 'lf.txt', 'one\ntwo\n');
  commitAll(root);
  const clean = takeSnapshot(root);
  assert.equal(clean.reconstructible, true);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'crlf.txt'), later, later); // stat-dirty, content-clean
  assert.deepEqual(takeSnapshot(root), clean);
  write(root, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n');
  const dirty = takeSnapshot(root);
  assert.notEqual(dirty.tracked_key, clean.tracked_key);
  assert.equal(takeSnapshot(root).tracked_key, dirty.tracked_key);
});

test('git configuration does not change the snapshot', (t) => {
  const root = makeRepo(makeTempDir(t), { 'old.txt': 'same content\n', 'sub/x.txt': 'x\n' });
  rawGit(root, ['mv', 'old.txt', 'new.txt']);
  write(root, 'sub/x.txt', 'changed\n');
  write(root, 'untracked/y.txt', 'y\n');
  const before = takeSnapshot(root);
  for (const [key, value] of [
    ['status.renames', 'true'], ['diff.renames', 'copies'], ['status.showUntrackedFiles', 'all'],
    ['diff.ignoreSubmodules', 'none'], ['status.branch', 'true'], ['color.status', 'always'],
    ['core.quotepath', 'true'], ['status.relativePaths', 'true'],
  ]) rawGit(root, ['config', key, value]);
  assert.deepEqual(takeSnapshot(root), before);
});

test('multi-repository project: each repository on its own, nested ones excluded from their parent', (t) => {
  const base = makeTempDir(t);
  const { root } = buildProject(base);
  const before = takeSnapshot(root);
  assert.deepEqual(before.repos.map((r) => r.path), ['.', 'api', 'fresh', 'libs/shared', 'vendor/lib', 'wt']);
  assert.deepEqual(before.limitations, []);
  assertValid(before);
  // The root lists deep/er/est/ and node_modules/m/ (not discovered) but not
  // api/, fresh/, wt/ (discovered) or .nth-review/x/ (always excluded).
  assert.deepEqual(repoAt(before, '.').untracked, {
    count: 2, list_sha256: listDigest(['deep/er/est/', 'node_modules/m/']), sample: [],
    content_sha256: EMPTY_SHA256, hashed: 0, skipped: { ...NO_SKIPS, repository: 2 },
  });
  assert.equal(repoAt(before, 'wt').branch, 'feature');
  assert.equal(repoAt(before, 'fresh').head, null);

  // Untracked files, inside a nested repository and inside the submodule: tracked_key unchanged.
  write(root, 'api/scratch.txt', 's\n');
  write(root, 'libs/shared/local.txt', 'l\n');
  const untrackedOnly = takeSnapshot(root);
  assert.equal(untrackedOnly.tracked_key, before.tracked_key);
  assert.equal(repoAt(untrackedOnly, 'api').untracked.count, 1);
  assert.equal(repoAt(untrackedOnly, 'libs/shared').untracked.count, 1);
  assert.deepEqual(repoAt(untrackedOnly, '.').untracked, repoAt(before, '.').untracked);

  // A new commit in the submodule changes both the submodule and its superproject.
  commitAll(path.join(root, 'libs', 'shared'), 'bump');
  const bumped = takeSnapshot(root);
  assert.notEqual(bumped.tracked_key, before.tracked_key);
  assert.notEqual(repoAt(bumped, '.').unstaged_sha256, EMPTY_SHA256);
  assert.notEqual(repoAt(bumped, 'libs/shared').head, repoAt(before, 'libs/shared').head);

  // A tracked change in the worktree; then a new repository changes the set.
  write(root, 'wt/README.md', 'worktree edit\n');
  const worktreeEdit = takeSnapshot(root);
  assert.notEqual(repoAt(worktreeEdit, 'wt').unstaged_sha256, EMPTY_SHA256);
  makeRepo(path.join(root, 'web'), {});
  const added = takeSnapshot(root);
  assert.ok(repoAt(added, 'web'));
  assert.notEqual(added.tracked_key, worktreeEdit.tracked_key);
});

test('a root that is not a repository: limitation recorded', (t) => {
  const root = makeTempDir(t);
  makeRepo(path.join(root, 'api'));
  write(root, 'notes.md', 'outside every repository\n');
  const snapshot = takeSnapshot(root);
  assert.deepEqual(snapshot.limitations, [{ code: 'root-not-a-repository', path: '.' }]);
  assert.deepEqual(snapshot.repos.map((r) => r.path), ['api']);
  assertValid(snapshot);
});

test('no repository at all is a refusal', (t) => {
  assert.throws(() => takeSnapshot(makeTempDir(t)), (error) => error instanceof DiscoveryError && error.refusal === true);
});

test('bounded content hashing: per-file size, file count and byte budget, reported per reason', (t) => {
  const root = makeRepo(makeTempDir(t));
  const files = { 'a.txt': 10, 'b.txt': 2000, 'c.txt': 10, 'd.txt': 10, 'e.txt': 10, 'f.txt': 1 };
  for (const [name, size] of Object.entries(files)) write(root, name, 'x'.repeat(size));
  const limits = { sample: 2, files: 4, fileBytes: 1000, totalBytes: 25 };
  // a hashed (15 bytes left); b over the per-file size; c hashed (5 left);
  // d over the byte budget; e and f beyond the 4 files examined.
  const snapshot = takeSnapshot(root, { limits });
  assert.deepEqual(snapshot.repos[0].untracked, {
    count: 6, list_sha256: listDigest(Object.keys(files)), sample: ['a.txt', 'b.txt'],
    content_sha256: snapshot.repos[0].untracked.content_sha256, hashed: 2,
    skipped: { ...NO_SKIPS, size: 1, budget: 3 },
  });
  assertValid(snapshot);
  write(root, 'e.txt', 'y'.repeat(10)); // not covered: the counts say so
  assert.deepEqual(takeSnapshot(root, { limits }), snapshot);
  write(root, 'a.txt', 'y'.repeat(10)); // covered
  assert.notEqual(takeSnapshot(root, { limits }).repos[0].untracked.content_sha256, snapshot.repos[0].untracked.content_sha256);
});

test('more than 10,000 untracked files: full list hashed, sample and content capped', { timeout: 300_000 }, (t) => {
  const root = makeRepo(makeTempDir(t));
  const names = [];
  fs.mkdirSync(path.join(root, 'many'));
  for (let i = 0; i <= 10_000; i += 1) {
    const name = `many/f${String(i).padStart(5, '0')}.txt`;
    fs.writeFileSync(path.join(root, name), `${i}\n`);
    names.push(name);
  }
  const { untracked } = takeSnapshot(root).repos[0];
  assert.equal(untracked.count, 10_001);
  assert.equal(untracked.list_sha256, listDigest(names));
  assert.deepEqual(untracked.sample, names.slice(0, UNTRACKED_LIMITS.sample));
  assert.equal(untracked.hashed, UNTRACKED_LIMITS.files);
  assert.deepEqual(untracked.skipped, { ...NO_SKIPS, budget: 10_001 - UNTRACKED_LIMITS.files });
});

test('secret files are never opened, tracked or untracked, and their changes are reported, not hashed', (t) => {
  const root = makeRepo(makeTempDir(t), { 'app/.env': 'TOKEN=committed-placeholder\n', 'app/main.js': '1\n' });
  write(root, 'app/.env', 'TOKEN=local-value-1\n'); // tracked, now modified
  const secrets = ['.env', 'config/.env.local', 'certs/server.pem', '.ssh/id_ed25519', 'deploy/prod.tfvars'];
  for (const name of secrets) write(root, name, 'value-1\n');
  write(root, 'notes.txt', 'ordinary\n');

  const open = t.mock.method(fs, 'openSync');
  const first = takeSnapshot(root);
  const opened = openedPaths(open, fs.realpathSync.native(root));
  assert.deepEqual(opened, ['notes.txt']);
  assert.ok(opened.every((p) => !isSecretPath(p)));

  const repo = first.repos[0];
  assert.equal(repo.untracked.count, 6);
  assert.equal(repo.untracked.hashed, 1);
  assert.deepEqual(repo.untracked.skipped, { ...NO_SKIPS, secret: 5 });
  assert.ok(repo.untracked.sample.includes('.env'), 'names are still listed');
  assert.deepEqual(first.limitations, [{ code: 'secret-not-hashed', path: 'app/.env' }]);
  assert.equal(repo.unverified.secret, 1);
  assert.equal(first.tracked_complete, false);
  assertValid(first);

  for (const name of [...secrets, 'app/.env']) write(root, name, 'value-2 (changed)\n');
  const second = takeSnapshot(root);
  assert.deepEqual(second, first, 'secret content never reaches the snapshot');
  // Equal keys are not verified equality: the secret's content was never seen.
  const compared = compareSnapshots(first, second);
  assert.equal(compared.tracked, 'unverified');
  assert.equal(compared.action, 'reassess');
  assert.deepEqual(compared.repos.unverified, ['.']);
});

test('isSecretPath: names and directories', () => {
  for (const p of [
    '.env', 'a/.ENV', '.env.local', '.env.example', 'prod.env', '.envrc', 'server.pem', 'tls/x.KEY',
    'id_rsa', 'id_ed25519.pub', '.npmrc', 'credentials', '.aws/config', 'home/.ssh/known_hosts',
    'x.tfvars', 'terraform.tfstate.backup', 'secrets.yaml', 'db.secret',
  ]) assert.equal(isSecretPath(p), true, p);
  for (const p of [
    'env.ts', 'src/environment.md', '.envelope', 'docs/env/README.md', 'public.key.md', 'keys.md',
    'README.md', 'credentials.md.bak/x.txt', 'ssh/config', 'secret-santa.txt',
  ]) assert.equal(isSecretPath(p), false, p);
});

test('directory links and junctions are never read through', (t) => {
  const base = makeTempDir(t);
  const root = makeRepo(path.join(base, 'root'));
  const outside = path.join(base, 'outside-dir');
  write(outside, 'private.txt', 'outside the project\n');
  linkDirectory(outside, path.join(root, 'linked'));
  const open = t.mock.method(fs, 'openSync');
  const snapshot = takeSnapshot(root);
  assert.ok(openedPaths(open, path.dirname(fs.realpathSync.native(root))).every((p) => !p.startsWith('outside-dir')));
  const { untracked } = snapshot.repos[0];
  if (process.platform === 'win32') {
    // Git for Windows lists files inside a junction; they are skipped, never opened.
    assert.deepEqual(untracked.skipped, { ...NO_SKIPS, link: 1 });
  } else {
    // Elsewhere git lists the link itself; its identity is the link text.
    assert.equal(untracked.hashed, 1);
  }
  write(outside, 'private.txt', 'changed outside\n');
  assert.deepEqual(takeSnapshot(root), snapshot);
});

test('an untracked file symlink is hashed by its link text, not its target', (t) => {
  const base = makeTempDir(t);
  const root = makeRepo(path.join(base, 'root'));
  const target = write(base, 'target.txt', 'target 1\n');
  try {
    fs.symlinkSync(target, path.join(root, 'link.txt'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('creating symbolic links needs a privilege on this machine');
    throw error;
  }
  const first = takeSnapshot(root);
  assert.equal(first.repos[0].untracked.hashed, 1);
  write(base, 'target.txt', 'target 2\n');
  assert.deepEqual(takeSnapshot(root), first);
});

test('limitations are capped at 100 with a truncation marker', (t) => {
  const base = makeTempDir(t);
  const root = makeRepo(path.join(base, 'root'));
  const target = makeRepo(path.join(base, 'target'));
  for (let i = 0; i < 101; i += 1) linkDirectory(target, path.join(root, `link${String(i).padStart(3, '0')}`));
  const snapshot = takeSnapshot(root);
  assert.equal(snapshot.limitations.length, 100);
  assert.deepEqual(snapshot.limitations.at(-1), { code: 'truncated', path: '.' });
  assert.deepEqual(snapshot.limitations[0], { code: 'symlink-skipped', path: 'link000' });
  assertValid(snapshot);
});

test('only read-only git commands are spawned, and nothing under .git changes', (t) => {
  const root = makeRepo(makeTempDir(t), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  write(root, 'a.txt', 'dirty\n');
  write(root, 'new.txt', 'untracked\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'a.txt'), later, later);
  fs.utimesSync(path.join(root, 'b.txt'), later, later); // racy: content-clean, stat-dirty
  const before = treeState(path.join(root, '.git'));
  const subcommands = new Set();
  const spawn = (command, args, options) => {
    assert.ok(args.includes('--no-optional-locks'));
    subcommands.add(args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-c'));
    return spawnSync(command, args, options);
  };
  takeSnapshot(root, { gitOptions: { spawn } });
  takeSnapshot(root);
  // `config` looks up filter drivers to disable; `check-attr` runs only when
  // drivers are configured (this machine's system git-lfs, for one).
  const used = [...subcommands].sort();
  assert.ok(['ls-files', 'rev-parse', 'status', 'config'].every((s) => used.includes(s)), used.join(' '));
  assert.ok(used.every((s) => ['check-attr', 'config', 'ls-files', 'rev-parse', 'status'].includes(s)), used.join(' '));
  assert.deepEqual(treeState(path.join(root, '.git')), before);
});

// ------------------------------------------------- snapshot contract regressions

test('tracked_key never depends on untracked names, content, skips or limitations', (t) => {
  const base = makeTempDir(t);
  const root = makeRepo(path.join(base, 'root'), { 'src/a.js': '1\n' });
  const outsideRepo = makeRepo(path.join(base, 'outside'));
  const limits = { sample: 50, files: 3, fileBytes: 100, totalBytes: 1000 };
  const discovery = { limits: { repos: 100, directories: 4 } };
  const snap = () => takeSnapshot(root, { limits, discovery });
  const first = snap();
  assert.equal(first.untracked_complete, true);
  assert.equal(first.discovery_complete, true);

  const steps = [
    ['a new untracked file', () => write(root, 'notes/a.md', 'a\n')],
    ['an untracked content-only change', () => write(root, 'notes/a.md', 'b\n')],
    ['an untracked secret file', () => write(root, '.env', 'TOKEN=x\n')],
    ['an oversize untracked file', () => write(root, 'big.bin', 'x'.repeat(500))],
    ['untracked files beyond the file budget', () => ['c', 'd', 'e'].forEach((n) => write(root, `${n}.txt`, n))],
    ['an untracked link to a repository', () => linkDirectory(outsideRepo, path.join(root, 'linked'))],
    ['an untracked .git that is not a repository', () => write(root, 'broken/.git', 'garbage\n')],
    ['untracked directories past the scan limit', () => ['d1', 'd2', 'd3', 'd4'].forEach((d) => fs.mkdirSync(path.join(root, d)))],
  ];
  let previous = first;
  for (const [what, step] of steps) {
    step();
    const next = snap();
    assert.equal(next.tracked_key, first.tracked_key, what);
    assert.notDeepEqual(
      [next.untracked_key, next.limitations, next.discovery_complete],
      [previous.untracked_key, previous.limitations, previous.discovery_complete],
      `${what} must show in the untracked key or the coverage`,
    );
    assertValid(next);
    previous = next;
  }
  assert.equal(previous.untracked_complete, false);
  assert.equal(previous.discovery_complete, false);
  assert.ok(previous.limitations.some((l) => l.code === 'scan-limit'));
  assert.equal(previous.reconstructible, false);
});

test('compareSnapshots: tracked change abandons; untracked or coverage change reassesses', (t) => {
  const base = makeTempDir(t);
  const root = makeRepo(path.join(base, 'root'), { 'a.txt': 'a\n' });
  const clean = takeSnapshot(root);
  assert.deepEqual(compareSnapshots(clean, takeSnapshot(root)), {
    tracked: 'equal', untracked: 'equal', coverage: 'equal', action: 'continue', repos: { tracked: [], untracked: [], unverified: [] },
  });

  write(root, 'draft.md', 'v1\n');
  const draft1 = takeSnapshot(root);
  write(root, 'draft.md', 'v2\n'); // content only
  const draft2 = takeSnapshot(root);
  assert.deepEqual(compareSnapshots(draft1, draft2), {
    tracked: 'equal', untracked: 'changed', coverage: 'equal', action: 'reassess', repos: { tracked: [], untracked: ['.'], unverified: [] },
  });

  linkDirectory(makeRepo(path.join(base, 'other')), path.join(root, 'linked'));
  const linked = takeSnapshot(root);
  const coverage = compareSnapshots(draft2, linked);
  assert.equal(coverage.coverage, 'changed');
  assert.equal(coverage.action, 'reassess');

  write(root, 'a.txt', 'tracked edit\n');
  const edited = takeSnapshot(root);
  const tracked = compareSnapshots(linked, edited);
  assert.equal(tracked.tracked, 'changed');
  assert.equal(tracked.action, 'abandon');
  assert.deepEqual(tracked.repos.tracked, ['.']);

  makeRepo(path.join(root, 'web'), {});
  const added = compareSnapshots(edited, takeSnapshot(root));
  assert.equal(added.action, 'abandon', 'a changed repository set is a tracked change (C7)');
  assert.ok(added.repos.tracked.includes('web') && added.repos.untracked.includes('web'));
});

test('compareSnapshots: partial hashing or discovery is unverified, never equal', (t) => {
  const root = makeRepo(makeTempDir(t));
  write(root, 'big.bin', 'x'.repeat(200));
  const limits = { ...UNTRACKED_LIMITS, fileBytes: 100 };
  const a = takeSnapshot(root, { limits });
  write(root, 'big.bin', 'y'.repeat(200)); // a change the snapshot cannot see
  const b = takeSnapshot(root, { limits });
  assert.equal(a.untracked_key, b.untracked_key);
  assert.equal(b.untracked_complete, false);
  const result = compareSnapshots(a, b);
  assert.equal(result.untracked, 'unverified');
  assert.equal(result.action, 'reassess');

  fs.mkdirSync(path.join(root, 'd1'));
  fs.mkdirSync(path.join(root, 'd2'));
  const discovery = { limits: { repos: 100, directories: 1 } };
  const c = takeSnapshot(root, { discovery });
  const d = takeSnapshot(root, { discovery });
  assert.equal(c.discovery_complete, false);
  const partial = compareSnapshots(c, d);
  assert.equal(partial.coverage, 'unverified');
  assert.equal(partial.action, 'reassess');
});

test('untracked-key@2: the integration\'s untracked installed files in the root repository are left out', (t) => {
  const base = makeTempDir(t);
  const root = makeRepo(path.join(base, 'root'), { 'a.txt': 'a\n' });
  write(root, '.claude/skills/nth-review/SKILL.md', 'skill\n');
  write(root, '.claude/skills/nth-review/reference/protocol.md', 'protocol\n');
  write(root, '.claude/nth-dev-kit-hooks/review.state.json', '{}\n');
  const clean = takeSnapshot(root);
  assertValid(clean);
  assert.equal(repoAt(clean, '.').untracked.count, 0);
  assert.equal(clean.reconstructible, true, 'only the integration\'s files: the commit reproduces the tree');

  // Other .claude files, a look-alike directory and a nested repository still count.
  write(root, '.claude/settings.json', '{}\n');
  write(root, '.claude/nth-dev-kit-hooks/other.json', '{}\n');
  write(root, '.claude/skills/nth-review-extra/SKILL.md', 'x\n');
  const web = makeRepo(path.join(root, 'web'));
  write(web, '.claude/skills/nth-review/SKILL.md', 'skill\n');
  const counted = takeSnapshot(root);
  assert.equal(repoAt(counted, '.').untracked.count, 3);
  assert.deepEqual([...repoAt(counted, '.').untracked.sample].sort(), [
    '.claude/nth-dev-kit-hooks/other.json', '.claude/settings.json', '.claude/skills/nth-review-extra/SKILL.md',
  ]);
  assert.equal(repoAt(counted, 'web').untracked.count, 1, 'the exception is for the root repository only');
  assert.equal(counted.reconstructible, false);

  // A snapshot keyed by @1 (same population) compares as changed: reassess, never abandon.
  const legacy = structuredClone(clean);
  legacy.untracked_key = createHash('sha256').update(JSON.stringify(['nth-review/untracked-key@1', legacy.repos.map((r) => [
    r.path, r.untracked.count, r.untracked.list_sha256, r.untracked.content_sha256, r.untracked.hashed,
    ...['secret', 'size', 'budget', 'repository', 'link', 'unreadable'].map((k) => r.untracked.skipped[k]),
  ])])).digest('hex');
  const crossed = compareSnapshots(legacy, clean);
  assert.deepEqual([crossed.tracked, crossed.untracked, crossed.action], ['equal', 'changed', 'reassess']);
});

test('a tracked copy of the integration\'s files is ordinary tracked state', (t) => {
  const root = makeRepo(makeTempDir(t), { 'a.txt': 'a\n', '.claude/skills/nth-review/SKILL.md': 'skill\n' });
  const before = takeSnapshot(root);
  assert.equal(before.reconstructible, true);
  write(root, '.claude/skills/nth-review/SKILL.md', 'edited\n');
  const after = takeSnapshot(root);
  assert.equal(after.reconstructible, false);
  assert.notEqual(repoAt(after, '.').porcelain_sha256, EMPTY_SHA256);
  assert.deepEqual([compareSnapshots(before, after).tracked, compareSnapshots(before, after).action], ['changed', 'abandon']);
});

test('a repository cloned at the integration\'s path is never left out', (t) => {
  const root = makeRepo(makeTempDir(t), { 'a.txt': 'a\n' });
  makeRepo(path.join(root, '.claude/skills/nth-review'), { 'SKILL.md': 'someone else\'s skill\n' });
  const snapshot = takeSnapshot(root);
  const untracked = repoAt(snapshot, '.').untracked;
  assert.deepEqual([untracked.count, untracked.skipped.repository], [1, 1], 'listed by Git as a directory entry, below the discovery depth');
  assert.equal(snapshot.untracked_complete, false);
  assert.equal(snapshot.reconstructible, false);
});

test('a directory name that is not UTF-8 is reported, never scanned, and makes discovery incomplete', (t) => {
  const root = makeRepo(makeTempDir(t));
  const realRoot = fs.realpathSync.native(root);
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, options) => {
    const entries = original(dir, options);
    if (dir === realRoot && options?.encoding === 'buffer') {
      // What a POSIX file system returns for a name with an invalid byte.
      entries.push({ name: Buffer.from([0x62, 0x61, 0x64, 0xff]), isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false });
    }
    return entries;
  });
  const snapshot = takeSnapshot(root);
  assert.deepEqual(snapshot.limitations, [{ code: 'undecodable-directory', path: '.' }]);
  assert.equal(snapshot.discovery_complete, false);
  assert.equal(snapshot.reconstructible, false);
  assertValid(snapshot);
});

test('staged and unstaged digests detect additions, modifications, renames, deletions and mode changes', (t) => {
  const base = makeTempDir(t);
  const cases = [
    ['staged addition', 'staged', (r) => { write(r, 'new.txt', 'n\n'); rawGit(r, ['add', 'new.txt']); }],
    ['staged modification', 'staged', (r) => { write(r, 'a.txt', 'changed\n'); rawGit(r, ['add', 'a.txt']); }],
    ['staged rename', 'staged', (r) => rawGit(r, ['mv', 'a.txt', 'renamed.txt'])],
    ['staged deletion', 'staged', (r) => rawGit(r, ['rm', '-q', 'a.txt'])],
    ['staged mode change', 'staged', (r) => rawGit(r, ['update-index', '--chmod=+x', 'run.sh'])],
    ['unstaged modification', 'unstaged', (r) => write(r, 'a.txt', 'changed\n')],
    ['unstaged deletion', 'unstaged', (r) => fs.rmSync(path.join(r, 'a.txt'))],
    ['unstaged rename', 'unstaged', (r) => fs.renameSync(path.join(r, 'a.txt'), path.join(r, 'renamed.txt'))],
    ['intent-to-add content', 'unstaged', (r) => { write(r, 'ita.txt', 'i\n'); rawGit(r, ['add', '-N', 'ita.txt']); }],
  ];
  cases.forEach(([what, side, change], i) => {
    const root = makeRepo(path.join(base, `r${i}`), { 'a.txt': 'a\n', 'run.sh': 'echo hi\n' });
    assertChangeDetected(root, what, side, change);
  });
  // An intent-to-add file's later content change is still an unstaged change.
  const ita = path.join(base, 'r8');
  const first = takeSnapshot(ita);
  write(ita, 'ita.txt', 'i changed\n');
  assert.notEqual(takeSnapshot(ita).repos[0].unstaged_sha256, first.repos[0].unstaged_sha256);
});

test('an unstaged executable-bit change is detected', { skip: process.platform === 'win32' && 'Windows has no executable bit (core.fileMode is false)' }, (t) => {
  const root = makeRepo(makeTempDir(t), { 'run.sh': 'echo hi\n' });
  rawGit(root, ['config', 'core.fileMode', 'true']);
  assertChangeDetected(root, 'unstaged mode change', 'unstaged', (r) => fs.chmodSync(path.join(r, 'run.sh'), 0o755));
});

function assertChangeDetected(root, what, side, change) {
  const before = takeSnapshot(root);
  change(root);
  const after = takeSnapshot(root);
  assert.notEqual(after.tracked_key, before.tracked_key, what);
  assert.notEqual(after.repos[0][`${side}_sha256`], before.repos[0][`${side}_sha256`], what);
  assert.notEqual(after.repos[0].porcelain_sha256, before.repos[0].porcelain_sha256, what);
  assertValid(after);
}

// Every file below `dir`: relative path, size, mtime and content digest.
function treeState(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      const stats = fs.statSync(file);
      return [path.relative(dir, file), stats.size, stats.mtimeMs, createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
