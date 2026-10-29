// Finds the repositories a review covers (decision C7): the project root when
// it is a repository, plus every directory up to two levels below it that has
// a `.git` file or directory. It never follows symbolic links or junctions,
// never opens files, and returns no absolute paths in its results.
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_DIR, samePath } from './fsguard.mjs';
import { git } from './git.mjs';
import { repoPathProblem } from './schema.mjs';

export const MAX_DEPTH = 2;
export const DISCOVERY_LIMITS = Object.freeze({ repos: 100, directories: 20_000 });

// Never descended into, at any depth (compared in lower case).
const SKIPPED_DIRS = new Set(['.git', REVIEW_DIR, 'node_modules']);

export class DiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoveryError';
    this.refusal = true; // cli.mjs maps refusals to exit 2
  }
}

// Git's path order: the bytes of the UTF-8 encoding, independent of locale
// and platform.
export function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// `rel`, or its longest prefix that records can store, or '.'.
export function storablePath(rel) {
  const segments = rel.split('/');
  for (let n = segments.length; n > 0; n -= 1) {
    const candidate = segments.slice(0, n).join('/');
    if (repoPathProblem(candidate) === null) return candidate;
  }
  return '.';
}

// Limitations sorted by path, then code, without duplicates.
export function sortLimitations(list) {
  const seen = new Set();
  return list
    .filter(({ code, path: p }) => {
      const key = `${code}\0${p}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => byteCompare(a.path, b.path) || byteCompare(a.code, b.code));
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decodeName(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function hasGitEntry(dir) {
  try {
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

function sameRealPath(a, b, platform) {
  try {
    return samePath(fs.realpathSync.native(a), fs.realpathSync.native(b), platform);
  } catch {
    return false;
  }
}

// Git's view of `dir`, or null when git does not accept `dir` as the top of a
// repository (an invalid `.git`, an empty `.git` that makes git look further
// up, an ownership refusal...).
function inspectRepository(dir, { gitOptions, platform }) {
  const result = git(dir, [
    'rev-parse', '--path-format=absolute',
    '--show-toplevel', '--git-dir', '--git-common-dir', '--show-superproject-working-tree',
  ], gitOptions);
  if (result.status !== 0) return null;
  const [top, gitDir, commonDir, superproject = ''] = result.stdout.toString('utf8').split('\n');
  if (!top || !gitDir || !commonDir || !sameRealPath(top, dir, platform)) return null;
  const head = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], gitOptions);
  return {
    is_worktree: !sameRealPath(gitDir, commonDir, platform),
    is_submodule: superproject.trim() !== '',
    unborn: head.status !== 0,
  };
}

// Returns { root, repos, limitations }:
// - root: the canonical absolute root (for the caller; never stored);
// - repos: [{ path, is_worktree, is_submodule, unborn }], the root ('.')
//   first, then in byte order, with '/' separators;
// - limitations: [{ code, path }], what the discovery could not cover.
export function discoverRepos(root, { limits = DISCOVERY_LIMITS, gitOptions, platform = process.platform } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root must be an absolute path');
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    throw new DiscoveryError('the root does not exist');
  }
  if (!fs.statSync(realRoot).isDirectory()) throw new DiscoveryError('the root is not a directory');

  const repos = [];
  const limitations = [];
  let directories = 0;
  let stopped = false;

  const consider = (rel, abs) => {
    if (rel !== '.' && repoPathProblem(rel) !== null) {
      limitations.push({ code: 'unrepresentable-path', path: storablePath(rel) });
      return;
    }
    const info = inspectRepository(abs, { gitOptions, platform });
    if (!info) {
      limitations.push({ code: 'not-a-repository', path: rel === '.' ? '.' : storablePath(rel) });
      return;
    }
    repos.push({ path: rel, ...info });
    if (repos.length > limits.repos) {
      throw new DiscoveryError(`found more than ${limits.repos} repositories; choose a narrower --root`);
    }
  };

  const visit = (rel, abs, depth) => {
    if (hasGitEntry(abs)) {
      consider(rel, abs);
    } else if (depth === 0) {
      const enclosing = git(abs, ['rev-parse', '--show-toplevel'], gitOptions).status === 0;
      limitations.push({ code: enclosing ? 'enclosing-repository' : 'root-not-a-repository', path: '.' });
    }
    if (depth === MAX_DEPTH) return;

    let entries;
    try {
      // Raw names: a name that is not UTF-8 (POSIX) or holds a lone surrogate
      // (Windows) would otherwise be decoded lossily and silently missed.
      entries = fs.readdirSync(abs, { withFileTypes: true, encoding: 'buffer' });
    } catch (error) {
      if (depth === 0) throw error;
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        limitations.push({ code: 'unreadable-directory', path: storablePath(rel) });
      }
      return; // otherwise it vanished or stopped being a directory
    }
    entries.sort((a, b) => Buffer.compare(a.name, b.name));
    for (const entry of entries) {
      if (stopped) return;
      if (entry.isFile()) continue;
      const name = decodeName(entry.name);
      if (name === null) {
        limitations.push({ code: 'undecodable-directory', path: storablePath(rel) });
        continue;
      }
      if (SKIPPED_DIRS.has(name.toLowerCase())) continue;
      const childRel = rel === '.' ? name : `${rel}/${name}`;
      const childAbs = path.join(abs, name);
      let stats;
      try {
        stats = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) {
        // Junctions are reported as links too. Not followed; reported only
        // when it leads to a repository, which then goes unreviewed.
        if (hasGitEntry(childAbs)) limitations.push({ code: 'symlink-skipped', path: storablePath(childRel) });
        continue;
      }
      if (!stats.isDirectory()) continue;
      directories += 1;
      if (directories > limits.directories) {
        limitations.push({ code: 'scan-limit', path: '.' });
        stopped = true;
        return;
      }
      visit(childRel, childAbs, depth + 1);
    }
  };

  visit('.', realRoot, 0);

  repos.sort((a, b) => (a.path === '.' ? -1 : b.path === '.' ? 1 : byteCompare(a.path, b.path)));
  return { root: realRoot, repos, limitations: sortLimitations(limitations) };
}
