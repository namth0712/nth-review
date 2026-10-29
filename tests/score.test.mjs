// M5-T3: the scorer, on hand-made records against the sealed answers and a
// freshly built fixture. A perfect record scores 100%; each defective record
// loses exactly the credit the README criteria say.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildFixture, heads } from './fixtures/build.mjs';
import { BLIND_SCHEMA, debtCheck, evidenceRefs, freshnessCheck, observedCost, overlaps, parseAnchor, score, treeDigest, versionCheck } from './tools/score.mjs';
import { REVIEW_DIR } from './helpers/tmp.mjs';

const FIX = path.join(REVIEW_DIR, 'tests', 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIX, name, 'answers.json'));
const LEDGER_TEXT = read('syn-ledger');
const LEDGER = JSON.parse(LEDGER_TEXT);
const SHA = crypto.createHash('sha256').update(LEDGER_TEXT).digest('hex');
const DEBT = JSON.parse(read('syn-debt'));
const INC = JSON.parse(read('syn-ledger-inc'));
const item = (id, doc = LEDGER) => doc.items.find((i) => i.id === id);
const at = (a) => `${a.path}:${a.lines[0]}${a.lines[1] !== a.lines[0] ? `-${a.lines[1]}` : ''}`;
const role = (id, r, doc = LEDGER) => item(id, doc).anchors.filter((a) => a.role === r);

let root;
let fixture;
let debtFixture;
let incFixture;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-s-'));
  fixture = buildFixture('syn-ledger', path.join(root, 'ledger')).fixture;
  debtFixture = buildFixture('syn-debt', path.join(root, 'debt')).fixture;
  incFixture = buildFixture('syn-ledger-inc', path.join(root, 'inc')).fixture;
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

// A finding whose trace is the item's entrypoint (if any), site and sink anchors.
function findingFor(id, fid, { verdict = 'confirmed', kind = item(id).expect === 'doc-drift' ? 'doc-drift' : 'defect', obligation, trace } = {}) {
  const it = item(id);
  const t = trace ?? it.anchors.filter((a) => ['entrypoint', 'propagation', 'site', 'sink'].includes(a.role)).map((a) => ({ role: a.role === 'site' ? 'propagation' : a.role, anchor: at(a), note: 'n' }));
  return { id: fid, fingerprint: fid, kind, verdict, severity: 'high', impact_dimension: 'security', obligation: obligation ?? `OB-${fid}`, summary: 's', trace: t, counterevidence: [], validation_plan: null, verification: { role: 'R5', model: 'opus', outcome: verdict === 'rejected' ? 'rejected' : 'confirmed', corrections: null, incomplete: false }, decision: 'pending' };
}
// An obligation citing the item's required evidence (rules through their headings).
function obligationFor(id, oid, { status = 'violated', checks = item(id).checks, evidence } = {}) {
  const it = item(id);
  const ev = evidence ?? it.required_evidence.map((e) => it.anchors[e.anchor_ref]).filter((a) => a.role !== 'rule').map((a) => ({ anchor: at(a), note: 'n' }));
  const rules = it.required_evidence.map((e) => it.anchors[e.anchor_ref]).filter((a) => a.role === 'rule');
  return { id: oid, checks, claim: 'c', acceptance: 'a', scope: 's', coverage: 'all-enumerated', coverage_method: 'm', status, open_reason: status === 'open' ? 'verification' : null, source_trace: 'consistent', evidence: ev, intent: rules.map((_, i) => `I-${oid}-${i}`), links: [], assumptions: [], _rules: rules };
}
function perfectRecords(dir, debt = false) {
  const h = heads(dir);
  const findings = [findingFor('P1', 'F-1'), findingFor('P2', 'F-2'), findingFor('P5', 'F-3'), findingFor('P6', 'F-4')];
  const obligations = [obligationFor('P1', 'OB-F-1'), obligationFor('P2', 'OB-F-2'), obligationFor('P5', 'OB-F-3'), obligationFor('P6', 'OB-F-4'),
    obligationFor('N1', 'OB-N1', { status: 'held', evidence: role('N1', 'site').map((a) => ({ anchor: at(a), note: 'n' })) }),
    obligationFor('N2', 'OB-N2', { status: 'held', evidence: [...role('N2', 'site'), ...role('N2', 'refutation')].map((a) => ({ anchor: at(a), note: 'n' })) })];
  const headingOf = (rule) => {
    const lines = fs.readFileSync(path.join(dir, ...rule.path.split('/')), 'utf8').split('\n');
    for (let i = rule.lines[0] - 1; i >= 0; i -= 1) if (/^#{1,6}\s/.test(lines[i])) return lines[i].replace(/^#{1,6}\s+/, '').trim();
    return null;
  };
  const intent = obligations.flatMap((o) => o._rules.map((r, i) => ({ id: `I-${o.id}-${i}`, anchor: `${r.path}#${headingOf(r)}`, note: 'rule' })));
  for (const o of obligations) delete o._rules;
  const census = LEDGER.census.mechanisms.map((m, i) => ({ id: `CI-${i}`, path: m.path, mechanism: m.kind, status: 'classified', reason: null, affects: null }));
  const writers = LEDGER.census.population.ledger_writers.members.map((m) => ({ anchor: at(m), note: 'writer' }));
  const routes = LEDGER.census.population.routes.members.map((m) => ({ anchor: at(m), note: 'route' }));
  obligations.push(obligationFor('P2', 'OB-POP', { status: 'held', checks: ['ATOMIC.1'], evidence: [...writers, ...routes] }));
  return {
    run: { id: 'r1', mode: 'task', status: 'complete', incomplete_reason: null, opened: '2026-10-26T15:00:00Z', closed: '2026-10-26T15:10:00Z' },
    snapshot: { repos: Object.entries(h).map(([p, head]) => ({ path: p, head })) },
    scope: { intent },
    obligations,
    findings: debt ? [] : findings,
    census: { items: census },
    delegations: [{ role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', completed: true, recovery_messages: 0, tool_uses: 5, tokens: 100 }],
    budget: { lead_tool_calls: 70, subagent_calls: 5, spent: { lead_tool_calls: 40, subagent_calls: 1 } },
    debt: { in: [], out: [] },
  };
}
const facts = (id) => item(id).mechanism_facts.map(() => true);
const adjudication = (extra = {}) => ({
  schema: 'nthr-adjudication@1', fixture: 'syn-ledger', run: 'r1', answers_sha256: SHA, adjudicator: 'test', independent: true,
  items: { P1: { finding: 'F-1', mechanism_facts: facts('P1'), wrong_claims: [] }, P2: { finding: 'F-2', mechanism_facts: facts('P2'), wrong_claims: [] }, P5: { finding: 'F-3', mechanism_facts: facts('P5'), wrong_claims: [] }, P6: { finding: 'F-4', mechanism_facts: facts('P6'), wrong_claims: [] }, ...extra.items },
  findings: { ...extra.findings },
});
const scoreOf = (records, adj = adjudication(), answers = LEDGER, sha = SHA, dir = fixture) => score({ answers, answersSha256: sha, records, fixture: dir, adjudication: adj });
const statusOf = (s) => Object.fromEntries(s.items.map((r) => [r.id, r.status]));

test('anchors: parsing and the 3-line tolerance', () => {
  assert.deepEqual(parseAnchor('a/b.js:3-7'), { path: 'a/b.js', lines: [3, 7], heading: null });
  assert.deepEqual(parseAnchor('docs/a.md#Two words'), { path: 'docs/a.md', lines: null, heading: 'Two words' });
  assert.ok(overlaps(parseAnchor('x:10'), parseAnchor('x:13-14'), 3));
  assert.ok(!overlaps(parseAnchor('x:10'), parseAnchor('x:14'), 3));
  assert.ok(!overlaps(parseAnchor('x:10'), parseAnchor('y:10'), 3));
});

test('a perfect record scores 100%: four true positives, both controls, full census and populations', () => {
  const s = scoreOf(perfectRecords(fixture));
  assert.equal(s.official, 'yes');
  assert.equal(s.version.status, 'verified');
  const st = statusOf(s);
  for (const id of ['P1', 'P2', 'P5', 'P6']) assert.equal(st[id], 'true-positive', id);
  for (const id of ['P3', 'P4']) assert.equal(st[id], 'covered', id);
  assert.equal(st.N1, 'correctly-held');
  assert.equal(st.N2, 'correctly-held');
  assert.equal(s.summary.true_positives, 4);
  assert.equal(s.summary.false_positives, 0);
  assert.equal(s.summary.precision, 1);
  assert.equal(s.summary.coverage_recall, `${LEDGER.census.mechanisms.length}/${LEDGER.census.mechanisms.length}`);
  assert.equal(s.summary.population.ledger_writers.cited, 4);
  assert.equal(s.summary.population.routes.cited, 5);
  assert.deepEqual(s.summary.unresolved_adjudications, []);
  assert.match(s.g5['finding-accuracy (this run)'], /^met/);
});

test('without adjudication a located match is pending, never full credit', () => {
  const s = scoreOf(perfectRecords(fixture), null);
  assert.equal(statusOf(s).P1, 'pending-adjudication');
  assert.equal(s.summary.true_positives, 0);
  assert.ok(s.summary.unresolved_adjudications.some((x) => x.startsWith('P1')));
});

test('duplicates: two findings on one planted defect earn one true positive; the other waits for adjudication', () => {
  const r = perfectRecords(fixture);
  r.findings.push(findingFor('P1', 'F-9', { obligation: 'OB-F-1' }));
  const s = scoreOf(r);
  assert.equal(s.summary.true_positives, 4);
  const extra = s.unmatched_findings.find((u) => u.id === 'F-9');
  assert.deepEqual(extra.overlaps_items, ['P1']);
  assert.equal(extra.adjudication, 'pending');
  const adjudicated = scoreOf(r, adjudication({ findings: { 'F-9': { verdict: 'duplicate-of F-1' } } }));
  assert.equal(adjudicated.summary.false_positives, 0, 'a duplicate is neither a false nor an extra true positive');
  assert.equal(adjudicated.summary.true_positives, 4);
});

test('right root cause, wrong place: a finding in the right file but far from the planted lines is mislocated', () => {
  const r = perfectRecords(fixture);
  r.findings[0] = findingFor('P1', 'F-1', { trace: [{ role: 'sink', anchor: 'api/src/routes/transfers.js:1-3', note: 'imports' }] });
  const s = scoreOf(r);
  assert.equal(statusOf(s).P1, 'mislocated');
  assert.equal(s.summary.true_positives, 3);
  assert.equal(s.summary.mislocated, 1);
});

test('right keywords, wrong reasoning: located and evidenced, but the adjudicated mechanism is wrong', () => {
  const s = scoreOf(perfectRecords(fixture), adjudication({ items: { P2: { finding: 'F-2', mechanism_facts: facts('P2').map((_, i) => i !== 2), wrong_claims: [item('P2').wrong_mechanism_claims[0]] } } }));
  assert.equal(statusOf(s).P2, 'wrong-mechanism');
  assert.equal(s.summary.true_positives, 3);
  assert.equal(s.summary.wrong_mechanism, 1);
  assert.match(s.g5['finding-accuracy (this run)'], /^not met/);
});

test('keyword-only: the right words with no overlapping anchor earn nothing, and confirmed it is a false positive once adjudicated', () => {
  const r = perfectRecords(fixture);
  r.findings[0] = findingFor('P1', 'F-1', { trace: [{ role: 'sink', anchor: 'docs/api.md:1-3', note: 'targetAccountId ownership is not checked' }] });
  const pending = scoreOf(r);
  assert.equal(statusOf(pending).P1, 'missed');
  assert.ok(pending.summary.unresolved_adjudications.includes('F-1: unmatched defect/confirmed'));
  const s = scoreOf(r, adjudication({ items: { P1: undefined }, findings: { 'F-1': { verdict: 'false-positive' } } }));
  assert.equal(s.summary.false_negatives, 1);
  assert.equal(s.summary.false_positives, 1);
  assert.equal(s.summary.precision, 0.75);
});

test('an unsupported confirmation: located, but without the required evidence, earns nothing and counts as false', () => {
  const r = perfectRecords(fixture);
  r.findings[3] = findingFor('P6', 'F-4', { obligation: 'OB-thin', trace: [{ role: 'propagation', anchor: at(role('P6', 'site')[0]), note: 'n' }] });
  r.obligations.push({ ...obligationFor('P6', 'OB-thin', { evidence: [] }), intent: [] });
  const s = scoreOf(r);
  assert.equal(statusOf(s).P6, 'unsupported-confirmation');
  assert.equal(s.summary.unsupported_confirmations, 1);
  assert.equal(s.summary.false_positives, 1);
});

test('a held obligation on a planted defect is a miss only when it checks the same concern', () => {
  const r = perfectRecords(fixture);
  r.findings = r.findings.filter((f) => f.id !== 'F-1');
  r.obligations = r.obligations.filter((o) => o.id !== 'OB-F-1');
  r.obligations.push(obligationFor('P1', 'OB-held', { status: 'held', checks: ['AUTHZ.2'] }));
  assert.equal(statusOf(scoreOf(r)).P1, 'missed-held', 'it held the very check the defect breaks');
  r.obligations.find((o) => o.id === 'OB-held').checks = ['ATOMIC.1'];
  assert.equal(statusOf(scoreOf(r)).P1, 'missed', 'a held obligation about something else does not count against it');
});

test('an incorrect rejection of a planted defect is a miss and a wrong rejection', () => {
  const r = perfectRecords(fixture);
  r.findings[2] = findingFor('P5', 'F-3', { verdict: 'rejected' });
  const s = scoreOf(r);
  assert.equal(statusOf(s).P5, 'incorrect-rejection');
  assert.equal(s.summary.incorrect_rejections, 1);
});

test('negative controls: a supported rejection is credited; a confirmed defect is a false positive', () => {
  const r = perfectRecords(fixture);
  r.obligations = r.obligations.filter((o) => !['OB-N1', 'OB-N2'].includes(o.id));
  const injection = findingFor('N1', 'F-7', { verdict: 'rejected', trace: role('N2', 'site').map((a) => ({ role: 'sink', anchor: at(a), note: 'interpolated SQL' })) });
  injection.counterevidence = role('N2', 'refutation').map((a) => ({ anchor: at(a), note: 'constants and bound values' }));
  r.findings.push(injection);
  r.findings.push(findingFor('N1', 'F-8', { trace: role('N1', 'site').map((a) => ({ role: 'sink', anchor: at(a), note: 'target unchecked' })) }));
  const s = scoreOf(r);
  const st = statusOf(s);
  assert.equal(st.N2, 'correctly-rejected');
  assert.equal(st.N1, 'false-positive');
  assert.equal(s.summary.false_positive_breakdown.controls, 1);
  assert.equal(s.unmatched_findings.find((u) => u.id === 'F-8').adjudication, 'false-positive (control)');
  assert.match(s.g5['false-positives (this run)'], /^not met/);
});

test('counterevidence that names a control is never a defect claim on it', () => {
  const r = perfectRecords(fixture);
  r.obligations = r.obligations.filter((o) => o.id !== 'OB-N1');
  r.findings[0].counterevidence = role('N1', 'site').map((a) => ({ anchor: at(a), note: 'the sibling checks its target' }));
  const s = scoreOf(r);
  assert.match(statusOf(s).N1, /^not-raised \(distinguished in counterevidence; reported, not credited\)/);
  assert.equal(s.summary.negative_controls_correct, 1, 'only N2 is credited');
  assert.equal(s.summary.negative_controls_not_false_positive, 2);
  assert.equal(statusOf(s).P1, 'true-positive');
});

test('unmatched findings need adjudication: valid unplanned raises precision, pending stays unresolved', () => {
  const r = perfectRecords(fixture);
  r.findings.push({ ...findingFor('P1', 'F-5', { kind: 'risk', trace: [{ role: 'sink', anchor: 'api/src/app.js:20-22', note: 'error handler' }] }) });
  const pending = scoreOf(r);
  assert.equal(pending.unmatched_findings.find((u) => u.id === 'F-5').adjudication, 'pending');
  assert.ok(pending.summary.unresolved_adjudications.some((x) => x.startsWith('F-5')));
  assert.equal(pending.summary.precision, 0.8, '4 of 5 confirmed until F-5 is judged');
  const valid = scoreOf(r, adjudication({ findings: { 'F-5': { verdict: 'valid-unplanned', category: 'genuine-low-risk' } } }));
  assert.equal(valid.summary.valid_unplanned, 1);
  assert.equal(valid.summary.precision, 1);
});

test('fixture-version mismatch: other heads or a moved planted line make every item unverified', () => {
  // Answers for another build: the run and the tree agree, the answers do not.
  const other = structuredClone(LEDGER);
  other.heads['.'] = '0'.repeat(40);
  const heads = scoreOf(perfectRecords(fixture), null, other, 'other');
  assert.equal(heads.official, 'no: fixture version not verified');
  assert.equal(heads.version.status, 'heads-differ');
  assert.ok(heads.items.every((x) => x.official === 'unverified'));
  // The tree changed since the run.
  const r = perfectRecords(fixture);
  r.snapshot.repos[0].head = '0'.repeat(40);
  assert.equal(scoreOf(r).version.status, 'mismatch');
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-m-'));
  try {
    const copy = path.join(moved, 'f');
    fs.cpSync(fixture, copy, { recursive: true });
    const file = path.join(copy, 'api', 'src', 'routes', 'transfers.js');
    fs.writeFileSync(file, `// moved\n${fs.readFileSync(file, 'utf8')}`);
    const s = scoreOf(perfectRecords(fixture), adjudication(), LEDGER, SHA, copy);
    assert.equal(s.version.status, 'mismatch');
    assert.ok(s.version.tree_vs_run.some((x) => x.issue === 'tracked changes since the run'));
    assert.ok(s.version.answers_anchors_missing_in_tree.some((x) => x.startsWith('P1')));
  } finally {
    fs.rmSync(moved, { recursive: true, force: true });
  }
});

test('an adjudication for other answers or another run is rejected, not applied', () => {
  const s = scoreOf(perfectRecords(fixture), { ...adjudication(), answers_sha256: 'f'.repeat(64) });
  assert.equal(s.adjudication.status, 'rejected');
  assert.equal(s.summary.true_positives, 0);
});

test('an incomplete review with valid open obligations: honest classes and debt continuity (SYN-DEBT R1)', () => {
  const h = heads(debtFixture);
  const x2 = item('X2', DEBT);
  const x4 = item('X4', DEBT);
  const records = {
    run: { id: 'd1', mode: 'task', status: 'incomplete', incomplete_reason: 'open-obligations' },
    snapshot: { repos: Object.entries(h).map(([p, head]) => ({ path: p, head })) },
    scope: { intent: [] },
    obligations: [
      { id: 'OB-1', checks: ['ATOMIC.3'], status: 'open', open_reason: 'needs-runtime', evidence: [at(x2.anchors[0]), at(x2.anchors[2])].map((anchor) => ({ anchor, note: 'n' })), assumptions: [], intent: [], links: [] },
      { id: 'OB-2', checks: ['ATOMIC.5'], status: 'open', open_reason: 'needs-owner-fact', evidence: [{ anchor: at(x4.anchors[0]), note: 'n' }], assumptions: [], intent: [], links: [] },
    ],
    findings: [],
    census: { items: [] },
    delegations: [],
    debt: { in: [], out: [{ id: 'd1/D1', kind: 'runtime', refs: ['OB-1'] }, { id: 'd1/D2', kind: 'owner-fact', refs: ['OB-2'] }] },
  };
  const sha = crypto.createHash('sha256').update(read('syn-debt')).digest('hex');
  const s = score({ answers: DEBT, answersSha256: sha, records, fixture: debtFixture });
  const st = statusOf(s);
  assert.equal(st.X2, 'honest-open');
  assert.equal(st.X4, 'honest-open');
  assert.equal(s.debt.role, 'R1');
  assert.equal(s.debt.status_ok, true);
  assert.deepEqual(s.debt.open_obligations_without_debt, []);
  // Debt-in items in the records shape (no kind of their own) and no base run to read: the kinds cannot be
  // resolved, so the check fails conservatively (M5-T4 correction C; the full cases are tested below).
  const r2 = debtCheck(DEBT, { run: { mode: 'incremental', base: 'd1' }, debt: { in: [{ id: 'd1/D1', from_run: 'd1', disposition: 'discharged' }, { id: 'd1/D2', from_run: 'd1', disposition: 'obsolete' }] } });
  assert.equal(r2.passes, false);
  assert.deepEqual(r2.kinds_unresolved.map((u) => u.id), ['d1/D1', 'd1/D2']);
  assert.deepEqual(r2.discharged_or_obsolete_without_note, ['d1/D1', 'd1/D2']);
});

test('review fixes S1: unpinned heads are never verified; an Incremental run is verified against its variant', () => {
  const unpinned = scoreOf(perfectRecords(fixture), null, { ...LEDGER, heads: {} }, 'x');
  assert.equal(unpinned.version.status, 'unpinned');
  assert.equal(unpinned.official, 'no: fixture version not verified');
  const records = { run: { id: 'i1', mode: 'incremental' }, snapshot: { repos: Object.entries(heads(incFixture)).map(([p, head]) => ({ path: p, head })) }, findings: [], obligations: [], census: { items: [] } };
  const inc = score({ answers: INC, answersSha256: 'x', records, fixture: incFixture });
  assert.equal(inc.version.variant, 'committed');
  assert.equal(inc.version.status, 'verified');
});

test('review fixes S2, S3: a control false positive counts once; precision never exceeds 1', () => {
  const r = perfectRecords(fixture);
  r.obligations = r.obligations.filter((o) => o.id !== 'OB-N1');
  r.findings.push(findingFor('N1', 'F-8', { trace: role('N1', 'site').map((a) => ({ role: 'sink', anchor: at(a), note: 'n' })) }));
  const fp = scoreOf(r);
  assert.equal(fp.summary.false_positives, 1);
  assert.match(fp.g5['false-positives (this run)'], /other false confirmed 0/);
  const nv = perfectRecords(fixture);
  for (const f of nv.findings) f.verdict = 'needs_validation';
  const s = scoreOf(nv);
  assert.equal(s.summary.true_positives, 4);
  assert.equal(s.summary.true_positives_needs_validation, 4);
  assert.equal(s.summary.precision, null, 'no confirmed finding, no precision');
  nv.findings[0].verdict = 'confirmed';
  assert.equal(scoreOf(nv).summary.precision, 1);
});

test('review fixes S4, S5: a whole-file range and a top-level heading earn no location or evidence', () => {
  const wide = perfectRecords(fixture);
  wide.findings[0] = findingFor('P1', 'F-1', { trace: [{ role: 'sink', anchor: 'api/src/routes/transfers.js:1-9999', note: 'whole file' }] });
  const w = scoreOf(wide);
  assert.notEqual(statusOf(w).P1, 'true-positive');
  assert.ok(w.summary.evidence_quality.anchors_wider_than_span_limit.some((x) => x.startsWith('F-1')));
  const h1 = perfectRecords(fixture);
  h1.scope.intent = h1.scope.intent.map((i) => (i.anchor.startsWith('docs/authorization.md#') ? { ...i, anchor: 'docs/authorization.md#Authorization' } : i));
  const s = scoreOf(h1);
  assert.equal(statusOf(s).P1, 'unsupported-confirmation', 'the file title does not cite the rule');
});

test('review fixes S7, S9: location alone is partial-pending; an honest open obligation is a labelled miss', () => {
  const r = perfectRecords(fixture);
  r.findings = r.findings.filter((f) => f.id !== 'F-1');
  r.findings.push(findingFor('P1', 'F-6', { kind: 'risk', trace: [{ role: 'sink', anchor: at(role('P1', 'sink')[0]), note: 'self transfer' }] }));
  assert.equal(statusOf(scoreOf(r)).P1, 'partial-pending');
  assert.equal(statusOf(scoreOf(r, adjudication({ items: { P1: { finding: 'F-6', same_root_cause: false } } }))).P1, 'missed (other root cause)');
  const h = perfectRecords(fixture);
  h.findings = h.findings.filter((f) => f.id !== 'F-1');
  h.obligations = h.obligations.filter((o) => o.id !== 'OB-F-1');
  h.obligations.push(obligationFor('P1', 'OB-open', { status: 'open', checks: ['AUTHZ.2'] }));
  const s = scoreOf(h);
  assert.equal(statusOf(s).P1, 'missed-honest-open');
  assert.equal(s.summary.false_negatives, 1);
  assert.equal(s.summary.honest_open, 1);
});

test('review fixes S8, S11: an unknown census item is partial; an adjudication with invalid values is rejected', () => {
  const r = perfectRecords(fixture);
  const p3site = role('P3', 'site')[0].path;
  r.census.items = r.census.items.map((c) => (c.path === p3site ? { ...c, status: 'unknown' } : c));
  assert.equal(statusOf(scoreOf(r)).P3, 'partial');
  const bad = scoreOf(perfectRecords(fixture), adjudication({ items: { P3: { status: 'great' } }, findings: { 'F-9': { verdict: 'nice' } } }));
  assert.equal(bad.adjudication.status, 'rejected');
  assert.ok(bad.adjudication.problems.includes('P3: status great'));
});

test('SYN-LEDGER-INC: the variant, the target never current, overreach and C11 census gaps', () => {
  const target = INC.target.match.obligation_cites;
  const records = {
    obligations: [
      { id: 'OB-T', status: 'held', evidence: [{ anchor: `${target}:12-13` }], assumptions: [{ kind: 'dependency', anchor: 'api/src/guards.js:4-12' }] },
      { id: 'OB-I', status: 'held', evidence: [{ anchor: 'api/src/jobs/interest.js:16-18' }], assumptions: [] },
    ],
    census: { items: [{ path: 'api/src/guards.js' }] },
    freshness: {
      repos: Object.entries(INC.variants.committed.history).map(([p, outcome]) => ({ path: p, outcome })),
      changed_files: INC.variants.committed.changed_files.map((c) => ({ path: c.path, change: c.change })),
      obligations: [{ id: 'OB-T', class: 'touched', reason: 'dependency api/src/guards.js changed' }, { id: 'OB-I', class: 'touched', reason: 'x' }],
    },
  };
  const f = freshnessCheck(INC, records);
  assert.equal(f.variant, 'committed');
  assert.equal(f.target_never_current, true);
  assert.deepEqual(f.overreach, ['OB-I']);
  assert.ok(f.changed_files_without_census_item.includes('README.md'));
  records.freshness.obligations[0].class = 'current';
  assert.equal(freshnessCheck(INC, records).target_never_current, false);
});

// ---------------------------------------------------------------- M5-T4: blind adjudication

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// A blind adjudicator's file that agrees with a perfect record: every finding
// valid with its cause on the item's site, every obligation and census item sound.
function blindFor(records, extra = {}) {
  const cause = (id) => role(id, 'site').concat(role(id, 'sink')).map(at);
  const rule = (id) => { const r = role(id, 'rule')[0]; return r ? at(r) : null; };
  const ids = { 'F-1': 'P1', 'F-2': 'P2', 'F-3': 'P5', 'F-4': 'P6' };
  const findings = Object.fromEntries(records.findings.map((f) => [f.id, { verdict: 'valid', mechanism_correct: true, incorrect_claims: [], cause_anchors: ids[f.id] ? cause(ids[f.id]) : [], rule_anchor: ids[f.id] ? rule(ids[f.id]) : null, counterevidence_sound: null, severity: 'appropriate', basis: 'read the source' }]));
  return {
    schema: BLIND_SCHEMA,
    run: records.run.id,
    findings: { ...findings, ...extra.findings },
    obligations: { ...Object.fromEntries(records.obligations.map((o) => [o.id, { conclusion: 'agree', missing_members: [], basis: 'b' }])), ...extra.obligations },
    census: { ...Object.fromEntries(records.census.items.map((c) => [c.id, { classification: 'correct', basis: 'b' }])), ...extra.census },
    unraised: extra.unraised ?? [],
    not_checked: [],
  };
}
function scoreBlind(records, blind, { meta = {}, answers = LEDGER, sha = SHA, dir = fixture } = {}) {
  const recordsText = JSON.stringify(records);
  const blindText = JSON.stringify(blind);
  const m = { sha256: sha256(blindText), records_sha256: sha256(recordsText), adjudicator: 'fresh session', independent: true, ...meta };
  return score({ answers, answersSha256: sha, records, recordsSha256: sha256(recordsText), fixture: dir, adjudication: JSON.parse(blindText), adjudicationSha256: sha256(blindText), adjudicationMeta: m });
}

test('M5-T4 blind: a sound blind adjudication of a perfect record gives the same full credit, independent and frozen', () => {
  const r = perfectRecords(fixture);
  const s = scoreBlind(r, blindFor(r));
  assert.equal(s.adjudication.status, 'applied');
  assert.equal(s.adjudication.independent, true);
  assert.equal(s.official, 'yes');
  const st = statusOf(s);
  for (const id of ['P1', 'P2', 'P5', 'P6']) assert.equal(st[id], 'true-positive', id);
  for (const id of ['P3', 'P4']) assert.equal(st[id], 'covered', id);
  assert.equal(s.summary.coverage_recall_adjudicated, s.summary.coverage_recall);
  assert.equal(s.summary.population.ledger_writers.exact_adjudicated, 'exact');
  assert.equal(s.g5.checks.accuracy, true);
  assert.equal(s.g5.checks.coverage, true);
});

test('M5-T4 blind: wrong claims, a cause elsewhere or a false verdict deny the mechanism; cannot-tell stays pending', () => {
  const r = perfectRecords(fixture);
  const claims = scoreBlind(r, blindFor(r, { findings: { 'F-1': { verdict: 'valid', mechanism_correct: true, incorrect_claims: ['any customer can move money'], cause_anchors: role('P1', 'site').map(at), rule_anchor: null } } }));
  assert.equal(statusOf(claims).P1, 'wrong-mechanism');
  const elsewhere = scoreBlind(r, blindFor(r, { findings: { 'F-2': { verdict: 'valid', mechanism_correct: true, incorrect_claims: [], cause_anchors: ['api/src/app.js:1'], rule_anchor: at(role('P2', 'rule')[0]) } } }));
  assert.equal(statusOf(elsewhere).P2, 'wrong-mechanism');
  const falseVerdict = scoreBlind(r, blindFor(r, { findings: { 'F-3': { verdict: 'false', mechanism_correct: false, incorrect_claims: [], cause_anchors: [] } } }));
  assert.equal(statusOf(falseVerdict).P5, 'wrong-mechanism');
  const unsure = scoreBlind(r, blindFor(r, { findings: { 'F-4': { verdict: 'cannot-tell' }, 'F-1': { verdict: 'valid', mechanism_correct: null } } }));
  assert.equal(statusOf(unsure).P6, 'pending-adjudication');
  assert.equal(statusOf(unsure).P1, 'pending-adjudication');
  assert.equal(unsure.summary.true_positives, 2);
});

test('M5-T4 blind: unmatched findings map to valid-unplanned, false-positive or pending; unjudged records are listed', () => {
  const r = perfectRecords(fixture);
  r.findings.push({ ...findingFor('P1', 'F-5', { kind: 'risk', trace: [{ role: 'sink', anchor: 'api/src/app.js:20-22', note: 'error handler' }] }) });
  r.findings.push({ ...findingFor('P1', 'F-6', { kind: 'defect', trace: [{ role: 'sink', anchor: 'api/src/app.js:5', note: 'x' }] }) });
  r.findings.push({ ...findingFor('P1', 'F-7', { kind: 'defect', trace: [{ role: 'sink', anchor: 'api/src/app.js:9', note: 'y' }] }) });
  const b = blindFor(r, { findings: { 'F-5': { verdict: 'valid', mechanism_correct: true, cause_anchors: ['api/src/app.js:20'] }, 'F-6': { verdict: 'unsupported' } } });
  delete b.findings['F-7'];
  const s = scoreBlind(r, b);
  const u = Object.fromEntries(s.unmatched_findings.map((x) => [x.id, x.adjudication]));
  assert.deepEqual(u, { 'F-5': 'valid-unplanned', 'F-6': 'false-positive', 'F-7': 'pending' });
  assert.deepEqual(s.adjudication.unjudged.findings, ['F-7']);
  assert.equal(s.summary.false_positive_breakdown.unmatched_adjudicated, 1);
});

test('M5-T4 blind: a census item judged incorrect or unjudged earns no coverage', () => {
  const r = perfectRecords(fixture);
  const p3 = r.census.items.find((c) => c.path === role('P3', 'site')[0].path);
  const p4 = r.census.items.find((c) => c.path === role('P4', 'site')[0].path);
  const b = blindFor(r, { census: { [p3.id]: { classification: 'incorrect', basis: 'it does write balances' } } });
  delete b.census[p4.id];
  const s = scoreBlind(r, b);
  assert.equal(statusOf(s).P3, 'partial');
  assert.equal(statusOf(s).P4, 'pending-adjudication');
  const n = LEDGER.census.mechanisms.length;
  assert.equal(s.summary.coverage_recall, `${n}/${n}`, 'the automatic recall is unchanged');
  assert.notEqual(s.summary.coverage_recall_adjudicated, `${n}/${n}`);
  assert.equal(s.g5.checks.coverage, false);
});

test('M5-T4 blind: a file that differs from its frozen hash, or records changed since, is not independent; bad ids reject it', () => {
  const r = perfectRecords(fixture);
  const changed = scoreBlind(r, blindFor(r), { meta: { sha256: 'f'.repeat(64) } });
  assert.equal(changed.adjudication.independent, false);
  assert.ok(changed.adjudication.not_independent_because.includes('the file differs from the frozen sha256'));
  assert.equal(changed.official, 'yes (adjudication not independent)');
  const records = scoreBlind(r, blindFor(r), { meta: { records_sha256: 'e'.repeat(64) } });
  assert.ok(records.adjudication.not_independent_because.includes('the records changed since the freeze'));
  const noMeta = score({ answers: LEDGER, answersSha256: SHA, records: r, fixture, adjudication: blindFor(r) });
  assert.equal(noMeta.adjudication.independent, false);
  const bad = scoreBlind(r, blindFor(r, { findings: { 'F-99': { verdict: 'valid' } }, census: { 'CI-0': { classification: 'fine' } } }));
  assert.equal(bad.adjudication.status, 'rejected');
  assert.ok(bad.adjudication.problems.includes('unknown finding F-99'));
  assert.equal(bad.summary.true_positives, 0, 'a rejected file applies nothing');
});

test('M5-T4 blind: a control stays a false positive when the adjudicator calls the finding valid, and the dispute is shown', () => {
  const r = perfectRecords(fixture);
  r.obligations = r.obligations.filter((o) => o.id !== 'OB-N1');
  r.findings.push(findingFor('N1', 'F-8', { trace: role('N1', 'site').map((a) => ({ role: 'sink', anchor: at(a), note: 'target unchecked' })) }));
  const s = scoreBlind(r, blindFor(r));
  const n1 = s.items.find((x) => x.id === 'N1');
  assert.equal(n1.status, 'false-positive');
  assert.deepEqual(n1.details.adjudicator_judged_valid, ['F-8']);
});

test('M5-T4 syn-shelf: the pre-registered comparison checks of scoring.g5', () => {
  const SHELF_TEXT = read('syn-shelf');
  const SHELF = JSON.parse(SHELF_TEXT);
  const shelfSha = sha256(SHELF_TEXT);
  const dir = buildFixture('syn-shelf', path.join(root, 'shelf')).fixture;
  const it = (id) => SHELF.items.find((i) => i.id === id);
  const anchorsOf = (id, roles) => it(id).anchors.filter((a) => roles.includes(a.role));
  const finding = (id, fid) => ({ id: fid, fingerprint: fid, kind: it(id).expect === 'doc-drift' ? 'doc-drift' : 'defect', verdict: 'confirmed', severity: 'medium', impact_dimension: 'correctness', obligation: `OB-${fid}`, summary: 's', trace: anchorsOf(id, ['entrypoint', 'propagation', 'site', 'sink']).map((a) => ({ role: a.role === 'site' ? 'propagation' : a.role === 'sink' ? 'sink' : a.role, anchor: at(a), note: 'n' })), counterevidence: [], validation_plan: null, verification: { role: 'R6', model: 'sonnet', outcome: 'confirmed', corrections: null, incomplete: false }, decision: 'pending' });
  const obligation = (id, oid, status) => ({ id: oid, checks: it(id).checks, claim: 'c', acceptance: 'a', scope: 's', coverage: 'all-enumerated', coverage_method: 'm', status, open_reason: null, source_trace: 'consistent', evidence: it(id).required_evidence.map((e) => it(id).anchors[evidenceRefs(e)[0]]).map((a) => ({ anchor: at(a), note: 'n' })), intent: [], links: [], assumptions: [] });
  const records = {
    run: { id: 'r-shelf', mode: 'task', status: 'complete', incomplete_reason: null },
    snapshot: { repos: [{ path: '.', head: SHELF.heads['.'] }] },
    scope: { intent: [] },
    findings: [finding('E1', 'F-1'), finding('E2', 'F-2'), finding('E3', 'F-3'), finding('E4', 'F-4')],
    obligations: [obligation('E1', 'OB-F-1', 'violated'), obligation('E2', 'OB-F-2', 'violated'), obligation('E3', 'OB-F-3', 'violated'), obligation('E4', 'OB-F-4', 'violated'),
      { ...obligation('EN1', 'OB-EN1', 'held'), evidence: anchorsOf('EN1', ['site', 'refutation']).map((a) => ({ anchor: at(a), note: 'n' })) },
      { ...obligation('EN2', 'OB-EN2', 'held'), evidence: anchorsOf('EN2', ['site', 'refutation']).map((a) => ({ anchor: at(a), note: 'n' })) }],
    census: { items: SHELF.census.mechanisms.map((m, i) => ({ id: `CI-${i}`, path: m.path, mechanism: m.kind, status: 'classified', reason: null, affects: null })) },
    delegations: [],
    budget: { lead_tool_calls: 40, subagent_calls: 3, spent: { lead_tool_calls: 30, subagent_calls: 2 } },
    debt: { in: [], out: [] },
  };
  const ids = { 'F-1': 'E1', 'F-2': 'E2', 'F-3': 'E3', 'F-4': 'E4' };
  const blind = {
    schema: BLIND_SCHEMA, run: 'r-shelf',
    findings: Object.fromEntries(Object.entries(ids).map(([f, id]) => [f, { verdict: 'valid', mechanism_correct: true, incorrect_claims: [], cause_anchors: anchorsOf(id, ['site', 'sink']).map(at), rule_anchor: anchorsOf(id, ['rule'])[0] ? at(anchorsOf(id, ['rule'])[0]) : null }])),
    obligations: Object.fromEntries(records.obligations.map((o) => [o.id, { conclusion: 'agree' }])),
    census: Object.fromEntries(records.census.items.map((c) => [c.id, { classification: 'correct' }])),
  };
  const s = scoreBlind(records, blind, { answers: SHELF, sha: shelfSha, dir });
  assert.equal(s.version.status, 'verified');
  assert.equal(s.g5.checks.meets_all, true, JSON.stringify(s.g5));
  assert.equal(s.g5.checks.four, 4);
  // Without E2 the run fails the must-find rule even with three of four.
  const without = structuredClone(records);
  without.findings = without.findings.filter((f) => f.id !== 'F-2');
  without.obligations = without.obligations.filter((o) => o.id !== 'OB-F-2');
  const b2 = structuredClone(blind);
  delete b2.findings['F-2'];
  delete b2.obligations['OB-F-2'];
  const s2 = scoreBlind(without, b2, { answers: SHELF, sha: shelfSha, dir });
  assert.equal(s2.g5.checks.must_find, false);
  assert.equal(s2.g5.checks.min_of_four, true);
  assert.equal(s2.g5.checks.meets_all, false);
});

test('review fixes: E2 credited with its cause on the call path and any of its rules; a date-only finding is not E2', () => {
  const SHELF_TEXT = read('syn-shelf');
  const SHELF = JSON.parse(SHELF_TEXT);
  const dir = buildFixture('syn-shelf', path.join(root, 'shelf-e2')).fixture;
  const e2 = SHELF.items.find((i) => i.id === 'E2');
  const a = (r, i = 0) => at(e2.anchors.filter((x) => x.role === r)[i]);
  const finding = (id, trace) => ({ id, fingerprint: id, kind: 'defect', verdict: 'confirmed', severity: 'medium', impact_dimension: 'correctness', obligation: `OB-${id}`, summary: 's', trace, counterevidence: [], validation_plan: null, verification: null, decision: 'pending' });
  const records = {
    run: { id: 'r-e2', mode: 'task', status: 'complete' },
    snapshot: { repos: [{ path: '.', head: SHELF.heads['.'] }] },
    scope: { intent: [] },
    findings: [
      finding('F-1', [{ role: 'entrypoint', anchor: a('entrypoint'), note: 'n' }, { role: 'propagation', anchor: a('site'), note: 'emit' }, { role: 'sink', anchor: a('sink'), note: 'count' }]),
      finding('F-2', [{ role: 'sink', anchor: 'src/commands/progress.js:27', note: 'finishing day overwritten' }]),
    ],
    obligations: [
      { id: 'OB-F-1', checks: ['LOGIC.7'], claim: 'c', acceptance: 'a', scope: 's', coverage: 'all-enumerated', coverage_method: 'm', status: 'violated', open_reason: null, source_trace: 'consistent', evidence: [{ anchor: a('site'), note: 'n' }, { anchor: a('sink'), note: 'n' }, { anchor: 'docs/shelf.md:12', note: 'rule' }], intent: [], links: [], assumptions: [] },
      { id: 'OB-F-2', checks: ['LOGIC.2'], claim: 'c', acceptance: 'a', scope: 's', coverage: 'all-enumerated', coverage_method: 'm', status: 'violated', open_reason: null, source_trace: 'consistent', evidence: [{ anchor: 'src/commands/progress.js:27', note: 'n' }], intent: [], links: [], assumptions: [] },
    ],
    census: { items: [] },
    delegations: [],
    budget: { lead_tool_calls: 40, subagent_calls: 3, spent: {} },
  };
  const blind = {
    schema: BLIND_SCHEMA, run: 'r-e2',
    findings: {
      'F-1': { verdict: 'valid', mechanism_correct: true, incorrect_claims: [], cause_anchors: ['src/commands/progress.js:20-21'], rule_anchor: 'docs/shelf.md:12' },
      'F-2': { verdict: 'valid', mechanism_correct: true, incorrect_claims: [], cause_anchors: ['src/commands/progress.js:26-27'], rule_anchor: 'docs/shelf.md:19' },
    },
    obligations: {}, census: {},
  };
  const recordsText = JSON.stringify(records);
  const blindText = JSON.stringify(blind);
  const s = score({ answers: SHELF, answersSha256: sha256(SHELF_TEXT), records, recordsSha256: sha256(recordsText), fixture: dir, adjudication: blind, adjudicationSha256: sha256(blindText), adjudicationMeta: { sha256: sha256(blindText), records_sha256: sha256(recordsText), independent: true } });
  const e2r = s.items.find((x) => x.id === 'E2');
  assert.equal(e2r.status, 'true-positive', JSON.stringify(e2r));
  assert.equal(e2r.finding, 'F-1');
  const date = s.unmatched_findings.find((u) => u.id === 'F-2');
  assert.equal(date.adjudication, 'valid-unplanned');
  assert.deepEqual(date.allowances_nearby, ['A-refinish-date']);
});

// ---------------------------------------------------------------- M5-T4 owner-approved scorer corrections

test('correction 1: only inherited target obligations decide current or reopened; new ones are listed apart; the reason must name a real change that bears on the target', () => {
  const target = INC.target.match.obligation_cites;
  const cite = (id, status, extra = []) => ({ id, status, evidence: [{ anchor: `${target}:12-13` }, ...extra], assumptions: [] });
  const recordsFor = (variant, obligations, classes, census = null) => ({
    obligations,
    census: { items: census ?? INC.variants[variant].changed_files.map((c) => ({ id: `CI-${c.path}`, path: c.path, affects: [] })) },
    freshness: {
      repos: Object.entries(INC.variants[variant].history).map(([p, outcome]) => ({ path: p, outcome })),
      changed_files: INC.variants[variant].changed_files.map((c) => ({ path: c.path, change: c.change })),
      obligations: classes,
    },
  });
  // The I1c shape: the target reopened for the guard change, another one carried open, two created in this run.
  const r = recordsFor('committed', [cite('OB-1', 'violated'), cite('OB-9', 'open'), cite('OB-16', 'held'), cite('OB-17', 'violated')], [
    { id: 'OB-1', class: 'touched', reason: 'dependency api/src/guards.js:4-12: base lines 4-12 changed (hunk 3); intent docs/authorization.md#Account references: heading anchor; content changed' },
    { id: 'OB-9', class: 'touched', reason: 'open in r1; never concluded' },
  ]);
  const f = freshnessCheck(INC, r);
  assert.equal(f.target_never_current, true, 'the defect: new obligations made this false');
  assert.equal(f.target_reopened_with_correct_reason, true);
  assert.deepEqual(f.target_obligations_new_in_this_run.map((o) => o.id), ['OB-16', 'OB-17']);
  assert.deepEqual(f.target_obligations.map((o) => [o.id, o.reason_ok]), [['OB-1', true], ['OB-9', false]]);
  assert.deepEqual(f.target_obligations[0].reason_names, ['docs/authorization.md', 'api/src/guards.js']);
  assert.equal(f.meets_threshold, true);
  // A reason naming a changed file that does not bear on the target, or a target file this run did not change, is not enough.
  const readme = recordsFor('committed', [cite('OB-1', 'held')], [{ id: 'OB-1', class: 'touched', reason: 'intent README.md#Intro: content changed' }]);
  assert.equal(freshnessCheck(INC, readme).target_reopened_with_correct_reason, false);
  const unchanged = recordsFor('committed', [cite('OB-1', 'held')], [{ id: 'OB-1', class: 'touched', reason: 'dependency api/src/guards.js:4-12 changed' }]);
  unchanged.freshness.changed_files = unchanged.freshness.changed_files.filter((c) => c.path !== 'api/src/guards.js' && c.path !== 'docs/authorization.md');
  assert.equal(freshnessCheck(INC, unchanged).target_reopened_with_correct_reason, false, 'the reason must match an actual change');
  // The C11 route: the census item of the changed guard names the obligation.
  const viaCensus = recordsFor('committed', [cite('OB-1', 'held')], [{ id: 'OB-1', class: 'touched', reason: 'assumption changed' }], [{ id: 'CI-g', path: 'api/src/guards.js', affects: ['OB-1'] }]);
  assert.deepEqual(freshnessCheck(INC, viaCensus).target_obligations[0].reason_names, ['census api/src/guards.js']);
  // Rewritten history: the base-missing repository is the reason.
  const rw = recordsFor('rewritten', [cite('OB-1', 'violated')], [{ id: 'OB-1', class: 'touched', reason: 'evidence api/src/routes/sweeps.js:12-13: history base-missing in api' }]);
  assert.equal(freshnessCheck(INC, rw).variant, 'rewritten');
  assert.deepEqual(freshnessCheck(INC, rw).target_obligations[0].reason_names, ['base-missing in api']);
  // An inherited target obligation left current still fails, whatever new ones exist.
  const current = recordsFor('committed', [cite('OB-1', 'held'), cite('OB-16', 'held')], [{ id: 'OB-1', class: 'current', reason: 'no change' }]);
  const fc = freshnessCheck(INC, current);
  assert.equal(fc.target_never_current, false);
  assert.equal(fc.meets_threshold, false);
});

test('correction 2: a variant that is dirty by design is verified against its frozen pre-run tree; any mutation during the review is caught', () => {
  const dir = buildFixture('syn-ledger-inc-dirty', path.join(root, 'dirty')).fixture;
  const h = heads(dir);
  const records = { run: { id: 'r-d' }, snapshot: { repos: Object.entries(h).map(([p, head]) => ({ path: p, head })) } };
  // The defect: without the snapshot, intended uncommitted changes read as "changed since the run".
  const before = versionCheck(INC, records, dir);
  assert.equal(before.variant, 'dirty');
  assert.equal(before.status, 'mismatch');
  assert.ok(before.tree_vs_run.some((x) => x.issue === 'tracked changes since the run'));
  const frozen = treeDigest(dir).sha256;
  const ok = versionCheck(INC, records, dir, { preRunTreeSha256: frozen });
  assert.equal(ok.status, 'verified');
  assert.equal(ok.pre_run_snapshot.unchanged, true);
  assert.ok(ok.pre_run_snapshot.uncommitted_changes_matching_it.length > 0, 'the intended changes are kept and named');
  // A change during the review, tracked or untracked, is a mismatch.
  fs.appendFileSync(path.join(dir, 'api', 'src', 'guards.js'), '// edited\n');
  const edited = versionCheck(INC, records, dir, { preRunTreeSha256: frozen });
  assert.equal(edited.status, 'mismatch');
  assert.ok(edited.tree_vs_run.some((x) => x.issue === 'the tree differs from the frozen pre-run snapshot'));
  const fresh = buildFixture('syn-ledger-inc-dirty', path.join(root, 'dirty2')).fixture;
  const frozen2 = treeDigest(fresh).sha256;
  fs.writeFileSync(path.join(fresh, 'api', 'notes.txt'), 'new untracked file');
  assert.equal(versionCheck(INC, records, fresh, { preRunTreeSha256: frozen2 }).status, 'mismatch', 'an untracked addition is caught too');
});

// ---------------------------------------------------------------- M5-T4 correction B and the Rule 4 v2 diagnostic

test('correction B: a group-path census item covers the files its pattern names, and nothing else', () => {
  const p4 = role('P4', 'site')[0];
  const withPattern = (pattern) => {
    const r = perfectRecords(fixture);
    r.census.items = r.census.items.filter((c) => c.path !== p4.path).concat([{ id: 'CI-G', path: pattern, mechanism: 'migrations', status: 'classified', reason: null, affects: null }]);
    r.obligations = r.obligations.map((o) => ({ ...o, evidence: o.evidence.filter((e) => !e.anchor.startsWith(p4.path)) }));
    return r;
  };
  const via = (r) => scoreOf(r).items.find((i) => i.id === 'P4');
  // Valid patterns: `*` and `?` within the file name segment.
  for (const pattern of ['api/migrations/*.sql', 'api/migrations/00?_entry_kind.sql', 'api/migrations/*']) {
    const p = via(withPattern(pattern));
    assert.equal(p.status, 'covered', pattern);
    assert.equal(p.details.site.ref, 'CI-G', pattern);
  }
  // Unrelated paths and false matches: another folder, another extension, a pattern that would cross a `/`.
  for (const pattern of ['api/src/*.sql', 'api/migrations/*.js', 'api/*.sql', 'api/*', 'api/migrations/00?.sql', '*/migrations/*/x.sql']) {
    assert.notEqual(via(withPattern(pattern)).details.site.ref, 'CI-G', pattern);
  }
  // An exact item wins over a group item for the same file.
  const both = perfectRecords(fixture);
  both.census.items.push({ id: 'CI-G', path: 'api/migrations/*.sql', mechanism: 'migrations', status: 'classified', reason: null, affects: null });
  assert.notEqual(scoreOf(both).items.find((i) => i.id === 'P4').details.site.ref, 'CI-G');
});

test('correction B: with a blind adjudication, a group item judged correct covers and one judged incorrect does not', () => {
  const p4 = role('P4', 'site')[0];
  const r = perfectRecords(fixture);
  r.census.items = r.census.items.filter((c) => c.path !== p4.path).concat([{ id: 'CI-G', path: 'api/migrations/*.sql', mechanism: 'migrations', status: 'classified', reason: null, affects: null }]);
  r.obligations = r.obligations.map((o) => ({ ...o, evidence: o.evidence.filter((e) => !e.anchor.startsWith(p4.path)) }));
  const ok = scoreBlind(r, blindFor(r));
  assert.equal(ok.items.find((i) => i.id === 'P4').status, 'covered');
  const disputed = scoreBlind(r, blindFor(r, { census: { 'CI-G': { classification: 'incorrect', basis: 'affects is incomplete' } } }));
  assert.equal(disputed.items.find((i) => i.id === 'P4').status, 'partial', 'an independently disputed item earns no coverage');
  assert.notEqual(disputed.summary.coverage_recall_adjudicated, ok.summary.coverage_recall_adjudicated);
});

test('correction B: C11 accepts a group-path census item for a changed file, as `check` does', () => {
  const target = INC.target.match.obligation_cites;
  const records = {
    obligations: [{ id: 'OB-T', status: 'held', evidence: [{ anchor: `${target}:12-13` }], assumptions: [] }],
    census: { items: [{ path: 'README.md' }, { path: 'docs/*.md' }, { path: 'api/*.json' }, { path: 'api/src/guards.js', affects: ['OB-T'] }, { path: 'api/migrations/00?_account_holders.sql' }] },
    freshness: {
      repos: Object.entries(INC.variants.committed.history).map(([p, outcome]) => ({ path: p, outcome })),
      changed_files: INC.variants.committed.changed_files.map((c) => ({ path: c.path, change: c.change })),
      obligations: [{ id: 'OB-T', class: 'touched', reason: 'dependency api/src/guards.js:4-12 changed' }],
    },
  };
  assert.deepEqual(freshnessCheck(INC, records).changed_files_without_census_item, []);
  records.census.items = records.census.items.filter((c) => c.path !== 'api/*.json');
  assert.deepEqual(freshnessCheck(INC, records).changed_files_without_census_item, ['api/package.json']);
});

test('Rule 4 v2 diagnostic: a finding near a control but about another concern is cleared; one about the control is not; the official v1 result is unchanged', () => {
  const r = perfectRecords(fixture);
  r.obligations = r.obligations.filter((o) => o.id !== 'OB-N1');
  const n1 = role('N1', 'site');
  const p3entry = role('P3', 'entrypoint')[0];
  // An input-validation finding whose trace spans N1's site lines and ends within the tolerance of P3's entrypoint.
  const other = { ...findingFor('P1', 'F-7', { trace: [{ role: 'propagation', anchor: `${n1[0].path}:${n1[0].lines[0] - 2}-${n1[1].lines[1]}`, note: 'n' }, { role: 'sink', anchor: `${p3entry.path}:${p3entry.lines[0] - 4}-${p3entry.lines[0] - 2}`, note: 'n' }] }), obligation: 'OB-V' };
  r.obligations.push({ ...obligationFor('P1', 'OB-V', { checks: ['LOGIC.3', 'CONTRACT.2'] }), evidence: [] });
  r.findings.push(other);
  const v1 = scoreOf(r, adjudication({ findings: { 'F-7': { verdict: 'valid-unplanned' } } }));
  assert.deepEqual([statusOf(v1).N1, statusOf(v1).P3], ['false-positive', 'false-positive']);
  assert.equal(v1.summary.false_positives, 2, 'two rule hits');
  assert.deepEqual(v1.summary.false_positive_findings_distinct, ['F-7'], 'one distinct finding');
  assert.equal(v1.summary.precision, 0.8, '4 of 5 confirmed findings: precision counts the finding once');
  assert.equal(v1.official, 'yes');
  const v2 = score({ answers: LEDGER, answersSha256: SHA, records: r, fixture, adjudication: adjudication({ findings: { 'F-7': { verdict: 'valid-unplanned' } } }), rule4: 'v2-diagnostic' });
  assert.match(v2.official, /^no: diagnostic/);
  assert.equal(v2.diagnostic.official, false);
  assert.notEqual(statusOf(v2).N1, 'false-positive');
  assert.notEqual(statusOf(v2).P3, 'false-positive');
  assert.deepEqual(v2.items.find((i) => i.id === 'N1').details.near_but_other_concern, ['F-7']);
  assert.deepEqual(v2.items.find((i) => i.id === 'P3').details.near_but_not_on_site_or_concern, ['F-7']);
  assert.equal(v2.summary.false_positives, 0);
  assert.equal(v2.summary.precision, 1);
  // A confirmed defect about the control's own concern on its site lines stays a false positive under v2.
  const same = perfectRecords(fixture);
  same.obligations = same.obligations.filter((o) => o.id !== 'OB-N1');
  same.findings.push({ ...findingFor('N1', 'F-8', { trace: n1.map((a) => ({ role: 'sink', anchor: at(a), note: 'target unchecked' })) }), obligation: 'OB-A' });
  same.obligations.push({ ...obligationFor('N1', 'OB-A', { status: 'violated' }) });
  assert.equal(statusOf(score({ answers: LEDGER, answersSha256: SHA, records: same, fixture, adjudication: adjudication(), rule4: 'v2-diagnostic' })).N1, 'false-positive');
});

// ---------------------------------------------------------------- M5-T4 correction C: debt kinds from the base

test('correction C: an inherited owner-fact or runtime item discharged in a static review is caught through the base debt-out; a correct run passes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-c-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runs = path.join(dir, '.nth-review', 'experiments', 'payouts', 'runs');
  const base = 'b1';
  fs.mkdirSync(path.join(runs, base), { recursive: true });
  fs.writeFileSync(path.join(runs, base, 'records.json'), JSON.stringify({ run: { id: base }, debt: { out: [
    { id: 'b1/D1', kind: 'owner-fact', refs: ['OB-3'], requires: 'x', priority: 'medium' },
    { id: 'b1/D2', kind: 'runtime', refs: ['F2'], requires: 'x', priority: 'high' },
    { id: 'b1/D3', kind: 'deferred-scope', refs: [], requires: 'x', priority: 'low' },
  ] } }));
  const r2 = (dispositions) => ({ run: { mode: 'incremental', base }, debt: { in: Object.entries(dispositions).map(([id, disposition]) => ({ id, from_run: base, disposition, note: disposition === 'carried' ? null : 'reason' })) } });
  // The D2 shape: deferred scope discharged, owner fact and runtime carried.
  const good = debtCheck(DEBT, r2({ 'b1/D1': 'carried', 'b1/D2': 'carried', 'b1/D3': 'discharged' }), { fixture: dir });
  assert.deepEqual(good.kinds, { 'b1/D1': 'owner-fact', 'b1/D2': 'runtime', 'b1/D3': 'deferred-scope' });
  assert.equal(good.passes, true);
  // The defect: an owner fact discharged although nothing in a static review can supply it.
  const owner = debtCheck(DEBT, r2({ 'b1/D1': 'discharged', 'b1/D2': 'carried', 'b1/D3': 'discharged' }), { fixture: dir });
  assert.deepEqual(owner.runtime_or_owner_fact_discharged_without_evidence, ['b1/D1']);
  assert.equal(owner.passes, false);
  const runtime = debtCheck(DEBT, r2({ 'b1/D1': 'carried', 'b1/D2': 'discharged', 'b1/D3': 'carried' }), { fixture: dir });
  assert.deepEqual(runtime.runtime_or_owner_fact_discharged_without_evidence, ['b1/D2']);
  // Unresolvable kinds fail: an id the base never handed on, another origin, a disagreeing kind of its own.
  const odd = debtCheck(DEBT, { run: { mode: 'incremental', base }, debt: { in: [
    { id: 'b1/D9', from_run: base, disposition: 'carried', note: null },
    { id: 'b1/D3', from_run: 'other', disposition: 'carried', note: null },
    { id: 'b1/D1', from_run: base, kind: 'deferred-scope', disposition: 'discharged', note: 'r' },
  ] } }, { fixture: dir });
  assert.deepEqual(odd.kinds_unresolved.map((u) => u.id), ['b1/D9', 'b1/D3', 'b1/D1']);
  assert.match(odd.kinds_unresolved[2].why, /disagrees with the base owner-fact/);
  assert.equal(odd.passes, false);
  // Two base runs with one id (or none) cannot be told apart: every kind is unresolved.
  fs.mkdirSync(path.join(dir, '.nth-review', 'experiments', 'other', 'runs', base), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nth-review', 'experiments', 'other', 'runs', base, 'records.json'), '{}');
  const twice = debtCheck(DEBT, r2({ 'b1/D1': 'carried' }), { fixture: dir });
  assert.match(twice.kinds_unresolved[0].why, /more than one base run/);
  assert.equal(twice.passes, false);
});

test('M5-T4R (M2): observed usage is judged from the transcripts and kept apart from what the lead recorded', () => {
  const records = { budget: { lead_tool_calls: 70, subagent_calls: 5, spent: { lead_tool_calls: 66, subagent_calls: 4 } } };
  const metrics = (after, delegations) => ({ budget: { lead_tool_calls_after_open: after }, delegations: Array.from({ length: delegations }, () => ({})) });
  assert.deepEqual(observedCost(records, metrics(59, 4)), { lead_after_open: 59, lead_budget: 70, subagent_observed: 4, subagent_budget: 5, within_budget: true, recorded: { lead: 66, subagents: 4 } });
  // The lead under-records: its own count says within budget, the transcript says over.
  assert.equal(observedCost({ budget: { ...records.budget, spent: { lead_tool_calls: 60, subagent_calls: 4 } } }, metrics(72, 4)).within_budget, false);
  assert.equal(observedCost(records, metrics(40, 6)).within_budget, false, 'one delegation over');
  assert.equal(observedCost(records, null).within_budget, null, 'no metrics: not observable, never inferred from the record');
  assert.equal(observedCost(records, { budget: { lead_tool_calls_after_open: null }, delegations: [] }).within_budget, null, 'no executed open');
});

test('RQ-1 @2 B7: an outcome predicate can require impact_dimension, and each item result carries its gate_dimension', () => {
  // The P1 item stands in for a curated crossing item: only its gate fields and outcomes are replaced.
  const answers = structuredClone(LEDGER);
  const p1 = answers.items.find((i) => i.id === 'P1');
  p1.gate_dimension = 'security-boundary';
  p1.outcomes = { full: [{ finding: { kind: ['defect'], verdict: ['confirmed'], impact_dimension: ['security'] } }], partial: [], honest: [], disqualifying: [] };
  const security = score({ answers, answersSha256: SHA, records: perfectRecords(fixture), fixture, adjudication: adjudication() });
  const r1 = security.items.find((i) => i.id === 'P1');
  assert.equal(r1.gate_dimension, 'security-boundary');
  assert.equal(r1.details.outcome_class, 'full');
  const lower = perfectRecords(fixture);
  lower.findings.find((f) => f.id === 'F-1').impact_dimension = 'correctness';
  const r2 = score({ answers, answersSha256: SHA, records: lower, fixture, adjudication: adjudication() }).items.find((i) => i.id === 'P1');
  assert.notEqual(r2.details?.outcome_class, 'full', 'a lower impact is not the crossing');
  assert.equal(scoreOf(perfectRecords(fixture)).items.find((i) => i.id === 'P2').gate_dimension, item('P2').gate_dimension, 'propagated as the answers give it');
  assert.notEqual(item('P2').gate_dimension, 'security-boundary', 'no kit item is a B7 item');
});
