// v1.0 release-candidate hardening (2026-10-28): one regression test per
// defect the reliability audit demonstrated (VALIDATION.md, "v1.0 release
// candidate"). Disposable repositories only; every helper call goes through
// the real CLI, and records are edited the way other tests seed them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { closeRun as helperClose } from '../scripts/lib/close.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, closeRun, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const NS = 'experiments/rc';
const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function project(t, files = {}) {
  return fs.realpathSync.native(makeRepo(makeTempDir(t), { 'src/a.js': numbered(30), 'src/guard.js': 'guard\n', 'docs/spec.md': '# Spec\n\n## Rules\n\nrule\n', ...files }));
}
function open(root, args, now = at(1)) {
  const r = nthr(['new-run', '--ns', NS, ...args], { cwd: root, now });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  return r.json.result.run_dir;
}
const edit = (root, runDir, fn) => { const d = readRecords(root, runDir); fn(d); writeRecords(root, runDir, d); return d; };
const check = (root, runDir) => nthr(['check', '--run', runDir], { cwd: root });
const errors = (r) => (r.json.errors ?? []).join('\n');
const ob = (id, status, anchor = 'src/a.js:3-5', extra = {}) => ({
  id, checks: ['AUTHZ.2'], claim: `${id} claim`, scope: 'scope', acceptance: 'acceptance', coverage: 'all-enumerated', coverage_method: 'read',
  status, open_reason: status === 'open' ? 'verification' : null, source_trace: 'consistent', evidence: [{ anchor, note: 'e' }], intent: [], assumptions: [], links: [], ...extra,
});
const finding = (verdict, verification, extra = {}) => ({
  id: 'F-1', fingerprint: 'rc/f1', kind: 'defect', verdict, severity: 'critical', impact_dimension: 'security', obligation: 'OB-1',
  summary: 'Any user can read any invoice.', trace: [{ role: 'sink', anchor: 'src/a.js:4', note: 'the read' }],
  counterevidence: [{ anchor: 'src/a.js:3', note: 'a guard exists' }], validation_plan: null, verification, decision: 'pending', ...extra,
});
const delegation = (role) => (role === 'R5'
  ? { role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: 4, tokens: 100, completed: true, recovery_messages: 0 }
  : { role: 'R6', agent: 'reviewer', model: 'sonnet', effort: null, budget_calls: 10, tool_uses: 4, tokens: 100, completed: true, recovery_messages: 0 });
const lead = (d) => Object.assign(d.run.runtime, { lead_model: 'claude-opus-5-5', lead_effort: 'high', required_lead_model: 'opus-high', triggers: [...new Set([...d.run.runtime.triggers, 'authorization'])] });

test('A1: a refuter-decided defect follows the refuter: R5 for security, the verdict matches the outcome, incomplete stays a candidate', (t) => {
  const root = project(t);
  const runDir = open(root, ['--mode', 'task', '--slug', 'a1', '--change', '.:HEAD..HEAD']);
  const seed = (verdict, verification, role) => edit(root, runDir, (d) => {
    lead(d);
    d.obligations = [ob('OB-1', 'held', 'src/a.js:3-5', { links: ['F-1'] })];
    d.findings = [finding(verdict, verification)];
    d.delegations = role ? [delegation(role)] : [];
    Object.assign(d.budget.spent, { subagent_calls: d.delegations.length, subagent_tokens: 100 * d.delegations.length });
  });
  const refused = [
    ['rejected by the Sonnet refuter', 'rejected', { role: 'R6', model: 'sonnet', outcome: 'rejected', corrections: null, incomplete: false }, 'R6', /needs the R5 Opus refuter/],
    ['rejected by no refuter', 'rejected', { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }, null, /a rejected defect needs a completed R5 or R6 verification that rejected it/],
    ['rejected against an R5 confirmation', 'rejected', { role: 'R5', model: 'opus', outcome: 'confirmed', corrections: null, incomplete: false }, 'R5', /rejected contradicts the R5 outcome confirmed/],
    ['rejected on an incomplete verification', 'rejected', { role: 'R5', model: 'opus', outcome: null, corrections: null, incomplete: true }, 'R5', /an incomplete verification leaves the finding a candidate/],
    ['needs_validation against an R5 rejection', 'needs_validation', { role: 'R5', model: 'opus', outcome: 'rejected', corrections: null, incomplete: false }, 'R5', /needs_validation contradicts the R5 outcome rejected/],
  ];
  for (const [label, verdict, verification, role, message] of refused) {
    seed(verdict, verification, role);
    const r = check(root, runDir);
    assert.equal(r.code, EXIT.INVALID, label);
    assert.match(errors(r), message, label);
  }
  // Control: an R5 rejection with counterevidence is a valid rejected defect, and its obligation may be held.
  seed('rejected', { role: 'R5', model: 'opus', outcome: 'rejected', corrections: null, incomplete: false }, 'R5');
  assert.equal(check(root, runDir).code, EXIT.OK, JSON.stringify(check(root, runDir).json));
});

test('A2: an obligation is never held while its own defect is a candidate or needs validation', (t) => {
  const root = project(t);
  const runDir = open(root, ['--mode', 'task', '--slug', 'a2', '--change', '.:HEAD..HEAD']);
  const none = { role: 'none', model: null, outcome: null, corrections: null, incomplete: false };
  for (const [verdict, extra] of [['candidate', {}], ['needs_validation', { severity: null, validation_plan: 'confirm the gateway config' }]]) {
    edit(root, runDir, (d) => { lead(d); d.obligations = [ob('OB-1', 'held')]; d.findings = [finding(verdict, none, { impact_dimension: 'correctness', severity: verdict === 'candidate' ? 'low' : null, ...extra })]; });
    assert.match(errors(check(root, runDir)), new RegExp(`cannot be held while F-1 is ${verdict}`), verdict);
  }
  // Control: open (verification) is the honest state while the candidate is unverified.
  edit(root, runDir, (d) => { d.obligations = [ob('OB-1', 'open')]; d.findings = [finding('candidate', none, { impact_dimension: 'correctness', severity: 'low' })]; });
  assert.equal(check(root, runDir).code, EXIT.OK, JSON.stringify(check(root, runDir).json));
});

test('A3: the lead cannot lower the lead model new-run derived: Incremental needs opus-high; a task above S keeps task-size', (t) => {
  const root = project(t, { 'src/big.js': numbered(500) });
  rawGit(root, ['tag', 'base']);
  write(root, 'src/big.js', numbered(500).replaceAll('line', 'LINE'));
  commitAll(root, 'big change');
  const taskDir = open(root, ['--mode', 'task', '--slug', 'm', '--change', '.:base..HEAD']);
  const task = readRecords(root, taskDir);
  assert.deepEqual([task.budget.lead_tool_calls, task.run.runtime.triggers], [70, ['task-size']]);
  edit(root, taskDir, (d) => Object.assign(d.run.runtime, { required_lead_model: 'sonnet', triggers: [], lead_model: 'claude-sonnet-5-5', lead_effort: 'high' }));
  assert.match(errors(check(root, taskDir)), /keeps the task-size trigger/);
  closeRun(root, taskDir, { status: 'incomplete', reason: 'owner-stopped', edit: (d) => Object.assign(d.run.runtime, { required_lead_model: 'opus-high', triggers: ['task-size'], lead_model: 'claude-opus-5-5', lead_effort: 'high' }) });
  const incDir = open(root, ['--mode', 'incremental', '--slug', 'i', '--base', task.run.id], at(5));
  edit(root, incDir, (d) => Object.assign(d.run.runtime, { required_lead_model: 'sonnet', lead_model: 'claude-sonnet-5-5', lead_effort: 'high' }));
  assert.match(errors(check(root, incDir)), /incremental runs require opus-high/);
  // Control: a task of size S keeps its Sonnet allowance.
  const small = project(t);
  const sDir = open(small, ['--mode', 'task', '--slug', 's', '--change', '.:HEAD..HEAD']);
  edit(small, sDir, (d) => Object.assign(d.run.runtime, { lead_model: 'claude-sonnet-5-5', lead_effort: 'high' }));
  assert.equal(check(small, sDir).code, EXIT.OK, JSON.stringify(check(small, sDir).json));
});

test('A4: a cited untracked file edited after the evidence is never closed as reviewed: refused in a task run, unverified when closed snapshot-changed', (t) => {
  const root = project(t);
  makeRepo(path.join(root, 'api'), { 'x.js': 'x\n' });
  write(root, 'src/new.js', 'export function pay(amount) {\n  guard(amount);\n  return charge(amount);\n}\n');
  const runDir = open(root, ['--mode', 'task', '--slug', 'a4', '--change', '.']);
  edit(root, runDir, (d) => { lead(d); d.obligations = [ob('OB-1', 'held', 'src/new.js:2')]; });
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  write(root, 'src/new.js', 'export function pay(amount) {\n  // guard removed\n  return charge(amount);\n}\n');
  const reassessed = nthr(['close', '--run', runDir, '--status', 'complete', '--reassessed'], { cwd: root, now: at(3) });
  assert.equal(reassessed.code, EXIT.USAGE, JSON.stringify(reassessed.json));
  assert.match(errors(reassessed), /files this review cites may have changed since Open \(src\/new\.js untracked\)/);
  assert.equal(nthr(['resume', '--ns', NS], { cwd: root, now: at(3) }).json.result.cause, 'cited-untracked', 'close and resume agree');
  // With a tracked change in another repository too, an explicit snapshot-changed close records the file as unverified.
  write(root, 'api/x.js', 'x changed\n');
  commitAll(path.join(root, 'api'), 'api change');
  const closed = nthr(['close', '--run', runDir, '--status', 'incomplete', '--reason', 'snapshot-changed'], { cwd: root, now: at(4) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  assert.deepEqual(readRecords(root, runDir).footprint['src/new.js'], { blob: null, state: 'unverified', reason: 'source-changed' });
  const inc = open(root, ['--mode', 'incremental', '--slug', 'next', '--base', path.basename(runDir)], at(5));
  assert.equal(nthr(['fresh', '--run', inc], { cwd: root, now: at(6) }).code, EXIT.OK);
  assert.equal(readRecords(root, inc).freshness.obligations.find((o) => o.id === 'OB-1').class, 'touched', 'never current');
});

test('S-A1: partial untracked hashing elsewhere, or an unproven tracked state, never puts an unchanged hashed untracked citation at risk', (t) => {
  const root = project(t, { '.gitignore': 'web/\n' });
  makeRepo(path.join(root, 'web'), { 'index.js': 'x\n' });
  write(root, 'src/new.js', 'export const n = 1;\n');
  write(root, 'web/assets/big.bin', 'x'.repeat(2 * 1024 * 1024)); // over the hashing limit
  const runDir = open(root, ['--mode', 'task', '--slug', 's1', '--change', '.']);
  edit(root, runDir, (d) => { d.obligations = [ob('OB-1', 'held', 'src/new.js:1')]; });
  const plan = nthr(['resume', '--ns', NS], { cwd: root, now: at(5) });
  assert.equal(plan.code, EXIT.OK, JSON.stringify(plan.json));
  assert.equal(plan.json.result.source.untracked, 'unverified');
  assert.equal(plan.json.result.action, 'continue', 'nothing changed: the run continues');
  // Control: once the cited file itself changes, resume abandons it.
  write(root, 'src/new.js', 'export const n = 2;\n');
  assert.equal(nthr(['resume', '--ns', NS], { cwd: root, now: at(6) }).json.result.cause, 'cited-untracked');
});

test('A5: an abandoned run never keeps the report an interrupted close wrote; check refuses one', (t) => {
  const root = project(t);
  const runDir = open(root, ['--mode', 'task', '--slug', 'a5', '--change', '.:HEAD..HEAD']);
  edit(root, runDir, (d) => { lead(d); d.obligations = [ob('OB-1', 'held')]; });
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  const crash = (from, to) => { if (to.endsWith('records.json')) throw Object.assign(new Error('simulated crash'), { code: 'EIO' }); fs.renameSync(from, to); };
  assert.throws(() => helperClose(root, NS, path.basename(runDir), { status: 'complete', now: at(3), io: { rename: crash } }), /simulated crash/);
  const report = path.join(root, ...runDir.split('/'), 'report.md');
  assert.ok(fs.existsSync(report), 'the interrupted close left its report');
  write(root, 'src/a.js', `${numbered(30)}changed\n`);
  commitAll(root, 'moved on');
  const applied = nthr(['resume', '--ns', NS, '--apply'], { cwd: root, now: at(4) });
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  assert.ok(!fs.existsSync(report), 'resume removed it before the commit point');
  assert.ok(applied.json.result.removed_temporary.some((p) => p.endsWith('/report.md')));
  assert.equal(check(root, runDir).code, EXIT.OK);
  fs.writeFileSync(report, '# Review report\n\nStatus complete\n');
  assert.match(errors(check(root, runDir)), /an abandoned run has no report\.md/);
});

test('A6: a refused close changes nothing, not even a leftover temporary file', (t) => {
  const root = project(t);
  const runDir = open(root, ['--mode', 'task', '--slug', 'a6', '--change', '.:HEAD..HEAD']);
  edit(root, runDir, (d) => { lead(d); d.obligations = [ob('OB-1', 'open')]; });
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  const temp = path.join(root, ...runDir.split('/'), '.records.json.4242.0123456789ab.tmp');
  fs.writeFileSync(temp, 'partial');
  const refused = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(3) });
  assert.equal(refused.code, EXIT.INVALID);
  assert.ok(fs.existsSync(temp), 'still there after the refusal');
  const closed = nthr(['close', '--run', runDir, '--status', 'incomplete', '--reason', 'open-obligations'], { cwd: root, now: at(4) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  assert.ok(!fs.existsSync(temp), 'removed by the close that passed');
});

test('A7: in an array whose items have ids, a patch path names an id; a missing id never falls back to a position', (t) => {
  const root = project(t);
  const runDir = open(root, ['--mode', 'task', '--slug', 'a7', '--change', '.:HEAD..HEAD']);
  edit(root, runDir, (d) => { d.obligations = [ob('OB-1', 'open'), ob('OB-2', 'open'), ob('OB-3', 'open')]; });
  const sha = check(root, runDir).json.records_sha256 ?? check(root, runDir).json.result.records_sha256;
  fs.writeFileSync(path.join(root, ...runDir.split('/'), 'patch.json'), JSON.stringify({ schema: 'nth-review/patch@1', base: sha, ops: [{ op: 'remove', path: '/obligations/1' }] }));
  const r = nthr(['apply', '--run', runDir], { cwd: root });
  assert.equal(r.code, EXIT.INVALID, JSON.stringify(r.json));
  assert.deepEqual(readRecords(root, runDir).obligations.map((o) => o.id), ['OB-1', 'OB-2', 'OB-3'], 'nothing removed');
});

test('S-A3: resume --apply hands on an assumption-changed mark the run had not yet reassessed', (t) => {
  const root = project(t);
  const r1 = open(root, ['--mode', 'task', '--slug', 'base', '--change', '.:HEAD..HEAD']);
  closeRun(root, r1, { edit: (d) => { d.obligations = [ob('OB-1', 'held', 'src/a.js:1')]; } });
  const r2 = open(root, ['--mode', 'incremental', '--slug', 'inc', '--base', path.basename(r1)], at(3));
  assert.equal(nthr(['fresh', '--run', r2], { cwd: root, now: at(4) }).code, EXIT.OK);
  edit(root, r2, (d) => { d.freshness.obligations = d.freshness.obligations.map((o) => (o.id === 'OB-1' ? { ...o, class: 'assumption-changed', reason: 'gateway SLA changed (owner)' } : o)); });
  write(root, 'src/guard.js', 'guard changed\n');
  commitAll(root, 'unrelated');
  const applied = nthr(['resume', '--ns', NS, '--apply'], { cwd: root, now: at(5) });
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  const generated = applied.json.result.debt.generated;
  assert.equal(generated.length, 1);
  assert.match(generated[0].requires, /^OB-1 was marked assumption-changed .*gateway SLA changed/);
  assert.equal(readRecords(root, applied.json.result.run_dir).debt.in.length, 1, 'the continuation inherits it');
});

test('S-A7: evidence on a file absent at the origin is never current later', (t) => {
  const root = project(t);
  const r1 = open(root, ['--mode', 'task', '--slug', 'gone', '--change', '.:HEAD..HEAD']);
  edit(root, r1, (d) => { lead(d); d.obligations = [ob('OB-1', 'held', 'src/gone.js:3', { coverage: 'named-subset' })]; });
  const closed = nthr(['close', '--run', r1, '--status', 'complete'], { cwd: root, now: at(2) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  assert.equal(readRecords(root, r1).footprint['src/gone.js'].state, 'absent');
  const r2 = open(root, ['--mode', 'incremental', '--slug', 'inc', '--base', path.basename(r1)], at(3));
  assert.equal(nthr(['fresh', '--run', r2], { cwd: root, now: at(4) }).code, EXIT.OK);
  const entry = readRecords(root, r2).freshness.obligations.find((o) => o.id === 'OB-1');
  assert.equal(entry.class, 'touched');
  assert.match(entry.reason, /absent at base and now/);
});

test('S-A8: a gitlink committed without a .gitmodules entry is reported, never assumed covered', (t) => {
  const root = project(t);
  const sdk = makeRepo(path.join(root, 'vendor', 'pay', 'sdk'), { 'index.js': 'sdk\n' });
  rawGit(root, ['add', 'vendor/pay/sdk']);
  rawGit(root, ['-c', 'user.name=nthr-test', '-c', 'user.email=nthr@test.invalid', 'commit', '-q', '-m', 'embed sdk']);
  assert.match(rawGit(root, ['ls-files', '--stage', 'vendor/pay/sdk']), /^160000 /);
  assert.ok(!fs.existsSync(path.join(root, '.gitmodules')));
  assert.ok(fs.existsSync(sdk));
  const runDir = open(root, ['--mode', 'task', '--slug', 's8', '--change', '.:HEAD..HEAD']);
  const snapshot = readRecords(root, runDir).snapshot;
  assert.equal(snapshot.discovery_complete, false);
  assert.deepEqual(snapshot.limitations, [{ code: 'submodule-not-covered', path: 'vendor/pay/sdk' }]);
});

test('R-1: a cited untracked file too large to hash at Open is at risk when its repository hashed partly, even with an equal untracked state', (t) => {
  const root = project(t);
  write(root, 'src/big.js', 'x\n'.repeat(700 * 1024)); // over the 1 MiB hashing limit: skipped at Open
  const runDir = open(root, ['--mode', 'task', '--slug', 'r1', '--change', '.']);
  edit(root, runDir, (d) => { lead(d); d.obligations = [ob('OB-1', 'held', 'src/big.js:3')]; });
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  write(root, 'src/big.js', 'y\n'.repeat(700 * 1024)); // same size, other content: no snapshot can see it
  assert.equal(nthr(['resume', '--ns', NS], { cwd: root, now: at(3) }).json.result.cause, 'cited-untracked');
  const reassessed = nthr(['close', '--run', runDir, '--status', 'complete', '--reassessed'], { cwd: root, now: at(4) });
  assert.equal(reassessed.code, EXIT.USAGE, JSON.stringify(reassessed.json));
  assert.match(errors(reassessed), /src\/big\.js untracked/);
});

test('R-2: resume --apply abandons a run that holds an unapplied patch; the patch is never applied', (t) => {
  const root = project(t);
  const runDir = open(root, ['--mode', 'task', '--slug', 'r2', '--change', '.:HEAD..HEAD']);
  edit(root, runDir, (d) => { d.obligations = [ob('OB-1', 'open')]; });
  const patch = path.join(root, ...runDir.split('/'), 'patch.json');
  fs.writeFileSync(patch, JSON.stringify({ schema: 'nth-review/patch@1', base: '0'.repeat(64), ops: [{ op: 'set', path: '/obligations/OB-1/status', value: 'held' }] }));
  write(root, 'src/a.js', `${numbered(30)}changed\n`);
  commitAll(root, 'moved on');
  const applied = nthr(['resume', '--ns', NS, '--apply'], { cwd: root, now: at(4) });
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  assert.ok(!fs.existsSync(patch), 'removed with the leftovers');
  assert.equal(readRecords(root, runDir).obligations[0].status, 'open', 'never applied');
  assert.equal(check(root, runDir).code, EXIT.OK);
});
