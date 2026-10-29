// RQ-1 @3 (tests/RELEASE-GATE-3.md): the evaluator's rules on synthetic inputs.
// No session, no paid call. A missing row or input is BLOCKED, never a pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  GATE, ROW_IDS, checkRecords, evaluate, fixtureDeterminism, gateFileOk, judgeB12, judgeB7, offline, parseTap, sealedEvidence,
} from './tools/release-gate.mjs';
import { GATE_FILE, GATE_SHA256, PREVIOUS_GATES } from './tools/gate-version.mjs';
import { appendLedger } from './tools/matrix.mjs';
import { EVIDENCE_ABSENT, sealedEvidenceState } from './tools/evidence.mjs';
import { makeRepo } from './helpers/repo.mjs';
import { at, closeRun, nthr } from './helpers/runs.mjs';
import { REVIEW_DIR, makeTempDir } from './helpers/tmp.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const items = (ids) => ids.map((id) => ({ id, status: 'true-positive', details: { outcome_class: 'full' } }));
function row(id) {
  const shelf = id.startsWith('S');
  return {
    id,
    score: {
      official: 'yes',
      items: [...items(shelf ? ['E1', 'E2', 'E3', 'E4'] : ['P1', 'P2', 'P5', 'P6']), ...(shelf ? ['EN1', 'EN2'] : ['N1', 'N2']).map((c) => ({ id: c, status: 'correctly-held' }))],
      summary: {
        control_rule_hits: [], false_positive_findings_distinct: [], false_positives: 0, precision: 1, unsupported_confirmations: 0, mislocated: 0, wrong_mechanism: 0,
        coverage_recall_adjudicated: '8/8', population: { routes: { exact_adjudicated: 'exact' }, ledger_writers: { exact_adjudicated: 'exact' } }, incorrect_rejections: 0,
      },
      incremental: { meets_threshold: true },
      debt: id === 'D1' ? { status: 'incomplete', status_ok: true, open_obligations_without_debt: [], unverified_findings_without_debt: [] } : { passes: true, dispositioned: 8, debt_in: 8 },
      delegations: { recorded: 3, without_recovery: 3, within_one_recovery: 3 },
      g5: { checks: { meets_all: true } },
    },
    blind: {
      findings: { 'F-1': { verdict: 'valid', incorrect_claims: [], severity: 'appropriate', counterevidence_sound: null }, 'F-2': { verdict: 'false', incorrect_claims: [], severity: 'n/a', counterevidence_sound: true } },
      obligations: { 'OB-1': { conclusion: 'agree', missing_members: [] } },
    },
    records: {
      findings: [{ id: 'F-1', verdict: 'confirmed' }, { id: 'F-2', verdict: 'rejected' }],
      obligations: [{ id: 'OB-1', status: 'held', coverage: 'all-enumerated' }],
      budget: { lead_tool_calls: 70, subagent_calls: 5, spent: { lead_tool_calls: 40, subagent_calls: 3 } },
    },
    metrics: { routing: { violations: [] }, budget: { lead_tool_calls_after_open: 40 }, delegations: [{}, {}, {}] },
    check: { valid: true, errors: [] },
  };
}
const matrix = (edit = () => {}) => {
  const rows = new Map(ROW_IDS.map((id) => [id, row(id)]));
  edit(rows);
  return rows;
};
// B7 and B12 come from their judges (tested below); here, their results.
const EXTRA = { b7: { status: 'PASS', detail: 'x' }, b12: { status: 'PASS', detail: 'x' } };
const statuses = (r) => Object.fromEntries(Object.entries(r.criteria).map(([k, v]) => [k, v.status]));
const failing = (r) => Object.entries(statuses(r)).filter(([, s]) => s !== 'PASS').map(([k]) => k).sort();

test('the gate files: @1 and @2 frozen at their recorded sha256, @3 frozen at its pin, and every result names @3', () => {
  assert.deepEqual(PREVIOUS_GATES.map((g) => g.gate), ['nthr-release-gate@1', 'nthr-release-gate@2']);
  for (const g of PREVIOUS_GATES) assert.equal(sha256(fs.readFileSync(g.file)), g.sha256, `${g.gate} is unchanged`);
  assert.equal(GATE, 'nthr-release-gate@3');
  assert.equal(sha256(fs.readFileSync(GATE_FILE)), GATE_SHA256, 'RELEASE-GATE-3.md is the frozen text: a change is a new version');
  assert.equal(gateFileOk(), true);
  const r = evaluate(new Map());
  assert.equal(r.gate, 'nthr-release-gate@3');
  assert.equal(r.gate_file_sha256_ok, true);
  assert.equal(gateFileOk(GATE_FILE, '0'.repeat(64)), false);
});

test('no registered row: every review-judgment criterion is BLOCKED and the gate is not passed', () => {
  const r = evaluate(new Map());
  assert.ok(Object.values(r.criteria).every((c) => c.status === 'BLOCKED'), JSON.stringify(statuses(r)));
  assert.equal(r.verdict, 'NOT YET STABLE');
});

test('a full matrix meeting every threshold passes only with B7 and B12 from their evidence', () => {
  const r = evaluate(matrix());
  assert.deepEqual(Object.entries(statuses(r)).filter(([, s]) => s !== 'PASS'), [['B7', 'BLOCKED'], ['B12', 'BLOCKED']]);
  assert.equal(r.verdict, 'NOT YET STABLE');
  assert.equal(evaluate(matrix(), EXTRA).verdict, 'PASS');
});

test('each threshold fails on the evidence that breaks it, and only that criterion moves', () => {
  const cases = [
    ['B1', (rows) => { Object.assign(rows.get('L2').score.summary, { control_rule_hits: ['N1: F-9', 'P3: F-9'], false_positive_findings_distinct: ['F-9'] }); }],
    ['B1', (rows) => { rows.get('SO1').score.items.find((i) => i.id === 'EN1').status = 'false-positive'; }],
    ['B1', (rows) => { rows.get('SO2').score.summary.precision = 0.667; }],
    ['B2', (rows) => { rows.get('SO2').score.items = rows.get('SO2').score.items.filter((i) => !['E3', 'E4'].includes(i.id)); }],
    ['B3', (rows) => { rows.get('L1').blind.findings['F-1'].severity = 'understated'; }],
    ['B3', (rows) => { rows.get('SO1').score.summary.unsupported_confirmations = 1; }],
    ['B4', (rows) => { rows.get('I2d').score.incremental.meets_threshold = false; }],
    ['B5', (rows) => { rows.get('L1').score.summary.population.ledger_writers.exact_adjudicated = 'pending: a citing obligation is not agreed'; }],
    ['B5', (rows) => { rows.get('L2').blind.obligations['OB-1'].missing_members = ['api/src/x.js:4']; }],
    ['B5', (rows) => { rows.get('L2').score.summary.coverage_recall_adjudicated = '7/8'; }],
    ['B6', (rows) => { rows.get('D1').score.summary.incorrect_rejections = 1; }],
    ['B6', (rows) => { rows.get('I1c').blind.findings['F-2'].counterevidence_sound = false; }],
    ['B6', (rows) => { rows.get('SS1').metrics.routing.violations = ['opus at xhigh']; }],
    ['B9', (rows) => { rows.get('D2').score.debt.passes = false; }],
    ['B9', (rows) => { rows.get('I1r').check = { valid: false, errors: ['$.findings[0].verification.role: needs the R5 Opus refuter'] }; }],
    ['B10', (rows) => { for (const id of ['L1', 'L2']) rows.get(id).metrics.budget.lead_tool_calls_after_open = 71; }],
    ['B11', (rows) => { rows.get('SS2').score.g5.checks.meets_all = false; }],
    ['B11', (rows) => { rows.get('SS1').score.summary.unsupported_confirmations = 1; }],
    ['B11', (rows) => { rows.get('SS2').score.items.find((i) => i.id === 'EN2').status = 'false-positive'; }],
    // D1: the Sonnet rows' coverage and evidence, not only the comparison rule.
    ['B11', (rows) => { rows.get('SS1').score.summary.coverage_recall_adjudicated = '2/7'; }],
    ['B11', (rows) => { rows.get('SS2').score.summary.population.routes.exact_adjudicated = 'not exact'; }],
    ['B11', (rows) => { rows.get('SS1').blind.obligations['OB-1'].missing_members = ['src/x.js:3']; }],
  ];
  for (const [criterion, edit] of cases) {
    const r = evaluate(matrix(edit), EXTRA);
    // B8 requires B1-B5 in each repeated member, so it follows them.
    const expected = ['B1', 'B2', 'B3', 'B4', 'B5'].includes(criterion) ? [criterion, 'B8'] : [criterion];
    assert.deepEqual(failing(r), expected.sort(), `${criterion}: ${JSON.stringify(r.criteria[criterion])}`);
    assert.equal(r.verdict, 'NOT YET STABLE');
  }
  assert.match(evaluate(matrix((rows) => { rows.get('SS1').score.summary.coverage_recall_adjudicated = '2/7'; }), EXTRA).criteria.B11.detail, /SS1: not met \(misses coverage \(census 2\/7/);
  // A Rule 4 hit on a non-control item (P3) is an "other false", of which one is allowed; two distinct ones are not.
  const p3 = (rows) => Object.assign(rows.get('L1').score.summary, { control_rule_hits: ['P3: F-9'], false_positive_findings_distinct: ['F-9'], precision: 0.9 });
  assert.equal(evaluate(matrix(p3), EXTRA).criteria.B1.status, 'PASS');
  assert.equal(evaluate(matrix((rows) => Object.assign(rows.get('L1').score.summary, { false_positive_findings_distinct: ['F-8', 'F-9'], precision: 0.9 })), EXTRA).criteria.B1.status, 'FAIL');
  // 13 of 14 rows within budget is enough.
  assert.equal(evaluate(matrix((rows) => { rows.get('L1').metrics.budget.lead_tool_calls_after_open = 71; }), EXTRA).criteria.B10.status, 'PASS');
  // A failing Sonnet row is met only by removing the Sonnet lead allowance, and
  // only once both Sonnet rows were scored and one failed: never in their place.
  assert.equal(evaluate(matrix((rows) => { rows.get('SS2').score.g5.checks.meets_all = false; }), { ...EXTRA, b11_routing_removed: true }).criteria.B11.status, 'PASS');
  assert.equal(evaluate(matrix((rows) => { rows.delete('SS1'); rows.delete('SS2'); }), { ...EXTRA, b11_routing_removed: true }).criteria.B11.status, 'BLOCKED');
  assert.equal(evaluate(matrix((rows) => { rows.get('SS2').blind = null; }), { ...EXTRA, b11_routing_removed: true }).criteria.B11.status, 'BLOCKED');
  // Only an official score counts: a diagnostic (Rule 4 v2) or unverified one never does.
  const diagnostic = evaluate(matrix((rows) => { rows.get('L1').score.official = 'no: diagnostic evaluation (rule 4 v2), never an official score'; }), EXTRA);
  assert.deepEqual(failing(diagnostic), ['B1', 'B2', 'B3', 'B5', 'B6', 'B8', 'B9']);
  assert.match(diagnostic.criteria.B1.detail, /L1: not met \(the score is not official/);
  // B8 names the repeated pair that disagrees.
  assert.match(evaluate(matrix((rows) => { rows.get('I1r').score.incremental.meets_threshold = false; }), EXTRA).criteria.B8.detail, /I1r\/I2r/);
});

test('missing inputs block; they never count as met', () => {
  const r = evaluate(matrix((rows) => { rows.delete('SS2'); rows.get('L1').blind = null; rows.get('D1').check = null; }));
  for (const k of ['B3', 'B5', 'B9', 'B10', 'B11']) assert.equal(r.criteria[k].status, 'BLOCKED', k);
  assert.equal(evaluate(matrix((rows) => { rows.get('SS1').blind = null; }), EXTRA).criteria.B11.status, 'BLOCKED');
  // Metrics without routing data are missing evidence, not 0 routing violations.
  assert.equal(evaluate(matrix((rows) => { rows.get('L1').metrics = { budget: { lead_tool_calls_after_open: 40 } }; }), EXTRA).criteria.B6.status, 'BLOCKED');
  assert.equal(checkRecords(path.join(REVIEW_DIR, 'nowhere', 'records.json')), null, 'not a run records file');
});

// ---------------------------------------------------------------- B7

// A synthetic B7 world: a repeat ledger with a recorded package and its
// supplement, the package folder, the matrix root's evidence folder, and the
// two security rows. `testDouble` and the location are set by the caller.
function securityWorld(t, { testDouble = false } = {}) {
  const dir = makeTempDir(t, 'nthr-b7-');
  const pkg = path.join(dir, 'package');
  fs.mkdirSync(path.join(pkg, 'repos'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'answers.json'), '{"schema":"nthr-fixture-answers@1","heads":{".":"0000000000000000000000000000000000000000"}}');
  fs.writeFileSync(path.join(pkg, 'attestation.txt'), 'TEST DOUBLE\n');
  fs.writeFileSync(path.join(pkg, 'repos', 'root.bundle'), 'not a real bundle');
  const evidenceDir = path.join(dir, 'root', 'curated');
  fs.mkdirSync(path.join(evidenceDir, 'adjudications'), { recursive: true });
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const hash = (rel) => sha256(fs.readFileSync(path.join(pkg, rel)));
  const entries = [['answers.json', hash('answers.json')], ['attestation.txt', hash('attestation.txt')], ['repos/root.bundle', hash('repos/root.bundle')]];
  const packageSha = sha256(entries.map(([p, h]) => `${p} ${h}`).sort().join('\n'));
  appendLedger(ledgerFile, { event: 'registered', chains: [] });
  const cur = appendLedger(ledgerFile, { event: 'curated-package', package_sha256: packageSha, answers_sha256: entries[0][1], location_sha256: 'L', test_double: testDouble });
  appendLedger(ledgerFile, { event: 'registered-supplement', curated_seq: cur.seq, package_sha256: packageSha, answers_sha256: entries[0][1], test_double: testDouble });
  const rows = new Map();
  for (const id of ['SB1', 'SB2']) {
    const runId = `20261030-00000${id.at(-1)}-task-app`;
    const verdicts = `{"run":"${runId}"}`;
    fs.writeFileSync(path.join(evidenceDir, 'adjudications', `${runId}.blind.json`), verdicts);
    const score = {
      official: 'yes',
      items: [
        { id: 'C1', gate_dimension: 'security-boundary', expect: 'defect', status: 'true-positive', finding: 'F-1', details: { outcome_class: 'full' } },
        { id: 'G1', gate_dimension: 'security-boundary', expect: 'no-defect', status: 'correctly-held', finding: null, details: {} },
      ],
      summary: {},
    };
    const text = JSON.stringify(score);
    const records = { findings: [{ id: 'F-1', kind: 'defect', verdict: 'confirmed', impact_dimension: 'security' }] };
    const recordsSha256 = sha256(JSON.stringify(records));
    appendLedger(ledgerFile, { event: 'pre-run', row: id, answers: 'curated', answers_sha256: entries[0][1], package_sha256: packageSha });
    appendLedger(ledgerFile, { event: 'adjudication-frozen', row: id, run_id: runId, verdicts_sha256: sha256(verdicts), records_sha256: recordsSha256 });
    appendLedger(ledgerFile, { event: 'scored', row: id, run_id: runId, score_sha256: sha256(text) });
    rows.set(id, { id, score, scoreSha256: sha256(text), check: { valid: true, errors: [] }, metrics: { routing: { violations: [] } }, records, recordsSha256 });
  }
  return { rows, ledgerFile, curatedDir: pkg, evidenceDir, locate: () => ({ location_sha256: 'L', outside_kit: true, outside_git: true, outside_tmp: true }) };
}
const b7 = (w, edit = () => {}) => { edit(w); return judgeB7(w, { locate: w.locate }); };

test('B7 passes only on a recorded, registered, non-test-double package whose security rows meet every threshold', (t) => {
  assert.equal(b7(securityWorld(t)).status, 'PASS', JSON.stringify(b7(securityWorld(t))));
  // BLOCKED: no evidence, a test double, missing folders or rows.
  assert.equal(judgeB7({ rows: new Map() }).status, 'BLOCKED');
  assert.match(b7(securityWorld(t, { testDouble: true })).detail, /test double: it is never independent evidence/);
  assert.equal(b7(securityWorld(t), (w) => { w.curatedDir = null; }).status, 'BLOCKED');
  assert.equal(b7(securityWorld(t), (w) => { w.rows.delete('SB2'); }).status, 'BLOCKED');
  assert.equal(b7(securityWorld(t), (w) => { w.evidenceDir = null; }).status, 'BLOCKED');
  // Metrics without routing data, or a row whose scored attempt was voided, are not evidence.
  assert.equal(b7(securityWorld(t), (w) => { w.rows.get('SB1').metrics = {}; }).status, 'BLOCKED');
  const voided = b7(securityWorld(t), (w) => {
    const pre = fs.readFileSync(w.ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'pre-run' && e.row === 'SB2');
    appendLedger(w.ledgerFile, { event: 'voided', row: 'SB2', reason: 'test' });
    appendLedger(w.ledgerFile, { event: 'pre-run', row: 'SB2', answers: 'curated', answers_sha256: pre.answers_sha256, package_sha256: pre.package_sha256 });
  });
  assert.equal(voided.status, 'BLOCKED', JSON.stringify(voided));
  // The real location check refuses a package in the temporary folder.
  const real = securityWorld(t);
  assert.notEqual(judgeB7(real).status, 'PASS');
  // FAIL: the evidence contradicts the records, or a threshold is missed.
  const fails = [
    ['a crossing missed', (w) => { w.rows.get('SB1').score.items[0].details.outcome_class = 'partial'; }, /crossings not confirmed as security: C1/],
    ['a crossing confirmed at a lower impact', (w) => { w.rows.get('SB2').records.findings[0].impact_dimension = 'correctness'; }, /crossings not confirmed as security: C1/],
    ['a defense-in-depth gap confirmed as security', (w) => { w.rows.get('SB1').score.items[1].status = 'false-positive'; }, /gaps confirmed as security: G1/],
    ['check red', (w) => { w.rows.get('SB2').check = { valid: false, errors: ['x'] }; }, /check fails/],
    ['a routing violation', (w) => { w.rows.get('SB1').metrics.routing.violations = ['sonnet refuter on security']; }, /routing violations 1/],
    ['an unofficial score', (w) => { w.rows.get('SB1').score.official = 'no'; }, /not official/],
    ['no defense-in-depth item', (w) => { w.rows.get('SB2').score.items.pop(); }, /both are required/],
    ['a score file the ledger did not freeze', (w) => { w.rows.get('SB1').scoreSha256 = 'f'.repeat(64); }, /not the one the ledger froze/],
    ['a records file the adjudication did not freeze', (w) => { w.rows.get('SB2').recordsSha256 = 'f'.repeat(64); }, /records file is not the one the adjudication froze/],
    ['a changed package', (w) => { fs.appendFileSync(path.join(w.curatedDir, 'answers.json'), ' '); }, /changed|differs/],
    ['a moved package', (w) => { w.locate = () => ({ location_sha256: 'M', outside_kit: true, outside_git: true, outside_tmp: true }); }, /not the recorded one/],
  ];
  for (const [label, edit, why] of fails) {
    const r = b7(securityWorld(t), edit);
    assert.equal(r.status, 'FAIL', `${label}: ${JSON.stringify(r)}`);
    assert.match(r.detail, why, label);
  }
});

test('B7 in evaluate comes only from its judge: a typed PASS is ignored by the CLI', (t) => {
  const dir = makeTempDir(t, 'nthr-b7cli-');
  const manifestFile = path.join(dir, 'rows.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ rows: [], b7: { status: 'PASS', detail: 'typed' }, b12: { status: 'PASS', detail: 'typed' } }));
  const run = spawnSync(process.execPath, [path.join(REVIEW_DIR, 'tests', 'tools', 'release-gate.mjs'), 'evaluate', '--rows', manifestFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const res = JSON.parse(run.stdout);
  assert.equal(res.gate, 'nthr-release-gate@3');
  assert.equal(res.criteria.B7.status, 'BLOCKED');
  assert.equal(res.criteria.B12.status, 'BLOCKED');
  assert.deepEqual(res.ignored_inputs, ['b7', 'b12']);
});

// ---------------------------------------------------------------- B12

// Synthetic records and decisions, injected in place of the files.
function realRuns({ runs, decisions = {} }) {
  const docs = new Map(runs.map((r) => [r.run_id, r.doc]));
  return {
    manifest: { schema: 'nthr-b12-runs@1', runs: runs.map(({ doc, ...r }) => ({ project_root: '/p', ns: 'reviews/x', ...r })) },
    read: (root, ns, id) => ({ doc: docs.get(id), errors: [] }),
    decisions: (root, ns) => ({ doc: { decisions: (decisions[ns] ?? []).map(([fingerprint, decision], i) => ({ seq: i + 1, fingerprint, decision })) }, errors: [] }),
  };
}
const runDoc = (mode, status, fingerprints) => ({ run: { mode, status }, findings: fingerprints.map((fp, i) => ({ id: `F-${i + 1}`, fingerprint: fp, verdict: fp.endsWith('?') ? 'candidate' : 'confirmed' })) });
const runsOf = (...docs) => docs.map(([run_id, independence, doc, reason]) => ({ run_id, independence, doc, ...(reason ? { reason } : {}) }));
const b12 = (world) => judgeB12(world.manifest, { read: world.read, decisions: world.decisions });

test('B12 counts each confirmed finding of each independent Task or Incremental run, reports contaminated and ineligible runs, and needs 3 independent runs', () => {
  const runs = runsOf(
    ['r1', 'independent', runDoc('task', 'incomplete', ['a', 'b'])],
    ['r2', 'contaminated', runDoc('task', 'incomplete', ['a']), 'read r1\'s records before outlining'],
    ['r3', 'independent', runDoc('incremental', 'complete', ['c', 'd?'])],
    ['f1', 'independent', runDoc('flow', 'complete', ['e'])],
    ['o1', 'independent', runDoc('task', 'open', ['g'])],
    ['r4', 'independent', runDoc('task', 'incomplete', ['a', 'h', 'i'])],
  );
  const all = { 'reviews/x': [['a', 'fix'], ['b', 'accept'], ['c', 'false-positive'], ['h', 'known-item'], ['i', 'accept']] };
  const r = b12(realRuns({ runs, decisions: all }));
  assert.equal(r.status, 'PASS', r.detail);
  // 6 listed; r1, r2, r3, r4 completed; r1, r3, r4 counted; a counted twice (r1 and r4): 6 findings, 1 false positive.
  assert.match(r.detail, /^6 listed, 4 completed Task\/Incremental, 3 independent; not counted \(contaminated\): r2: read r1's records before outlining; not eligible: f1 \(flow, complete\), o1 \(task, open\); owner-judged false positives 1\/6 \(17%, at most 20%\)$/);
  // 2 of 6 is over 20%.
  assert.equal(b12(realRuns({ runs, decisions: { 'reviews/x': [...all['reviews/x'], ['h', 'false-positive']] } })).status, 'FAIL');
  // A later decision supersedes an earlier one.
  assert.equal(b12(realRuns({ runs, decisions: { 'reviews/x': [['c', 'false-positive'], ['c', 'accept'], ['a', 'fix'], ['b', 'fix'], ['h', 'false-positive'], ['i', 'fix']] } })).status, 'PASS');
  // An undecided counted finding blocks; an undecided contaminated or candidate one does not count.
  const undecided = b12(realRuns({ runs, decisions: { 'reviews/x': all['reviews/x'].filter(([fp]) => fp !== 'i') } }));
  assert.equal(undecided.status, 'BLOCKED');
  assert.match(undecided.detail, /1 of 6 counted findings have no owner decision: r4 F-3/);
  // Fewer than 3 independent runs block, however many contaminated ones there are.
  const two = b12(realRuns({ runs: runs.filter((x) => x.run_id !== 'r4'), decisions: all }));
  assert.equal(two.status, 'BLOCKED');
  assert.match(two.detail, /5 listed, 3 completed Task\/Incremental, 2 independent.*at least 3 independent runs are required/);
});

test('B12 blocks on invalid or missing input and on runs without confirmed findings', () => {
  assert.equal(judgeB12(null).status, 'BLOCKED');
  assert.equal(judgeB12({ schema: 'other', runs: [] }).status, 'BLOCKED');
  const noReason = runsOf(['r1', 'contaminated', runDoc('task', 'complete', ['a'])]);
  assert.match(b12(realRuns({ runs: noReason })).detail, /a contaminated run needs its reason/);
  const undeclared = runsOf(['r1', 'maybe', runDoc('task', 'complete', ['a'])]);
  assert.match(b12(realRuns({ runs: undeclared })).detail, /independence must be independent or contaminated/);
  const empty = runsOf(['r1', 'independent', runDoc('task', 'complete', [])], ['r2', 'independent', runDoc('task', 'complete', ['x?'])], ['r3', 'independent', runDoc('task', 'complete', [])]);
  assert.match(b12(realRuns({ runs: empty })).detail, /hold no confirmed finding, so there is no precision evidence/);
  const missing = realRuns({ runs: runsOf(['r1', 'independent', runDoc('task', 'complete', ['a'])]) });
  missing.read = () => ({ doc: undefined, errors: ['$: records.json is missing'] });
  assert.match(b12(missing).detail, /r1: cannot be read/);
  // One run listed three times, under any spelling of its root, is one run.
  const many = runDoc('task', 'complete', ['a', 'b', 'c', 'd', 'e']);
  const thrice = realRuns({ runs: runsOf(['r1', 'independent', many], ['r1', 'independent', many], ['r1', 'independent', many]), decisions: { 'reviews/x': ['a', 'b', 'c', 'd', 'e'].map((fp) => [fp, 'fix']) } });
  assert.match(b12(thrice).detail, /r1: listed more than once/);
  thrice.manifest.runs[1].project_root = '/P/';
  thrice.manifest.runs[2].project_root = '/p/.';
  const spelled = b12(thrice);
  assert.equal(spelled.status, 'BLOCKED');
  assert.match(spelled.detail, /r1: listed more than once/);
});

test('B12 on real files: closed runs and decisions recorded with `nthr decide`, read only', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t, 'nthr-b12-'), { 'src/a.js': 'a\n' }));
  const ns = 'reviews/b12';
  const ids = [];
  for (const [n, fp] of [[1, 'x/one'], [2, 'x/two'], [3, 'x/three']]) {
    const opened = nthr(['new-run', '--ns', ns, '--mode', 'task', '--slug', `r${n}`, '--change', '.:HEAD..HEAD'], { cwd: root, now: at(n * 10) });
    assert.equal(opened.code, 0, JSON.stringify(opened.json));
    closeRun(root, opened.json.result.run_dir, { status: 'incomplete', reason: 'open-obligations', edit: (doc) => {
      doc.findings = [{ id: 'F-1', fingerprint: fp, kind: 'defect', verdict: 'confirmed', severity: 'low', impact_dimension: 'correctness', obligation: null, summary: 's', trace: [], counterevidence: [], validation_plan: null, verification: { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }, decision: 'pending' }];
    } });
    ids.push(opened.json.result.run_id);
  }
  const manifest = { schema: 'nthr-b12-runs@1', runs: ids.map((run_id) => ({ project_root: root, ns, run_id, independence: 'independent' })) };
  const before = fs.readFileSync(path.join(root, '.nth-review', 'reviews', 'b12', 'runs', ids[0], 'records.json'));
  assert.match(judgeB12(manifest).detail, /3 of 3 counted findings have no owner decision/);
  for (const fp of ['x/one', 'x/two', 'x/three']) {
    const d = nthr(['decide', '--ns', ns, '--fingerprint', fp, '--decision', 'fix', '--note', 'test', '--by', 'test'], { cwd: root, now: at(50) });
    assert.equal(d.code, 0, JSON.stringify(d.json));
  }
  const r = judgeB12(manifest);
  assert.equal(r.status, 'PASS', r.detail);
  assert.match(r.detail, /false positives 0\/3/);
  assert.deepEqual(fs.readFileSync(path.join(root, '.nth-review', 'reviews', 'b12', 'runs', ids[0], 'records.json')), before, 'read only');
});

// ---------------------------------------------------------------- Part A

test('A5 builds every fixture twice: sealed heads and byte-identical trees, or FAIL', () => {
  const answers = (n) => JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, 'tests', 'fixtures', n, 'answers.json'), 'utf8'));
  const sealed = { 'syn-ledger': answers('syn-ledger').heads, 'syn-debt': answers('syn-debt').heads, 'syn-shelf': answers('syn-shelf').heads };
  const inc = answers('syn-ledger-inc').heads;
  const headsOf = (name) => sealed[name] ?? inc[{ 'syn-ledger-inc': 'committed', 'syn-ledger-inc-rewritten': 'rewritten', 'syn-ledger-inc-dirty': 'dirty' }[name]];
  const built = [];
  const fake = (bad = {}) => (name, outDir, from) => {
    built.push([name, Boolean(from)]);
    const second = outDir.endsWith('-2');
    return { heads: bad.heads === name ? { '.': '0'.repeat(40) } : headsOf(name), manifest: { 'a.txt': bad.tree === name && second ? 'changed' : 'same' }, dir: outDir };
  };
  assert.equal(fixtureDeterminism({ build: fake() }).status, 'PASS');
  assert.deepEqual(built.filter(([, from]) => from).map(([n]) => n).sort(), ['syn-ledger-inc', 'syn-ledger-inc', 'syn-ledger-inc-dirty', 'syn-ledger-inc-dirty', 'syn-ledger-inc-rewritten', 'syn-ledger-inc-rewritten']);
  assert.equal(built.length, 12, 'six builds, twice each');
  assert.match(fixtureDeterminism({ build: fake({ tree: 'syn-debt' }) }).detail, /syn-debt: sealed heads, trees differ/);
  assert.equal(fixtureDeterminism({ build: fake({ heads: 'syn-shelf' }) }).status, 'FAIL');
  assert.match(fixtureDeterminism({ build: () => { throw new Error('boom'); } }).detail, /a build failed: boom/);
});

test('Part A: A4 is UNVERIFIED in a copy without the sealed G5 evidence, and FAIL with only part of it', (t) => {
  const copy = makeTempDir(t, 'nthr-gate-');
  fs.cpSync(path.join(REVIEW_DIR, 'tests', 'fixtures', 'syn-debt', 'answers.json'), path.join(copy, 'tests', 'fixtures', 'syn-debt', 'answers.json'), { recursive: true });
  assert.deepEqual([sealedEvidenceState(copy), sealedEvidence(copy).status, sealedEvidence(copy).detail], ['absent', 'UNVERIFIED', EVIDENCE_ABSENT]);
  for (const part of [['g5-ledger.jsonl'], ['syn-debt', 'reports', 'x.json']]) {
    const partial = makeTempDir(t, 'nthr-gate-');
    fs.mkdirSync(path.join(partial, 'tests', 'fixtures', ...part.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(partial, 'tests', 'fixtures', ...part), '{}\n');
    assert.deepEqual([sealedEvidenceState(partial), sealedEvidence(partial).status], ['partial', 'FAIL'], part.join('/'));
  }
});

test('Part A: the sealed G5 evidence verifies, and one changed byte in it fails A4', (t) => {
  const state = sealedEvidenceState();
  if (state === 'absent') { t.skip(EVIDENCE_ABSENT); return; }
  assert.equal(state, 'present');
  assert.equal(sealedEvidence().status, 'PASS', sealedEvidence().detail);
  const copy = makeTempDir(t, 'nthr-gate-');
  fs.cpSync(path.join(REVIEW_DIR, 'tests', 'fixtures'), path.join(copy, 'tests', 'fixtures'), { recursive: true });
  const target = path.join(copy, 'tests', 'fixtures', 'syn-ledger', 'adjudications', '20261027-030324-task-ledger.blind.json');
  fs.appendFileSync(target, ' ');
  const tampered = sealedEvidence(copy);
  assert.equal(tampered.status, 'FAIL');
  assert.match(tampered.detail, /20261027-030324-task-ledger\.blind\.json/);
});

test('Part A: saved test output decides A1, A2 and the named checks; none saved is UNVERIFIED, a failure is FAIL', () => {
  const tap = (fail, names) => `TAP version 13\n${names.map((n, i) => `ok ${i + 1} - ${n}`).join('\n')}\nok 99 - x # SKIP Windows has no executable bit\n# tests ${names.length + 1 + fail}\n# pass ${names.length}\n# fail ${fail}\n# skipped 1\n`;
  const names = ['A4: a cited untracked file edited after the evidence x', 'S-A7: evidence on a file absent at the origin x', 'lifecycle: x',
    'hardening 2: complete is process status, Verified is coverage x', 'A2: an obligation is never held while its own defect x', 'A1: a refuter-decided defect follows the refuter x'];
  const parsed = parseTap(tap(0, names));
  assert.deepEqual([parsed.tests, parsed.pass, parsed.fail, parsed.skips[0].reason], [7, 6, 0, 'Windows has no executable bit']);
  const a5 = () => ({ status: 'PASS', detail: 'stub' });
  const none = offline({ a5 });
  assert.equal(none.criteria.A1.status, 'UNVERIFIED');
  assert.equal(none.verdict, 'NOT YET STABLE');
  assert.equal(none.gate, 'nthr-release-gate@3');
  const good = offline({ a5, a4: a5, taps: { 'windows-gitbash': tap(0, names), 'windows-powershell': tap(0, names), 'linux-node20': tap(0, names), 'linux-node22': tap(0, names) }, rehearsal: '75 rows: 72 pass, 0 fail, 3 unverified' }); // A4 has its own tests above
  assert.deepEqual(Object.entries(statuses(good)).filter(([, s]) => s !== 'PASS'), []);
  const bad = offline({ a5, taps: { 'windows-gitbash': tap(1, names), 'windows-powershell': tap(0, names), 'linux-node20': tap(0, names.slice(1)), 'linux-node22': tap(0, names) } });
  assert.equal(bad.criteria.A1.status, 'FAIL');
  assert.equal(bad.criteria.A8.status, 'FAIL', 'a named test missing on one platform');
  assert.equal(offline({ a5: () => ({ status: 'FAIL', detail: 'x' }) }).criteria.A5.status, 'FAIL');
});
