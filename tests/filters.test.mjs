// Strict read-only Git (owner decision, 2026-10-26): snapshots and change
// sizing never run filter drivers, fsmonitor commands or hooks, never write
// Git metadata or the working tree, and never fetch. Where a comparison would
// need a filter, the result is recorded as unverified. Every fixture is a
// throwaway repository under os.tmpdir(); each test checks the repository
// state before and after, and a raw-git control proves the mechanism would
// otherwise have fired.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { EMPTY_SHA256, compareSnapshots, takeSnapshot } from '../scripts/lib/snapshot.mjs';
import { validateStructure } from '../scripts/lib/schema.mjs';
import { validRecords } from './helpers/records.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, nthr } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';
import { refusePartialCloneOnOldGit } from '../scripts/lib/git.mjs';

const posix = (p) => p.replaceAll('\\', '/');

// Every file below `dir` except .nth-review/: path, size, mtime, digest.
function treeState(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => !path.relative(dir, file).split(path.sep).includes('.nth-review'))
    .map((file) => {
      const stats = fs.statSync(file);
      return `${path.relative(dir, file)} ${stats.size} ${stats.mtimeMs} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    })
    .sort();
}

// Sets a file's times in the past, so a commit leaves it stat-clean (not racy).
const age = (file) => fs.utimesSync(file, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
const touch = (file) => fs.utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

// A logger script: appends its label to the marker file, upper-cases stdin
// to stdout (so a filtered blob differs from the working-tree bytes).
function logger(base) {
  const marker = path.join(base, 'marker.log');
  const script = write(base, 'logger.mjs', [
    "import fs from 'node:fs';",
    'fs.appendFileSync(process.argv[2], `${process.argv[3]}\\n`);',
    "let data = '';",
    "process.stdin.on('data', (c) => { data += c; });",
    "process.stdin.on('end', () => process.stdout.write(data.toUpperCase()));",
    '',
  ].join('\n'));
  const command = (label) => `node "${posix(script)}" "${posix(marker)}" ${label}`;
  const runs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);
  return { command, runs, reset: () => fs.rmSync(marker, { force: true }) };
}

const valid = (snapshot) => assert.deepEqual(validateStructure({ ...validRecords(), snapshot }), []);

test('a custom clean filter never runs; its file is unverified, never silently clean or modified', (t) => {
  const base = makeTempDir(t);
  const log = logger(base);
  const root = makeRepo(path.join(base, 'repo'), { 'plain.txt': 'plain\n' });
  rawGit(root, ['config', 'filter.upper.clean', log.command('clean')]);
  rawGit(root, ['config', 'filter.upper.required', 'true']);
  write(root, '.gitattributes', '*.dat filter=upper\n');
  age(write(root, 'x.dat', 'content\n'));
  commitAll(root); // the real filter stores CONTENT (fixture setup)
  // Control: plain git status runs the filter for a stat-dirty file.
  touch(path.join(root, 'x.dat'));
  log.reset();
  rawGit(root, ['status', '--porcelain']);
  assert.ok(log.runs().includes('clean'), 'control: git status would run the filter');
  age(path.join(root, 'x.dat'));
  rawGit(root, ['update-index', '-q', '--refresh']); // restore a stat-clean, non-racy index (fixture setup)
  log.reset();

  const before = treeState(root);
  const clean = takeSnapshot(root);
  assert.equal(clean.tracked_complete, true);
  assert.equal(clean.reconstructible, true);

  touch(path.join(root, 'x.dat')); // same content, stat-dirty
  const touchedState = treeState(root);
  const touched = takeSnapshot(root);
  assert.deepEqual(touched.repos[0].unverified, { filter: 1, secret: 0, unreadable: 0, sha256: touched.repos[0].unverified.sha256 });
  assert.equal(touched.tracked_complete, false);
  assert.equal(touched.reconstructible, false);
  assert.deepEqual(touched.limitations, [{ code: 'filter-not-run', path: 'x.dat' }]);
  assert.equal(touched.tracked_key, clean.tracked_key, 'the uncertain verdict does not move tracked_key');
  assert.equal(compareSnapshots(clean, touched).tracked, 'unverified');
  assert.equal(compareSnapshots(clean, touched).action, 'reassess');
  valid(touched);

  // The same observed bytes again: proven unchanged in between.
  const again = takeSnapshot(root);
  assert.deepEqual(compareSnapshots(touched, again), {
    tracked: 'equal', untracked: 'equal', coverage: 'equal', action: 'continue', repos: { tracked: [], untracked: [], unverified: [] },
  });

  write(root, 'x.dat', 'edited!\n'); // a real edit of the same size: unverified, never "equal"
  const edited = takeSnapshot(root);
  assert.equal(edited.tracked_key, clean.tracked_key);
  assert.deepEqual(compareSnapshots(again, edited).tracked, 'unverified');
  assert.deepEqual(compareSnapshots(again, edited).repos.unverified, ['.']);

  write(root, 'new.dat', 'untracked\n'); // untracked filtered files are hashed by us
  assert.equal(takeSnapshot(root).repos[0].untracked.hashed, 1);
  const opened = nthr(['new-run', '--ns', 'experiments/filters', '--mode', 'task', '--slug', 'f', '--change', '.'], { cwd: fs.realpathSync.native(root), now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));

  assert.deepEqual(log.runs(), [], 'the filter never ran during snapshots or new-run');
  assert.notDeepEqual(touchedState, before);
  // Nothing outside .nth-review/ changed except the fixture's own edits.
  const final = treeState(root);
  assert.ok(final.every((line) => !line.startsWith(`.git${path.sep}`) || before.includes(line)), 'no file under .git/ changed');
});

const lfsMissing = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8', windowsHide: true }).status !== 0 && 'git-lfs is not installed';

test('git-lfs: the filter-process never runs and stores nothing; edits are unverified', { skip: lfsMissing }, (t) => {
  const root = makeRepo(makeTempDir(t), {});
  // Local configuration only; global and system configuration are untouched.
  rawGit(root, ['config', 'filter.lfs.process', 'git-lfs filter-process']);
  rawGit(root, ['config', 'filter.lfs.required', 'true']);
  write(root, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(4096, 7));
  age(path.join(root, 'big.bin'));
  commitAll(root); // git-lfs stores the object (fixture setup)
  const objects = () => fs.readdirSync(path.join(root, '.git', 'lfs', 'objects'), { recursive: true }).filter((p) => /[0-9a-f]{64}$/.test(p)).length;
  const committed = objects();

  const before = treeState(root);
  const clean = takeSnapshot(root);
  assert.equal(clean.tracked_complete, true);
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(4096, 9)); // same size, new content
  const editedFiles = treeState(root).filter((line) => line.startsWith(`.git${path.sep}`));
  const edited = takeSnapshot(root);
  assert.equal(objects(), committed, 'nothing stored under .git/lfs');
  assert.equal(edited.repos[0].unverified.filter, 1);
  assert.equal(compareSnapshots(clean, edited).tracked, 'unverified');
  const opened = nthr(['new-run', '--ns', 'experiments/lfs', '--mode', 'task', '--slug', 'l', '--change', '.'], { cwd: fs.realpathSync.native(root), now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.equal(objects(), committed, 'change sizing stored nothing either');
  assert.deepEqual(treeState(root).filter((line) => line.startsWith(`.git${path.sep}`)), editedFiles);
  assert.deepEqual(before.filter((line) => line.startsWith(`.git${path.sep}`)), editedFiles);
  // Control: plain git status stores the edited content.
  rawGit(root, ['status', '--porcelain']);
  assert.equal(objects(), committed + 1, 'control: git status would have stored an object');
});

test('fsmonitor commands and hooks never run; the index is never rewritten', (t) => {
  const base = makeTempDir(t);
  const log = logger(base);
  const root = makeRepo(path.join(base, 'repo'), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const hook = write(base, 'hook.sh', `#!/bin/sh\necho "$0" >> "${posix(path.join(base, 'marker.log'))}"\nexit 1\n`);
  fs.chmodSync(hook, 0o755);
  rawGit(root, ['config', 'core.fsmonitor', posix(hook)]);
  const postIndex = write(root, '.git/hooks/post-index-change', `#!/bin/sh\necho post-index-change >> "${posix(path.join(base, 'marker.log'))}"\n`);
  fs.chmodSync(postIndex, 0o755);
  write(root, 'a.txt', 'edited\n');
  touch(path.join(root, 'b.txt'));

  const before = treeState(root);
  const snapshot = takeSnapshot(root);
  const opened = nthr(['new-run', '--ns', 'experiments/hooks', '--mode', 'task', '--slug', 'h', '--change', '.'], { cwd: fs.realpathSync.native(root), now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.deepEqual(log.runs(), [], 'no fsmonitor command or hook ran');
  assert.deepEqual(treeState(root), before, 'no file outside .nth-review/ changed, .git/index included');
  assert.equal(snapshot.tracked_complete, true, 'an ordinary edit stays verified');
  assert.notEqual(snapshot.repos[0].unstaged_sha256, EMPTY_SHA256);

  // Control: plain git diff against the working tree runs both.
  rawGit(root, ['diff', '--numstat', 'HEAD', '--']);
  assert.ok(log.runs().length > 0, `control: git would have run them: ${log.runs()}`);
  assert.ok(log.runs().includes('post-index-change'), 'control: plain git diff rewrites the index');
});

test('a partial clone never fetches: sizing a range with missing objects is refused', (t) => {
  const base = makeTempDir(t);
  const origin = makeRepo(path.join(base, 'origin'), { 'f.txt': 'one\n' });
  rawGit(origin, ['config', 'uploadpack.allowFilter', 'true']);
  write(origin, 'f.txt', 'two\n');
  commitAll(origin, 'two');
  const clone = path.join(base, 'clone');
  rawGit(base, ['-c', 'protocol.file.allow=always', 'clone', '-q', '--filter=blob:none', `file://${posix(origin)}`, clone]);
  const objects = () => rawGit(clone, ['count-objects', '-v']).split('\n').filter((l) => /^(count|in-pack):/.test(l)).join(' ');
  const before = objects();
  const beforeTree = treeState(clone);
  // Git older than 2.44 ignores GIT_NO_LAZY_FETCH, so there the partial clone
  // itself is refused (records.md, snapshot); from 2.44 only the range needing
  // missing objects is.
  const [major, minor] = rawGit(base, ['version']).match(/(\d+)\.(\d+)/).slice(1).map(Number);
  const oldGit = major < 2 || (major === 2 && minor < 44);
  if (!oldGit) takeSnapshot(clone);
  const refused = nthr(['new-run', '--ns', 'experiments/partial', '--mode', 'task', '--slug', 'p', '--change', '.:HEAD~1..HEAD'], { cwd: fs.realpathSync.native(clone), now: at(1) });
  assert.equal(refused.code, EXIT.USAGE, JSON.stringify(refused.json));
  assert.match(refused.json.errors[0], oldGit ? /partial clone .* Git 2\.44 or later is required/ : /cannot size the change/);
  assert.equal(objects(), before, 'no object fetched');
  assert.deepEqual(treeState(clone), beforeTree);
});

test('submodules: their own filter drivers never run; a deep submodule is reported, not assumed clean', (t) => {
  const base = makeTempDir(t);
  const log = logger(base);
  const upstream = makeRepo(path.join(base, 'upstream'), { '.gitattributes': '*.dat filter=subonly\n', 'x.dat': 'content\n' });
  const root = makeRepo(path.join(base, 'root'), { 'r.txt': 'r\n' });
  for (const where of ['libs/near', 'a/b/c/deep']) {
    rawGit(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, where]);
  }
  rawGit(root, ['commit', '-q', '-m', 'submodules']);
  // A filter driver defined only in each submodule's own configuration.
  for (const where of ['libs/near', 'a/b/c/deep']) {
    const dir = path.join(root, ...where.split('/'));
    rawGit(dir, ['config', 'filter.subonly.clean', log.command(`clean:${where}`)]);
    write(dir, 'x.dat', 'edited!\n'); // same size: only content comparison can tell
  }
  // Control: plain git status in the superproject runs both.
  rawGit(root, ['status', '--porcelain']);
  // (how often git re-runs a filter depends on timing; that it runs does not)
  assert.deepEqual([...new Set(log.runs())].sort(), ['clean:a/b/c/deep', 'clean:libs/near'], 'control');
  log.reset();

  const before = treeState(root);
  const snapshot = takeSnapshot(root);
  assert.deepEqual(log.runs(), [], 'no submodule filter ran');
  assert.deepEqual(treeState(root), before);
  assert.deepEqual(snapshot.repos.map((r) => r.path), ['.', 'libs/near']);
  // The discovered submodule is snapshotted on its own, its filter disabled:
  // its touched file is unverified.
  assert.equal(snapshot.repos[1].unverified.filter, 1);
  // The deep one is out of discovery and reported.
  assert.deepEqual(snapshot.limitations, [
    { code: 'submodule-not-covered', path: 'a/b/c/deep' },
    { code: 'filter-not-run', path: 'libs/near/x.dat' },
  ]);
  assert.equal(snapshot.discovery_complete, false);
  valid(snapshot);
  const opened = nthr(['new-run', '--ns', 'experiments/sub', '--mode', 'task', '--slug', 's', '--change', '.', '--change', 'libs/near'], { cwd: fs.realpathSync.native(root), now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.deepEqual(log.runs(), [], 'change sizing ran no submodule filter either');
});

test('review fixes: unverified sizing is conservative; trace output and nameless filter keys are harmless', (t) => {
  const base = makeTempDir(t);
  const log = logger(base);
  const root = makeRepo(path.join(base, 'repo'), { 'plain.txt': 'plain\n' });
  rawGit(root, ['config', 'filter.upper.clean', log.command('clean')]);
  rawGit(root, ['config', 'filter.nameless', 'ignored by git']); // `filter.x`: no driver name
  write(root, '.gitattributes', '*.dat filter=upper\n');
  age(write(root, 'x.dat', 'content\n'));
  commitAll(root);
  write(root, 'x.dat', 'edited!\n'); // same size: an unverified working-tree change
  // A task whose working tree has an unverified filtered file gets the M budget and Opus.
  const trace = path.join(base, 'trace.log');
  const previous = { GIT_TRACE: process.env.GIT_TRACE, GIT_TRACE2: process.env.GIT_TRACE2 };
  process.env.GIT_TRACE = trace;
  process.env.GIT_TRACE2 = trace;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  log.reset();
  const opened = nthr(['new-run', '--ns', 'experiments/size', '--mode', 'task', '--slug', 's', '--change', '.'], { cwd: fs.realpathSync.native(root), now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.equal(opened.json.result.size.verified, false);
  assert.equal(opened.json.result.size.class, 'unverified');
  assert.equal(opened.json.result.budget.lead_tool_calls, 70);
  assert.equal(opened.json.result.required_lead_model, 'opus-high');
  assert.deepEqual(log.runs(), []);
  assert.equal(fs.existsSync(trace), false, 'GIT_TRACE and GIT_TRACE2 are stripped: no trace file written');
});

test('review fixes: a partial clone is refused on Git without GIT_NO_LAZY_FETCH', (t) => {
  const base = makeTempDir(t);
  const origin = makeRepo(path.join(base, 'origin'), { 'f.txt': 'one\n' });
  rawGit(origin, ['config', 'uploadpack.allowFilter', 'true']);
  const clone = path.join(base, 'clone');
  rawGit(base, ['-c', 'protocol.file.allow=always', 'clone', '-q', '--filter=blob:none', `file://${posix(origin)}`, clone]);
  const dir = fs.realpathSync.native(clone);
  assert.throws(() => refusePartialCloneOnOldGit(dir, { version: 'git version 2.39.5 (Apple Git-154)' }), /Git 2\.44 or later is required/);
  assert.doesNotThrow(() => refusePartialCloneOnOldGit(dir, { version: 'git version 2.44.0' }));
  assert.doesNotThrow(() => refusePartialCloneOnOldGit(fs.realpathSync.native(origin), { version: 'git version 2.30.0' }), 'not a partial clone');
});
