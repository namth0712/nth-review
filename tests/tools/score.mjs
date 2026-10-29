// M5-T3 scoring. Library-only test tooling: Enable never installs it.
//
// Scores one finished run against the sealed answers of its fixture, following
// tests/fixtures/README.md (Evaluation criteria and its M5-T3 clarifications).
// It reads only the answers, the run's records.json, the reviewed fixture
// tree and, if given, a human adjudication file and an M5-T2 metrics file. It
// never copies answers into a fixture or a prompt, and never changes a run.
//
// Matching:
// - a finding matches an item when one of its **trace** anchors overlaps a
//   `site` or `sink` anchor of the item within `scoring.line_tolerance` lines;
//   an anchor wider than SPAN_LIMIT lines never matches or supports anything;
// - counterevidence never creates a match to a defect claim. It earns
//   refutation credit only on a rejected candidate, against the item's
//   `refutation.counterevidence_anchor_refs`;
// - a heading anchor supports a `rule` line only when it is the innermost
//   heading over that line;
// - one finding per item, assigned greedily and deterministically (most
//   overlapping anchors, then most required evidence, then ids); other
//   findings that overlap an assigned item go to adjudication;
// - an obligation counts toward an item only when one of its checks is the
//   item's, or in the same taxonomy family;
// - mechanism facts, partial matches, unplanned findings and census coverage
//   through evidence are judged by a person, in the adjudication file;
// - or, from M5-T4, by a blind adjudicator (`nthr-adjudication-blind@1`) who
//   never saw the answers. Its file is keyed by record ids, frozen by sha256
//   before scoring, and mapped onto the items here by fixed rules (mapBlind).
//   Whatever the blind file cannot settle stays pending and earns nothing.
//
// Usage: node score.mjs --answers <answers.json> --run <run dir> --fixture <dir>
//          [--adjudication <file> [--adjudication-meta <file>]] [--metrics <file>]
//          [--format json|markdown]
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { manifest } from '../fixtures/build.mjs';
import { globMatches } from '../../scripts/lib/check.mjs';

export const SCHEMA = 'nthr-score@1';
export const SPAN_LIMIT = 30;
const SITE_ROLES = new Set(['site', 'sink']);
// Where a blind adjudicator may locate an item's cause: its site, sink or propagation lines.
const CAUSE_ROLES = new Set(['site', 'sink', 'propagation']);
const POSITIVE = new Set(['defect', 'doc-drift']);
const HONEST = new Set(['needs-runtime', 'outside-fact']);
const CENSUS_STATUSES = new Set(['covered', 'partial', 'missed', 'false-positive']);
const FINDING_VERDICTS = /^(valid-unplanned|false-positive|duplicate-of \S+|pending)$/;
export const BLIND_SCHEMA = 'nthr-adjudication-blind@1';
const BLIND_VERDICT = /^(valid|false|unsupported|cannot-tell|duplicate-of \S+)$/;
const BLIND_CONCLUSION = new Set(['agree', 'disagree', 'cannot-tell']);
const BLIND_CLASSIFICATION = new Set(['correct', 'incorrect', 'cannot-tell']);
const family = (c) => String(c).split('.')[0];
// A required evidence entry names one anchor (`anchor_ref`) or alternatives (`anchor_refs`, any of).
export const evidenceRefs = (e) => (Array.isArray(e.anchor_refs) ? e.anchor_refs : [e.anchor_ref]);
// An obligation is about an item when one of its checks is one of the item's,
// or in the same taxonomy family.
const sameConcern = (o, item) => (o.checks ?? []).some((c) => item.checks.includes(c) || item.checks.map(family).includes(family(c)));

// ---------------------------------------------------------------- anchors

// `path:L1-L2`, `path:L`, `path#Heading` or `path`.
export function parseAnchor(anchor) {
  if (typeof anchor !== 'string' || !anchor) return null;
  const hash = anchor.indexOf('#');
  if (hash >= 0) return { path: anchor.slice(0, hash), lines: null, heading: anchor.slice(hash + 1) };
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(anchor);
  if (m) return { path: m[1], lines: [Number(m[2]), Number(m[3] ?? m[2])], heading: null };
  return { path: anchor, lines: null, heading: null };
}

const tooWide = (a) => Boolean(a?.lines && a.lines[1] - a.lines[0] + 1 > SPAN_LIMIT);

export function overlaps(a, b, tolerance) {
  if (!a || !b || a.path !== b.path || !a.lines || !b.lines || tooWide(a)) return false;
  return a.lines[0] - tolerance <= b.lines[1] && b.lines[0] - tolerance <= a.lines[1];
}

const HEADING = /^#{1,6}\s/;
// The line of the innermost Markdown heading above `line`, and its text.
function innermostHeading(fixture, file, line) {
  try {
    const lines = fs.readFileSync(path.join(fixture, ...file.split('/')), 'utf8').split('\n');
    for (let i = Math.min(line, lines.length) - 1; i >= 0; i -= 1) if (HEADING.test(lines[i])) return lines[i].replace(/^#{1,6}\s+/, '').trim();
  } catch { /* unreadable */ }
  return null;
}

function headingExists(fixture, file, heading) {
  try {
    return fs.readFileSync(path.join(fixture, ...file.split('/')), 'utf8').split('\n').some((l) => HEADING.test(l) && l.replace(/^#{1,6}\s+/, '').trim() === heading.trim());
  } catch {
    return false;
  }
}

// Does a cited anchor support an answers anchor? Line ranges overlap within the
// tolerance; a heading anchor supports a `rule` anchor only as its innermost heading.
function supports(cited, target, fixture, tolerance) {
  if (overlaps(cited, target, tolerance)) return true;
  if (cited?.heading && target.role === 'rule' && cited.path === target.path && target.lines) {
    return innermostHeading(fixture, cited.path, target.lines[0]) === cited.heading.trim();
  }
  return false;
}

function anchorResolves(fixture, a) {
  const p = parseAnchor(a);
  if (!p) return false;
  const file = path.join(fixture, ...p.path.split('/'));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  if (p.heading) return headingExists(fixture, p.path, p.heading);
  if (!p.lines) return true;
  const count = fs.readFileSync(file, 'utf8').split('\n').length;
  return p.lines[0] >= 1 && p.lines[0] <= p.lines[1] && p.lines[1] <= count;
}

// ---------------------------------------------------------------- version

// Read-only Git in a tree the reviewed agent could have written: no fsmonitor,
// no hooks, no optional locks.
function readGit(dir, args) {
  return spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '--no-optional-locks', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

// Whether the reviewed tree is the version the answers describe: the answers'
// heads (per variant for an Incremental fixture) against the run's snapshot,
// the tree's heads and tracked state against the snapshot, and every answers
// anchor in the tree.
// Every file outside `.git/` and `.nth-review/` (and the ones named), as one
// sha256: the matrix runner records it in the ledger before each session.
export function treeDigest(dir, { skip = [] } = {}) {
  const m = manifest(dir);
  const kept = Object.entries(m).filter(([rel]) => !rel.startsWith('.nth-review/') && !skip.some((x) => rel === x || rel.startsWith(`${x}/`))).sort(([a], [b]) => a.localeCompare(b));
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(kept)).digest('hex'), files: Object.fromEntries(kept) };
}

// M5-T4 correction 2 (owner-approved): with the tree digest frozen before the
// run, uncommitted changes count as intended when the tree still equals that
// snapshot (a variant that is dirty by design), and any change since the
// snapshot, tracked or not, is a mismatch. Without it, the check is as before.
export function versionCheck(answers, records, fixture, { preRunTreeSha256 = null } = {}) {
  const snap = Object.fromEntries((records.snapshot?.repos ?? []).map((r) => [r.path, r.head]));
  let expected = answers.heads ?? {};
  let variant = null;
  if (answers.variants) {
    variant = Object.keys(answers.variants).find((v) => expected[v] && Object.entries(expected[v]).every(([repo, head]) => snap[repo] === head)) ?? null;
    expected = variant ? expected[variant] : {};
  }
  const problems = [];
  if (!Object.keys(expected).length) problems.push(answers.variants ? 'the run matches no sealed variant' : 'the answers pin no heads');
  const headDiffs = Object.entries(expected).filter(([repo, head]) => snap[repo] !== head).map(([repo, head]) => ({ repo, answers: head, run: snap[repo] ?? null }));
  const treeDiffs = [];
  const preRun = preRunTreeSha256 ? { frozen_sha256: preRunTreeSha256, now_sha256: treeDigest(fixture).sha256 } : null;
  if (preRun) preRun.unchanged = preRun.now_sha256 === preRun.frozen_sha256;
  const intended = [];
  for (const repo of Object.keys(snap)) {
    const dir = path.join(fixture, repo);
    const head = readGit(dir, ['rev-parse', 'HEAD']);
    const status = readGit(dir, ['status', '--porcelain', '--untracked-files=no']);
    if (head.status !== 0 || head.stdout.trim() !== snap[repo]) treeDiffs.push({ repo, issue: 'head differs from the run snapshot' });
    else if (status.status !== 0 || status.stdout.trim()) {
      if (preRun?.unchanged) intended.push(repo);
      else treeDiffs.push({ repo, issue: 'tracked changes since the run' });
    }
  }
  if (preRun && !preRun.unchanged) treeDiffs.push({ repo: '*', issue: 'the tree differs from the frozen pre-run snapshot' });
  const anchors = [
    ...(answers.items ?? []).flatMap((i) => i.anchors.map((a) => ({ owner: i.id, a }))),
    ...(answers.census?.mechanisms ?? []).map((m) => ({ owner: m.id, a: m })),
  ];
  const missing = anchors.filter(({ a }) => {
    try {
      const lines = fs.readFileSync(path.join(fixture, ...a.path.split('/')), 'utf8').split('\n');
      return !lines.slice(a.lines[0] - 1, a.lines[1]).some((l) => l.includes(a.contains));
    } catch {
      return true;
    }
  }).map(({ owner, a }) => `${owner}: ${a.path}:${a.lines.join('-')}`);
  const status = problems.length ? 'unpinned' : treeDiffs.length || missing.length ? 'mismatch' : headDiffs.length ? 'heads-differ' : 'verified';
  return {
    status,
    ...(answers.variants ? { variant } : {}),
    problems,
    answers_heads_vs_run: headDiffs,
    tree_vs_run: treeDiffs,
    ...(preRun ? { pre_run_snapshot: { ...preRun, uncommitted_changes_matching_it: intended } } : {}),
    answers_anchors_missing_in_tree: missing,
    rule: 'Defect scores are official only when status is verified; otherwise every item score is unverified.',
  };
}

// ---------------------------------------------------------------- predicates

function predicateHolds(pred, { finding = null, obligation = null, census = null, raised = true }) {
  if (pred.not_raised) return !raised;
  const check = (obj, spec) => obj && Object.entries(spec).every(([k, values]) => !Array.isArray(values) || values.includes(obj[k]));
  if (pred.finding && !check(finding, pred.finding)) return false;
  if (pred.obligation && !check(obligation, pred.obligation)) return false;
  if (pred.census && !check(census, pred.census)) return false;
  if (pred.debt) return false; // debt predicates are scored by debtCheck
  return Boolean(pred.finding || pred.obligation || pred.census);
}

function outcomeClass(item, ctx) {
  for (const cls of ['disqualifying', 'full', 'partial', 'honest']) {
    if ((item.outcomes?.[cls] ?? []).some((p) => predicateHolds(p, ctx))) return cls;
  }
  return 'none';
}

// The anchors that refute a no-defect item: its counterevidence references,
// else its refutation anchors.
function refutationAnchors(item) {
  const refs = item.refutation?.counterevidence_anchor_refs;
  if (Array.isArray(refs) && refs.length) return refs.map((i) => item.anchors[i]).filter(Boolean);
  return item.anchors.filter((a) => a.role === 'refutation');
}

// ---------------------------------------------------------------- scoring

// Rule 4 as registered (v1): a confirmed defect whose trace overlaps any anchor
// of a control (no-defect: its site lines; census-only: any of its anchors) is
// a false positive. Rule 4 v2 (M5-T4, proposed for future pre-registered
// benchmarks only; never applied to a completed official run) also requires
// the finding to share the item's concern (one of its checks in the item's
// check families, through the finding's obligation) and matches only the
// item's site or sink lines. `rule4: 'v2-diagnostic'` computes it, and the
// result is labelled not official.
export function score({ answers, answersSha256, records, recordsSha256 = null, fixture, adjudication = null, adjudicationSha256 = null, adjudicationMeta = null, metrics = null, preRunTreeSha256 = null, rule4 = 'v1' }) {
  const v2 = rule4 === 'v2-diagnostic';
  const tol = answers.scoring?.line_tolerance ?? 3;
  const version = versionCheck(answers, records, fixture, { preRunTreeSha256 });
  const official = version.status === 'verified';
  const blindCheck = adjudication?.schema === BLIND_SCHEMA ? validateBlind(adjudication, adjudicationMeta, adjudicationSha256, records, recordsSha256) : null;
  const blind = blindCheck?.summary.status === 'applied' ? blindCheck : null;
  const adj = blindCheck ? { items: {}, findings: {}, population: null, summary: blindCheck.summary } : validateAdjudication(adjudication, answers, answersSha256, records);
  const findings = records.findings ?? [];
  const obligations = new Map((records.obligations ?? []).map((o) => [o.id, o]));
  const intents = new Map((records.scope?.intent ?? []).map((i) => [i.id, i.anchor]));
  const cited = (f) => {
    const ob = obligations.get(f.obligation);
    return [
      ...f.trace.map((t) => t.anchor),
      ...(ob ? [...ob.evidence.map((e) => e.anchor), ...ob.assumptions.map((a) => a.anchor).filter(Boolean), ...ob.intent.map((id) => intents.get(id)).filter(Boolean)] : []),
    ].map(parseAnchor).filter(Boolean);
  };
  const traceOf = (f) => f.trace.map((t) => parseAnchor(t.anchor)).filter(Boolean);
  // A finding's concern is its obligation's checks; with no obligation it shares every concern (counted, as v1 does).
  const findingConcern = (f, item) => { const ob = obligations.get(f.obligation); return !ob || sameConcern(ob, item); };
  const items = answers.items ?? [];
  const wide = [
    ...findings.flatMap((f) => f.trace.filter((t) => tooWide(parseAnchor(t.anchor))).map((t) => `${f.id} trace ${t.anchor}`)),
    ...[...obligations.values()].flatMap((o) => o.evidence.filter((e) => tooWide(parseAnchor(e.anchor))).map((e) => `${o.id} evidence ${e.anchor}`)),
  ];

  // Candidate pairs: items a finding can claim (no-defect items are controls).
  const pairs = [];
  for (const item of items.filter((i) => POSITIVE.has(i.expect) || HONEST.has(i.expect))) {
    const sites = item.anchors.filter((a) => SITE_ROLES.has(a.role));
    for (const f of findings) {
      const trace = traceOf(f);
      const hits = sites.filter((s) => trace.some((t) => overlaps(t, s, tol))).length;
      if (!hits) continue;
      const all = cited(f);
      const req = item.required_evidence.filter((e) => evidenceRefs(e).some((ref) => all.some((c) => supports(c, item.anchors[ref], fixture, tol)))).length;
      pairs.push({ item, f, hits, req });
    }
  }
  pairs.sort((a, b) => b.hits - a.hits || b.req - a.req || a.f.id.localeCompare(b.f.id) || a.item.id.localeCompare(b.item.id));
  const assigned = new Map();
  const usedFindings = new Set();
  for (const p of pairs) {
    if (assigned.has(p.item.id) || usedFindings.has(p.f.id)) continue;
    assigned.set(p.item.id, p);
    usedFindings.add(p.f.id);
  }
  if (blind) Object.assign(adj, mapBlind({ blind, assigned, findings, usedFindings, fixture, tol }));

  const itemResults = [];
  const adjudicationNeeded = [];
  for (const item of items) {
    const sites = item.anchors.filter((a) => SITE_ROLES.has(a.role));
    const r = { id: item.id, gating: item.gating, gate_dimension: item.gate_dimension ?? null, category: item.category, expect: item.expect, status: null, finding: null, details: {} };
    if (POSITIVE.has(item.expect) || HONEST.has(item.expect)) {
      const p = assigned.get(item.id);
      // Only obligations that check what the item is about can hold or open it.
      const coveringObligations = [...obligations.values()].filter((o) => sameConcern(o, item) && o.evidence.some((e) => sites.some((s) => overlaps(parseAnchor(e.anchor), s, tol))));
      const a = adj.items[item.id];
      if (p) {
        const f = p.f;
        const ob = obligations.get(f.obligation) ?? null;
        const cls = outcomeClass(item, { finding: f, obligation: ob });
        const evidenceCoverage = p.req / Math.max(1, item.required_evidence.length);
        const adjudicated = a && a.finding === f.id;
        const factsOk = adjudicated ? Array.isArray(a.mechanism_facts) && a.mechanism_facts.length === item.mechanism_facts.length && a.mechanism_facts.every((x) => x === true) : null;
        const wrongClaims = adjudicated ? (a.wrong_claims ?? []) : null;
        r.finding = f.id;
        r.details = {
          outcome_class: cls, verdict: f.verdict, kind: f.kind, location_overlaps: p.hits,
          required_evidence: `${p.req}/${item.required_evidence.length}`, mechanism_facts: adjudicated ? a.mechanism_facts ?? 'not given' : 'pending', wrong_claims: wrongClaims ?? 'pending',
          verification: f.verification ? `${f.verification.role}/${f.verification.model ?? '-'}/${f.verification.outcome ?? '-'}` : null,
        };
        if (cls === 'disqualifying') r.status = f.verdict === 'rejected' ? 'incorrect-rejection' : 'incorrectly-classified';
        else if (cls === 'full' && evidenceCoverage < 1) r.status = f.verdict === 'confirmed' ? 'unsupported-confirmation' : 'partial-pending';
        else if (cls === 'full' && !adjudicated) r.status = 'pending-adjudication';
        else if (cls === 'full' && factsOk && wrongClaims.length === 0) r.status = 'true-positive';
        else if (cls === 'full') r.status = 'wrong-mechanism';
        else if (cls === 'partial') r.status = adjudicated && a.same_root_cause === true ? 'partial' : adjudicated && a.same_root_cause === false ? 'missed (other root cause)' : 'partial-pending';
        else if (cls === 'honest') r.status = 'honest-open';
        else r.status = 'unclassified-match';
        if (/pending/.test(r.status)) adjudicationNeeded.push(`${item.id}: ${r.status === 'pending-adjudication' ? 'mechanism facts' : 'same root cause and evidence'} for ${f.id}`);
      } else {
        const sameFile = findings.filter((f) => !usedFindings.has(f.id) && traceOf(f).some((t) => sites.some((s) => s.path === t.path)));
        const honest = coveringObligations.find((o) => o.status === 'open' && ['honest', 'full'].includes(outcomeClass(item, { obligation: o })));
        const held = coveringObligations.find((o) => o.status === 'held');
        r.details = { covering_obligations: coveringObligations.map((o) => `${o.id}:${o.status}${o.open_reason ? `/${o.open_reason}` : ''}`), same_file_findings: sameFile.map((f) => f.id) };
        if (honest && HONEST.has(item.expect)) r.status = 'honest-open';
        else if (honest) r.status = 'missed-honest-open';
        else if (held) r.status = 'missed-held';
        else if (sameFile.length) { r.status = 'mislocated'; adjudicationNeeded.push(`${item.id}: same-file findings ${sameFile.map((f) => f.id).join(', ')} at other lines`); }
        else r.status = 'missed';
      }
    } else if (item.expect === 'census-only') {
      const cov = censusCoverage(item.anchors, records, obligations, tol);
      const ruleAnchors = v2 ? item.anchors.filter((a) => SITE_ROLES.has(a.role)) : item.anchors;
      const disq = findings.filter((f) => traceOf(f).some((t) => ruleAnchors.some((s) => overlaps(t, s, tol))) && outcomeClass(item, { finding: f }) === 'disqualifying' && (!v2 || findingConcern(f, item)));
      r.details = { site: cov.site, others: cov.others };
      const siteFull = cov.site.covered && cov.site.via !== 'census-item:unknown';
      r.status = disq.length ? 'false-positive' : siteFull ? 'covered' : cov.site.covered || cov.others.some((o) => o.covered) || cov.site.named ? 'partial' : 'missed';
      if (disq.length) r.details.false_positive_findings = disq.map((f) => f.id);
      if (v2) {
        const nearAny = findings.filter((f) => traceOf(f).some((t) => item.anchors.some((s) => overlaps(t, s, tol))) && outcomeClass(item, { finding: f }) === 'disqualifying');
        const cleared = nearAny.filter((f) => !disq.includes(f)).map((f) => f.id);
        if (cleared.length) r.details.near_but_not_on_site_or_concern = cleared;
      }
      const a = adj.items[item.id];
      if (blind) {
        if (r.status === 'covered') {
          const v = blindCoverage(cov.site, blind);
          r.details.automatic_status = r.status;
          r.details.adjudication = v.basis;
          r.status = v.verdict === 'ok' ? 'covered' : v.verdict === 'bad' ? 'partial' : 'pending-adjudication';
        }
        if (r.status === 'pending-adjudication' || r.status === 'partial') adjudicationNeeded.push(`${item.id}: census coverage via ${cov.site.covered ? cov.site.via : 'text or other anchors'}`);
      } else if (a?.status) { r.details.automatic_status = r.status; r.status = a.status; r.details.adjudication = a.basis ?? null; }
      else if (r.status === 'partial' || (r.status === 'covered' && ['obligation-evidence', 'assumption'].includes(cov.site.via))) adjudicationNeeded.push(`${item.id}: census coverage via ${cov.site.covered ? cov.site.via : 'text or other anchors'}`);
    } else if (item.expect === 'no-defect') {
      const near = findings.filter((f) => traceOf(f).some((t) => sites.some((s) => overlaps(t, s, tol))));
      const touching = v2 ? near.filter((f) => findingConcern(f, item)) : near;
      const disq = touching.filter((f) => outcomeClass(item, { finding: f }) === 'disqualifying');
      const refuting = refutationAnchors(item);
      const rejected = touching.filter((f) => f.verdict === 'rejected' && f.counterevidence.some((c) => refuting.some((x) => overlaps(parseAnchor(c.anchor), x, tol))));
      const distinguished = findings.filter((f) => f.counterevidence.some((c) => [...refuting, ...sites].some((x) => overlaps(parseAnchor(c.anchor), x, tol))));
      const coveringObligations = [...obligations.values()].filter((o) => o.evidence.some((e) => sites.some((s) => overlaps(parseAnchor(e.anchor), s, tol))));
      // A held obligation counts only when it checks exactly what the control is about.
      const exact = coveringObligations.find((o) => o.status === 'held' && o.checks.some((c) => item.checks.includes(c)));
      const sameFamily = coveringObligations.find((o) => o.status === 'held' && sameConcern(o, item));
      r.details = {
        raised: touching.map((f) => `${f.id}:${f.kind}/${f.verdict}`),
        rejected_with_counterevidence: rejected.map((f) => f.id),
        named_as_counterevidence_by: distinguished.map((f) => f.id),
        covering_obligations: coveringObligations.map((o) => `${o.id}:${o.status}`),
        ...(v2 && near.length !== touching.length ? { near_but_other_concern: near.filter((f) => !touching.includes(f)).map((f) => f.id) } : {}),
      };
      if (blind) {
        const disputed = touching.filter((f) => blind.findings[f.id]?.verdict === 'valid').map((f) => f.id);
        if (disputed.length) r.details.adjudicator_judged_valid = disputed;
      }
      if (disq.length) { r.status = 'false-positive'; r.details.false_positive_findings = disq.map((f) => f.id); }
      else if (rejected.length) r.status = 'correctly-rejected';
      else if (exact) r.status = 'correctly-held';
      else if (!touching.length && (item.outcomes.full ?? []).some((p) => p.not_raised)) r.status = 'not-raised (full)';
      else if (distinguished.length) r.status = 'not-raised (distinguished in counterevidence; reported, not credited)';
      else if (sameFamily) r.status = 'not-raised (held in the same family only; reported, not credited)';
      else if (!touching.length) r.status = 'not-raised';
      else r.status = 'raised-unresolved';
    }
    if (!official) r.official = 'unverified';
    itemResults.push(r);
  }

  // Findings not assigned to an item.
  const unmatched = [];
  for (const f of findings.filter((x) => !usedFindings.has(x.id))) {
    const overlapsItems = items.filter((i) => traceOf(f).some((t) => i.anchors.filter((a) => SITE_ROLES.has(a.role)).some((s) => overlaps(t, s, tol)))).map((i) => i.id);
    // Allowances near the finding's trace: a hint for the adjudicator, never a match.
    const allowance = (answers.unplanned_allowances ?? []).filter((a) => a.anchors.some((x) => traceOf(f).some((t) => overlaps(t, x, tol)))).map((a) => a.id);
    const controlFp = itemResults.some((r) => r.details.false_positive_findings?.includes(f.id));
    const a = adj.findings[f.id];
    const verdict = controlFp ? 'false-positive (control)' : a?.verdict ?? 'pending';
    if (!controlFp && (!a || a.verdict === 'pending')) adjudicationNeeded.push(`${f.id}: unmatched ${f.kind}/${f.verdict}`);
    unmatched.push({ id: f.id, kind: f.kind, verdict: f.verdict, overlaps_items: overlapsItems, allowances_nearby: allowance, anchors_resolve: f.trace.every((t) => anchorResolves(fixture, t.anchor)), adjudication: verdict, basis: a?.basis ?? null, category: a?.category ?? null });
  }

  // Counts.
  const count = (pred) => itemResults.filter(pred).length;
  const positives = itemResults.filter((r) => POSITIVE.has(r.expect));
  const findingOf = (id) => findings.find((f) => f.id === id);
  const confirmed = findings.filter((f) => f.verdict === 'confirmed');
  const tpAll = itemResults.filter((r) => r.status === 'true-positive');
  const tpConfirmed = tpAll.filter((r) => findingOf(r.finding)?.verdict === 'confirmed').length;
  const validUnplanned = unmatched.filter((u) => u.verdict === 'confirmed' && /^valid/.test(u.adjudication)).length;
  const fpUnmatched = unmatched.filter((u) => u.verdict === 'confirmed' && u.adjudication === 'false-positive').length;
  const unsupported = count((r) => r.status === 'unsupported-confirmation');
  const coverage = censusRecall(answers, records, obligations, tol, blind);
  const anchorsAll = [
    ...findings.flatMap((f) => [...f.trace.map((t) => t.anchor), ...f.counterevidence.map((c) => c.anchor).filter(Boolean)]),
    ...[...obligations.values()].flatMap((o) => [...o.evidence.map((e) => e.anchor), ...o.assumptions.map((x) => x.anchor).filter(Boolean)]),
  ];
  const resolving = anchorsAll.filter((x) => anchorResolves(fixture, x)).length;
  const traceOrder = findings.filter((f) => {
    const roles = f.trace.map((t) => t.role);
    const e = roles.indexOf('entrypoint');
    const s = roles.lastIndexOf('sink');
    return e < 0 || s < 0 || e < s;
  }).length;
  const matched = itemResults.filter((r) => r.finding);
  const summary = {
    true_positives: tpAll.length,
    true_positives_confirmed: tpConfirmed,
    true_positives_needs_validation: tpAll.length - tpConfirmed,
    partial: count((r) => r.status === 'partial'),
    pending_adjudication: count((r) => /pending/.test(r.status)),
    false_negatives: positives.filter((r) => /^missed|^incorrect|^unclassified/.test(r.status)).length,
    false_positives: count((r) => r.status === 'false-positive') + fpUnmatched + unsupported,
    false_positive_breakdown: { controls: count((r) => r.status === 'false-positive'), unmatched_adjudicated: fpUnmatched, unsupported_confirmations: unsupported },
    // `false_positives` counts rule hits (one per control or census item a finding disqualifies, plus each
    // unmatched false finding and unsupported confirmation); precision counts findings. These say how they relate.
    control_rule_hits: itemResults.filter((r) => r.status === 'false-positive').map((r) => `${r.id}: ${(r.details.false_positive_findings ?? []).join(', ')}`),
    false_positive_findings_distinct: [...new Set([
      ...itemResults.flatMap((r) => (r.status === 'false-positive' ? r.details.false_positive_findings ?? [] : [])),
      ...unmatched.filter((u) => u.verdict === 'confirmed' && u.adjudication === 'false-positive').map((u) => u.id),
      ...itemResults.filter((r) => r.status === 'unsupported-confirmation').map((r) => r.finding),
    ])].sort(),
    negative_controls_correct: count((r) => r.expect === 'no-defect' && /^correctly|^not-raised \(full\)/.test(r.status)),
    negative_controls_not_false_positive: count((r) => r.expect === 'no-defect' && r.status !== 'false-positive'),
    negative_controls_total: count((r) => r.expect === 'no-defect'),
    incorrect_rejections: count((r) => r.status === 'incorrect-rejection'),
    mislocated: count((r) => /mislocated/.test(r.status)),
    wrong_mechanism: count((r) => r.status === 'wrong-mechanism'),
    unsupported_confirmations: unsupported,
    valid_unplanned: validUnplanned,
    honest_open: count((r) => /honest-open/.test(r.status)),
    precision: confirmed.length ? +((tpConfirmed + validUnplanned) / confirmed.length).toFixed(3) : null,
    precision_rule: '(confirmed true positives + valid unplanned confirmed findings) / confirmed findings',
    coverage_recall: coverage.recall,
    ...(blind ? { coverage_recall_adjudicated: coverage.recall_adjudicated } : {}),
    coverage_mechanisms: coverage.mechanisms.map((m) => `${m.id} ${m.covered ? `covered (${m.via})` : `not covered${m.named ? ' (named in text only)' : ''}`}${m.adjudicated ? ` [adjudicated: ${m.adjudicated}]` : ''}`),
    population: coverage.population,
    population_adjudication: adj.population ?? null,
    ...(blind ? { adjudicator_unraised: blindUnraised(blind, answers, tol) } : {}),
    evidence_quality: {
      anchors_resolving: `${resolving}/${anchorsAll.length}`,
      anchors_wider_than_span_limit: wide,
      required_evidence_of_matched: matched.map((r) => `${r.id} ${r.details.required_evidence}`),
      trace_entrypoint_before_sink: `${traceOrder}/${findings.length}`,
    },
    open_obligations: [...obligations.values()].filter((o) => o.status === 'open').map((o) => `${o.id}:${o.open_reason}`),
    unresolved_adjudications: [...new Set(adjudicationNeeded)],
  };
  return {
    schema: SCHEMA,
    fixture: answers.fixture,
    run: records.run?.id ?? null,
    answers_sha256: answersSha256,
    official: v2 ? 'no: diagnostic evaluation (rule 4 v2), never an official score' : official ? (adj.summary.status === 'applied' && !adj.summary.independent ? 'yes (adjudication not independent)' : 'yes') : 'no: fixture version not verified',
    ...(v2 ? { diagnostic: { rule: 'rule4-v2', official: false, note: 'Rule 4 v2 (concern-aware, site or sink lines only) is proposed for future pre-registered benchmarks; it is never applied to a completed official run.' } } : {}),
    version,
    adjudication: adj.summary,
    items: itemResults,
    unmatched_findings: unmatched,
    summary,
    delegations: delegationCheck(records, metrics),
    g5: g5Progress({ answers, itemResults, summary, records, metrics, blind: Boolean(blind), independent: adj.summary?.status === 'applied' && adj.summary.independent === true }),
    ...(answers.variants ? { incremental: freshnessCheck(answers, records) } : {}),
    ...(answers.debt ? { debt: debtCheck(answers, records, { fixture }) } : {}),
  };
}

function censusCoverage(anchors, records, obligations, tol) {
  const items = records.census?.items ?? [];
  const cites = [...obligations.values()].flatMap((o) => [...o.evidence.map((e) => ({ a: parseAnchor(e.anchor), via: 'obligation-evidence', ref: o.id })), ...o.assumptions.filter((x) => x.anchor).map((x) => ({ a: parseAnchor(x.anchor), via: 'assumption', ref: o.id }))]);
  const one = (anchor) => {
    const label = `${anchor.path}:${anchor.lines.join('-')}`;
    // An exact item first; else a group path (`*` and `?` within one segment,
    // census.md §1) matched by the helper's own C11 matcher (M5-T4 correction B).
    const ci = items.find((c) => c.path === anchor.path) ?? items.find((c) => typeof c.path === 'string' && globMatches(c.path, anchor.path));
    if (ci && ['classified', 'unknown'].includes(ci.status)) return { anchor: label, covered: true, via: `census-item:${ci.status}`, ref: ci.id };
    const cite = cites.find((c) => overlaps(c.a, anchor, tol));
    if (cite) return { anchor: label, covered: true, via: cite.via, ref: cite.ref };
    const named = items.some((c) => String(c.mechanism ?? '').includes(anchor.path));
    return { anchor: label, covered: false, named, via: named ? "named in a census item's text only" : null };
  };
  const site = anchors.find((a) => a.role === 'site') ?? anchors[0];
  return { site: one(site), others: anchors.filter((a) => a !== site && a.role !== 'rule').map(one) };
}

function censusRecall(answers, records, obligations, tol, blind = null) {
  const mechanisms = answers.census?.mechanisms ?? [];
  const results = mechanisms.map((m) => {
    const site = censusCoverage([{ ...m, role: 'site' }], records, obligations, tol).site;
    return { id: m.id, kind: m.kind, ...site, ...(blind && site.covered ? { adjudicated: blindCoverage(site, blind).verdict } : {}) };
  });
  const covered = results.filter((r) => r.covered).length;
  const coveredAdjudicated = results.filter((r) => r.covered && r.adjudicated === 'ok').length;
  const population = Object.fromEntries(Object.entries(answers.census?.population ?? {}).map(([name, p]) => {
    const cites = [...obligations.values()].flatMap((o) => o.evidence.map((e) => ({ a: parseAnchor(e.anchor), ob: o.id })));
    const citing = cites.filter((c) => p.members.some((m) => overlaps(c.a, m, tol)));
    const hit = p.members.filter((m) => cites.some((c) => overlaps(c.a, m, tol))).length;
    const out = { sealed: p.count, cited: hit, exact: hit === p.count ? "all members cited (each obligation's enumeration is adjudicated)" : 'members missing' };
    if (blind) {
      const obs = [...new Set(citing.map((c) => c.ob))];
      const agree = obs.length > 0 && obs.every((id) => blind.obligations[id]?.conclusion === 'agree');
      out.exact_adjudicated = hit === p.count && agree ? 'exact' : hit === p.count ? 'pending: a citing obligation is not agreed' : 'not exact';
      out.citing_obligations = obs.map((id) => `${id}:${blind.obligations[id]?.conclusion ?? 'unjudged'}`);
    }
    return [name, out];
  }));
  return {
    recall: mechanisms.length ? `${covered}/${mechanisms.length}` : null,
    recall_ratio: mechanisms.length ? covered / mechanisms.length : null,
    ...(blind ? { recall_adjudicated: mechanisms.length ? `${coveredAdjudicated}/${mechanisms.length}` : null } : {}),
    mechanisms: results,
    population,
  };
}

function delegationCheck(records, metrics) {
  const d = records.delegations ?? [];
  const out = {
    recorded: d.length,
    completed: d.filter((x) => x.completed).length,
    without_recovery: d.filter((x) => x.completed && (x.recovery_messages ?? 0) === 0).length,
    within_one_recovery: d.filter((x) => x.completed && (x.recovery_messages ?? 0) <= 1).length,
  };
  if (metrics) {
    const m = metrics.delegations ?? [];
    out.transcript = { launched: m.length, completed: m.filter((x) => x.status?.value === 'completed').length, recoveries: m.reduce((a, x) => a + (x.recovery_messages?.value ?? 0), 0) };
    out.agreement = out.transcript.launched === out.recorded && out.transcript.completed === out.completed ? 'agree' : 'differs';
  }
  return out;
}

// Observed usage against the run's budget (M5-T4R, M2): the lead's tool calls
// after the executed `new-run` and the delegations, both from the transcripts,
// kept apart from what the lead recorded in `budget.spent` (which the Beta v2
// run double-counted). `within_budget` is null when it cannot be observed.
export function observedCost(records, metrics) {
  const budget = records?.budget ?? {};
  const lead = Number.isFinite(metrics?.budget?.lead_tool_calls_after_open) ? metrics.budget.lead_tool_calls_after_open : null;
  const subagents = Array.isArray(metrics?.delegations) ? metrics.delegations.length : null;
  const known = lead !== null && subagents !== null && Number.isFinite(budget.lead_tool_calls) && Number.isFinite(budget.subagent_calls);
  return {
    lead_after_open: lead, lead_budget: budget.lead_tool_calls ?? null, subagent_observed: subagents, subagent_budget: budget.subagent_calls ?? null,
    within_budget: known ? lead <= budget.lead_tool_calls && subagents <= budget.subagent_calls : null,
    recorded: { lead: budget.spent?.lead_tool_calls ?? null, subagents: budget.spent?.subagent_calls ?? null },
  };
}

// One run's evidence toward each G5 threshold (delivery roadmap §4). A
// threshold that needs repeats, other lead models or other fixtures stays
// `not-evaluable` here.
function g5Progress({ answers, itemResults, summary, records, metrics, blind = false, independent = false }) {
  const g5 = answers.scoring?.g5;
  if (g5) return g5Comparison(g5, itemResults, summary, independent);
  if (answers.fixture !== 'syn-ledger') return { note: 'G5 thresholds on this fixture are scored by its own checks' };
  const by = Object.fromEntries(itemResults.map((r) => [r.id, r.status]));
  const four = ['P1', 'P2', 'P5', 'P6'].filter((id) => by[id] === 'true-positive').length;
  const otherFalse = summary.false_positive_breakdown.unmatched_adjudicated + summary.unsupported_confirmations;
  const deleg = delegationCheck(records, metrics);
  const spent = records.budget?.spent ?? {};
  const budget = records.budget ?? {};
  const [covered, total] = ((blind ? summary.coverage_recall_adjudicated : summary.coverage_recall) ?? '0/1').split('/');
  const populationExact = Object.values(summary.population ?? {}).every((p) => (blind ? p.exact_adjudicated === 'exact' : p.cited === p.sealed));
  const observed = observedCost(records, metrics);
  return {
    checks: {
      independent,
      cost_observed: observed,
      accuracy: by.P1 === 'true-positive' && by.P2 === 'true-positive' && four >= 3,
      four,
      controls_not_confirmed: !['N1', 'N2'].some((id) => by[id] === 'false-positive'),
      other_false_confirmed: otherFalse,
      precision: summary.precision,
      coverage_recall: blind ? summary.coverage_recall_adjudicated : summary.coverage_recall,
      coverage: covered === total,
      population_exact: populationExact,
      pending: summary.pending_adjudication,
    },
    'finding-accuracy (this run)': by.P1 === 'true-positive' && by.P2 === 'true-positive' && four >= 3 ? `met: P1 and P2, ${four}/4 of P1, P2, P5, P6` : `not met: P1 ${by.P1}, P2 ${by.P2}, ${four}/4`,
    'false-positives (this run)': !['N1', 'N2'].some((id) => by[id] === 'false-positive') && otherFalse <= 1 ? `met: N1 and N2 not confirmed; other false confirmed ${otherFalse}` : `not met: N1 ${by.N1}, N2 ${by.N2}, other false confirmed ${otherFalse}`,
    'precision >= 80% across repeats': `one run only: ${summary.precision}`,
    'coverage (census recall 100%, population exact)': covered === total ? `recall ${summary.coverage_recall}; population needs adjudication` : `not met: recall ${summary.coverage_recall}`,
    'agent completion': `${deleg.without_recovery}/${deleg.recorded} complete without recovery; ${deleg.within_one_recovery}/${deleg.recorded} within one`,
    'routing (0 violations)': metrics ? (metrics.routing?.violations?.length ? `not met: ${metrics.routing.violations.length} violations` : 'met for this run (transcript)') : 'not evaluated: no metrics',
    'cost (spent <= budget in >= 90% of runs)': `this run: lead ${spent.lead_tool_calls}/${budget.lead_tool_calls}, subagent calls ${spent.subagent_calls}/${budget.subagent_calls}`,
    'cost observed (transcript)': observed.within_budget === null ? 'not observable: no transcript metrics' : `this run: lead ${observed.lead_after_open}/${observed.lead_budget} after the open, delegations ${observed.subagent_observed}/${observed.subagent_budget}; ${observed.within_budget ? 'within' : 'over'} budget`,
    'repeats and lead models (2 x Opus High, 2 x Sonnet)': 'not-evaluable: one Opus-High run',
    'indirect invalidation (SYN-LEDGER-INC)': 'not-evaluable: no INC run',
    'review debt (SYN-DEBT)': 'not-evaluable: no DEBT run',
    gate: 'not passed: G5 needs every row above',
  };
}

// The pre-registered comparison thresholds of a fixture's `scoring.g5` (the
// Sonnet-eligible fixture, M5-T4), for one run.
function g5Comparison(g5, itemResults, summary, independent = false) {
  const by = Object.fromEntries(itemResults.map((r) => [r.id, r.status]));
  const tp = (id) => by[id] === 'true-positive';
  const four = g5.four.filter(tp).length;
  const otherFalse = summary.false_positive_breakdown.unmatched_adjudicated + summary.unsupported_confirmations;
  const checks = {
    must_find: g5.must_find.every(tp),
    four,
    min_of_four: four >= g5.min_of_four,
    controls_not_confirmed: g5.controls.every((id) => by[id] !== 'false-positive'),
    other_false_confirmed: otherFalse,
    other_false_ok: otherFalse <= g5.max_other_false_confirmed,
    precision: summary.precision,
    precision_ok: summary.precision === null || summary.precision >= g5.min_precision,
    pending: summary.pending_adjudication,
  };
  checks.independent = independent;
  checks.meets_all = checks.must_find && checks.min_of_four && checks.controls_not_confirmed && checks.other_false_ok && checks.precision_ok;
  checks.counts = checks.meets_all && independent;
  return {
    checks,
    'must find': g5.must_find.map((id) => `${id} ${by[id]}`).join(', '),
    [`at least ${g5.min_of_four} of ${g5.four.join(', ')}`]: `${four}/${g5.four.length}`,
    controls: g5.controls.map((id) => `${id} ${by[id]}`).join(', '),
    'other false confirmed': `${otherFalse} (at most ${g5.max_other_false_confirmed})`,
    precision: summary.precision === null ? 'no confirmed finding' : `${summary.precision} (at least ${g5.min_precision})`,
    run: checks.meets_all ? 'meets every pre-registered threshold' : 'does not meet every pre-registered threshold',
  };
}

// SYN-LEDGER-INC: history, changed files, the target obligation, overreach.
export function freshnessCheck(answers, records) {
  const fr = records.freshness;
  if (!fr) return { status: 'unavailable: the run has no freshness' };
  const repos = Object.fromEntries(fr.repos.map((r) => [r.path, r.outcome]));
  const variant = Object.entries(answers.variants).find(([, v]) => Object.entries(v.history).every(([repo, o]) => repos[repo] === o))?.[0] ?? null;
  const target = answers.target?.match?.obligation_cites;
  const cites = (o, p) => [...(o.evidence ?? []), ...(o.assumptions ?? [])].some((e) => parseAnchor(e.anchor)?.path === p);
  const targetObs = (records.obligations ?? []).filter((o) => cites(o, target));
  const classes = Object.fromEntries((fr.obligations ?? []).map((o) => [o.id, o]));
  const independent = answers.independent ?? [];
  const overreach = (fr.obligations ?? []).filter((o) => o.class !== 'current').filter((o) => {
    const ob = (records.obligations ?? []).find((x) => x.id === o.id);
    if (!ob) return false;
    const paths = [...ob.evidence, ...ob.assumptions].map((e) => parseAnchor(e.anchor)?.path).filter(Boolean);
    return paths.length && paths.every((p) => independent.includes(p));
  }).map((o) => o.id);
  const changed = new Set(fr.changed_files.map((c) => c.path));
  const censusPaths = (records.census?.items ?? []).map((c) => c.path).filter((x) => typeof x === 'string');
  const hasItem = (file) => censusPaths.some((c) => globMatches(c, file));
  // M5-T4 correction 1 (owner-approved). Current or reopened is a question only
  // for obligations inherited from the base run (the ones `fresh` classified);
  // obligations created in this run are listed apart. A reopen reason counts
  // when it names a file that changed in this run and that the sealed variant
  // marks as bearing on the target (or the census item of such a file names
  // the obligation, C11), or the base-missing history of that file's repository.
  const v = variant ? answers.variants[variant] : null;
  const targetFiles = (v?.changed_files ?? []).filter((c) => c.affects === 'target').map((c) => c.path).filter((p) => changed.has(p));
  const missingRepos = Object.entries(v?.history ?? {}).filter(([, o]) => o === 'base-missing').map(([r]) => r);
  const reasonFor = (o) => {
    const text = String(classes[o.id]?.reason ?? '');
    const named = targetFiles.filter((p) => text.includes(p));
    const viaCensus = (records.census?.items ?? []).filter((c) => typeof c.path === 'string' && targetFiles.some((f) => globMatches(c.path, f)) && (c.affects ?? []).includes(o.id)).map((c) => `census ${c.path}`);
    const missing = missingRepos.filter((r) => text.includes(`base-missing in ${r}`)).map((r) => `base-missing in ${r}`);
    const names = [...named, ...viaCensus, ...missing];
    return { ok: names.length > 0, names };
  };
  const inherited = targetObs.filter((o) => classes[o.id]);
  const created = targetObs.filter((o) => !classes[o.id]);
  const rows = inherited.map((o) => { const r = reasonFor(o); return { id: o.id, class: classes[o.id].class, reason: classes[o.id].reason ?? null, reason_ok: r.ok, reason_names: r.names, final_status: o.status }; });
  const neverCurrent = inherited.length > 0 && inherited.every((o) => classes[o.id].class !== 'current');
  const reopenedWithReason = rows.some((x) => x.class !== 'current' && x.reason_ok);
  const withoutItem = [...changed].filter((p) => !hasItem(p));
  return {
    rule: 'M5-T4 correction 1: inherited target obligations only; the reopen reason checked against the files that changed and bear on the target',
    variant: variant ?? 'unmatched: the history fits no sealed variant',
    target_obligations: rows,
    target_obligations_new_in_this_run: created.map((o) => ({ id: o.id, final_status: o.status })),
    target_never_current: neverCurrent,
    target_reopened_with_correct_reason: reopenedWithReason,
    overreach,
    changed_files_without_census_item: withoutItem,
    meets_threshold: Boolean(variant) && neverCurrent && reopenedWithReason && withoutItem.length === 0,
  };
}

// SYN-DEBT: R1 ends incomplete with debt-out; R2 dispositions every debt-in.
// The base run's records, found by run id under the fixture's `.nth-review/`
// (`<ns...>/runs/<id>/records.json`). null unless exactly one exists.
function baseRecords(fixture, baseId) {
  if (!fixture || !baseId) return { records: null, why: 'no base run named' };
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === baseId && path.basename(dir) === 'runs' && fs.existsSync(path.join(p, 'records.json'))) found.push(path.join(p, 'records.json'));
      else walk(p, depth + 1);
    }
  };
  walk(path.join(fixture, '.nth-review'), 0);
  if (found.length !== 1) return { records: null, why: found.length ? 'more than one base run with that id' : 'the base run is not in the fixture' };
  try { return { records: JSON.parse(fs.readFileSync(found[0], 'utf8')), why: null }; } catch { return { records: null, why: 'the base records cannot be read' }; }
}

// M5-T4 correction C (owner-approved). records.md gives a debt-in item no
// `kind` ({ id, from_run, disposition, note }); its kind is the one of the
// item with the same id in the base run's debt-out. An item whose kind cannot
// be resolved exactly (no base, another origin, no or several matches, or a
// stray kind of its own that disagrees) fails the check. A matrix review is
// static: nothing gives it runtime or owner evidence, so every discharged
// `runtime` or `owner-fact` item is an error here.
export function debtCheck(answers, records, { fixture = null } = {}) {
  const run = records.run ?? {};
  if (run.mode === 'task') {
    const r1 = answers.runs.find((r) => r.id === 'R1');
    const openOb = (records.obligations ?? []).filter((o) => o.status === 'open').map((o) => o.id);
    const refs = new Set((records.debt?.out ?? []).flatMap((d) => d.refs ?? []));
    const unverified = (records.findings ?? []).filter((f) => f.verdict === 'candidate' || f.verification?.incomplete).map((f) => f.id);
    return {
      role: 'R1',
      status: run.status,
      expected_status: r1?.expected_status,
      status_ok: run.status === r1?.expected_status && (r1?.expected_reasons ?? []).includes(run.incomplete_reason),
      debt_out: (records.debt?.out ?? []).map((d) => d.kind),
      open_obligations_without_debt: openOb.filter((id) => !refs.has(id)),
      unverified_findings_without_debt: unverified.filter((id) => !refs.has(id)),
    };
  }
  const inItems = records.debt?.in ?? [];
  const baseId = run.base ?? run.continues ?? null;
  const base = baseRecords(fixture, baseId);
  const out = base.records?.debt?.out ?? [];
  const kinds = {};
  const unresolved = [];
  for (const d of inItems) {
    const why = base.why
      ?? (d.from_run !== baseId ? `from ${d.from_run}, not the base ${baseId}` : null)
      ?? (() => {
        const m = out.filter((o) => o.id === d.id);
        if (m.length !== 1) return m.length ? 'more than one base debt-out item with this id' : 'not in the base debt-out';
        if (!m[0].kind) return 'the base debt-out item has no kind';
        if (d.kind !== undefined && d.kind !== m[0].kind) return `its own kind ${d.kind} disagrees with the base ${m[0].kind}`;
        kinds[d.id] = m[0].kind;
        return null;
      })();
    if (why) unresolved.push({ id: d.id, why });
  }
  const dispositioned = inItems.filter((d) => ['discharged', 'carried', 'obsolete'].includes(d.disposition)).length;
  const withoutNote = inItems.filter((d) => ['discharged', 'obsolete'].includes(d.disposition) && !d.note).map((d) => d.id);
  const wronglyDischarged = inItems.filter((d) => d.disposition === 'discharged' && ['runtime', 'owner-fact'].includes(kinds[d.id])).map((d) => d.id);
  return {
    role: 'R2',
    rule: 'M5-T4 correction C: kinds from the base run\'s debt-out; unresolved kinds fail; a static review has no runtime or owner evidence',
    base_run: baseId,
    debt_in: inItems.length,
    dispositioned,
    kinds,
    kinds_unresolved: unresolved,
    discharged_or_obsolete_without_note: withoutNote,
    runtime_or_owner_fact_discharged_without_evidence: wronglyDischarged,
    passes: inItems.length > 0 ? dispositioned === inItems.length && unresolved.length === 0 && withoutNote.length === 0 && wronglyDischarged.length === 0 : null,
  };
}

// The adjudication file must name this run and these exact answers, and use
// only the allowed values.
function validateAdjudication(adj, answers, sha, records) {
  const empty = { items: {}, findings: {}, population: null, summary: { status: 'none' } };
  if (!adj) return empty;
  const problems = [];
  if (adj.schema !== 'nthr-adjudication@1') problems.push('schema');
  if (adj.fixture !== answers.fixture) problems.push('fixture');
  if (adj.run !== records.run?.id) problems.push('run');
  if (adj.answers_sha256 !== sha) problems.push('answers_sha256');
  const ids = new Set((answers.items ?? []).map((i) => i.id));
  for (const [id, a] of Object.entries(adj.items ?? {})) {
    if (!a) continue;
    if (!ids.has(id)) problems.push(`unknown item ${id}`);
    if (a.status !== undefined && !CENSUS_STATUSES.has(a.status)) problems.push(`${id}: status ${a.status}`);
    if (a.mechanism_facts !== undefined && !(Array.isArray(a.mechanism_facts) && a.mechanism_facts.every((x) => typeof x === 'boolean'))) problems.push(`${id}: mechanism_facts`);
  }
  for (const [id, f] of Object.entries(adj.findings ?? {})) if (!FINDING_VERDICTS.test(String(f?.verdict))) problems.push(`${id}: verdict ${f?.verdict}`);
  if (problems.length) return { ...empty, summary: { status: 'rejected', problems } };
  return { items: adj.items ?? {}, findings: adj.findings ?? {}, population: adj.population ?? null, summary: { status: 'applied', adjudicator: adj.adjudicator ?? null, independent: adj.independent === true } };
}

// ---------------------------------------------------------------- blind adjudication

// A blind adjudication names the run and judges records by their own ids. Its
// meta (written by the operator when it was frozen) carries the file's sha256,
// the records' sha256 at freezing time, the adjudicator and whether it was
// independent. Unknown ids or values reject the whole file; ids it does not
// judge stay pending.
export function validateBlind(adj, meta, adjSha, records, recordsSha) {
  const problems = [];
  const findingIds = new Set((records.findings ?? []).map((f) => f.id));
  const obligationIds = new Set((records.obligations ?? []).map((o) => o.id));
  const censusIds = new Set((records.census?.items ?? []).map((c) => c.id));
  const anchorOk = (a) => typeof a === 'string' && parseAnchor(a)?.lines != null;
  if (adj.run !== records.run?.id) problems.push('run');
  for (const [id, f] of Object.entries(adj.findings ?? {})) {
    if (!findingIds.has(id)) problems.push(`unknown finding ${id}`);
    const v = String(f?.verdict);
    if (!BLIND_VERDICT.test(v)) problems.push(`${id}: verdict ${v}`);
    if (v.startsWith('duplicate-of ') && !findingIds.has(v.slice(13))) problems.push(`${id}: duplicate of an unknown finding`);
    if (![true, false, null, undefined].includes(f?.mechanism_correct)) problems.push(`${id}: mechanism_correct`);
    if (f?.incorrect_claims !== undefined && !(Array.isArray(f.incorrect_claims) && f.incorrect_claims.every((x) => typeof x === 'string'))) problems.push(`${id}: incorrect_claims`);
    if (f?.cause_anchors !== undefined && !(Array.isArray(f.cause_anchors) && f.cause_anchors.every(anchorOk))) problems.push(`${id}: cause_anchors`);
    if (f?.rule_anchor != null && typeof f.rule_anchor !== 'string') problems.push(`${id}: rule_anchor`);
  }
  for (const [id, o] of Object.entries(adj.obligations ?? {})) {
    if (!obligationIds.has(id)) problems.push(`unknown obligation ${id}`);
    if (!BLIND_CONCLUSION.has(o?.conclusion)) problems.push(`${id}: conclusion ${o?.conclusion}`);
  }
  for (const [id, c] of Object.entries(adj.census ?? {})) {
    if (!censusIds.has(id)) problems.push(`unknown census item ${id}`);
    if (!BLIND_CLASSIFICATION.has(c?.classification)) problems.push(`${id}: classification ${c?.classification}`);
  }
  const notIndependent = [];
  if (!meta) notIndependent.push('no freeze record');
  else {
    if (!adjSha || meta.sha256 !== adjSha) notIndependent.push('the file differs from the frozen sha256');
    if (!recordsSha || meta.records_sha256 !== recordsSha) notIndependent.push('the records changed since the freeze');
    if (meta.independent !== true) notIndependent.push(meta.independence_note ?? 'not declared independent');
  }
  const summary = {
    status: problems.length ? 'rejected' : 'applied',
    schema: BLIND_SCHEMA,
    adjudicator: meta?.adjudicator ?? null,
    independent: !problems.length && notIndependent.length === 0,
    ...(notIndependent.length ? { not_independent_because: notIndependent } : {}),
    ...(problems.length ? { problems } : {}),
    unjudged: {
      findings: [...findingIds].filter((id) => !adj.findings?.[id]),
      obligations: [...obligationIds].filter((id) => !adj.obligations?.[id]),
      census: [...censusIds].filter((id) => !adj.census?.[id]),
    },
  };
  return { summary, findings: adj.findings ?? {}, obligations: adj.obligations ?? {}, census: adj.census ?? {}, unraised: adj.unraised ?? [] };
}

// The pre-registered mapping from blind verdicts to what the scorer needs. An
// assigned finding gets its item's mechanism facts only when the adjudicator
// judged it valid with a correct mechanism and no incorrect claim, located its
// cause on the item's site, sink or propagation lines, and (if the item has
// rules) cited a rule anchor that supports one of them. This approximates the prose checklist by anchors.
export function mapBlind({ blind, assigned, findings, usedFindings, fixture, tol }) {
  const items = {};
  for (const [itemId, p] of assigned) {
    const b = blind.findings[p.f.id];
    if (!b || b.verdict === 'cannot-tell' || /^duplicate-of /.test(b.verdict)) continue;
    const n = p.item.mechanism_facts?.length ?? 0;
    const causeLines = p.item.anchors.filter((a) => CAUSE_ROLES.has(a.role));
    const rules = p.item.anchors.filter((a) => a.role === 'rule');
    const cause = (b.cause_anchors ?? []).some((c) => causeLines.some((s) => overlaps(parseAnchor(c), s, tol)));
    const ruleOk = !rules.length || (typeof b.rule_anchor === 'string' && rules.some((r) => supports(parseAnchor(b.rule_anchor), r, fixture, tol)));
    const claims = b.incorrect_claims ?? [];
    if (b.verdict === 'valid') {
      if (b.mechanism_correct == null) continue; // valid, mechanism not judged: pending
      const facts = b.mechanism_correct === true && claims.length === 0 && cause && ruleOk;
      items[itemId] = { finding: p.f.id, mechanism_facts: Array(n).fill(facts), wrong_claims: claims, same_root_cause: cause, basis: `blind: valid; mechanism ${b.mechanism_correct ? 'correct' : 'not correct'}; cause ${cause ? 'on' : 'not on'} the site; rule ${ruleOk ? 'supported' : 'not supported'}` };
    } else {
      items[itemId] = { finding: p.f.id, mechanism_facts: Array(n).fill(false), wrong_claims: claims, same_root_cause: false, basis: `blind: ${b.verdict}` };
    }
  }
  const out = {};
  for (const f of findings.filter((x) => !usedFindings.has(x.id))) {
    const b = blind.findings[f.id];
    const v = b?.verdict;
    out[f.id] = {
      verdict: v === 'valid' ? 'valid-unplanned' : v === 'false' || v === 'unsupported' ? 'false-positive' : /^duplicate-of /.test(v ?? '') ? v : 'pending',
      basis: b ? `blind: ${v}${b.basis ? `; ${b.basis}` : ''}` : 'blind: not judged',
      category: b?.severity ?? null,
    };
  }
  return { items, findings: out };
}

// Whether the record that covers a census anchor was judged sound.
function blindCoverage(site, blind) {
  if (site.via?.startsWith('census-item:')) {
    const c = blind.census[site.ref]?.classification;
    return { verdict: c === 'correct' ? 'ok' : c === 'incorrect' ? 'bad' : 'pending', basis: `blind: census item ${site.ref} ${c ?? 'unjudged'}` };
  }
  const o = blind.obligations[site.ref]?.conclusion;
  return { verdict: o === 'agree' ? 'ok' : 'pending', basis: `blind: obligation ${site.ref} ${o ?? 'unjudged'}` };
}

// Defects the adjudicator found that no finding raised, set against the items
// after the freeze (information about the review and the adjudicator; no credit).
function blindUnraised(blind, answers, tol) {
  return (blind.unraised ?? []).map((u) => {
    const a = parseAnchor(u?.anchor);
    const near = (answers.items ?? []).filter((i) => i.anchors.some((x) => SITE_ROLES.has(x.role) && overlaps(a, x, tol))).map((i) => i.id);
    return { anchor: u?.anchor ?? null, near_items: near, note: u?.note ?? null };
  });
}

// ---------------------------------------------------------------- markdown

export function toMarkdown(s) {
  const show = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : x)).join(', ') || '-' : typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  const lines = [`# Score: ${s.fixture}, run ${s.run}`, '', `- Official: ${s.official}`, `- Version: ${s.version.status}`, `- Answers sha256: \`${s.answers_sha256}\``, `- Adjudication: ${s.adjudication.status}${s.adjudication.adjudicator ? ` (${s.adjudication.adjudicator}${s.adjudication.independent ? '' : ', not independent'})` : ''}`, ''];
  lines.push('## Items', '', '| Item | Gating | Expect | Status | Finding | Details |', '|---|---|---|---|---|---|');
  for (const r of s.items) lines.push(`| ${r.id} | ${r.gating ? 'yes' : 'no'} | ${r.expect} | ${r.status} | ${r.finding ?? '-'} | ${Object.entries(r.details).map(([k, v]) => `${k}: ${show(v)}`).join('; ').replace(/\|/g, '/')} |`);
  lines.push('', '## Unmatched findings', '', '| Finding | Kind/verdict | Overlaps items | Allowances nearby | Adjudication |', '|---|---|---|---|---|');
  for (const u of s.unmatched_findings) lines.push(`| ${u.id} | ${u.kind}/${u.verdict} | ${u.overlaps_items.join(', ') || '-'} | ${u.allowances_nearby.join(', ') || '-'} | ${u.adjudication}${u.category ? ` (${u.category})` : ''} |`);
  lines.push('', '## Summary', '', '```json', JSON.stringify(s.summary, null, 2), '```', '', '## G5 progress', '');
  for (const [k, v] of Object.entries(s.g5)) lines.push(`- **${k}:** ${show(v)}`);
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) { process.stderr.write('usage: score.mjs --answers <file> --run <dir> --fixture <dir> [--adjudication <file> [--adjudication-meta <file>]] [--metrics <file>] [--pre-run-tree <sha256>] [--rule4 v2-diagnostic] [--format json|markdown]\n'); return 2; }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.answers || !args.run || !args.fixture) { process.stderr.write('--answers, --run and --fixture are required\n'); return 2; }
  try {
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const text = fs.readFileSync(args.answers);
    const recordsText = fs.readFileSync(path.join(args.run, 'records.json'));
    const adjText = args.adjudication ? fs.readFileSync(args.adjudication) : null;
    const result = score({
      answers: JSON.parse(text.toString('utf8')),
      answersSha256: sha(text),
      records: JSON.parse(recordsText.toString('utf8')),
      recordsSha256: sha(recordsText),
      fixture: args.fixture,
      adjudication: adjText ? JSON.parse(adjText.toString('utf8')) : null,
      adjudicationSha256: adjText ? sha(adjText) : null,
      adjudicationMeta: args['adjudication-meta'] ? JSON.parse(fs.readFileSync(args['adjudication-meta'], 'utf8')) : null,
      preRunTreeSha256: args['pre-run-tree'] ?? null,
      rule4: args['rule4'] === 'v2-diagnostic' ? 'v2-diagnostic' : 'v1',
      metrics: args.metrics ? JSON.parse(fs.readFileSync(args.metrics, 'utf8')) : null,
    });
    process.stdout.write(args.format === 'markdown' ? toMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
