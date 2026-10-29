import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DiscoveryError, byteCompare, discoverRepos, storablePath } from '../scripts/lib/discover.mjs';
import { buildProject, linkDirectory, makeRepo, write } from './helpers/repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const repo = (p, { worktree = false, submodule = false, unborn = false } = {}) => ({
  path: p, is_worktree: worktree, is_submodule: submodule, unborn,
});

const STANDARD = [
  repo('.'),
  repo('api'),
  repo('fresh', { unborn: true }),
  repo('libs/shared', { submodule: true }),
  repo('vendor/lib'),
  repo('wt', { worktree: true }),
];

let base;
let project;
before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-discover-'));
  project = buildProject(base);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('the standard project: root, nested, unborn, submodule, ignored-directory and worktree repositories', () => {
  const result = discoverRepos(project.root);
  assert.deepEqual(result.repos, STANDARD);
  assert.deepEqual(result.limitations, []);
  assert.equal(result.root, fs.realpathSync.native(project.root));
  // Depth 3, .nth-review/ and node_modules/ are not discovered.
  for (const r of result.repos) {
    assert.ok(!r.path.includes('\\') && !path.isAbsolute(r.path), r.path);
    assert.ok(!/^(deep|\.nth-review|node_modules)/.test(r.path), r.path);
  }
});

test('the result is deterministic across calls', () => {
  assert.deepEqual(discoverRepos(project.root), discoverRepos(project.root));
});

test('a root that is not a repository still finds its nested repositories', (t) => {
  const root = makeTempDir(t);
  makeRepo(path.join(root, 'web'));
  makeRepo(path.join(root, 'services', 'api'), {});
  write(root, 'notes.md', 'unversioned\n');
  const result = discoverRepos(root);
  assert.deepEqual(result.repos, [repo('services/api', { unborn: true }), repo('web')]);
  assert.deepEqual(result.limitations, [{ code: 'root-not-a-repository', path: '.' }]);
});

test('a root inside a repository it is not the top of is reported, not adopted', (t) => {
  const outer = makeRepo(path.join(makeTempDir(t), 'outer'));
  const root = path.join(outer, 'packages');
  makeRepo(path.join(root, 'inner'));
  const result = discoverRepos(root);
  assert.deepEqual(result.repos, [repo('inner')]);
  assert.deepEqual(result.limitations, [{ code: 'enclosing-repository', path: '.' }]);
});

test('a .git that git does not accept is reported and skipped', (t) => {
  const root = makeRepo(makeTempDir(t));
  write(root, 'garbage/.git', 'not a gitdir pointer\n');
  fs.mkdirSync(path.join(root, 'empty', '.git'), { recursive: true }); // git would use the root instead
  write(root, 'stale/.git', 'gitdir: ../missing/.git/worktrees/x\n');
  const result = discoverRepos(root);
  assert.deepEqual(result.repos, [repo('.')]);
  assert.deepEqual(result.limitations, [
    { code: 'not-a-repository', path: 'empty' },
    { code: 'not-a-repository', path: 'garbage' },
    { code: 'not-a-repository', path: 'stale' },
  ]);
});

test('symbolic links and junctions are never followed', (t) => {
  const base = makeTempDir(t);
  const root = makeRepo(path.join(base, 'root'));
  const outsideRepo = makeRepo(path.join(base, 'outside-repo'));
  const outsideDir = path.join(base, 'outside-dir');
  makeRepo(path.join(outsideDir, 'hidden'));
  linkDirectory(outsideRepo, path.join(root, 'linked-repo'));
  linkDirectory(outsideDir, path.join(root, 'linked-dir'));
  const result = discoverRepos(root);
  assert.deepEqual(result.repos, [repo('.')]);
  // Only the link that leads straight to a repository is worth reporting.
  assert.deepEqual(result.limitations, [{ code: 'symlink-skipped', path: 'linked-repo' }]);
});

test('non-ASCII names, and git byte order rather than locale order', (t) => {
  const root = makeTempDir(t);
  for (const name of ['ébène', 'alpha/beta', 'alpha-2', 'Zed', 'alpha', 'dự-án', '日本']) {
    makeRepo(path.join(root, ...name.split('/')), {});
  }
  const paths = discoverRepos(root).repos.map((r) => r.path);
  assert.deepEqual(paths, ['Zed', 'alpha', 'alpha-2', 'alpha/beta', 'dự-án', 'ébène', '日本']);
  assert.deepEqual([...paths].sort(byteCompare), paths);
});

test('a repository whose path records cannot store is reported at its nearest storable parent', (t) => {
  const root = makeRepo(makeTempDir(t));
  makeRepo(path.join(root, 'ok', 'has#hash'));
  makeRepo(path.join(root, 'bad#dir', 'inner'));
  const result = discoverRepos(root);
  assert.deepEqual(result.repos, [repo('.')]);
  assert.deepEqual(result.limitations, [
    { code: 'unrepresentable-path', path: '.' },
    { code: 'unrepresentable-path', path: 'ok' },
  ]);
  assert.equal(storablePath('a/b#c/d'), 'a');
  assert.equal(storablePath('#x'), '.');
});

test('root path forms: separators, trailing separator and case give the same result', { skip: process.platform !== 'win32' && 'Windows path forms' }, (t) => {
  const root = makeRepo(makeTempDir(t));
  makeRepo(path.join(root, 'Api'));
  const expected = discoverRepos(root);
  const forms = [
    root.replaceAll('\\', '/'),
    `${root}\\`,
    root.toUpperCase(),
    root[0].toLowerCase() + root.slice(1),
  ];
  for (const form of forms) assert.deepEqual(discoverRepos(form), expected, form);
  assert.deepEqual(expected.repos.map((r) => r.path), ['.', 'Api']);
});

test('on a case-insensitive file system, a .GIT directory is a repository, as it is for git', { skip: process.platform !== 'win32' && 'needs a case-insensitive file system' }, (t) => {
  const root = makeTempDir(t);
  const upper = makeRepo(path.join(root, 'upper'));
  fs.renameSync(path.join(upper, '.git'), path.join(upper, '.GIT'));
  assert.deepEqual(discoverRepos(root).repos, [repo('upper')]);
});

test('limits: too many repositories is a refusal; the directory scan stops deterministically', (t) => {
  const root = makeTempDir(t);
  for (const name of ['a', 'b', 'c']) makeRepo(path.join(root, name), {});
  assert.throws(() => discoverRepos(root, { limits: { repos: 2, directories: 100 } }), (error) => {
    assert.ok(error instanceof DiscoveryError);
    assert.equal(error.refusal, true);
    assert.match(error.message, /more than 2 repositories/);
    return true;
  });
  const limited = discoverRepos(root, { limits: { repos: 100, directories: 2 } });
  assert.deepEqual(limited.repos.map((r) => r.path), ['a', 'b']);
  assert.deepEqual(limited.limitations, [
    { code: 'root-not-a-repository', path: '.' },
    { code: 'scan-limit', path: '.' },
  ]);
});

test('refusals: missing root, a file as root, a relative root', (t) => {
  const dir = makeTempDir(t);
  assert.throws(() => discoverRepos(path.join(dir, 'missing')), DiscoveryError);
  assert.throws(() => discoverRepos(write(dir, 'file.txt', 'x')), DiscoveryError);
  assert.throws(() => discoverRepos('relative/root'), TypeError);
});

test('only allowlisted read-only git commands are spawned, and no file is opened', (t) => {
  const subcommands = new Set();
  const spawn = (command, args, options) => {
    // args: the fixed global options, then the subcommand
    subcommands.add(args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-c'));
    return spawnSync(command, args, options);
  };
  const open = t.mock.method(fs, 'openSync');
  const read = t.mock.method(fs, 'readFileSync');
  discoverRepos(project.root, { gitOptions: { spawn } });
  assert.deepEqual([...subcommands].sort(), ['rev-parse']);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});
