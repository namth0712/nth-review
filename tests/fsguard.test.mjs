import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  FsGuardError,
  ensureDir,
  mkdirExclusive,
  parseNamespace,
  parseRunId,
  resolveReviewPath,
  runDir,
  samePath,
  splitReviewPath,
  writeAtomic,
} from '../scripts/lib/fsguard.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const RUN = '20261025-131201-task-demo';

// A project root plus a sibling "outside" directory with a sentinel file,
// both inside one disposable temp directory.
function sandbox(t) {
  const base = makeTempDir(t, 'nthr-fs-');
  const root = path.join(base, 'project root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'untouched');
  return { base, root, outside };
}

const listTree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

function assertOutsideUntouched(outside) {
  assert.deepEqual(listTree(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
}

function expectGuard(fn, code) {
  assert.throws(fn, (error) => error instanceof FsGuardError && error.code === code && error.refusal === true);
}

// Directory link that needs no privilege on Windows (a junction) and is a
// plain symlink elsewhere.
const dirLink = (target, link) => fs.symlinkSync(target, link, 'junction');

test('valid namespaces map to their kind', () => {
  assert.deepEqual(parseNamespace('experiments/pilot-1'), {
    namespace: 'experiments/pilot-1', prefix: 'experiments', id: 'pilot-1', kind: 'experiment',
  });
  assert.equal(parseNamespace('reviews/main').kind, 'review');
  assert.equal(parseNamespace('audits/a1').kind, 'audit');
  assert.equal(parseNamespace(`experiments/${'a'.repeat(64)}`).id.length, 64);
});

test('hostile and malformed namespaces are refused', () => {
  const bad = [
    '', 'experiments', 'experiments/', 'experiments/x/y', '/experiments/x', 'C:/experiments/x',
    'c:experiments/x', '../experiments/x', 'experiments/../audits/x', 'experiments\\x',
    'Experiments/x', 'experiments/X', 'experiments/-x', 'experiments/x.y', 'experiments/x y',
    'experiments/x_y', 'experiment/x', 'research/x', 'runs/x', `experiments/${'a'.repeat(65)}`,
    'experiments/x\0', 'experiments/é', 'experiments/con', 'experiments/nul', 'experiments/aux',
    'experiments/prn', 'experiments/com1', 'experiments/lpt9', 'audits/clock$', ' experiments/x',
    'experiments/x ', 42, null, undefined, ['experiments', 'x'],
  ];
  for (const ns of bad) expectGuard(() => parseNamespace(ns), 'NAMESPACE_INVALID');
});

test('run ids and run directories', () => {
  assert.deepEqual(parseRunId(RUN), { date: '20261025', time: '131201', mode: 'task', slug: 'demo' });
  assert.equal(parseRunId('20261025-131201-audit-unit-u-07').mode, 'audit-unit');
  assert.equal(runDir('experiments/x', RUN), `experiments/x/runs/${RUN}`);
  for (const id of ['', 'x', '2026-10-25-task-x', '20261025-131201-review-x', '20261025-131201-task-X', '20261025-131201-task-', `20261025-131201-task-a/b`, '20261025-131201-task-..']) {
    expectGuard(() => parseRunId(id), 'RUN_ID_INVALID');
  }
  expectGuard(() => runDir('runs', RUN), 'NAMESPACE_INVALID');
});

test('hostile review-relative paths are refused', () => {
  const cases = [
    ['', 'PATH_INVALID'], ['/abs/x', 'PATH_INVALID'], ['C:/x/y', 'PATH_INVALID'], ['c:x', 'PATH_INVALID'],
    ['\\\\server\\share\\x', 'PATH_INVALID'], ['experiments\\x\\f', 'PATH_INVALID'],
    ['experiments/x/../../outside', 'PATH_INVALID'], ['experiments/x/./f', 'PATH_INVALID'],
    ['experiments/x//f', 'PATH_INVALID'], ['experiments/x/f/', 'PATH_INVALID'],
    ['experiments/x/f\0', 'PATH_INVALID'], ['experiments', 'PATH_INVALID'],
    ['runs/20261025-131201-task-x/records.json', 'NAMESPACE_INVALID'],
    ['research/notes.md', 'NAMESPACE_INVALID'], ['census/x.md', 'NAMESPACE_INVALID'],
    ['experiments/x/records.json:ads', 'PATH_INVALID'], ['experiments/x/CON', 'PATH_INVALID'],
    ['experiments/x/con.json', 'PATH_INVALID'], ['experiments/x/nul.txt', 'PATH_INVALID'],
    ['experiments/x/file.', 'PATH_INVALID'], ['experiments/x/file ', 'PATH_INVALID'],
    ['experiments/x/.hidden', 'PATH_INVALID'], [`experiments/x/${'a'.repeat(129)}`, 'PATH_INVALID'],
    ['experiments/x/dự-án', 'PATH_INVALID'], ['experiments/x/a b', 'PATH_INVALID'],
    ['experiments/x/*', 'PATH_INVALID'], [`experiments/x/${'a/'.repeat(600)}f`, 'PATH_INVALID'],
  ];
  for (const [rel, code] of cases) expectGuard(() => splitReviewPath(rel), code);
  assert.deepEqual(splitReviewPath(`experiments/x/runs/${RUN}/records.json`), ['experiments', 'x', 'runs', RUN, 'records.json']);
});

test('root must be an existing absolute directory', (t) => {
  const { root } = sandbox(t);
  expectGuard(() => resolveReviewPath('relative/root', 'experiments/x'), 'ROOT_INVALID');
  expectGuard(() => resolveReviewPath(path.join(root, 'missing'), 'experiments/x'), 'ROOT_INVALID');
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'x');
  expectGuard(() => resolveReviewPath(file, 'experiments/x'), 'ROOT_INVALID');
});

test('ensureDir creates components one by one and is idempotent', (t) => {
  const { root, outside } = sandbox(t);
  const dir = ensureDir(root, `experiments/x/runs`);
  assert.equal(dir, path.join(fs.realpathSync.native(root), '.nth-review', 'experiments', 'x', 'runs'));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.equal(ensureDir(root, 'experiments/x/runs'), dir);
  assertOutsideUntouched(outside);
});

test('an existing file where a directory is expected is refused', (t) => {
  const { root } = sandbox(t);
  fs.writeFileSync(path.join(root, '.nth-review'), 'not a directory');
  expectGuard(() => ensureDir(root, 'experiments/x'), 'NOT_DIRECTORY');
});

test('mkdirExclusive creates once and refuses an existing directory', (t) => {
  const { root } = sandbox(t);
  const rel = runDir('experiments/x', RUN);
  const dir = mkdirExclusive(root, rel);
  assert.ok(fs.statSync(dir).isDirectory());
  expectGuard(() => mkdirExclusive(root, rel), 'EXISTS');
  expectGuard(() => mkdirExclusive(root, 'experiments/x'), 'PATH_INVALID');
});

test('writeAtomic writes UTF-8 without BOM, replaces files, leaves no temp files', (t) => {
  const { root, outside } = sandbox(t);
  const rel = `${runDir('experiments/x', RUN)}/records.json`;
  const file = writeAtomic(root, rel, '{"a":"dự án"}\n');
  assert.deepEqual(fs.readFileSync(file), Buffer.from('{"a":"dự án"}\n', 'utf8'));
  writeAtomic(root, rel, Buffer.from('second'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['records.json']);
  assert.throws(() => writeAtomic(root, rel, 42), TypeError);
  assertOutsideUntouched(outside);
});

test('an interrupted atomic write leaves the previous file intact', (t) => {
  const { root } = sandbox(t);
  const rel = `${runDir('experiments/x', RUN)}/records.json`;
  const file = writeAtomic(root, rel, 'previous');
  const failingRename = () => { throw Object.assign(new Error('simulated crash'), { code: 'EIO' }); };
  assert.throws(() => writeAtomic(root, rel, 'next', { rename: failingRename }), /simulated crash/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['records.json']);
});

test('writing over a directory is refused and the directory survives', (t) => {
  const { root } = sandbox(t);
  const rel = `${runDir('experiments/x', RUN)}/records.json`;
  ensureDir(root, rel);
  expectGuard(() => writeAtomic(root, rel, 'x'), 'NOT_FILE');
  assert.ok(fs.statSync(resolveReviewPath(root, rel, { expectDirectory: true })).isDirectory());
});

test('traversal cannot reach outside .nth-review', (t) => {
  const { root, outside } = sandbox(t);
  const before = listTree(root);
  for (const rel of ['experiments/x/../../../outside/sentinel.txt', '../outside/sentinel.txt', '/tmp/x', 'C:/x/y']) {
    assert.throws(() => writeAtomic(root, rel, 'evil'), FsGuardError);
  }
  assert.deepEqual(listTree(root), before);
  assertOutsideUntouched(outside);
});

test('a junction or symlink at any component is refused, nothing is written outside', (t) => {
  for (const linkAt of ['.nth-review', '.nth-review/experiments', '.nth-review/experiments/x', `.nth-review/experiments/x/runs/${RUN}`]) {
    const { root, outside } = sandbox(t);
    const linkPath = path.join(root, ...linkAt.split('/'));
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    dirLink(outside, linkPath);
    const rel = `${runDir('experiments/x', RUN)}/records.json`;
    expectGuard(() => writeAtomic(root, rel, 'evil'), 'SYMLINK');
    expectGuard(() => ensureDir(root, `experiments/x/runs/${RUN}`), 'SYMLINK');
    assertOutsideUntouched(outside);
  }
});

test('a symlinked leaf file is refused (skipped where symlinks need privileges)', (t) => {
  const { root, outside } = sandbox(t);
  const rel = `${runDir('experiments/x', RUN)}/records.json`;
  ensureDir(root, runDir('experiments/x', RUN));
  const leaf = resolveReviewPath(root, rel);
  try {
    fs.symlinkSync(path.join(outside, 'sentinel.txt'), leaf, 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('file symlinks need a privilege on this machine');
    throw error;
  }
  expectGuard(() => writeAtomic(root, rel, 'evil'), 'SYMLINK');
  assertOutsideUntouched(outside);
});

test('a directory symlink (not a junction) is refused (skipped where symlinks need privileges)', (t) => {
  const { root, outside } = sandbox(t);
  try {
    fs.symlinkSync(outside, path.join(root, '.nth-review'), 'dir');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('directory symlinks need a privilege on this machine');
    throw error;
  }
  expectGuard(() => ensureDir(root, 'experiments/x'), 'SYMLINK');
  assertOutsideUntouched(outside);
});

test('case-insensitive comparison follows the platform', (t) => {
  const { root } = sandbox(t);
  fs.mkdirSync(path.join(root, '.nth-review', 'EXPERIMENTS', 'x'), { recursive: true });
  const lower = path.join(root, '.nth-review', 'experiments');
  if (!fs.existsSync(lower)) return t.skip('case-sensitive file system: same-name check not applicable');
  // On a case-insensitive file system the differently cased directory is the
  // same place: accepted for win32/darwin, refused when compared exactly.
  assert.ok(resolveReviewPath(root, 'experiments/x', { expectDirectory: true, platform: 'win32' }));
  assert.ok(resolveReviewPath(root, 'experiments/x', { expectDirectory: true, platform: 'darwin' }));
  expectGuard(() => resolveReviewPath(root, 'experiments/x', { expectDirectory: true, platform: 'linux' }), 'ESCAPE');
});

test('M3-T8 platform logic, independent of the host: containment case rules and device names under win32, darwin and linux', (t) => {
  // Containment compares case-insensitively on win32 and darwin, exactly on linux.
  const a = path.join('Root', '.nth-review', 'Experiments', 'x');
  const b = path.join('root', '.nth-review', 'experiments', 'X');
  assert.equal(samePath(a, b, 'win32'), true);
  assert.equal(samePath(a, b, 'darwin'), true);
  assert.equal(samePath(a, b, 'linux'), false);
  assert.equal(samePath(a, a, 'linux'), true);
  // Windows device names are refused under every platform, so records stay portable.
  const { root } = sandbox(t);
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const rel of ['experiments/x/con', 'experiments/x/runs/nul.json', 'experiments/x/packs/COM1.md', 'experiments/x/LPT9.txt']) {
      expectGuard(() => resolveReviewPath(root, rel, { platform }), 'PATH_INVALID');
    }
    assert.ok(resolveReviewPath(root, 'experiments/x/console.md', { platform }), `${platform}: a longer name is not a device`);
  }
});
