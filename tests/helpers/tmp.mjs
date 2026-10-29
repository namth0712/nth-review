// Test-only helpers: temporary directories under os.tmpdir() and a raw git
// runner for building fixtures. Production code never uses rawGit; it goes
// through scripts/lib/git.mjs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NTHR = path.join(REVIEW_DIR, 'scripts', 'nthr.mjs');

// A fresh directory, removed after the test that created it.
export function makeTempDir(t, prefix = 'nthr-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function rawGit(cwd, args, { env } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

// A repository with one commit, independent of the user's global git config.
export function initRepo(dir) {
  rawGit(dir, ['init', '-q', '-b', 'main']);
  rawGit(dir, ['config', 'user.name', 'nthr-test']);
  rawGit(dir, ['config', 'user.email', 'nthr@test.invalid']);
  rawGit(dir, ['config', 'commit.gpgsign', 'false']);
  rawGit(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

// Runs nthr.mjs as a separate process, the way the skill will.
export function runNthr(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [NTHR, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // left null: the test asserts on it
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}
