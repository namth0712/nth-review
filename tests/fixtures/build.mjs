// M5 fixture builder (M5-T1). Library-only test tooling: Enable never installs
// it, and it never reads the sealed `answers.json` files next to it. Nothing it
// writes into a fixture names an expected result: file text, names, commit
// messages and identities are neutral.
//
// Usage: node tests/fixtures/build.mjs <name> <outDir> [--from <dir>]
//   syn-ledger                 three repositories (root `.`, `api`, `admin`) with a base and a change commit
//   syn-ledger-inc             syn-ledger plus one more commit in `.` and `api`
//   syn-ledger-inc-rewritten   the same, after `api`'s change commit is rewritten and the old one pruned
//   syn-ledger-inc-dirty       the same, with the new files left uncommitted
//   syn-debt                   syn-ledger plus a smaller follow-up commit in `.` and `api`
//   syn-shelf                  one repository (`.`, a reading-list command-line tool) with a base and a change commit
// The `-inc` names take `--from <dir>`: a built syn-ledger fixture (with its
// review records), copied and then extended. Every fixture is installed with
// INSTALL.md's project-scoped Enable from a throwaway installed package.
// outDir must be absent or empty, under the system temporary directory, and
// outside every Git work tree. Exit codes: 0 built, 2 usage or refusal, 3 unexpected.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KIT, makePackageCache } from '../helpers/library.mjs';
import { rawGit } from '../helpers/tmp.mjs';
import { enable, makeIO } from '../m4/operator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TREE = path.join(HERE, 'syn-ledger', 'tree');
export const SHELF_TREE = path.join(HERE, 'syn-shelf', 'tree');
export const NAMES = ['syn-ledger', 'syn-ledger-inc', 'syn-ledger-inc-rewritten', 'syn-ledger-inc-dirty', 'syn-debt', 'syn-shelf'];
export const REPO_DIRS = { root: '.', api: 'api', admin: 'admin' };
const IDENTITY = { name: 'Ledger Team', email: 'team@ledger.example' };
const DATES = {
  base: '2026-03-02T09:00:00+00:00',
  change: '2026-03-09T10:30:00+00:00',
  rewritten: '2026-03-09T10:45:00+00:00',
  inc: '2026-03-16T11:00:00+00:00',
  debt: '2026-03-16T14:00:00+00:00',
};
const MESSAGES = {
  base: { root: 'Document accounts, ledger and operations', api: 'Add accounts, ledger and daily interest', admin: 'Add back-office limits mirror and transfer review' },
  change: { root: 'Document transfers, sweeps, withdrawals and statements', api: 'Add transfers, sweeps, withdrawals and statements' },
  rewritten: { api: 'Add money movement endpoints' },
  inc: { root: 'Document joint account holders', api: 'Accept joint account holders' },
  debt: { root: 'Document payouts and entry lookups', api: 'Add payouts and entry lookups' },
};
// The root repository ignores the nested repositories and exactly the paths
// INSTALL.md's optional local exclude names.
const REVIEW_EXCLUDE = ['/.nth-review/', '/.claude/skills/nth-review/', '/.claude/nth-dev-kit-hooks/review.state.json'];
const ROOT_EXCLUDE = ['/api/', '/admin/', ...REVIEW_EXCLUDE];
const LEDGER = { tree: TREE, repos: REPO_DIRS, dates: DATES, messages: MESSAGES };
// syn-shelf: one repository, its own neutral identity, dates and messages.
export const SHELF_REPOS = { root: '.' };
const SHELF_IDENTITY = { name: 'Shelf Maintainers', email: 'maintainers@shelf.example' };
const SHELF = {
  tree: SHELF_TREE,
  repos: SHELF_REPOS,
  dates: { base: '2026-04-06T09:00:00+00:00', change: '2026-04-13T10:00:00+00:00' },
  messages: { base: { root: 'Add reading list with finish, stats and plugins' }, change: { root: 'Add reading progress' } },
};
export const COMMANDS = {
  'syn-ledger': '/nth-review task --ns experiments/ledger --slug ledger --change .:HEAD~1..HEAD --change api:HEAD~1..HEAD',
  'syn-ledger-inc': '/nth-review incremental --ns experiments/ledger --slug ledger-inc --base <run id of the first review>',
  'syn-debt': '/nth-review task --ns experiments/payouts --slug payouts --change .:HEAD~1..HEAD --change api:HEAD~1..HEAD',
  'syn-shelf': '/nth-review task --ns experiments/shelf --slug shelf --change .:HEAD~1..HEAD',
};

export class Refusal extends Error {}

const at = (dir, rel) => path.join(dir, ...rel.split('/'));
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Git isolated from system and user configuration: no hooks, no autocrlf, and
// identity and dates only through the environment.
function gitRunner(emptyConfig, identity = IDENTITY) {
  return (dir, args, date = DATES.base) => rawGit(dir, args, {
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

// The files of one template layer for one repository, as '/'-separated paths.
export function layerFiles(layer, repo, tree = TREE) {
  const dir = path.join(tree, layer, repo);
  const out = [];
  const walk = (d, prefix) => {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else out.push(prefix + e.name);
    }
  };
  walk(dir, '');
  return out.sort();
}

function applyLayer(out, layer, repo, cfg = LEDGER) {
  const files = layerFiles(layer, repo, cfg.tree);
  for (const rel of files) {
    const text = fs.readFileSync(at(path.join(cfg.tree, layer, repo), rel), 'utf8').replace(/\r\n/g, '\n');
    const target = at(path.join(out, cfg.repos[repo]), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return files;
}

function commitLayer(git, out, layer, repo, cfg = LEDGER) {
  const files = applyLayer(out, layer, repo, cfg);
  const dir = path.join(out, cfg.repos[repo]);
  git(dir, ['add', '--', ...files], cfg.dates[layer]);
  git(dir, ['commit', '-q', '--no-verify', '-m', cfg.messages[layer][repo]], cfg.dates[layer]);
}

function initRepository(git, dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['commit.gpgsign', 'false'], ['gc.auto', '0']]) {
    git(dir, ['config', key, value]);
  }
}

export function heads(out, repos = REPO_DIRS) {
  const result = {};
  for (const dir of Object.values(repos)) {
    result[dir] = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(out, dir), encoding: 'utf8', windowsHide: true }).stdout.trim();
  }
  return result;
}

// Every file outside `.git/`, as path → sha256 (byte identity of a build).
export function manifest(out) {
  const result = {};
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}/`);
      else result[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex');
    }
  };
  walk(out, '');
  return result;
}

function insideWorkTree(dir) {
  let probe = dir;
  while (!exists(probe)) probe = path.dirname(probe);
  return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: probe, encoding: 'utf8', windowsHide: true }).stdout.trim() === 'true';
}

function realOrParent(p) {
  let probe = path.resolve(p);
  const rest = [];
  while (!exists(probe)) { rest.unshift(path.basename(probe)); probe = path.dirname(probe); }
  return path.join(fs.realpathSync.native(probe), ...rest);
}

function checkOutDir(outDir) {
  const out = realOrParent(outDir);
  const tmp = fs.realpathSync.native(os.tmpdir());
  const inside = (a, b) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + path.sep);
  if (!inside(out, tmp) || out.toLowerCase() === tmp.toLowerCase()) throw new Refusal(`outDir must be a new directory under ${tmp}`);
  const kit = fs.realpathSync.native(KIT);
  if (inside(out, kit) || inside(kit, out)) throw new Refusal('outDir overlaps the kit');
  if (exists(out) && fs.readdirSync(out).length) throw new Refusal('outDir must be absent or empty');
  if (insideWorkTree(out)) throw new Refusal('outDir is inside a Git work tree');
  return out;
}

function install(out) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-config-'));
  try {
    makePackageCache(config);
    const result = enable({ P: out, config, kit: KIT, io: makeIO() });
    if (result.result !== 'enabled') throw new Error(`Enable: ${result.result}`);
    return result;
  } finally {
    fs.rmSync(config, { recursive: true, force: true });
  }
}

function buildLedger(git, out) {
  initRepository(git, out);
  fs.appendFileSync(path.join(out, '.git', 'info', 'exclude'), `${ROOT_EXCLUDE.join('\n')}\n`);
  initRepository(git, path.join(out, 'api'));
  initRepository(git, path.join(out, 'admin'));
  for (const repo of ['root', 'api', 'admin']) commitLayer(git, out, 'base', repo);
  for (const repo of ['root', 'api']) commitLayer(git, out, 'change', repo);
}

function buildShelf(git, out) {
  initRepository(git, out);
  fs.appendFileSync(path.join(out, '.git', 'info', 'exclude'), `${REVIEW_EXCLUDE.join('\n')}\n`);
  for (const layer of ['base', 'change']) commitLayer(git, out, layer, 'root', SHELF);
}

// --from: a syn-ledger fixture, possibly reviewed, with clean tracked state and
// the heads a fresh syn-ledger build has.
function checkSource(git, from) {
  const source = realOrParent(from);
  if (!exists(path.join(source, '.git')) || !exists(path.join(source, 'api', '.git'))) throw new Refusal('--from is not a syn-ledger fixture');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-check-'));
  try {
    buildLedger(git, path.join(scratch, 'p'));
    const expected = heads(path.join(scratch, 'p'));
    const actual = heads(source);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Refusal('--from heads differ from a syn-ledger build');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  for (const dir of Object.values(REPO_DIRS)) {
    if (git(path.join(source, dir), ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Refusal(`--from has uncommitted changes in ${dir}`);
  }
  return source;
}

export function buildFixture(name, outDir, { from } = {}) {
  if (!NAMES.includes(name)) throw new Refusal(`unknown fixture: ${name}`);
  if (from && !name.startsWith('syn-ledger-inc')) throw new Refusal('--from applies to the syn-ledger-inc fixtures only');
  const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-git-')), 'config');
  fs.writeFileSync(emptyConfig, '');
  const git = gitRunner(emptyConfig);
  try {
    const out = checkOutDir(outDir);
    if (name === 'syn-shelf') {
      buildShelf(gitRunner(emptyConfig, SHELF_IDENTITY), out);
      install(out);
      return { fixture: out, name, heads: heads(out, SHELF_REPOS), command: COMMANDS[name], next: nextSteps(name, from) };
    }
    if (from) {
      const source = checkSource(git, from);
      fs.cpSync(source, out, { recursive: true });
    } else {
      buildLedger(git, out);
      install(out);
    }
    if (name === 'syn-ledger-inc-rewritten') {
      const api = path.join(out, 'api');
      const old = git(api, ['rev-parse', 'HEAD']).trim();
      const tree = git(api, ['rev-parse', 'HEAD^{tree}']).trim();
      const parent = git(api, ['rev-parse', 'HEAD~1']).trim();
      const rewritten = git(api, ['commit-tree', tree, '-p', parent, '-m', MESSAGES.rewritten.api], DATES.rewritten).trim();
      git(api, ['update-ref', 'refs/heads/main', rewritten, old]);
      for (const repo of ['root', 'api']) commitLayer(git, out, 'inc', repo);
      git(api, ['reflog', 'expire', '--expire=now', '--all']);
      git(api, ['gc', '-q', '--prune=now']);
      if (spawnSync('git', ['cat-file', '-e', `${old}^{commit}`], { cwd: api, windowsHide: true }).status === 0) throw new Error('the rewritten commit is still reachable');
    } else if (name === 'syn-ledger-inc-dirty') {
      for (const repo of ['root', 'api']) applyLayer(out, 'inc', repo);
    } else if (name === 'syn-ledger-inc') {
      for (const repo of ['root', 'api']) commitLayer(git, out, 'inc', repo);
    } else if (name === 'syn-debt') {
      for (const repo of ['root', 'api']) commitLayer(git, out, 'debt', repo);
    }
    const command = COMMANDS[name.startsWith('syn-ledger-inc') ? 'syn-ledger-inc' : name];
    return { fixture: out, name, heads: heads(out), command, next: nextSteps(name, from) };
  } finally {
    fs.rmSync(path.dirname(emptyConfig), { recursive: true, force: true });
  }
}

// RQ-1 @2, B7: a fixture from an independently curated package of Git bundles
// (SECURITY-FIXTURE-SPEC.md). Nothing from the package is run. Each bundle is
// verified, the ref holding its recorded head is fetched into a fresh
// repository, and checked out; no remote, FETCH_HEAD, reflog or path to the
// package is left in the fixture. `bundles`: { '<repo>': '<file>' }, '.' for
// the root; `heads`: { '<repo>': '<commit>' } as the curated answers record.
export function buildCuratedFixture(bundles, outDir, { heads: expected }) {
  const repos = Object.keys(bundles).sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  if (!repos.includes('.')) throw new Refusal('a curated package needs the root repository (repos/root.bundle)');
  if (JSON.stringify(Object.keys(expected ?? {}).sort()) !== JSON.stringify([...repos].sort())) throw new Refusal('the bundles and the recorded heads name different repositories');
  for (const repo of repos) {
    if (repo !== '.' && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(repo)) throw new Refusal(`bad repository name ${repo}`);
    if (!/^[0-9a-f]{40}$/.test(expected[repo])) throw new Refusal(`bad head for ${repo}`);
  }
  const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-git-')), 'config');
  fs.writeFileSync(emptyConfig, '');
  const git = gitRunner(emptyConfig);
  try {
    const out = checkOutDir(outDir);
    for (const repo of repos) {
      const dir = repo === '.' ? out : path.join(out, repo);
      if (repo !== '.' && exists(dir)) throw new Refusal(`the root repository already holds ${repo}/: a nested repository must not be tracked by the root`);
      initRepository(git, dir);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-b-'));
      try {
        const copy = path.join(scratch, 'p.bundle');
        fs.copyFileSync(bundles[repo], copy);
        try { git(dir, ['bundle', 'verify', '-q', copy]); } catch (error) { throw new Refusal(`${repo}: the bundle does not verify (${String(error.message).split('\n')[0]})`); }
        const refs = git(dir, ['bundle', 'list-heads', copy]).split('\n').map((l) => l.trim().split(/\s+/)).filter(([sha, ref]) => sha && ref);
        const ref = refs.find(([sha, name]) => sha === expected[repo] && name.startsWith('refs/'))?.[1];
        if (!ref) throw new Refusal(`${repo}: no ref in the bundle holds the recorded head`);
        git(dir, ['fetch', '-q', '--no-tags', '--update-head-ok', copy, `${ref}:refs/heads/main`]);
        git(dir, ['reset', '-q', '--hard', 'main']);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
      fs.rmSync(path.join(dir, '.git', 'FETCH_HEAD'), { force: true });
      git(dir, ['reflog', 'expire', '--expire=now', '--all']);
      if (git(dir, ['rev-parse', 'HEAD']).trim() !== expected[repo]) throw new Refusal(`${repo}: HEAD is not the recorded head`);
    }
    const nested = repos.filter((r) => r !== '.').map((r) => `/${r}/`);
    fs.appendFileSync(path.join(out, '.git', 'info', 'exclude'), `${[...nested, ...REVIEW_EXCLUDE].join('\n')}\n`);
    install(out);
    return { fixture: out, name: 'curated', heads: heads(out, Object.fromEntries(repos.map((r) => [r, r]))) };
  } finally {
    fs.rmSync(path.dirname(emptyConfig), { recursive: true, force: true });
  }
}

function nextSteps(name, from) {
  const steps = ['Start a new Claude Code session in the fixture directory (Opus at high effort, or as routing requires).', 'Type the command above.'];
  if (name.startsWith('syn-ledger-inc') && !from) steps.unshift('No first review exists in this fixture: build it with --from <a reviewed syn-ledger fixture> for an Incremental review.');
  return steps;
}

function main(argv) {
  const [name, outDir, ...rest] = argv;
  if (!name || !outDir || (rest.length && !(rest.length === 2 && rest[0] === '--from'))) {
    process.stderr.write('usage: build.mjs <name> <outDir> [--from <dir>]\n');
    return 2;
  }
  try {
    const result = buildFixture(name, outDir, { from: rest[1] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error instanceof Refusal ? 2 : 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
