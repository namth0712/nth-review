// The snapshot of every discovered repository (decision C6, as adjusted in
// reference/records.md):
// - tracked state: HEAD, branch, `git status` entries, and the staged and
//   unstaged change sets with content identities. `tracked_key` compares it.
// - flagged files: tracked files marked assume-unchanged or skip-worktree,
//   which `status` never compares, by their own observed content (`flagged`,
//   since tracked-key@3), within fixed limits. Part of `tracked_key`.
// - untracked files: names (count, list digest, sample) and, within fixed
//   limits, content, with explicit counts of every file whose content was
//   not hashed.
// It never writes, never follows symbolic links or junctions, and never opens
// a file whose name looks like a secret (isSecretPath).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DiscoveryError, byteCompare, discoverRepos, sortLimitations, storablePath } from './discover.mjs';
import { REVIEW_DIR, isIntegrationPath } from './fsguard.mjs';
import { GitExecutionError, filterDriversOf, git, refusePartialCloneOnOldGit } from './git.mjs';
import { EMPTY_SHA256, INCOMPLETE_DISCOVERY, repoPathProblem } from './schema.mjs';

export { EMPTY_SHA256 };

export const UNTRACKED_LIMITS = Object.freeze({
  sample: 50, // paths kept in untracked.sample
  files: 5_000, // untracked files examined for content, across all repositories
  fileBytes: 1024 * 1024, // larger files are counted as skipped.size
  totalBytes: 64 * 1024 * 1024, // content read across all repositories
});
// Flagged files (assume-unchanged, skip-worktree) read for content: a budget
// of its own, so it never changes what the untracked budget covers.
export const FLAGGED_LIMITS = Object.freeze({
  files: 5_000, // flagged files read, across all repositories
  fileBytes: 1024 * 1024, // larger files are counted as skipped.size
  totalBytes: 64 * 1024 * 1024, // content read across all repositories
});
export const MAX_LIMITATIONS = 100;
// @3: flagged files by observed content. @2: unverified entries left out,
// submodules by commit only (strict read-only Git).
const TRACKED_KEY_VERSION = 'nth-review/tracked-key@3';
// Snapshots written before @3 have no `flagged`: compared on the @2 fields.
const LEGACY_TRACKED_KEY_VERSION = 'nth-review/tracked-key@2';
const CHUNK = 64 * 1024;
const NUL = Buffer.from([0]);
const SPACE = 0x20;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------- secrets

// File names (case-insensitive, `*` = any characters) and directory names
// whose content nth-review never reads. Matching files are still counted and
// listed by name.
export const SECRET_NAMES = Object.freeze([
  '.env', '.env.*', '*.env', '.envrc',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx', '*.gpg',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.htpasswd', '.git-credentials',
  'credentials', 'credentials.*', 'secrets.*', '*.secret', '*.secrets',
  '*.tfvars', '*.tfstate', '*.tfstate.*',
]);
export const SECRET_DIRS = Object.freeze(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);

const SECRET_NAME = new RegExp(
  `^(?:${SECRET_NAMES.map((glob) => glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')).join('|')})$`,
  'is',
);
const SECRET_DIR = new Set(SECRET_DIRS);

// `rel` is a '/'-separated path inside a repository.
export function isSecretPath(rel) {
  const segments = rel.split('/');
  const name = segments.pop();
  return SECRET_NAME.test(name) || segments.some((segment) => SECRET_DIR.has(segment.toLowerCase()));
}

// ---------------------------------------------------------------- helpers

export function gitBytes(dir, args, gitOptions) {
  const result = git(dir, args, gitOptions);
  if (result.status !== 0) {
    throw new GitExecutionError(`git ${args[0]} exited ${result.status}: ${result.stderr.toString('utf8').trim()}`);
  }
  return result.stdout;
}

export function splitNul(buffer) {
  const records = [];
  let start = 0;
  for (let i = buffer.indexOf(0); i !== -1; i = buffer.indexOf(0, start)) {
    records.push(buffer.subarray(start, i));
    start = i + 1;
  }
  if (start < buffer.length) records.push(buffer.subarray(start));
  return records;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decode(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null; // not UTF-8 (possible on POSIX file systems)
  }
}

const isReviewPath = (rel) => rel.split('/')[0].toLowerCase() === REVIEW_DIR;
const projectPath = (repoPath, rel) => (repoPath === '.' ? rel : `${repoPath}/${rel}`);

// ---------------------------------------------------------------- file identity

// Classifies a working-tree path without following links. Directories on the
// way are checked once each (`dirs` caches them): a path reached through a
// symbolic link or junction is never opened.
export function probe(repoDir, rel, dirs) {
  const segments = rel.split('/');
  let dir = repoDir;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    if (!dirs.has(dir)) {
      let state = 'unreadable';
      try {
        const stats = fs.lstatSync(dir);
        state = stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'ok' : 'unreadable';
      } catch (error) {
        state = error.code === 'ENOENT' ? 'absent' : 'unreadable';
      }
      dirs.set(dir, state);
    }
    if (dirs.get(dir) !== 'ok') return { state: dirs.get(dir) };
  }
  const abs = path.join(repoDir, ...segments);
  let stats;
  try {
    stats = fs.lstatSync(abs, { bigint: true });
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (stats.isSymbolicLink()) return { state: 'symlink', abs, size: Number(stats.size) };
  if (stats.isFile()) return { state: 'file', abs, stats, size: Number(stats.size) };
  return { state: 'unreadable' };
}

// [id, bytesRead]. id is 'l:<sha256 of the link text>', 'f:<sha256 of the
// bytes>', 'size' when the file is (or grew) larger than maxBytes, or null
// when it cannot be read as the same regular file that was probed. At most
// maxBytes + 1 bytes are read.
function identity(probed, maxBytes = Infinity) {
  if (probed.state === 'symlink') {
    try {
      const target = fs.readlinkSync(probed.abs, { encoding: 'buffer' });
      return [`l:${sha256(target)}`, target.length];
    } catch {
      return [null, 0];
    }
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = fs.openSync(probed.abs, flags);
  } catch {
    return [null, 0];
  }
  let total = 0;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== probed.stats.ino || opened.dev !== probed.stats.dev) return [null, 0];
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, Math.min(CHUNK, maxBytes + 1 - total), null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return ['size', total];
      hash.update(buffer.subarray(0, n));
    }
    return [`f:${hash.digest('hex')}`, total];
  } catch {
    return [null, total];
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- tracked state

// `git status` entries (type 1 and u) with the fields the snapshot needs,
// optionally limited to `pathspecs`.
export function readStatus(repoDir, gitOptions, pathspecs = [], { includeReview = false } = {}) {
  const out = gitBytes(repoDir, [
    'status', '--porcelain=v2', '-z', '--branch', '--no-renames',
    // `dirty`: never run git inside submodules, where filter drivers from
    // their own configuration would not be disabled. A discovered submodule
    // has its own snapshot; any other is reported (submodule-not-covered).
    '--untracked-files=no', '--ignore-submodules=dirty',
    ...(pathspecs.length ? ['--', ...pathspecs] : []),
  ], gitOptions);
  let head = null;
  let branch = null;
  const entries = [];
  for (const raw of splitNul(out)) {
    if (raw[0] === 0x23 /* # */) {
      const header = raw.toString('utf8');
      if (header.startsWith('# branch.oid ')) {
        const oid = header.slice('# branch.oid '.length);
        head = oid === '(initial)' ? null : oid;
      } else if (header.startsWith('# branch.head ')) {
        const name = header.slice('# branch.head '.length);
        branch = name === '(detached)' ? null : name;
      }
      continue;
    }
    const type = String.fromCharCode(raw[0]);
    const fieldsBeforePath = type === '1' ? 8 : type === 'u' ? 10 : -1;
    if (fieldsBeforePath === -1) throw new GitExecutionError(`unexpected git status entry type ${JSON.stringify(type)}`);
    let offset = 0;
    for (let i = 0; i < fieldsBeforePath; i += 1) {
      offset = raw.indexOf(SPACE, offset) + 1;
      if (offset === 0) throw new GitExecutionError('malformed git status entry');
    }
    const fields = raw.subarray(0, offset - 1).toString('latin1').split(' ');
    const pathBytes = raw.subarray(offset);
    const rel = decode(pathBytes);
    if (!includeReview && rel !== null && isReviewPath(rel)) continue;
    entries.push({ raw, type, fields, pathBytes, rel, x: fields[1][0], y: fields[1][1], sub: fields[2], worktreeMode: fields[type === '1' ? 5 : 6] });
  }
  entries.sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
  return { head, branch, entries };
}

function digest(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

// Filter drivers never run (git.mjs disables them), so git's working-tree
// verdict for a file with a configured `filter` attribute compares raw bytes
// with a cleaned blob: a reported modification is uncertain. Returns the
// status entries in that position.
function filterUncertain(repoDir, entries, drivers, gitOptions) {
  const uncertain = new Set();
  if (drivers.length === 0) return uncertain;
  const configured = new Set(drivers);
  const candidates = entries.filter((e) => e.type === '1' && (e.y === 'M' || e.y === 'T') && !e.sub.startsWith('S'));
  const byPath = new Map();
  for (const entry of candidates) {
    if (entry.rel === null) uncertain.add(entry); // cannot be asked about: uncertain
    else byPath.set(entry.rel, entry);
  }
  const paths = [...byPath.keys()];
  for (let i = 0; i < paths.length;) {
    const batch = [];
    for (let length = 0; i < paths.length && (batch.length === 0 || length + paths[i].length < 8_000); i += 1) {
      batch.push(paths[i]);
      length += paths[i].length + 1;
    }
    const out = gitBytes(repoDir, ['check-attr', '-z', 'filter', '--', ...batch], gitOptions).toString('utf8').split('\0');
    for (let j = 0; j + 2 < out.length; j += 3) {
      if (configured.has(out[j + 2]) && byPath.has(out[j])) uncertain.add(byPath.get(out[j]));
    }
  }
  return uncertain;
}

// The status entry as git would print it for a file whose working tree it
// did not compare: no unstaged flag, working-tree mode equal to the index.
function withoutWorktreeSide(entry) {
  const fields = [...entry.fields];
  fields[1] = `${entry.x}.`;
  fields[5] = fields[4];
  return Buffer.concat([Buffer.from(`${fields.join(' ')} `, 'latin1'), entry.pathBytes]);
}

// The working-tree side of one entry with an unstaged change.
function worktreeIdentity(repo, repoDir, entry, dirs, limitations, gitOptions) {
  if (entry.sub.startsWith('S')) {
    // A submodule: its checked-out commit. Its own files are covered when it
    // is one of the discovered repositories.
    const where = storablePath(entry.rel === null ? repo.path : projectPath(repo.path, entry.rel));
    if (entry.y === 'D') return '-';
    const state = entry.rel === null ? 'unreadable' : probe(repoDir, `${entry.rel}/.git`, dirs).state;
    if (state === 'absent') return 'S:absent'; // not checked out: nothing to read
    if (state !== 'link') {
      try {
        const result = git(path.join(repoDir, ...entry.rel.split('/')), ['rev-parse', '--verify', '--quiet', 'HEAD'], gitOptions);
        if (result.status === 0) return `S:${result.stdout.toString('utf8').trim()}`;
      } catch {
        // could not be read: unverified below
      }
    }
    limitations.push({ code: 'file-not-hashed', path: where });
    return state === 'link' ? 'S:link' : 'S:unreadable'; // never run git through a link
  }
  if (entry.y === 'D') return '-';
  const where = entry.rel === null ? storablePath(repo.path) : storablePath(projectPath(repo.path, entry.rel));
  if (entry.rel !== null && isSecretPath(entry.rel)) {
    limitations.push({ code: 'secret-not-hashed', path: where });
    return 'secret';
  }
  const probed = entry.rel === null ? { state: 'unreadable' } : probe(repoDir, entry.rel, dirs);
  if (probed.state === 'absent') return '-';
  const [id] = probed.state === 'file' || probed.state === 'symlink' ? identity(probed) : [null];
  if (id === null) {
    limitations.push({ code: 'file-not-hashed', path: where });
    return probed.state === 'link' ? 'link' : 'unreadable';
  }
  return id;
}

// ---------------------------------------------------------------- untracked

function readUntracked(repo, repoDir, nested, budget, limits, gitOptions) {
  const listed = splitNul(gitBytes(repoDir, ['ls-files', '--others', '--exclude-standard', '-z'], gitOptions));
  const entries = listed
    .map((bytes) => ({ bytes, rel: decode(bytes) }))
    .filter(({ rel }) => rel === null || (!isReviewPath(rel) && !isIntegrationPath(repo.path, rel) && !nested.has(rel)))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes));

  const list = createHash('sha256');
  const content = createHash('sha256');
  const skipped = { secret: 0, size: 0, budget: 0, repository: 0, link: 0, unreadable: 0 };
  const sample = [];
  const dirs = new Map();
  let hashed = 0;

  for (const { bytes, rel } of entries) {
    list.update(bytes);
    list.update(NUL);
    if (rel !== null && !rel.endsWith('/') && sample.length < limits.sample) {
      const shown = projectPath(repo.path, rel);
      if (repoPathProblem(shown) === null) sample.push(shown);
    }

    // Classified without I/O first; only then does a file use the budget.
    let reason = null;
    if (rel === null) reason = 'unreadable';
    else if (rel.endsWith('/')) reason = 'repository'; // a repository git does not descend into
    else if (isSecretPath(rel)) reason = 'secret';
    else if (budget.files <= 0) reason = 'budget';
    if (reason) {
      skipped[reason] += 1;
      continue;
    }

    budget.files -= 1;
    const probed = probe(repoDir, rel, dirs);
    if (probed.state === 'link') reason = 'link';
    else if (probed.state !== 'file' && probed.state !== 'symlink') reason = 'unreadable';
    else if (probed.size > limits.fileBytes) reason = 'size';
    else if (probed.size > budget.bytes) reason = 'budget';
    if (reason) {
      skipped[reason] += 1;
      continue;
    }
    const [id, read] = identity(probed, Math.min(limits.fileBytes, budget.bytes));
    budget.bytes = Math.max(0, budget.bytes - read);
    if (id === null || id === 'size') {
      skipped[id === 'size' ? 'size' : 'unreadable'] += 1;
      continue;
    }
    hashed += 1;
    content.update(bytes);
    content.update(NUL);
    content.update(id);
    content.update(NUL);
  }

  return {
    count: entries.length,
    list_sha256: list.digest('hex'),
    sample,
    content_sha256: content.digest('hex'),
    hashed,
    skipped,
  };
}

// ---------------------------------------------------------------- flagged

// Index entries git is told not to compare with the working tree, so that
// `status` never reports an edit to them: assume-unchanged (a lower-case
// `ls-files -v` tag) and skip-worktree (`S`, or `s` with both). Shared by the
// snapshot and `fresh`. Sorted by path bytes; review records are left out.
// [{ pathBytes, rel (null when not UTF-8), tag, skipWorktree }]
export function readFlagged(repoDir, gitOptions) {
  const flagged = [];
  for (const record of splitNul(gitBytes(repoDir, ['ls-files', '-v', '-z'], gitOptions))) {
    const tag = String.fromCharCode(record[0]);
    if (tag !== 'S' && tag === tag.toUpperCase()) continue;
    const pathBytes = record.subarray(2);
    const rel = decode(pathBytes);
    if (rel !== null && isReviewPath(rel)) continue;
    flagged.push({ pathBytes, rel, tag, skipWorktree: tag.toUpperCase() === 'S' });
  }
  return flagged.sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
}

// The observed state of one repository's flagged files. Each is read as raw
// bytes (no git conversion, so no filter can run), within the shared budget;
// one that is not read is counted, never assumed unchanged. The digest covers
// flag, observed state and path, so a content edit, a flag change, an
// appearance or a deletion all change it.
function readFlaggedState(repo, repoDir, dirs, budget, limits, limitations, gitOptions) {
  const skipped = { secret: 0, size: 0, budget: 0, link: 0, unreadable: 0 };
  let hashed = 0;
  let missing = 0;
  let sparse = 0;
  const parts = [];
  const entries = readFlagged(repoDir, gitOptions);
  // The executable bit is tracked state where git tracks it (core.fileMode,
  // which git defaults to true): `status` would show a chmod, so does this.
  let fileMode;
  const tracksMode = () => {
    if (fileMode === undefined) {
      const out = git(repoDir, ['config', '--get', 'core.fileMode'], gitOptions);
      fileMode = !(out.status === 0 && /^(false|no|off|0)$/i.test(out.stdout.toString('utf8').trim()));
    }
    return fileMode;
  };
  for (const { pathBytes, rel, tag, skipWorktree } of entries) {
    const probed = rel === null ? null : probe(repoDir, rel, dirs);
    let token;
    if (rel === null) token = 'unreadable';
    else if (probed.state === 'absent') token = skipWorktree ? 'sparse' : 'missing'; // a sparse checkout, or a deletion
    else if (probed.state === 'link') token = 'link';
    else if (isSecretPath(rel)) token = 'secret'; // never opened
    else if (probed.state !== 'file' && probed.state !== 'symlink') token = 'unreadable';
    else if (budget.files <= 0) token = 'budget';
    else if (probed.size > limits.fileBytes) token = 'size';
    else if (probed.size > budget.bytes) token = 'budget';
    else {
      budget.files -= 1;
      const [id, read] = identity(probed, Math.min(limits.fileBytes, budget.bytes));
      budget.bytes = Math.max(0, budget.bytes - read);
      token = id ?? 'unreadable';
      if (token.startsWith('f:') && (Number(probed.stats.mode) & 0o111) !== 0 && tracksMode()) token += ':x';
    }
    if (token === 'sparse') sparse += 1;
    else if (token === 'missing') missing += 1;
    else if (token.startsWith('f:') || token.startsWith('l:')) hashed += 1;
    else {
      skipped[token] += 1;
      limitations.push({ code: 'flagged-not-hashed', path: rel === null ? storablePath(repo.path) : storablePath(projectPath(repo.path, rel)) });
    }
    parts.push(Buffer.from(`${tag} ${token} `), pathBytes, NUL);
  }
  return { count: entries.length, sha256: digest(parts), hashed, missing, sparse, skipped };
}

// ---------------------------------------------------------------- snapshot

const UNOBSERVED ={ secret: 'secret', unreadable: 'unreadable', link: 'unreadable', 'S:link': 'unreadable', 'S:unreadable': 'unreadable' };

function snapshotRepo(repo, realRoot, allRepos, budget, limits, limitations, gitOptions, flagged) {
  const repoDir = repo.path === '.' ? realRoot : path.join(realRoot, ...repo.path.split('/'));
  refusePartialCloneOnOldGit(repoDir, gitOptions);
  const options = { ...gitOptions, filterDrivers: filterDriversOf(repoDir, gitOptions) };
  const { head, branch, entries } = readStatus(repoDir, options);
  const uncertain = filterUncertain(repoDir, entries, options.filterDrivers, options);
  const dirs = new Map();

  // Tracked entries go into the tracked digests only as far as they are
  // verified. Entries whose working-tree content was not observed (secret,
  // unreadable) or whose comparison needed a filter are counted here, never
  // silently treated as clean or modified.
  const tracked = [];
  const unstaged = [];
  const unverified = { filter: 0, secret: 0, unreadable: 0 };
  const unverifiedParts = [];
  for (const entry of entries) {
    const isUncertain = uncertain.has(entry);
    if (!isUncertain) tracked.push(entry.raw);
    else if (entry.x !== '.') tracked.push(withoutWorktreeSide(entry)); // the staged side is still verified
    if (entry.y === '.') continue;
    const id = worktreeIdentity(repo, repoDir, entry, dirs, limitations, options);
    const reason = UNOBSERVED[id] ?? (isUncertain ? 'filter' : null);
    if (reason) {
      unverified[reason] += 1;
      unverifiedParts.push(Buffer.from(`${reason} ${id} `), entry.pathBytes, NUL);
    }
    if (reason === 'filter') {
      limitations.push({ code: 'filter-not-run', path: entry.rel === null ? storablePath(repo.path) : storablePath(projectPath(repo.path, entry.rel)) });
    }
    if (!isUncertain) unstaged.push(Buffer.from(`${entry.y} ${entry.worktreeMode} ${id} `), entry.pathBytes, NUL);
  }

  // Discovered repositories below this one are snapshotted on their own;
  // git lists them here as untracked `dir/` entries.
  const prefix = repo.path === '.' ? '' : `${repo.path}/`;
  const nested = new Set(
    allRepos.filter((r) => r !== repo && r.path !== '.' && r.path.startsWith(prefix)).map((r) => `${r.path.slice(prefix.length)}/`),
  );

  // Status ignores submodule working trees (`--ignore-submodules=dirty`), so
  // a checked-out submodule that is not one of the discovered repositories
  // would go unchecked: report it. Every repository pays for the index
  // listing: a gitlink committed without a .gitmodules entry (`git add` of an
  // embedded repository) is a submodule in the index all the same.
  {
    const discovered = new Set(allRepos.map((r) => r.path));
    for (const record of splitNul(gitBytes(repoDir, ['ls-files', '--stage', '-z'], options))) {
      if (!record.subarray(0, 7).equals(Buffer.from('160000 '))) continue;
      const rel = decode(record.subarray(record.indexOf(0x09 /* tab */) + 1));
      if (rel === null) { // cannot be located: reported at the repository
        limitations.push({ code: 'submodule-not-covered', path: storablePath(repo.path) });
        continue;
      }
      const submodule = projectPath(repo.path, rel);
      const checkedOut = probe(repoDir, `${rel}/.git`, dirs).state !== 'absent';
      if (checkedOut && !discovered.has(submodule)) limitations.push({ code: 'submodule-not-covered', path: storablePath(submodule) });
    }
  }

  return {
    path: repo.path,
    head,
    branch,
    unborn: head === null,
    is_worktree: repo.is_worktree,
    is_submodule: repo.is_submodule,
    porcelain_sha256: digest(tracked.flatMap((raw) => [raw, NUL])),
    staged_sha256: digest(tracked.filter((raw) => raw[2] !== 0x2e /* X is not '.' */).flatMap((raw) => [raw, NUL])),
    unstaged_sha256: digest(unstaged),
    unverified: { ...unverified, sha256: digest(unverifiedParts) },
    flagged: readFlaggedState(repo, repoDir, dirs, flagged.budget, flagged.limits, limitations, options),
    untracked: readUntracked(repo, repoDir, nested, budget, limits, options),
  };
}

const SKIP_REASONS = ['secret', 'size', 'budget', 'repository', 'link', 'unreadable'];
// @2: the population leaves out this integration's untracked installed files
// (isIntegrationPath). A key from @1 compares as changed: reassess, never abandon.
const UNTRACKED_KEY_VERSION = 'nth-review/untracked-key@2';

// What tracked_key covers for one repository: never anything untracked.
// The @2 fields, then (since @3) the flagged files.
const legacyTrackedTuple = (r) => [
  r.path, r.head, r.branch, r.unborn, r.is_worktree, r.is_submodule,
  r.porcelain_sha256, r.staged_sha256, r.unstaged_sha256,
];
const trackedTuple = (r) => [...legacyTrackedTuple(r), r.flagged.count, r.flagged.sha256];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Flagged files whose content was not read (secret, size, budget, link, unreadable).
const flaggedSkipped = (r) => (isObject(r.flagged) ? Object.values(r.flagged.skipped).reduce((n, v) => n + v, 0) : 0);
// A flagged file present in the working tree, deleted, or not read: git's
// working-tree comparisons (status, diff) cannot see an edit to it, so a
// size or a match with the commit is never established (sparse entries are
// absent by design and excepted).
export const flaggedInWorkingTree = (r) => isObject(r.flagged) && r.flagged.hashed + r.flagged.missing + flaggedSkipped(r) > 0;
const trackedVerified = (r) => r.unverified.filter + r.unverified.secret + r.unverified.unreadable === 0 && flaggedSkipped(r) === 0;
// Unverified entries whose working-tree content was still observed (filter
// only): equal digests then prove those files did not change in between.
const observedOnly = (r) => r.unverified.secret + r.unverified.unreadable === 0 && flaggedSkipped(r) === 0;
// What untracked_key covers for one repository.
const untrackedTuple = (r) => [
  r.path, r.untracked.count, r.untracked.list_sha256, r.untracked.content_sha256, r.untracked.hashed,
  ...SKIP_REASONS.map((reason) => r.untracked.skipped[reason]),
];

// The records@1 `snapshot` of the project at `root` (an absolute path).
export function takeSnapshot(root, { limits = UNTRACKED_LIMITS, flaggedLimits = FLAGGED_LIMITS, discovery = {}, gitOptions } = {}) {
  const { root: realRoot, repos: found, limitations: discovered } = discoverRepos(root, { ...discovery, gitOptions });
  if (found.length === 0) {
    throw new DiscoveryError('no git repository at the root or up to two levels below it');
  }
  const limitations = [...discovered];
  const budget = { files: limits.files, bytes: limits.totalBytes };
  const flagged = { limits: flaggedLimits, budget: { files: flaggedLimits.files, bytes: flaggedLimits.totalBytes } };
  const repos = found.map((repo) => snapshotRepo(repo, realRoot, found, budget, limits, limitations, gitOptions, flagged));

  const all = sortLimitations(limitations);
  const discoveryComplete = !all.some((l) => INCOMPLETE_DISCOVERY.includes(l.code));
  const kept = all.length > MAX_LIMITATIONS
    ? [...all.slice(0, MAX_LIMITATIONS - 1), { code: 'truncated', path: '.' }]
    : all;
  const trackedComplete = repos.every(trackedVerified);
  return {
    // A flagged file in the working tree is never shown to match its commit.
    reconstructible: discoveryComplete && trackedComplete
      && repos.every((r) => r.porcelain_sha256 === EMPTY_SHA256 && r.untracked.count === 0 && !flaggedInWorkingTree(r)),
    tracked_key: sha256(JSON.stringify([TRACKED_KEY_VERSION, repos.map(trackedTuple)])),
    untracked_key: sha256(JSON.stringify([UNTRACKED_KEY_VERSION, repos.map(untrackedTuple)])),
    tracked_complete: trackedComplete,
    discovery_complete: discoveryComplete,
    untracked_complete: repos.every((r) => r.untracked.hashed === r.untracked.count),
    limitations: kept,
    repos,
  };
}

// How `current` differs from `previous` (two records@1 snapshots), for resume:
// - tracked: 'equal' | 'changed' | 'unverified'. 'changed' when tracked_key
//   differs (it includes the repository set). Equal keys are 'equal' only
//   when every tracked entry was verified on both sides, or the unverified
//   ones were observed and are identical; otherwise 'unverified' (a secret
//   or unreadable file, or a filtered file whose state cannot be compared).
// - untracked: 'equal' | 'changed' | 'unverified'. Equal keys are only
//   'equal' when every untracked file was hashed on both sides; otherwise the
//   skipped files are unverified, never assumed unchanged.
// - coverage: 'equal' | 'changed' | 'unverified' (limitations and discovery
//   completeness; 'unverified' when discovery was incomplete on either side);
// - action: 'abandon' when tracked state changed; 'reassess' (continue, but
//   reassess scope and census) when tracked state cannot be verified, or
//   untracked state or coverage changed or cannot be verified; otherwise
//   'continue';
// - repos: the repository paths whose tracked or untracked part differs
//   (a repository present on one side only counts as both), and those whose
//   tracked state is unverified.
// A snapshot written before tracked-key@3 has no `flagged`: both sides are
// then compared on the @2 fields only, and a repository is never proven
// equal (its flagged files were never looked at): 'changed' or 'unverified'.
export function compareSnapshots(previous, current) {
  const index = (snapshot) => new Map(snapshot.repos.map((r) => [r.path, r]));
  const before = index(previous);
  const after = index(current);
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : byteCompare(a, b)));
  const legacy = [previous, current].some((s) => s.repos.some((r) => !isObject(r.flagged)));
  const tupleOf = legacy ? legacyTrackedTuple : trackedTuple;
  const keyOf = (s) => (legacy ? sha256(JSON.stringify([LEGACY_TRACKED_KEY_VERSION, s.repos.map(legacyTrackedTuple)])) : s.tracked_key);
  const differs = (tuple, path) => {
    const a = before.get(path);
    const b = after.get(path);
    return !a || !b || JSON.stringify(tuple(a)) !== JSON.stringify(tuple(b));
  };

  // A repository whose tracked state is not proven equal by verified or
  // observed entries.
  const unproven = (p) => {
    const a = before.get(p);
    const b = after.get(p);
    if (!a || !b) return false; // a repository set change already changes tracked_key
    if (!isObject(a.flagged) || !isObject(b.flagged)) return true;
    if (trackedVerified(a) && trackedVerified(b)) return false;
    return !(observedOnly(a) && observedOnly(b) && JSON.stringify(a.unverified) === JSON.stringify(b.unverified));
  };
  const unverifiedRepos = paths.filter(unproven);
  let tracked = 'changed';
  if (keyOf(previous) === keyOf(current)) tracked = unverifiedRepos.length ? 'unverified' : 'equal';
  const untracked = previous.untracked_key !== current.untracked_key
    ? 'changed'
    : previous.untracked_complete && current.untracked_complete ? 'equal' : 'unverified';
  const sameCoverage = previous.discovery_complete === current.discovery_complete
    && JSON.stringify(previous.limitations) === JSON.stringify(current.limitations);
  const coverage = !sameCoverage
    ? 'changed'
    : previous.discovery_complete && current.discovery_complete ? 'equal' : 'unverified';
  let action = 'continue';
  if (tracked === 'changed') action = 'abandon';
  else if (tracked !== 'equal' || untracked !== 'equal' || coverage !== 'equal') action = 'reassess';
  return {
    tracked,
    untracked,
    coverage,
    action,
    repos: {
      tracked: paths.filter((p) => differs(tupleOf, p)),
      untracked: paths.filter((p) => differs(untrackedTuple, p)),
      unverified: unverifiedRepos,
    },
  };
}
