// VS1 preparation: the fixture builder and the verifier. The actual review
// runs later, in an isolated Opus High session (owner decision); here a
// synthetic, correct review proves the verifier accepts a passing run and
// rejects each failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { makeRepo } from './helpers/repo.mjs';
import { at, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { REVIEW_DIR, makeTempDir, rawGit } from './helpers/tmp.mjs';
import { CONTROL, PLANTED, RUNTIME_FILES, SKILL_PATH, VS1, VS1_COMMAND, buildVs1Fixture, symbolLines } from './vs1/fixture.mjs';
import { recordCriteria, verifyVs1 } from './vs1/verify.mjs';

const listFiles = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();

test('the fixture: two repositories with one change each, a project-level skill of runtime files only, no answer hints', (t) => {
  const root = buildVs1Fixture(path.join(makeTempDir(t), 'vs1'));
  for (const repo of ['api', 'web']) {
    assert.equal(rawGit(path.join(root, repo), ['rev-list', '--count', 'HEAD']).trim(), '2', `${repo}: base and change commits`);
    assert.equal(rawGit(path.join(root, repo), ['status', '--porcelain']), '', `${repo} is clean`);
  }
  assert.throws(() => rawGit(root, ['rev-parse', '--git-dir']), 'the fixture root is not a repository');
  assert.deepEqual(rawGit(path.join(root, 'api'), ['diff', '--name-only', 'HEAD~1', 'HEAD']).trim().split('\n').sort(),
    ['src/routes/index.js', 'src/routes/invoices.js', 'src/routes/orders.js']);

  // The skill copy is exactly the runtime files, byte for byte.
  const skill = path.join(root, ...SKILL_PATH.split('/'));
  const expected = RUNTIME_FILES.flatMap((entry) => {
    const source = path.join(REVIEW_DIR, entry);
    return fs.statSync(source).isDirectory() ? listFiles(source).map((f) => `${entry}/${f}`) : [entry];
  }).sort();
  assert.deepEqual(listFiles(skill), expected);
  for (const rel of expected) {
    assert.ok(fs.readFileSync(path.join(skill, rel)).equals(fs.readFileSync(path.join(REVIEW_DIR, rel))), rel);
  }
  assert.ok(!expected.some((f) => f.startsWith('tests/') || f === 'VALIDATION.md'));

  // Nothing in the reviewed code points at the answer.
  for (const repo of ['api', 'web']) {
    for (const rel of listFiles(path.join(root, repo)).filter((f) => !f.startsWith('.git/'))) {
      const text = fs.readFileSync(path.join(root, repo, rel), 'utf8');
      assert.ok(!/planted|insecure|vulnerab|idor|negative control|expected answer|todo|fixme|\bbug\b|\bvs1\b/i.test(text), `${repo}/${rel}`);
    }
  }
  assert.deepEqual(symbolLines(path.join(root, ...PLANTED.path.split('/')), PLANTED.symbol), [5, 10]);
  assert.deepEqual(symbolLines(path.join(root, ...CONTROL.path.split('/')), CONTROL.symbol), [5, 10]);
  assert.equal(VS1_COMMAND, '/nth-review task --ns experiments/vs1 --slug vs1 --change api:HEAD~1..HEAD --change web:HEAD~1..HEAD');

  // The command opens a check-valid run in the fixture (then it is left alone).
  const opened = nthr(['new-run', '--ns', VS1.ns, '--mode', 'task', '--slug', VS1.slug, ...VS1.changes.flatMap((c) => ['--change', c])], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  // api: orders 10 + invoices 10 + route table 5; web: two pages of 6.
  assert.deepEqual(opened.json.result.size, { class: 'S', files: 5, lines: 37, verified: true });
  assert.equal(nthr(['check', '--run', opened.json.result.run_dir], { cwd: root }).code, EXIT.OK);
});

test('the builder refuses a non-empty directory and one inside a repository', (t) => {
  const base = makeTempDir(t);
  fs.writeFileSync(path.join(base, 'something'), 'x');
  assert.throws(() => buildVs1Fixture(base), /is not empty/);
  const repo = makeRepo(path.join(makeTempDir(t), 'repo'));
  assert.throws(() => buildVs1Fixture(path.join(repo, 'inner')), /inside a git working tree/);
});

// A correct review of the fixture, as the skill would record it.
function synthesizeReview(root) {
  const opened = nthr(['new-run', '--ns', VS1.ns, '--mode', 'task', '--slug', VS1.slug, ...VS1.changes.flatMap((c) => ['--change', c])], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  Object.assign(doc.run.runtime, { required_lead_model: 'opus-high', lead_model: 'claude-opus-5-5', lead_effort: 'high', triggers: ['authorization'] });
  doc.scope.summary = 'Task Review of the order and invoice routes and pages.';
  doc.scope.intent = [{ id: 'I1', anchor: 'api/docs/authorization.md#Resource ownership', note: 'ownership check before use' }];
  const ob = (id, claim, status, evidence, links) => ({
    id, checks: ['AUTHZ'], claim, scope: 'GET by id', acceptance: 'accountId is compared with the session before use',
    coverage: 'all-enumerated', coverage_method: 'the route table in api/src/routes/index.js', status, open_reason: null, source_trace: 'consistent',
    evidence: [{ anchor: evidence, note: 'handler' }], intent: ['I1'],
    assumptions: [{ kind: 'dependency', anchor: 'api/src/session.js:7-16', fact: null, observed: null, note: 'requireSession' }], links,
  });
  doc.obligations = [
    ob('OB-1', 'GET /orders/:id returns only the caller\'s orders.', 'held', 'api/src/routes/orders.js:5-10', []),
    ob('OB-2', 'GET /invoices/:id returns only the caller\'s invoices.', 'violated', 'api/src/routes/invoices.js:5-10', ['F-1']),
  ];
  doc.census.recipes = [{ id: 'C2', pattern: 'callers of getOrder and getInvoice', scope: 'api, web', hits: 4, limits: 'dynamic route registration would be missed' }];
  doc.census.items = [
    ['api/src/routes/index.js', 'route table', ['OB-1', 'OB-2']],
    ['api/src/routes/orders.js', 'route GET /orders/:id', ['OB-1']],
    ['api/src/routes/invoices.js', 'route GET /invoices/:id', ['OB-2']],
    ['web/src/pages/order.js', 'client call', ['OB-1']],
    ['web/src/pages/invoice.js', 'client call', ['OB-2']],
  ].map(([p, mechanism, affects], i) => ({ id: `CI-${i + 1}`, path: p, mechanism, status: 'classified', reason: null, affects }));
  doc.findings = [{
    id: 'F-1', fingerprint: 'api/invoices/ownership', kind: 'defect', verdict: 'confirmed', severity: 'high', impact_dimension: 'security',
    obligation: 'OB-2', summary: 'Any session can read any invoice: getInvoice never compares accountId with the session.',
    trace: [
      { role: 'entrypoint', anchor: 'api/src/routes/index.js:7', note: 'GET /invoices/:id' },
      { role: 'sink', anchor: 'api/src/routes/invoices.js:6-9', note: 'returns the invoice without an ownership check' },
    ],
    counterevidence: [], validation_plan: null,
    verification: { role: 'R5', model: 'opus', outcome: 'confirmed', corrections: null, incomplete: false }, decision: 'pending',
  }];
  doc.delegations = [
    { role: 'R3', agent: 'Explore', model: 'sonnet', effort: null, budget_calls: 30, tool_uses: 12, tokens: 41000, completed: true, recovery_messages: 0 },
    { role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: 5, tokens: 52000, completed: true, recovery_messages: 0 },
  ];
  doc.budget.spent = { lead_tool_calls: 24, subagent_calls: 2, subagent_tokens: 93000, lead_tokens_observed: null, wall_clock_min: 14 };
  writeRecords(root, runDir, doc);
  assert.equal(nthr(['pack', '--run', runDir, '--for', 'F-1'], { cwd: root }).code, EXIT.OK);
  const closed = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(2) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  return { runDir, doc: readRecords(root, runDir) };
}

test('verify: a correct synthetic review passes every criterion', (t) => {
  const root = buildVs1Fixture(path.join(makeTempDir(t), 'vs1'));
  const { runDir } = synthesizeReview(root);
  const result = verifyVs1(root);
  assert.equal(result.run, runDir.slice('.nth-review/'.length));
  assert.deepEqual(result.criteria.filter((c) => !c.pass), []);
  assert.deepEqual(result.criteria.map((c) => c.id), [
    'closed-run', 'check-passes', 'lead-opus-high', 'plan-critique', 'planted-confirmed', 'evidence-first',
    'control-not-confirmed', 'delegations-complete', 'second-close-refused',
  ]);
  assert.equal(result.pass, true);
  // The verifier changed nothing.
  assert.equal(readRecords(root, runDir).run.status, 'complete');
});

test('verify: each failure is caught by its criterion', (t) => {
  const root = buildVs1Fixture(path.join(makeTempDir(t), 'vs1'));
  const { doc } = synthesizeReview(root);
  const ranges = { planted: [5, 10], control: [5, 10], packExists: () => true };
  const failing = (mutate, options = {}) => {
    const copy = structuredClone(doc);
    mutate(copy);
    return recordCriteria(copy, { ...ranges, ...options }).filter((c) => !c.pass).map((c) => c.id);
  };
  assert.deepEqual(failing(() => {}), []);
  assert.deepEqual(failing((d) => { d.run.runtime.lead_model = 'claude-sonnet-5-5'; }), ['lead-opus-high']);
  assert.deepEqual(failing((d) => { d.run.runtime.lead_effort = 'xhigh'; }), ['lead-opus-high']);
  assert.deepEqual(failing((d) => { d.delegations.shift(); }), ['plan-critique']);
  assert.deepEqual(failing((d) => { Object.assign(d.findings[0].verification, { role: 'R6', model: 'sonnet' }); }), ['planted-confirmed', 'evidence-first']);
  assert.deepEqual(failing((d) => { d.findings[0].verdict = 'candidate'; }), ['planted-confirmed', 'evidence-first']);
  assert.deepEqual(failing(() => {}, { packExists: () => false }), ['evidence-first']);
  assert.deepEqual(failing((d) => {
    d.findings.push({ ...structuredClone(d.findings[0]), id: 'F-2', trace: [{ role: 'sink', anchor: 'api/src/routes/orders.js:8', note: 'x' }] });
  }), ['control-not-confirmed']);
  assert.deepEqual(failing((d) => { d.delegations[1].recovery_messages = 2; }), ['delegations-complete']);
  assert.deepEqual(failing((d) => { d.delegations[1].completed = false; }), ['delegations-complete']);
});
