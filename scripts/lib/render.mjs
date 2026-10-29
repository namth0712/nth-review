// The report (M2-T3; decisions C1, C13): report.md is a pure function of the
// closed records and the helper version (its Helper row), so rendering the
// same records with the same helper twice gives the same bytes.
// Gaps come first; coverage and correctness are separate sections; "Verified"
// is reserved for held, all-enumerated obligations whose evidence is verified
// and that no census item contradicts.
import { AUDIT_MODES, unitClassified } from './runs.mjs';
import { PROTOCOL, VERSION, parseAnchor } from './schema.mjs';

export const RECHECK_COMMAND = 'nthr close: source recheck';
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'informational', null];

// Record text on one line: no line break of any kind can start a heading,
// list or table row in the report.
const text = (value) => String(value ?? '').replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
const cell = (value) => (text(value) || '–').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const table = (heads, rows) => (rows.length
  ? [`| ${heads.join(' | ')} |`, `|${heads.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
  : 'None.');
const list = (items) => (items.length ? items.map((i) => `- ${i}`).join('\n') : 'None.');

function citedBy(doc) {
  const by = new Map();
  const add = (anchor, who) => {
    const parsed = anchor ? parseAnchor(anchor) : null;
    if (!parsed) return;
    by.set(parsed.path, [...new Set([...(by.get(parsed.path) ?? []), who])]);
  };
  for (const i of doc.scope.intent) add(i.anchor, i.id);
  for (const o of doc.obligations) {
    for (const e of o.evidence) add(e.anchor, o.id);
    for (const a of o.assumptions) add(a.anchor, o.id);
  }
  for (const f of doc.findings) {
    for (const s of f.trace) add(s.anchor, f.id);
    for (const c of f.counterevidence) add(c.anchor, f.id);
  }
  return by;
}

const evidencePaths = (o) => [...o.evidence.map((e) => e.anchor), ...o.assumptions.filter((a) => a.kind === 'dependency').map((a) => a.anchor)]
  .map((a) => parseAnchor(a).path);

// A finding that is not verified: a candidate, needs_validation, or a
// verification that did not finish. Shared with check and resume.
export const unverifiedFinding = (f) => f.verdict === 'candidate' || f.verdict === 'needs_validation' || f.verification.incomplete;
// An obligation whose evidence or dependency files have an unverified or
// absent footprint. Shared with check and resume.
export const restsOnUnverified = (doc, o) => evidencePaths(o).some((p) => ['unverified', 'absent'].includes(doc.footprint[p]?.state));
// Census items that contradict an all-enumerated claim on the obligation
// (C13): an unknown item that names it or names no obligation (with no
// established relationship it bears on every obligation), and an excluded
// item that names it. An excluded item naming no obligation, or other ones
// only, does not. Shared with check.
// In a flow run, edges count the same way, and a reached edge limit
// (max_edges) bears on every obligation: the frontier was cut, so nothing
// there is exhaustive.
export const flowLimitReached = (doc) => Array.isArray(doc.census.edges) && Number.isInteger(doc.budget.max_edges)
  && doc.census.edges.length >= doc.budget.max_edges;
// An unknown edge also bears on every obligation covering an edge on its
// path from the entry: the unreviewed frontier lies inside that obligation's
// population.
const coversPathTo = (doc, g, o) => {
  const byId = new Map((doc.census.edges ?? []).map((e) => [e.id, e]));
  const seen = new Set();
  for (let p = byId.get(g.from); p && !seen.has(p.id); p = byId.get(p.from)) {
    seen.add(p.id);
    if ((p.affects ?? []).includes(o.id)) return true;
  }
  return false;
};
export const coverageBlockers = (doc, o) => [
  ...[...doc.census.items, ...(doc.census.edges ?? [])].filter((i) => {
    const names = Array.isArray(i.affects) && i.affects.includes(o.id);
    if (i.status === 'unknown') return names || !Array.isArray(i.affects) || i.affects.length === 0 || (i.from !== undefined && coversPathTo(doc, i, o));
    return i.status === 'excluded' && names;
  }),
  ...(flowLimitReached(doc) ? [{ id: `the edge limit (max_edges ${doc.budget.max_edges})` }] : []),
];

// Flow Review (BETA): the entries, every recorded path and its disposition,
// and the limits. Unknown paths are the frontier this run did not review.
function renderFlow(doc, push) {
  const { scope, census, budget } = doc;
  const edges = census.edges;
  push('### Flow entries', '', table(['Entry', 'Selector', 'Resolved', 'Repository', 'State at Open'], scope.entries.map((e) => [
    e.id, e.selector, `${e.path}:${e.lines[0]}-${e.lines[1]}`, e.repo, e.identity.state,
  ])), '');
  const count = (s) => edges.filter((g) => g.status === s).length;
  const depthOf = new Map();
  for (const g of edges) depthOf.set(g.id, /^E/.test(g.from) ? 1 : (depthOf.get(g.from) ?? 0) + 1);
  push('### Reviewed paths', '', table(['Edge', 'From', 'Kind', 'To', 'Evidence', 'Depth', 'Disposition', 'Obligations or reason'], edges.map((g) => [
    g.id, g.from, g.kind, g.to ?? 'unresolved', g.evidence, String(depthOf.get(g.id)),
    g.status === 'classified' ? 'covered' : g.status, g.status === 'classified' ? (g.affects ?? []).join(', ') : g.reason ?? '',
  ])), '');
  const limits = [];
  if (flowLimitReached(doc)) limits.push(`edge limit reached (${edges.length} of ${budget.max_edges}): the frontier was cut, so no coverage here is exhaustive`);
  const beyond = edges.filter((g) => depthOf.get(g.id) > budget.max_depth);
  if (beyond.length) limits.push(`depth limit reached (max_depth ${budget.max_depth}): ${beyond.map((g) => g.id).join(', ')} only record the frontier`);
  push(list([
    `${edges.length} paths: ${count('classified')} covered by obligations, ${count('excluded')} excluded with a reason, ${count('unknown')} unknown (not reviewed; handed on as debt)`,
    `Limits: depth ${budget.max_depth}, ${budget.max_edges} edges`,
    ...(limits.length ? limits : ['No limit was reached.']),
  ]), '');
}

// The command that follows a closed run up (also `status`'s next step).
// <new-slug> is the user's: run ids carry a timestamp, so any slug works.
export function followUpCommand(run, doc) {
  if (AUDIT_MODES.includes(run.mode)) return `nthr status --ns ${run.namespace}`;
  if (run.mode === 'flow') {
    const entries = (doc.scope.entries ?? []).map((e) => ` --entry ${e.selector}`).join('');
    return `/nth-review flow --ns ${run.namespace} --slug <new-slug>${entries} (a flow run is not a baseline: a new flow run reviews the current source again)`;
  }
  return `/nth-review incremental --ns ${run.namespace} --slug <new-slug> --base ${run.id}`;
}

// The report's Summary: what the status means, counts, and the next step.
function summaryLines(doc, { projectWide, verified }) {
  const { run } = doc;
  const count = (items, pred) => items.filter(pred).length;
  const lines = [];
  if (projectWide) {
    lines.push(`\`${run.status}\`${run.incomplete_reason ? ` (${run.incomplete_reason})` : ''}: this run plans or closes the audit; no obligation here is concluded for the project. Each unit's conclusions are in its own run's report.`);
  } else if (run.status === 'complete') {
    lines.push('`complete`: the run finished its method within its scope and `check` accepted it. That is not a verdict on the code: only the obligations marked Verified in section 3 are Verified; every other conclusion needs the owner\'s judgement.');
  } else {
    lines.push(`\`${run.status}\`${run.incomplete_reason ? ` (${run.incomplete_reason})` : ''}: work remained; section 1 says what.`);
  }
  const ob = doc.obligations;
  const held = count(ob, (o) => o.status === 'held');
  lines.push(`Obligations: ${held} held${projectWide ? '' : ` (${count(ob, verified)} Verified)`}, ${count(ob, (o) => o.status === 'violated')} violated, ${count(ob, (o) => o.status === 'open')} open, ${count(ob, (o) => o.status === 'accepted')} accepted, ${count(ob, (o) => o.status === 'out-of-scope')} out of scope.`);
  const confirmed = doc.findings.filter((f) => f.verdict === 'confirmed');
  const bySeverity = SEVERITY_ORDER.filter((s) => s !== null).map((s) => [s, count(confirmed, (f) => f.severity === s)]).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`);
  const risks = count(confirmed, (f) => f.kind === 'risk');
  const verdicts = ['candidate', 'needs_validation', 'rejected'].map((v) => [v, count(doc.findings, (f) => f.verdict === v)]).filter(([, n]) => n > 0).map(([v, n]) => `${n} ${v}`);
  lines.push(`Findings: ${confirmed.length} confirmed${bySeverity.length || risks ? ` (${[...bySeverity, ...(risks ? [`${risks} risk`] : [])].join(', ')})` : ''}${verdicts.length ? `; ${verdicts.join(', ')}` : ''}. Candidates and needs_validation findings are leads, not verified defects.`);
  lines.push(`Debt handed on: ${doc.debt.out.length}. Unknown census items: ${count(doc.census.items, (i) => i.status === 'unknown')}${Array.isArray(doc.census.edges) ? `; unknown paths: ${count(doc.census.edges, (e) => e.status === 'unknown')}` : ''}.`);
  lines.push(`Next step: \`${followUpCommand(run, doc)}\`${['task', 'incremental'].includes(run.mode) ? ' reviews what changed since, with this run\'s debt as mandatory scope' : ''}.`);
  return lines;
}

export function renderReport(doc) {
  const { run, snapshot, footprint } = doc;
  const out = [];
  const push = (...lines) => out.push(...lines);
  const unverifiedPaths = Object.entries(footprint).filter(([, v]) => v.state === 'unverified');

  const flow = run.mode === 'flow';
  push(flow ? `# Flow Review report: ${run.id}` : `# Review report: ${run.id}`, '');
  if (flow) {
    push('**Boundary:** this review concludes only on the code reached from the entries below, over the paths recorded in this report, at the source state of its snapshot. It is not a project audit: code outside these paths was not reviewed.', '');
  }
  push(table(['Run', ''], [
    ['Namespace', run.namespace],
    ['Mode', run.mode + (run.unit ? ` (unit ${run.unit})` : '')],
    ['Status', run.status + (run.incomplete_reason ? ` (${run.incomplete_reason})` : '')],
    ['Opened', run.opened],
    ['Closed', run.closed ?? 'open'],
    ['Base / continues', `${run.base ?? '–'} / ${run.continues ?? '–'}`],
    ['Lead', `required ${run.runtime.required_lead_model}; recorded ${run.runtime.lead_model ?? 'not recorded'}${run.runtime.lead_effort ? ` (effort ${run.runtime.lead_effort})` : ''}`],
    ['Triggers', run.runtime.triggers.join(', ') || 'none'],
    ['Helper', `nthr ${VERSION} · protocol ${PROTOCOL} · records ${doc.schema}`],
  ]), '');

  // The last entry is the one close wrote; a lead entry cannot stand in for it.
  const recheck = doc.checks.findLast((c) => c.command === RECHECK_COMMAND);
  const sourceProven = Boolean(recheck) && /^tracked equal; untracked \w+; coverage equal;/.test(recheck.result);
  // A plan or the audit close reviews no unit: nothing there is Verified.
  const projectWide = run.mode === 'audit-plan' || (run.mode === 'audit-unit' && run.unit === 'close');
  const verified = (o) => !projectWide && o.status === 'held' && o.coverage === 'all-enumerated' && snapshot.discovery_complete
    && sourceProven && !restsOnUnverified(doc, o) && coverageBlockers(doc, o).length === 0;

  // ------------------------------------------------------------ summary
  push('## Summary', '', list(summaryLines(doc, { projectWide, verified })), '');

  // ------------------------------------------------------------ 1. gaps
  push('## 1. Gaps', '');
  push('### Source state at Close', '');
  push(recheck ? list([`Result: ${text(recheck.result)}`, `Proves: ${text(recheck.proves)}`, `Does not prove: ${text(recheck.not_proven)}`]) : 'No close-time recheck is recorded.', '');
  const snap = [];
  if (!snapshot.tracked_complete) snap.push('Tracked state at Open has unverified entries (see `snapshot.repos[].unverified` and `flagged.skipped`).');
  if (!snapshot.untracked_complete) snap.push('Untracked content at Open was hashed only partly.');
  if (!snapshot.discovery_complete) snap.push('Repository discovery at Open was incomplete: no coverage can be exhaustive.');
  for (const l of snapshot.limitations) snap.push(`Limitation \`${l.code}\` at ${l.path}`);
  push('### Snapshot coverage at Open', '', list(snap), '',
    'No snapshot covers `.nth-review/` or the untracked copies of this integration\'s installed files in the root repository (`.claude/skills/nth-review/`, `.claude/nth-dev-kit-hooks/review.state.json`). Those copies are not reviewed and cannot be cited.', '');
  if (flow) renderFlow(doc, push);
  if (run.mode === 'audit-plan' || run.mode === 'audit-unit') {
    // Full Audit (protocol §10): which units are reviewed, and by which run. A
    // unit's conclusions stay in its own run's report; no run here concludes
    // the project, and "Verified" is never said of the whole audit.
    const units = doc.scope.units;
    const ids = (pred) => units.filter(pred).map((u) => u.id).join(', ') || 'none';
    const counts = {};
    for (const u of units) counts[u.status] = (counts[u.status] ?? 0) + 1;
    const unfinished = units.filter((u) => !['complete', 'out_of_scope'].includes(u.status));
    const official = run.namespace.startsWith('audits/');
    let scope;
    if (run.mode === 'audit-plan') {
      scope = "This plan defines the audit's units and reviews none of them. The ledger comes from the plan's census; discovery alone never shows that nothing else exists.";
    } else if (run.unit === 'close') {
      const why = [];
      if (unfinished.length) why.push(`units not complete: ${unfinished.map((u) => u.id).join(', ')}`);
      if (!units.some((u) => u.status === 'complete')) why.push('no unit was reviewed');
      const unclassified = units.filter((u) => u.status !== 'out_of_scope' && !unitClassified(u));
      if (unclassified.length) why.push(`units not classified: ${unclassified.map((u) => u.id).join(', ')}`);
      if (run.status !== 'complete') why.push(`the audit close is ${run.status}${run.incomplete_reason ? ` (${run.incomplete_reason})` : ''}`);
      scope = why.length
        ? `Whole audit: not complete: ${why.join('; ')}.`
        : 'Whole audit: complete at this snapshot. Every unit is complete or out of scope; each unit\'s conclusions are in the report of its last run, and out-of-scope units were not reviewed.';
    } else {
      scope = `This report concludes unit ${run.unit} only. It is no conclusion about the project or the whole audit.`;
    }
    push('### Audit units', '');
    if (!official) push('**Not an official audit:** this namespace has no owner charter and no release gate.', '');
    push(scope, '');
    push(list([
      `${units.length} units: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`,
      `Reviewed (complete): ${ids((u) => u.status === 'complete')}`,
      `Not reviewed: ${ids((u) => u.status !== 'complete')}`,
    ]), '');
    push(table(['Unit', 'Title', 'Tier', 'Basis', 'Status', 'Depends on', 'Scope', 'Last run', 'Reason'], units.map((u) => [
      u.id, u.title, u.tier === null ? '–' : String(u.tier), (u.basis ?? []).map((b) => `${b.anchor} — ${b.note}`).join('; '),
      u.status, u.depends_on.join(', ') || 'none', u.scope ?? '–', u.runs.at(-1) ?? 'not run', u.reason,
    ])), '');
    if (run.unit === 'close') {
      push('Left unresolved by each unit\'s last run (from its records; its report has the details):', '');
      push(list(doc.checks.filter((c) => c.command === 'nthr close: unit summary').map((c) => text(c.result))), '');
    }
  }
  push('### Open obligations', '', list(doc.obligations.filter((o) => o.status === 'open').map((o) => `${o.id} (${o.open_reason}): ${text(o.claim)}`)), '');
  const unverifiedFindings = doc.findings.filter(unverifiedFinding);
  push('### Unverified findings', '', list(unverifiedFindings.map((f) => `${f.id} (${f.kind}, ${f.verdict}${f.verification.incomplete ? ', verification incomplete' : ''}): ${text(f.summary)}`)), '');
  const by = citedBy(doc);
  push('### Unverified or missing evidence', '');
  push(list([
    ...unverifiedPaths.map(([p, v]) => `${p}: unverified (${v.reason}); cited by ${(by.get(p) ?? []).join(', ')}`),
    ...Object.entries(footprint).filter(([, v]) => v.state === 'absent').map(([p]) => `${p}: absent; cited by ${(by.get(p) ?? []).join(', ')}`),
    ...doc.obligations.filter((o) => o.status === 'held' && restsOnUnverified(doc, o)).map((o) => `${o.id} is held on evidence that is unverified or absent: never reported as verified`),
    ...doc.obligations.filter((o) => o.status !== 'open' && o.coverage === 'all-enumerated' && coverageBlockers(doc, o).length > 0)
      .map((o) => `${o.id} claims all-enumerated coverage, but census items ${coverageBlockers(doc, o).map((i) => i.id).join(', ')} bear on it: never reported as verified`),
  ]), '');
  push('### Review debt', '', 'Inherited:', '', table(['Id', 'From', 'Disposition', 'Note'], doc.debt.in.map((d) => [d.id, d.from_run, d.disposition ?? 'undecided', d.note])), '');
  push('Handed on:', '', table(['Id', 'Kind', 'Priority', 'Requires', 'Refs'], doc.debt.out.map((d) => [d.id, d.kind, d.priority, d.requires, d.refs.join(', ')])), '');
  push('### Unknown census items', '', list(doc.census.items.filter((i) => i.status === 'unknown').map((i) => `${i.id} ${i.path}: ${text(i.reason)}`)), '');
  const untested = [];
  for (const o of doc.obligations) {
    for (const a of o.assumptions) {
      if (a.kind === 'environment' && a.observed !== 'yes') untested.push(`${o.id}: "${text(a.fact)}" is ${a.observed === 'no' ? 'observed false' : 'not observed'}`);
    }
    if (o.source_trace === 'not-traced') untested.push(`${o.id}: source not traced`);
  }
  push('### Untested properties', '', list(untested), '');

  // ------------------------------------------------------------ 2. coverage
  push('## 2. Coverage', '');
  // The lead's own words, including its family screening: shown, never computed or checked.
  push('### Scope summary and family screening (as recorded)', '', 'Recorded by the lead in `scope.summary`; the helper neither computes nor checks it.', '');
  push(text(doc.scope.summary) ? table(['Recorded summary'], [[doc.scope.summary]]) : 'None recorded.', '');
  if (doc.freshness) {
    const fr = doc.freshness;
    const kinds = {};
    for (const f of fr.changed_files) kinds[f.change] = (kinds[f.change] ?? 0) + 1;
    push(`### Freshness against base ${fr.base_run}`, '');
    push(list([
      ...fr.repos.map((r) => `${r.path}: ${r.outcome}`),
      `${fr.changed_files.length} changed files${fr.changed_files.length ? `: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}` : ''}`,
    ]), '');
    const here = (id) => doc.obligations.find((o) => o.id === id);
    push(table(['Inherited obligation', 'Class', 'Reason', 'This run'], fr.obligations.map((f) => [
      f.id, f.class, f.reason,
      here(f.id) ? `re-recorded: ${here(f.id).status}` : f.class === 'current' ? `concluded in ${f.origin ?? fr.base_run}` : 'not re-recorded',
    ])), '');
  }
  push('### Census recipes', '', table(['Recipe', 'Pattern', 'Scope', 'Hits', 'Limits'], doc.census.recipes.map((r) => [r.id, r.pattern, r.scope, String(r.hits), r.limits])), '');
  const counts = { classified: 0, unknown: 0, excluded: 0 };
  for (const i of doc.census.items) counts[i.status] += 1;
  push('### Census items', '', `${doc.census.items.length} items: ${counts.classified} classified, ${counts.unknown} unknown, ${counts.excluded} excluded.`, '');
  push(table(['Item', 'Path', 'Mechanism', 'Status', 'Affects', 'Reason'], doc.census.items.map((i) => [i.id, i.path, i.mechanism, i.status, (i.affects ?? []).join(', ') || 'none', i.reason])), '');
  push('### Obligation coverage', '', table(['Obligation', 'Coverage', 'Method', 'Status'], doc.obligations.map((o) => [o.id, o.coverage, o.coverage_method, o.status])), '');

  // ------------------------------------------------------------ 3. correctness
  push('## 3. Correctness', '');
  const held = doc.obligations.filter((o) => o.status === 'held');
  push('### Held', '', table(['Obligation', 'Claim', 'Evidence method', 'Verified'], held.map((o) => [
    o.id, o.claim, o.coverage_method, verified(o) ? 'Verified' : 'not verified',
  ])), '');
  const linked = (o) => doc.findings.filter((f) => f.obligation === o.id || o.links.includes(f.id)).map((f) => f.id).join(', ');
  push('### Violated', '', table(['Obligation', 'Claim', 'Findings'], doc.obligations.filter((o) => o.status === 'violated').map((o) => [o.id, o.claim, linked(o)])), '');
  push('### Accepted and out of scope', '', table(['Obligation', 'Status', 'Claim'], doc.obligations.filter((o) => o.status === 'accepted' || o.status === 'out-of-scope').map((o) => [o.id, o.status, o.claim])), '');

  // ------------------------------------------------------------ 4. findings
  push('## 4. Findings', '');
  const findings = [...doc.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (findings.length === 0) push('None.', '');
  for (const f of findings) {
    const v = f.verification;
    push(`### ${f.id} · ${f.kind} · ${f.severity ?? 'unrated'} · ${f.verdict} · decision ${f.decision}`, '');
    push(list([
      `Summary: ${text(f.summary)}`,
      `Impact: ${f.impact_dimension ?? 'not set'}; obligation: ${f.obligation ?? 'none'}`,
      `Verification: ${v.role === 'none' ? 'none' : `${v.role} (${v.model}), ${v.outcome ?? 'no outcome'}${v.incomplete ? ', incomplete' : ''}`}${v.corrections ? `; corrections: ${text(v.corrections)}` : ''}`,
      ...f.trace.map((s) => `Trace ${s.role}: ${s.anchor}${s.note ? ` (${text(s.note)})` : ''}`),
      ...f.counterevidence.map((c) => `Counterevidence: ${c.anchor ?? 'no anchor'}${c.note ? ` (${text(c.note)})` : ''}`),
      ...(f.validation_plan ? [`Validation plan: ${text(f.validation_plan)}`] : []),
    ]), '');
  }

  // ------------------------------------------------------------ 5, 6
  push('## 5. Delegations', '', table(['Role', 'Agent', 'Model', 'Effort', 'Budget', 'Tool uses', 'Tokens', 'Completed', 'Recoveries'],
    doc.delegations.map((d) => [d.role, d.agent, d.model, d.effort ?? '–', String(d.budget_calls), String(d.tool_uses ?? '–'), String(d.tokens ?? '–'), d.completed ? 'yes' : 'no', String(d.recovery_messages)])), '');
  const { budget } = doc;
  // A delegation whose usage was never reported makes the token total a lower bound.
  const unreported = doc.delegations.filter((d) => d.tokens === null).map((d) => d.role);
  const subagentTokens = unreported.length
    ? `at least ${budget.spent.subagent_tokens} (not reported: ${unreported.join(', ')})`
    : String(budget.spent.subagent_tokens);
  push('## 6. Cost', '', table(['Measure', 'Budget', 'Spent', 'Source'], [
    ['Lead tool calls', String(budget.lead_tool_calls), String(budget.spent.lead_tool_calls), 'recorded by the lead'],
    ['Subagent calls', String(budget.subagent_calls), String(budget.spent.subagent_calls), 'recorded by the lead'],
    ['Obligations', String(budget.obligations_max), String(doc.obligations.length), 'counted from the records'],
    ['Subagent tokens', '–', subagentTokens, 'recorded by the lead from task notifications'],
    ['Lead tokens observed', '–', String(budget.spent.lead_tokens_observed ?? 'not observed'), 'recorded by the lead'],
    ['Open to close (minutes)', '–', String(budget.spent.wall_clock_min), 'computed by close'],
  ]), '', 'Open to close is the recorded run interval (`run.opened` to `run.closed`). Session time outside it and money cost are not measured.', 'The helper cannot observe tool calls: the lead\'s counts are its own report (earlier runs were off by up to 7). Only the session transcript observes them.', '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
