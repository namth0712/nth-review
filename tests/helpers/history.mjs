// Test-only history builders for freshness fixtures (M2-T4): ancestor,
// diverged, rewritten (amend + reflog expire + gc --prune=now) and transient
// histories, plus line edits. They use rawGit and only ever run in temporary
// repositories; each asserts its own postcondition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commitAll, write } from './repo.mjs';
import { rawGit } from './tmp.mjs';

// `n` numbered lines: "<prefix> 1" ... "<prefix> n", newline-terminated.
export const numbered = (n, prefix = 'line') => `${Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')}\n`;

export const head = (dir) => rawGit(dir, ['rev-parse', 'HEAD']).trim();
export const hasCommit = (dir, oid) => {
  try {
    rawGit(dir, ['cat-file', '-e', `${oid}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

// Edits the lines of a text file: `change(lines)` returns the new lines.
function editLines(dir, rel, change) {
  const file = path.join(dir, ...rel.split('/'));
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const last = lines.pop(); // the empty string after the final newline
  assert.equal(last, '', `${rel} ends with a newline`);
  fs.writeFileSync(file, `${change(lines).join('\n')}\n`);
}
// Replaces line `n` (1-based).
export const replaceLine = (dir, rel, n, text) => editLines(dir, rel, (l) => l.map((line, i) => (i === n - 1 ? text : line)));
// Inserts `text` after line `n` (0: at the top).
export const insertAfter = (dir, rel, n, text) => editLines(dir, rel, (l) => [...l.slice(0, n), text, ...l.slice(n)]);
// Removes `count` lines starting at line `n`.
export const removeLines = (dir, rel, n, count = 1) => editLines(dir, rel, (l) => [...l.slice(0, n - 1), ...l.slice(n - 1 + count)]);

// Commits `files` on top of HEAD: the old HEAD is an ancestor of the new one.
export function commitOnTop(dir, files = {}, message = 'on top') {
  const old = head(dir);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commitAll(dir, message);
  rawGit(dir, ['merge-base', '--is-ancestor', old, 'HEAD']);
  return head(dir);
}

// Moves to a new branch from HEAD~1 and commits `files` there: the old HEAD
// is no longer an ancestor, but still present.
export function diverge(dir, files = {}, message = 'diverged') {
  const old = head(dir);
  rawGit(dir, ['checkout', '-q', '-b', 'diverged', 'HEAD~1']);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commitAll(dir, message);
  assert.throws(() => rawGit(dir, ['merge-base', '--is-ancestor', old, 'HEAD']), 'diverged from the old HEAD');
  assert.ok(hasCommit(dir, old), 'the old HEAD is still present');
  return head(dir);
}

// Amends HEAD and prunes the old commit for good (temporary repositories only).
export function rewriteHead(dir) {
  const old = head(dir);
  rawGit(dir, ['commit', '-q', '--amend', '-m', 'rewritten history']);
  rawGit(dir, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
  rawGit(dir, ['gc', '-q', '--prune=now']);
  assert.ok(!hasCommit(dir, old), 'the old HEAD is gone');
  return head(dir);
}

// Adds `rel` in one commit and deletes it in the next.
export function addThenDelete(dir, rel, content = 'transient\n') {
  write(dir, rel, content);
  commitAll(dir, `add ${rel}`);
  fs.rmSync(path.join(dir, ...rel.split('/')));
  commitAll(dir, `delete ${rel}`);
  return head(dir);
}
