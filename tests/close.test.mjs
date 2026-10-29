import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { checkRun } from '../scripts/lib/check.mjs';
import { closeRun } from '../scripts/lib/close.mjs';
import { RECHECK_COMMAND, renderReport } from '../scripts/lib/render.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, nthr, readRecords, recordsFile, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// An open task run whose records pass `check`: a held, all-enumerated
// obligation and a violated one with a confirmed, R6-verified defect.
function reviewedRun(t, { files = {}, setup, edit } = {}) {
  const base = makeTempDir(t);
  const root = fs.realpathSync.native(makeRepo(path.join(base, 'repo'), {
    'src/a.js': numbered(30), 'src/guard.js': 'guard\n', 'docs/spec.md': '# Spec\n\n## Rules\n\nrule\n', ...files,
  }));
  setup?.(root, base);
  const opened = nthr(['new-run', '--ns', 'experiments/close', '--mode', 'task', '--slug', 'c', '--change', '.'], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  Object.assign(doc.scope, { summary: 'close test', intent: [{ id: 'I1', anchor: 'docs/spec.md#Rules', note: 'rules' }] });
  doc.run.runtime.lead_model = 'claude-sonnet-5-5';
  doc.census.items = [{ id: 'CI-1', path: 'src/a.js', mechanism: 'route', status: 'classified', reason: null, affects: ['OB-1', 'OB-2'] }];
  const obligation = (id, status, coverage, anchor, links) => ({
    id, checks: ['CLOSE'], claim: `${id} claim`, scope: 'scope', acceptance: 'acceptance', coverage, coverage_method: `${id} method`,
    status, open_reason: null, source_trace: 'consistent', evidence: [{ anchor, note: 'evidence' }], intent: ['I1'],
    assumptions: [{ kind: 'dependency', anchor: 'src/guard.js:1', fact: null, observed: null, note: 'guard' }], links,
  });
  doc.obligations = [obligation('OB-1', 'held', 'all-enumerated', 'src/a.js:3-5', []), obligation('OB-2', 'violated', 'named-subset', 'src/a.js:10', ['F-1'])];
  doc.findings = [{
    id: 'F-1', fingerprint: 'close/f1', kind: 'defect', verdict: 'confirmed', severity: 'medium', impact_dimension: 'correctness',
    obligation: 'OB-2', summary: 'Line 10 is wrong.', trace: [{ role: 'sink', anchor: 'src/a.js:10', note: 'the write' }],
    counterevidence: [], validation_plan: null,
    verification: { role: 'R6', model: 'sonnet', outcome: 'confirmed', corrections: null, incomplete: false }, decision: 'pending',
  }];
  doc.delegations = [{ role: 'R6', agent: 'reviewer', model: 'sonnet', effort: null, budget_calls: 10, tool_uses: 4, tokens: 30000, completed: true, recovery_messages: 0 }];
  doc.budget.spent = { lead_tool_calls: 12, subagent_calls: 1, subagent_tokens: 30000, lead_tokens_observed: null, wall_clock_min: 7 };
  edit?.(doc);
  writeRecords(root, runDir, doc);
  return { root, runDir, base };
}

const close = (root, runDir, args) => nthr(['close', '--run', runDir, ...args], { cwd: root, now: at(5) });
const reportFile = (root, runDir) => path.join(root, ...runDir.split('/'), 'report.md');
const state = (root, runDir) => [fs.readFileSync(recordsFile(root, runDir), 'utf8'), fs.existsSync(reportFile(root, runDir))];

test('new-run, records, pack, footprint, check, close, report: a complete run, immutable afterwards', (t) => {
  const { root, runDir } = reviewedRun(t);
  const opened = readRecords(root, runDir);
  assert.equal(nthr(['pack', '--run', runDir, '--for', 'F-1'], { cwd: root }).code, EXIT.OK);
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.OK);

  const closed = close(root, runDir, ['--status', 'complete']);
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  assert.deepEqual(closed.json.result.source, { tracked: 'equal', untracked: 'equal', coverage: 'equal', action: 'continue', reassessed: false });
  const doc = readRecords(root, runDir);
  assert.equal(doc.run.status, 'complete');
  assert.equal(doc.run.incomplete_reason, null);
  assert.equal(doc.run.closed, '2026-10-26T09:00:05Z');
  assert.deepEqual(doc.snapshot, opened.snapshot, 'the Open snapshot is never replaced');
  assert.deepEqual(Object.keys(doc.footprint), ['docs/spec.md', 'src/a.js', 'src/guard.js']);
  const recheck = doc.checks.find((c) => c.command === RECHECK_COMMAND);
  assert.match(recheck.result, /^tracked equal; untracked equal; coverage equal; action continue$/);
  assert.match(recheck.proves, /equals the snapshot taken at Open/);

  // The report: deterministic, gaps first, coverage and correctness apart.
  const report = fs.readFileSync(reportFile(root, runDir), 'utf8');
  assert.equal(report, renderReport(doc), 'byte-identical when rendered again from the records');
  const order = ['| Helper |', '## Summary', '## 1. Gaps', '### Source state at Close', '### Open obligations', '### Unverified findings', '### Review debt',
    '## 2. Coverage', '## 3. Correctness', '## 4. Findings', '## 5. Delegations', '## 6. Cost'].map((h) => report.indexOf(h));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  assert.match(report, /\| OB-1 \| OB-1 claim \| OB-1 method \| Verified \|/);
  assert.match(report, /### F-1 · defect · medium · confirmed · decision pending/);
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.OK);

  // Closed is final: every write path refuses, and nothing changes.
  const frozen = state(root, runDir);
  const reportBytes = fs.readFileSync(reportFile(root, runDir));
  for (const args of [['close', '--run', runDir, '--status', 'complete'], ['close', '--run', runDir, '--status', 'incomplete', '--reason', 'budget'],
    ['footprint', '--run', runDir], ['pack', '--run', runDir, '--for', 'F-1']]) {
    const r = nthr(args, { cwd: root, now: at(9) });
    assert.equal(r.code, EXIT.USAGE, `${args[0]}: ${JSON.stringify(r.json)}`);
  }
  assert.match(close(root, runDir, ['--status', 'complete']).json.errors[0], /already complete; a closed run never changes/);
  assert.deepEqual(state(root, runDir), frozen);
  assert.ok(fs.readFileSync(reportFile(root, runDir)).equals(reportBytes));
});

test('a tracked change since Open refuses closure; only an explicit snapshot-changed close is allowed', (t) => {
  const { root, runDir } = reviewedRun(t);
  const opened = readRecords(root, runDir);
  write(root, 'src/a.js', `${numbered(30)}changed\n`);
  const before = state(root, runDir);
  const refused = close(root, runDir, ['--status', 'complete']);
  assert.equal(refused.code, EXIT.USAGE);
  assert.match(refused.json.errors[0], /the tracked source changed since Open \(\.\)/);
  assert.match(close(root, runDir, ['--status', 'incomplete', '--reason', 'budget']).json.errors[0], /tracked source changed/);
  assert.deepEqual(state(root, runDir), before, 'nothing written');

  const explicit = close(root, runDir, ['--status', 'incomplete', '--reason', 'snapshot-changed']);
  assert.equal(explicit.code, EXIT.OK, JSON.stringify(explicit.json));
  const doc = readRecords(root, runDir);
  assert.deepEqual(doc.snapshot, opened.snapshot, 'the Open snapshot is kept, not replaced');
  assert.deepEqual(doc.footprint['src/a.js'], { blob: null, state: 'unverified', reason: 'source-changed' }, 'not the evidence state: never usable as current');
  const report = fs.readFileSync(reportFile(root, runDir), 'utf8');
  assert.match(report, /Result: tracked changed; untracked equal; coverage equal; action abandon; tracked differs in: \./);
  assert.match(report, /\| Status \| incomplete \(snapshot-changed\) \|/);
});

test('untracked changes and unobservable state need an explicit --reassessed', (t) => {
  const { root, runDir } = reviewedRun(t);
  write(root, 'notes/new.md', 'untracked\n');
  const refused = close(root, runDir, ['--status', 'complete']);
  assert.equal(refused.code, EXIT.USAGE);
  assert.match(refused.json.errors[0], /untracked changed.*Reassess scope and census for \..*--reassessed/);
  assert.equal(fs.existsSync(reportFile(root, runDir)), false);
  const reassessed = close(root, runDir, ['--status', 'complete', '--reassessed']);
  assert.equal(reassessed.code, EXIT.OK, JSON.stringify(reassessed.json));
  assert.match(readRecords(root, runDir).checks.at(-1).result, /untracked differs in: \.; the lead declared scope and census reassessed/);

  // A tracked secret modified before Open was never observed: equal keys are
  // not verified equality, so even an unchanged source needs reassessment.
  const secret = reviewedRun(t, { files: { 'config/.env.example': 'A=1\n' }, setup: (root) => write(root, 'config/.env.example', 'A=2\n') });
  assert.equal(readRecords(secret.root, secret.runDir).snapshot.tracked_complete, false);
  const unverified = close(secret.root, secret.runDir, ['--status', 'complete']);
  assert.equal(unverified.code, EXIT.USAGE);
  assert.match(unverified.json.errors[0], /tracked unverified/);
  assert.equal(close(secret.root, secret.runDir, ['--status', 'complete', '--reassessed']).code, EXIT.OK);
});

test('a failing check changes nothing: invalid findings, unresolved obligations, invalid status', (t) => {
  const invalid = reviewedRun(t, { edit: (d) => { d.findings[0].verification = { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }; } });
  const before = state(invalid.root, invalid.runDir);
  const r = close(invalid.root, invalid.runDir, ['--status', 'complete']);
  assert.equal(r.code, EXIT.INVALID);
  assert.ok(r.json.errors.some((e) => /a confirmed defect needs a completed R5 or R6 verification/.test(e)), r.json.errors.join('\n'));
  assert.deepEqual(state(invalid.root, invalid.runDir), before);

  const open = reviewedRun(t, { edit: (d) => { Object.assign(d.obligations[0], { status: 'open', open_reason: 'needs-runtime' }); } });
  const complete = close(open.root, open.runDir, ['--status', 'complete']);
  assert.equal(complete.code, EXIT.INVALID);
  assert.ok(complete.json.errors.includes('$.obligations[0].status: a complete run has no open obligation; close as incomplete'));
  assert.equal(fs.existsSync(reportFile(open.root, open.runDir)), false);
  const incomplete = close(open.root, open.runDir, ['--status', 'incomplete', '--reason', 'open-obligations']);
  assert.equal(incomplete.code, EXIT.OK, JSON.stringify(incomplete.json));
  assert.match(fs.readFileSync(reportFile(open.root, open.runDir), 'utf8'), /### Open obligations\n\n- OB-1 \(needs-runtime\): OB-1 claim/);

  for (const [args, pattern] of [
    [['--status', 'abandoned'], /complete or incomplete/],
    [['--status', 'incomplete'], /needs --reason/],
    [['--status', 'incomplete', '--reason', 'tired'], /needs --reason/],
    [['--status', 'complete', '--reason', 'budget'], /only for --status incomplete/],
  ]) {
    const v = reviewedRun(t);
    const bad = close(v.root, v.runDir, args);
    assert.equal(bad.code, EXIT.USAGE, JSON.stringify(bad.json));
    assert.match(bad.json.errors[0], pattern);
  }
});

test('failed writes: records are written last, a failure leaves the run open, and close can be retried', (t) => {
  const { root, runDir } = reviewedRun(t);
  const ns = 'experiments/close';
  const id = path.basename(runDir);
  const before = fs.readFileSync(recordsFile(root, runDir), 'utf8');
  const failOn = (name) => (from, to) => {
    if (to.endsWith(name)) throw Object.assign(new Error(`simulated crash writing ${name}`), { code: 'EIO' });
    fs.renameSync(from, to);
  };
  // The report write fails: nothing changes.
  assert.throws(() => closeRun(root, ns, id, { status: 'complete', now: at(5), io: { rename: failOn('report.md') } }), /simulated crash writing report\.md/);
  assert.equal(fs.readFileSync(recordsFile(root, runDir), 'utf8'), before);
  assert.equal(fs.existsSync(reportFile(root, runDir)), false);
  // The records write fails after the report: the run is still open.
  assert.throws(() => closeRun(root, ns, id, { status: 'complete', now: at(5), io: { rename: failOn('records.json') } }), /simulated crash writing records\.json/);
  assert.equal(fs.readFileSync(recordsFile(root, runDir), 'utf8'), before);
  assert.equal(readRecords(root, runDir).run.status, 'open');
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.OK, 'a leftover report.md is an allowed file');
  const leftovers = fs.readdirSync(path.join(root, ...runDir.split('/'))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temporary files left');
  // Retry: it closes, and the report matches the records.
  const retried = close(root, runDir, ['--status', 'complete']);
  assert.equal(retried.code, EXIT.OK, JSON.stringify(retried.json));
  assert.equal(fs.readFileSync(reportFile(root, runDir), 'utf8'), renderReport(readRecords(root, runDir)));
});

test('unverified evidence is never reported as verified', (t) => {
  const { root, runDir } = reviewedRun(t, {
    setup: (root, base) => {
      write(base, 'pass.mjs', 'process.stdin.pipe(process.stdout);\n');
      rawGit(root, ['config', 'filter.pass.clean', `node "${path.join(base, 'pass.mjs').replaceAll('\\', '/')}"`]);
      write(root, '.gitattributes', 'guard.js filter=pass\n');
      commitAll(root);
    },
  });
  const closed = close(root, runDir, ['--status', 'complete']);
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const doc = readRecords(root, runDir);
  assert.deepEqual(doc.footprint['src/guard.js'], { blob: null, state: 'unverified', reason: 'filter' });
  const report = fs.readFileSync(reportFile(root, runDir), 'utf8');
  assert.match(report, /- src\/guard\.js: unverified \(filter\); cited by OB-1, OB-2/);
  assert.match(report, /- OB-1 is held on evidence that is unverified or absent: never reported as verified/);
  assert.match(report, /\| OB-1 \| OB-1 claim \| OB-1 method \| not verified \|/);
  assert.ok(!/^\| OB-\d+ .*\| Verified \|$/m.test(report), 'no obligation row is labelled Verified');
});

test('C13: a census item that contradicts all-enumerated refuses close, and the report never labels the obligation Verified, even from inconsistent records', (t) => {
  const unknownItem = (affects, status = 'unknown') => ({ id: 'CI-2', path: 'src/guard.js', mechanism: 'reached through a dispatch table', status, reason: 'the table is built at runtime', affects });
  // End to end: close refuses, and nothing is written.
  const blocked = reviewedRun(t, { edit: (d) => { d.census.items.push(unknownItem(['OB-1'])); } });
  const before = state(blocked.root, blocked.runDir);
  const refused = close(blocked.root, blocked.runDir, ['--status', 'complete']);
  assert.equal(refused.code, EXIT.INVALID, JSON.stringify(refused.json));
  assert.ok(refused.json.errors.some((e) => /\$\.obligations\[0\]\.coverage: cannot be all-enumerated: census items CI-2 bear on it/.test(e)), JSON.stringify(refused.json.errors));
  assert.deepEqual(state(blocked.root, blocked.runDir), before, 'a refused close writes nothing');

  // The original false-Verified case at render level: records made inconsistent after a valid close.
  const { root, runDir } = reviewedRun(t);
  assert.equal(close(root, runDir, ['--status', 'complete']).code, EXIT.OK);
  const doc = readRecords(root, runDir);
  const verifiedRow = /^\| OB-1 \| OB-1 claim \| OB-1 method \| Verified \|$/m;
  assert.match(renderReport(doc), verifiedRow);
  for (const item of [unknownItem(['OB-1']), unknownItem(null), unknownItem([]), unknownItem(['OB-1'], 'excluded')]) {
    const inconsistent = structuredClone(doc);
    inconsistent.census.items.push(item);
    const report = renderReport(inconsistent);
    assert.ok(!/^\| OB-\d+ .*\| Verified \|$/m.test(report), `${item.status} ${JSON.stringify(item.affects)}: never Verified`);
    assert.match(report, /^- OB-1 claims all-enumerated coverage, but census items CI-2 bear on it: never reported as verified$/m);
  }
  // Items scoped elsewhere, or justified exclusions naming no obligation, leave the label alone.
  for (const item of [unknownItem(['OB-2']), unknownItem(null, 'excluded'), unknownItem(['OB-2'], 'excluded')]) {
    const scoped = structuredClone(doc);
    scoped.census.items.push(item);
    assert.match(renderReport(scoped), verifiedRow, `${item.status} ${JSON.stringify(item.affects)}`);
  }
  // check stays read-only on the closed run.
  const frozen = state(root, runDir);
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.OK);
  assert.deepEqual(state(root, runDir), frozen);
});

test('the scope summary and family screening are shown as recorded, never computed; freshness appears only in incremental runs', (t) => {
  const { root, runDir } = reviewedRun(t, { edit: (d) => { d.scope.summary = 'Task review. Not applicable: PERF, UI\n# Injected | pipe'; } });
  assert.equal(close(root, runDir, ['--status', 'complete']).code, EXIT.OK);
  const doc = readRecords(root, runDir);
  const report = fs.readFileSync(reportFile(root, runDir), 'utf8');
  const heading = report.indexOf('### Scope summary and family screening (as recorded)');
  assert.ok(heading > report.indexOf('## 2. Coverage') && heading < report.indexOf('### Census recipes'), 'first in Coverage');
  assert.match(report, /^Recorded by the lead in `scope\.summary`; the helper neither computes nor checks it\.$/m);
  assert.match(report, /^\| Task review\. Not applicable: PERF, UI # Injected \\\| pipe \|$/m);
  assert.ok(!/^# Injected/m.test(report), 'summary text cannot inject');
  assert.ok(!report.includes('### Freshness against base'), 'a task run has no freshness section');
  const empty = structuredClone(doc);
  empty.scope.summary = '';
  assert.match(renderReport(empty), /### Scope summary and family screening \(as recorded\)\n\nRecorded by the lead[^\n]*\n\nNone recorded\.\n/);
});

test('review fixes: snapshot-changed identities are unverified, never Verified; a killed write is recovered; record text cannot inject', (t) => {
  // A tracked change closed explicitly: the footprint of the changed
  // repository is unverified (source-changed), and nothing is "Verified".
  const changed = reviewedRun(t, { edit: (d) => { d.findings[0].summary = 'line one\r# Injected heading\n- injected item | with pipe \\ and backslash'; } });
  write(changed.root, 'src/guard.js', 'guard changed\n');
  const closed = close(changed.root, changed.runDir, ['--status', 'incomplete', '--reason', 'snapshot-changed']);
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const doc = readRecords(changed.root, changed.runDir);
  for (const [file, identity] of Object.entries(doc.footprint)) {
    assert.deepEqual(identity, { blob: null, state: 'unverified', reason: 'source-changed' }, file);
  }
  const report = fs.readFileSync(reportFile(changed.root, changed.runDir), 'utf8');
  assert.ok(!/^\| OB-\d+ .*\| Verified \|$/m.test(report), 'nothing Verified after a source change');
  assert.ok(!/^# Injected heading/m.test(report) && !/^- injected item/m.test(report), 'record text stays on one line');
  assert.match(report, /line one # Injected heading - injected item \| with pipe \\ and backslash/);

  // A close killed during its write leaves a temporary file; the next close removes it.
  const { root, runDir } = reviewedRun(t);
  const tmp = path.join(root, ...runDir.split('/'), '.records.json.4242.0123456789ab.tmp');
  fs.writeFileSync(tmp, '{"half": ');
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.INVALID, 'check flags the leftover');
  const recovered = close(root, runDir, ['--status', 'complete']);
  assert.equal(recovered.code, EXIT.OK, JSON.stringify(recovered.json));
  assert.deepEqual(recovered.json.result.removed_temporary, [`${runDir.slice('.nth-review/'.length)}/.records.json.4242.0123456789ab.tmp`]);
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.OK);
});

test('VS1: a delegation whose usage never arrived is null, never 0, and the token total is reported as a lower bound', (t) => {
  // In VS1 the R5 answer arrived before its task notification, so its usage was
  // missing at close; 0 would have presented a partial total as complete.
  const { root, runDir } = reviewedRun(t, {
    edit: (doc) => {
      doc.delegations.push({ role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: null, tokens: null, completed: true, recovery_messages: 0 });
      doc.budget.spent.subagent_calls = 2;
    },
  });
  assert.equal(nthr(['check', '--run', runDir], { cwd: root }).code, EXIT.OK, 'null usage is valid');
  const closed = close(root, runDir, ['--status', 'complete']);
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const report = fs.readFileSync(reportFile(root, runDir), 'utf8');
  assert.match(report, /^\| Subagent tokens \| – \| at least 30000 \(not reported: R5\) \| recorded by the lead from task notifications \|$/m);
  assert.match(report, /^\| R5 \| reviewer \| opus \| high \| 10 \| – \| – \| yes \| 0 \|$/m);

  // Fully reported usage keeps the plain total.
  const reported = reviewedRun(t);
  assert.match(renderReport(readRecords(reported.root, reported.runDir)), /^\| Subagent tokens \| – \| 30000 \| recorded by the lead from task notifications \|$/m);
});

test('wall clock: close computes it from opened and closed, replacing any lead value; an earlier clock is refused', (t) => {
  // Owner decision 2026-10-26: VS1's lead recorded 12 minutes for a run open 6.6 minutes.
  const { root, runDir } = reviewedRun(t, { edit: (doc) => { doc.budget.spent.wall_clock_min = 12; } });
  const opened = readRecords(root, runDir).run.opened;
  assert.equal(opened, '2026-10-26T09:00:01Z');

  const before = state(root, runDir);
  const early = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(0) });
  assert.equal(early.code, EXIT.USAGE);
  assert.match(early.json.errors[0], /the clock reads 2026-10-26T09:00:00Z, before the run opened \(2026-10-26T09:00:01Z\)/);
  assert.deepEqual(state(root, runDir), before, 'a refused close changes nothing');

  const closed = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(396) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const doc = readRecords(root, runDir);
  assert.equal(doc.run.closed, '2026-10-26T09:06:36Z');
  assert.equal(doc.budget.spent.wall_clock_min, 6.6, '395 seconds, to one decimal; never the lead value');
  const report = fs.readFileSync(reportFile(root, runDir), 'utf8');
  assert.match(report, /^\| Open to close \(minutes\) \| – \| 6\.6 \| computed by close \|$/m);
  assert.match(report, /^Open to close is the recorded run interval \(`run\.opened` to `run\.closed`\)\. Session time outside it and money cost are not measured\.$/m);
  assert.match(report, /^No snapshot covers `\.nth-review\/` or the untracked copies of this integration's installed files in the root repository \(`\.claude\/skills\/nth-review\/`, `\.claude\/nth-dev-kit-hooks\/review\.state\.json`\)\. Those copies are not reviewed and cannot be cited\.$/m);

  // Open and close in the same second: 0.
  const instant = reviewedRun(t);
  assert.equal(nthr(['close', '--run', instant.runDir, '--status', 'complete'], { cwd: instant.root, now: at(1) }).code, EXIT.OK);
  assert.equal(readRecords(instant.root, instant.runDir).budget.spent.wall_clock_min, 0);

  // Runs closed before this rule keep their value: check never recomputes it.
  const legacy = structuredClone(doc);
  legacy.budget.spent.wall_clock_min = 12;
  assert.deepEqual(checkRun(root, runDir.slice('.nth-review/'.length), { document: legacy }).errors, []);
});
