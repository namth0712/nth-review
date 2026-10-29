// Write containment for nth-review. Every file or directory the helper writes
// lives under <root>/.nth-review/<prefix>/<id>/… and is addressed by a
// review-relative POSIX path, never an absolute one. Each existing component is
// checked with lstat (no symbolic links or junctions) and realpath (it must be
// where the lexical path says), so nothing can be redirected outside the tree.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REVIEW_DIR = '.nth-review';

// This integration's own installed files (review.md, Runtime files), relative
// to the repository at the project root. Like `.nth-review/`, an untracked copy
// is never part of a reviewed change or a snapshot; a tracked copy still is.
// Exact case: Enable refuses case variants. Files only: an entry ending in '/'
// is a nested repository Git did not descend into, which still counts.
export const INTEGRATION_SKILL_DIR = '.claude/skills/nth-review/';
export const INTEGRATION_STATE_FILE = '.claude/nth-dev-kit-hooks/review.state.json';
export const isIntegrationPath = (repoPath, rel) =>
  repoPath === '.' && typeof rel === 'string' && !rel.endsWith('/')
  && (rel.startsWith(INTEGRATION_SKILL_DIR) || rel === INTEGRATION_STATE_FILE);

// Namespace prefix → the run kind it implies (rule N1: the kind comes from the
// path, never from a field the model writes).
export const NAMESPACE_KINDS = Object.freeze({
  experiments: 'experiment',
  reviews: 'review',
  audits: 'audit',
});

const NAMESPACE = /^(experiments|reviews|audits)\/([a-z0-9][a-z0-9-]{0,63})$/;
export const NAMESPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RUN_MODES = Object.freeze(['task', 'incremental', 'audit-plan', 'audit-unit', 'flow']);
export const RUN_ID = /^(\d{8})-(\d{6})-(task|incremental|audit-plan|audit-unit|flow)-([a-z0-9][a-z0-9-]{0,63})$/;

// Every component below the namespace is a name the helper generates (run
// ids, records.json, report.md, packs/<finding>.md): a strict portable charset.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)$/i;

export class FsGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FsGuardError';
    this.code = code;
    this.refusal = true; // cli.mjs maps refusals to exit 2
  }
}

const caseInsensitive = (platform) => platform === 'win32' || platform === 'darwin';

export function samePath(a, b, platform) {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return caseInsensitive(platform) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isWindowsDevice(segment) {
  // Windows reserves a device name with any extension: CON, con.json, nul.txt.
  return WINDOWS_DEVICE.test(segment.split('.')[0]);
}

// rule N1/N3 inputs: "<prefix>/<id>" with a known prefix and a strict id.
export function parseNamespace(ns) {
  if (typeof ns !== 'string') throw new FsGuardError('NAMESPACE_INVALID', 'namespace must be a string');
  const match = NAMESPACE.exec(ns);
  if (!match) {
    throw new FsGuardError(
      'NAMESPACE_INVALID',
      `namespace must be experiments|reviews|audits followed by /<id> (lowercase a-z, 0-9, -; at most 64): ${JSON.stringify(ns)}`,
    );
  }
  const [, prefix, id] = match;
  if (isWindowsDevice(id)) {
    throw new FsGuardError('NAMESPACE_INVALID', `namespace id is a reserved Windows device name: ${id}`);
  }
  return { namespace: ns, prefix, id, kind: NAMESPACE_KINDS[prefix] };
}

export function parseRunId(runId) {
  const match = typeof runId === 'string' ? RUN_ID.exec(runId) : null;
  if (!match) throw new FsGuardError('RUN_ID_INVALID', `invalid run id: ${JSON.stringify(runId)}`);
  return { date: match[1], time: match[2], mode: match[3], slug: match[4] };
}

// The review-relative path of a run directory: "<ns>/runs/<run-id>".
export function runDir(ns, runId) {
  parseNamespace(ns);
  parseRunId(runId);
  return `${ns}/runs/${runId}`;
}

function checkSegment(segment, rel) {
  if (!SEGMENT.test(segment) || segment.endsWith('.')) {
    throw new FsGuardError('PATH_INVALID', `invalid path component ${JSON.stringify(segment)} in ${JSON.stringify(rel)}`);
  }
  if (isWindowsDevice(segment)) {
    throw new FsGuardError('PATH_INVALID', `reserved Windows device name ${JSON.stringify(segment)} in ${JSON.stringify(rel)}`);
  }
}

// Validates a review-relative path ("experiments/x/runs/<id>/records.json")
// and returns its segments. Absolute paths, drive letters, backslashes, `.`
// and `..`, empty components and anything outside a namespace are refused.
export function splitReviewPath(rel, { minDepth = 2 } = {}) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new FsGuardError('PATH_INVALID', 'path must be a non-empty string');
  }
  if (rel.length > 1024) throw new FsGuardError('PATH_INVALID', 'path is too long');
  if (rel.includes('\\') || rel.includes('\0')) {
    throw new FsGuardError('PATH_INVALID', `path must use / separators only: ${JSON.stringify(rel)}`);
  }
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new FsGuardError('PATH_INVALID', `path must be relative to ${REVIEW_DIR}: ${JSON.stringify(rel)}`);
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new FsGuardError('PATH_INVALID', `empty, . or .. component in ${JSON.stringify(rel)}`);
  }
  if (segments.length < minDepth) {
    throw new FsGuardError('PATH_INVALID', `path must be inside a namespace: ${JSON.stringify(rel)}`);
  }
  parseNamespace(`${segments[0]}/${segments[1]}`);
  segments.slice(2).forEach((segment) => checkSegment(segment, rel));
  return segments;
}

function realRootOf(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new FsGuardError('ROOT_INVALID', 'root must be an absolute path');
  }
  let real;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    throw new FsGuardError('ROOT_INVALID', `root does not exist: ${root}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new FsGuardError('ROOT_INVALID', `root is not a directory: ${root}`);
  return real;
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Checks one existing component: a real directory (or the final file) that
// is exactly where the lexical path says.
function checkExisting(p, stats, { leaf, expectDirectory, platform }) {
  if (stats.isSymbolicLink()) {
    throw new FsGuardError('SYMLINK', `symbolic link or junction on the path: ${p}`);
  }
  const wantDirectory = !leaf || expectDirectory;
  if (wantDirectory && !stats.isDirectory()) {
    throw new FsGuardError('NOT_DIRECTORY', `not a directory: ${p}`);
  }
  if (leaf && !expectDirectory && !stats.isFile()) {
    throw new FsGuardError('NOT_FILE', `not a regular file: ${p}`);
  }
  const real = fs.realpathSync.native(p);
  if (!samePath(real, p, platform)) {
    throw new FsGuardError('ESCAPE', `path resolves elsewhere: ${p} -> ${real}`);
  }
}

// Resolves a review-relative path to an absolute one under
// <real root>/.nth-review, after walking every existing component. Missing
// components are allowed (they will be created below a checked parent).
export function resolveReviewPath(root, rel, { expectDirectory = false, minDepth = 2, platform = process.platform } = {}) {
  const segments = splitReviewPath(rel, { minDepth });
  const parts = [path.join(realRootOf(root), REVIEW_DIR)];
  for (const segment of segments) parts.push(path.join(parts[parts.length - 1], segment));
  for (let i = 0; i < parts.length; i += 1) {
    const stats = lstatOrNull(parts[i]);
    if (!stats) break; // the rest does not exist yet
    checkExisting(parts[i], stats, { leaf: i === parts.length - 1, expectDirectory, platform });
  }
  return parts[parts.length - 1];
}

// Creates one directory and verifies what was created.
function makeDirectory(p, platform) {
  fs.mkdirSync(p);
  checkExisting(p, fs.lstatSync(p), { leaf: true, expectDirectory: true, platform });
}

// Ensures .nth-review/<ns>/… exists, creating each missing component one at a
// time (never `recursive`, which would follow links).
export function ensureDir(root, rel, { platform = process.platform } = {}) {
  const target = resolveReviewPath(root, rel, { expectDirectory: true, platform });
  const realRoot = realRootOf(root);
  let current = realRoot;
  for (const segment of [REVIEW_DIR, ...rel.split('/')]) {
    current = path.join(current, segment);
    const stats = lstatOrNull(current);
    if (stats) checkExisting(current, stats, { leaf: false, expectDirectory: true, platform });
    else makeDirectory(current, platform);
  }
  return target;
}

// Creates the final directory exclusively: an existing one is refused. Its
// parents are ensured first.
export function mkdirExclusive(root, rel, { platform = process.platform } = {}) {
  const segments = splitReviewPath(rel, { minDepth: 3 });
  const parent = segments.slice(0, -1).join('/');
  ensureDir(root, parent, { platform });
  const target = resolveReviewPath(root, rel, { expectDirectory: true, minDepth: 3, platform });
  try {
    makeDirectory(target, platform);
  } catch (error) {
    if (error.code === 'EEXIST') throw new FsGuardError('EXISTS', `already exists: ${rel}`);
    throw error;
  }
  return target;
}

// Writes a file atomically: a temporary file in the same directory, flushed,
// then renamed over the target. A failure leaves any previous file intact.
// `rename` is injectable so tests can simulate an interrupted write.
// `exclusive`: the target must not exist, and never will be replaced, even by
// a racing writer: the complete temporary file is hard-linked into place
// (which fails if the target exists), then the temporary name is removed.
export function writeAtomic(root, rel, data, { platform = process.platform, rename = fs.renameSync, exclusive = false } = {}) {
  const segments = splitReviewPath(rel, { minDepth: 3 });
  ensureDir(root, segments.slice(0, -1).join('/'), { platform });
  const target = resolveReviewPath(root, rel, { minDepth: 3, platform });
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (!Buffer.isBuffer(bytes)) throw new TypeError('data must be a string or Buffer');
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // Re-check the leaf just before replacing it.
    const stats = lstatOrNull(target);
    if (exclusive) {
      if (stats) throw new FsGuardError('EXISTS', `already exists: ${rel}`);
      try {
        fs.linkSync(temp, target);
      } catch (error) {
        if (error.code === 'EEXIST') throw new FsGuardError('EXISTS', `already exists: ${rel}`);
        throw error;
      }
      // The target is complete and in place: removing the temporary name is
      // best effort (a scanner may hold it briefly), never a failure.
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // left behind; harmless
      }
      return target;
    } else {
      if (stats) checkExisting(target, stats, { leaf: true, expectDirectory: false, platform });
      rename(temp, target);
    }
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return target;
}

// Every namespace directory under .nth-review/{experiments,reviews,audits}/,
// sorted, without following links (a link on the way is refused). Anything
// else inside those directories is a stray. { namespaces, strays }
export function listNamespaces(root, { platform = process.platform } = {}) {
  const base = path.join(realRootOf(root), REVIEW_DIR);
  const top = lstatOrNull(base);
  if (!top) return { namespaces: [], strays: [] };
  checkExisting(base, top, { leaf: false, expectDirectory: true, platform });
  const namespaces = [];
  const strays = [];
  for (const prefix of Object.keys(NAMESPACE_KINDS).sort()) {
    const dir = path.join(base, prefix);
    const stats = lstatOrNull(dir);
    if (!stats) continue;
    checkExisting(dir, stats, { leaf: false, expectDirectory: true, platform });
    for (const name of fs.readdirSync(dir).sort()) {
      const entry = path.join(dir, name);
      const entryStats = fs.lstatSync(entry);
      if (entryStats.isSymbolicLink()) throw new FsGuardError('SYMLINK', `symbolic link or junction on the path: ${entry}`);
      if (entryStats.isDirectory() && NAMESPACE_ID.test(name)) namespaces.push(`${prefix}/${name}`);
      else strays.push(`${prefix}/${name}`);
    }
  }
  return { namespaces, strays };
}
