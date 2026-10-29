import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { validateRecords } from '../scripts/lib/schema.mjs';
import { takeSnapshot } from '../scripts/lib/snapshot.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, closeRun, nthr, readRecords, recordsFile, writeCharter, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit, runNthr } from './helpers/tmp.mjs';

// A repository whose last commit changes `files` files of `lines` lines each.
function project(t, { files = 2, lines = 5 } = {}) {
  const root = makeRepo(makeTempDir(t), { 'README.md': 'base\n' });
  for (let i = 0; i < files; i += 1) write(root, `src/f${i}.js`, Array.from({ length: lines }, (_, n) => `line ${n}`).join('\n') + '\n');
  commitAll(root, 'change');
  return fs.realpathSync.native(root);
}

const open = (root, args, options = {}) => nthr(['new-run', ...args], { cwd: root, now: at(0), ...options });
const refused = (r, pattern) => {
  assert.equal(r.code, EXIT.USAGE, JSON.stringify(r.json));
  assert.equal(r.json.ok, false);
  if (pattern) assert.match(r.json.errors[0], pattern);
};

test('opens a task run: exclusive directory, a valid open skeleton that passes check', (t) => {
  const root = project(t, { files: 2, lines: 5 });
  const r = open(root, ['--ns', 'experiments/demo', '--mode', 'task', '--slug', 'login', '--change', '.:HEAD~1..HEAD'], { now: new Date('2026-10-26T09:30:15.123Z') });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const result = r.json.result;
  assert.equal(result.run_id, '20261026-093015-task-login');
  assert.equal(result.run_dir, '.nth-review/experiments/demo/runs/20261026-093015-task-login');
  assert.deepEqual(result.size, { class: 'S', files: 2, lines: 10, verified: true });
  assert.equal(result.required_lead_model, 'sonnet');
  assert.deepEqual(result.triggers, []);
  assert.deepEqual(result.budget, {
    lead_tool_calls: 40, subagent_calls: 3, obligations_max: 15, reserve_pct: 30,
    spent: { lead_tool_calls: 0, subagent_calls: 0, subagent_tokens: 0, lead_tokens_observed: null, wall_clock_min: 0 },
  });

  const bytes = fs.readFileSync(recordsFile(root, result.run_dir));
  assert.notEqual(bytes[0], 0xef, 'no byte-order mark');
  assert.ok(bytes.toString('utf8').endsWith('}\n'));
  assert.deepEqual(validateRecords(bytes), []);
  const doc = JSON.parse(bytes);
  assert.equal(doc.run.status, 'open');
  assert.equal(doc.run.opened, '2026-10-26T09:30:15Z');
  assert.deepEqual(doc.scope.change, [{ repo: '.', range: 'HEAD~1..HEAD', working_tree: false }]);
  assert.deepEqual(doc.debt, { in: [], out: [] });
  // The snapshot is the project's, and the new .nth-review/ does not move it.
  assert.equal(doc.snapshot.tracked_key, takeSnapshot(root).tracked_key);
  assert.equal(doc.snapshot.untracked_key, takeSnapshot(root).untracked_key);

  const check = nthr(['check', '--run', result.run_dir], { cwd: root });
  assert.equal(check.code, EXIT.OK, JSON.stringify(check.json));
});

test('T7: the size row comes from git diff --numstat', (t) => {
  const cases = [
    [{ files: 1, lines: 400 }, 'S', 40, 'sonnet', []],
    [{ files: 1, lines: 401 }, 'M', 70, 'opus-high', ['task-size']],
    [{ files: 16, lines: 1 }, 'M', 70, 'opus-high', ['task-size']],
    [{ files: 1, lines: 1501 }, 'L', 70, 'opus-high', ['task-size']],
  ];
  for (const [shape, size, lead, model, triggers] of cases) {
    const root = project(t, shape);
    const r = open(root, ['--ns', 'experiments/t7', '--mode', 'task', '--slug', 's', '--change', '.:HEAD~1..HEAD']);
    assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
    assert.deepEqual(r.json.result.size, { class: size, files: shape.files, lines: shape.files * shape.lines, verified: true }, JSON.stringify(shape));
    assert.equal(r.json.result.budget.lead_tool_calls, lead);
    assert.equal(r.json.result.required_lead_model, model);
    assert.deepEqual(readRecords(root, r.json.result.run_dir).run.runtime.triggers, triggers);
  }
  // A working-tree change counts staged, unstaged and untracked files. The
  // untracked files' lines are not counted, so the size is never small.
  const root = project(t, { files: 1, lines: 1 });
  write(root, 'src/f0.js', 'a\nb\n');
  write(root, 'staged.js', 'x\n');
  rawGit(root, ['add', 'staged.js']);
  write(root, 'untracked.js', 'u\n');
  const wt = open(root, ['--ns', 'experiments/wt', '--mode', 'task', '--slug', 's', '--change', '.']);
  assert.equal(wt.code, EXIT.OK, JSON.stringify(wt.json));
  assert.deepEqual(wt.json.result.size, { class: 'unverified', files: 3, lines: 3 + 1, verified: false });
  assert.equal(wt.json.result.required_lead_model, 'opus-high');
  assert.deepEqual(readRecords(root, wt.json.result.run_dir).scope.change, [{ repo: '.', range: null, working_tree: true }]);
});

test('T4: audits/ is refused while official audits are disabled, and without a valid charter', (t) => {
  const root = project(t);
  const charter = path.join(root, '.nth-review', 'audits', 'core', 'charter.json');
  const args = ['--ns', 'audits/core', '--mode', 'audit-plan', '--slug', 'plan'];
  fs.mkdirSync(path.dirname(charter), { recursive: true });
  writeCharter(root);
  refused(open(root, args), /OFFICIAL_AUDITS_ENABLED is false/);
  fs.rmSync(charter);
  refused(open(root, args, { official: true }), /no charter\.json/);
  fs.writeFileSync(charter, JSON.stringify({ official: false }));
  refused(open(root, args, { official: true }), /"official": true/);
  // A partial or hand-made charter is not the owner's authorization.
  fs.writeFileSync(charter, JSON.stringify({ official: true, owner: 'owner', scope: 'all' }));
  refused(open(root, args, { official: true }), /charter\.json is not a complete owner charter/);
  writeCharter(root, 'audits/core', { exclusions: '' });
  refused(open(root, args, { official: true }), /not a complete owner charter \(\$\.exclusions/);
  writeCharter(root, 'audits/core', { namespace: 'audits/other' });
  refused(open(root, args, { official: true }), /charter\.json names audits\/other, not audits\/core/);
  assert.ok(!fs.existsSync(path.join(root, '.nth-review', 'audits', 'core', 'runs')), 'refusals leave nothing behind');

  writeCharter(root, 'audits/core', { profile: 'deep' });
  const ok = open(root, args, { official: true });
  assert.equal(ok.code, EXIT.OK, JSON.stringify(ok.json));
  assert.equal(ok.json.result.required_lead_model, 'opus-high');
  assert.equal(ok.json.result.budget.lead_tool_calls, 50);
  assert.equal(readRecords(root, ok.json.result.run_dir).run.profile, 'deep');

  // Mode and namespace kind must agree.
  refused(open(root, ['--ns', 'reviews/x', '--mode', 'audit-plan', '--slug', 'p']), /not allowed in reviews\/x/);
  refused(open(root, ['--ns', 'audits/core', '--mode', 'task', '--slug', 'p'], { official: true }), /not allowed/);
});

test('T5: bases must be closed runs of the same namespace; legacy runs/ is never one', (t) => {
  const root = project(t);
  const first = open(root, ['--ns', 'experiments/demo', '--mode', 'task', '--slug', 'first', '--change', '.'], { now: at(1) });
  assert.equal(first.code, EXIT.OK);
  const baseId = first.json.result.run_id;
  const inc = (base, extra = []) => open(root, ['--ns', 'experiments/demo', '--mode', 'incremental', '--slug', 'next', '--base', base, ...extra], { now: at(2) });

  refused(inc(baseId), /still open/); // an open base: the namespace's open run blocks it
  closeRun(root, first.json.result.run_dir);

  refused(inc(`experiments/demo/runs/${baseId}`), /must be a run id/);
  refused(inc('20261026-090001-task-missing'), /not a run in experiments\/demo/);
  const other = open(root, ['--ns', 'experiments/other', '--mode', 'task', '--slug', 'elsewhere', '--change', '.'], { now: at(3) });
  closeRun(root, other.json.result.run_dir);
  refused(inc(other.json.result.run_id), /same namespace/);
  // A Pilot-1 style legacy run at .nth-review/runs/<id>.
  writeRecords(root, '.nth-review/runs/20261020-100000-task-legacy', readRecords(root, first.json.result.run_dir));
  refused(inc('20261020-100000-task-legacy'), /legacy top-level runs\/ is never one/);
  refused(open(root, ['--ns', 'experiments/demo', '--mode', 'incremental', '--slug', 'next']), /--base is required/);

  const abandoned = open(root, ['--ns', 'experiments/demo', '--mode', 'task', '--slug', 'gone', '--change', '.'], { now: at(4) });
  closeRun(root, abandoned.json.result.run_dir, { status: 'abandoned', reason: 'snapshot-changed' });
  refused(inc(abandoned.json.result.run_id), /is abandoned; it must be complete or incomplete/);
  const continued = open(root, ['--ns', 'experiments/demo', '--mode', 'task', '--slug', 'again', '--change', '.', '--continues', abandoned.json.result.run_id], { now: at(5) });
  assert.equal(continued.code, EXIT.OK, JSON.stringify(continued.json));

  // A base that fails structure validation is refused.
  closeRun(root, continued.json.result.run_dir);
  const broken = readRecords(root, continued.json.result.run_dir);
  broken.obligations = 'not a list';
  writeRecords(root, continued.json.result.run_dir, broken);
  refused(inc(baseId), /cannot be read/);
});

test('T6: an open run in the namespace is refused with resume instructions; other namespaces are independent', (t) => {
  const root = project(t);
  assert.equal(open(root, ['--ns', 'reviews/main', '--mode', 'task', '--slug', 'a', '--change', '.'], { now: at(1) }).code, EXIT.OK);
  refused(open(root, ['--ns', 'reviews/main', '--mode', 'task', '--slug', 'b', '--change', '.'], { now: at(2) }), /nthr resume --ns reviews\/main/);
  assert.equal(open(root, ['--ns', 'reviews/other', '--mode', 'task', '--slug', 'b', '--change', '.'], { now: at(2) }).code, EXIT.OK);
});

test('T8: debt-in is the complete debt-out of the immediate parent, dispositions empty', (t) => {
  const root = project(t);
  const base = open(root, ['--ns', 'experiments/debt', '--mode', 'task', '--slug', 'base', '--change', '.'], { now: at(1) });
  const baseId = base.json.result.run_id;
  const debt = (id, n) => ({ id: `${id}/D${n}`, kind: 'runtime', refs: [], requires: `item ${n}`, priority: 'medium' });
  closeRun(root, base.json.result.run_dir, { edit: (doc) => { doc.debt.out = [debt(baseId, 1), debt(baseId, 2)]; } });

  const next = open(root, ['--ns', 'experiments/debt', '--mode', 'incremental', '--slug', 'next', '--base', baseId], { now: at(2) });
  assert.equal(next.code, EXIT.OK, JSON.stringify(next.json));
  assert.equal(next.json.result.debt_in, 2);
  const nextDoc = readRecords(root, next.json.result.run_dir);
  assert.deepEqual(nextDoc.debt.in, [
    { id: `${baseId}/D1`, from_run: baseId, disposition: null, note: null },
    { id: `${baseId}/D2`, from_run: baseId, disposition: null, note: null },
  ]);

  // With continues, the debt comes from that run, not from the base.
  const nextId = next.json.result.run_id;
  closeRun(root, next.json.result.run_dir, {
    status: 'incomplete',
    reason: 'budget',
    edit: (doc) => { doc.debt.out = [debt(baseId, 2), debt(nextId, 1)]; doc.debt.in[0].disposition = 'discharged'; doc.debt.in[0].note = 'fixed'; },
  });
  const cont = open(root, ['--ns', 'experiments/debt', '--mode', 'incremental', '--slug', 'cont', '--base', baseId, '--continues', nextId], { now: at(3) });
  assert.equal(cont.code, EXIT.OK, JSON.stringify(cont.json));
  assert.deepEqual(readRecords(root, cont.json.result.run_dir).debt.in.map((d) => [d.id, d.from_run]), [
    [`${baseId}/D2`, nextId],
    [`${nextId}/D1`, nextId],
  ]);
});

test('incremental budget: 20 + 2 per changed file + 3 per debt-in item, capped at 80', (t) => {
  const root = project(t, { files: 1, lines: 1 });
  const base = open(root, ['--ns', 'experiments/inc', '--mode', 'task', '--slug', 'base', '--change', '.'], { now: at(1) });
  const baseId = base.json.result.run_id;
  closeRun(root, base.json.result.run_dir, {
    edit: (doc) => { doc.debt.out = [{ id: `${baseId}/D1`, kind: 'runtime', refs: [], requires: 'x', priority: 'low' }]; },
  });
  for (let i = 0; i < 3; i += 1) write(root, `src/new${i}.js`, `${i}\n`);
  commitAll(root, 'three files'); // also commits .nth-review/, which sizing must ignore
  write(root, 'src/f0.js', 'edited\n'); // one more, uncommitted
  const r = open(root, ['--ns', 'experiments/inc', '--mode', 'incremental', '--slug', 'next', '--base', baseId], { now: at(2) });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  assert.equal(r.json.result.size.files, 4);
  assert.equal(r.json.result.budget.lead_tool_calls, 20 + 2 * 4 + 3 * 1);
  assert.equal(r.json.result.required_lead_model, 'opus-high');
  const doc = readRecords(root, r.json.result.run_dir);
  const baseHead = readRecords(root, base.json.result.run_dir).snapshot.repos[0].head;
  assert.deepEqual(doc.scope.change, [{ repo: '.', range: `${baseHead}..${doc.snapshot.repos[0].head}`, working_tree: true }]);

  // When the base commit is gone, the size is unknown and the budget is the cap.
  const root2 = project(t, { files: 1, lines: 1 });
  const b2 = open(root2, ['--ns', 'experiments/inc', '--mode', 'task', '--slug', 'base', '--change', '.'], { now: at(1) });
  closeRun(root2, b2.json.result.run_dir, { edit: (d) => { d.snapshot.repos[0].head = '0'.repeat(40); } });
  const r2 = open(root2, ['--ns', 'experiments/inc', '--mode', 'incremental', '--slug', 'next', '--base', b2.json.result.run_id], { now: at(2) });
  assert.equal(r2.code, EXIT.OK, JSON.stringify(r2.json));
  assert.deepEqual(r2.json.result.size, { class: null, files: null, lines: null, verified: false });
  assert.equal(r2.json.result.budget.lead_tool_calls, 80);
});

test('the integration\'s untracked installed files never size a task or an incremental change', (t) => {
  const root = project(t, { files: 1, lines: 1 });
  const base = open(root, ['--ns', 'experiments/int', '--mode', 'task', '--slug', 'base', '--change', '.'], { now: at(1) });
  assert.equal(base.code, EXIT.OK, JSON.stringify(base.json));
  closeRun(root, base.json.result.run_dir);
  write(root, '.claude/skills/nth-review/SKILL.md', 'skill\n');
  write(root, '.claude/skills/nth-review/reference/protocol.md', 'protocol\n');
  write(root, '.claude/nth-dev-kit-hooks/review.state.json', '{}\n');

  const wt = open(root, ['--ns', 'experiments/int-wt', '--mode', 'task', '--slug', 's', '--change', '.'], { now: at(2) });
  assert.equal(wt.code, EXIT.OK, JSON.stringify(wt.json));
  assert.deepEqual(wt.json.result.size, { class: 'S', files: 0, lines: 0, verified: true });

  const inc = open(root, ['--ns', 'experiments/int', '--mode', 'incremental', '--slug', 'next', '--base', base.json.result.run_id], { now: at(3) });
  assert.equal(inc.code, EXIT.OK, JSON.stringify(inc.json));
  assert.equal(inc.json.result.size.files, 0);
  assert.equal(inc.json.result.budget.lead_tool_calls, 20);
});

test('a run-id collision is refused and changes nothing', (t) => {
  const root = project(t);
  const first = open(root, ['--ns', 'experiments/c', '--mode', 'task', '--slug', 'same', '--change', '.'], { now: at(7) });
  closeRun(root, first.json.result.run_dir);
  const before = fs.readFileSync(recordsFile(root, first.json.result.run_dir));
  refused(open(root, ['--ns', 'experiments/c', '--mode', 'task', '--slug', 'same', '--change', '.'], { now: at(7) }), /already exists/);
  assert.ok(fs.readFileSync(recordsFile(root, first.json.result.run_dir)).equals(before));
});

test('argument refusals: changes, ranges, slug, unit, namespace; nothing is created', (t) => {
  const root = project(t);
  makeRepo(path.join(root, 'api'), { 'a.js': '1\n' });
  write(root, 'api/a.js', '2\n');
  commitAll(path.join(root, 'api'), 'api change');
  const base = ['--ns', 'experiments/args', '--mode', 'task', '--slug', 'x'];
  for (const [args, pattern] of [
    [[...base, '--change', 'web'], /unknown repository "web"/],
    [[...base, '--change', 'api:HEAD~1..'], /must be <a>\.\.<b>/],
    [[...base, '--change', 'api:HEAD~1...HEAD'], /must be <a>\.\.<b>/],
    [[...base, '--change', 'api:-x..HEAD'], /must be <a>\.\.<b>/],
    [[...base, '--change', 'api:nope..HEAD'], /nope is not a commit in api/],
    [[...base, '--change', 'api', '--change', 'api'], /given twice/],
    [['--ns', 'experiments/args', '--mode', 'task', '--slug', 'Bad_Slug'], /--slug/],
    [['--ns', 'experiments/args', '--mode', 'task', '--slug', 'x', '--unit', 'U-1'], /only for audit-unit/],
    [['--ns', 'experiments/args', '--mode', 'review', '--slug', 'x'], /--mode must be one of/],
    [['--ns', 'Experiments/args', '--mode', 'task', '--slug', 'x'], /namespace/],
    [['--ns', '../escape', '--mode', 'task', '--slug', 'x'], /namespace/],
    [['--mode', 'task', '--slug', 'x'], /--ns is required/],
  ]) refused(open(root, args), pattern);
  assert.ok(!fs.existsSync(path.join(root, '.nth-review')), 'no refusal created .nth-review/');
  const nested = open(root, [...base, '--change', 'api:HEAD~1..HEAD']);
  assert.equal(nested.code, EXIT.OK, JSON.stringify(nested.json));
  assert.deepEqual(nested.json.result.size, { class: 'S', files: 1, lines: 2, verified: true });
});

test('audit-unit: needs an audit base and a unit of its ledger; the ledger is carried (C20)', (t) => {
  const root = project(t);
  writeCharter(root);
  const plan = open(root, ['--ns', 'audits/core', '--mode', 'audit-plan', '--slug', 'plan'], { now: at(1), official: true });
  assert.equal(plan.code, EXIT.OK, JSON.stringify(plan.json));
  const units = [{ id: 'U-01', title: 'Ledger', tier: 1, status: 'planned', depends_on: [], runs: [], reason: null, scope: 'the ledger', basis: [{ anchor: 'docs/ledger.md#Balances', note: 'balances move money' }] }];
  closeRun(root, plan.json.result.run_dir, { edit: (doc) => { doc.scope.units = units; } });
  const unitArgs = (unit) => ['--ns', 'audits/core', '--mode', 'audit-unit', '--slug', 'u1', '--base', plan.json.result.run_id, '--unit', unit];
  refused(open(root, unitArgs('U-99'), { now: at(2), official: true }), /not in the units ledger/);
  refused(open(root, ['--ns', 'audits/core', '--mode', 'audit-unit', '--slug', 'u1'], { now: at(2), official: true }), /--unit is required/);
  const unit = open(root, unitArgs('U-01'), { now: at(2), official: true });
  assert.equal(unit.code, EXIT.OK, JSON.stringify(unit.json));
  const doc = readRecords(root, unit.json.result.run_dir);
  assert.equal(doc.run.unit, 'U-01');
  assert.deepEqual(doc.scope.units, units);
  assert.equal(doc.budget.lead_tool_calls, 60);
});

test('launched as a process: the entry keeps official audits disabled', (t) => {
  const root = project(t);
  const charter = path.join(root, '.nth-review', 'audits', 'core', 'charter.json');
  fs.mkdirSync(path.dirname(charter), { recursive: true });
  fs.writeFileSync(charter, JSON.stringify({ official: true }));
  const audit = runNthr(['new-run', '--ns', 'audits/core', '--mode', 'audit-plan', '--slug', 'p'], { cwd: root });
  assert.equal(audit.code, EXIT.USAGE, audit.stdout);
  assert.match(audit.json.errors[0], /OFFICIAL_AUDITS_ENABLED is false/);
  const ok = runNthr(['new-run', '--ns=experiments/proc', '--mode=task', '--slug=p', '--change', '.:HEAD~1..HEAD'], { cwd: root });
  assert.equal(ok.code, EXIT.OK, ok.stdout + ok.stderr);
  const check = runNthr(['check', '--run', ok.json.result.run_dir.replaceAll('/', path.sep)], { cwd: root });
  assert.equal(check.code, EXIT.OK, check.stdout + check.stderr);
});

test('review fixes: task runs need --change; a file named HEAD; unborn sizing adds staged and unstaged lines', (t) => {
  const root = project(t);
  refused(open(root, ['--ns', 'experiments/fix', '--mode', 'task', '--slug', 'x']), /a task run needs --change/);
  write(root, 'HEAD', 'a file named like a revision\n');
  const named = open(root, ['--ns', 'experiments/fix', '--mode', 'task', '--slug', 'x', '--change', '.:HEAD~1..HEAD', '--change', '.']);
  assert.equal(named.code, EXIT.OK, JSON.stringify(named.json));

  const fresh = fs.realpathSync.native(makeRepo(makeTempDir(t), {}));
  write(fresh, 'a.js', Array.from({ length: 300 }, (_, i) => `${i}`).join('\n') + '\n');
  rawGit(fresh, ['add', 'a.js']);
  write(fresh, 'a.js', Array.from({ length: 301 }, (_, i) => `${i}`).join('\n') + '\n'); // staged 300 + unstaged 1
  const unborn = open(fresh, ['--ns', 'experiments/fix', '--mode', 'task', '--slug', 'x', '--change', '.']);
  assert.equal(unborn.code, EXIT.OK, JSON.stringify(unborn.json));
  assert.deepEqual(unborn.json.result.size, { class: 'S', files: 1, lines: 301, verified: true });
});

// Owner decision 2026-10-26: edits to assume-unchanged or skip-worktree files
// are invisible to git diff, so a working-tree size there is never small.
test('hidden changes: a flagged file in the working tree makes a working-tree size unverified, never small', (t) => {
  const flaggedProject = (flag) => {
    const root = fs.realpathSync.native(makeRepo(path.join(makeTempDir(t), 'p'), { 'a.js': 'a\n', 'hidden.js': 'hidden\n', 'sparse.js': 's\n' }));
    if (flag) rawGit(root, ['update-index', `--${flag}`, 'hidden.js']);
    return root;
  };

  // Incremental: assume-unchanged edit, skip-worktree edit, missing file.
  for (const [flag, act] of [
    ['assume-unchanged', (root) => write(root, 'hidden.js', 'hidden edit\n')],
    ['skip-worktree', (root) => write(root, 'hidden.js', 'hidden edit\n')],
    ['assume-unchanged', (root) => fs.rmSync(path.join(root, 'hidden.js'))],
  ]) {
    const root = flaggedProject(null);
    const base = open(root, ['--ns', 'experiments/h', '--mode', 'task', '--slug', 'b', '--change', '.'], { now: at(1) });
    closeRun(root, base.json.result.run_dir);
    rawGit(root, ['update-index', `--${flag}`, 'hidden.js']);
    act(root);
    assert.equal(rawGit(root, ['status', '--porcelain', '--', 'hidden.js']).trim(), '', 'control: git status sees nothing');
    const inc = open(root, ['--ns', 'experiments/h', '--mode', 'incremental', '--slug', 'i', '--base', base.json.result.run_id], { now: at(2) });
    assert.equal(inc.code, EXIT.OK, JSON.stringify(inc.json));
    assert.deepEqual([inc.json.result.size.verified, inc.json.result.budget.lead_tool_calls, inc.json.result.required_lead_model], [false, 80, 'opus-high'], flag);
  }

  // A sparse skip-worktree file (absent by design) does not make the size uncertain.
  const sparse = flaggedProject(null);
  const sparseBase = open(sparse, ['--ns', 'experiments/h', '--mode', 'task', '--slug', 'b', '--change', '.'], { now: at(1) });
  closeRun(sparse, sparseBase.json.result.run_dir);
  rawGit(sparse, ['update-index', '--skip-worktree', 'sparse.js']);
  fs.rmSync(path.join(sparse, 'sparse.js'));
  const sparseInc = open(sparse, ['--ns', 'experiments/h', '--mode', 'incremental', '--slug', 'i', '--base', sparseBase.json.result.run_id], { now: at(2) });
  assert.deepEqual([sparseInc.json.result.size.verified, sparseInc.json.result.budget.lead_tool_calls], [true, 20]);

  // Task, working tree: a small visible edit plus a flagged file is unverified (M budget, Opus High), not S.
  const task = flaggedProject('assume-unchanged');
  write(task, 'hidden.js', 'hidden edit\n');
  write(task, 'a.js', 'a visible edit\n');
  const sized = open(task, ['--ns', 'experiments/t', '--mode', 'task', '--slug', 't', '--change', '.'], { now: at(1) });
  assert.equal(sized.code, EXIT.OK, JSON.stringify(sized.json));
  assert.deepEqual(
    [sized.json.result.size.class, sized.json.result.size.verified, sized.json.result.budget.lead_tool_calls, sized.json.result.budget.subagent_calls, sized.json.result.budget.obligations_max, sized.json.result.required_lead_model, sized.json.result.triggers],
    ['unverified', false, 70, 5, 30, 'opus-high', ['task-size']],
  );

  // A committed range is exact, whatever is flagged in the working tree.
  const ranged = flaggedProject(null);
  write(ranged, 'a.js', 'a committed edit\n');
  commitAll(ranged, 'edit');
  rawGit(ranged, ['update-index', '--assume-unchanged', 'hidden.js']);
  write(ranged, 'hidden.js', 'hidden edit\n');
  const exact = open(ranged, ['--ns', 'experiments/r', '--mode', 'task', '--slug', 'r', '--change', '.:HEAD~1..HEAD'], { now: at(1) });
  assert.equal(exact.code, EXIT.OK, JSON.stringify(exact.json));
  assert.deepEqual([exact.json.result.size.class, exact.json.result.size.verified, exact.json.result.required_lead_model], ['S', true, 'sonnet']);
});
