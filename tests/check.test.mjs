import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkRun, globMatches, parseRunArg } from '../scripts/lib/check.mjs';
import { EXIT } from '../scripts/lib/cli.mjs';
import { BASE, RUN, validRecords } from './helpers/records.mjs';
import { linkDirectory } from './helpers/repo.mjs';
import { nthr, writeRecords, writeRun } from './helpers/runs.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

// The closed base run that validRecords() names, with the debt it hands on.
function baseRecords() {
  const doc = validRecords({ status: 'complete' });
  Object.assign(doc.run, { id: BASE, mode: 'task', slug: 'demo', base: null, opened: '2026-10-24T09:00:00Z', closed: '2026-10-24T10:00:00Z' });
  doc.debt = { in: [], out: [{ id: `${BASE}/D1`, kind: 'owner-fact', refs: ['OB-02'], requires: 'the process count', priority: 'low' }] };
  doc.freshness = null;
  return doc;
}

// T9's chain: the base and a valid closed (incomplete) incremental run.
function chain(t, edit) {
  const root = makeTempDir(t);
  writeRun(root, baseRecords());
  const doc = validRecords({ status: 'incomplete' });
  edit?.(doc, root);
  return { root, doc, dir: writeRun(root, doc) };
}

function errorsFor(t, edit, options) {
  const { root, dir } = chain(t, edit);
  return checkRun(root, dir, options).errors;
}

function assertError(errors, pattern, label) {
  assert.ok(errors.some((e) => pattern.test(e)), `${label}: expected ${pattern} in ${JSON.stringify(errors, null, 1)}`);
}

test('T9: a valid closed incremental run passes, through the CLI too', (t) => {
  const { root, dir } = chain(t);
  assert.deepEqual(checkRun(root, dir), { run_dir: dir, status: 'incomplete', errors: [], warnings: [] });
  const cli = nthr(['check', '--run', dir], { cwd: root });
  assert.equal(cli.code, EXIT.OK, JSON.stringify(cli.json));
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, ...dir.split('/'), 'records.json'))).digest('hex');
  assert.deepEqual(cli.json.result, { valid: true, run_dir: dir, status: 'incomplete', warnings: [], records_sha256: digest });
});

test('T10: one injected defect at a time fails with the matching error (exit 1)', (t) => {
  const cases = [
    ['dropped debt', (d) => { d.debt.in = []; }, /\$\.debt\.in: .*\/D1 from .* has no entry: debt cannot be dropped/],
    ['a held obligation without evidence', (d) => { Object.assign(d.obligations[1], { status: 'held', open_reason: null, evidence: [] }); }, /\$\.obligations\[1\]\.evidence: a held obligation needs cited evidence/],
    ['a confirmed defect without verification', (d) => { d.findings[0].verification = { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }; }, /\$\.findings\[0\]\.verification: a confirmed defect needs a completed R5 or R6 verification/],
    ['a risk with a severity', (d) => { Object.assign(d.findings[0], { kind: 'risk' }); }, /\$\.findings\[0\]\.severity: a risk has no severity/],
    ['a needs_validation finding without a plan', (d) => { Object.assign(d.findings[0], { verdict: 'needs_validation', severity: null, validation_plan: null }); }, /\$\.findings\[0\]\.validation_plan: a needs_validation finding needs a validation plan/],
    ['a stray file', null, /run directory: notes\.txt: unexpected/, (runDir) => fs.writeFileSync(path.join(runDir, 'notes.txt'), 'x')],
    ['overspend without incomplete/budget', (d) => { d.run.incomplete_reason = 'open-obligations'; d.budget.spent.lead_tool_calls = 41; }, /\$\.budget\.spent\.lead_tool_calls: 41 exceeds the budget of 40; close as incomplete with reason budget/],
    ['a sonnet lead with triggers', (d) => { d.run.runtime.lead_model = 'claude-sonnet-5-5'; }, /\$\.run\.runtime\.lead_model: claude-sonnet-5-5 does not meet the required opus-high \(triggers: authorization\)/],
    ['an opus delegation without effort high', (d) => { d.delegations[0].effort = null; }, /\$\.delegations\[0\]\.effort: an opus delegation must set effort high/],
  ];
  for (const [label, edit, pattern, after] of cases) {
    const { root, dir } = chain(t, edit ?? undefined);
    after?.(path.join(root, ...dir.split('/')));
    const cli = nthr(['check', '--run', dir], { cwd: root });
    assert.equal(cli.code, EXIT.INVALID, `${label}: ${JSON.stringify(cli.json)}`);
    assert.equal(cli.json.ok, false);
    assertError(cli.json.errors, pattern, label);
  }
});

test('T11: an official run carrying debt from another namespace fails', (t) => {
  const root = makeTempDir(t);
  const charter = path.join(root, '.nth-review', 'audits', 'core', 'charter.json');
  fs.mkdirSync(path.dirname(charter), { recursive: true });
  fs.writeFileSync(charter, JSON.stringify({ official: true }));
  const experimentDebt = '20261020-100000-task-pilot/D1'; // a run that exists only under experiments/
  writeRun(root, { ...baseRecords(), run: { ...baseRecords().run, namespace: 'experiments/pilot', id: '20261020-100000-task-pilot', slug: 'pilot' } });

  const units = [{ id: 'U-01', title: 'Ledger', tier: 1, status: 'planned', depends_on: [], runs: [], reason: null }];
  const plan = baseRecords();
  Object.assign(plan.run, { id: '20261025-090000-audit-plan-plan', namespace: 'audits/core', mode: 'audit-plan', slug: 'plan' });
  plan.run.runtime.required_lead_model = 'opus-high';
  plan.scope.units = units;
  plan.debt.out = [{ id: experimentDebt, kind: 'runtime', refs: [], requires: 'x', priority: 'low' }];
  writeRun(root, plan);

  const unit = validRecords({ status: 'incomplete' });
  Object.assign(unit.run, { id: '20261026-090000-audit-unit-u1', namespace: 'audits/core', mode: 'audit-unit', slug: 'u1', unit: 'U-01', base: plan.run.id });
  unit.scope.units = units;
  unit.freshness = null;
  unit.debt.in = [{ id: experimentDebt, from_run: plan.run.id, disposition: 'carried', note: null }];
  unit.debt.out = [unit.debt.out[0], { id: experimentDebt, kind: 'runtime', refs: [], requires: 'x', priority: 'low' }];
  unit.debt.out[0].id = `${unit.run.id}/D1`;
  unit.obligations[1].links = [`${unit.run.id}/D1`];
  const dir = writeRun(root, unit);

  const errors = checkRun(root, dir, { officialAuditsEnabled: true }).errors;
  assertError(errors, /\$\.debt\.in\[0\]\.id: originates in 20261020-100000-task-pilot, which is not a run in audits\/core; an official run may not carry debt from another namespace/, 'T11');
  // And the audit gate itself: disabled, or no charter.
  assertError(checkRun(root, dir).errors, /\$\.run\.namespace: official audits are disabled/, 'disabled');
  fs.rmSync(charter);
  assertError(checkRun(root, dir, { officialAuditsEnabled: true }).errors, /no charter\.json/, 'no charter');
});

test('more defects: debt continuity, references, coverage, completion, routing, accounting', (t) => {
  const cases = [
    ['a carried item missing from debt-out', (d) => { d.debt.out.pop(); }, /\$\.debt\.in\[0\]: a carried item must reappear in debt\.out/],
    ['a discharged item still open', (d) => { Object.assign(d.debt.in[0], { disposition: 'discharged', note: 'fixed' }); }, /\$\.debt\.out\[1\]\.id: is discharged in debt\.in/],
    ['debt-in not in the parent', (d) => { d.debt.in.push({ id: `${BASE}/D9`, from_run: BASE, disposition: 'obsolete', note: 'gone' }); }, /\$\.debt\.in\[1\]\.id: is not in the debt-out of/],
    ['a new debt id not owned by the run', (d) => { d.debt.out[0].id = `${BASE}/D7`; }, /\$\.debt\.out\[0\]\.id: must be .*\/D<n> or a carried debt-in id/],
    ['a finding linking an unknown obligation', (d) => { d.findings[0].obligation = 'OB-99'; }, /\$\.findings\[0\]\.obligation: OB-99 is not an obligation/],
    ['an unknown intent', (d) => { d.obligations[0].intent = ['I9']; }, /\$\.obligations\[0\]\.intent\[0\]: I9 is not in scope\.intent/],
    ['a duplicate obligation id', (d) => { d.obligations[1].id = 'OB-01'; }, /\$\.obligations\[1\]\.id: duplicate id OB-01/],
    ['a changed file without a census item (C11)', (d) => { d.census.items.pop(); }, /\$\.freshness\.changed_files\[1\]: api\/src\/new\.js has no census item/],
    ['a census item without affects or reason', (d) => { Object.assign(d.census.items[2], { affects: null }); }, /covers changed file api\/src\/new\.js: it needs affects/],
    ['freshness for another base', (d) => { d.freshness.base_run = RUN; }, /\$\.freshness\.base_run: must be the run's base/],
    ['a closed incremental run without freshness', (d) => { d.freshness = null; }, /\$\.freshness: an incremental run records freshness before it closes/],
    ['all-enumerated with incomplete discovery', (d) => { d.snapshot.discovery_complete = false; d.snapshot.limitations.push({ code: 'scan-limit', path: '.' }); }, /\$\.obligations\[0\]\.coverage: cannot be all-enumerated: repository discovery was incomplete/],
    ['complete with an open obligation', (d) => { Object.assign(d.run, { status: 'complete', incomplete_reason: null }); }, /\$\.obligations\[1\]\.status: a complete run has no open obligation/],
    ['complete with a candidate', (d) => { Object.assign(d.run, { status: 'complete', incomplete_reason: null }); Object.assign(d.obligations[1], { status: 'held', open_reason: null }); d.findings[0].verdict = 'candidate'; }, /\$\.findings\[0\]\.verdict: a complete run has no unverified candidate/],
    ['complete while carrying inherited debt', (d) => { Object.assign(d.run, { status: 'complete', incomplete_reason: null }); }, /\$\.debt\.in\[0\]\.disposition: a complete run carries no open debt/],
    ['a rejected finding without counterevidence', (d) => { Object.assign(d.findings[0], { verdict: 'rejected', counterevidence: [] }); }, /\$\.findings\[0\]\.counterevidence: a rejected finding needs counterevidence/],
    ['violated without a confirmed finding', (d) => { d.findings[0].verdict = 'rejected'; }, /\$\.obligations\[0\]\.status: violated needs a linked finding/],
    ['held while linked to a confirmed defect', (d) => { Object.assign(d.obligations[0], { status: 'held' }); }, /\$\.obligations\[0\]\.status: cannot be held: F-01 is a confirmed defect/],
    ['a high defect verified by the batch refuter', (d) => { Object.assign(d.findings[0].verification, { role: 'R6', model: 'sonnet' }); }, /\$\.findings\[0\]\.verification\.role: a critical or high defect/],
    ['a verification with no completed delegation (C17)', (d) => { d.delegations[0].completed = false; }, /\$\.findings\[0\]\.verification: no completed R5 opus delegation/],
    ['a delegation run by the wrong agent', (d) => { d.delegations[0].agent = 'Explore'; }, /\$\.delegations\[0\]\.agent: R5 is run by reviewer/],
    ['two recovery messages', (d) => { d.delegations[0].recovery_messages = 2; }, /\$\.delegations\[0\]\.recovery_messages: at most one/],
    ['an xhigh lead', (d) => { d.run.runtime.lead_effort = 'xhigh'; }, /\$\.run\.runtime\.lead_effort: review execution uses high effort at most/],
    ['triggers with a sonnet requirement', (d) => { d.run.runtime.required_lead_model = 'sonnet'; }, /\$\.run\.runtime\.required_lead_model: must be opus-high when triggers are set/],
    ['fewer subagent calls than delegations', (d) => { d.budget.spent.subagent_calls = 0; }, /\$\.budget\.spent\.subagent_calls: is less than the 1 recorded delegations/],
    ['more obligations than the outline cap (B3)', (d) => { d.budget.obligations_max = 1; }, /\$\.obligations: 2 obligations exceed the outline cap of 1/],
    ['a base outside the namespace', (d) => { d.run.base = '20261023-090000-task-elsewhere'; d.freshness.base_run = d.run.base; }, /\$\.run\.base: 20261023-090000-task-elsewhere is not a run in experiments\/demo/],
    ['freshness in a task run', (d) => { d.run.mode = 'task'; d.run.id = d.run.id.replace('incremental', 'task'); }, /\$\.freshness: is written only in incremental runs/],
  ];
  for (const [label, edit, pattern] of cases) assertError(errorsFor(t, edit), pattern, label);

  // Records copied into another run's directory (N1: the path decides).
  const { root, doc, dir } = chain(t);
  const elsewhere = '.nth-review/experiments/other/runs/20261026-120000-incremental-copy';
  writeRecords(root, elsewhere, doc);
  const errors = checkRun(root, elsewhere).errors;
  assertError(errors, /\$\.run\.namespace: must be experiments\/other, the namespace of its directory/, 'namespace');
  assertError(errors, /\$\.run\.id: must be 20261026-120000-incremental-copy, its directory name/, 'id');
  assert.deepEqual(checkRun(root, dir).errors, []);
});

test('C13: all-enumerated is refused when an unknown census item bears on it or an excluded item names it; unrelated and justified items pass', (t) => {
  const item = (status, affects, extra = {}) => (d) => {
    d.census.items.push({ id: 'CI-9', path: 'api/src/dispatch.js', mechanism: 'dispatch table built at runtime', status, reason: 'the table comes from configuration', affects, ...extra });
  };
  const blocked = /\$\.obligations\[0\]\.coverage: cannot be all-enumerated: census items CI-9 bear on it .*\(C13\)/;
  // The original false-Verified case, and unknown applicability treated conservatively.
  for (const [label, edit] of [
    ['an unknown item naming the obligation', item('unknown', ['OB-01'])],
    ['an unknown item naming no obligation (null)', item('unknown', null)],
    ['an unknown item naming no obligation ([])', item('unknown', [])],
    ['an unknown item naming it among others', item('unknown', ['OB-02', 'OB-01'])],
    ['an excluded item naming the obligation', item('excluded', ['OB-01'], { reason: 'excluded by the owner' })],
    ['the same claim in an open run', (d) => { item('unknown', ['OB-01'])(d); Object.assign(d.run, { status: 'open', closed: null, incomplete_reason: null }); d.debt.in[0].disposition = null; }],
  ]) assertError(errorsFor(t, edit), blocked, label);
  // Justified exclusions and items scoped elsewhere leave the claim alone.
  for (const [label, edit] of [
    ['an unknown item scoped to another obligation', item('unknown', ['OB-02'])],
    ['an excluded item naming no obligation', item('excluded', null, { path: 'api/src/*.snap', reason: 'generated snapshots' })],
    ['an excluded item naming another obligation', item('excluded', ['OB-02'], { reason: 'excluded by the owner' })],
    ['a classified item naming no obligation, with a reason', item('classified', null, { reason: 'logging only' })],
    ['a classified item naming the obligation', item('classified', ['OB-01'], { reason: null })],
    // An open obligation's coverage is a target, not yet a claim: it never blocks a checkpoint or an abandon.
    ['an open obligation targeting all-enumerated', (d) => { d.obligations[1].coverage = 'all-enumerated'; item('unknown', ['OB-02'])(d); }],
  ]) assert.deepEqual(errorsFor(t, edit), [], label);
});

test('Incremental (C11): a non-current base obligation is re-recorded, and a held one is not the base evidence copied unchanged', (t) => {
  const has = (errors, pattern) => errors.some((e) => pattern.test(e));
  const dropped = /\$\.freshness\.obligations\[0\]: base obligation OB-01 is touched; re-record it in this run and reassess it \(C11\)/;
  const copied = /\$\.obligations\[0\]\.evidence: OB-01 is touched since the base, yet held on the base's evidence unchanged/;
  const drop = (d) => { d.obligations.shift(); d.findings = []; d.census.items.forEach((i) => { i.affects = null; i.reason = 'reassessed elsewhere'; }); d.delegations = []; d.budget.spent.subagent_calls = 0; };
  const hold = (d) => { Object.assign(d.obligations[0], { status: 'held', links: [] }); d.findings = []; };
  assert.ok(has(errorsFor(t, drop), dropped), 'a dropped touched obligation');
  assert.ok(has(errorsFor(t, hold), copied), 'held on the base evidence copied');
  // Recorded again after reassessment, current in freshness, or still open: no such error.
  assert.ok(!has(errorsFor(t, (d) => { hold(d); d.obligations[0].evidence[0].note = 'reassessed: still checks the source only'; }), copied), 'evidence recorded again');
  assert.ok(!has(errorsFor(t, (d) => { hold(d); d.freshness.obligations[0].class = 'current'; }), copied), 'a current obligation');
  assert.ok(!has(errorsFor(t, (d) => { drop(d); d.freshness.obligations[0].class = 'current'; }), dropped), 'a current obligation stays in the base');
  assert.ok(!has(errorsFor(t, (d) => { drop(d); Object.assign(d.run, { status: 'open', closed: null, incomplete_reason: null }); d.debt.in[0].disposition = null; }), dropped), 'an open run is still working');
  assert.ok(!has(errorsFor(t, (d) => { drop(d); Object.assign(d.run, { status: 'abandoned', incomplete_reason: 'snapshot-changed' }); }), dropped), 'an abandoned run is history');
  // A copy stays a copy in any order, and an accepted one is a conclusion too.
  const reordered = (d, root) => {
    const b = baseRecords();
    b.obligations[0].evidence.push({ anchor: 'api/src/transfer.js:20', note: 'the credit' });
    writeRun(root, b);
    hold(d);
    d.obligations[0].evidence = [...b.obligations[0].evidence].reverse();
  };
  assert.ok(has(errorsFor(t, reordered), copied), 'the base evidence reordered');
  assert.ok(has(errorsFor(t, (d) => { hold(d); d.obligations[0].status = 'accepted'; }), /OB-01 is touched since the base, yet accepted on the base's evidence unchanged/), 'accepted on the base evidence copied');
});

// The effective baseline in check: BASE (task: OB-01, OB-02) <- RUN (incremental,
// records only OB-01; OB-02 stays current in BASE) <- TOP (incremental on RUN).
const TOP = '20261025-150000-incremental-top';
function inheritedChain(t, edit) {
  const root = makeTempDir(t);
  const base = baseRecords();
  Object.assign(base.obligations[1], { status: 'held', open_reason: null });
  writeRun(root, base);
  const mid = validRecords({ status: 'incomplete' });
  mid.obligations.pop();
  mid.debt.out.forEach((d) => { d.refs = ['OB-01']; });
  mid.freshness.obligations = [{ id: 'OB-01', class: 'touched', reason: 'hunk 5-7 intersects 3-12' }, { id: 'OB-02', class: 'current', reason: '1 cited file unchanged' }];
  writeRun(root, mid);
  const top = validRecords({ status: 'incomplete' });
  Object.assign(top.run, { id: TOP, slug: 'top', base: RUN });
  top.scope.intent = [];
  top.census = { recipes: [], items: [] };
  top.obligations = [];
  top.findings = [];
  top.delegations = [];
  top.budget.spent.subagent_calls = 0;
  top.footprint = {};
  top.debt = { in: mid.debt.out.map((d) => ({ id: d.id, from_run: RUN, disposition: 'carried', note: null })), out: mid.debt.out.map((d) => ({ ...d, refs: [] })) };
  top.freshness = {
    base_run: RUN, repos: [], changed_files: [],
    obligations: [{ id: 'OB-01', class: 'current', reason: '1 cited file unchanged' }, { id: 'OB-02', class: 'current', reason: '1 cited file unchanged', origin: BASE }],
  };
  edit?.(top, { base, mid, root });
  return checkRun(root, writeRun(root, top)).errors;
}

test('effective baseline (C11): freshness names every inherited obligation once with its origin; a changed one is reassessed against its origin', (t) => {
  assert.deepEqual(inheritedChain(t), [], 'a valid three-run chain');
  const fails = (label, edit, pattern) => assertError(inheritedChain(t, edit), pattern, label);
  const entries = (top) => top.freshness.obligations;
  fails('an inherited obligation skipped', (top) => { entries(top).pop(); }, new RegExp(`\\$\\.freshness\\.obligations: inherited obligation OB-02 \\(last recorded in ${BASE}\\) has no freshness entry`));
  fails('an obligation outside the baseline', (top) => { entries(top).push({ id: 'OB-99', class: 'current', reason: 'r' }); }, new RegExp(`OB-99 is not an obligation of the effective baseline of ${RUN}`));
  fails('a duplicate entry', (top) => { entries(top).push({ ...entries(top)[0] }); }, /\$\.freshness\.obligations\[2\]\.id: duplicate id OB-01/);
  fails('a redundant origin', (top) => { entries(top)[0].origin = RUN; }, /\$\.freshness\.obligations\[0\]\.origin: is written only when it is not base_run/);
  fails('a wrong origin', (top) => { entries(top)[0].origin = BASE; }, new RegExp(`OB-01 was last recorded in ${RUN}, not ${BASE}`));
  fails('a missing origin', (top) => { delete entries(top)[1].origin; }, new RegExp(`OB-02 was last recorded in ${BASE}, not ${RUN}`));
  fails('a changed inherited obligation dropped', (top) => { entries(top)[1].class = 'touched'; }, new RegExp(`inherited obligation OB-02 \\(last recorded in ${BASE}\\) is touched; re-record it in this run and reassess it`));
  fails('its origin conclusion copied', (top, { base }) => {
    entries(top)[1].class = 'file-changed';
    top.obligations = [structuredClone(base.obligations[1])];
    top.debt.out.forEach((d) => { d.refs = ['OB-02']; });
  }, new RegExp(`OB-02 is file-changed since ${BASE}, yet held on ${BASE}'s evidence unchanged`));
  // An ancestor outside the namespace (or missing) breaks the chain, at $.run.base.
  fails('an ancestor outside the namespace', (top, { mid, root }) => {
    mid.run.base = '20261020-090000-task-elsewhere';
    mid.freshness.base_run = mid.run.base;
    writeRun(root, mid);
  }, /\$\.run\.base: its ancestry cannot be resolved: ancestor 20261020-090000-task-elsewhere of base .*: --base 20261020-090000-task-elsewhere is not a run in experiments\/demo/);
  // A new obligation under an inherited id would silently replace it: a re-record keeps the claim.
  const collide = (cls) => (top, { base }) => {
    entries(top)[1].class = cls;
    top.obligations = [{ ...structuredClone(base.obligations[1]), claim: 'Something else entirely.', evidence: [{ anchor: 'api/src/transfer.js:30', note: 'new' }] }];
    top.debt.out.forEach((d) => { d.refs = ['OB-02']; });
  };
  const collision = new RegExp(`\\$\\.obligations\\[0\\]\\.claim: OB-02 is an inherited obligation \\(last recorded in ${BASE}\\) with another claim`);
  fails('a new obligation reusing a current inherited id', collide('current'), collision);
  fails('a new obligation reusing a changed inherited id', collide('touched'), collision);
  assert.ok(!inheritedChain(t, (top, { base }) => {
    top.obligations = [{ ...structuredClone(base.obligations[1]), evidence: [{ anchor: 'api/src/transfer.js:8', note: 're-read in top' }] }];
    top.debt.out.forEach((d) => { d.refs = ['OB-02']; });
  }).some((e) => /another claim/.test(e)), 'a current obligation re-recorded with its claim (a changed file bears on it) passes');
  // A complete Incremental run with no changed file, whose inherited obligations are all current, is not empty;
  // with a changed file it still needs a recorded obligation.
  const complete = (top) => { Object.assign(top.run, { status: 'complete', incomplete_reason: null }); top.debt = { in: top.debt.in.map((d) => ({ ...d, disposition: 'obsolete', note: 'gone' })), out: [] }; };
  assert.ok(!inheritedChain(t, complete).some((e) => /cannot be empty/.test(e)), 'reviewed through its freshness');
  fails('changed files and no obligation', (top) => {
    complete(top);
    top.freshness.changed_files = [{ path: 'api/src/new.js', change: 'added', from: null }];
    top.census.items = [{ id: 'CI-1', path: 'api/src/new.js', mechanism: 'module', status: 'classified', reason: 'no inherited obligation rests on it', affects: null }];
  }, /\$\.obligations: a complete run cannot be empty/);
});

test('run directory contents (C18): report.md required when closed; packs/*.md only; no links', (t) => {
  const { root, dir } = chain(t);
  const abs = path.join(root, ...dir.split('/'));
  fs.rmSync(path.join(abs, 'report.md'));
  assertError(checkRun(root, dir).errors, /run directory: a closed run has report\.md/, 'report');
  fs.writeFileSync(path.join(abs, 'report.md'), '# r\n');
  fs.mkdirSync(path.join(abs, 'packs'));
  fs.writeFileSync(path.join(abs, 'packs', 'F-01.md'), 'pack\n');
  assert.deepEqual(checkRun(root, dir).errors, []);
  fs.writeFileSync(path.join(abs, 'packs', 'F-01.txt'), 'x');
  fs.writeFileSync(path.join(abs, '.records.json.123.abc.tmp'), 'x'); // a leftover temporary file
  linkDirectory(makeTempDir(t), path.join(abs, 'linked'));
  const errors = checkRun(root, dir).errors;
  assertError(errors, /packs\/F-01\.txt: only packs\/<id>\.md/, 'pack');
  assertError(errors, /run directory: \.records\.json\.123\.abc\.tmp: unexpected/, 'temp');
  assertError(errors, /run directory: linked: symbolic links and junctions are not allowed/, 'link');
});

test('open runs: overspend is a warning; a second open run in the namespace is an error (C5)', (t) => {
  const root = makeTempDir(t);
  writeRun(root, baseRecords());
  const doc = validRecords({ status: 'open' });
  doc.budget.spent.lead_tool_calls = 41;
  const dir = writeRun(root, doc);
  const result = checkRun(root, dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, ['$.budget.spent.lead_tool_calls: 41 exceeds the budget of 40; the run must close as incomplete with reason budget']);
  const other = validRecords({ status: 'open' });
  Object.assign(other.run, { id: '20261025-140000-incremental-demo' });
  writeRun(root, other);
  assertError(checkRun(root, dir).errors, /\$\.run\.status: 20261025-140000-incremental-demo is also open/, 'two open');
});

test('structure errors are reported as they are; a missing records.json is an error', (t) => {
  const { root, dir } = chain(t, (d) => { d.obligations[0].status = 'bogus'; });
  const cli = nthr(['check', '--run', dir], { cwd: root });
  assert.equal(cli.code, EXIT.INVALID);
  assert.equal(cli.json.errors.length, 1);
  assert.match(cli.json.errors[0], /^\$\.obligations\[0\]\.status: must be one of/);
  fs.rmSync(path.join(root, ...dir.split('/'), 'records.json'));
  assertError(checkRun(root, dir).errors, /records\.json is missing/, 'missing');
});

test('--run forms: with or without .nth-review/, backslashes; anything else is a refusal', (t) => {
  const { root, dir } = chain(t);
  for (const form of [dir, dir.slice('.nth-review/'.length), dir.replaceAll('/', '\\'), `./${dir}/`]) {
    assert.equal(nthr(['check', '--run', form], { cwd: root }).code, EXIT.OK, form);
  }
  for (const bad of ['', '/abs/experiments/demo/runs/x', '.nth-review/experiments/demo', '../.nth-review/experiments/demo/runs/' + RUN, 'experiments/demo/runs/not-a-run-id', 'audits/CON/runs/' + RUN]) {
    assert.throws(() => parseRunArg(bad), (error) => error.refusal === true, JSON.stringify(bad));
  }
  assert.equal(nthr(['check', '--run', 'experiments/demo/runs/20261026-090000-task-missing'], { cwd: root }).code, EXIT.USAGE);
  assert.equal(nthr(['check'], { cwd: root }).code, EXIT.USAGE);
  // A junction as the run directory is refused, never followed.
  const elsewhere = makeTempDir(t);
  fs.cpSync(path.join(root, ...dir.split('/')), elsewhere, { recursive: true });
  const linked = path.join(root, '.nth-review', 'experiments', 'demo', 'runs', '20261026-100000-incremental-demo');
  linkDirectory(elsewhere, linked);
  assert.equal(nthr(['check', '--run', 'experiments/demo/runs/20261026-100000-incremental-demo'], { cwd: root }).code, EXIT.USAGE);
});

test('check is read-only: no file is written, renamed, created or removed', (t) => {
  const { root, dir } = chain(t, (d) => { d.debt.in = []; }); // a failing run exercises every rule
  const tree = () => fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      const stats = fs.statSync(file);
      return `${path.relative(root, file)} ${stats.mtimeMs} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    })
    .sort();
  const before = tree();
  const writers = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'copyFileSync', 'writeSync']
    .map((name) => t.mock.method(fs, name));
  checkRun(root, dir);
  nthr(['check', '--run', dir], { cwd: root });
  for (const spy of writers) assert.equal(spy.mock.callCount(), 0);
  for (const spy of writers) spy.mock.restore();
  assert.deepEqual(tree(), before);
});

test('review fixes: any matching census item may account for a change; hostile globs stay fast; unreadable siblings are errors', (t) => {
  // A broad item without affects listed first no longer hides the exact one.
  const { root, dir } = chain(t, (d) => {
    d.census.items.unshift({ id: 'CI-0', path: 'api/src/*', mechanism: 'all sources', status: 'classified', reason: null, affects: null });
  });
  assert.deepEqual(checkRun(root, dir).errors, []);

  // `*` stays within a segment; matching is linear, even for hostile patterns.
  assert.equal(globMatches('api/src/*.js', 'api/src/a.js'), true);
  assert.equal(globMatches('api/src/*', 'api/src/x/y.js'), false);
  assert.equal(globMatches('api/?rc/a*b*c.js', 'api/src/aXbYc.js'), true);
  const started = Date.now();
  assert.equal(globMatches(`${'*a'.repeat(100)}b`, 'a'.repeat(250)), false);
  assert.ok(Date.now() - started < 1000, 'no catastrophic backtracking');

  // A sibling whose records.json is not a regular file (the guard refuses it,
  // as it refuses a link) is reported instead of aborting the check.
  const open = validRecords({ status: 'open' });
  const openDir = writeRun(root, { ...open, run: { ...open.run, id: '20261026-110000-incremental-demo' } });
  fs.mkdirSync(path.join(root, '.nth-review', 'experiments', 'demo', 'runs', '20261026-100000-task-odd', 'records.json'), { recursive: true });
  const errors = checkRun(root, openDir).errors;
  assertError(errors, /\$\.run\.status: 20261026-100000-task-odd in experiments\/demo cannot be read \(not a regular file/, 'sibling');
});
