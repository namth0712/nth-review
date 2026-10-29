// Test-only fixture builders for multi-repository projects. They use rawGit
// (tests/helpers/tmp.mjs), never the production wrapper.
import fs from 'node:fs';
import path from 'node:path';
import { initRepo, rawGit } from './tmp.mjs';

// Writes `content` at the '/'-separated `rel` below `dir`, creating parents.
export function write(dir, rel, content) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// The identity is passed on the command line, so a repository Git created
// itself (a submodule clone) commits without a global identity, as on a fresh machine.
export function commitAll(dir, message = 'commit') {
  rawGit(dir, ['add', '-A']);
  rawGit(dir, ['-c', 'user.name=nthr-test', '-c', 'user.email=nthr@test.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

// A repository at `dir` with `files` committed (none: an unborn repository).
export function makeRepo(dir, files = { 'README.md': 'readme\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  initRepo(dir);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  if (Object.keys(files).length > 0) commitAll(dir, 'initial');
  return dir;
}

// A directory link that needs no privilege on Windows (a junction).
export function linkDirectory(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

// The standard project used by the discovery and snapshot tests:
//   .               root repository (`vendor/` ignored)
//   api             nested repository
//   fresh           unborn repository
//   libs/shared     submodule of the root
//   vendor/lib      repository inside an ignored directory
//   wt              linked worktree of the root
// and repositories that must NOT be discovered:
//   deep/er/est     depth 3
//   .nth-review/x   review directory
//   node_modules/m  node_modules
export function buildProject(base) {
  const root = makeRepo(path.join(base, 'project'), { 'README.md': 'root\n', '.gitignore': 'vendor/\n' });
  makeRepo(path.join(root, 'api'), { 'src/index.js': 'export {};\n' });
  makeRepo(path.join(root, 'fresh'), {});
  const upstream = makeRepo(path.join(base, 'upstream'), { 'lib.js': 'module.exports = 1;\n' });
  rawGit(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'libs/shared']);
  rawGit(root, ['commit', '-q', '-m', 'add submodule']); // only what `submodule add` staged
  rawGit(root, ['worktree', 'add', '-q', '-b', 'feature', path.join(root, 'wt')]);
  makeRepo(path.join(root, 'vendor', 'lib'));
  makeRepo(path.join(root, 'deep', 'er', 'est'));
  makeRepo(path.join(root, '.nth-review', 'x'));
  makeRepo(path.join(root, 'node_modules', 'm'));
  return { root, upstream };
}
