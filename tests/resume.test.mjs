// `resume` (M2-T5; decisions C1, C4, C5, C6) through real commands on
// disposable repositories: continue, reassess, the abandon plan, --apply with
// its continuation and debt carry-forward, refusals, and crash recovery.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { resumeRun } from '../scripts/lib/resume.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, nthr, readRecords, recordsFile, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const NS = 'experiments/resume';

function project(t, files = {}) {
  return fs.realpathSync.native(makeRepo(path.join(makeTempDir(t), 'p'), { 'src/a.js': 'a\n', 'src/b.js': 'b\n', ...files }));
}

const ob = (id, status, extra = {}) => ({
  id, checks: ['RESUME'], claim: `${id} claim`, scope: 'scope', acceptance: 'acceptance', coverage: 'named-subset', coverage_method: 'm',
  status, open_reason: null, source_trace: 'consistent', evidence: [{ anchor: 'src/a.js:1', note: 'e' }], intent: [], assumptions: [], links: [],
  ...extra,
});
const finding = (id, obligation, verdict, extra = {}) => ({
  id, fingerprint: `resume/${id}`, kind: 'defect', verdict, severity: null, impact_dimension: 'correctness', obligation,
  summary: `${id} summary`, trace: [{ role: 'sink', anchor: 'src/a.js:1', note: 'the write' }], counterevidence: [], validation_plan: null,
  verification: { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }, decision: 'pending', ...extra,
});

// Opens a run and lets `edit` record a checkpoint (a single held obligation by default).
function openRun(root, slug, second, { ns = NS, mode = 'task', continues = null, base = null, edit } = {}) {
  const args = ['new-run', '--ns', ns, '--mode', mode, '--slug', slug,
    ...(mode === 'task' ? ['--change', '.'] : []), ...(continues ? ['--continues', continues] : []), ...(base ? ['--base', base] : [])];
  const opened = nthr(args, { cwd: root, now: at(second) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.obligations = [ob('OB-1', 'held')];
  edit?.(doc);
  writeRecords(root, runDir, doc);
  return { runDir, id: opened.json.result.run_id };
}
const resume = (root, second, args = [], ns = NS) => nthr(['resume', '--ns', ns, ...args], { cwd: root, now: at(second) });
const check = (root, runDir) => nthr(['check', '--run', runDir], { cwd: root });
const commitChange = (root, rel = 'src/b.js') => {
  write(root, rel, `${rel} changed\n`);
  commitAll(root, 'source change');
};

// Every file under `root`, Git metadata included: path and digest.
function treeState(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .map((file) => `${path.relative(root, file)} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`)
    .sort();
}
function unchanged(root, action) {
  const before = treeState(root);
  const result = action();
  assert.deepEqual(treeState(root), before, 'nothing in the project changed');
  return result;
}

test('lifecycle: new-run, checkpoint, source change, resume plan, --apply, debt carried forward, check on the whole chain', (t) => {
  const root = project(t);
  // P: a closed parent that hands on three debt items.
  const p = openRun(root, 'p', 1, {
    edit: (d) => {
      d.obligations = [ob('OB-1', 'open', { open_reason: 'needs-runtime' })];
      d.debt.out = [
        { id: '20261026-090001-task-p/D1', kind: 'runtime', refs: ['OB-1'], requires: 'a runtime test', priority: 'medium' },
        { id: '20261026-090001-task-p/D2', kind: 'owner-fact', refs: [], requires: 'an owner fact', priority: 'low' },
        { id: '20261026-090001-task-p/D3', kind: 'frontier', refs: [], requires: 'a frontier', priority: 'high' },
      ];
    },
  });
  assert.equal(nthr(['close', '--run', p.runDir, '--status', 'incomplete', '--reason', 'open-obligations'], { cwd: root, now: at(2) }).code, EXIT.OK);
  const pBytes = fs.readFileSync(recordsFile(root, p.runDir));

  // R continues P; a checkpoint with work in every state.
  const D = (n) => `20261026-090001-task-p/D${n}`;
  const r = openRun(root, 'r', 3, {
    continues: p.id,
    edit: (d) => {
      d.obligations = [
        ob('OB-1', 'held'),
        ob('OB-2', 'violated', { links: ['F-1'] }),
        ob('OB-3', 'open', { open_reason: 'needs-owner-fact' }),
        ob('OB-4', 'out-of-scope', { evidence: [] }),
        ob('OB-5', 'open', { open_reason: 'verification', links: ['F-2'] }),
        ob('OB-6', 'violated', { links: ['F-3'] }),
        ob('OB-7', 'accepted'), // a documented, accepted limitation: resolved
      ];
      d.findings = [
        finding('F-1', 'OB-2', 'confirmed', { severity: 'medium', verification: { role: 'R6', model: 'sonnet', outcome: 'confirmed', corrections: null, incomplete: false } }),
        finding('F-2', 'OB-5', 'candidate'),
        finding('F-3', 'OB-6', 'needs_validation', { impact_dimension: 'security', validation_plan: 'run the API against a gateway' }),
      ];
      d.delegations = [{ role: 'R6', agent: 'reviewer', model: 'sonnet', effort: null, budget_calls: 10, tool_uses: 4, tokens: 1000, completed: true, recovery_messages: 0 }];
      d.budget.spent.subagent_calls = 1;
      d.budget.spent.subagent_tokens = 1000;
      d.debt.in = [
        { id: D(1), from_run: p.id, disposition: null, note: null },
        { id: D(2), from_run: p.id, disposition: 'discharged', note: 'the owner confirmed it' },
        { id: D(3), from_run: p.id, disposition: 'carried', note: null },
      ];
      d.debt.out = [
        { id: '20261026-090003-task-r/D1', kind: 'owner-fact', refs: ['OB-3'], requires: 'ask the owner', priority: 'medium' },
        { id: D(3), kind: 'frontier', refs: [], requires: 'a frontier', priority: 'high' },
      ];
    },
  });
  assert.equal(check(root, r.runDir).code, EXIT.OK, JSON.stringify(check(root, r.runDir).json));
  const before = readRecords(root, r.runDir);
  commitChange(root);
  const head = rawGit(root, ['rev-parse', 'HEAD']);
  const index = fs.readFileSync(path.join(root, '.git', 'index'));

  // The plan: exactly what --apply will do; nothing changes.
  const plan = unchanged(root, () => resume(root, 10));
  assert.equal(plan.code, EXIT.OK, JSON.stringify(plan.json));
  const R = (n) => `${r.id}/D${n}`;
  assert.deepEqual(
    { action: plan.json.result.action, applied: plan.json.result.applied, cause: plan.json.result.cause, run: plan.json.result.run, changed: plan.json.result.changed },
    { action: 'abandon', applied: false, cause: 'tracked-changed', run: r.id, changed: { tracked: ['.'], cited: [] } },
  );
  assert.deepEqual(plan.json.result.debt.carried_in, [D(1)]);
  assert.deepEqual(plan.json.result.debt.out, [R(1), D(3), D(1), R(2), R(3), R(4), R(5), R(6)]);
  // C5 as amended: the out-of-scope OB-4 and the accepted OB-7 are resolved, not debt.
  assert.deepEqual(plan.json.result.debt.generated.map((g) => [g.id, g.kind, g.refs, g.priority]), [
    [R(2), 'verification', ['OB-2'], 'high'],
    [R(3), 'verification', ['OB-5'], 'medium'],
    [R(4), 'verification', ['OB-6'], 'high'],
    [R(5), 'verification', ['F-2'], 'medium'],
    [R(6), 'verification', ['F-3'], 'high'],
  ]);
  assert.equal(plan.json.result.debt.generated[0].requires, `OB-2 was violated when ${r.id} was abandoned: re-establish "OB-2 claim" against the current source`);
  assert.equal(plan.json.result.next, `nthr resume --ns ${NS} --apply`);

  // --apply: R abandoned, C opened; nothing else in the project changes.
  const applied = resume(root, 11, ['--apply']);
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  const c = applied.json.result.run;
  assert.equal(c, '20261026-090011-task-r');
  const abandoned = readRecords(root, r.runDir);
  assert.deepEqual(
    [abandoned.run.status, abandoned.run.incomplete_reason, abandoned.run.closed, abandoned.budget.spent.wall_clock_min],
    ['abandoned', 'snapshot-changed', '2026-10-26T09:00:11Z', 0.1],
  );
  assert.match(abandoned.checks.at(-1).command, /^nthr resume: source recheck$/);
  assert.match(abandoned.checks.at(-1).result, /^tracked changed;.*abandoned by resume$/);
  for (const key of ['obligations', 'findings', 'snapshot', 'footprint', 'census', 'scope']) assert.deepEqual(abandoned[key], before[key], key);
  const handedOn = new Set(abandoned.debt.out.flatMap((d) => d.refs));
  assert.ok(!handedOn.has('OB-4') && !handedOn.has('OB-7'), 'accepted and out-of-scope obligations stay history, never debt');
  assert.deepEqual(abandoned.obligations.filter((o) => ['OB-4', 'OB-7'].includes(o.id)).map((o) => o.status), ['out-of-scope', 'accepted']);
  assert.deepEqual(abandoned.debt.in[0], { id: D(1), from_run: p.id, disposition: 'carried', note: 'carried on abandon (resume)' });
  assert.deepEqual(abandoned.debt.out.find((d) => d.id === D(1)), { id: D(1), kind: 'runtime', refs: [], requires: 'a runtime test', priority: 'medium' });
  assert.equal(fs.existsSync(path.join(root, ...r.runDir.split('/'), 'report.md')), false, 'an abandoned run has no report');

  const cDir = `.nth-review/${NS}/runs/${c}`;
  const continuation = readRecords(root, cDir);
  assert.deepEqual([continuation.run.status, continuation.run.continues, continuation.run.base, continuation.run.mode, continuation.run.slug],
    ['open', r.id, null, 'task', 'r']);
  assert.deepEqual(continuation.scope.change, [{ repo: '.', range: null, working_tree: true }]);
  assert.deepEqual(continuation.debt.in, abandoned.debt.out.map((d) => ({ id: d.id, from_run: r.id, disposition: null, note: null })));
  for (const run of [p.runDir, r.runDir, cDir]) assert.equal(check(root, run).code, EXIT.OK, `${run}: ${JSON.stringify(check(root, run).json)}`);
  assert.ok(fs.readFileSync(recordsFile(root, p.runDir)).equals(pBytes), 'a closed run never changes');
  assert.equal(rawGit(root, ['rev-parse', 'HEAD']), head);
  assert.ok(fs.readFileSync(path.join(root, '.git', 'index')).equals(index), 'the Git index is never written');

  // The continuation holds: continue.
  const next = resume(root, 12);
  assert.deepEqual([next.json.result.action, next.json.result.run, next.json.result.reassess], ['continue', c, null]);
});

test('continue writes nothing; untracked or unverified changes ask for reassessment', (t) => {
  const root = project(t);
  write(root, 'keys/dev.pem', 'dummy fixture\n'); // an untracked secret: never hashed
  const r = openRun(root, 'r', 1);
  const same = unchanged(root, () => resume(root, 2));
  assert.deepEqual([same.json.result.action, same.json.result.applied], ['continue', false]);
  assert.deepEqual(same.json.result.reassess, { repos: ['.'], instruction: 'Reassess scope and census for ., then close with --reassessed' }, 'an unhashed untracked file is unverified');
  assert.equal(same.json.result.source.untracked, 'unverified');

  write(root, 'notes.txt', 'an uncited untracked file\n');
  const reassess = unchanged(root, () => resume(root, 3));
  assert.deepEqual([reassess.json.result.action, reassess.json.result.source.untracked, reassess.json.result.reassess.repos], ['continue', 'changed', ['.']]);
  assert.equal(readRecords(root, r.runDir).run.status, 'open');
});

test('a cited untracked file that changed, or vanished, forces abandon; --apply then checks', (t) => {
  for (const variant of ['edited', 'deleted']) {
    const root = project(t);
    write(root, 'src/new.js', 'new\n'); // untracked, and cited
    const r = openRun(root, 'r', 1, { edit: (d) => { d.obligations = [ob('OB-1', 'held', { evidence: [{ anchor: 'src/new.js:1', note: 'e' }] })]; } });
    if (variant === 'edited') write(root, 'src/new.js', 'new and edited\n');
    else fs.rmSync(path.join(root, 'src', 'new.js'));
    const plan = unchanged(root, () => resume(root, 2));
    assert.equal(plan.code, EXIT.OK, JSON.stringify(plan.json));
    assert.deepEqual([plan.json.result.action, plan.json.result.cause, plan.json.result.source.tracked], ['abandon', 'cited-untracked', 'equal']);
    assert.deepEqual(plan.json.result.changed.cited.map((c) => [c.path, c.state]), [['src/new.js', variant === 'edited' ? 'untracked' : 'absent']]);
    // The held OB-1 rested on that file: it is handed on to be re-established.
    assert.deepEqual(plan.json.result.debt.generated.map((g) => [g.kind, g.refs]), [['verification', ['OB-1']]]);
    const applied = resume(root, 3, ['--apply']);
    assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
    assert.match(readRecords(root, r.runDir).checks.at(-1).result, /cited untracked, absent or unverified: src\/new\.js; abandoned by resume$/);
    assert.equal(check(root, r.runDir).code, EXIT.OK);
    assert.equal(check(root, applied.json.result.run_dir).code, EXIT.OK);
  }
});

test('C5 as amended: unverified claims are carried, resolved obligations are not; check makes the carry machine-checkable', (t) => {
  const root = project(t);
  const checkpoint = (d) => {
    d.obligations = [
      ob('OB-1', 'held', { evidence: [{ anchor: 'src/gone.js:1', note: 'e' }] }), // its evidence is absent
      ob('OB-2', 'accepted'),
      ob('OB-3', 'held', { links: ['F-1'] }),
      ob('OB-4', 'out-of-scope', { evidence: [] }),
    ];
    // An incomplete verification leaves a candidate (protocol §7); a doc-drift
    // candidate does not stop OB-3 being held (a defect candidate would).
    d.findings = [finding('F-1', 'OB-3', 'candidate', {
      kind: 'doc-drift',
      verification: { role: 'R6', model: 'sonnet', outcome: null, corrections: null, incomplete: true },
    })];
    d.delegations = [{ role: 'R6', agent: 'reviewer', model: 'sonnet', effort: null, budget_calls: 10, tool_uses: 10, tokens: 900, completed: false, recovery_messages: 1 }];
    d.budget.spent.subagent_calls = 1;
    d.budget.spent.subagent_tokens = 900;
    d.debt.out = [{ id: '20261026-090001-task-r/D1', kind: 'owner-decision', refs: ['OB-2'], requires: 'the owner may revisit the accepted limit', priority: 'low' }];
  };
  const r = openRun(root, 'r', 1, { edit: checkpoint });
  assert.equal(nthr(['footprint', '--run', r.runDir], { cwd: root }).code, EXIT.OK);
  assert.equal(check(root, r.runDir).code, EXIT.OK, JSON.stringify(check(root, r.runDir).json));
  commitChange(root);
  const applied = resume(root, 2, ['--apply']);
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  assert.deepEqual(applied.json.result.debt.generated.map((g) => [g.refs[0], g.kind, g.priority]), [['OB-1', 'verification', 'medium'], ['F-1', 'verification', 'medium']]);
  assert.match(applied.json.result.debt.generated[1].requires, /^verify F-1 /);
  const abandoned = readRecords(root, r.runDir);
  assert.deepEqual(abandoned.debt.out[0].refs, ['OB-2'], "the lead's own debt for an accepted obligation is kept");
  assert.ok(!abandoned.debt.out.some((d) => d.refs.includes('OB-4')));
  assert.equal(check(root, r.runDir).code, EXIT.OK);

  // check: an abandoned run whose carry-required item has no debt fails; resolved items need none.
  const dropped = structuredClone(abandoned);
  dropped.debt.out = dropped.debt.out.filter((d) => !d.refs.includes('OB-1'));
  writeRecords(root, r.runDir, dropped);
  const failed = check(root, r.runDir);
  assert.equal(failed.code, EXIT.INVALID);
  assert.deepEqual(failed.json.errors, ['$.obligations[0]: OB-1 is held on evidence that is unverified or absent in an abandoned run; a debt.out item must refer to it (C5, as amended)']);
  const noFinding = structuredClone(abandoned);
  noFinding.debt.out = noFinding.debt.out.filter((d) => !d.refs.includes('F-1'));
  writeRecords(root, r.runDir, noFinding);
  assert.deepEqual(check(root, r.runDir).json.errors, ['$.findings[0]: F-1 is unverified (candidate, verification incomplete) in an abandoned run; a debt.out item must refer to it (C5, as amended)']);
  const resolvedOnly = structuredClone(abandoned);
  resolvedOnly.debt.out = resolvedOnly.debt.out.filter((d) => !d.refs.includes('OB-2'));
  writeRecords(root, r.runDir, resolvedOnly);
  assert.equal(check(root, r.runDir).code, EXIT.OK, 'accepted and out-of-scope obligations are never required');
  // The rule is for abandoned runs only.
  writeRecords(root, r.runDir, { ...dropped, run: { ...dropped.run, status: 'incomplete', incomplete_reason: 'budget' } });
  assert.ok(!(check(root, r.runDir).json.errors ?? []).some((e) => /abandoned run/.test(e)));
  writeRecords(root, r.runDir, abandoned);
});

test('refusals change nothing: corrupt or conflicting state, invalid parent chains, no open run, the clock', (t) => {
  const refused = (root, pattern, second = 9, args = []) => {
    const r = unchanged(root, () => resume(root, second, args));
    assert.equal(r.code, EXIT.USAGE, JSON.stringify(r.json));
    assert.match(r.json.errors[0], pattern);
  };
  // No open run.
  const empty = project(t);
  refused(empty, /no open run in experiments\/resume/);

  // Two open runs (only a hand edit can make this).
  const two = project(t);
  const first = openRun(two, 'a', 1);
  const copy = readRecords(two, first.runDir);
  copy.run.id = '20261026-090002-task-b';
  copy.run.slug = 'b';
  writeRecords(two, `.nth-review/${NS}/runs/${copy.run.id}`, copy);
  refused(two, /2 runs are open in experiments\/resume \(20261026-090001-task-a, 20261026-090002-task-b\)/, 9, ['--apply']);

  // An unreadable run; records naming another namespace.
  const corrupt = project(t);
  const open = openRun(corrupt, 'a', 1);
  fs.mkdirSync(path.join(corrupt, '.nth-review', 'experiments', 'resume', 'runs', '20261026-090000-task-x'));
  refused(corrupt, /run 20261026-090000-task-x in experiments\/resume cannot be read/);
  fs.rmSync(path.join(corrupt, '.nth-review', 'experiments', 'resume', 'runs', '20261026-090000-task-x'), { recursive: true });
  const foreign = readRecords(corrupt, open.runDir);
  writeRecords(corrupt, open.runDir, { ...foreign, run: { ...foreign.run, namespace: 'experiments/other' } });
  refused(corrupt, /its records name experiments\/other\/20261026-090001-task-a/);
  writeRecords(corrupt, open.runDir, foreign);

  // A parent outside the namespace, and an open base.
  const other = openRun(corrupt, 'z', 2, { ns: 'experiments/other' });
  writeRecords(corrupt, open.runDir, { ...foreign, run: { ...foreign.run, continues: other.id } });
  refused(corrupt, /--continues 20261026-090002-task-z is not a run in experiments\/resume/);
  writeRecords(corrupt, open.runDir, { ...foreign, run: { ...foreign.run, base: foreign.run.id } });
  refused(corrupt, /--base 20261026-090001-task-a is open; it must be complete or incomplete/);
  writeRecords(corrupt, open.runDir, foreign);
  assert.equal(readRecords(corrupt, other.runDir).run.status, 'open', 'the other namespace is untouched');

  // The clock before Open.
  refused(corrupt, /the clock reads 2026-10-26T09:00:00Z, before the run opened/, 0);

  // An open run next to an abandoned run nobody continues; two such runs.
  const pending = project(t);
  const a = openRun(pending, 'a', 1);
  commitChange(pending);
  const half = resumeAbandonOnly(pending, a, 2);
  // new-run now refuses to open a run next to it, so only a hand edit makes this state.
  const b = { ...readRecords(pending, a.runDir), debt: { in: [], out: [] } };
  b.run = { ...b.run, id: '20261026-090003-task-b', slug: 'b', status: 'open', incomplete_reason: null, closed: null, continues: null };
  b.checks = [];
  writeRecords(pending, `.nth-review/${NS}/runs/20261026-090003-task-b`, b);
  refused(pending, /has an open run \(20261026-090003-task-b\) and an abandoned run with no continuation \(20261026-090001-task-a\)/);
  writeRecords(pending, `.nth-review/${NS}/runs/20261026-090003-task-b`, { ...b, run: { ...b.run, status: 'abandoned', incomplete_reason: 'snapshot-changed', closed: b.run.opened } });
  refused(pending, /has 2 abandoned runs with no continuation/);
  assert.ok(half);
});

// Abandons `run` the way an interrupted --apply leaves it: the commit point
// written, the continuation never created.
function resumeAbandonOnly(root, run, second) {
  let calls = 0;
  const rename = (from, to) => {
    calls += 1;
    if (calls === 2) throw new Error('killed before the continuation was written');
    fs.renameSync(from, to);
  };
  assert.throws(() => resumeRun(root, NS, { apply: true, now: at(second), io: { rename } }), /killed before the continuation/);
  assert.equal(readRecords(root, run.runDir).run.status, 'abandoned');
  return true;
}

test('exit 1: records that would fail check as abandoned stop both the plan and --apply; nothing changes', (t) => {
  const root = project(t);
  openRun(root, 'r', 1, { edit: (d) => { d.obligations = [ob('OB-1', 'violated')]; } }); // no linked finding
  commitChange(root);
  for (const args of [[], ['--apply']]) {
    const r = unchanged(root, () => resume(root, 2, args));
    assert.equal(r.code, EXIT.INVALID, JSON.stringify(r.json));
    assert.ok(r.json.errors.some((e) => /violated needs a linked finding/.test(e)), r.json.errors.join('\n'));
  }
});

test('crash recovery: a failed commit point changes nothing; a failure after it is finished by the next resume', (t) => {
  // Killed on the first write: the run is still open and unchanged.
  const early = project(t);
  const r1 = openRun(early, 'r', 1);
  commitChange(early);
  const bytes = fs.readFileSync(recordsFile(early, r1.runDir));
  const fail = () => { throw new Error('killed at the commit point'); };
  assert.throws(() => resumeRun(early, NS, { apply: true, now: at(2), io: { rename: fail } }), /killed at the commit point/);
  assert.ok(fs.readFileSync(recordsFile(early, r1.runDir)).equals(bytes));
  assert.deepEqual(fs.readdirSync(path.join(early, '.nth-review', 'experiments', 'resume', 'runs')), [r1.id]);

  // Killed after it: abandoned, no continuation; resume reports and finishes it.
  const late = project(t);
  const r2 = openRun(late, 'r', 1);
  commitChange(late);
  resumeAbandonOnly(late, r2, 2);
  // A new run cannot leave the abandoned run's work behind.
  const bypass = unchanged(late, () => nthr(['new-run', '--ns', NS, '--mode', 'task', '--slug', 'other', '--change', '.'], { cwd: late, now: at(3) }));
  assert.equal(bypass.code, EXIT.USAGE);
  assert.match(bypass.json.errors[0], new RegExp(`run ${r2.id} in experiments/resume was abandoned, but no run continues it`));
  const plan = unchanged(late, () => resume(late, 3));
  assert.deepEqual([plan.json.result.action, plan.json.result.cause, plan.json.result.applied], ['abandon', 'interrupted', false]);
  const finished = resume(late, 4, ['--apply']);
  assert.equal(finished.code, EXIT.OK, JSON.stringify(finished.json));
  assert.equal(readRecords(late, finished.json.result.run_dir).run.continues, r2.id);
  for (const run of [r2.runDir, finished.json.result.run_dir]) assert.equal(check(late, run).code, EXIT.OK);
  assert.equal(resume(late, 5).json.result.action, 'continue');
});

test('a leftover temporary file: listed by the plan, removed by --apply', (t) => {
  const root = project(t);
  const r = openRun(root, 'r', 1);
  const tmp = path.join(root, ...r.runDir.split('/'), '.records.json.4242.0123456789ab.tmp');
  fs.writeFileSync(tmp, '{"half": ');
  commitChange(root);
  const plan = resume(root, 2);
  assert.equal(plan.code, EXIT.OK, JSON.stringify(plan.json));
  assert.deepEqual(plan.json.result.temporary, [`${r.runDir.slice('.nth-review/'.length)}/.records.json.4242.0123456789ab.tmp`]);
  assert.ok(fs.existsSync(tmp), 'the plan removes nothing');
  const applied = resume(root, 3, ['--apply']);
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  assert.equal(applied.json.result.removed_temporary.length, 1);
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(check(root, r.runDir).code, EXIT.OK);
});

test('an incremental run: the continuation keeps its base and is sized since it; another namespace is untouched', (t) => {
  const root = project(t);
  const base = openRun(root, 'base', 1);
  assert.equal(nthr(['close', '--run', base.runDir, '--status', 'complete'], { cwd: root, now: at(2) }).code, EXIT.OK);
  const elsewhere = openRun(root, 'x', 3, { ns: 'experiments/elsewhere' });
  const elsewhereBytes = fs.readFileSync(recordsFile(root, elsewhere.runDir));
  const inc = openRun(root, 'inc', 4, { mode: 'incremental', base: base.id });
  commitChange(root);
  const applied = resume(root, 5, ['--apply']);
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  const continuation = readRecords(root, applied.json.result.run_dir);
  assert.deepEqual([continuation.run.mode, continuation.run.base, continuation.run.continues], ['incremental', base.id, inc.id]);
  assert.equal(continuation.scope.change[0].range, `${readRecords(root, base.runDir).snapshot.repos[0].head}..${rawGit(root, ['rev-parse', 'HEAD']).trim()}`);
  for (const run of [inc.runDir, applied.json.result.run_dir]) assert.equal(check(root, run).code, EXIT.OK, JSON.stringify(check(root, run).json));
  assert.ok(fs.readFileSync(recordsFile(root, elsewhere.runDir)).equals(elsewhereBytes), 'another namespace never changes');
  assert.equal(nthr(['resume', '--ns', NS, '--apply=false'], { cwd: root, now: at(6) }).json.result.action, 'continue');
});
