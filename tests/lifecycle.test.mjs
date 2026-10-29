// End-to-end lifecycles through the CLI only (new-run, apply, pack, footprint,
// fresh, check, close, status), as the skill drives them: no record is written
// directly. Disposable synthetic repositories. Also: the boundary test on four
// security cases, at the record and pack level (model judgment needs a live run).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, nthr, readRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const lines = (...l) => `${l.join('\n')}\n`;
const NS = 'reviews/payments';

// Opens a run and returns a handle that writes patches and applies them.
function opened(root, args, now) {
  const r = nthr(['new-run', '--ns', NS, ...args], { cwd: root, now });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  return { root, runDir: r.json.result.run_dir, id: r.json.result.run_id, sha: r.json.result.records_sha256, result: r.json.result };
}
function apply(run, ops) {
  fs.writeFileSync(path.join(run.root, ...run.runDir.split('/'), 'patch.json'), JSON.stringify({ schema: 'nth-review/patch@1', base: run.sha, ops }));
  const r = nthr(['apply', '--run', run.runDir], { cwd: run.root });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  run.sha = r.json.result.records_sha256;
  return r.json.result.check;
}
const helper = (run, args, now) => nthr([...args, '--run', run.runDir], { cwd: run.root, now });
const report = (run) => fs.readFileSync(path.join(run.root, ...run.runDir.split('/'), 'report.md'), 'utf8');
const add = (p, value) => ({ op: 'add', path: p, value });
const set = (p, value) => ({ op: 'set', path: p, value });
const ob = (id, checks, claim, extra = {}) => ({
  id, checks, claim, scope: 'payments', acceptance: `${claim} (acceptance)`, coverage: 'named-subset', coverage_method: 'read the cited lines',
  status: 'open', open_reason: 'frontier', source_trace: 'not-traced', evidence: [], intent: ['I1'], assumptions: [], links: [], ...extra,
});

// The project's own files and Git state: what the helper must never change.
function projectState(root) {
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('.git/') && !rel.startsWith('.nth-review/'))
    .sort()
    .map((rel) => `${rel} ${createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')}`);
  const status = rawGit(root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l && !l.startsWith('?? .nth-review/'));
  return { files, head: rawGit(root, ['rev-parse', 'HEAD']).trim(), status };
}

const TRANSFER = lines(
  "import { move } from './ledger.js';",
  '',
  'export function transfer(user, from, to, amount) {',
  "  if (!user.accounts.includes(from)) throw new Error('forbidden');",
  "  if (!(amount > 0)) throw new Error('invalid amount');",
  '  return move(from, to, amount);',
  '}',
  '',
  '// Callers log each transfer.',
  '// Limits per account are configured elsewhere.',
);
const LEDGER = lines(
  'const balances = new Map();',
  '',
  'export function move(from, to, amount) {',
  '  balances.set(from, (balances.get(from) ?? 0) - amount);',
  '  balances.set(to, (balances.get(to) ?? 0) + amount);',
  '  return balances.get(from);',
  '}',
);
const REPORT = lines('export function total(rows) {', '  return rows.reduce((sum, r) => sum + r.amount, 0);', '}');
const RULES = lines('# Rules', '', '## Transfers', '', 'Only the owner of the source account may transfer. A transfer never overdraws the source account.');

test('lifecycle: a Task Review, a source change, then an Incremental Review that revalidates, carries debt and closes honestly', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { 'README.md': 'payments\n' }));
  write(root, 'api/transfer.js', TRANSFER);
  write(root, 'api/ledger.js', LEDGER);
  write(root, 'api/report.js', REPORT);
  write(root, 'docs/rules.md', RULES);
  commitAll(root, 'transfers');
  const before = projectState(root);

  // ---------------------------------------------------------------- Task Review
  const task = opened(root, ['--mode', 'task', '--slug', 'transfers', '--change', '.:HEAD~1..HEAD'], at(1));
  assert.equal(task.result.size.class, 'S');
  let check = apply(task, [
    set('/run/runtime/lead_model', 'claude-opus-5-5'),
    set('/run/runtime/lead_effort', 'high'),
    set('/run/runtime/triggers', ['money']),
    set('/run/runtime/required_lead_model', 'opus-high'),
    set('/scope/summary', 'Transfers and the ledger. Not applicable: UI, PERF, SUPPLY.'),
    add('/scope/intent', { id: 'I1', anchor: 'docs/rules.md#Transfers', note: 'ownership and no overdraft' }),
    add('/census/items', { id: 'CI-1', path: 'api/transfer.js', mechanism: 'transfer entry', status: 'classified', reason: null, affects: ['OB-1'] }),
    add('/census/items', { id: 'CI-2', path: 'api/ledger.js', mechanism: 'ledger write', status: 'classified', reason: null, affects: ['OB-2', 'OB-4'] }),
    add('/census/items', { id: 'CI-3', path: 'docs/rules.md', mechanism: 'intent document', status: 'classified', reason: 'documentation only', affects: null }),
    add('/census/items', { id: 'CI-4', path: 'api/report.js', mechanism: 'report totals', status: 'classified', reason: null, affects: ['OB-3'] }),
    add('/obligations', ob('OB-1', ['AUTHZ.1'], 'Only the owner of the source account may transfer')),
    add('/obligations', ob('OB-2', ['LEDGER'], 'A transfer never overdraws the source account')),
    add('/obligations', ob('OB-3', ['LOGIC.1'], 'Totals add every amount')),
    add('/obligations', ob('OB-4', ['ATOMIC.1'], 'Concurrent transfers keep balances consistent')),
  ]);
  assert.equal(check.valid, true, check.errors.join('\n'));
  // Plan-critique, then discharge: one candidate defect.
  check = apply(task, [
    add('/delegations', { role: 'R3', agent: 'Explore', model: 'sonnet', effort: null, budget_calls: 30, tool_uses: 6, tokens: 1000, completed: true, recovery_messages: 0, discovered: ['api/report.js'] }),
    set('/budget/spent/subagent_calls', 1), set('/budget/spent/subagent_tokens', 1000),
    set('/obligations/OB-1/status', 'held'), set('/obligations/OB-1/open_reason', null), set('/obligations/OB-1/source_trace', 'consistent'),
    set('/obligations/OB-1/evidence', [{ anchor: 'api/transfer.js:4', note: 'the owner check precedes the move' }]),
    set('/obligations/OB-3/status', 'held'), set('/obligations/OB-3/open_reason', null), set('/obligations/OB-3/source_trace', 'consistent'),
    set('/obligations/OB-3/evidence', [{ anchor: 'api/report.js:1-3', note: 'sums every row' }]),
    set('/obligations/OB-4/open_reason', 'needs-runtime'), set('/obligations/OB-4/source_trace', 'consistent'),
    set('/obligations/OB-2/open_reason', 'verification'), set('/obligations/OB-2/source_trace', 'consistent'), add('/obligations/OB-2/links', 'F-1'),
    add('/findings', {
      id: 'F-1', fingerprint: 'payments/ledger/overdraft', kind: 'defect', verdict: 'candidate', severity: null, impact_dimension: 'financial',
      obligation: 'OB-2', summary: 'move() subtracts without checking the balance, so a transfer can overdraw the source account.',
      trace: [
        { role: 'entrypoint', anchor: 'api/transfer.js:3', note: 'transfer' },
        { role: 'propagation', anchor: 'api/transfer.js:6', note: 'calls move' },
        { role: 'sink', anchor: 'api/ledger.js:4', note: 'unchecked subtraction' },
      ],
      counterevidence: [], validation_plan: null,
      verification: { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }, decision: 'pending',
    }),
  ]);
  assert.equal(check.valid, true, check.errors.join('\n'));
  // Verify: the pack shows the claim and evidence, never a verdict.
  assert.equal(helper(task, ['pack', '--for', 'F-1']).code, EXIT.OK);
  const pack = fs.readFileSync(path.join(root, ...task.runDir.split('/'), 'packs', 'F-1.md'), 'utf8');
  assert.match(pack, /api\/ledger\.js:4/);
  assert.doesNotMatch(pack, /candidate|confirmed|Boundary test/, 'no verdict; a financial correctness finding gets no boundary test');
  check = apply(task, [
    add('/delegations', { role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: 5, tokens: 2000, completed: true, recovery_messages: 0 }),
    set('/findings/F-1/verdict', 'confirmed'), set('/findings/F-1/severity', 'medium'),
    set('/findings/F-1/verification', { role: 'R5', model: 'opus', outcome: 'confirmed', corrections: null, incomplete: false }),
    add('/findings/F-1/counterevidence', { anchor: 'api/transfer.js:5', note: 'only the amount sign is checked' }),
    set('/obligations/OB-2/status', 'violated'), set('/obligations/OB-2/open_reason', null),
    add('/debt/out', { id: `${task.id}/D1`, kind: 'runtime', refs: ['OB-4'], requires: 'run concurrent transfers against one account', priority: 'medium' }),
    set('/budget/spent/lead_tool_calls', 14), set('/budget/spent/subagent_calls', 2), set('/budget/spent/subagent_tokens', 3000),
  ]);
  assert.equal(check.valid, true, check.errors.join('\n'));
  assert.equal(helper(task, ['footprint']).code, EXIT.OK);
  // OB-4 is open: complete is refused, incomplete with the reason is not.
  assert.match(helper(task, ['close', '--status', 'complete'], at(5)).json.errors.join('\n'), /a complete run has no open obligation/);
  assert.equal(helper(task, ['close', '--status', 'incomplete', '--reason', 'open-obligations'], at(5)).code, EXIT.OK);
  const taskReport = report(task);
  assert.match(taskReport, /F-1/);
  assert.match(taskReport, /OB-4/);
  assert.match(taskReport, /Open to close is the recorded run interval .* Session time outside it and money cost are not measured\./);
  assert.match(taskReport, /^\| Lead tool calls \| 40 \| 14 \| recorded by the lead \|$/m, 'budget and recorded spending side by side, labelled as the lead\'s');
  assert.deepEqual(projectState(root), before, 'the Task Review wrote nothing outside .nth-review and changed no Git state');

  // ---------------------------------------------------------------- the source changes
  write(root, 'api/ledger.js', lines(
    'const balances = new Map();',
    '',
    'export function move(from, to, amount) {',
    '  const balance = balances.get(from) ?? 0;',
    "  if (balance < amount) throw new Error('insufficient funds');",
    '  balances.set(from, balance - amount);',
    '  balances.set(to, (balances.get(to) ?? 0) + amount);',
    '  return balances.get(from);',
    '}',
  ));
  write(root, 'api/transfer.js', `${TRANSFER}\n\n\nexport function preview(from, amount) {\n  return { from, amount };\n}\n`);
  commitAll(root, 'no overdraft; a preview');
  const changed = projectState(root);

  // ---------------------------------------------------------------- Incremental Review
  const inc = opened(root, ['--mode', 'incremental', '--slug', 'transfers-2', '--base', task.id], at(20));
  assert.equal(inc.result.debt_in, 1, 'the base debt is inherited explicitly');
  const fresh = helper(inc, ['fresh']);
  assert.equal(fresh.code, EXIT.OK, JSON.stringify(fresh.json));
  inc.sha = fresh.json.result.records_sha256;
  const classes = Object.fromEntries(readRecords(root, inc.runDir).freshness.obligations.map((o) => [o.id, o.class]));
  assert.deepEqual(classes, { 'OB-1': 'file-changed', 'OB-2': 'touched', 'OB-3': 'current', 'OB-4': 'touched' }, 'stale evidence is detected per obligation');
  // Reassess: OB-2 held on the fixed code (F-1's cause is gone); OB-4 re-recorded, still open.
  // OB-1 is first copied forward unchanged, which close refuses: a conclusion is reassessed, never carried.
  const base = readRecords(root, task.runDir).obligations;
  const copied = (id) => ({ ...base.find((o) => o.id === id) });
  check = apply(inc, [
    set('/run/runtime/lead_model', 'claude-opus-5-5'), set('/run/runtime/lead_effort', 'high'),
    add('/scope/intent', { id: 'I1', anchor: 'docs/rules.md#Transfers', note: 'ownership and no overdraft' }),
    add('/census/items', { id: 'CI-1', path: 'api/transfer.js', mechanism: 'transfer entry and the new preview', status: 'classified', reason: null, affects: ['OB-1'] }),
    add('/census/items', { id: 'CI-2', path: 'api/ledger.js', mechanism: 'ledger write', status: 'classified', reason: null, affects: ['OB-2', 'OB-4'] }),
    add('/obligations', copied('OB-1')),
    add('/obligations', { ...copied('OB-2'), status: 'held', open_reason: null, links: [], evidence: [{ anchor: 'api/ledger.js:4-6', note: 'the balance is checked before the subtraction' }] }),
    add('/obligations', { ...copied('OB-4') }),
    // Inherited debt: carried, because concurrency still needs a runtime check.
    set(`/debt/in/${task.id}~1D1/disposition`, 'carried'),
    add('/debt/out', { id: `${task.id}/D1`, kind: 'runtime', refs: ['OB-4'], requires: 'run concurrent transfers against one account', priority: 'medium' }),
    set('/budget/spent/lead_tool_calls', 9),
  ]);
  assert.equal(check.valid, true, check.errors.join('\n'));
  const copiedClose = helper(inc, ['close', '--status', 'incomplete', '--reason', 'open-obligations'], at(30));
  assert.match(copiedClose.json.errors.join('\n'), /OB-1 is file-changed since the base, yet held on the base's evidence unchanged; reassess it/);
  check = apply(inc, [set('/obligations/OB-1/evidence', [{ anchor: 'api/transfer.js:4', note: 're-read after the change: the owner check still precedes the move; the new preview moves nothing' }])]);
  assert.equal(check.valid, true, check.errors.join('\n'));
  assert.deepEqual(projectState(root), changed, 'the Incremental Review so far wrote nothing outside .nth-review');

  // A source edit during the run is caught at close; restored, the run closes.
  write(root, 'api/report.js', REPORT.replace('sum + r.amount', 'sum - r.amount'));
  assert.match(helper(inc, ['close', '--status', 'incomplete', '--reason', 'open-obligations'], at(30)).json.errors[0], /the tracked source changed since Open/);
  write(root, 'api/report.js', REPORT);
  // Carried debt keeps the run from closing complete.
  assert.match(helper(inc, ['close', '--status', 'complete'], at(30)).json.errors.join('\n'), /a complete run (carries no open debt|has no open obligation)/);
  const closed = helper(inc, ['close', '--status', 'incomplete', '--reason', 'open-obligations'], at(30));
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const incReport = report(inc);
  assert.match(incReport, new RegExp(`### Freshness against base ${task.id}`));
  assert.match(incReport, /^\| OB-1 \| file-changed \| .* \| re-recorded: held \|$/m);
  assert.match(incReport, /^\| OB-2 \| touched \| .* \| re-recorded: held \|$/m);
  assert.match(incReport, new RegExp(`^\\| OB-3 \\| current \\| .* \\| concluded in ${task.id} \\|$`, 'm'));
  assert.deepEqual(projectState(root), changed, 'nothing outside .nth-review changed, and no Git operation ran');
  // Status names the debt handed on.
  const status = nthr(['status', '--ns', NS], { cwd: root }).json.result.namespaces[0];
  assert.deepEqual(status.debt.items.map((d) => d.id), [`${task.id}/D1`]);
  assert.deepEqual(status.runs.map((r) => [r.mode, r.status]), [['task', 'incomplete'], ['incremental', 'incomplete']]);
});

// Four security cases, each with real synthetic source. The helper cannot judge
// the claims (that is the model's work, unverified without a live run), but it
// must give every one the boundary test, accept each honest outcome, and refuse
// the record shapes that would overstate one.
test('security boundary: escalation, defense in depth, operator spend and a speculative claim', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { 'README.md': 'admin\n' }));
  write(root, 'api/roles.js', lines(
    'export function setRole(actor, target, role) {',
    "  if (!actor.signedIn) throw new Error('unauthenticated');",
    '  db.users.update(target, { role });',
    '}',
  ));
  write(root, 'api/files.js', lines(
    'export function download(actor, id) {',
    "  const file = db.files.find({ id, owner: actor.id });",
    "  if (!file) throw new Error('not found');",
    "  return sanitize(file.path);",
    '}',
  ));
  write(root, 'api/summarize.js', lines(
    'export async function summarize(actor, text) {',
    "  if (!actor.signedIn) throw new Error('unauthenticated');",
    '  return llm.complete({ prompt: text, maxTokens: 100000 });',
    '}',
  ));
  write(root, 'api/search.js', lines('export function search(actor, q) {', '  return index.query(q, { owner: actor.id });', '}'));
  commitAll(root, 'admin api');
  const run = opened(root, ['--mode', 'task', '--slug', 'boundary', '--change', '.:HEAD~1..HEAD'], at(1));
  const obligation = (id, checks, file) => ({ ...ob(id, checks, `${id} holds`), status: 'violated', open_reason: null, source_trace: 'consistent', evidence: [{ anchor: file, note: 'read' }], intent: [] });
  const finding = (id, obligationId, impact, trace, extra) => ({
    id, fingerprint: `admin/${id}`, kind: 'defect', verdict: 'candidate', severity: null, impact_dimension: impact, obligation: obligationId,
    summary: `${id} claim`, trace: trace.map(([role, anchor]) => ({ role, anchor, note: role })), counterevidence: [], validation_plan: null,
    verification: { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }, decision: 'pending', ...extra,
  });
  apply(run, [
    set('/run/runtime/triggers', ['authorization', 'ai-dispatch']), set('/run/runtime/required_lead_model', 'opus-high'),
    add('/obligations', obligation('OB-A', ['AUTHZ.1'], 'api/roles.js:1-4')),
    add('/obligations', obligation('OB-B', ['INJECT.4'], 'api/files.js:1-5')),
    add('/obligations', obligation('OB-C', ['LLM.4', 'RESOURCE.2'], 'api/summarize.js:1-4')),
    add('/obligations', obligation('OB-D', ['AUTHZ.4'], 'api/search.js:1-3')),
    // A: any signed-in user can make anyone an admin: an actor, a failing control, another principal crossed.
    add('/findings', finding('F-A', 'OB-A', 'security', [['entrypoint', 'api/roles.js:1'], ['propagation', 'api/roles.js:2'], ['sink', 'api/roles.js:3']])),
    // B: the path is not normalized again, but the owner-scoped lookup already stops the read.
    add('/findings', finding('F-B', 'OB-B', 'security', [['entrypoint', 'api/files.js:1'], ['sink', 'api/files.js:4']])),
    // C: a signed-in user can buy 100k-token completions on the operator's account, unbounded.
    add('/findings', finding('F-C', 'OB-C', 'financial', [['entrypoint', 'api/summarize.js:1'], ['sink', 'api/summarize.js:3']])),
    // D: "the index might leak other owners' results": nothing in the source shows the owner filter failing.
    add('/findings', finding('F-D', 'OB-D', 'privacy', [['entrypoint', 'api/search.js:1'], ['sink', 'api/search.js:2']])),
  ]);
  // Every case gets the boundary test, with the lines its checks call for.
  const packText = (id) => {
    assert.equal(helper(run, ['pack', '--for', id]).code, EXIT.OK);
    return fs.readFileSync(path.join(root, ...run.runDir.split('/'), 'packs', `${id}.md`), 'utf8');
  };
  const packs = Object.fromEntries(['F-A', 'F-B', 'F-C', 'F-D'].map((id) => [id, packText(id)]));
  for (const text of Object.values(packs)) assert.match(text, /## Boundary test[\s\S]*- Crossing: whose data, account, tenant, shared capacity or paid spend is affected beyond the actor's own permissions\?/);
  assert.match(packs['F-C'], /- Cost: name the input, the work or spend it buys/);
  assert.match(packs['F-C'], /- Model path: instructions given to a model are no control/);
  assert.match(packs['F-D'], /- Scope: an owner or tenant column proves nothing until the query, key or path that reads the data applies it\./);
  assert.doesNotMatch(packs['F-A'], /- Cost:|- Model path:|- Scope:/);

  const r5 = (outcome) => ({ role: 'R5', model: 'opus', outcome, corrections: null, incomplete: false });
  const errorsAfter = (ops) => apply(run, ops).errors.join('\n');
  // Overstated shapes are refused: a security defect confirmed by the Sonnet refuter,
  // a risk with a severity, a needs_validation with a severity or no plan, a rejection
  // with no counterevidence.
  const overstated = errorsAfter([
    set('/findings/F-A/verdict', 'confirmed'), set('/findings/F-A/severity', 'high'), set('/findings/F-A/verification', { role: 'R6', model: 'sonnet', outcome: 'confirmed', corrections: null, incomplete: false }),
    set('/findings/F-B/kind', 'risk'), set('/findings/F-B/verdict', 'confirmed'), set('/findings/F-B/severity', 'low'),
    set('/findings/F-D/verdict', 'needs_validation'), set('/findings/F-D/severity', 'medium'),
    set('/findings/F-C/verdict', 'rejected'),
  ]);
  assert.match(overstated, /findings\[0\]\.verification\.role: a critical or high defect, or a money, authorization or data-integrity claim, needs the R5 Opus refuter/);
  assert.match(overstated, /findings\[1\]\.severity: a risk has no severity/);
  assert.match(overstated, /findings\[3\]\.severity: must be null while the finding needs validation/);
  assert.match(overstated, /findings\[3\]\.validation_plan: a needs_validation finding needs a validation plan/);
  assert.match(overstated, /findings\[2\]\.counterevidence: a rejected finding needs counterevidence/);
  // The honest outcomes are accepted:
  // A confirmed by R5 (a genuine escalation); B a risk, or rejected on the effective control;
  // C confirmed by R5 at its financial impact; D needs_validation with the fact to establish.
  const honest = apply(run, [
    add('/delegations', { role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: 4, tokens: 100, completed: true, recovery_messages: 0 }),
    add('/delegations', { role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: 4, tokens: 100, completed: true, recovery_messages: 0 }),
    set('/budget/spent/subagent_calls', 2), set('/budget/spent/subagent_tokens', 200),
    set('/findings/F-A/verification', r5('confirmed')),
    set('/findings/F-B/severity', null), set('/findings/F-B/verification', { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }),
    set('/findings/F-C/verdict', 'confirmed'), set('/findings/F-C/severity', 'medium'), set('/findings/F-C/verification', r5('corrected')),
    set('/findings/F-C/verification/corrections', 'the impact is operator spend, not availability of other users'),
    set('/findings/F-D/severity', null), set('/findings/F-D/validation_plan', 'show a query path that reads the index without the owner filter'),
    set('/obligations/OB-B/status', 'open'), set('/obligations/OB-B/open_reason', 'needs-owner-intent'),
  ]);
  assert.equal(honest.valid, true, honest.errors.join('\n'));
  // B rejected instead of risk: accepted with counterevidence naming the effective control.
  const rejected = apply(run, [
    set('/findings/F-B/kind', 'defect'), set('/findings/F-B/verdict', 'rejected'), set('/findings/F-B/verification', r5('rejected')),
    add('/findings/F-B/counterevidence', { anchor: 'api/files.js:2', note: 'the lookup is scoped to the owner, so no other principal is reached' }),
    set('/obligations/OB-B/status', 'held'), set('/obligations/OB-B/open_reason', null),
  ]);
  assert.equal(rejected.valid, true, rejected.errors.join('\n'));
});
