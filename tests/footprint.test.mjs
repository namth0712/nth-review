import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { citedPaths, footprintRun, owningRepository } from '../scripts/lib/footprint.mjs';
import { validRecords } from './helpers/records.mjs';
import { commitAll, linkDirectory, makeRepo, write } from './helpers/repo.mjs';
import { at, closeRun, nthr, readRecords, recordsFile, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const posix = (p) => p.replaceAll('\\', '/');
const blobOf = (repo, rel) => rawGit(repo, ['hash-object', '--', rel]).trim();

// Opens a task run in `root` and makes one held obligation cite `paths`.
function citingRun(root, paths, { ns = 'experiments/fp', now = at(1), change = '.' } = {}) {
  const opened = nthr(['new-run', '--ns', ns, '--mode', 'task', '--slug', 'fp', '--change', change], { cwd: root, now });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.scope.intent = [{ id: 'I1', anchor: `${paths[0]}#Intent`, note: 'intent' }];
  doc.obligations = [{
    id: 'OB-1', checks: ['FOOT'], claim: 'claim', scope: 'scope', acceptance: 'acceptance',
    coverage: 'named-subset', coverage_method: 'listed', status: 'held', open_reason: null, source_trace: 'consistent',
    evidence: paths.map((p) => ({ anchor: `${p}:1`, note: 'evidence' })),
    intent: ['I1'], assumptions: [], links: [],
  }];
  writeRecords(root, runDir, doc);
  return runDir;
}

const footprint = (root, runDir) => nthr(['footprint', '--run', runDir], { cwd: root });

// Every file below `dir` except one: path, size, mtime, digest.
function treeState(dir, except) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => file !== except)
    .map((file) => {
      const stats = fs.statSync(file);
      return `${path.relative(dir, file)} ${stats.size} ${stats.mtimeMs} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    })
    .sort();
}

test('cited paths: intent, evidence, dependency assumptions, traces and counterevidence, once each', () => {
  const doc = validRecords();
  doc.findings[0].counterevidence.push({ anchor: 'api/src/counter.js:4', note: 'kept' });
  assert.deepEqual(citedPaths(doc), [
    'api/src/counter.js', // counterevidence
    'api/src/guards/owner.js', // a dependency assumption (environment ones cite nothing)
    'api/src/routes.js', // a finding trace
    'api/src/transfer.js', // evidence and trace, recorded once
    'docs/ledger.md', // intent `#Heading`
  ]);
  assert.equal(owningRepository('api/src/x.js', ['.', 'api', 'api/sub']), 'api');
  assert.equal(owningRepository('api/sub/x.js', ['.', 'api', 'api/sub']), 'api/sub');
  assert.equal(owningRepository('apix/y.js', ['.', 'api']), '.');
  assert.equal(owningRepository('notes.md', ['api', 'web']), null);
});

test('states: clean, dirty, staged, untracked, ignored, deleted, renamed and never-existing paths', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), {
    '.gitignore': '*.log\n', 'clean.txt': 'c\n', 'dirty.txt': 'd\n', 'staged.txt': 's\n', 'gone.txt': 'g\n',
    'moved-away.txt': 'm\n', 'git-mv.txt': 'v\n',
  }));
  write(root, 'dirty.txt', 'd changed\n');
  write(root, 'staged.txt', 's staged\n');
  rawGit(root, ['add', 'staged.txt']);
  write(root, 'new.txt', 'n\n');
  write(root, 'debug.log', 'ignored but present\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  fs.renameSync(path.join(root, 'moved-away.txt'), path.join(root, 'moved-here.txt'));
  rawGit(root, ['mv', 'git-mv.txt', 'git-mv-new.txt']);
  write(root, 'empty-ita.txt', '');
  rawGit(root, ['add', '-N', 'empty-ita.txt']); // intent-to-add: the index holds the empty blob
  const cited = ['clean.txt', 'debug.log', 'dirty.txt', 'empty-ita.txt', 'git-mv-new.txt', 'git-mv.txt', 'gone.txt', 'moved-away.txt', 'moved-here.txt', 'never.txt', 'new.txt', 'staged.txt'];
  const runDir = citingRun(root, cited);

  const r = footprint(root, runDir);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const fp = readRecords(root, runDir).footprint;
  assert.deepEqual(Object.keys(fp), cited, 'one entry per cited path, in byte order');
  const head = (rel) => rawGit(root, ['rev-parse', `HEAD:${rel}`]).trim();
  assert.deepEqual(fp['clean.txt'], { blob: head('clean.txt'), state: 'clean', reason: null });
  assert.deepEqual(fp['dirty.txt'], { blob: blobOf(root, 'dirty.txt'), state: 'dirty', reason: null });
  assert.deepEqual(fp['staged.txt'], { blob: blobOf(root, 'staged.txt'), state: 'dirty', reason: null });
  assert.deepEqual(fp['new.txt'], { blob: blobOf(root, 'new.txt'), state: 'untracked', reason: null });
  assert.deepEqual(fp['debug.log'], { blob: blobOf(root, 'debug.log'), state: 'untracked', reason: null });
  for (const absent of ['gone.txt', 'moved-away.txt', 'git-mv.txt', 'never.txt']) {
    assert.deepEqual(fp[absent], { blob: null, state: 'absent', reason: null }, absent);
  }
  assert.deepEqual(fp['moved-here.txt'], { blob: blobOf(root, 'moved-here.txt'), state: 'untracked', reason: null });
  assert.deepEqual(fp['git-mv-new.txt'], { blob: head('git-mv.txt'), state: 'dirty', reason: null }, 'a staged rename keeps the blob');
  assert.deepEqual(fp['empty-ita.txt'], { blob: blobOf(root, 'empty-ita.txt'), state: 'dirty', reason: null }, 'not in HEAD: never clean');
  assert.deepEqual(r.json.result.states, { clean: 1, dirty: 4, untracked: 3, absent: 4, unverified: 0 });
});

test('core.autocrlf=true: a CRLF working tree of a committed file is clean with the committed blob', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), {}));
  rawGit(root, ['config', 'core.autocrlf', 'true']);
  write(root, 'crlf.txt', 'one\r\ntwo\r\n');
  commitAll(root);
  const runDir = citingRun(root, ['crlf.txt']);
  assert.equal(footprint(root, runDir).code, EXIT.OK);
  assert.deepEqual(readRecords(root, runDir).footprint['crlf.txt'], { blob: rawGit(root, ['rev-parse', 'HEAD:crlf.txt']).trim(), state: 'clean', reason: null });
});

test('unverified, never guessed: filtered, secret, linked, nested-repository and directory paths', (t) => {
  const base = makeTempDir(t);
  const marker = path.join(base, 'marker.log');
  const script = write(base, 'logger.mjs', "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], 'ran\\n');\nprocess.stdin.pipe(process.stdout);\n");
  const root = fs.realpathSync.native(makeRepo(path.join(base, 'repo'), { 'plain.txt': 'p\n', 'app/.env': 'TOKEN=placeholder\n' }));
  rawGit(root, ['config', 'filter.logged.clean', `node "${posix(script)}" "${posix(marker)}"`]);
  write(root, '.gitattributes', '*.dat filter=logged\n');
  write(root, 'tracked.dat', 'tracked\n');
  commitAll(root); // the real filter runs here (fixture setup)
  fs.rmSync(marker, { force: true });
  write(root, 'untracked.dat', 'untracked\n');
  write(root, 'app/.env', 'TOKEN=changed\n');
  write(root, 'config/.env.local', 'SECRET=1\n');
  const outside = makeTempDir(t);
  write(outside, 'x.txt', 'outside\n');
  linkDirectory(outside, path.join(root, 'linked'));
  makeRepo(path.join(root, 'deep', 'er', 'est'), { 'f.txt': 'f\n' }); // depth 3: not discovered
  fs.mkdirSync(path.join(root, 'adir'));
  const cited = ['adir', 'app/.env', 'config/.env.local', 'deep/er/est/f.txt', 'linked/x.txt', 'plain.txt', 'tracked.dat', 'untracked.dat'];
  const runDir = citingRun(root, cited);

  const spawned = [];
  const spawn = (cmd, args, options) => {
    spawned.push(args);
    return spawnSync(cmd, args, options);
  };
  const result = footprintRun(root, 'experiments/fp', path.basename(runDir), { gitOptions: { spawn } });
  assert.deepEqual(result.errors, []);
  const fp = readRecords(root, runDir).footprint;
  const reasons = Object.fromEntries(Object.entries(fp).map(([k, v]) => [k, v.reason]));
  assert.deepEqual(reasons, {
    adir: 'unreadable',
    'app/.env': 'secret',
    'config/.env.local': 'secret',
    'deep/er/est/f.txt': 'nested-repository',
    'linked/x.txt': 'link',
    'plain.txt': null,
    'tracked.dat': 'filter',
    'untracked.dat': 'filter',
  });
  for (const [file, entry] of Object.entries(fp)) {
    if (entry.reason) assert.deepEqual(entry, { blob: null, state: 'unverified', reason: entry.reason }, file);
  }
  assert.equal(fs.existsSync(marker), false, 'the filter driver never ran');
  const handed = spawned.flat();
  for (const secret of ['app/.env', 'config/.env.local', 'linked/x.txt', 'tracked.dat']) {
    assert.ok(!spawned.some((args) => args.includes('hash-object') && args.includes(secret)), `${secret} never hashed`);
  }
  assert.ok(handed.includes('filter.logged.clean='), 'the configured driver was disabled');
  const used = new Set(spawned.map((args) => args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-c')));
  assert.ok([...used].every((s) => ['config', 'check-attr', 'hash-object', 'ls-files', 'status'].includes(s)), [...used].join(' '));
  assert.deepEqual(result.unverified.map((u) => u.path), ['adir', 'app/.env', 'config/.env.local', 'deep/er/est/f.txt', 'linked/x.txt', 'tracked.dat', 'untracked.dat']);
});

test('nested repositories: each path is resolved in its owning repository; a path outside every repository is an error', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { 'README.md': 'r\n' }));
  const api = makeRepo(path.join(root, 'api'), { 'src/a.js': '1\n', 'src/b.js': '2\n' });
  write(api, 'src/a.js', '1 changed\n');
  const runDir = citingRun(root, ['README.md', 'api/src/a.js', 'api/src/b.js']);
  assert.equal(footprint(root, runDir).code, EXIT.OK);
  const fp = readRecords(root, runDir).footprint;
  assert.deepEqual(fp['api/src/a.js'], { blob: blobOf(api, 'src/a.js'), state: 'dirty', reason: null });
  assert.deepEqual(fp['api/src/b.js'], { blob: rawGit(api, ['rev-parse', 'HEAD:src/b.js']).trim(), state: 'clean', reason: null });
  assert.equal(fp['README.md'].state, 'clean');

  // A root that is not a repository: its own files belong to no repository.
  const plain = fs.realpathSync.native(makeTempDir(t));
  makeRepo(path.join(plain, 'web'), { 'index.js': 'w\n' });
  write(plain, 'notes.md', 'outside every repository\n');
  const outDir = citingRun(plain, ['notes.md', 'web/index.js'], { change: 'web' });
  const before = fs.readFileSync(recordsFile(plain, outDir));
  const refused = footprint(plain, outDir);
  assert.equal(refused.code, EXIT.INVALID, JSON.stringify(refused.json));
  assert.deepEqual(refused.json.errors, ["notes.md: is cited but is inside none of the snapshot's repositories (C8)"]);
  assert.ok(fs.readFileSync(recordsFile(plain, outDir)).equals(before), 'nothing written');
});

test('an untracked copy of the integration\'s installed files cannot be cited; a tracked copy, a look-alike and a nested repository\'s copy can', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { '.gitignore': 'api/\n', 'src/a.js': 'a\n' }));
  const api = makeRepo(path.join(root, 'api'), { 'x.js': 'x\n' });
  write(root, '.claude/skills/nth-review/SKILL.md', 'skill\n');
  write(root, '.claude/nth-dev-kit-hooks/review.state.json', '{}\n');
  // The optional local exclude makes it ignored: still an untracked copy.
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.claude/nth-dev-kit-hooks/review.state.json\n');
  const runDir = citingRun(root, ['src/a.js', '.claude/nth-dev-kit-hooks/review.state.json', '.claude/skills/nth-review/SKILL.md']);
  const before = fs.readFileSync(recordsFile(root, runDir));
  const why = "is cited but is an untracked copy of this integration's installed files, which no snapshot covers; cite the reviewed source instead";
  const expected = [`.claude/nth-dev-kit-hooks/review.state.json: ${why}`, `.claude/skills/nth-review/SKILL.md: ${why}`];
  const refused = footprint(root, runDir);
  assert.equal(refused.code, EXIT.INVALID, JSON.stringify(refused.json));
  assert.deepEqual(refused.json.errors, expected);
  const close = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(2) });
  assert.equal(close.code, EXIT.INVALID, JSON.stringify(close.json));
  assert.deepEqual(close.json.errors, expected);
  assert.ok(fs.readFileSync(recordsFile(root, runDir)).equals(before), 'nothing written');

  commitAll(root, 'track the skill copy');
  write(root, '.claude/skills/nth-review-x/a.md', 'look-alike\n');
  write(api, '.claude/skills/nth-review/SKILL.md', 'nested\n');
  const allowed = citingRun(root, [
    '.claude/skills/nth-review/SKILL.md', '.claude/skills/nth-review-x/a.md', '.claude/skills/nth-review/gone.md', 'api/.claude/skills/nth-review/SKILL.md',
  ], { ns: 'experiments/fp2' });
  const ok = footprint(root, allowed);
  assert.equal(ok.code, EXIT.OK, JSON.stringify(ok.json));
  const states = Object.fromEntries(Object.entries(readRecords(root, allowed).footprint).map(([file, id]) => [file, id.state]));
  assert.deepEqual(states, {
    '.claude/skills/nth-review-x/a.md': 'untracked', '.claude/skills/nth-review/SKILL.md': 'clean',
    '.claude/skills/nth-review/gone.md': 'absent', 'api/.claude/skills/nth-review/SKILL.md': 'untracked',
  });
});

test('deterministic and idempotent; only an open run; nothing else is written', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { 'a.txt': 'a\n', 'b.txt': 'b\n' }));
  write(root, 'b.txt', 'b changed\n');
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(root, 'a.txt'), later, later); // racy: content-clean, stat-dirty
  const runDir = citingRun(root, ['b.txt', 'a.txt']);
  const records = recordsFile(root, runDir);
  const outsideRecords = treeState(root, records);
  assert.equal(footprint(root, runDir).code, EXIT.OK);
  const first = fs.readFileSync(records);
  assert.equal(footprint(root, runDir).code, EXIT.OK);
  assert.ok(fs.readFileSync(records).equals(first), 'a second footprint writes the same bytes');
  assert.equal(readRecords(root, runDir).footprint['a.txt'].state, 'clean', 'decided by content, not by stat');
  assert.deepEqual(treeState(root, records), outsideRecords, 'no other file changed, .git included');

  closeRun(root, runDir);
  const closed = fs.readFileSync(records);
  const refused = footprint(root, runDir);
  assert.equal(refused.code, EXIT.USAGE);
  assert.match(refused.json.errors[0], /only an open run gets a footprint/);
  assert.ok(fs.readFileSync(records).equals(closed));
});

test('integration: new-run, cited records, footprint, close, check; a stale footprint fails check', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { 'src/a.js': 'a\n', 'src/guard.js': 'g\n', 'docs/spec.md': '# Rules\n' }));
  write(root, 'src/a.js', 'a changed\n');
  const runDir = citingRun(root, ['docs/spec.md', 'src/a.js']);
  const doc = readRecords(root, runDir);
  // A dependency assumption on a helper: kept for indirect invalidation (C11).
  write(root, 'src/draft-helper.js', 'draft\n'); // an untracked dependency
  doc.obligations[0].assumptions = [
    { kind: 'dependency', anchor: 'src/guard.js:1', fact: null, observed: null, note: 'shared guard' },
    { kind: 'dependency', anchor: 'src/draft-helper.js', fact: null, observed: null, note: 'not committed yet' },
    { kind: 'environment', anchor: null, fact: 'one process', observed: 'unknown', note: 'cites no file' },
  ];
  writeRecords(root, runDir, doc);
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.OK, 'an open run needs no footprint yet');

  assert.equal(footprint(root, runDir).code, EXIT.OK);
  const fp = readRecords(root, runDir).footprint;
  assert.deepEqual(Object.keys(fp), ['docs/spec.md', 'src/a.js', 'src/draft-helper.js', 'src/guard.js']);
  assert.deepEqual(fp['src/draft-helper.js'], { blob: blobOf(root, 'src/draft-helper.js'), state: 'untracked', reason: null });
  assert.equal(fp['src/guard.js'].state, 'clean');
  assert.equal(fp['src/a.js'].state, 'dirty');
  closeRun(root, runDir);
  const checked = nthr(['check', '--run', runDir], { cwd: root });
  assert.equal(checked.code, EXIT.OK, JSON.stringify(checked.json));

  // Evidence added after the footprint: check requires a fresh one.
  const stale = readRecords(root, runDir);
  stale.obligations[0].evidence.push({ anchor: 'src/later.js:3', note: 'added later' });
  delete stale.footprint['src/guard.js'];
  stale.footprint['src/unused.js'] = { blob: null, state: 'absent', reason: null };
  writeRecords(root, runDir, stale);
  const errors = nthr(['check', '--run', runDir], { cwd: root }).json.errors;
  assert.ok(errors.includes('$.footprint: src/guard.js is cited but has no entry; run footprint before closing (C9)'), errors.join('\n'));
  assert.ok(errors.includes('$.footprint: src/later.js is cited but has no entry; run footprint before closing (C9)'));
  assert.ok(errors.includes('$.footprint["src/unused.js"]: is not cited by the run; run footprint again'));
});

test('review fixes: per-path retry, case mismatch, cited .nth-review files, a repository replaced by a link', (t) => {
  const base = makeTempDir(t);
  const root = fs.realpathSync.native(makeRepo(path.join(base, 'root'), {
    'a.txt': 'a\n', 'b.txt': 'b\n', 'Foo.txt': 'f\n', '.nth-review/notes.md': 'tracked by mistake\n',
  }));
  makeRepo(path.join(root, 'api'), { 'src/x.js': 'x\n' });
  write(root, '.nth-review/notes.md', 'staged edit\n');
  rawGit(root, ['add', '.nth-review/notes.md']);
  const runDir = citingRun(root, ['.nth-review/notes.md', 'a.txt', 'api/src/x.js', 'b.txt', 'foo.txt']);

  // The repository directory `api` is replaced by a junction after Open.
  const moved = path.join(base, 'api-moved');
  fs.renameSync(path.join(root, 'api'), moved);
  linkDirectory(moved, path.join(root, 'api'));

  // hash-object fails for b.txt (as for a locked or vanished file).
  const spawn = (cmd, args, options) => {
    if (args.includes('hash-object') && args.includes('b.txt')) {
      return { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: could not open b.txt'), signal: null };
    }
    return spawnSync(cmd, args, options);
  };
  const result = footprintRun(root, 'experiments/fp', path.basename(runDir), { gitOptions: { spawn } });
  assert.deepEqual(result.errors, []);
  const fp = readRecords(root, runDir).footprint;
  assert.deepEqual(fp['a.txt'], { blob: rawGit(root, ['rev-parse', 'HEAD:a.txt']).trim(), state: 'clean', reason: null }, 'the rest of the batch is still hashed');
  assert.deepEqual(fp['b.txt'], { blob: null, state: 'unverified', reason: 'unreadable' });
  assert.deepEqual(fp['api/src/x.js'], { blob: null, state: 'unverified', reason: 'link' });
  assert.deepEqual(fp['.nth-review/notes.md'], { blob: blobOf(root, '.nth-review/notes.md'), state: 'dirty', reason: null });
  const insensitive = fs.existsSync(path.join(root, 'FOO.TXT'));
  assert.deepEqual(fp['foo.txt'], insensitive
    ? { blob: null, state: 'unverified', reason: 'case-mismatch' } // tracked as Foo.txt: never guessed
    : { blob: null, state: 'absent', reason: null });
});
