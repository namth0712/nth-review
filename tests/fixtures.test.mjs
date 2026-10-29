// M5-T1: the synthetic fixtures are deterministic, carry their planted items at
// the sealed anchors, never contain an answer, are installed by Enable, and
// behave as the sealed answers say under `new-run` and `fresh`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { VOCAB, repoPathProblem } from '../scripts/lib/schema.mjs';
import { NAMES, SHELF_REPOS, SHELF_TREE, TREE, buildFixture, heads, manifest } from './fixtures/build.mjs';
import { evidenceRefs } from './tools/score.mjs';
import { KIT } from './helpers/library.mjs';
import { at, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { REVIEW_DIR, makeTempDir, rawGit } from './helpers/tmp.mjs';

const FIXTURES = path.join(REVIEW_DIR, 'tests', 'fixtures');
const answers = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'answers.json'), 'utf8'));
const LEDGER = answers('syn-ledger');
const INC = answers('syn-ledger-inc');
const DEBT = answers('syn-debt');
const SHELF = answers('syn-shelf');
const ALL_ITEMS = [...LEDGER.items, ...DEBT.items, ...SHELF.items];
const BUILDER = path.join(FIXTURES, 'build.mjs');

// Shared builds, under one temporary root removed after the file.
let root;
const built = {};
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-t-'));
  built.ledger = buildFixture('syn-ledger', path.join(root, 'ledger')).fixture;
  built.ledger2 = buildFixture('syn-ledger', path.join(root, 'ledger2')).fixture;
  built.debt = buildFixture('syn-debt', path.join(root, 'debt')).fixture;
  built.shelf = buildFixture('syn-shelf', path.join(root, 'shelf')).fixture;
  built.shelf2 = buildFixture('syn-shelf', path.join(root, 'shelf2')).fixture;
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (dir, args) => rawGit(dir, args, { env: { GIT_OPTIONAL_LOCKS: '0' } });
function filesOf(dir, { skip = ['.git'] } = {}) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.includes(e.name) && e.isDirectory()) continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}/`);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}
const readText = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');

// An anchor problem: missing file, range outside it, or `contains` not on its lines.
function anchorProblem(dir, a) {
  const file = path.join(dir, ...a.path.split('/'));
  if (!fs.existsSync(file)) return `${a.path}: missing`;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const [l1, l2] = a.lines;
  if (!(l1 >= 1 && l2 >= l1 && l2 <= lines.length)) return `${a.path}:${l1}-${l2}: outside the file`;
  if (!lines.slice(l1 - 1, l2).some((l) => l.includes(a.contains))) return `${a.path}:${l1}-${l2}: does not contain ${a.contains}`;
  return null;
}

test('syn-ledger: three clean repositories, the expected change, size M, installed by Enable', () => {
  const dir = built.ledger;
  assert.deepEqual(Object.fromEntries(['.', 'api', 'admin'].map((r) => [r, git(path.join(dir, r), ['rev-list', '--count', 'HEAD']).trim()])), { '.': '2', api: '2', admin: '1' });
  for (const r of ['.', 'api', 'admin']) assert.equal(git(path.join(dir, r), ['status', '--porcelain']), '', `${r} is clean`);
  assert.deepEqual(git(dir, ['diff', '--name-only', 'HEAD~1', 'HEAD']).trim().split('\n'), ['CHANGELOG.md', 'docs/api.md', 'docs/ledger.md']);
  assert.deepEqual(git(path.join(dir, 'api'), ['diff', '--name-only', 'HEAD~1', 'HEAD']).trim().split('\n'),
    ['README.md', 'package.json', 'src/routes/index.js', 'src/routes/statements.js', 'src/routes/sweeps.js', 'src/routes/transfers.js', 'src/routes/withdrawals.js', 'src/shared/limits.js']);
  // Installed by Enable: the state file and exactly the runtime files, byte for byte.
  const state = JSON.parse(readText(dir, '.claude/nth-dev-kit-hooks/review.state.json'));
  assert.equal(state.skill.pending, undefined);
  const installed = filesOf(path.join(dir, '.claude', 'skills', 'nth-review'));
  assert.deepEqual(installed, Object.keys(state.skill.files).sort());
  assert.ok(!installed.some((f) => f.startsWith('tests/') || f === 'VALIDATION.md' || f === 'RELEASE.md'), 'no development files installed');
  for (const rel of installed) assert.ok(fs.readFileSync(path.join(dir, '.claude', 'skills', 'nth-review', rel)).equals(fs.readFileSync(path.join(REVIEW_DIR, rel))), rel);
  // The sealed run plan matches what new-run decides (on a copy: new-run writes records).
  const copy = path.join(root, 'ledger-run');
  fs.cpSync(dir, copy, { recursive: true });
  const run = LEDGER.runs[0];
  const opened = nthr(['new-run', '--ns', run.ns, '--mode', 'task', '--slug', 'ledger', ...run.changes.flatMap((c) => ['--change', c])], { cwd: copy, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.equal(opened.json.result.size.class, run.expected_size);
  assert.equal(opened.json.result.required_lead_model, run.required_lead_model);
  assert.equal(nthr(['check', '--run', opened.json.result.run_dir], { cwd: copy }).code, EXIT.OK);
});

test('no answers in any fixture: no answers file, item id, mechanism, label word, identity or user config', () => {
  const denied = /planted|answer|fixture|synthetic|negative control|\btrap\b|\bbug|vulnerab|insecure|\btodo\b|fixme|nth-review|nthr|syn-/i;
  const ids = /\b(P[1-6]|N[12]|X[1-4]|T1|E[1-4]|EN[12])\b/;
  const mechanisms = ALL_ITEMS.map((i) => i.mechanism);
  for (const [dir, repos] of [[built.ledger, ['.', 'api', 'admin']], [built.debt, ['.', 'api', 'admin']], [built.shelf, ['.']]]) {
    const all = filesOf(dir);
    assert.ok(!all.some((f) => path.basename(f) === 'answers.json'), 'no answers file');
    for (const rel of all.filter((f) => !f.startsWith('.claude/'))) {
      const text = readText(dir, rel);
      assert.ok(!denied.test(text), `${rel} has a label word: ${text.match(denied)?.[0]}`);
      assert.ok(!ids.test(text), `${rel} names an item id: ${text.match(ids)?.[0]}`);
      for (const m of mechanisms) assert.ok(!text.includes(m), `${rel} contains a mechanism`);
    }
    for (const r of repos) {
      const log = git(path.join(dir, r), ['log', '--all', '--format=%an%n%ae%n%cn%n%ce%n%B']);
      assert.ok(!denied.test(log) && !ids.test(log), `${r} history is neutral`);
      assert.ok(!/^\s*\[user\]/m.test(fs.readFileSync(path.join(dir, r, '.git', 'config'), 'utf8')), `${r} has no user config`);
    }
  }
  // The builder output names no item either.
  for (const name of ['syn-ledger', 'syn-shelf']) {
    const result = spawnSync(process.execPath, [BUILDER, name, path.join(root, `cli-${name}`)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!ids.test(result.stdout) && !/answers/.test(result.stdout));
  }
});

test('every planted item, control, census mechanism and population member is where the answers say', () => {
  const check = (dir, anchors, label) => {
    for (const a of anchors) assert.equal(anchorProblem(dir, a), null, `${label}: ${a.path}`);
  };
  for (const [dir, doc] of [[built.ledger, LEDGER], [built.debt, DEBT], [built.shelf, SHELF]]) {
    for (const item of doc.items) {
      check(dir, item.anchors, item.id);
      for (const e of item.required_evidence) for (const ref of evidenceRefs(e)) assert.ok(item.anchors[ref], `${item.id} ${e.id} refers to an anchor`);
      for (const r of item.refutation?.counterevidence_anchor_refs ?? []) assert.ok(item.anchors[r], `${item.id} refutation anchor ${r}`);
      for (const absent of item.absent) {
        const prefix = absent.path_glob.replace(/\*\*$/, '');
        const scope = filesOf(dir).filter((f) => (absent.path_glob.endsWith('**') ? f.startsWith(prefix) : f === absent.path_glob));
        assert.ok(scope.length > 0, `${item.id}: ${absent.path_glob} names files`);
        for (const f of scope) assert.ok(!readText(dir, f).includes(absent.contains), `${item.id}: ${f} must not contain ${absent.contains}`);
      }
    }
  }
  for (const [dir, doc] of [[built.ledger, LEDGER], [built.shelf, SHELF]]) {
    check(dir, doc.census.mechanisms, 'census');
    for (const [name, p] of Object.entries(doc.census.population)) {
      assert.equal(p.members.length, p.count, name);
      check(dir, p.members, name);
    }
    for (const a of doc.unplanned_allowances) check(dir, a.anchors, a.id);
  }
  // The admin mirror differs from its source by exactly one line.
  const source = readText(built.ledger, 'api/src/shared/limits.js').split('\n');
  const mirror = readText(built.ledger, 'admin/src/shared/limits.js').split('\n');
  assert.equal(source.length, mirror.length);
  assert.equal(source.filter((l, i) => l !== mirror[i]).length, 1);
});

test('determinism: rebuilds are byte-identical and match the sealed heads', () => {
  assert.deepEqual(manifest(built.ledger2), manifest(built.ledger));
  assert.deepEqual(heads(built.ledger), LEDGER.heads);
  assert.deepEqual(heads(built.ledger2), LEDGER.heads);
  assert.deepEqual(heads(built.debt), DEBT.heads);
  assert.deepEqual(manifest(built.shelf2), manifest(built.shelf));
  assert.deepEqual(heads(built.shelf, SHELF_REPOS), SHELF.heads);
  assert.deepEqual(heads(built.shelf2, SHELF_REPOS), SHELF.heads);
  assert.ok(!filesOf(built.shelf).some((f) => readText(built.shelf, f).includes('\r')), 'syn-shelf LF only');
  assert.equal(INC.base.heads['.'], LEDGER.heads['.']);
  assert.ok(!filesOf(built.ledger).some((f) => readText(built.ledger, f).includes('\r')), 'LF only');
});

// A closed first review on a copy of syn-ledger, as a lead would record it.
function firstReview(dir) {
  const opened = nthr(['new-run', '--ns', 'experiments/ledger', '--mode', 'task', '--slug', 'ledger', ...LEDGER.runs[0].changes.flatMap((c) => ['--change', c])], { cwd: dir, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(dir, runDir);
  Object.assign(doc.run.runtime, { lead_model: 'claude-opus-5-5', lead_effort: 'high', triggers: ['task-size', 'authorization', 'money'] });
  doc.scope.summary = 'Task review of the money movement change.';
  doc.scope.intent = [
    { id: 'I1', anchor: 'docs/authorization.md#Account references', note: 'every named account belongs to the customer' },
    { id: 'I2', anchor: 'docs/operations.md#Daily interest', note: 'one interest entry per account and day' },
  ];
  const sweeps = INC.target.match.obligation_cites;
  const ob = (id, evidence, intent, deps) => ({
    id, checks: ['AUTHZ.2'], claim: `claim of ${id}`, scope: 'one handler', acceptance: 'as documented', coverage: 'all-enumerated', coverage_method: 'the route table',
    status: 'held', open_reason: null, source_trace: 'consistent', evidence: [{ anchor: evidence, note: 'handler' }], intent: [intent],
    assumptions: deps.map((d) => ({ kind: 'dependency', anchor: d, fact: null, observed: null, note: 'guard' })), links: [],
  });
  const guard = LEDGER.items.find((i) => i.id === 'N1').anchors.find((a) => a.role === 'refutation');
  doc.obligations = [
    ob('OB-sweeps', `${sweeps}:12-13`, 'I1', [`${guard.path}:4-12`]),
    ob('OB-interest', 'api/src/jobs/interest.js:16-18', 'I2', []),
  ];
  writeRecords(dir, runDir, doc);
  const closed = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: dir, now: at(2) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  return path.basename(runDir);
}

test('syn-ledger-inc: each variant matches its sealed heads, history and changed files; the target reopens, the independent obligation does not', () => {
  const reviewed = path.join(root, 'reviewed');
  fs.cpSync(built.ledger, reviewed, { recursive: true });
  const r1 = firstReview(reviewed);
  for (const variant of ['committed', 'rewritten', 'dirty']) {
    const name = variant === 'committed' ? 'syn-ledger-inc' : `syn-ledger-inc-${variant}`;
    const dir = buildFixture(name, path.join(root, name), { from: reviewed }).fixture;
    assert.deepEqual(heads(dir), INC.heads[variant], `${variant} heads`);
    const opened = nthr(['new-run', '--ns', 'experiments/ledger', '--mode', 'incremental', '--slug', 'ledger-inc', '--base', r1], { cwd: dir, now: at(10) });
    assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
    assert.equal(nthr(['fresh', '--run', opened.json.result.run_dir], { cwd: dir, now: at(11) }).code, EXIT.OK);
    const freshness = readRecords(dir, opened.json.result.run_dir).freshness;
    const expected = INC.variants[variant];
    assert.deepEqual(Object.fromEntries(freshness.repos.map((r) => [r.path, r.outcome])), expected.history, `${variant} history`);
    const changed = freshness.changed_files.map((c) => `${c.path}:${c.change}`).sort();
    if (expected.api_all_files_changed) {
      assert.equal(changed.length, expected.changed_files_total);
      for (const c of expected.changed_files) assert.ok(changed.includes(`${c.path}:${c.change}`), `${variant}: ${c.path}`);
    } else {
      assert.deepEqual(changed, expected.changed_files.map((c) => `${c.path}:${c.change}`).sort(), `${variant} changed files`);
    }
    const byId = Object.fromEntries(freshness.obligations.map((o) => [o.id, o]));
    assert.equal(byId['OB-sweeps'].class, 'touched', `${variant}: target never current`);
    assert.match(byId['OB-sweeps'].reason, variant === 'rewritten' ? /base-missing/ : /api\/src\/guards\.js/);
    assert.equal(byId['OB-interest'].class, variant === 'rewritten' ? 'touched' : 'current', `${variant}: independent obligation`);
  }
});

test('syn-debt: R1 is size S with 3 subagent calls, fewer than the refuter work its candidates need', () => {
  const copy = path.join(root, 'debt-run');
  fs.cpSync(built.debt, copy, { recursive: true });
  const run = DEBT.runs[0];
  const opened = nthr(['new-run', '--ns', run.ns, '--mode', 'task', '--slug', 'payouts', ...run.changes.flatMap((c) => ['--change', c])], { cwd: copy, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.equal(opened.json.result.size.class, run.expected_size);
  assert.equal(opened.json.result.budget.subagent_calls, run.expected_subagent_calls);
  const pressure = DEBT.budget_pressure;
  assert.ok(pressure.r5_routed_candidates.length > pressure.subagent_calls - pressure.plan_critique_calls);
});

test('syn-shelf: one clean repository, a Task S change with no trigger, installed by Enable, opened for a Sonnet lead', () => {
  const dir = built.shelf;
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).trim(), '2');
  assert.equal(git(dir, ['status', '--porcelain']), '');
  assert.deepEqual(git(dir, ['diff', '--name-only', 'HEAD~1', 'HEAD']).trim().split('\n'),
    ['CHANGELOG.md', 'README.md', 'docs/shelf.md', 'package.json', 'src/commands/index.js', 'src/commands/list.js', 'src/commands/progress.js', 'src/progress.js']);
  const numstat = git(dir, ['diff', '--numstat', 'HEAD~1', 'HEAD']).trim().split('\n').map((l) => l.split('\t'));
  assert.ok(numstat.length <= 15, 'at most 15 files');
  assert.ok(numstat.reduce((n, [a, d]) => n + Number(a) + Number(d), 0) <= 400, 'at most 400 lines');
  const state = JSON.parse(readText(dir, '.claude/nth-dev-kit-hooks/review.state.json'));
  assert.equal(state.skill.pending, undefined);
  // The change names nothing a lead-model trigger is about (a vocabulary check, not proof).
  const diff = git(dir, ['diff', 'HEAD~1', 'HEAD']);
  assert.doesNotMatch(diff, /\b(auth\w*|session|token|password|role|owner|price|money|payment|balance|invoice|migrat\w*|ALTER|CREATE TABLE|schema|lock|mutex|thread|worker|queue|concurren\w*|async|await|setInterval|prompt|openai|anthropic|llm)\b/i);
  const copy = path.join(root, 'shelf-run');
  fs.cpSync(dir, copy, { recursive: true });
  const run = SHELF.runs[0];
  const opened = nthr(['new-run', '--ns', run.ns, '--mode', 'task', '--slug', 'shelf', ...run.changes.flatMap((c) => ['--change', c])], { cwd: copy, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.equal(opened.json.result.size.class, run.expected_size);
  assert.equal(opened.json.result.required_lead_model, run.required_lead_model);
  assert.deepEqual(readRecords(copy, opened.json.result.run_dir).run.runtime.triggers, run.expected_triggers);
  assert.equal(nthr(['check', '--run', opened.json.result.run_dir], { cwd: copy }).code, EXIT.OK);
});

test('the builder refuses a non-empty directory, a work tree, a place outside the temporary directory, a bad --from and an unknown name', (t) => {
  const cli = (...args) => spawnSync(process.execPath, [BUILDER, ...args], { encoding: 'utf8', windowsHide: true });
  const full = makeTempDir(t, 'ledger-r-');
  fs.writeFileSync(path.join(full, 'x'), 'x');
  assert.equal(cli('syn-ledger', full).status, 2);
  const repo = makeTempDir(t, 'ledger-r-');
  rawGit(repo, ['init', '-q']);
  assert.equal(cli('syn-ledger', path.join(repo, 'inner')).status, 2);
  const outside = path.join(path.dirname(KIT), `ledger-refused-${process.pid}`);
  assert.equal(cli('syn-ledger', outside).status, 2);
  assert.ok(!fs.existsSync(outside), 'nothing created outside the temporary directory');
  const notLedger = makeTempDir(t, 'ledger-r-');
  assert.equal(cli('syn-ledger-inc', path.join(makeTempDir(t, 'ledger-r-'), 'out'), '--from', notLedger).status, 2);
  assert.equal(cli('syn-ledger-x', path.join(makeTempDir(t, 'ledger-r-'), 'out')).status, 2);
  assert.equal(cli('syn-shelf', path.join(makeTempDir(t, 'ledger-r-'), 'out'), '--from', notLedger).status, 2);
  assert.equal(cli('syn-ledger').status, 2);
});

test('answers contract: schema, unique ids, gating, safe anchors and the records vocabulary', () => {
  const kinds = ['sites', 'callers', 'entries', 'schedules', 'events', 'migrations', 'scripts', 'mirrors', 'clients', 'dynamic'];
  const ROLES = ['entrypoint', 'propagation', 'site', 'sink', 'rule', 'refutation'];
  const vocab = { kind: VOCAB.findingKind, verdict: VOCAB.verdict, status: [...VOCAB.obligationStatus, ...VOCAB.censusStatus], open_reason: VOCAB.openReason };
  for (const doc of [LEDGER, INC, DEBT, SHELF]) {
    assert.equal(doc.schema, 'nthr-fixture-answers@1');
    assert.ok(NAMES.includes(doc.fixture));
    assert.equal(doc.scoring.line_tolerance, 3);
  }
  assert.deepEqual(LEDGER.items.map((i) => i.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'N1', 'N2']);
  assert.ok(LEDGER.items.every((i) => i.gating === true), 'P1-P6 and N1-N2 gate (delivery roadmap §4)');
  assert.deepEqual(DEBT.items.map((i) => i.id), ['X1', 'X2', 'X3', 'X4']);
  assert.ok(DEBT.items.every((i) => i.gating === false), 'X items are reported, not gating');
  assert.deepEqual(SHELF.items.map((i) => i.id), ['E1', 'E2', 'E3', 'E4', 'EN1', 'EN2']);
  assert.ok(SHELF.items.every((i) => i.gating === true), 'the comparison items gate the Sonnet decision');
  const g5 = SHELF.scoring.g5;
  const shelfIds = SHELF.items.map((i) => i.id);
  for (const id of [...g5.must_find, ...g5.four, ...g5.controls]) assert.ok(shelfIds.includes(id), `g5 names ${id}`);
  assert.ok(g5.controls.every((id) => SHELF.items.find((i) => i.id === id).expect === 'no-defect'));
  assert.deepEqual(SHELF.runs[0].expected_triggers, []);
  assert.deepEqual(Object.keys(SHELF.runs[0].triggers_absent).sort(), [...VOCAB.trigger].sort(), 'a reason for every trigger');
  for (const item of ALL_ITEMS) {
    for (const a of item.anchors) {
      assert.ok(ROLES.includes(a.role), `${item.id} role ${a.role}`);
      assert.equal(repoPathProblem(a.path), null, `${item.id} ${a.path}`);
    }
    for (const c of item.checks) assert.match(c, /^[A-Z][A-Z-]*(\.\d+)?$/);
    for (const preds of Object.values(item.outcomes)) {
      for (const p of preds) {
        for (const [field, values] of Object.entries({ ...p.finding, ...p.obligation, ...p.census })) {
          if (vocab[field]) for (const v of values) assert.ok(vocab[field].includes(v), `${item.id}: ${field} ${v}`);
        }
        for (const v of p.debt?.kind ?? []) assert.ok(VOCAB.debtKind.includes(v), `${item.id}: debt ${v}`);
      }
    }
  }
  for (const m of [...LEDGER.census.mechanisms, ...SHELF.census.mechanisms]) assert.ok(kinds.includes(m.kind), m.kind);
  for (const variant of Object.values(INC.variants)) {
    for (const outcome of Object.values(variant.history)) assert.ok(VOCAB.historyOutcome.includes(outcome));
    for (const c of variant.changed_files) assert.ok(VOCAB.changeType.includes(c.change));
  }
});

test('template hygiene: LF only, and no template matches a node --test default pattern', () => {
  const testPattern = /(^|\/)(test(-[^/]*)?\.[cm]?js|[^/]*[.\-_]test\.[cm]?js|test\/.*\.[cm]?js)$/;
  for (const tree of [TREE, SHELF_TREE]) {
    for (const rel of filesOf(tree)) {
      assert.ok(!testPattern.test(rel), rel);
      assert.ok(!readText(tree, rel).includes('\r'), `${rel} is LF`);
    }
  }
});
