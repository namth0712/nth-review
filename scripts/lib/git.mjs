// The only path from nth-review to git. Every call is checked against a
// read-only allowlist BEFORE anything is spawned, runs without a shell, and
// carries options that keep git from writing (index refresh, lazy fetches)
// or running external programs (filter drivers, external diff, textconv,
// fsmonitor, hooks).
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

// A hooks directory that cannot exist, so no hook can run.
export const NO_HOOKS = path.join(os.devNull, 'nth-review-no-hooks');

// Added in front of every subcommand.
const GLOBAL_ARGS = Object.freeze([
  '--no-pager',
  '--no-optional-locks',
  '-c', 'core.quotepath=off',
  '-c', 'core.fsmonitor=false', // no fsmonitor hook or daemon
  '-c', 'diff.autoRefreshIndex=false', // `git diff` would otherwise rewrite the index
  '-c', `core.hooksPath=${NO_HOOKS}`,
  // Trace2 targets configured by the user would make git write log files.
  '-c', 'trace2.normalTarget=0',
  '-c', 'trace2.perfTarget=0',
  '-c', 'trace2.eventTarget=0',
  // `log` would run the configured signature program (gpg) for every commit.
  '-c', 'log.showSignature=false',
  '-c', 'log.showRoot=true', // a root commit inside a range shows what it adds
  // Hunks and renames independent of the user's diff configuration.
  '-c', 'diff.algorithm=myers',
  '-c', 'diff.indentHeuristic=true',
  '-c', 'diff.interHunkContext=0',
  '-c', 'diff.renameLimit=1000',
]);

// Subcommands that may convert working-tree content, and so would run a
// configured filter driver (clean, smudge, process).
const FILTER_CAPABLE = new Set(['status', 'diff', 'hash-object']);
const FILTER_QUERY = Object.freeze(['config', '--null', '--name-only', '--get-regexp', '^filter\\.']);
// A partial clone: a promisor remote, or the older extensions.partialClone.
const PROMISOR_QUERY = Object.freeze(['config', '--null', '--get-regexp', '^(remote\\..+\\.promisor|extensions\\.partialclone)$']);
const EXACT_CONFIG_QUERIES = [FILTER_QUERY, PROMISOR_QUERY];

// Environment variables that would point git somewhere other than `cwd`.
const REDIRECTING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_EXTERNAL_DIFF',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

export class GitPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitPolicyError';
    this.refusal = true; // cli.mjs maps refusals to exit 2
  }
}

export class GitUnavailableError extends Error {
  constructor(cause) {
    super('git is not available on PATH');
    this.name = 'GitUnavailableError';
    this.cause = cause;
  }
}

export class GitExecutionError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GitExecutionError';
    this.cause = cause;
  }
}

// Per subcommand: exact flags, flags allowed with any value after a prefix,
// whether positionals (revisions, paths) are allowed, flags always added, and
// flags refused with a specific message.
const RULES = Object.freeze({
  'rev-parse': {
    flags: [
      '--show-toplevel', '--git-dir', '--git-common-dir', '--absolute-git-dir',
      '--is-inside-work-tree', '--is-bare-repository', '--show-prefix',
      '--abbrev-ref', '--symbolic-full-name', '--verify', '--quiet', '-q',
      '--path-format=relative', '--path-format=absolute', '--show-superproject-working-tree',
    ],
    positionals: true,
  },
  status: {
    flags: [
      '--porcelain=v2', '-z', '--branch', '--no-renames',
      '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all',
      '--ignore-submodules=none', '--ignore-submodules=untracked',
      '--ignore-submodules=dirty', '--ignore-submodules=all',
    ],
    positionals: true,
  },
  diff: {
    flags: [
      '--cached', '--staged', '--binary', '--numstat', '--name-status', '--name-only',
      '--raw', '--full-index', '-U0', '-M', '-z', '--no-renames', '--find-renames',
      '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty',
    ],
    prefixFlags: ['--diff-filter='],
    positionals: true,
    forced: ['--no-ext-diff', '--no-textconv', '--no-color'],
  },
  'ls-files': {
    flags: ['--others', '--exclude-standard', '--cached', '--stage', '-s', '-v', '-z', '--full-name', '--error-unmatch'],
    positionals: true,
  },
  'check-attr': {
    flags: ['-z'],
    positionals: true,
  },
  'hash-object': {
    flags: [],
    positionals: true,
    refused: {
      '-w': 'hash-object -w writes to the object store',
      '--stdin': 'hash-object --stdin is not allowed',
      '--stdin-paths': 'hash-object --stdin-paths is not allowed',
      '--literally': 'hash-object --literally is not allowed',
    },
  },
  log: {
    flags: [
      '--name-status', '-z', '-M', '--no-renames', '--reverse', '--first-parent',
      '--no-merges', '--topo-order', '--no-color', '--no-ext-diff', '--no-textconv',
    ],
    prefixFlags: ['--format=', '--max-count=', '--diff-filter='],
    positionals: true,
    forced: ['--no-ext-diff', '--no-textconv', '--no-color'],
  },
});

const CONFIG_KEY = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

function checkToken(token) {
  if (typeof token !== 'string') throw new GitPolicyError('git arguments must be strings');
  if (token.includes('\0')) throw new GitPolicyError('git arguments must not contain NUL');
}

// Validates caller arguments (starting with the subcommand) and returns the
// subcommand arguments to run, forced safety flags included. Throws
// GitPolicyError for anything outside the allowlist.
export function validateGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new GitPolicyError('a git subcommand is required');
  }
  args.forEach(checkToken);
  const [sub, ...rest] = args;

  // Fixed-shape subcommands.
  if (sub === 'cat-file') {
    if (rest.length !== 2 || rest[0] !== '-e' || rest[1].startsWith('-')) {
      throw new GitPolicyError('only `cat-file -e <object>` is allowed');
    }
    return [...args];
  }
  if (sub === 'merge-base') {
    if (rest.length !== 3 || rest[0] !== '--is-ancestor' || rest[1].startsWith('-') || rest[2].startsWith('-')) {
      throw new GitPolicyError('only `merge-base --is-ancestor <a> <b>` is allowed');
    }
    return [...args];
  }
  if (sub === 'version') {
    if (rest.length !== 0) throw new GitPolicyError('only `version` is allowed');
    return [...args];
  }
  if (sub === 'config') {
    const isQuery = EXACT_CONFIG_QUERIES.some((q) => args.length === q.length && args.every((a, i) => a === q[i]));
    if (!isQuery && (rest.length !== 2 || rest[0] !== '--get' || !CONFIG_KEY.test(rest[1]))) {
      throw new GitPolicyError('only `config --get <key>` and the fixed filter-driver and promisor queries are allowed');
    }
    return [...args];
  }

  const rule = Object.hasOwn(RULES, sub) ? RULES[sub] : undefined;
  if (!rule) throw new GitPolicyError(`git ${sub} is not allowed`);

  let afterSeparator = false;
  for (const token of rest) {
    if (afterSeparator) continue; // paths after `--` may look like options
    if (token === '--') {
      afterSeparator = true;
      continue;
    }
    if (token.startsWith('-')) {
      if (rule.refused && Object.hasOwn(rule.refused, token)) {
        throw new GitPolicyError(rule.refused[token]);
      }
      const allowed =
        rule.flags.includes(token) ||
        (rule.prefixFlags ?? []).some((prefix) => token.startsWith(prefix) && token.length > prefix.length);
      if (!allowed) throw new GitPolicyError(`git ${sub} ${token} is not allowed`);
    } else if (!rule.positionals) {
      throw new GitPolicyError(`git ${sub} takes no positional arguments`);
    }
  }

  const forced = (rule.forced ?? []).filter((flag) => !rest.includes(flag));
  return [sub, ...forced, ...rest];
}

// The environment git runs with: the caller's, minus anything that would
// redirect git away from `cwd`, plus no optional locks and no prompts.
export function gitEnv(base = process.env) {
  const env = { ...base };
  for (const name of REDIRECTING_ENV) delete env[name];
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete env[name];
    if (/^GIT_TRACE/.test(name)) delete env[name]; // trace output is a file write
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1'; // a partial clone never fetches (writes objects, uses the network)
  return env;
}

// The names of every configured filter driver (`filter.<name>.*` in any
// configuration scope), sorted. Fails closed: a name that cannot be
// overridden on the command line is a refusal.
export function filterDriversOf(cwd, options = {}) {
  const result = git(cwd, [...FILTER_QUERY], { ...options, filterDrivers: [] });
  if (result.status === 1) return []; // none configured
  if (result.status !== 0) {
    throw new GitExecutionError(`git config exited ${result.status}: ${result.stderr.toString('utf8').trim()}`);
  }
  const names = new Set();
  for (const key of result.stdout.toString('utf8').split('\0')) {
    const last = key.lastIndexOf('.');
    // `filter.<name>.<setting>`; git ignores a key without a name (`filter.x`).
    if (!key.startsWith('filter.') || last < 'filter.'.length) continue;
    names.add(key.slice('filter.'.length, last));
  }
  for (const name of names) {
    if (name === '' || /[=\0\n\r]/.test(name)) {
      throw new GitPolicyError(`filter driver ${JSON.stringify(name)} cannot be disabled on the command line; refusing to run git where it could execute`);
    }
  }
  return [...names].sort();
}

// GIT_NO_LAZY_FETCH exists from Git 2.44. Before it, a partial clone could
// fetch (network, object writes) whenever an object is missing, so such a
// repository is refused rather than read.
export const NO_LAZY_FETCH_SINCE = [2, 44];

export function refusePartialCloneOnOldGit(cwd, options = {}) {
  const found = git(cwd, [...PROMISOR_QUERY], options);
  if (found.status === 1) return; // no promisor remote: not a partial clone
  if (found.status !== 0) throw new GitExecutionError(`git config exited ${found.status}: ${found.stderr.toString('utf8').trim()}`);
  const values = found.stdout.toString('utf8').split('\0').filter(Boolean).map((entry) => entry.slice(entry.indexOf('\n') + 1).trim().toLowerCase());
  if (!values.some((value) => value !== 'false' && value !== '')) return;
  const version = (options.version ?? gitText(cwd, ['version'], options)).match(/(\d+)\.(\d+)/);
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0];
  const [needMajor, needMinor] = NO_LAZY_FETCH_SINCE;
  if (major < needMajor || (major === needMajor && minor < needMinor)) {
    throw new GitPolicyError(`this is a partial clone and git ${major}.${minor} cannot be stopped from fetching missing objects; Git ${needMajor}.${needMinor} or later is required`);
  }
}

// `-c` overrides that disable the named drivers: no clean, smudge or process
// command, and not required (a required driver with no command is fatal).
function disableFilters(names) {
  return names.flatMap((name) => [
    '-c', `filter.${name}.clean=`,
    '-c', `filter.${name}.smudge=`,
    '-c', `filter.${name}.process=`,
    '-c', `filter.${name}.required=false`,
  ]);
}

// Runs one allowlisted git command in `cwd`. A non-zero exit is returned,
// not thrown; callers decide what it means. stdout and stderr are Buffers.
// For filter-capable subcommands every configured filter driver is disabled;
// `filterDrivers` may pass the names already looked up for `cwd`.
export function git(cwd, args, options = {}) {
  const { spawn = spawnSync, timeout = TIMEOUT_MS, env = process.env } = options;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new TypeError('git cwd must be an absolute path');
  }
  const validated = validateGitArgs(args);
  let disabled = [];
  if (FILTER_CAPABLE.has(validated[0])) {
    disabled = disableFilters(Array.isArray(options.filterDrivers) ? options.filterDrivers : filterDriversOf(cwd, options));
  }
  const finalArgs = [...GLOBAL_ARGS, ...disabled, ...validated];
  const result = spawn('git', finalArgs, {
    cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    timeout,
    env: gitEnv(env),
  });
  if (result.error) {
    const code = result.error.code;
    if (code === 'ENOENT') throw new GitUnavailableError(result.error);
    if (code === 'ENOBUFS') throw new GitExecutionError(`git ${args[0]} output exceeded ${MAX_BUFFER} bytes`, result.error);
    if (code === 'ETIMEDOUT') throw new GitExecutionError(`git ${args[0]} timed out after ${timeout} ms`, result.error);
    throw new GitExecutionError(`git ${args[0]} failed to run: ${result.error.message}`, result.error);
  }
  if (result.signal) {
    throw new GitExecutionError(`git ${args[0]} was terminated by ${result.signal}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

// Convenience for commands that must succeed: returns stdout as UTF-8 text.
export function gitText(cwd, args, options) {
  const result = git(cwd, args, options);
  if (result.status !== 0) {
    throw new GitExecutionError(
      `git ${args[0]} exited ${result.status}: ${result.stderr.toString('utf8').trim()}`,
    );
  }
  return result.stdout.toString('utf8');
}
