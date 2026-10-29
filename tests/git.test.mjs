import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EXIT, run } from '../scripts/lib/cli.mjs';
import {
  GitExecutionError,
  GitPolicyError,
  GitUnavailableError,
  NO_HOOKS,
  filterDriversOf,
  git,
  gitEnv,
  gitText,
  validateGitArgs,
} from '../scripts/lib/git.mjs';
import { initRepo, makeTempDir, rawGit } from './helpers/tmp.mjs';

// A repository with one committed file, one staged change and one untracked file.
function repoFixture(t) {
  const dir = initRepo(makeTempDir(t, 'nthr-git-'));
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  rawGit(dir, ['add', 'a.txt']);
  rawGit(dir, ['commit', '-q', '-m', 'first']);
  writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  rawGit(dir, ['add', 'a.txt']);
  writeFileSync(path.join(dir, 'new file.txt'), 'untracked\n');
  return dir;
}

// A spawn stand-in that records calls and returns a canned result.
function spySpawn(result = { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return result;
  };
  return { spawn, calls };
}

test('allowlisted read commands run against a real repository', (t) => {
  const dir = repoFixture(t);
  const top = gitText(dir, ['rev-parse', '--show-toplevel']).trim();
  assert.equal(path.resolve(top).toLowerCase(), path.resolve(dir).toLowerCase());

  const status = gitText(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=no']);
  assert.match(status, /a\.txt/);
  assert.doesNotMatch(status, /new file/);

  assert.match(gitText(dir, ['diff', '--cached', '--binary']), /\+two/);
  assert.equal(gitText(dir, ['diff', '--cached', '--numstat']).trim(), '1\t1\ta.txt');
  assert.match(gitText(dir, ['ls-files', '--others', '--exclude-standard', '-z']), /new file\.txt/);
  assert.match(gitText(dir, ['log', '--format=%s', '--max-count=1']), /first/);
  assert.equal(gitText(dir, ['config', '--get', 'user.name']).trim(), 'nthr-test');
  assert.equal(git(dir, ['cat-file', '-e', 'HEAD']).status, 0);
  assert.equal(git(dir, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD']).status, 0);
  assert.match(gitText(dir, ['rev-parse', 'HEAD:a.txt']).trim(), /^[0-9a-f]{40}$/);
});

test('hash-object computes a blob id without writing it', (t) => {
  const dir = repoFixture(t);
  writeFileSync(path.join(dir, 'unique.txt'), `only-here-${Date.now()}\n`);
  const oid = gitText(dir, ['hash-object', '--', 'unique.txt']).trim();
  assert.match(oid, /^[0-9a-f]{40}$/);
  // Not written: the object store does not have it.
  assert.notEqual(git(dir, ['cat-file', '-e', oid]).status, 0);
});

test('a non-zero exit is returned, not thrown', (t) => {
  const dir = repoFixture(t);
  const result = git(dir, ['cat-file', '-e', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
  assert.notEqual(result.status, 0);
  assert.throws(() => gitText(dir, ['cat-file', '-e', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']), GitExecutionError);
});

test('hash-object -w and other writing forms are refused before spawning', () => {
  const { spawn, calls } = spySpawn();
  for (const args of [
    ['hash-object', '-w', 'a.txt'],
    ['hash-object', '--stdin'],
    ['hash-object', '--stdin-paths'],
    ['hash-object', '--literally', 'a.txt'],
    ['hash-object', '-t', 'blob', 'a.txt'],
  ]) {
    assert.throws(() => git(process.cwd(), args, { spawn }), GitPolicyError, args.join(' '));
  }
  assert.equal(calls.length, 0);
});

test('mutating and unknown subcommands are refused before spawning', () => {
  const { spawn, calls } = spySpawn();
  const refused = [
    ['add', '.'], ['commit', '-m', 'x'], ['checkout', 'main'], ['switch', 'main'],
    ['reset', '--hard'], ['restore', '.'], ['clean', '-fd'], ['stash'], ['push'],
    ['fetch'], ['pull'], ['merge', 'x'], ['rebase', 'x'], ['gc'], ['prune'],
    ['worktree', 'add', 'x'], ['branch', 'x'], ['tag', 'x'], ['update-ref', 'a', 'b'],
    ['update-index', '--refresh'], ['reflog', 'expire'], ['notes', 'add'], ['init'],
    ['clone', 'x'], ['apply', 'p'], ['rm', 'x'], ['mv', 'a', 'b'], ['submodule', 'update'],
    ['config', 'user.name', 'x'], ['config', '--unset', 'user.name'], ['config', '--get'],
    ['config', '--get', 'a', 'b'], ['config', '--get', '--global'],
    ['cat-file', '-p', 'HEAD'], ['cat-file', '-e'], ['merge-base', 'a', 'b'],
    ['-c', 'core.pager=x', 'status'], ['--git-dir=x', 'status'], ['constructor'], ['toString'],
  ];
  for (const args of refused) {
    assert.throws(() => git(process.cwd(), args, { spawn }), GitPolicyError, args.join(' '));
  }
  assert.equal(calls.length, 0);
});

test('options outside the allowlist are refused, including output and external programs', () => {
  for (const args of [
    ['diff', '--output=x.patch'], ['diff', '--ext-diff'], ['diff', '--textconv'], ['diff', '-p'],
    ['diff', '--color'], ['log', '-p'], ['log', '--format'], ['log', '--output=x'],
    ['status', '--porcelain'], ['rev-parse', '--git-path', 'x'], ['ls-files', '--with-tree=x'],
    ['ls-files', '-x'], ['status', '-uall'],
  ]) {
    assert.throws(() => validateGitArgs(args), GitPolicyError, args.join(' '));
  }
});

test('argument hygiene: non-strings, NUL, empty list, option-like positionals', () => {
  assert.throws(() => validateGitArgs([]), GitPolicyError);
  assert.throws(() => validateGitArgs('status'), GitPolicyError);
  assert.throws(() => validateGitArgs(['status', 1]), GitPolicyError);
  assert.throws(() => validateGitArgs(['status', 'a\0b']), GitPolicyError);
  assert.throws(() => validateGitArgs(['cat-file', '-e', '--batch']), GitPolicyError);
  assert.throws(() => validateGitArgs(['merge-base', '--is-ancestor', '-x', 'b']), GitPolicyError);
  // After `--`, a path may look like an option.
  assert.deepEqual(validateGitArgs(['ls-files', '--', '-odd-name']), ['ls-files', '--', '-odd-name']);
  assert.deepEqual(validateGitArgs(['hash-object', '--', '-w']), ['hash-object', '--', '-w']);
});

test('diff and log always run with --no-ext-diff --no-textconv --no-color', () => {
  assert.deepEqual(validateGitArgs(['diff', '--cached']), ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--cached']);
  assert.deepEqual(
    validateGitArgs(['log', '--no-color', '--format=%H']),
    ['log', '--no-ext-diff', '--no-textconv', '--no-color', '--format=%H'],
  );
});

test('spawn options: no shell, hidden window, safety globals, sanitised environment', () => {
  const { spawn, calls } = spySpawn();
  git(process.cwd(), ['status', '--porcelain=v2'], {
    spawn,
    env: { PATH: 'p', GIT_DIR: '/elsewhere', GIT_WORK_TREE: '/w', GIT_CONFIG_PARAMETERS: "'diff.external'='x'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: 'x', GIT_EXTERNAL_DIFF: 'x' },
  });
  // status first looks up the configured filter drivers (read-only), then runs.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(28), ['config', '--null', '--name-only', '--get-regexp', '^filter\\.']);
  assert.deepEqual(calls[1].args.slice(28), ['status', '--porcelain=v2']);
  for (const { cmd, args, options } of calls) {
    assert.equal(cmd, 'git');
    assert.deepEqual(args.slice(0, 28), [
      '--no-pager', '--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false',
      '-c', 'diff.autoRefreshIndex=false', '-c', `core.hooksPath=${NO_HOOKS}`,
      '-c', 'trace2.normalTarget=0', '-c', 'trace2.perfTarget=0', '-c', 'trace2.eventTarget=0',
      // M2-T4: no signature program; hunks and renames independent of user diff config.
      '-c', 'log.showSignature=false', '-c', 'log.showRoot=true', '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=true',
      '-c', 'diff.interHunkContext=0', '-c', 'diff.renameLimit=1000',
    ]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(options.env.PATH, 'p');
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EXTERNAL_DIFF']) {
      assert.equal(Object.hasOwn(options.env, name), false, name);
    }
  }
  assert.equal(gitEnv({}).GIT_OPTIONAL_LOCKS, '0');
  const traced = gitEnv({ GIT_TRACE: '/t', GIT_TRACE2_EVENT: '/t', GIT_TRACE_PACKET: '1', GIT_TRACEX: 'x' });
  assert.deepEqual(Object.keys(traced).filter((k) => k.startsWith('GIT_TRACE')), [], 'trace output would be a file write');
  assert.deepEqual(validateGitArgs(['version']), ['version']);
  assert.throws(() => validateGitArgs(['version', '--build-options']), GitPolicyError);
});

test('filter-capable commands disable every configured filter driver; other commands look nothing up', () => {
  const configured = Buffer.from('filter.lfs.clean\0filter.lfs.process\0filter.my.dotted.clean\0filter.lfs.required\0filter.nameless\0');
  const { spawn, calls } = spySpawn({ status: 0, stdout: configured, stderr: Buffer.alloc(0) });
  for (const sub of [['status', '--porcelain=v2'], ['diff', '--numstat', 'HEAD', '--'], ['hash-object', '--', 'a.txt']]) {
    calls.length = 0;
    git(process.cwd(), sub, { spawn });
    const args = calls[1].args;
    for (const name of ['lfs', 'my.dotted']) {
      for (const setting of [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]) {
        assert.ok(args.includes(setting), `${sub[0]}: ${setting}`);
      }
    }
    assert.ok(args.indexOf(sub[0]) > args.indexOf('filter.lfs.clean='), 'overrides come before the subcommand');
  }
  for (const sub of [['ls-files', '--others'], ['rev-parse', '--git-dir'], ['check-attr', '-z', 'filter', '--', 'a']]) {
    calls.length = 0;
    git(process.cwd(), sub, { spawn });
    assert.equal(calls.length, 1, sub[0]);
  }
  // Names already looked up are reused; a name that cannot be overridden is refused.
  calls.length = 0;
  git(process.cwd(), ['status'], { spawn, filterDrivers: ['x'] });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('filter.x.process='));
  const hostile = spySpawn({ status: 0, stdout: Buffer.from('filter.a=b.clean\0'), stderr: Buffer.alloc(0) }).spawn;
  assert.throws(() => git(process.cwd(), ['status'], { spawn: hostile }), GitPolicyError);
  assert.deepEqual(filterDriversOf(process.cwd(), { spawn: spySpawn({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }).spawn }), []);
  // Only the exact filter query is allowed among config forms.
  assert.throws(() => validateGitArgs(['config', '--null', '--name-only', '--get-regexp', '.']), GitPolicyError);
  assert.throws(() => validateGitArgs(['config', '--get-regexp', '^filter\\.']), GitPolicyError);
});

test('spawn failures become typed errors', () => {
  const fail = (code) => spySpawn({ error: Object.assign(new Error(code), { code }) }).spawn;
  assert.throws(() => git(process.cwd(), ['status'], { spawn: fail('ENOENT') }), GitUnavailableError);
  assert.throws(() => git(process.cwd(), ['status'], { spawn: fail('ENOBUFS') }), /exceeded/);
  assert.throws(() => git(process.cwd(), ['status'], { spawn: fail('ETIMEDOUT') }), /timed out/);
  assert.throws(() => git(process.cwd(), ['status'], { spawn: fail('EPERM') }), GitExecutionError);
  const killed = spySpawn({ status: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }).spawn;
  assert.throws(() => git(process.cwd(), ['status'], { spawn: killed }), /terminated by SIGKILL/);
});

test('cwd must be an absolute path', () => {
  assert.throws(() => git('relative/dir', ['status']), TypeError);
});

test('a GitPolicyError surfacing from a command is a guard refusal (exit 2)', () => {
  const out = [];
  const commands = {
    probe: { summary: '', options: {}, run: () => git(process.cwd(), ['hash-object', '-w', 'x']) },
  };
  const code = run(['probe'], { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, commands });
  assert.equal(code, EXIT.USAGE);
  assert.match(JSON.parse(out.join('')).errors[0], /writes to the object store/);
});
