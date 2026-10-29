// Full Audit (M3-T6; protocol §10, decisions C19, C20): the plan -> unit ->
// close workflow, the units ledger, unit dependencies, the linear chain, R4,
// resumed units, the drift check at the audit close, the report's scope, and
// the official-audit gate. Every test runs on a disposable synthetic project
// with the test-only in-process gate (`official: true`); the switch in
// nthr.mjs stays false, and nothing here can reach a real project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { COMMANDS, EXIT } from '../scripts/lib/cli.mjs';
import { renderReport } from '../scripts/lib/render.mjs';
import { commitAll, makeRepo } from './helpers/repo.mjs';
import { at, nthr, readRecords, recordsFile, writeRecords } from './helpers/runs.mjs';
import { NTHR, REVIEW_DIR, makeTempDir, runNthr } from './helpers/tmp.mjs';
import { replaceLine } from './helpers/history.mjs';

const NS = 'audits/core';
const numbered = (n, p) => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n') + '\n';

// A synthetic project with an owner charter, created by the real (gated) command.
function project(t) {
  const root = fs.realpathSync.native(makeRepo(path.join(makeTempDir(t), 'p'), { 'src/a.js': numbered(30, 'a'), 'src/b.js': numbered(30, 'b') }));
  const chartered = nthr(['charter', '--ns', NS, '--owner', 'Owner Name', '--scope', 'the synthetic project', '--exclusions', 'none', '--official'], { cwd: root, now: at(0), official: true });
  assert.equal(chartered.code, EXIT.OK, JSON.stringify(chartered.json));
  return root;
}
const cmd = (root, args, seconds, official = true) => nthr(args, { cwd: root, now: at(seconds), official });
function open(root, seconds, { mode = 'audit-unit', slug, base = null, unit = null }) {
  const args = ['new-run', '--ns', NS, '--mode', mode, '--slug', slug, ...(base ? ['--base', base] : []), ...(unit ? ['--unit', unit] : [])];
  const r = cmd(root, args, seconds);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  return { dir: r.json.result.run_dir, id: r.json.result.run_id };
}
const refusedOpen = (root, seconds, options, pattern) => {
  const args = ['new-run', '--ns', NS, '--mode', options.mode ?? 'audit-unit', '--slug', options.slug ?? 'x', ...(options.base ? ['--base', options.base] : []), ...(options.unit ? ['--unit', options.unit] : [])];
  const r = cmd(root, args, seconds);
  assert.equal(r.code, EXIT.USAGE, JSON.stringify(r.json));
  assert.match(r.json.errors[0], pattern);
};
function edit(root, dir, fn) {
  const doc = readRecords(root, dir);
  doc.run.runtime.lead_model = 'claude-opus-5-5';
  doc.run.runtime.lead_effort = 'high';
  if (!doc.scope.summary) doc.scope.summary = 'synthetic audit';
  fn(doc);
  writeRecords(root, dir, doc);
  return doc;
}
const close = (root, dir, seconds, status = 'complete', reason = null) => cmd(root, ['close', '--run', dir, '--status', status, ...(reason ? ['--reason', reason] : [])], seconds);
const check = (root, dir, official = true) => nthr(['check', '--run', dir], { cwd: root, official });
const ledger = (root, dir) => Object.fromEntries(readRecords(root, dir).scope.units.map((u) => [u.id, { status: u.status, runs: u.runs, reason: u.reason }]));
const report = (root, dir) => fs.readFileSync(path.join(root, ...dir.split('/'), 'report.md'), 'utf8');
const unit = (id, fields = {}) => ({
  id, title: `${id} title`, tier: 2, status: 'planned', depends_on: [], runs: [], reason: null, scope: `${id} scope`,
  basis: [{ anchor: `docs/units.md#${id}`, note: 'synthetic basis: the owning section' }], ...fields,
});
const held = (id, anchor) => ({
  id, checks: ['LOGIC.1'], claim: `${id} claim`, scope: 's', acceptance: 'a', coverage: 'named-subset', coverage_method: 'read',
  status: 'held', open_reason: null, source_trace: 'consistent', evidence: [{ anchor, note: 'read' }], intent: [], assumptions: [], links: [],
});
const R4 = { role: 'R4', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: 4, tokens: 12000, completed: true, recovery_messages: 0 };
// A unit run reviewed with one held obligation (and R4 when `critic`).
function reviewUnit(root, dir, { anchor = 'src/a.js:3', critic = false } = {}) {
  edit(root, dir, (d) => {
    d.obligations = [held('OB-1', anchor)];
    if (critic) { d.delegations = [R4]; d.budget.spent.subagent_calls = 1; d.budget.spent.subagent_tokens = R4.tokens; }
  });
}
function plan(root, seconds, units, base = null) {
  const p = open(root, seconds, { mode: 'audit-plan', slug: 'plan', base });
  edit(root, p.dir, (d) => { d.scope.units = units; });
  return p;
}
function closeOk(root, dir, seconds, status = 'complete', reason = null) {
  const r = close(root, dir, seconds, status, reason);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
}
function closeInvalid(root, dir, seconds, pattern, status = 'complete', reason = null) {
  const before = fs.readFileSync(recordsFile(root, dir));
  const r = close(root, dir, seconds, status, reason);
  assert.equal(r.code, EXIT.INVALID, JSON.stringify(r.json));
  assert.ok(r.json.errors.some((e) => pattern.test(e)), JSON.stringify(r.json.errors));
  assert.ok(fs.readFileSync(recordsFile(root, dir)).equals(before), 'a refused close writes nothing');
}

test('lifecycle: plan -> units -> audit close; close records each unit; R4 gates a Tier-1 unit; reports never claim more than they reviewed', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01', { tier: 1 }), unit('U-02', { depends_on: ['U-01'] })]);
  closeOk(root, p.dir, 2);
  assert.match(report(root, p.dir), /This plan defines the audit's units and reviews none of them\. The ledger comes from the plan's census; discovery alone never shows that nothing else exists\./);
  assert.match(report(root, p.dir), /^- Not reviewed: U-01, U-02$/m);

  // U-01 (Tier 1): the ledger stays the base's while open; close needs a completed R4.
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  assert.deepEqual(readRecords(root, u1.dir).scope.units, readRecords(root, p.dir).scope.units);
  reviewUnit(root, u1.dir);
  closeInvalid(root, u1.dir, 4, /unit U-01 is Tier 1: it closes complete only after a completed R4 judgment critique/);
  // R4 routing: reviewer, opus, effort high; anything else is refused.
  for (const [bad, pattern] of [[{ model: 'sonnet' }, /\$\.delegations\[0\]\.model: R4 uses opus/], [{ effort: null }, /\$\.delegations\[0\]\.effort: an opus delegation must set effort high/], [{ agent: 'Explore' }, /\$\.delegations\[0\]\.agent: R4 is run by reviewer/]]) {
    edit(root, u1.dir, (d) => { d.delegations = [{ ...R4, ...bad }]; d.budget.spent.subagent_calls = 1; });
    assert.ok(check(root, u1.dir).json.errors.some((e) => pattern.test(e)), JSON.stringify(bad));
  }
  reviewUnit(root, u1.dir, { critic: true });
  closeOk(root, u1.dir, 5);
  assert.deepEqual(ledger(root, u1.dir)['U-01'], { status: 'complete', runs: [u1.id], reason: null });
  assert.deepEqual(ledger(root, u1.dir)['U-02'], { status: 'planned', runs: [], reason: null });
  const unitReport = report(root, u1.dir);
  assert.match(unitReport, /^This report concludes unit U-01 only\. It is no conclusion about the project or the whole audit\.$/m);
  assert.match(unitReport, /^- Reviewed \(complete\): U-01$/m);
  assert.match(unitReport, /^- Not reviewed: U-02$/m);
  assert.ok(!/Whole audit: complete/.test(unitReport));
  assert.equal(check(root, u1.dir).code, EXIT.OK);

  // U-02 (Tier 2) on the chain head: no R4 needed.
  const u2 = open(root, 6, { slug: 'u2', base: u1.id, unit: 'U-02' });
  reviewUnit(root, u2.dir, { anchor: 'src/b.js:3' });
  closeOk(root, u2.dir, 7);

  // The audit close: every unit complete and unchanged -> the whole audit is complete at this snapshot.
  const fin = open(root, 8, { slug: 'close', base: u2.id, unit: 'close' });
  edit(root, fin.dir, () => {});
  closeOk(root, fin.dir, 9);
  assert.deepEqual(ledger(root, fin.dir), ledger(root, u2.dir), 'nothing drifted');
  const closeReport = report(root, fin.dir);
  assert.match(closeReport, /^Whole audit: complete at this snapshot\. Every unit is complete or out of scope; each unit's conclusions are in the report of its last run, and out-of-scope units were not reviewed\.$/m);
  assert.match(closeReport, new RegExp(`^\\| U-01 \\| U-01 title \\| 1 \\| docs/units\\.md#U-01 — synthetic basis: the owning section \\| complete \\| none \\| U-01 scope \\| ${u1.id} \\| – \\|$`, 'm'), 'provenance and tier basis of each unit');
  assert.ok(!/Verified/.test(closeReport), 'the audit close never says Verified');
  assert.equal(check(root, fin.dir).code, EXIT.OK);
  assert.equal(close(root, fin.dir, 10).code, EXIT.USAGE, 'a closed run never changes (C1)');
});

test('gating: a unit runs only when planned or incomplete with its dependencies complete; the ledger has no cycle, no reserved id and a scope for every unit', (t) => {
  const root = project(t);
  const p = plan(root, 1, [
    unit('U-01'), unit('U-02', { depends_on: ['U-01'] }),
    unit('U-03', { status: 'deferred', reason: 'after the release' }), unit('U-04', { status: 'out_of_scope', reason: 'owner exclusion' }),
  ]);
  // The open plan: cycles, the reserved id and a missing scope fail check.
  const failsCheck = (units, pattern) => {
    const saved = readRecords(root, p.dir);
    edit(root, p.dir, (d) => { d.scope.units = units; });
    const r = check(root, p.dir);
    assert.equal(r.code, EXIT.INVALID);
    assert.ok(r.json.errors.some((e) => pattern.test(e)), JSON.stringify(r.json.errors));
    writeRecords(root, p.dir, saved);
  };
  failsCheck([unit('U-01', { depends_on: ['U-01'] })], /U-01 depends on itself, directly or through other units/);
  failsCheck([unit('U-01', { depends_on: ['U-02'] }), unit('U-02', { depends_on: ['U-01'] })], /depends on itself, directly or through other units/);
  failsCheck([unit('close')], /close is reserved for the audit close; a unit cannot use it/);
  const { scope, ...noScope } = unit('U-01');
  failsCheck([noScope], /a plan run gives unit U-01 its scope/);
  closeOk(root, p.dir, 2);

  refusedOpen(root, 3, { base: p.id, unit: 'U-02' }, /unit U-02 depends on U-01, not complete yet; run it first/);
  refusedOpen(root, 3, { base: p.id, unit: 'U-03' }, /unit U-03 is deferred; only a planned or incomplete unit runs/);
  refusedOpen(root, 3, { base: p.id, unit: 'U-04' }, /unit U-04 is out_of_scope; only a planned or incomplete unit runs/);
  refusedOpen(root, 3, { base: p.id, unit: 'U-99' }, /--unit U-99 is not in the units ledger/);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  reviewUnit(root, u1.dir);
  closeOk(root, u1.dir, 4);
  refusedOpen(root, 5, { base: u1.id, unit: 'U-01' }, /unit U-01 is complete; only a planned or incomplete unit runs \(a plan run may reopen it\)/);
  assert.equal(open(root, 5, { slug: 'u2', base: u1.id, unit: 'U-02' }).id.endsWith('audit-unit-u2'), true, 'U-02 runs once U-01 is complete');
});

test('the chain is linear, and the ledger changes only as the plan, the unit run and close may change it', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01'), unit('U-02'), unit('U-03')]);
  closeOk(root, p.dir, 2);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  reviewUnit(root, u1.dir);
  closeOk(root, u1.dir, 4);
  // A fork, or a second root plan, is refused at Open, naming the head.
  refusedOpen(root, 5, { base: p.id, unit: 'U-02', slug: 'fork' }, new RegExp(`${u1.id} already builds on ${p.id}; the audit chain is linear: build on its head ${u1.id} \\(C20\\)`));
  refusedOpen(root, 5, { mode: 'audit-plan', slug: 'again' }, new RegExp(`the audit chain already has its root plan; every later audit run builds on its head ${u1.id}`));

  // An open unit run keeps the base ledger; a hand-made fork fails check.
  const u2 = open(root, 5, { slug: 'u2', base: u1.id, unit: 'U-02' });
  const errorsAfter = (fn) => {
    const saved = readRecords(root, u2.dir);
    edit(root, u2.dir, fn);
    const errors = check(root, u2.dir).json.errors ?? [];
    writeRecords(root, u2.dir, saved);
    return errors;
  };
  assert.ok(errorsAfter((d) => { d.scope.units[0].title = 'renamed'; }).some((e) => /an open unit run keeps the ledger of .* unchanged/.test(e)));
  assert.ok(errorsAfter((d) => { d.run.base = p.id; d.scope.units = readRecords(root, p.dir).scope.units; }).some((e) => /already builds on .*; the audit chain is linear/.test(e)));
  // Close records only this run's unit: editing another unit is refused.
  reviewUnit(root, u2.dir, { anchor: 'src/b.js:3' });
  edit(root, u2.dir, (d) => { d.scope.units[2].title = 'changed by a unit run'; });
  closeInvalid(root, u2.dir, 6, /unit U-03 is not this run's unit; it stays as in/);
  edit(root, u2.dir, (d) => { d.scope.units[2].title = 'U-03 title'; });
  closeOk(root, u2.dir, 6);

  // A re-plan on the head: it may defer or reopen units, never drop one, rewrite runs, or conclude one.
  const re = open(root, 7, { mode: 'audit-plan', slug: 'replan', base: u2.id });
  const planErrors = (fn) => {
    const saved = readRecords(root, re.dir);
    edit(root, re.dir, fn);
    const errors = check(root, re.dir).json.errors ?? [];
    writeRecords(root, re.dir, saved);
    return errors;
  };
  assert.ok(planErrors((d) => { d.scope.units.pop(); }).some((e) => /unit U-03 of .* is dropped; a plan run keeps every unit/.test(e)));
  assert.ok(planErrors((d) => { d.scope.units[0].runs = []; }).some((e) => /\$\.scope\.units\[0\]\.runs: must stay as in/.test(e)));
  assert.ok(planErrors((d) => { d.scope.units[2].status = 'complete'; }).some((e) => /only a unit run concludes a unit complete/.test(e)));
  assert.deepEqual(planErrors((d) => { Object.assign(d.scope.units[0], { status: 'planned' }); Object.assign(d.scope.units[2], { status: 'deferred', reason: 'later' }); d.scope.units.push(unit('U-04')); }), [], 'reopen, defer and add are a plan run\'s');
});

test('incomplete units stay open with their reason; debt from another unit does not block a unit, debt from its own earlier run does; the audit close is strict', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01'), unit('U-02')]);
  closeOk(root, p.dir, 2);
  // U-01 ends incomplete, handing on debt.
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  edit(root, u1.dir, (d) => {
    d.obligations = [{ ...held('OB-1', 'src/a.js:3'), status: 'open', open_reason: 'needs-runtime' }];
    d.debt.out = [{ id: `${u1.id}/D1`, kind: 'runtime', refs: ['OB-1'], requires: 'a runtime test', priority: 'medium' }];
  });
  closeOk(root, u1.dir, 4, 'incomplete', 'open-obligations');
  assert.deepEqual(ledger(root, u1.dir)['U-01'], { status: 'incomplete', runs: [u1.id], reason: `run ${u1.id} closed incomplete (open-obligations)` });

  // U-02 carries U-01's debt and still completes.
  const u2 = open(root, 5, { slug: 'u2', base: u1.id, unit: 'U-02' });
  reviewUnit(root, u2.dir, { anchor: 'src/b.js:3' });
  edit(root, u2.dir, (d) => {
    d.debt.in.forEach((x) => { x.disposition = 'carried'; });
    d.debt.out = [{ id: `${u1.id}/D1`, kind: 'runtime', refs: [], requires: 'a runtime test', priority: 'medium' }];
  });
  closeOk(root, u2.dir, 6);

  // The audit close cannot be complete while U-01 is incomplete, or while debt is carried.
  const fin = open(root, 7, { slug: 'close', base: u2.id, unit: 'close' });
  edit(root, fin.dir, (d) => {
    d.debt.in.forEach((x) => { x.disposition = 'carried'; });
    d.debt.out = [{ id: `${u1.id}/D1`, kind: 'runtime', refs: [], requires: 'a runtime test', priority: 'medium' }];
  });
  closeInvalid(root, fin.dir, 8, /the audit closes complete only when every unit is complete or out of scope; U-01 is incomplete/);
  closeInvalid(root, fin.dir, 8, /\$\.debt\.in\[0\]\.disposition: a complete run carries no open debt/);
  closeOk(root, fin.dir, 8, 'incomplete', 'open-obligations');
  assert.match(report(root, fin.dir), /^Whole audit: not complete: units not complete: U-01; the audit close is incomplete \((open-obligations|owner-stopped)\)\.$/m);

  // U-01 again: its own earlier debt blocks completion until it is discharged.
  const again = open(root, 9, { slug: 'u1b', base: fin.id, unit: 'U-01' });
  reviewUnit(root, again.dir);
  edit(root, again.dir, (d) => {
    d.debt.in.forEach((x) => { x.disposition = 'carried'; });
    d.debt.out = [{ id: `${u1.id}/D1`, kind: 'runtime', refs: [], requires: 'a runtime test', priority: 'medium' }];
  });
  closeInvalid(root, again.dir, 10, /\$\.debt\.in\[0\]\.disposition: a complete run carries no open debt/);
  edit(root, again.dir, (d) => {
    d.debt.in.forEach((x) => { Object.assign(x, { disposition: 'discharged', note: 'covered by a test now' }); });
    d.debt.out = [];
  });
  closeOk(root, again.dir, 10);
  assert.deepEqual(ledger(root, again.dir)['U-01'], { status: 'complete', runs: [u1.id, again.id], reason: null });
});

test('an interrupted unit run resumes: the continuation keeps unit and base, and its close records the continuation', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01')]);
  closeOk(root, p.dir, 2);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  reviewUnit(root, u1.dir);
  replaceLine(root, 'src/b.js', 5, 'b 5 changed');
  commitAll(root, 'moved on');
  const plan2 = cmd(root, ['resume', '--ns', NS], 4);
  assert.deepEqual([plan2.json.result.action, plan2.json.result.cause], ['abandon', 'tracked-changed']);
  const applied = cmd(root, ['resume', '--ns', NS, '--apply'], 5);
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  const cont = { dir: applied.json.result.run_dir, id: applied.json.result.run };
  const contDoc = readRecords(root, cont.dir);
  assert.deepEqual([contDoc.run.mode, contDoc.run.unit, contDoc.run.base, contDoc.run.continues], ['audit-unit', 'U-01', p.id, u1.id]);
  assert.deepEqual(contDoc.scope.units, readRecords(root, p.dir).scope.units, 'the continuation starts from the base ledger');
  assert.deepEqual(readRecords(root, u1.dir).scope.units, readRecords(root, p.dir).scope.units, 'the abandoned run never concluded its unit');
  assert.equal(check(root, u1.dir).code, EXIT.OK);
  reviewUnit(root, cont.dir);
  closeOk(root, cont.dir, 6);
  assert.deepEqual(ledger(root, cont.dir)['U-01'], { status: 'complete', runs: [cont.id], reason: null });
});

test('the audit close downgrades a complete unit whose cited files changed since its run', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01'), unit('U-02')]);
  closeOk(root, p.dir, 2);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  reviewUnit(root, u1.dir, { anchor: 'src/a.js:3' });
  closeOk(root, u1.dir, 4);
  replaceLine(root, 'src/a.js', 3, 'a 3 changed after U-01');
  commitAll(root, 'change');
  const u2 = open(root, 5, { slug: 'u2', base: u1.id, unit: 'U-02' });
  reviewUnit(root, u2.dir, { anchor: 'src/b.js:3' });
  closeOk(root, u2.dir, 6);
  const fin = open(root, 7, { slug: 'close', base: u2.id, unit: 'close' });
  edit(root, fin.dir, () => {});
  closeInvalid(root, fin.dir, 8, /the audit closes complete only when every unit is complete or out of scope; U-01 is incomplete/);
  closeOk(root, fin.dir, 8, 'incomplete', 'owner-stopped');
  const after = ledger(root, fin.dir);
  assert.equal(after['U-01'].status, 'incomplete');
  assert.match(after['U-01'].reason, new RegExp(`^audit close: files cited by ${u1.id} changed or cannot be verified since: src/a\\.js$`));
  assert.deepEqual(after['U-02'], { status: 'complete', runs: [u2.id], reason: null }, 'an unchanged unit stays complete');
  assert.match(report(root, fin.dir), /^Whole audit: not complete: units not complete: U-01; the audit close is incomplete \((open-obligations|owner-stopped)\)\.$/m);
  assert.equal(check(root, fin.dir).code, EXIT.OK);
});

test('the gate: refused without the test-only switch, without a complete charter, and never from the command line', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01')]);
  // Without the switch: new-run, check and close refuse; nothing is written.
  const before = fs.readFileSync(recordsFile(root, p.dir));
  const off = nthr(['new-run', '--ns', NS, '--mode', 'audit-plan', '--slug', 'x'], { cwd: root, now: at(2) });
  assert.equal(off.code, EXIT.USAGE);
  assert.match(off.json.errors[0], /official audits are disabled: OFFICIAL_AUDITS_ENABLED is false/);
  assert.ok(check(root, p.dir, false).json.errors.some((e) => /\$\.run\.namespace: official audits are disabled/.test(e)));
  const closedOff = nthr(['close', '--run', p.dir, '--status', 'complete'], { cwd: root, now: at(2) });
  assert.equal(closedOff.code, EXIT.INVALID, JSON.stringify(closedOff.json));
  assert.ok(closedOff.json.errors.some((e) => /\$\.run\.namespace: official audits are disabled/.test(e)));
  for (const args of [['resume', '--ns', NS], ['decide', '--ns', NS, '--fingerprint', 'audit/x', '--decision', 'fix', '--by', 'Owner Name', '--note', 'n']]) {
    const r = nthr(args, { cwd: root, now: at(2) });
    assert.equal(r.code, EXIT.USAGE, `${args[0]}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.errors[0], /official audits are disabled/, args[0]);
  }
  assert.ok(fs.readFileSync(recordsFile(root, p.dir)).equals(before));
  // The real entry point refuses too.
  const spawned = runNthr(['check', '--run', p.dir], { cwd: root });
  assert.equal(spawned.code, EXIT.INVALID, spawned.stdout + spawned.stderr);
  assert.ok(spawned.json.errors.some((e) => /official audits are disabled/.test(e)));
  // A partial charter is not authorization.
  const charter = path.join(root, '.nth-review', 'audits', 'core', 'charter.json');
  const good = fs.readFileSync(charter);
  fs.writeFileSync(charter, JSON.stringify({ official: true }));
  assert.ok(check(root, p.dir).json.errors.some((e) => /charter\.json is not a complete owner charter/.test(e)));
  fs.writeFileSync(charter, good);
  // The switch is a constant, passed in process only: no option or environment reaches it.
  assert.match(fs.readFileSync(NTHR, 'utf8'), /^export const OFFICIAL_AUDITS_ENABLED = false;$/m);
  const cli = fs.readFileSync(path.join(REVIEW_DIR, 'scripts', 'lib', 'cli.mjs'), 'utf8');
  assert.ok(!/process\.env/.test(cli), 'no environment variable');
  assert.match(cli, /officialAuditsEnabled: io\.officialAuditsEnabled === true,/);
  for (const [name, command] of Object.entries(COMMANDS)) {
    for (const option of Object.keys(command.options)) assert.ok(!/enable|gate|official-audit/i.test(option), `${name} --${option}`);
  }
});

test('the chain keeps its debt: --continues names only the abandoned run this run carries on', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01'), unit('U-02')]);
  closeOk(root, p.dir, 2);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  edit(root, u1.dir, (d) => {
    d.obligations = [{ ...held('OB-1', 'src/a.js:3'), status: 'open', open_reason: 'needs-runtime' }];
    d.debt.out = [{ id: `${u1.id}/D1`, kind: 'runtime', refs: ['OB-1'], requires: 'a runtime test', priority: 'medium' }];
  });
  closeOk(root, u1.dir, 4, 'incomplete', 'open-obligations');
  // Continuing the plan instead of the head would take debt-in from the plan, and drop D1.
  const forked = cmd(root, ['new-run', '--ns', NS, '--mode', 'audit-unit', '--slug', 'u2', '--base', u1.id, '--unit', 'U-02', '--continues', p.id], 5);
  assert.equal(forked.code, EXIT.USAGE, JSON.stringify(forked.json));
  assert.match(forked.json.errors[0], new RegExp(`in an audit chain, --continues names only the abandoned run this run carries on \\(same mode, base and unit; resume opens it\\), not ${p.id}`));
  const u2 = open(root, 5, { slug: 'u2', base: u1.id, unit: 'U-02' });
  assert.deepEqual(readRecords(root, u2.dir).debt.in.map((d) => d.id), [`${u1.id}/D1`], 'debt-in comes from the head');
  edit(root, u2.dir, (d) => { d.run.continues = p.id; });
  assert.ok(check(root, u2.dir).json.errors.some((e) => /^\$\.run\.continues: in an audit chain, --continues names only the abandoned run/.test(e)));
});

test('a re-plan never takes an existing unit out of scope or lowers its priority; it may defer, raise and add', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01', { tier: 1 }), unit('U-02')]);
  closeOk(root, p.dir, 2);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  reviewUnit(root, u1.dir);
  closeOk(root, u1.dir, 4, 'incomplete', 'owner-stopped');
  const re = open(root, 5, { mode: 'audit-plan', slug: 'replan', base: u1.id });
  const planErrors = (fn) => {
    const saved = readRecords(root, re.dir);
    edit(root, re.dir, fn);
    const errors = check(root, re.dir).json.errors ?? [];
    writeRecords(root, re.dir, saved);
    return errors;
  };
  assert.ok(planErrors((d) => { Object.assign(d.scope.units[0], { status: 'out_of_scope', reason: 'not worth it' }); })
    .some((e) => new RegExp(`a re-plan never puts an existing unit out of scope \\(U-01 is incomplete in ${u1.id}\\); defer it instead`).test(e)));
  assert.ok(planErrors((d) => { Object.assign(d.scope.units[1], { status: 'out_of_scope', reason: 'not worth it' }); })
    .some((e) => /a re-plan never puts an existing unit out of scope \(U-02 is planned in/.test(e)));
  assert.ok(planErrors((d) => { d.scope.units[0].tier = 3; })
    .some((e) => /a re-plan never lowers a unit's priority \(U-01 is tier 1 in .*\); Tier 1 needs R4/.test(e)));
  assert.ok(planErrors((d) => { d.scope.units[0].tier = null; }).some((e) => /never lowers a unit's priority/.test(e)));
  assert.deepEqual(planErrors((d) => {
    d.scope.units[1].tier = 1;
    Object.assign(d.scope.units[0], { status: 'deferred', reason: 'after the release' });
    d.scope.units.push(unit('U-03', { status: 'out_of_scope', reason: 'owner exclusion: vendored code' }));
  }), [], 'raise a priority, defer an unfinished unit, add an excluded one');
});

test('the audit close: never complete with no unit reviewed; it records no obligation; plan and close reports never say Verified', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01', { status: 'out_of_scope', reason: 'owner exclusion' })]);
  closeOk(root, p.dir, 2);
  const fin = open(root, 3, { slug: 'close', base: p.id, unit: 'close' });
  edit(root, fin.dir, (d) => { d.obligations = [{ ...held('OB-1', 'src/a.js:3'), claim: 'The whole project has no defects.', coverage: 'all-enumerated' }]; });
  closeInvalid(root, fin.dir, 4, /\$\.obligations: the audit close records no obligation; a surface found now becomes a unit through a re-plan/);
  closeInvalid(root, fin.dir, 4, /the audit closes complete only when at least one unit was reviewed \(complete\)/);
  edit(root, fin.dir, (d) => { d.obligations = []; });
  closeOk(root, fin.dir, 4, 'incomplete', 'owner-stopped');
  assert.match(report(root, fin.dir), /^Whole audit: not complete: no unit was reviewed; the audit close is incomplete \(owner-stopped\)\.$/m);
  // Not even inconsistent records make a plan or the audit close Verified.
  for (const dir of [p.dir, fin.dir]) {
    const doc = readRecords(root, dir);
    doc.run.status = 'complete';
    doc.obligations = [{ ...held('OB-9', 'src/a.js:3'), coverage: 'all-enumerated' }];
    assert.ok(!/^\| OB-9 .*\| Verified \|$/m.test(renderReport(doc)), dir);
    assert.match(renderReport(doc), /^\| OB-9 \| OB-9 claim \| read \| not verified \|$/m);
  }
});

test('the audit close lists what each unit left unresolved, and downgrades a unit whose cited file was deleted; an experiments/ audit is labelled unofficial', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01'), unit('U-02')]);
  closeOk(root, p.dir, 2);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  edit(root, u1.dir, (d) => {
    d.obligations = [{ ...held('OB-1', 'src/a.js:3'), status: 'violated', links: ['F-1'] }];
    d.findings = [{
      id: 'F-1', fingerprint: 'audit/f1', kind: 'defect', verdict: 'confirmed', severity: 'medium', impact_dimension: 'correctness',
      obligation: 'OB-1', summary: 'Line 3 is wrong.', trace: [{ role: 'sink', anchor: 'src/a.js:3', note: 'the write' }],
      counterevidence: [], validation_plan: null,
      verification: { role: 'R6', model: 'sonnet', outcome: 'confirmed', corrections: null, incomplete: false }, decision: 'pending',
    }];
    d.delegations = [{ role: 'R6', agent: 'reviewer', model: 'sonnet', effort: null, budget_calls: 10, tool_uses: 3, tokens: 9000, completed: true, recovery_messages: 0 }];
    d.budget.spent.subagent_calls = 1;
    d.budget.spent.subagent_tokens = 9000;
  });
  closeOk(root, u1.dir, 4);
  const u2 = open(root, 5, { slug: 'u2', base: u1.id, unit: 'U-02' });
  reviewUnit(root, u2.dir, { anchor: 'src/b.js:3' });
  closeOk(root, u2.dir, 6);
  fs.rmSync(path.join(root, 'src', 'b.js'));
  commitAll(root, 'delete b');
  const fin = open(root, 7, { slug: 'close', base: u2.id, unit: 'close' });
  edit(root, fin.dir, () => {});
  closeInvalid(root, fin.dir, 8, /U-02 is incomplete/);
  closeOk(root, fin.dir, 8, 'incomplete', 'owner-stopped');
  const after = ledger(root, fin.dir);
  assert.deepEqual(after['U-01'], { status: 'complete', runs: [u1.id], reason: null }, 'its cited file is unchanged');
  assert.match(after['U-02'].reason, new RegExp(`^audit close: files cited by ${u2.id} changed or cannot be verified since: src/b\\.js$`));
  const r = report(root, fin.dir);
  assert.match(r, /^Left unresolved by each unit's last run \(from its records; its report has the details\):$/m);
  assert.match(r, new RegExp(`^- U-01 \\(${u1.id}\\); open obligations 0; violated 1; confirmed defects 1 \\(1 medium\\); needs_validation 0; unverified findings 0; risks 0; debt handed on 0$`, 'm'));
  assert.match(r, new RegExp(`^- U-02 \\(${u2.id}\\); open obligations 0; violated 0; confirmed defects 0; needs_validation 0; unverified findings 0; risks 0; debt handed on 0$`, 'm'));
  assert.ok(!/Not an official audit/.test(r), 'audits/ is official');
  assert.equal(check(root, fin.dir).code, EXIT.OK);

  // An experiments/ namespace runs the audit modes without the gate or a charter; its reports say it is not official.
  const exp = nthr(['new-run', '--ns', 'experiments/audit', '--mode', 'audit-plan', '--slug', 'plan'], { cwd: root, now: at(9) });
  assert.equal(exp.code, EXIT.OK, JSON.stringify(exp.json));
  edit(root, exp.json.result.run_dir, (d) => { d.scope.units = [unit('U-01')]; });
  const closedExp = nthr(['close', '--run', exp.json.result.run_dir, '--status', 'complete'], { cwd: root, now: at(10) });
  assert.equal(closedExp.code, EXIT.OK, JSON.stringify(closedExp.json));
  assert.match(report(root, exp.json.result.run_dir), /^\*\*Not an official audit:\*\* this namespace has no owner charter and no release gate\.$/m);
});

test('plan tiers: a plan closes complete only when every active unit has a tier and a reviewable basis; presence and form only, never the tier itself', (t) => {
  const root = project(t);
  const p = open(root, 1, { mode: 'audit-plan', slug: 'plan' });
  // Refused at a complete close; nothing written.
  const closeErrors = (units) => {
    edit(root, p.dir, (d) => { d.scope.units = units; });
    const before = fs.readFileSync(recordsFile(root, p.dir));
    const r = close(root, p.dir, 2);
    assert.equal(r.code, EXIT.INVALID, JSON.stringify(r.json));
    assert.ok(fs.readFileSync(recordsFile(root, p.dir)).equals(before), 'a refused close writes nothing');
    return r.json.errors;
  };
  const has = (errors, pattern) => errors.some((e) => pattern.test(e));
  const without = (fields) => { const u = unit('U-01', fields); delete u.basis; return u; };
  assert.ok(has(closeErrors([unit('U-01', { tier: null })]), /\$\.scope\.units\[0\]\.tier: a plan run gives active unit U-01 a tier \(1-3\)/));
  const noBasis = /\$\.scope\.units\[0\]\.basis: a plan run gives active unit U-01 the basis of its tier: at least one anchor, with a note on what it shows/;
  assert.ok(has(closeErrors([without()]), noBasis), 'missing');
  assert.ok(has(closeErrors([unit('U-01', { basis: [] })]), noBasis), 'empty');
  assert.ok(has(closeErrors([without({ status: 'deferred', reason: 'after the release' })]), noBasis), 'a deferred unit is active');
  assert.ok(has(closeErrors([unit('U-01', { tier: 1, basis: [] })]), noBasis), 'Tier 1 too');
  // The basis is anchors with notes: a blank note, free text, or an anchor outside the project is refused by the schema.
  assert.ok(has(closeErrors([unit('U-01', { basis: [{ anchor: 'docs/units.md#U-01', note: '   ' }] })]), /\$\.scope\.units\[0\]\.basis\[0\]\.note: must not be empty/));
  assert.ok(has(closeErrors([unit('U-01', { basis: 'because it handles money' })]), /\$\.scope\.units\[0\]\.basis/));
  assert.ok(has(closeErrors([unit('U-01', { basis: [{ anchor: '/etc/hosts', note: 'n' }] })]), /\$\.scope\.units\[0\]\.basis\[0\]\.anchor/));
  // While the plan is open, an honest "unclassified" is allowed: check reports no tier or basis error.
  edit(root, p.dir, (d) => { d.scope.units = [unit('U-01', { tier: null })]; });
  assert.ok(!(check(root, p.dir).json.errors ?? []).some((e) => /tier|basis/.test(e)));
  // Out of scope needs neither; any well-formed basis passes, whatever the tier: the tier is the lead's judgment,
  // and a basis may say that nothing documents the unit's criticality.
  const outOfScope = unit('U-02', { status: 'out_of_scope', reason: 'owner exclusion', tier: null });
  delete outOfScope.basis;
  edit(root, p.dir, (d) => {
    d.scope.units = [unit('U-01', { tier: 3, basis: [{ anchor: 'src/a.js:1', note: 'no document states its criticality; the code touches no money, authorization or stored data' }] }), outOfScope];
  });
  closeOk(root, p.dir, 3);
  assert.match(report(root, p.dir), /^\| U-01 \| U-01 title \| 3 \| src\/a\.js:1 — no document states its criticality; the code touches no money, authorization or stored data \| planned \|/m);
});

test('a plan closed incomplete may leave a unit unclassified; that unit cannot run until a re-plan classifies it', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01', { tier: null })]);
  closeOk(root, p.dir, 2, 'incomplete', 'owner-stopped');
  refusedOpen(root, 3, { base: p.id, unit: 'U-01' }, /unit U-01 has no tier or no tier basis; classify it in a re-plan first/);
  const re = open(root, 3, { mode: 'audit-plan', slug: 'replan', base: p.id });
  edit(root, re.dir, (d) => { d.scope.units[0].tier = 2; });
  closeOk(root, re.dir, 4);
  assert.equal(open(root, 5, { slug: 'u1', base: re.id, unit: 'U-01' }).id.endsWith('audit-unit-u1'), true);
});

test('an unclassified unit neither runs nor counts toward the whole audit; a re-plan classifies it, and reopens a unit raised to Tier 1', (t) => {
  const root = project(t);
  const p = plan(root, 1, [unit('U-01'), unit('U-02')]);
  closeOk(root, p.dir, 2);
  const u1 = open(root, 3, { slug: 'u1', base: p.id, unit: 'U-01' });
  reviewUnit(root, u1.dir);
  closeOk(root, u1.dir, 4);
  // A legacy ledger (written before tiers needed a basis): both units unclassified.
  const legacy = readRecords(root, u1.dir);
  for (const u of legacy.scope.units) { u.tier = null; delete u.basis; }
  writeRecords(root, u1.dir, legacy);
  refusedOpen(root, 5, { base: u1.id, unit: 'U-02' }, /unit U-02 has no tier or no tier basis; classify it in a re-plan first/);
  // The audit close cannot count an unclassified reviewed unit.
  const fin = open(root, 5, { slug: 'close', base: u1.id, unit: 'close' });
  edit(root, fin.dir, () => {});
  closeInvalid(root, fin.dir, 6, /the audit closes complete only when every reviewed unit is classified; U-01 has no tier or no tier basis/);
  closeOk(root, fin.dir, 6, 'incomplete', 'owner-stopped');
  assert.match(report(root, fin.dir), /^Whole audit: not complete: units not complete: U-02; units not classified: U-01, U-02; the audit close is incomplete \(owner-stopped\)\.$/m);
  // A re-plan classifies them (null -> a tier is never a lowering); raising the reviewed U-01 to Tier 1 reopens it.
  const re = open(root, 7, { mode: 'audit-plan', slug: 'replan', base: fin.id });
  const classify = (d, tier1Status) => {
    d.scope.units[0] = { ...d.scope.units[0], tier: 1, status: tier1Status, basis: [{ anchor: 'docs/ledger.md#Balances', note: 'it moves balances' }] };
    d.scope.units[1] = { ...d.scope.units[1], tier: 2, basis: [{ anchor: 'src/b.js:1', note: 'reads the ledger only' }] };
  };
  edit(root, re.dir, (d) => classify(d, 'complete'));
  const errors = check(root, re.dir).json.errors ?? [];
  assert.ok(errors.some((e) => /U-01 is raised to Tier 1 after its review; reopen it \(planned\) so it is reviewed again with the R4 judgment critique/.test(e)), JSON.stringify(errors));
  assert.ok(!errors.some((e) => /lowers a unit's priority/.test(e)), 'classifying an unclassified unit is not a lowering');
  edit(root, re.dir, (d) => classify(d, 'planned'));
  assert.equal(check(root, re.dir).code, EXIT.OK, JSON.stringify(check(root, re.dir).json));
  closeOk(root, re.dir, 8);
  // U-01 runs again as Tier 1, so its complete close needs R4.
  const again = open(root, 9, { slug: 'u1b', base: re.id, unit: 'U-01' });
  reviewUnit(root, again.dir);
  closeInvalid(root, again.dir, 10, /unit U-01 is Tier 1: it closes complete only after a completed R4 judgment critique/);
});
