// Flow Review (BETA): entry resolution, the bounded path graph, freshness,
// close, resume and the report, on disposable synthetic projects.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { at, nthr, readRecords, recordsFile, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const NS = 'reviews/flow';
const lines = (...l) => `${l.join('\n')}\n`;

// A synthetic order service: a route, a handler, persistence, an event bus
// with two consumers, a job with an injected dependency, and a module cycle.
const SOURCE = {
  'src/routes.js': lines("import { createOrder } from './orders.js';", '', 'export function registerRoutes(app) {', "  app.post('/orders', createOrder);", '}'),
  'src/orders.js': lines(
    "import { saveOrder } from './store.js';",
    "import { publish } from './events.js';",
    '',
    'export async function createOrder(req, res) {',
    '  if (!req.user) return res.status(401).end();',
    '  const order = await saveOrder(req.body);',
    "  publish('order.created', order);",
    '  return res.json(order);',
    '}',
  ),
  'src/store.js': lines('export async function saveOrder(body) {', "  return db.insert('orders', body);", '}'),
  'src/events.js': lines(
    'const handlers = {};',
    'export function subscribe(name, fn) { (handlers[name] ??= []).push(fn); }',
    'export function publish(name, payload) { for (const fn of handlers[name] ?? []) fn(payload); }',
  ),
  'src/consumers/email.js': lines("import { subscribe } from '../events.js';", 'export function onOrderCreated(order) {', '  return sendEmail(order.email);', '}', "subscribe('order.created', onOrderCreated);"),
  'src/consumers/audit.js': lines("import { subscribe } from '../events.js';", 'export function recordOrder(order) {', '  return log(order.id);', '}', "subscribe('order.created', recordOrder);"),
  'src/jobs/nightly.js': lines('export function nightlyReconcile(deps) {', '  return deps.reconcile();', '}'),
  'src/lib/a.js': lines("import { b } from './b.js';", 'export function a(n) {', '  return n > 0 ? b(n - 1) : 0;', '}'),
  'src/lib/b.js': lines("import { a } from './a.js';", 'export function b(n) {', '  return a(n);', '}'),
  'src/dup.js': lines('function handle() {}', 'function handle() {}'),
  'src/service.py': lines('class Billing:', '    def charge(self, amount):', '        return amount', '', '    def refund(self, amount):', '        return -amount'),
};

function project(t, extra = {}) {
  return fs.realpathSync.native(makeRepo(makeTempDir(t), { ...SOURCE, ...extra }));
}

function open(root, entries, { slug = 'orders', now = at(1), ns = NS, extra = [] } = {}) {
  return nthr(['new-run', '--ns', ns, '--mode', 'flow', '--slug', slug, ...entries.flatMap((e) => ['--entry', e]), ...extra], { cwd: root, now });
}

function opened(root, entries, options) {
  const r = open(root, entries, options);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  return { runDir: r.json.result.run_dir, sha: r.json.result.records_sha256, result: r.json.result };
}

// Writes one batch through patch.json + apply; returns the apply output.
function apply(root, run, ops) {
  fs.writeFileSync(path.join(root, ...run.runDir.split('/'), 'patch.json'), JSON.stringify({ schema: 'nth-review/patch@1', base: run.sha, ops }));
  const r = nthr(['apply', '--run', run.runDir], { cwd: root });
  if (r.code === EXIT.OK) run.sha = r.json.result.records_sha256;
  return r;
}

const ob = (id, evidence, extra = {}) => ({
  id, checks: ['LOGIC.1'], claim: `${id} claim`, scope: 'flow', acceptance: 'acceptance',
  coverage: 'named-subset', coverage_method: 'read the recorded paths', status: 'held', open_reason: null, source_trace: 'consistent',
  evidence: evidence.map((anchor) => ({ anchor, note: 'read' })), intent: [], assumptions: [], links: [], ...extra,
});
const edge = (id, from, to, kind, evidence, status = 'classified', extra = {}) => ({
  id, from, to, kind, evidence, status, reason: status === 'classified' ? null : `${status} reason`, affects: status === 'classified' ? ['OB-1'] : null, ...extra,
});
const add = (pathName, value) => ({ op: 'add', path: pathName, value });
const close = (root, run, args = ['--status', 'complete'], now = at(9)) => nthr(['close', '--run', run.runDir, ...args], { cwd: root, now });
const check = (root, run) => nthr(['check', '--run', run.runDir], { cwd: root });
const errorsOf = (r) => (r.json.errors ?? r.json.result?.check?.errors ?? []).join('\n');

// Every file outside .git and .nth-review: path and digest.
function treeState(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('.git/') && !rel.startsWith('.nth-review/'))
    .sort()
    .map((rel) => `${rel} ${createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')}`);
}

test('flow 1: one API entry, from resolve to a complete close; nothing but the run directory is written', (t) => {
  const root = project(t);
  const before = treeState(root);
  const head = rawGit(root, ['rev-parse', 'HEAD']).trim();
  const resolved = nthr(['resolve', '--entry', 'src/orders.js#createOrder'], { cwd: root });
  assert.equal(resolved.code, EXIT.OK, JSON.stringify(resolved.json));
  assert.deepEqual(resolved.json.result, {
    resolved: true, problems: [],
    entries: [{ id: 'E1', selector: 'src/orders.js#createOrder', anchor: 'src/orders.js:4-9', repo: '.', state: 'clean' }],
  });

  const run = opened(root, ['src/orders.js#createOrder']);
  assert.match(run.result.run_id, /^\d{8}-\d{6}-flow-orders$/);
  assert.deepEqual(run.result.budget, {
    lead_tool_calls: 60, subagent_calls: 5, obligations_max: 20, reserve_pct: 30, max_depth: 4, max_edges: 40,
    spent: { lead_tool_calls: 0, subagent_calls: 0, subagent_tokens: 0, lead_tokens_observed: null, wall_clock_min: 0 },
  });
  assert.equal(run.result.required_lead_model, 'opus-high');
  const doc = readRecords(root, run.runDir);
  assert.deepEqual(doc.scope.change, []);
  assert.deepEqual(doc.census.edges, []);
  assert.equal(doc.scope.entries[0].identity.blob, rawGit(root, ['rev-parse', 'HEAD:src/orders.js']).trim());

  const r = apply(root, run, [
    { op: 'set', path: '/run/runtime/lead_model', value: 'claude-opus-5-5' },
    add('/obligations', ob('OB-1', ['src/orders.js:4-9', 'src/store.js:1-3'])),
    add('/census/edges', edge('G1', 'E1', 'src/store.js:1-3', 'data', 'src/orders.js:6')),
    add('/census/edges', edge('G2', 'E1', 'src/events.js:3', 'event', 'src/orders.js:7')),
    add('/census/edges', edge('G3', 'E1', null, 'guard', 'src/orders.js:5', 'excluded', { reason: 'the 401 branch writes nothing' })),
  ]);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  const closed = close(root, run);
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const report = fs.readFileSync(path.join(root, ...run.runDir.split('/'), 'report.md'), 'utf8');
  assert.match(report, /^# Flow Review report: \d{8}-\d{6}-flow-orders$/m);
  assert.match(report, /It is not a project audit: code outside these paths was not reviewed\./);
  assert.match(report, /^\| E1 \| src\/orders\.js#createOrder \| src\/orders\.js:4-9 \| \. \| clean \|$/m);
  assert.match(report, /^\| G3 \| E1 \| guard \| unresolved \| src\/orders\.js:5 \| 1 \| excluded \| the 401 branch writes nothing \|$/m);
  assert.match(report, /3 paths: 2 covered by obligations, 1 excluded with a reason, 0 unknown/);
  assert.match(report, /No limit was reached\./);
  assert.deepEqual(Object.keys(readRecords(root, run.runDir).footprint), ['src/events.js', 'src/orders.js', 'src/store.js']);
  // Read-only for the project: same files, same HEAD, a clean index.
  assert.deepEqual(treeState(root), before);
  assert.equal(rawGit(root, ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(rawGit(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '');
});

test('flow 2: a web action into the API across repositories; the budget counts the extra repository', (t) => {
  const root = project(t, { '.gitignore': 'web/\n' });
  const web = makeRepo(path.join(root, 'web'), { 'src/checkout.js': lines('export async function submitCheckout(form) {', "  return fetch('/orders', { method: 'POST', body: form });", '}') });
  assert.ok(web);
  const run = opened(root, ['web/src/checkout.js#submitCheckout', 'src/routes.js:3-5']);
  assert.deepEqual([run.result.budget.lead_tool_calls, run.result.budget.obligations_max, run.result.budget.max_edges], [70, 25, 80]);
  assert.deepEqual(run.result.entries.map((e) => [e.id, e.anchor, e.repo]), [['E1', 'web/src/checkout.js:1-3', 'web'], ['E2', 'src/routes.js:3-5', '.']]);
  const r = apply(root, run, [
    add('/obligations', ob('OB-1', ['web/src/checkout.js:1-3', 'src/routes.js:3-5', 'src/orders.js:4-9'])),
    add('/census/edges', edge('G1', 'E1', 'src/routes.js:4', 'external', 'web/src/checkout.js:2')),
    add('/census/edges', edge('G2', 'E2', 'src/orders.js:4-9', 'route', 'src/routes.js:4')),
    add('/census/edges', edge('G3', 'G2', 'src/store.js:1-3', 'data', 'src/orders.js:6')),
  ]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  assert.equal(close(root, run).code, EXIT.OK);
  const fp = readRecords(root, run.runDir).footprint;
  assert.equal(fp['web/src/checkout.js'].state, 'clean');
  assert.equal(fp['src/routes.js'].state, 'clean');
});

test('flow 3 and 4: event consumers and a job with an injected dependency; an unknown path is handed on, never Verified', (t) => {
  const root = project(t);
  const run = opened(root, ['src/orders.js#createOrder', 'src/jobs/nightly.js#nightlyReconcile']);
  const all = (o) => ({ ...o, coverage: 'all-enumerated', coverage_method: 'every recorded path' });
  let r = apply(root, run, [
    add('/obligations', all(ob('OB-1', ['src/orders.js:4-9', 'src/consumers/email.js:2-4', 'src/consumers/audit.js:2-4', 'src/jobs/nightly.js:1-3']))),
    add('/census/edges', edge('G1', 'E1', 'src/events.js:3', 'event', 'src/orders.js:7')),
    add('/census/edges', edge('G2', 'G1', 'src/consumers/email.js:2-4', 'event', 'src/consumers/email.js:5')),
    add('/census/edges', edge('G3', 'G1', 'src/consumers/audit.js:2-4', 'event', 'src/consumers/audit.js:5')),
    add('/census/edges', edge('G4', 'E2', null, 'dynamic', 'src/jobs/nightly.js:2', 'unknown', { reason: 'deps.reconcile is injected; find the scheduler that builds deps' })),
  ]);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  assert.match(errorsOf(r), /\$\.obligations\[0\]\.coverage: cannot be all-enumerated: census items G4 bear on it/);
  r = apply(root, run, [{ op: 'set', path: '/obligations/OB-1/coverage', value: 'named-subset' }]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  // Close needs the unknown path handed on as debt naming its evidence.
  const refused = close(root, run);
  assert.equal(refused.code, EXIT.INVALID);
  assert.match(errorsOf(refused), /the unknown path G4 \(src\/jobs\/nightly\.js:2\) needs frontier or deferred-scope debt whose requires names src\/jobs\/nightly\.js:2/);
  r = apply(root, run, [add('/debt/out', { id: `${run.result.run_id}/D1`, kind: 'frontier', refs: ['OB-1'], requires: 'resolve the injected deps of src/jobs/nightly.js:2 from the scheduler', priority: 'medium' })]);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  assert.equal(close(root, run).code, EXIT.OK);
  const report = fs.readFileSync(path.join(root, ...run.runDir.split('/'), 'report.md'), 'utf8');
  assert.match(report, /4 paths: 3 covered by obligations, 0 excluded with a reason, 1 unknown/);
  assert.match(report, /^\| OB-1 \| OB-1 claim \| every recorded path \| not verified \|$/m);
});

test('flow 5 and 14: entry counts set the limits; depth and edge limits stop expansion and block exhaustive claims', (t) => {
  const root = project(t);
  const many = Array.from({ length: 9 }, (_, i) => `src/orders.js:${i + 1}`);
  const tooMany = open(root, many);
  assert.equal(tooMany.code, EXIT.USAGE);
  assert.match(tooMany.json.errors[0], /at most 8 entries/);
  const eight = opened(root, many.slice(0, 8), { slug: 'eight' });
  assert.deepEqual([eight.result.budget.lead_tool_calls, eight.result.budget.obligations_max, eight.result.budget.max_edges], [90, 40, 120]);
  // Seven entries are cited nowhere: a complete run concludes on every entry.
  apply(root, eight, [add('/obligations', ob('OB-1', ['src/orders.js:1']))]);
  const incomplete = close(root, eight);
  assert.match(errorsOf(incomplete), /a complete flow run concludes on every entry/);
  assert.equal(close(root, eight, ['--status', 'incomplete', '--reason', 'open-obligations']).code, EXIT.OK);

  // Depth on a real six-stage path: test 'hardening 3'.
  let r;
  // The edge limit: 40 edges for one entry; reaching it blocks all-enumerated, passing it is an error.
  const root3 = project(t);
  const capped = opened(root3, ['src/store.js#saveOrder']);
  const fill = Array.from({ length: 40 }, (_, i) => add('/census/edges', edge(`G${i + 1}`, 'E1', `src/store.js:${i + 1}`, 'call', 'src/store.js:2')));
  r = apply(root3, capped, [add('/obligations', ob('OB-1', ['src/store.js:1-3'], { coverage: 'all-enumerated' })), ...fill]);
  assert.match(errorsOf(r), /census items the edge limit \(max_edges 40\) bear on it/);
  r = apply(root3, capped, [add('/census/edges', edge('G41', 'E1', 'src/store.js:99', 'call', 'src/store.js:2'))]);
  assert.match(errorsOf(r), /41 edges exceed max_edges 40/);
});

test('flow 6 and 13: edges expand forward only; repeated paths are refused; one edge disposes of a path two delegates found', (t) => {
  const root = project(t);
  const run = opened(root, ['src/lib/a.js#a']);
  let r = apply(root, run, [
    add('/obligations', ob('OB-1', ['src/lib/a.js:2-4', 'src/lib/b.js:2-4'])),
    add('/census/edges', edge('G1', 'G2', 'src/lib/b.js:2-4', 'call', 'src/lib/a.js:3')),
    add('/census/edges', edge('G2', 'E1', 'src/lib/b.js:2-4', 'call', 'src/lib/a.js:3')),
    add('/census/edges', edge('G3', 'G3', 'src/lib/a.js:2-4', 'call', 'src/lib/b.js:3')),
    add('/census/edges', edge('G4', 'E1', 'src/lib/b.js:2-4', 'call', 'src/lib/a.js:3')),
  ]);
  const errors = errorsOf(r);
  assert.match(errors, /census\.edges\[0\]\.from: G2 is not an entry or an earlier edge/);
  assert.match(errors, /census\.edges\[2\]\.from: G3 is not an entry or an earlier edge/);
  assert.match(errors, /census\.edges\[3\]: repeats E1 -> src\/lib\/b\.js:2-4 \(call\) as G2: reuse the recorded edge/);
  // The cycle back into reviewed code: a classified revisit (the relationship is real).
  r = apply(root, run, [
    { op: 'remove', path: '/census/edges/G1' },
    { op: 'remove', path: '/census/edges/G3' },
    { op: 'remove', path: '/census/edges/G4' },
    add('/census/edges', edge('G3', 'G2', 'src/lib/a.js:2-4', 'call', 'src/lib/b.js:3')),
    add('/delegations', { role: 'R2', agent: 'Explore', model: 'sonnet', effort: null, budget_calls: 30, tool_uses: 4, tokens: 10, completed: true, recovery_messages: 0, discovered: ['src/lib/b.js'] }),
    add('/delegations', { role: 'R3', agent: 'Explore', model: 'sonnet', effort: null, budget_calls: 30, tool_uses: 4, tokens: 10, completed: true, recovery_messages: 0, discovered: ['src/lib/b.js', 'src/events.js'] }),
    { op: 'set', path: '/budget/spent/subagent_calls', value: 2 },
    { op: 'set', path: '/budget/spent/subagent_tokens', value: 20 },
  ]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  const refused = close(root, run);
  assert.match(errorsOf(refused), /delegations\[1\]\.discovered\[1\]: src\/events\.js \(found by R3\) has no census disposition/);
  assert.doesNotMatch(errorsOf(refused), /src\/lib\/b\.js \(found by/);
  apply(root, run, [add('/census/items', { id: 'CI-ev', path: 'src/events.js', mechanism: 'event bus', status: 'excluded', reason: 'a() publishes no event', affects: null })]);
  const done = close(root, run);
  assert.equal(done.code, EXIT.OK, JSON.stringify(done.json));
});

test('flow 7: ambiguous, missing and unsafe entries are refused before anything is written', (t) => {
  const root = project(t, { '.env': 'SECRET=1\n' });
  write(root, '.claude/skills/nth-review/SKILL.md', lines('# skill', 'function x() {}'));
  const refusals = [
    ['src/dup.js#handle', /2 definitions of handle in src\/dup\.js \(src\/dup\.js:1-1, src\/dup\.js:2-2\); choose one with a line selector/],
    ['src/orders.js#missing', /no definition of missing in src\/orders\.js/],
    ['src/service.py#Billing.void', /no definition of void inside Billing/],
    ['src/orders.js', /a whole file is not an entry point/],
    ['src/orders.js:40-44', /src\/orders\.js has 9 lines; the selector names 40-44/],
    ['src/gone.js#run', /src\/gone\.js does not exist in the current source/],
    ['.env:1', /cannot be verified \(secret\)/],
    ['.nth-review/x.js:1', /review records are never an entry point/],
    ['.claude/skills/nth-review/SKILL.md:2', /installed files are never an entry point/],
    ['README.txt#x', /not a selector|does not exist/],
    ['src/orders.js#a-b', /the symbol must be an identifier/],
  ];
  for (const [selector, pattern] of refusals) {
    const r = open(root, [selector]);
    assert.equal(r.code, EXIT.USAGE, `${selector}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.errors.join('\n'), pattern, selector);
    const check = nthr(['resolve', '--entry', selector], { cwd: root });
    assert.equal(check.json.result.resolved, false, selector);
  }
  const dupes = open(root, ['src/service.py#Billing.charge', 'src/service.py:2-3']);
  assert.match(dupes.json.errors.join('\n'), /resolves to the same code as src\/service\.py#Billing\.charge/);
  assert.ok(!fs.existsSync(path.join(root, '.nth-review')), 'no refusal writes anything');
  // Mode contract: flow takes no change and no base; other modes take no entry.
  assert.match(open(root, ['src/orders.js:4'], { extra: ['--change', '.'] }).json.errors[0], /takes no --change/);
  assert.match(nthr(['new-run', '--ns', NS, '--mode', 'task', '--slug', 't', '--change', '.', '--entry', 'src/orders.js:4'], { cwd: root }).json.errors[0], /--entry is only for --mode flow/);
  assert.equal(nthr(['new-run', '--ns', 'audits/x', '--mode', 'flow', '--slug', 'f', '--entry', 'src/orders.js:4'], { cwd: root }).code, EXIT.USAGE);
});

test('flow 9: an unrelated repository changes neither the budget nor the boundary', (t) => {
  const root = project(t, { '.gitignore': 'big/\n' });
  makeRepo(path.join(root, 'big'), Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`m${i}.js`, `export const v${i} = ${i};\n`])));
  const run = opened(root, ['src/store.js#saveOrder']);
  assert.deepEqual([run.result.budget.lead_tool_calls, run.result.budget.max_edges], [60, 40]);
  const r = apply(root, run, [add('/obligations', ob('OB-1', ['src/store.js:1-3', 'big/m1.js:1']))]);
  assert.match(errorsOf(r), /obligations\[0\]\.evidence\[1\]: big\/m1\.js is outside the reviewed flow/);
});

test('flow 10 and 11: a source change during the review never closes clean; resume carries the entries', (t) => {
  // A tracked file the flow reached changes: refused as for every run.
  const root = project(t);
  const run = opened(root, ['src/orders.js#createOrder']);
  apply(root, run, [add('/obligations', ob('OB-1', ['src/orders.js:4-9', 'src/store.js:1-3'])), add('/census/edges', edge('G1', 'E1', 'src/store.js:1-3', 'data', 'src/orders.js:6'))]);
  write(root, 'src/store.js', lines('export async function saveOrder(body) {', "  return db.upsert('orders', body);", '}'));
  assert.match(close(root, run).json.errors[0], /the tracked source changed since Open/);

  // An untracked entry changes: --reassessed does not cover it.
  const root2 = project(t);
  write(root2, 'src/new.ts', lines('export const handler = async (event: Event) => {', '  return save(event);', '};'));
  const run2 = opened(root2, ['src/new.ts#handler']);
  assert.equal(run2.result.entries[0].state, 'untracked');
  apply(root2, run2, [add('/obligations', ob('OB-1', ['src/new.ts:1-3']))]);
  write(root2, 'src/new.ts', lines('export const handler = async (event: Event) => {', '  return drop(event);', '};'));
  const refused = close(root2, run2, ['--status', 'complete', '--reassessed']);
  assert.equal(refused.code, EXIT.USAGE);
  assert.match(refused.json.errors[0], /files this review cites may have changed since Open \(src\/new\.ts untracked\)/);
  // Resume abandons it and opens a flow continuation on the same selector, resolved again.
  const plan = nthr(['resume', '--ns', NS], { cwd: root2, now: at(10) });
  assert.equal(plan.json.result.cause, 'cited-untracked', JSON.stringify(plan.json));
  assert.deepEqual(plan.json.result.continuation.entries.map((e) => [e.selector, e.anchor]), [['src/new.ts#handler', 'src/new.ts:1-3']]);
  const applied = nthr(['resume', '--ns', NS, '--apply'], { cwd: root2, now: at(11) });
  assert.equal(applied.code, EXIT.OK, JSON.stringify(applied.json));
  const next = readRecords(root2, applied.json.result.run_dir);
  assert.equal(next.run.mode, 'flow');
  assert.equal(next.run.continues, run2.result.run_id);
  assert.notEqual(next.scope.entries[0].identity.blob, readRecords(root2, run2.runDir).scope.entries[0].identity.blob);

  // An ignored entry file is outside the snapshot: re-resolving it at close catches the change.
  const root3 = project(t, { '.gitignore': 'gen/\n' });
  write(root3, 'gen/handler.js', lines('export function run() {', '  return 1;', '}'));
  const run3 = opened(root3, ['gen/handler.js#run']);
  apply(root3, run3, [add('/obligations', ob('OB-1', ['gen/handler.js:1-3']))]);
  write(root3, 'gen/handler.js', lines('// moved', 'export function run() {', '  return 2;', '}'));
  assert.match(close(root3, run3).json.errors[0], /the selected entries no longer resolve as at Open \(E1 gen\/handler\.js#run\)/);
  assert.equal(close(root3, run3, ['--status', 'incomplete', '--reason', 'snapshot-changed']).code, EXIT.OK);
});

test('flow 15: incompatible, tampered and stale flow records are refused', (t) => {
  const root = project(t);
  const run = opened(root, ['src/store.js#saveOrder']);
  // The helper's fields cannot be patched; edges can.
  for (const [p, value] of [['/scope/entries', []], ['/budget/max_edges', 500], ['/budget/max_depth', 9]]) {
    const r = apply(root, run, [{ op: 'set', path: p, value }]);
    assert.equal(r.code, EXIT.INVALID, p);
    assert.match(errorsOf(r), /refused: /, p);
  }
  // A hand edit of the limits, or flow fields in another mode, fail check.
  const doc = readRecords(root, run.runDir);
  writeRecords(root, run.runDir, { ...doc, budget: { ...doc.budget, max_edges: 500 } });
  assert.match(errorsOf(check(root, run)), /\$\.budget\.max_edges: must be 40, as new-run sets it from the entries/);
  const missing = structuredClone(doc);
  delete missing.census.edges;
  writeRecords(root, run.runDir, missing);
  assert.match(errorsOf(check(root, run)), /a flow run records edges/);
  writeRecords(root, run.runDir, doc);
  const other = nthr(['new-run', '--ns', 'reviews/other', '--mode', 'task', '--slug', 't', '--change', '.'], { cwd: root, now: at(2) });
  const taskRun = { runDir: other.json.result.run_dir };
  const task = readRecords(root, taskRun.runDir);
  task.scope.entries = doc.scope.entries;
  task.census.edges = [];
  task.budget.max_edges = 40;
  writeRecords(root, taskRun.runDir, task);
  const taskErrors = errorsOf(check(root, taskRun));
  assert.match(taskErrors, /\$\.scope\.entries: is written only in flow runs/);
  assert.match(taskErrors, /\$\.census\.edges: is recorded only in flow runs/);
  assert.match(taskErrors, /\$\.budget: max_depth and max_edges are flow-run limits only/);
  run.sha = createHash('sha256').update(fs.readFileSync(recordsFile(root, run.runDir))).digest('hex');
  assert.equal(apply(root, run, []).code, EXIT.OK, 'an empty batch clears the refused patch');
  assert.equal(close(root, run, ['--status', 'incomplete', '--reason', 'owner-stopped']).code, EXIT.OK);

  // A flow run is no Incremental baseline, and a flow run continues only an abandoned flow run.
  const inc = nthr(['new-run', '--ns', NS, '--mode', 'incremental', '--slug', 'inc', '--base', run.result.run_id], { cwd: root, now: at(20) });
  assert.equal(inc.code, EXIT.USAGE);
  assert.match(inc.json.errors[0], /is a flow run; a incremental run cannot build on it/);
  const cont = open(root, ['src/store.js#saveOrder'], { slug: 'again', now: at(21), extra: ['--continues', run.result.run_id] });
  assert.match(cont.json.errors[0], /a flow run continues only an abandoned flow run/);
  assert.match(open(root, ['src/store.js#saveOrder'], { slug: 'b', now: at(22), extra: ['--base', run.result.run_id] }).json.errors[0], /a flow run takes no --base/);
});

test('review fixes: a cited ignored file is refused; debt names an unknown path exactly; minified lines are never definitions', (t) => {
  // An ignored edge target: outside every snapshot, so it can never be cited (an ignored entry is re-resolved instead).
  const root = project(t, { '.gitignore': 'gen/\n' });
  write(root, 'gen/x.js', lines('export function x() {', '  return 1;', '}'));
  const run = opened(root, ['src/orders.js#createOrder']);
  apply(root, run, [
    add('/obligations', ob('OB-1', ['src/orders.js:4-9', 'gen/x.js:1-3'])),
    add('/census/edges', edge('G1', 'E1', 'gen/x.js:1-3', 'call', 'src/orders.js:6')),
  ]);
  const fp = nthr(['footprint', '--run', run.runDir], { cwd: root });
  assert.equal(fp.code, EXIT.INVALID, JSON.stringify(fp.json));
  assert.match(fp.json.errors.join('\n'), /gen\/x\.js: is cited but is ignored by Git/);
  assert.match(errorsOf(close(root, run)), /gen\/x\.js: is cited but is ignored by Git/);

  // Debt must name the unknown edge's evidence anchor itself, not one that merely starts with it.
  const root2 = project(t);
  const run2 = opened(root2, ['src/jobs/nightly.js#nightlyReconcile']);
  apply(root2, run2, [
    add('/obligations', ob('OB-1', ['src/jobs/nightly.js:1-3'])),
    add('/census/edges', edge('G1', 'E1', null, 'dynamic', 'src/jobs/nightly.js:2', 'unknown')),
    add('/debt/out', { id: `${run2.result.run_id}/D1`, kind: 'frontier', refs: ['OB-1'], requires: 'trace src/jobs/nightly.js:21-30', priority: 'low' }),
  ]);
  assert.match(errorsOf(close(root2, run2)), /the unknown path G1 \(src\/jobs\/nightly\.js:2\) needs frontier/);
  // Debt items have ids, so the path names the id (JSON Pointer escapes '/' as ~1), never a position.
  apply(root2, run2, [{ op: 'set', path: `/debt/out/${run2.result.run_id}~1D1/requires`, value: 'resolve deps at src/jobs/nightly.js:2, from the scheduler' }]);
  const closed2 = close(root2, run2);
  assert.equal(closed2.code, EXIT.OK, JSON.stringify(closed2.json));

  // A minified line is skipped quickly, and never resolves as a definition.
  const root3 = project(t, { 'src/min.js': `${'var a=1;'.repeat(400)}function packed(){return 1}\n` });
  const started = Date.now();
  const r = nthr(['resolve', '--entry', 'src/min.js#packed'], { cwd: root3 });
  assert.ok(Date.now() - started < 5000);
  assert.match(r.json.result.problems[0], /no definition of packed in src\/min\.js/);
});


// A six-stage synthetic path: route -> handler -> service -> repository -> adapter -> driver.
const SIX = {
  'app/routes.js': lines("import { postPayment } from './handler.js';", "export function routes(app) { app.post('/pay', postPayment); }"),
  'app/handler.js': lines("import { pay } from './service.js';", 'export async function postPayment(req, res) {', '  return res.json(await pay(req.body));', '}'),
  'app/service.js': lines("import { savePayment } from './repo.js';", 'export async function pay(body) {', '  return savePayment(body);', '}'),
  'app/repo.js': lines("import { exec } from './adapter.js';", 'export async function savePayment(p) {', "  return exec('insert', p);", '}'),
  'app/adapter.js': lines("import { send } from './driver.js';", 'export async function exec(op, p) {', '  return send(op, p);', '}'),
  'app/driver.js': lines('export async function send(op, p) {', '  return socket.write(op, p);', '}'),
};

test('hardening 1: cycles and shared dependencies keep their relationships; a revisited node is never expanded again', (t) => {
  // A -> B -> A: the edge back into A is classified (a real call), and nothing expands from it.
  const root = project(t);
  const run = opened(root, ['src/lib/a.js#a']);
  let r = apply(root, run, [
    add('/obligations', ob('OB-1', ['src/lib/a.js:2-4', 'src/lib/b.js:2-4'])),
    add('/census/edges', edge('G1', 'E1', 'src/lib/b.js:2-4', 'call', 'src/lib/a.js:3')),
    add('/census/edges', edge('G2', 'G1', 'src/lib/a.js:3', 'call', 'src/lib/b.js:3')),
  ]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  r = apply(root, run, [add('/census/edges', edge('G3', 'G2', 'src/lib/b.js:3', 'call', 'src/lib/a.js:3'))]);
  assert.match(errorsOf(r), /census\.edges\[2\]\.from: G2 revisits a node already reached: a revisit keeps its relationship but is not expanded again/);
  r = apply(root, run, [{ op: 'remove', path: '/census/edges/G3' }, { op: 'set', path: '/census/edges/G2/status', value: 'excluded' }, { op: 'set', path: '/census/edges/G2/reason', value: 'already reviewed' }, { op: 'set', path: '/census/edges/G2/affects', value: null }]);
  assert.match(errorsOf(r), /src\/lib\/a\.js:3 was already reached \(E1\): a revisit is a real relationship, so record it as classified; excluded means out of scope/);
  r = apply(root, run, [
    { op: 'set', path: '/census/edges/G2/status', value: 'classified' },
    { op: 'set', path: '/census/edges/G2/reason', value: null },
    { op: 'set', path: '/census/edges/G2/affects', value: ['OB-1'] },
  ]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  assert.equal(close(root, run).code, EXIT.OK);
  const recorded = readRecords(root, run.runDir).census.edges;
  assert.deepEqual(recorded.map((g) => [g.id, g.from, g.to, g.status]), [['G1', 'E1', 'src/lib/b.js:2-4', 'classified'], ['G2', 'G1', 'src/lib/a.js:3', 'classified']]);

  // Two callers sharing one service: both relationships stay; the service is expanded once.
  const root2 = project(t);
  const shared = opened(root2, ['src/orders.js#createOrder', 'src/jobs/nightly.js#nightlyReconcile']);
  r = apply(root2, shared, [
    add('/obligations', ob('OB-1', ['src/orders.js:4-9', 'src/jobs/nightly.js:1-3', 'src/store.js:1-3'])),
    add('/census/edges', edge('G1', 'E1', 'src/store.js:1-3', 'data', 'src/orders.js:6')),
    add('/census/edges', edge('G2', 'E2', 'src/store.js:1-3', 'data', 'src/jobs/nightly.js:2')),
    add('/census/edges', edge('G3', 'G1', 'src/store.js:2', 'data', 'src/store.js:2')),
  ]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  r = apply(root2, shared, [add('/census/edges', edge('G4', 'G2', 'src/store.js:2', 'data', 'src/store.js:2'))]);
  assert.match(errorsOf(r), /G2 revisits a node already reached/);
  r = apply(root2, shared, [{ op: 'remove', path: '/census/edges/G4' }]);
  assert.equal(close(root2, shared).code, EXIT.OK);
});

test('hardening 2: complete is process status, Verified is coverage; an unreviewed path below a covered one is never Verified', (t) => {
  const root = project(t);
  const report = (run) => fs.readFileSync(path.join(root, ...run.runDir.split('/'), 'report.md'), 'utf8');
  const all = (o) => ({ ...o, coverage: 'all-enumerated', coverage_method: 'every recorded path' });
  // Fully covered: complete, all-enumerated, nothing unknown: Verified.
  const clean = opened(root, ['src/store.js#saveOrder'], { slug: 'clean' });
  let r = apply(root, clean, [add('/obligations', all(ob('OB-1', ['src/store.js:1-3'])))]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  assert.equal(close(root, clean).code, EXIT.OK);
  assert.match(report(clean), /^\| OB-1 \| OB-1 claim \| every recorded path \| Verified \|$/m);

  // An unknown path below an edge OB-1 covers, even when the unknown edge names another obligation.
  const deep = opened(root, ['src/orders.js#createOrder'], { slug: 'deep', now: at(30) });
  r = apply(root, deep, [
    add('/obligations', all(ob('OB-1', ['src/orders.js:4-9', 'src/events.js:3']))),
    add('/obligations', ob('OB-2', ['src/orders.js:7'], { status: 'out-of-scope', coverage: 'excluded', coverage_method: '' })),
    add('/census/edges', edge('G1', 'E1', 'src/events.js:3', 'event', 'src/orders.js:7')),
    add('/census/edges', edge('G2', 'G1', null, 'dynamic', 'src/events.js:3', 'unknown', { affects: ['OB-2'], reason: 'handlers are registered at runtime' })),
  ]);
  assert.match(errorsOf(r), /\$\.obligations\[0\]\.coverage: cannot be all-enumerated: census items G2 bear on it/);
  r = apply(root, deep, [
    { op: 'set', path: '/obligations/OB-1/coverage', value: 'named-subset' },
    add('/debt/out', { id: `${deep.result.run_id}/D1`, kind: 'frontier', refs: ['OB-1'], requires: 'find the subscribers of src/events.js:3 registered at runtime', priority: 'medium' }),
  ]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  // It may close complete (the process finished), but the coverage is never Verified and the gap is reported.
  assert.equal(close(root, deep, ['--status', 'complete'], at(39)).code, EXIT.OK);
  const text = report(deep);
  assert.match(text, /^\| OB-1 \| OB-1 claim \| every recorded path \| not verified \|$/m);
  assert.match(text, /2 paths: 1 covered by obligations, 0 excluded with a reason, 1 unknown \(not reviewed; handed on as debt\)/);
  const status = nthr(['status', '--ns', NS], { cwd: root });
  const debt = status.json.result.namespaces[0].debt;
  assert.deepEqual([debt.by_kind.frontier, debt.items[0].id], [1, `${deep.result.run_id}/D1`], 'status lists the unreviewed path as open debt');
});

test('hardening 3: a six-stage path counts depth from the entry; the frontier past the limit stays unknown and is handed on', (t) => {
  const root = project(t, SIX);
  const run = opened(root, ['app/routes.js#routes']);
  const stages = [
    edge('G1', 'E1', 'app/handler.js:2-4', 'route', 'app/routes.js:2'),
    edge('G2', 'G1', 'app/service.js:2-4', 'call', 'app/handler.js:3'),
    edge('G3', 'G2', 'app/repo.js:2-4', 'call', 'app/service.js:3'),
    edge('G4', 'G3', 'app/adapter.js:2-4', 'data', 'app/repo.js:3'),
  ];
  const evidence = ['app/routes.js:2', 'app/handler.js:2-4', 'app/service.js:2-4', 'app/repo.js:2-4', 'app/adapter.js:2-4'];
  let r = apply(root, run, [add('/obligations', ob('OB-1', evidence, { coverage: 'all-enumerated' })), ...stages.map((g) => add('/census/edges', g))]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  // Stage 6 (the driver) is depth 5: past max_depth 4, it can only be the recorded frontier.
  r = apply(root, run, [add('/census/edges', edge('G5', 'G4', 'app/driver.js:1-3', 'external', 'app/adapter.js:3'))]);
  assert.match(errorsOf(r), /census\.edges\[4\]\.status: an edge past max_depth 4 only records the frontier: it must be unknown/);
  r = apply(root, run, [
    { op: 'set', path: '/census/edges/G5/status', value: 'unknown' },
    { op: 'set', path: '/census/edges/G5/reason', value: 'depth limit: review the driver in its own flow run' },
    { op: 'set', path: '/census/edges/G5/affects', value: null },
  ]);
  assert.match(errorsOf(r), /\$\.obligations\[0\]\.coverage: cannot be all-enumerated: census items G5 bear on it/);
  r = apply(root, run, [{ op: 'set', path: '/obligations/OB-1/coverage', value: 'named-subset' }]);
  assert.equal(r.json.result.check.valid, true, errorsOf(r));
  // Nothing grows past the frontier.
  r = apply(root, run, [add('/census/edges', edge('G6', 'G5', 'app/driver.js:2', 'external', 'app/driver.js:2', 'unknown'))]);
  assert.match(errorsOf(r), /G5 is not a classified edge with a target/);
  assert.match(errorsOf(r), /is at depth 6, past max_depth 4/);
  r = apply(root, run, [{ op: 'remove', path: '/census/edges/G6' }]);
  assert.match(errorsOf(close(root, run)), /the unknown path G5 \(app\/adapter\.js:3\) needs frontier or deferred-scope debt/);
  apply(root, run, [add('/debt/out', { id: `${run.result.run_id}/D1`, kind: 'frontier', refs: ['OB-1'], requires: 'review the driver called at app/adapter.js:3', priority: 'medium' })]);
  assert.equal(close(root, run, ['--status', 'incomplete', '--reason', 'budget']).code, EXIT.OK);
  const text = fs.readFileSync(path.join(root, ...run.runDir.split('/'), 'report.md'), 'utf8');
  assert.match(text, /depth limit reached \(max_depth 4\): G5 only record the frontier/);
  assert.match(text, /^\| G5 \| G4 \| external \| app\/driver\.js:1-3 \| app\/adapter\.js:3 \| 5 \| unknown \| depth limit: review the driver in its own flow run \|$/m);
});

test('hardening 4: entry selectors stay tied to the code they resolved; edits, renames and resume never re-point them silently', (t) => {
  const root = project(t);
  // A line selector whose file changed: close refuses, and resume refuses to re-point it.
  const lineRun = opened(root, ['src/orders.js:4-9']);
  apply(root, lineRun, [add('/obligations', ob('OB-1', ['src/orders.js:4-9']))]);
  write(root, 'src/orders.js', lines('// a new header line shifts everything', SOURCE['src/orders.js']));
  rawGit(root, ['add', 'src/orders.js']);
  rawGit(root, ['commit', '-q', '-m', 'shift']);
  assert.match(close(root, lineRun).json.errors[0], /the tracked source changed since Open/);
  const plan = nthr(['resume', '--ns', NS], { cwd: root, now: at(10) });
  assert.equal(plan.code, EXIT.USAGE, JSON.stringify(plan.json));
  assert.match(plan.json.errors[0], /the files of line selectors src\/orders\.js:4-9 changed since Open, so those lines may now hold other code/);
  assert.equal(close(root, lineRun, ['--status', 'incomplete', '--reason', 'snapshot-changed']).code, EXIT.OK);

  // A symbol selector follows its definition: resume continues on the moved lines.
  const symRun = opened(root, ['src/store.js#saveOrder'], { slug: 'sym', now: at(20) });
  apply(root, symRun, [add('/obligations', ob('OB-1', ['src/store.js:1-3']))]);
  write(root, 'src/store.js', lines('// moved down', SOURCE['src/store.js']));
  commitAll(root, 'move');
  const symPlan = nthr(['resume', '--ns', NS], { cwd: root, now: at(30) });
  assert.equal(symPlan.code, EXIT.OK, JSON.stringify(symPlan.json));
  assert.deepEqual(symPlan.json.result.continuation.entries.map((e) => e.anchor), ['src/store.js:2-4']);

  // A renamed entry file: resolution refuses, never picks a similar name.
  const root2 = project(t);
  const renamed = opened(root2, ['src/store.js#saveOrder']);
  apply(root2, renamed, [add('/obligations', ob('OB-1', ['src/store.js:1-3']))]);
  rawGit(root2, ['mv', 'src/store.js', 'src/storage.js']);
  rawGit(root2, ['commit', '-q', '-m', 'rename']);
  const renamedPlan = nthr(['resume', '--ns', NS], { cwd: root2, now: at(10) });
  assert.equal(renamedPlan.code, EXIT.USAGE);
  assert.match(renamedPlan.json.errors.join('\n'), /src\/store\.js does not exist in the current source \(renamed or deleted\?\)/);
});

test('hardening 5: the flow budget is enforced: spending over it never closes complete, and limits are recomputed', (t) => {
  const root = project(t);
  const run = opened(root, ['src/store.js#saveOrder']);
  apply(root, run, [
    add('/obligations', ob('OB-1', ['src/store.js:1-3'])),
    { op: 'set', path: '/budget/spent/lead_tool_calls', value: 61 },
  ]);
  assert.match(errorsOf(close(root, run)), /\$\.budget\.spent\.lead_tool_calls: 61 exceeds the budget of 60; close as incomplete with reason budget/);
  assert.match(errorsOf(close(root, run, ['--status', 'incomplete', '--reason', 'open-obligations'])), /61 exceeds the budget of 60/);
  assert.equal(close(root, run, ['--status', 'incomplete', '--reason', 'budget']).code, EXIT.OK);
  // Subagent calls are capped the same way, and obligations at obligations_max + 20%.
  const run2 = opened(root, ['src/store.js#saveOrder'], { slug: 'two', now: at(20) });
  const r = apply(root, run2, [
    ...Array.from({ length: 25 }, (_, i) => add('/obligations', ob(`OB-${i + 1}`, ['src/store.js:1-3']))),
    { op: 'set', path: '/budget/spent/subagent_calls', value: 6 },
  ]);
  assert.match(errorsOf(r), /25 obligations exceed the outline cap of 24/);
  apply(root, run2, []);
  assert.match(errorsOf(close(root, run2, ['--status', 'complete'], at(29))), /\$\.budget\.spent\.subagent_calls: 6 exceeds the budget of 5/);
});

test('beta fix: a definition whose signature spans lines resolves to its whole body (TypeScript, a method, Python)', (t) => {
  const root = project(t, {
    'src/settle.ts': lines(
      'export const settle = async (',
      '  ctx: Ctx,',
      '  sent: Sent,',
      '  source: Source = defaults(sent),',
      '): Promise<Settled> => {',
      '  const base = { id: sent.id };',
      '  return write(ctx, base, source);',
      '};',
      '',
      'export const after = 1;',
    ),
    'src/service.ts': lines(
      'export class Ledger {',
      '  async record(',
      '    entry: Entry,',
      '  ): Promise<void> {',
      '    await this.store.append(entry);',
      '  }',
      '',
      '  close() {}',
      '}',
    ),
    'jobs/sync.py': lines('def sync(', '    batch,', '    retries=3,', '):', '    for item in batch:', '        push(item)', '', 'def other():', '    pass'),
    'src/odd.ts': lines('export function odd(a: string) { return "(" + a;', '}'),
  });
  const r = nthr(['resolve', '--entry', 'src/settle.ts#settle', '--entry', 'src/service.ts#Ledger.record', '--entry', 'jobs/sync.py#sync', '--entry', 'src/odd.ts#odd'], { cwd: root });
  assert.equal(r.json.result.resolved, true, JSON.stringify(r.json));
  assert.deepEqual(r.json.result.entries.map((e) => e.anchor), ['src/settle.ts:1-8', 'src/service.ts:2-6', 'jobs/sync.py:1-6', 'src/odd.ts:1-2']);
  // A call whose arguments span lines is never a definition: only a signature that opens a body is.
  write(root, 'src/caller.ts', lines('export function run(x: X) {', '  record(', '    x,', '  );', '}'));
  const call = nthr(['resolve', '--entry', 'src/caller.ts#record'], { cwd: root });
  assert.match(call.json.result.problems[0], /no definition of record in src\/caller\.ts/);
});
