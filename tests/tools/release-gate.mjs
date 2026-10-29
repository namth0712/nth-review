#!/usr/bin/env node
// Release quality gate RQ-1, version 3 (`nthr-release-gate@3`,
// tests/RELEASE-GATE-3.md; @1 and @2 stay frozen beside it): a deterministic
// evaluator. It writes nothing; it prints one JSON object naming the gate
// version and whether the gate file is the pinned, frozen one.
//
//   node release-gate.mjs offline [--tap <label>=<file>]... [--rehearsal <file>]
//     Part A. Checks A4-A7 and A11 directly (A5 builds every fixture twice,
//     about 20 s); reads A1-A3 and A8-A10 from saved `node --test` (TAP)
//     output and the rehearsal output. Labels: windows-gitbash,
//     windows-powershell, linux-node20, linux-node22.
//   node release-gate.mjs evaluate --rows <manifest.json>
//     Part B. The manifest lists the registered rows as { id, score, blind,
//     records, metrics } file paths (scored officially, adjudication frozen;
//     `records` is the run's own records.json, which B9 checks with the
//     helper), and optionally `ledger`, `curated` and `curated_evidence`
//     (B7: the repeat ledger, the curated package and the matrix root's
//     `curated/`), `b12_runs` (B12: the owner's nthr-b12-runs@1 file) and
//     `b11_routing_removed`. A typed `b7` or `b12` value is ignored. A missing
//     row or input leaves its criteria BLOCKED; nothing is assumed.
//
// Verdicts: PASS, FAIL, BLOCKED (cannot be evaluated without something the
// candidate cannot supply), UNVERIFIED (could be, but was not). The gate is
// PASS only when every criterion is PASS.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observedCost } from './score.mjs';
import { curatedLocation, curatedPackage, platformProblem, verifyLedger } from './matrix.mjs';
import { GATE, GATE_FILE, GATE_SHA256, PREVIOUS_GATES } from './gate-version.mjs';
import { readRun } from '../../scripts/lib/runs.mjs';
import { readDecisions } from '../../scripts/lib/decisions.mjs';
import { buildFixture, manifest } from '../fixtures/build.mjs';
import { checkRun } from '../../scripts/lib/check.mjs';
import { DOC, MANIFEST, RUNTIME_ENTRIES, buildManifest } from './runtime-manifest.mjs';
import { EVIDENCE_ABSENT, productPathOfLabel, sealedEvidenceState } from './evidence.mjs';

export { GATE };
const REVIEW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REVIEW, 'tests', 'fixtures');
export const HISTORICAL_LEDGER_SHA256 = '7aa36b1666e031808199087d1456526384d47de459c98b862b4edb1bde8f1f18';
export const HISTORICAL_LEDGER_EVENTS = 97;

// The core matrix (G5-REPEAT-PLAN §4), the security rows, and the rows each
// criterion gates (RELEASE-GATE-3.md §3).
export const ROW_IDS = ['L1', 'L2', 'I1c', 'I1r', 'I1d', 'I2c', 'I2r', 'I2d', 'D1', 'D2', 'SO1', 'SS1', 'SO2', 'SS2'];
const QUALITY_ROWS = ['L1', 'L2', 'SO1', 'SO2'];
const LEDGER_ROWS = ['L1', 'L2'];
const INC_ROWS = ['I1c', 'I1r', 'I1d', 'I2c', 'I2r', 'I2d'];
const MUST = { ledger: { must: ['P1', 'P2'], four: ['P1', 'P2', 'P5', 'P6'] }, shelf: { must: ['E1', 'E2'], four: ['E1', 'E2', 'E3', 'E4'] } };
const PAIRS = [['L1', 'L2'], ['SO1', 'SO2'], ['I1c', 'I2c'], ['I1r', 'I2r'], ['I1d', 'I2d']];
export const SECURITY_ROWS = ['SB1', 'SB2'];
const SONNET_ROWS = ['SS1', 'SS2'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const num = (v) => (Array.isArray(v) ? v.length : Number(v ?? 0));
const result = (status, detail) => ({ status, detail });
const blocked = (detail) => result('BLOCKED', detail);
const fraction = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? [Number(m[1]), Number(m[2])] : null; };
const full = (score, id) => score.items.some((i) => i.id === id && i.status === 'true-positive' && i.details?.outcome_class === 'full');
const kindOf = (id) => (/^S[OS]\d/.test(id) ? 'shelf' : 'ledger');
// Whether the gate file is the frozen, pinned one.
export const gateFileOk = (file = GATE_FILE, pinned = GATE_SHA256) => fs.existsSync(file) && sha256(fs.readFileSync(file)) === pinned;

// Combines per-row results: every row must pass; a missing row blocks.
function perRow(rows, ids, judge) {
  const missing = ids.filter((id) => !rows.has(id));
  if (missing.length) return blocked(`no registered row for ${missing.join(', ')}`);
  // Only an official score counts (Rule 4 v1, a verified fixture): never a diagnostic one.
  const unofficial = (row) => row.score && !String(row.score.official ?? '').startsWith('yes');
  const outcomes = ids.map((id) => [id, unofficial(rows.get(id)) ? { ok: false, why: `the score is not official (${rows.get(id).score.official})` } : judge(rows.get(id), id)]);
  const unknown = outcomes.filter(([, o]) => o === null).map(([id]) => id);
  if (unknown.length) return blocked(`inputs missing for ${unknown.join(', ')}`);
  const failed = outcomes.filter(([, o]) => !o.ok);
  return result(failed.length ? 'FAIL' : 'PASS', outcomes.map(([id, o]) => `${id}: ${o.ok ? 'ok' : 'not met'} (${o.why})`).join('; '));
}

// The negative controls B1 names. Rule 4's other items (P3, P4, X3) make a
// finding false, but they are not controls: such a finding is an "other false".
export const NEGATIVE_CONTROLS = Object.freeze(['N1', 'N2', 'EN1', 'EN2']);

// B1 for one row: negative controls never confirmed (Rule 4 v1: any confirmed
// defect on a control's anchors); at most 1 other false confirmed finding,
// counted as distinct findings; precision >= 0.80.
export function judgeB1({ score }) {
  const s = score.summary;
  const hits = (s.control_rule_hits ?? []).map((h) => /^([A-Za-z0-9]+): (.+)$/.exec(String(h))).filter(Boolean)
    .filter(([, item]) => NEGATIVE_CONTROLS.includes(item));
  const controls = new Set([...hits.map(([, item]) => item),
    ...score.items.filter((i) => NEGATIVE_CONTROLS.includes(i.id) && i.status === 'false-positive').map((i) => i.id)]);
  const onControls = new Set(hits.map(([, , finding]) => finding));
  const other = (s.false_positive_findings_distinct ?? []).filter((f) => !onControls.has(f));
  const precisionOk = s.precision === null || s.precision >= 0.8;
  return { ok: controls.size === 0 && other.length <= 1 && precisionOk, why: `controls confirmed ${[...controls].join(', ') || 'none'}, other false ${other.length}, precision ${s.precision}` };
}
export function judgeB2({ score }, id) {
  const { must, four } = MUST[kindOf(id)];
  const hits = four.filter((i) => full(score, i));
  return { ok: must.every((i) => full(score, i)) && hits.length >= 3, why: `full credit ${hits.join(', ') || 'none'}` };
}
export function judgeB3({ score, blind, records }) {
  if (!blind || !records) return null;
  const s = score.summary;
  const confirmed = records.findings.filter((f) => f.verdict === 'confirmed').map((f) => blind.findings?.[f.id]).filter(Boolean);
  const wrongClaims = confirmed.filter((b) => b.verdict === 'valid' && (b.incorrect_claims ?? []).length > 0).length;
  const understated = confirmed.filter((b) => b.severity === 'understated').length;
  const overstated = confirmed.filter((b) => b.severity === 'overstated').length;
  const counts = [num(s.unsupported_confirmations), num(s.mislocated), num(s.wrong_mechanism)];
  return { ok: counts.every((n) => n === 0) && wrongClaims === 0 && understated === 0 && overstated <= 1,
    why: `unsupported/mislocated/wrong mechanism ${counts.join('/')}, incorrect claims ${wrongClaims}, severity understated ${understated} overstated ${overstated}` };
}

// B5's coverage thresholds for one row (also B11's on syn-shelf): adjudicated
// census recall over every sealed mechanism, every population exact (at least
// one is required: both fixtures seal one), and no overclaim.
export function judgeCoverage({ score, blind, records }) {
  if (!blind || !records) return null;
  const recall = fraction(score.summary.coverage_recall_adjudicated);
  const populations = Object.entries(score.summary.population ?? {});
  const inexact = populations.filter(([, p]) => p.exact_adjudicated !== 'exact').map(([name]) => name);
  const overclaims = records.obligations.filter((o) => o.status === 'held' && o.coverage === 'all-enumerated')
    .filter((o) => blind.obligations?.[o.id]?.conclusion === 'disagree' || (blind.obligations?.[o.id]?.missing_members ?? []).length > 0).map((o) => o.id);
  return { ok: recall !== null && recall[0] === recall[1] && populations.length > 0 && inexact.length === 0 && overclaims.length === 0,
    why: `census ${score.summary.coverage_recall_adjudicated}, ${populations.length} population(s), not exact: ${inexact.join(', ') || 'none'}, overclaims: ${overclaims.join(', ') || 'none'}` };
}

export function evaluate(rows, extra = {}) {
  const c = {};
  c.B1 = perRow(rows, QUALITY_ROWS, judgeB1);
  c.B2 = perRow(rows, QUALITY_ROWS, judgeB2);
  c.B3 = perRow(rows, QUALITY_ROWS, judgeB3);
  c.B4 = perRow(rows, INC_ROWS, ({ score }) => ({ ok: score.incremental?.meets_threshold === true, why: `meets_threshold ${score.incremental?.meets_threshold}` }));
  c.B5 = perRow(rows, LEDGER_ROWS, judgeCoverage);
  c.B6 = (() => {
    const each = perRow(rows, ROW_IDS, ({ score, blind, records, metrics }) => {
      if (!records || !Array.isArray(metrics?.routing?.violations)) return null;
      const wrongRejections = num(score.summary.incorrect_rejections);
      const unsound = records.findings.filter((f) => f.verdict === 'rejected' && blind?.findings?.[f.id]?.counterevidence_sound === false).map((f) => f.id);
      const violations = num(metrics.routing?.violations);
      return { ok: wrongRejections === 0 && unsound.length === 0 && violations === 0, why: `wrong rejections ${wrongRejections}, unsound counterevidence ${unsound.join(', ') || 'none'}, routing violations ${violations}` };
    });
    if (each.status !== 'PASS') return each;
    const d = [...rows.values()].map((r) => r.score.delegations ?? {}).reduce((a, x) => ({ n: a.n + num(x.recorded), clean: a.clean + num(x.without_recovery), one: a.one + num(x.within_one_recovery) }), { n: 0, clean: 0, one: 0 });
    const ok = d.n === 0 || (d.clean / d.n >= 0.9 && d.one === d.n);
    return result(ok ? 'PASS' : 'FAIL', `${each.detail}; delegations ${d.clean}/${d.n} without recovery, ${d.one}/${d.n} within one`);
  })();
  // B7 and B12 come only from their judges (judgeB7, judgeB12), never from a
  // value someone typed into the rows manifest: main() ignores those.
  c.B7 = extra.b7 ?? blocked('no recorded and registered curated security package, or no scored security row');
  c.B8 = (() => {
    const missing = PAIRS.flat().filter((id) => !rows.has(id));
    if (missing.length) return blocked(`no registered row for ${missing.join(', ')}`);
    const disagreements = PAIRS.filter(([a, b]) => {
      const ra = rows.get(a).score;
      const rb = rows.get(b).score;
      if (INC_ROWS.includes(a)) return (ra.incremental?.meets_threshold === true) !== (rb.incremental?.meets_threshold === true);
      return MUST[kindOf(a)].must.some((i) => full(ra, i) !== full(rb, i));
    }).map((p) => p.join('/'));
    const memberFailures = ['B1', 'B2', 'B3', 'B4', 'B5'].filter((k) => c[k].status !== 'PASS');
    const ok = disagreements.length === 0 && memberFailures.length === 0;
    return result(ok ? 'PASS' : memberFailures.some((k) => c[k].status === 'BLOCKED') && disagreements.length === 0 ? 'BLOCKED' : 'FAIL',
      `pairs disagreeing on must-find items: ${disagreements.join(', ') || 'none'}; per-member criteria not passed: ${memberFailures.join(', ') || 'none'}`);
  })();
  // B9: the debt chain, and `check` green on every one of the 14 rows.
  c.B9 = perRow(rows, ROW_IDS, ({ score, check }, id) => {
    if (!check) return null;
    const green = check.valid === true;
    const why = [`check ${green ? 'green' : `fails (${(check.errors ?? []).slice(0, 2).join('; ')})`}`];
    let ok = green;
    const d = score.debt ?? {};
    if (id === 'D1') {
      ok = ok && d.status_ok === true && num(d.open_obligations_without_debt) === 0 && num(d.unverified_findings_without_debt) === 0;
      why.push(`status ${d.status}, uncovered ${num(d.open_obligations_without_debt) + num(d.unverified_findings_without_debt)}`);
    }
    if (id === 'D2') {
      ok = ok && d.passes === true;
      why.push(`debt-in ${d.dispositioned}/${d.debt_in} dispositioned`);
    }
    return { ok, why: why.join(', ') };
  });
  c.B10 = (() => {
    const missing = ROW_IDS.filter((id) => !rows.get(id)?.records || !rows.get(id)?.metrics);
    if (missing.length) return blocked(`records or metrics missing for ${missing.join(', ')}`);
    const within = ROW_IDS.filter((id) => observedCost(rows.get(id).records, rows.get(id).metrics).within_budget === true);
    return result(within.length >= 13 ? 'PASS' : 'FAIL', `observed calls within budget in ${within.length} of 14 rows`);
  })();
  // B11 (@2, D1): each Sonnet row meets every B1-B3 threshold on syn-shelf's
  // items, B5's coverage thresholds on syn-shelf, and scoring.g5.
  c.B11 = (() => {
    const sonnet = perRow(rows, SONNET_ROWS, (row, id) => {
      const parts = [['B1', judgeB1(row, id)], ['B2', judgeB2(row, id)], ['B3', judgeB3(row, id)], ['coverage', judgeCoverage(row, id)]];
      if (parts.some(([, p]) => p === null)) return null;
      const g5 = row.score.g5?.checks?.meets_all === true;
      const missed = [...parts.filter(([, p]) => !p.ok).map(([k, p]) => `${k} (${p.why})`), ...(g5 ? [] : ['scoring.g5'])];
      return { ok: missed.length === 0, why: missed.length ? `misses ${missed.join('; ')}: remove the Sonnet lead allowance before release` : 'meets B1-B3, coverage and scoring.g5' };
    });
    // The remedy applies only after both Sonnet rows were scored and one failed;
    // the routing change it declares must itself pass A1-A2.
    return sonnet.status === 'FAIL' && extra.b11_routing_removed === true
      ? result('PASS', `${sonnet.detail}; the manifest declares the Sonnet lead allowance removed, a routing change that must pass A1-A2`)
      : sonnet;
  })();
  c.B12 = extra.b12 ?? blocked('no owner real-run manifest (b12_runs) given');
  return { gate: GATE, gate_file_sha256_ok: gateFileOk(), part: 'B', criteria: c, verdict: verdictOf(c) };
}

// ---------------------------------------------------------------- B7 (@2)

// The security rows' evidence: the repeat ledger, the curated package and the
// matrix root's `curated/` folder, and SB1/SB2's rows. BLOCKED while anything
// is missing or the package is a test double; FAIL when the evidence
// contradicts the records or a threshold is missed. `locate` checks where the
// package lies (injected in tests: a test package lives in the temporary folder).
export function judgeB7({ rows, ledgerFile, curatedDir, evidenceDir }, { locate = curatedLocation } = {}) {
  if (!ledgerFile || !fs.existsSync(ledgerFile)) return blocked('no repeat ledger given');
  const events = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const supplement = events.find((e) => e.event === 'registered-supplement');
  const cur = supplement ? events.find((e) => e.seq === supplement.curated_seq && e.event === 'curated-package') : null;
  if (!cur) return blocked('no curated package is recorded and registered for the security rows');
  if (cur.test_double === true || supplement.test_double === true) return blocked('the recorded package is a test double: it is never independent evidence');
  if (!curatedDir || !fs.existsSync(curatedDir) || !evidenceDir) return blocked('the curated package folder or the security rows\' evidence folder is not given');
  const ledger = verifyLedger(ledgerFile, { external: { dir: curatedDir, evidenceDir } });
  if (!ledger.ok) return result('FAIL', `the ledger does not verify: ${ledger.problems.slice(0, 3).join('; ')}`);
  if (ledger.unchecked.length) return blocked(`the ledger leaves evidence unchecked: ${ledger.unchecked.slice(0, 3).join('; ')}`);
  const where = locate(curatedDir);
  if (where.location_sha256 !== cur.location_sha256) return result('FAIL', 'the package folder is not the recorded one');
  if (!(where.outside_kit && where.outside_git && where.outside_tmp)) return result('FAIL', 'the package lies in the kit, a Git work tree or the temporary folder');
  const pkg = curatedPackage(curatedDir);
  if (pkg.package_sha256 !== cur.package_sha256 || pkg.answers_sha256 !== cur.answers_sha256) return result('FAIL', 'the package or its answers changed since they were recorded');
  // Only a row's last attempt counts: its events after its last `voided` (as verifyLedger).
  const attempt = (id) => {
    const es = events.filter((e) => e.row === id);
    const v = es.findLastIndex((e) => e.event === 'voided');
    return es.slice(v + 1);
  };
  return perRow(rows, SECURITY_ROWS, ({ score, scoreSha256, records, recordsSha256, metrics, check }, id) => {
    if (!records || !recordsSha256 || !Array.isArray(metrics?.routing?.violations) || !check || !scoreSha256) return null;
    const es = attempt(id);
    const scored = es.filter((e) => e.event === 'scored' || e.event === 'rescored').at(-1);
    if (!scored) return null;
    if (scoreSha256 !== scored.score_sha256) return { ok: false, why: 'the score file is not the one the ledger froze' };
    if (recordsSha256 !== es.find((e) => e.event === 'adjudication-frozen')?.records_sha256) return { ok: false, why: 'the records file is not the one the adjudication froze' };
    if (score.official !== 'yes') return { ok: false, why: `the score is not official (${score.official})` };
    const boundary = score.items.filter((i) => i.gate_dimension === 'security-boundary');
    const crossings = boundary.filter((i) => i.expect === 'defect');
    const gaps = boundary.filter((i) => i.expect === 'no-defect');
    if (!crossings.length || !gaps.length) return { ok: false, why: `the answers hold ${crossings.length} crossing and ${gaps.length} defense-in-depth items; both are required` };
    const finding = (i) => records.findings.find((f) => f.id === i.finding);
    const missed = crossings.filter((i) => {
      const f = finding(i);
      return !(full(score, i.id) && f && f.kind === 'defect' && f.verdict === 'confirmed' && f.impact_dimension === 'security');
    }).map((i) => i.id);
    const overcalled = gaps.filter((i) => i.status === 'false-positive' || i.details?.outcome_class === 'disqualifying').map((i) => i.id);
    const violations = num(metrics.routing?.violations);
    const ok = missed.length === 0 && overcalled.length === 0 && check.valid === true && violations === 0;
    return { ok, why: `crossings not confirmed as security: ${missed.join(', ') || 'none'}; gaps confirmed as security: ${overcalled.join(', ') || 'none'}; check ${check.valid ? 'green' : 'fails'}; routing violations ${violations}` };
  });
}

// ---------------------------------------------------------------- B12 (@2)

// The owner's real runs (nthr-b12-runs@1, RELEASE-GATE-3.md §5), read only:
// each run's records and its namespace's decisions. The unit is each confirmed
// finding of each counted run, judged by the latest decision for its
// fingerprint in that namespace.
export function judgeB12(manifest, { read = readRun, decisions = readDecisions } = {}) {
  if (!manifest) return blocked('no owner real-run manifest (b12_runs) given');
  if (manifest.schema !== 'nthr-b12-runs@1' || !Array.isArray(manifest.runs) || !manifest.runs.length) return blocked('the real-run manifest is not nthr-b12-runs@1 with at least one run');
  const listed = [];
  // One run listed twice, under any spelling of its root, counts once: refuse it (roots compared case-insensitively).
  const runKey = (r) => [path.resolve(r.project_root).replace(/\\/g, '/').toLowerCase(), r.ns.replace(/\\/g, '/'), r.run_id].join('\0');
  const seen = new Set();
  for (const [i, r] of manifest.runs.entries()) {
    if (typeof r.project_root !== 'string' || typeof r.ns !== 'string' || typeof r.run_id !== 'string') return blocked(`run ${i + 1}: project_root, ns and run_id are required`);
    if (seen.has(runKey(r))) return blocked(`${r.run_id}: listed more than once`);
    seen.add(runKey(r));
    if (!['independent', 'contaminated'].includes(r.independence)) return blocked(`${r.run_id}: independence must be independent or contaminated (the owner declares it)`);
    if (r.independence === 'contaminated' && !String(r.reason ?? '').trim()) return blocked(`${r.run_id}: a contaminated run needs its reason`);
    let doc;
    try { ({ doc } = read(r.project_root, r.ns, r.run_id)); } catch (error) { return blocked(`${r.run_id}: cannot be read (${error.message})`); }
    if (!doc) return blocked(`${r.run_id}: cannot be read`);
    const eligible = ['task', 'incremental'].includes(doc.run.mode) && ['complete', 'incomplete'].includes(doc.run.status);
    listed.push({ ...r, doc, eligible });
  }
  const completed = listed.filter((r) => r.eligible);
  const counted = completed.filter((r) => r.independence === 'independent');
  const notEligible = listed.filter((r) => !r.eligible).map((r) => `${r.run_id} (${r.doc.run.mode}, ${r.doc.run.status})`);
  const contaminated = completed.filter((r) => r.independence === 'contaminated').map((r) => `${r.run_id}: ${r.reason}`);
  const head = `${listed.length} listed, ${completed.length} completed Task/Incremental, ${counted.length} independent${contaminated.length ? `; not counted (contaminated): ${contaminated.join('; ')}` : ''}${notEligible.length ? `; not eligible: ${notEligible.join(', ')}` : ''}`;
  if (counted.length < 3) return blocked(`${head}; at least 3 independent runs are required`);
  const latest = new Map();
  for (const r of counted) {
    const key = `${r.project_root}\0${r.ns}`;
    if (latest.has(key)) continue;
    let dec;
    try { dec = decisions(r.project_root, r.ns); } catch (error) { return blocked(`${r.ns}: decisions.json cannot be read (${error.message})`); }
    if (dec.errors?.length) return blocked(`${r.ns}: ${dec.errors[0]}`);
    const byFp = new Map(); // decisions are append-only by seq: the last entry for a fingerprint is its current decision
    for (const d of dec.doc?.decisions ?? []) byFp.set(d.fingerprint, d.decision);
    latest.set(key, byFp);
  }
  const findings = counted.flatMap((r) => r.doc.findings.filter((f) => f.verdict === 'confirmed').map((f) => ({ run: r.run_id, id: f.id, decision: latest.get(`${r.project_root}\0${r.ns}`).get(f.fingerprint) ?? null })));
  if (!findings.length) return blocked(`${head}; the counted runs hold no confirmed finding, so there is no precision evidence`);
  const undecided = findings.filter((f) => f.decision === null);
  if (undecided.length) return blocked(`${head}; ${undecided.length} of ${findings.length} counted findings have no owner decision: ${undecided.map((f) => `${f.run} ${f.id}`).join(', ')}`);
  const fp = findings.filter((f) => f.decision === 'false-positive').length;
  const share = fp / findings.length;
  return result(share <= 0.2 ? 'PASS' : 'FAIL', `${head}; owner-judged false positives ${fp}/${findings.length} (${(share * 100).toFixed(0)}%, at most 20%)`);
}

const verdictOf = (criteria) => (Object.values(criteria).every((x) => x.status === 'PASS') ? 'PASS' : 'NOT YET STABLE');

// ---------------------------------------------------------------- Part A

// The M5-T4 evidence the kit holds (manifest class "kit", evidence paths only:
// the ledger, answers, adjudications, reports, history and criteria; tooling may change).
const EVIDENCE = /tests\/fixtures\/(g5-ledger\.jsonl|g5-criteria\/.+|[^/]+\/(answers\.json|adjudications\/.+|reports\/.+|history\/.+))$/;
// A public copy holds none of it (docs/DEVELOPMENT.md): UNVERIFIED, never PASS.
export function sealedEvidence(review = REVIEW) {
  const state = sealedEvidenceState(review);
  if (state === 'absent') return result('UNVERIFIED', EVIDENCE_ABSENT);
  if (state === 'partial') return result('FAIL', 'only part of the sealed G5 evidence is present: the ledger, its manifest and the criteria are required together');
  const ledgerFile = path.join(review, 'tests', 'fixtures', 'g5-ledger.jsonl');
  const ledger = verifyLedger(ledgerFile);
  const digest = sha256(fs.readFileSync(ledgerFile));
  const manifest = JSON.parse(fs.readFileSync(path.join(review, 'tests', 'fixtures', 'g5-evidence-m5t4.json'), 'utf8'));
  const entries = manifest.files.filter((f) => f.class === 'kit' && EVIDENCE.test(f.label));
  const changed = entries.filter((f) => {
    const file = path.join(review, ...productPathOfLabel(f.label).split('/'));
    return !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== f.sha256;
  }).map((f) => f.label);
  const events = Number.isInteger(ledger.events) ? ledger.events : null;
  const ok = ledger.ok === true && events === HISTORICAL_LEDGER_EVENTS && digest === HISTORICAL_LEDGER_SHA256 && changed.length === 0 && entries.length > 0;
  return result(ok ? 'PASS' : 'FAIL', `verify-ledger ${ledger.ok ? 'ok' : 'FAILED'}${events === null ? '' : ` (${events} events)`}; ledger sha256 ${digest === HISTORICAL_LEDGER_SHA256 ? 'as recorded' : 'CHANGED'}; ${entries.length - changed.length}/${entries.length} manifest evidence files byte-identical${changed.length ? `; changed: ${changed.slice(0, 5).join(', ')}` : ''}`);
}

// The runtime files: every file under the runtime entries is listed in the
// lifecycle document's inventory by name and is LF-only, and the package
// manifest lists exactly these files and INSTALL.md, at their digests. The
// lifecycle document is INSTALL.md; the gate texts call it review.md, its
// name in the nth-dev-kit checkout (MIGRATION-VALIDATION.md).
export function runtimeInventory(review = REVIEW) {
  const doc = fs.readFileSync(path.join(review, DOC), 'utf8');
  const files = [];
  const walk = (rel) => {
    const abs = path.join(review, rel);
    if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(`${rel}/${n}`);
    else files.push(rel);
  };
  for (const entry of RUNTIME_ENTRIES) walk(entry);
  const unlisted = files.filter((f) => !doc.includes(path.basename(f)));
  const crlf = files.filter((f) => fs.readFileSync(path.join(review, f)).includes('\r\n'));
  const count = /the skill's (\d+) runtime files/.exec(doc)?.[1];
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(review, MANIFEST), 'utf8')); } catch { /* reported below */ }
  const manifestOk = pkg !== null && JSON.stringify(pkg) === JSON.stringify(buildManifest(review))
    && JSON.stringify(Object.keys(pkg.files).sort()) === JSON.stringify([DOC, ...files].sort());
  const ok = unlisted.length === 0 && crlf.length === 0 && Number(count) === files.length && manifestOk;
  return result(ok ? 'PASS' : 'FAIL', `${files.length} runtime files; ${DOC} states ${count ?? 'no count'}; unlisted: ${unlisted.join(', ') || 'none'}; CRLF: ${crlf.join(', ') || 'none'}; ${MANIFEST} ${pkg === null ? 'missing' : manifestOk ? 'current' : 'STALE'}`);
}

export function safetySwitches(review = REVIEW) {
  const nthr = fs.readFileSync(path.join(review, 'scripts', 'nthr.mjs'), 'utf8');
  const skill = fs.readFileSync(path.join(review, 'SKILL.md'), 'utf8');
  const disabled = /^export const OFFICIAL_AUDITS_ENABLED = false;$/m.test(nthr);
  const explicitOnly = /^disable-model-invocation: true$/m.test(skill.split('\n---')[0]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-gate-'));
  let exit = null;
  try {
    for (const args of [['init', '-q'], ['-c', 'user.name=g', '-c', 'user.email=g@x.invalid', 'commit', '-q', '--allow-empty', '-m', 'g']]) spawnSync('git', args, { cwd: dir, windowsHide: true });
    exit = spawnSync(process.execPath, [path.join(review, 'scripts', 'nthr.mjs'), 'new-run', '--ns', 'audits/x', '--mode', 'audit-plan', '--slug', 'p'], { cwd: dir, encoding: 'utf8', windowsHide: true }).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ok = disabled && explicitOnly && exit === 2;
  return result(ok ? 'PASS' : 'FAIL', `OFFICIAL_AUDITS_ENABLED false: ${disabled}; audit-plan new-run exit ${exit}; disable-model-invocation true: ${explicitOnly}`);
}

// Saved `node --test` output: counts, and the names of passing tests.
export function parseTap(text) {
  const count = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN);
  const skips = [...text.matchAll(/^ok \d+ - (.*?) # SKIP(.*)$/gm)].map((m) => ({ name: m[1], reason: m[2].trim() }));
  const passed = new Set([...text.matchAll(/^ok \d+ - (.*?)(?: # SKIP.*)?$/gm)].filter((m) => !/# SKIP/.test(m[0])).map((m) => m[1]));
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), skips, passed };
}

// A5: each of the 4 fixtures (each syn-ledger-inc variant, from one syn-ledger
// build) built twice in a row: the sealed heads both times, and byte-identical
// trees outside .git. `build(name, outDir, from)` returns { heads, manifest, dir }.
const sorted = (o) => JSON.stringify(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));
const answersOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'answers.json'), 'utf8'));
const realBuild = (name, outDir, from) => {
  const built = buildFixture(name, outDir, from ? { from } : {});
  return { heads: built.heads, manifest: manifest(built.fixture), dir: built.fixture };
};
export function fixtureDeterminism({ build = realBuild } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-gate-a5-'));
  try {
    const twice = (name, sealed, from) => {
      const [a, b] = [1, 2].map((n) => build(name, path.join(tmp, `${name}-${n}`), from));
      const headsOk = sorted(a.heads) === sorted(sealed) && sorted(b.heads) === sorted(sealed);
      const same = sorted(a.manifest) === sorted(b.manifest) && Object.keys(a.manifest ?? {}).length > 0;
      return { name, ok: headsOk && same, dir: a.dir, why: `${name}: ${headsOk ? 'sealed heads' : 'heads differ from the sealed ones'}, ${same ? 'identical trees' : 'trees differ'}` };
    };
    const ledger = twice('syn-ledger', answersOf('syn-ledger').heads);
    const inc = answersOf('syn-ledger-inc');
    const results = [
      ledger,
      ...['committed', 'rewritten', 'dirty'].map((v) => twice(v === 'committed' ? 'syn-ledger-inc' : `syn-ledger-inc-${v}`, inc.heads[v], ledger.dir)),
      twice('syn-debt', answersOf('syn-debt').heads),
      twice('syn-shelf', answersOf('syn-shelf').heads),
    ];
    return result(results.every((r) => r.ok) ? 'PASS' : 'FAIL', results.map((r) => r.why).join('; '));
  } catch (error) {
    return result('FAIL', `a build failed: ${error.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// B9's `check` of one row: the helper's own check on the run records.json
// names (<root>/.nth-review/<ns>/runs/<id>/records.json). Null when it is not one.
export function checkRecords(recordsPath) {
  const m = /^(.*)[\\/]\.nth-review[\\/](.+)[\\/]runs[\\/]([^\\/]+)[\\/]records\.json$/.exec(path.resolve(String(recordsPath ?? '')));
  if (!m || !fs.existsSync(recordsPath)) return null;
  const { errors } = checkRun(m[1], `${m[2].replaceAll('\\', '/')}/runs/${m[3]}`);
  return { valid: errors.length === 0, errors };
}

// The tests that carry A8-A10 (by name; a renamed test must be added here).
// They are part of A1 and A2; these must pass on every platform given.
export const NAMED = {
  A8: [/^A4: a cited untracked file edited after the evidence/, /^S-A7: evidence on a file absent at the origin/, /^lifecycle: /],
  A9: [/^hardening 2: complete is process status, Verified is coverage/, /^A2: an obligation is never held while its own defect/],
  A10: [/^A1: a refuter-decided defect follows the refuter/],
};

export function offline({ taps = {}, rehearsal = null, review = REVIEW, a4 = () => sealedEvidence(review), a5 = () => fixtureDeterminism() } = {}) {
  const c = {};
  const suite = (labels) => {
    const present = labels.filter((l) => taps[l]);
    if (present.length < labels.length) return result('UNVERIFIED', `no saved test output for ${labels.filter((l) => !taps[l]).join(', ')}`);
    const parsed = present.map((l) => [l, parseTap(taps[l])]);
    const bad = parsed.filter(([, p]) => !(p.fail === 0 && p.tests > 0 && p.skips.every((s) => s.reason.length > 0)));
    return result(bad.length ? 'FAIL' : 'PASS', parsed.map(([l, p]) => `${l}: ${p.pass} pass, ${p.fail} fail, ${p.skipped} skipped`).join('; '));
  };
  c.A1 = suite(['windows-gitbash', 'windows-powershell']);
  c.A2 = suite(['linux-node20', 'linux-node22']);
  if (rehearsal === null) c.A3 = result('UNVERIFIED', 'no saved rehearsal output');
  else {
    const m = /(\d+) rows?: (\d+) pass, (\d+) fail, (\d+) unverified/.exec(rehearsal);
    c.A3 = m && Number(m[3]) === 0 ? result('PASS', m[0]) : result('FAIL', m ? m[0] : 'no summary line in the rehearsal output');
  }
  c.A4 = a4();
  c.A5 = a5();
  const named = (key) => {
    const labels = Object.keys(taps);
    if (labels.length === 0) return result('UNVERIFIED', 'no saved test output');
    const missing = [];
    for (const label of labels) {
      const { passed } = parseTap(taps[label]);
      for (const re of NAMED[key]) if (![...passed].some((n) => re.test(n))) missing.push(`${label}: ${re.source}`);
    }
    return result(missing.length ? 'FAIL' : 'PASS', missing.length ? `not passed: ${missing.join('; ')}` : `passed in ${labels.join(', ')}`);
  };
  c.A6 = runtimeInventory(review);
  c.A7 = safetySwitches(review);
  c.A8 = named('A8');
  c.A9 = named('A9');
  c.A10 = named('A10');
  c.A11 = platformProblem('win32') === null && platformProblem('linux') !== null && platformProblem('darwin') !== null
    ? result('PASS', 'register, record-isolation and drive refuse off win32')
    : result('FAIL', 'the matrix would start sessions on an unverified platform');
  return { gate: GATE, gate_file_sha256_ok: gateFileOk(), part: 'A', criteria: c, verdict: verdictOf(c) };
}

// ---------------------------------------------------------------- CLI

const readJson = (file) => (file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'offline') {
    const taps = {};
    let rehearsal = null;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--tap') { const [label, file] = rest[++i].split(/=(.*)/s); taps[label] = fs.readFileSync(file, 'utf8'); }
      else if (rest[i] === '--rehearsal') rehearsal = fs.readFileSync(rest[++i], 'utf8');
      else { process.stderr.write(`unknown argument ${rest[i]}\n`); return 2; }
    }
    process.stdout.write(`${JSON.stringify(offline({ taps, rehearsal }), null, 2)}\n`);
    return 0;
  }
  if (command === 'evaluate') {
    const at = rest.indexOf('--rows');
    if (at === -1) { process.stderr.write('usage: evaluate --rows <manifest.json>\n'); return 2; }
    const manifest = readJson(rest[at + 1]);
    const rows = new Map((manifest.rows ?? []).map((r) => [r.id, {
      id: r.id, score: readJson(r.score), scoreSha256: r.score && fs.existsSync(r.score) ? sha256(fs.readFileSync(r.score)) : null,
      blind: readJson(r.blind), records: readJson(r.records), recordsSha256: r.records && fs.existsSync(r.records) ? sha256(fs.readFileSync(r.records)) : null, metrics: readJson(r.metrics), check: r.records ? checkRecords(r.records) : null,
    }]));
    // B7 and B12 from their evidence only; a typed `b7` or `b12` value is ignored.
    const ignored = ['b7', 'b12'].filter((k) => k in manifest);
    const b7 = judgeB7({ rows, ledgerFile: manifest.ledger ?? null, curatedDir: manifest.curated ?? null, evidenceDir: manifest.curated_evidence ?? null });
    const b12 = manifest.b12_runs ? judgeB12(readJson(manifest.b12_runs)) : null;
    const out = evaluate(rows, { b7, b12, b11_routing_removed: manifest.b11_routing_removed === true });
    process.stdout.write(`${JSON.stringify({ label: manifest.label ?? null, ...out, ...(ignored.length ? { ignored_inputs: ignored } : {}) }, null, 2)}\n`);
    return 0;
  }
  process.stderr.write('usage: release-gate.mjs offline [--tap <label>=<file>]... [--rehearsal <file>] | evaluate --rows <manifest.json>\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
