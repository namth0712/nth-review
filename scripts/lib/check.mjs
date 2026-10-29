// `check` (M1-T8): read-only semantic validation of one run (decisions C1,
// C4, C11-C18, C21; namespace rules N1-N5; model-routing.md). It reads the
// run directory, the run's records and its parent's, and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { citedPaths } from './footprint.mjs';
import { REVIEW_DIR, parseNamespace, parseRunId, resolveReviewPath } from './fsguard.mjs';
import { coverageBlockers, restsOnUnverified, unverifiedFinding } from './render.mjs';
import { LIMITS, parseAnchor, validateStructure } from './schema.mjs';
import {
  AUDIT_MODES, BASE_STATUSES, CONTINUES_STATUSES, MODES_BY_KIND, RESERVED_UNIT, RunError, auditAuthorization, auditChainProblem,
  auditContinuesProblem, effectiveBaseline, flowPlanOf, isAuditClose, listRuns, readRun, TASK_SIZES, unitClassified, unitProblem,
} from './runs.mjs';

// Delegation roles (model-routing.md §1): agent and model for each.
export const ROLES = Object.freeze({
  R2: { agent: 'Explore', model: 'sonnet' },
  R3: { agent: 'Explore', model: 'sonnet' },
  R4: { agent: 'reviewer', model: 'opus' },
  R5: { agent: 'reviewer', model: 'opus' },
  R6: { agent: 'reviewer', model: 'sonnet' },
  R7: { agent: 'verifier', model: 'sonnet' },
});
// A confirmed defect with these needs the Opus refuter R5 (protocol-v0.1 §7).
const R5_SEVERITIES = ['critical', 'high'];
const R5_DIMENSIONS = ['financial', 'security', 'data-integrity'];
const PACK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,124}\.md$/;

// `--run` as `.nth-review/<ns>/runs/<run-id>` or `<ns>/runs/<run-id>`;
// backslashes are accepted for Windows shells.
export function parseRunArg(value) {
  if (typeof value !== 'string' || value === '') throw new RunError('--run is required: .nth-review/<ns>/runs/<run-id>');
  let rel = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (rel.startsWith(`${REVIEW_DIR}/`)) rel = rel.slice(REVIEW_DIR.length + 1);
  const parts = rel.split('/');
  if (parts.length !== 4 || parts[2] !== 'runs') {
    throw new RunError(`--run must be .nth-review/<ns>/runs/<run-id>: ${JSON.stringify(value)}`);
  }
  const ns = `${parts[0]}/${parts[1]}`;
  parseNamespace(ns);
  parseRunId(parts[3]);
  return { ns, id: parts[3], rel };
}

const blank = (v) => v === null || (typeof v === 'string' && v.trim() === '');

// One path segment against a pattern segment: `*` is any text, `?` one
// character. Greedy with a single backtrack point, so it stays O(p·s) for any
// pattern (no regular expression, no catastrophic backtracking).
function segmentMatches(pattern, text) {
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[s])) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = s;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      s = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

// A census path covers a file when every segment matches; `*` and `?`
// never cross a `/`.
export function globMatches(pattern, file) {
  const patterns = pattern.split('/');
  const parts = file.split('/');
  return patterns.length === parts.length && patterns.every((segment, i) => segmentMatches(segment, parts[i]));
}

// C18: only records.json, report.md, packs/*.md and, while the run is open,
// the lead's pending patch.json; no links anywhere.
function checkDirectory(dir, add) {
  const present = { records: false, report: false, patch: false };
  for (const name of fs.readdirSync(dir).sort()) {
    const stats = fs.lstatSync(path.join(dir, name));
    const where = `run directory: ${name}`;
    if (stats.isSymbolicLink()) add(`${where}: symbolic links and junctions are not allowed (C18)`);
    else if (name === 'records.json' && stats.isFile()) present.records = true;
    else if (name === 'report.md' && stats.isFile()) present.report = true;
    else if (name === 'patch.json' && stats.isFile()) present.patch = true;
    else if (name === 'packs' && stats.isDirectory()) {
      for (const pack of fs.readdirSync(path.join(dir, name)).sort()) {
        const packStats = fs.lstatSync(path.join(dir, name, pack));
        if (!packStats.isFile() || packStats.isSymbolicLink() || !PACK.test(pack)) {
          add(`run directory: packs/${pack}: only packs/<id>.md files are allowed (C18)`);
        }
      }
    } else add(`${where}: unexpected; a run directory holds only records.json, report.md, packs/*.md and an open run's patch.json (C18)`);
  }
  return present;
}

// ---------------------------------------------------------------- rules

function identityRules(c) {
  const { doc, ns, id, kind } = c;
  const run = doc.run;
  if (run.namespace !== ns) c.add('$.run.namespace', `must be ${ns}, the namespace of its directory (N1)`);
  if (run.id !== id) c.add('$.run.id', `must be ${id}, its directory name`);
  if (!MODES_BY_KIND[kind].includes(run.mode)) c.add('$.run.mode', `${run.mode} is not allowed in a ${kind} namespace`);
  if (kind === 'audit') {
    const refusal = auditAuthorization(c.root, ns, c.officialAuditsEnabled);
    if (refusal) c.add('$.run.namespace', refusal);
  }
  const unitIds = doc.scope.units.map((u) => u.id);
  if (run.mode === 'audit-unit' && (run.unit === null || (run.unit !== RESERVED_UNIT && !unitIds.includes(run.unit)))) {
    c.add('$.run.unit', `an audit-unit run names a unit of its units ledger, or ${RESERVED_UNIT} for the audit close`);
  }
  const reserved = unitIds.indexOf(RESERVED_UNIT);
  if (reserved >= 0) c.add(`$.scope.units[${reserved}].id`, `${RESERVED_UNIT} is reserved for the audit close; a unit cannot use it`);
  if (run.mode !== 'audit-unit' && run.unit !== null) c.add('$.run.unit', 'must be null unless the mode is audit-unit');
  if ((run.mode === 'incremental' || run.mode === 'audit-unit') && run.base === null) c.add('$.run.base', `is required for ${run.mode}`);
  for (const role of ['base', 'continues']) {
    if (run[role] === run.id) c.add(`$.run.${role}`, 'must not name the run itself');
  }
}

// N2, N5: base and continues are closed runs of the same namespace.
function parentRules(c) {
  const parents = {};
  for (const [role, statuses] of [['base', BASE_STATUSES], ['continues', CONTINUES_STATUSES]]) {
    const parentId = c.doc.run[role];
    if (parentId === null || parentId === c.id) continue;
    const where = `$.run.${role}`;
    if (!c.runIds.includes(parentId)) {
      c.add(where, `${parentId} is not a run in ${c.ns}; it must be in the same namespace (N2, N5)`);
      continue;
    }
    const { doc, errors } = c.read(parentId);
    if (!doc || errors.length) {
      c.add(where, `${parentId} fails validation: ${errors[0]}`);
      continue;
    }
    if (doc.run.namespace !== c.ns || doc.run.id !== parentId) c.add(where, `${parentId}: its records name ${doc.run.namespace}/${doc.run.id}`);
    if (!statuses.includes(doc.run.status)) c.add(where, `${parentId} is ${doc.run.status}; it must be ${statuses.join(' or ')}`);
    if (AUDIT_MODES.includes(doc.run.mode) !== AUDIT_MODES.includes(c.doc.run.mode) || (doc.run.mode === 'flow') !== (c.doc.run.mode === 'flow')) {
      c.add(where, `${parentId} is a ${doc.run.mode} run; a ${c.doc.run.mode} run cannot build on it`);
    }
    parents[role] = doc;
  }
  return parents;
}

function duplicates(list, where, c) {
  const seen = new Set();
  list.forEach((value, i) => {
    if (seen.has(value)) c.add(`${where}[${i}].id`, `duplicate id ${value}`);
    seen.add(value);
  });
}

// C4: debt-in is exactly the immediate parent's debt-out; carried items
// reappear with the same id; every item originates in this namespace.
// `parentRole` is 'continues', 'base' or null; `parent` is undefined when
// that run could not be loaded (already reported).
function debtRules(c, parentRole, parent) {
  const { doc } = c;
  const debtIn = doc.debt.in;
  const debtOut = doc.debt.out;
  duplicates(debtIn.map((d) => d.id), '$.debt.in', c);
  duplicates(debtOut.map((d) => d.id), '$.debt.out', c);
  const inById = new Map(debtIn.map((d) => [d.id, d]));
  const outIds = new Set(debtOut.map((d) => d.id));

  if (!parentRole && debtIn.length) c.add('$.debt.in', 'must be empty without a base or continues run (C4)');
  if (parent) {
    const parentOut = new Set(parent.debt.out.map((d) => d.id));
    for (const pid of parentOut) {
      if (!inById.has(pid)) c.add('$.debt.in', `${pid} from ${parent.run.id} has no entry: debt cannot be dropped (C4)`);
    }
    debtIn.forEach((d, i) => {
      if (!parentOut.has(d.id)) c.add(`$.debt.in[${i}].id`, `is not in the debt-out of ${parent.run.id}, the immediate parent (C4)`);
      if (d.from_run !== parent.run.id) c.add(`$.debt.in[${i}].from_run`, `must be ${parent.run.id}`);
    });
  }
  debtIn.forEach((d, i) => {
    if (d.disposition === 'carried' && !outIds.has(d.id)) c.add(`$.debt.in[${i}]`, 'a carried item must reappear in debt.out with the same id (C4)');
  });
  debtOut.forEach((d, i) => {
    const inherited = inById.get(d.id);
    if (inherited && (inherited.disposition === 'discharged' || inherited.disposition === 'obsolete')) {
      c.add(`$.debt.out[${i}].id`, `is ${inherited.disposition} in debt.in, so it cannot stay open`);
    }
    if (!inherited && !d.id.startsWith(`${doc.run.id}/D`)) c.add(`$.debt.out[${i}].id`, `must be ${doc.run.id}/D<n> or a carried debt-in id`);
  });
  const official = c.kind === 'audit' ? '; an official run may not carry debt from another namespace' : '';
  for (const [list, name] of [[debtIn, 'in'], [debtOut, 'out']]) {
    list.forEach((d, i) => {
      const origin = d.id.slice(0, d.id.lastIndexOf('/'));
      if (origin !== doc.run.id && !c.runIds.includes(origin)) {
        c.add(`$.debt.${name}[${i}].id`, `originates in ${origin}, which is not a run in ${c.ns}${official}`);
      }
    });
  }
  const refs = new Set([...doc.obligations.map((o) => o.id), ...doc.findings.map((f) => f.id)]);
  debtOut.forEach((d, i) => d.refs.forEach((r, j) => {
    if (!refs.has(r)) c.add(`$.debt.out[${i}].refs[${j}]`, `${r} is not an obligation or finding of this run`);
  }));
}

// C5, as amended (owner decision, 2026-10-26): what an abandoned run must
// hand on. Unresolved obligations (open, violated), held obligations whose
// evidence is unverified or absent, and unverified findings; never the
// resolved ones (`accepted` limitations, `out-of-scope` exclusions), which
// stay in the abandoned records as history. [{ id, where, why }]
export function carryRequired(doc) {
  const required = [];
  doc.obligations.forEach((o, i) => {
    if (o.status === 'open' || o.status === 'violated') required.push({ id: o.id, where: `$.obligations[${i}]`, why: o.status });
    else if (o.status === 'held' && restsOnUnverified(doc, o)) required.push({ id: o.id, where: `$.obligations[${i}]`, why: 'held on evidence that is unverified or absent' });
  });
  doc.findings.forEach((f, i) => {
    if (unverifiedFinding(f)) {
      required.push({ id: f.id, where: `$.findings[${i}]`, why: `unverified (${f.verdict}${f.verification.incomplete ? ', verification incomplete' : ''})` });
    }
  });
  return required;
}

// An abandoned run hands on every carry-required item: some debt.out entry refers to it.
function abandonRules(c) {
  const { doc } = c;
  if (doc.run.status !== 'abandoned') return;
  const referenced = new Set(doc.debt.out.flatMap((d) => d.refs));
  for (const item of carryRequired(doc)) {
    if (!referenced.has(item.id)) c.add(item.where, `${item.id} is ${item.why} in an abandoned run; a debt.out item must refer to it (C5, as amended)`);
  }
}

function referenceRules(c) {
  const { doc } = c;
  duplicates(doc.obligations.map((o) => o.id), '$.obligations', c);
  duplicates(doc.findings.map((f) => f.id), '$.findings', c);
  duplicates(doc.census.items.map((i) => i.id), '$.census.items', c);
  duplicates(doc.census.recipes.map((r) => r.id), '$.census.recipes', c);
  duplicates(doc.scope.intent.map((i) => i.id), '$.scope.intent', c);
  duplicates(doc.scope.units.map((u) => u.id), '$.scope.units', c);
  const obligations = new Set(doc.obligations.map((o) => o.id));
  const findings = new Set(doc.findings.map((f) => f.id));
  const intents = new Set(doc.scope.intent.map((i) => i.id));
  const debts = new Set([...doc.debt.in.map((d) => d.id), ...doc.debt.out.map((d) => d.id)]);
  const units = new Set(doc.scope.units.map((u) => u.id));
  doc.obligations.forEach((o, i) => {
    o.intent.forEach((ref, j) => intents.has(ref) || c.add(`$.obligations[${i}].intent[${j}]`, `${ref} is not in scope.intent`));
    o.links.forEach((ref, j) => (findings.has(ref) || obligations.has(ref) || debts.has(ref))
      || c.add(`$.obligations[${i}].links[${j}]`, `${ref} is not a finding, obligation or debt item of this run`));
  });
  doc.findings.forEach((f, i) => {
    if (f.obligation !== null && !obligations.has(f.obligation)) c.add(`$.findings[${i}].obligation`, `${f.obligation} is not an obligation of this run`);
  });
  doc.census.items.forEach((item, i) => (item.affects ?? []).forEach((ref, j) => obligations.has(ref)
    || c.add(`$.census.items[${i}].affects[${j}]`, `${ref} is not an obligation of this run`)));
  doc.scope.units.forEach((u, i) => u.depends_on.forEach((ref, j) => units.has(ref)
    || c.add(`$.scope.units[${i}].depends_on[${j}]`, `${ref} is not a unit of the ledger`)));
  // Dependencies form no cycle, so every unit can run once its dependencies are complete.
  const deps = new Map(doc.scope.units.map((u) => [u.id, u.depends_on]));
  const reaches = (from, target, seen) => (deps.get(from) ?? []).some((d) => d === target || (!seen.has(d) && seen.add(d) && reaches(d, target, seen)));
  doc.scope.units.forEach((u, i) => reaches(u.id, u.id, new Set())
    && c.add(`$.scope.units[${i}].depends_on`, `${u.id} depends on itself, directly or through other units`));
}

// C12 and the evidence and verification requirements.
function verdictRules(c) {
  const { doc } = c;
  const verified = (f) => ['R5', 'R6'].includes(f.verification.role) && f.verification.incomplete === false
    && ['confirmed', 'corrected'].includes(f.verification.outcome);
  doc.obligations.forEach((o, i) => {
    const where = `$.obligations[${i}]`;
    const linked = doc.findings.filter((f) => f.obligation === o.id || o.links.includes(f.id));
    if ((o.status === 'held' || o.status === 'accepted') && o.evidence.length === 0) {
      c.add(`${where}.evidence`, o.status === 'held' ? 'a held obligation needs cited evidence (C12)' : 'an accepted obligation cites the doc that accepts the limitation');
    }
    if (o.status === 'held') {
      const defect = linked.find((f) => f.kind === 'defect' && f.verdict === 'confirmed');
      if (defect) c.add(`${where}.status`, `cannot be held: ${defect.id} is a confirmed defect (C12)`);
      // SKILL §3.4-3.5: the obligation stays open / verification until its
      // finding is verified, and a needs_validation finding makes it violated.
      const unsettled = linked.find((f) => f.kind === 'defect' && (f.verdict === 'candidate' || f.verdict === 'needs_validation'));
      if (unsettled) {
        c.add(`${where}.status`, `cannot be held while ${unsettled.id} is ${unsettled.verdict}: keep it open (verification) until the finding is verified; needs_validation makes it violated (C12)`);
      }
    }
    if (o.status === 'violated' && !linked.some((f) => f.verdict === 'confirmed' || f.verdict === 'needs_validation')) {
      c.add(`${where}.status`, 'violated needs a linked finding that is confirmed or needs_validation (C12)');
    }
  });
  doc.findings.forEach((f, i) => {
    const where = `$.findings[${i}]`;
    const v = f.verification;
    if (v.role === 'none' && (v.model !== null || v.outcome !== null)) c.add(`${where}.verification`, 'role none has model and outcome null');
    if (v.role !== 'none' && v.model !== ROLES[v.role].model) c.add(`${where}.verification.model`, `${v.role} is run by ${ROLES[v.role].model} (model-routing.md)`);
    if (f.kind === 'risk') {
      if (f.severity !== null) c.add(`${where}.severity`, 'a risk has no severity; the owner decides (C12)');
      if (!['candidate', 'confirmed'].includes(f.verdict)) c.add(`${where}.verdict`, 'a risk is candidate or confirmed (C12)');
      if (v.role !== 'none') c.add(`${where}.verification.role`, 'a risk has no refuter (C12)');
    }
    if (f.verdict === 'needs_validation') {
      if (f.severity !== null) c.add(`${where}.severity`, 'must be null while the finding needs validation (C12)');
      if (blank(f.validation_plan)) c.add(`${where}.validation_plan`, 'a needs_validation finding needs a validation plan (C12)');
    }
    if (f.verdict === 'rejected' && f.counterevidence.length === 0) c.add(`${where}.counterevidence`, 'a rejected finding needs counterevidence (C12)');
    if ((f.verdict === 'confirmed' || f.verdict === 'needs_validation') && f.trace.length === 0) c.add(`${where}.trace`, `a ${f.verdict} finding needs a trace`);
    if (f.verdict === 'confirmed' && f.kind !== 'risk' && f.severity === null) c.add(`${where}.severity`, `a confirmed ${f.kind} needs a severity`);
    if (f.verdict === 'confirmed' && f.kind === 'defect' && !verified(f)) {
      c.add(`${where}.verification`, 'a confirmed defect needs a completed R5 or R6 verification that confirmed or corrected it (C12)');
    }
    if (f.verdict === 'confirmed' && f.kind === 'doc-drift' && !verified(f)) {
      const mechanical = v.role === 'none' && f.trace.length > 0 && f.trace.every((step) => parseAnchor(step.anchor)?.lines);
      if (!mechanical) c.add(`${where}.verification`, 'a confirmed doc-drift needs a verification, or role none with exact-line trace anchors (C12)');
    }
    // The verdict follows the refuter's outcome (SKILL §3.5, protocol §7): an
    // incomplete verification leaves a candidate; a verdict never contradicts
    // the answer, and a defect is rejected only by a refuter that rejected it.
    const refuted = ['R5', 'R6'].includes(v.role) && v.incomplete === false;
    if (v.incomplete === true && f.verdict !== 'candidate') {
      c.add(`${where}.verdict`, `an incomplete verification leaves the finding a candidate, not ${f.verdict} (protocol §7)`);
    }
    if (refuted && f.verdict === 'rejected' && v.outcome !== 'rejected') {
      c.add(`${where}.verdict`, `rejected contradicts the ${v.role} outcome ${v.outcome ?? 'null'}; never weaken or strengthen a refuter's outcome (protocol §7)`);
    }
    if (refuted && f.verdict === 'needs_validation' && v.outcome === 'rejected') {
      c.add(`${where}.verdict`, `needs_validation contradicts the ${v.role} outcome rejected (protocol §7)`);
    }
    if (f.verdict === 'rejected' && f.kind === 'defect' && !refuted) {
      c.add(`${where}.verification`, 'a rejected defect needs a completed R5 or R6 verification that rejected it (C12)');
    }
    // R5 routing binds every refuter-decided defect, not only a confirmed one.
    const decided = f.verdict === 'confirmed' || f.verdict === 'rejected' || (f.verdict === 'needs_validation' && refuted);
    if (decided && f.kind === 'defect' && (R5_SEVERITIES.includes(f.severity) || R5_DIMENSIONS.includes(f.impact_dimension)) && v.role !== 'R5') {
      c.add(`${where}.verification.role`, 'a critical or high defect, or a money, authorization or data-integrity claim, needs the R5 Opus refuter');
    }
    if (['R5', 'R6'].includes(v.role) && v.incomplete === false
      && !doc.delegations.some((d) => d.role === v.role && d.model === v.model && d.completed)) {
      c.add(`${where}.verification`, `no completed ${v.role} ${v.model} delegation is recorded (C17)`);
    }
  });
}

// C14 and stop rule B3.
function budgetRules(c) {
  const { doc } = c;
  const { budget, run } = doc;
  const status = run.status;
  for (const field of ['lead_tool_calls', 'subagent_calls']) {
    if (budget.spent[field] <= budget[field]) continue;
    const message = `${budget.spent[field]} exceeds the budget of ${budget[field]}`;
    if (status === 'open') c.warn(`$.budget.spent.${field}: ${message}; the run must close as incomplete with reason budget`);
    else if ((status === 'complete' || status === 'incomplete') && !(status === 'incomplete' && run.incomplete_reason === 'budget')) {
      c.add(`$.budget.spent.${field}`, `${message}; close as incomplete with reason budget (C14)`);
    }
  }
  if (budget.spent.subagent_calls < doc.delegations.length) {
    c.add('$.budget.spent.subagent_calls', `is less than the ${doc.delegations.length} recorded delegations`);
  }
  const tokens = doc.delegations.reduce((n, d) => n + (d.tokens ?? 0), 0);
  if (budget.spent.subagent_tokens < tokens) c.add('$.budget.spent.subagent_tokens', `is less than the ${tokens} tokens recorded in delegations`);
  const cap = Math.floor(budget.obligations_max * 1.2);
  if (budget.obligations_max > 0 && doc.obligations.length > cap) {
    c.add('$.obligations', `${doc.obligations.length} obligations exceed the outline cap of ${cap} (obligations_max + 20%, B3); defer the rest as debt`);
  }
}

// C15, C16, C17 and model-routing.md: Opus High or Sonnet, never xHigh or max.
function routingRules(c) {
  const { run } = c.doc;
  const runtime = run.runtime;
  if ((AUDIT_MODES.includes(run.mode) || run.mode === 'incremental') && runtime.required_lead_model !== 'opus-high') {
    c.add('$.run.runtime.required_lead_model', `${run.mode} runs require opus-high`);
  }
  // The helper-owned budget records new-run's size class, which the lead
  // cannot change: any task budget but the S row is M, L or unverified
  // (protocol §3), so the task-size trigger, and with it opus-high, stays.
  if (run.mode === 'task' && c.doc.budget.lead_tool_calls !== TASK_SIZES[0].lead_tool_calls && !runtime.triggers.includes('task-size')) {
    c.add('$.run.runtime.triggers', 'a task larger than S, or of unverified size, keeps the task-size trigger new-run set (C15)');
  }
  if (runtime.triggers.length > 0 && runtime.required_lead_model !== 'opus-high') {
    c.add('$.run.runtime.required_lead_model', `must be opus-high when triggers are set (${runtime.triggers.join(', ')}) (C15)`);
  }
  const model = runtime.lead_model === null ? null : runtime.lead_model.toLowerCase();
  if (model !== null && !model.includes('opus') && !model.includes('sonnet')) {
    c.add('$.run.runtime.lead_model', 'review runs are led by Opus or Sonnet');
  }
  if (runtime.required_lead_model === 'opus-high' && model !== null && !model.includes('opus')) {
    c.add('$.run.runtime.lead_model', `${runtime.lead_model} does not meet the required opus-high${runtime.triggers.length ? ` (triggers: ${runtime.triggers.join(', ')})` : ''} (C15)`);
  }
  if (['xhigh', 'max'].includes(runtime.lead_effort)) {
    c.add('$.run.runtime.lead_effort', 'review execution uses high effort at most; never xhigh or max');
  } else if (runtime.required_lead_model === 'opus-high' && ['low', 'medium'].includes(runtime.lead_effort)) {
    c.add('$.run.runtime.lead_effort', 'opus-high needs high effort');
  }
  c.doc.delegations.forEach((d, i) => {
    const where = `$.delegations[${i}]`;
    const role = ROLES[d.role];
    if (d.agent !== role.agent) c.add(`${where}.agent`, `${d.role} is run by ${role.agent}`);
    if (d.model !== role.model) c.add(`${where}.model`, `${d.role} uses ${role.model}`);
    if (d.model === 'opus' && d.effort !== 'high') c.add(`${where}.effort`, 'an opus delegation must set effort high (C16)');
    if (d.role === 'R4' && run.mode !== 'audit-unit') c.add(`${where}.role`, 'the R4 judgment critic runs only in Full Audit units');
    if (d.recovery_messages > 1) c.add(`${where}.recovery_messages`, 'at most one recovery message (C17)');
  });
  // Protocol §10: a Tier-1 unit closes complete only after its judgment critique (R4).
  const unit = run.mode === 'audit-unit' && !isAuditClose(run) ? c.doc.scope.units.find((u) => u.id === run.unit) : undefined;
  if (run.status === 'complete' && unit?.tier === 1 && !c.doc.delegations.some((d) => d.role === 'R4' && d.completed)) {
    c.add('$.delegations', `unit ${unit.id} is Tier 1: it closes complete only after a completed R4 judgment critique; otherwise close as incomplete`);
  }
}

// C11 for an Incremental run's effective baseline: one freshness entry per
// inherited obligation, with its resolved origin; every non-current one is
// re-recorded and not a copy of its origin version.
function inheritedRules(c, freshness, baseline) {
  const { doc } = c;
  const byId = new Map(baseline.entries.map((e) => [e.id, e]));
  const evidenceKey = (evidence) => JSON.stringify(evidence.map((e) => JSON.stringify([e.anchor, e.note])).sort());
  const named = new Set();
  freshness.obligations.forEach((f, i) => {
    const where = `$.freshness.obligations[${i}]`;
    if (named.has(f.id)) c.add(`${where}.id`, `duplicate id ${f.id}`);
    named.add(f.id);
    const entry = byId.get(f.id);
    if (!entry) {
      c.add(`${where}.id`, `${f.id} is not an obligation of the effective baseline of ${freshness.base_run}; run fresh again (C11)`);
      return;
    }
    if (f.origin === freshness.base_run) c.add(`${where}.origin`, 'is written only when it is not base_run');
    else if ((f.origin ?? freshness.base_run) !== entry.origin) c.add(`${where}.origin`, `${f.id} was last recorded in ${entry.origin}, not ${f.origin ?? freshness.base_run} (C11)`);
    const inherited = entry.origin !== freshness.base_run;
    const here = doc.obligations.find((o) => o.id === f.id);
    // Recording an inherited id again keeps its claim: a different claim under
    // that id is a new obligation that would silently replace the inherited one.
    if (here && here.claim !== entry.obligation.claim) {
      c.add(`$.obligations[${doc.obligations.indexOf(here)}].claim`, `${f.id} is an inherited obligation (last recorded in ${entry.origin}) with another claim; re-record it with its claim, or give a new obligation an id the effective baseline does not use (C11)`);
    }
    if (f.class === 'current') return;
    if (!here) {
      c.add(where, `${inherited ? `inherited obligation ${f.id} (last recorded in ${entry.origin})` : `base obligation ${f.id}`} is ${f.class}; re-record it in this run and reassess it (C11)`);
      return;
    }
    if (['held', 'accepted'].includes(here.status) && evidenceKey(here.evidence) === evidenceKey(entry.obligation.evidence)) {
      const since = inherited ? entry.origin : 'the base';
      c.add(`$.obligations[${doc.obligations.indexOf(here)}].evidence`, `${f.id} is ${f.class} since ${since}, yet ${here.status} on ${inherited ? `${entry.origin}'s` : "the base's"} evidence unchanged; reassess it and record the evidence again, with notes that say what this run re-read (C11)`);
    }
  });
  for (const entry of baseline.entries) {
    if (!named.has(entry.id)) c.add('$.freshness.obligations', `inherited obligation ${entry.id} (last recorded in ${entry.origin}) has no freshness entry; run fresh again (C11)`);
  }
}

// C11 and coverage claims. `base` is the base run's records, or undefined
// when there is none or it could not be loaded (already reported).
function coverageRules(c, base) {
  const { doc } = c;
  const { run, freshness } = doc;
  if (run.mode === 'incremental') {
    if (freshness === null && run.status !== 'open' && run.status !== 'abandoned') c.add('$.freshness', 'an incremental run records freshness before it closes');
    if (freshness !== null) {
      if (freshness.base_run !== run.base) c.add('$.freshness.base_run', `must be the run's base ${run.base}`);
      const accounts = (item) => (Array.isArray(item.affects) && item.affects.length > 0) || (item.affects === null && !blank(item.reason));
      freshness.changed_files.forEach((changed, i) => {
        const items = doc.census.items.filter((it) => globMatches(it.path, changed.path));
        if (items.length === 0) {
          c.add(`$.freshness.changed_files[${i}]`, `${changed.path} has no census item (C11)`);
        } else if (!items.some(accounts)) {
          c.add(`$.census.items[${doc.census.items.indexOf(items[0])}]`, `covers changed file ${changed.path}: it needs affects, or affects null with a reason (C11)`);
        }
      });
      // The effective baseline (runs.mjs): freshness names every inherited
      // obligation exactly once, with its origin, so none is skipped or lost
      // along the chain. A conclusion whose class is not current is
      // reassessed in this run, never carried forward: it is re-recorded
      // under its id, and a held or accepted one is not its origin's
      // evidence copied unchanged (in any order). This catches a copy; it
      // cannot prove a reassessment. Close recomputes the classes themselves.
      if ((run.status === 'complete' || run.status === 'incomplete') && base) {
        let baseline = null;
        try {
          baseline = effectiveBaseline(c.root, c.ns, run.base, c.runIds, c.read);
        } catch (error) {
          if (!(error instanceof RunError)) throw error;
          c.add('$.run.base', `its ancestry cannot be resolved: ${error.message}`);
        }
        if (baseline) inheritedRules(c, freshness, baseline);
      }
    }
  } else if (freshness !== null) {
    c.add('$.freshness', 'is written only in incremental runs');
  }
  doc.obligations.forEach((o, i) => {
    if (o.coverage !== 'all-enumerated') return;
    if (!doc.snapshot.discovery_complete) {
      c.add(`$.obligations[${i}].coverage`, 'cannot be all-enumerated: repository discovery was incomplete (see snapshot.limitations)');
    }
    // An open obligation's coverage is still a target; a concluded one claims it.
    const blockers = o.status === 'open' ? [] : coverageBlockers(doc, o);
    if (blockers.length > 0) {
      c.add(`$.obligations[${i}].coverage`, `cannot be all-enumerated: census items ${blockers.map((it) => it.id).join(', ')} bear on it (an unknown item that names it or names no obligation, or an excluded item that names it); resolve or scope them, or claim named-subset (C13)`);
    }
  });
}

// C20, Full Audit (protocol §10): the units ledger. A plan run is the only
// run that edits units (scope, status planned, deferred or out_of_scope), and
// it never drops one or rewrites its runs. A unit run keeps the ledger of its
// base until close records its own unit (complete or incomplete, and the run
// in `runs`). The audit close may only downgrade a complete unit whose cited
// files changed. The chain is linear, and a unit runs only when the ledger of
// its base allows it. `base` is the base's records, or undefined when there
// is none or it could not be loaded (already reported).
function ledgerRules(c, base) {
  const { doc } = c;
  const { run } = doc;
  if (!AUDIT_MODES.includes(run.mode)) return;
  const units = doc.scope.units;
  const at = (i) => `$.scope.units[${i}]`;
  if (run.status !== 'abandoned') {
    const docs = c.runIds.map((id) => c.read(id).doc).filter(Boolean);
    const chain = auditChainProblem(docs, { id: run.id, base: run.base });
    if (chain) c.add('$.run.base', chain);
  }
  if (run.continues !== null) {
    const continued = c.read(run.continues).doc;
    const problem = continued ? auditContinuesProblem(continued.run, run) : null;
    if (problem) c.add('$.run.continues', problem);
  }
  // The audit close concludes no obligation of its own: a surface found now
  // becomes a unit through a re-plan, so nothing here reads as a project-wide claim.
  if (isAuditClose(run) && doc.obligations.length) c.add('$.obligations', 'the audit close records no obligation; a surface found now becomes a unit through a re-plan');
  if (run.mode === 'audit-plan') {
    units.forEach((u, i) => (u.scope === undefined || blank(u.scope)) && c.add(`${at(i)}.scope`, `a plan run gives unit ${u.id} its scope (its boundary)`));
    // A plan that closes complete classifies every active unit: a tier, and
    // the basis for it. Only presence and form are checked; the tier itself is
    // the lead's judgment. A plan still open, or closed incomplete, may leave a
    // unit unclassified (honestly, rather than guessing): it cannot run until
    // a re-plan classifies it.
    units.forEach((u, i) => {
      if (u.status === 'out_of_scope' || run.status !== 'complete') return;
      if (u.tier === null) c.add(`${at(i)}.tier`, `a plan run gives active unit ${u.id} a tier (1-3)`);
      if (!Array.isArray(u.basis) || u.basis.length === 0 || u.basis.some((b) => blank(b.note))) {
        c.add(`${at(i)}.basis`, `a plan run gives active unit ${u.id} the basis of its tier: at least one anchor, with a note on what it shows`);
      }
    });
  }
  if (run.base !== null && base === undefined) return;
  const before = run.base === null ? [] : base.scope.units;
  const prior = new Map(before.map((u) => [u.id, u]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (run.mode === 'audit-plan') {
    for (const u of before) {
      if (!units.some((x) => x.id === u.id)) c.add('$.scope.units', `unit ${u.id} of ${run.base} is dropped; a plan run keeps every unit (mark it deferred or out_of_scope)`);
    }
    // Priority: tier 1 first; null (no tier) last.
    const rank = (tier) => tier ?? 4;
    units.forEach((u, i) => {
      const was = prior.get(u.id);
      if (!same(u.runs, was ? was.runs : [])) c.add(`${at(i)}.runs`, was ? `must stay as in ${run.base}: only a unit run records its runs` : 'a new unit has no runs');
      // The charter's exclusions are fixed when the root plan is made: a
      // re-plan never takes an existing unit out of scope (it may defer it).
      if (was && u.status === 'out_of_scope' && was.status !== 'out_of_scope') {
        c.add(`${at(i)}.status`, `a re-plan never puts an existing unit out of scope (${u.id} is ${was.status} in ${run.base}); defer it instead`);
      }
      if (was && rank(u.tier) > rank(was.tier)) c.add(`${at(i)}.tier`, `a re-plan never lowers a unit's priority (${u.id} is tier ${was.tier ?? 'none'} in ${run.base}); Tier 1 needs R4`);
      // A unit raised to Tier 1 after its review is reviewed again, with R4.
      if (was && u.tier === 1 && was.tier !== 1 && u.status === 'complete') {
        c.add(`${at(i)}.status`, `${u.id} is raised to Tier 1 after its review; reopen it (planned) so it is reviewed again with the R4 judgment critique`);
      }
      if (u.status === 'in_progress') c.add(`${at(i)}.status`, 'in_progress is not used: a unit is concluded by its own run');
      else if (['complete', 'incomplete'].includes(u.status) && was?.status !== u.status) {
        c.add(`${at(i)}.status`, `only a unit run concludes a unit ${u.status}; a plan run sets planned, deferred or out_of_scope`);
      }
    });
    return;
  }
  if (!isAuditClose(run)) {
    const problem = unitProblem(before, run.unit);
    if (problem) c.add('$.run.unit', `${problem} in the ledger of ${run.base}`);
  }
  const closed = run.status === 'complete' || run.status === 'incomplete';
  if (!closed) {
    if (!same(units, before)) c.add('$.scope.units', `an ${run.status} unit run keeps the ledger of ${run.base} unchanged; close records the unit's result`);
    return;
  }
  if (!same(units.map((u) => u.id), before.map((u) => u.id))) {
    c.add('$.scope.units', `a unit run keeps the units of ${run.base}, in order`);
    return;
  }
  units.forEach((u, i) => {
    const was = before[i];
    if (isAuditClose(run)) {
      const downgraded = was.status === 'complete' && u.status === 'incomplete' && !blank(u.reason) && same({ ...u, status: was.status, reason: was.reason }, was);
      if (!same(u, was) && !downgraded) c.add(at(i), `the audit close keeps ${u.id} as in ${run.base}, or downgrades a complete unit to incomplete with the reason`);
    } else if (u.id === run.unit) {
      const expected = { ...was, runs: [...was.runs, run.id], status: run.status, reason: run.status === 'complete' ? null : u.reason };
      if (!same(u, expected) || (run.status === 'incomplete' && blank(u.reason))) c.add(at(i), `close records unit ${u.id} as ${run.status}, with this run in its runs`);
    } else if (!same(u, was)) {
      c.add(at(i), `unit ${u.id} is not this run's unit; it stays as in ${run.base}`);
    }
  });
}

// Protocol §8, amended for Full Audit (C4 with C20): in the linear audit
// chain, debt from another unit's run is carried until that unit or the audit
// close takes it up, so only debt from an earlier run of the same unit blocks
// a unit run's `complete`, and none blocks a plan run's. The audit close keeps
// the strict rule. An origin that cannot be read blocks.
function blocksCompletion(c, debt) {
  const { run } = c.doc;
  if (!AUDIT_MODES.includes(run.mode) || isAuditClose(run)) return true;
  if (run.mode === 'audit-plan') return false;
  const origin = c.read(debt.id.slice(0, debt.id.lastIndexOf('/'))).doc;
  return !origin || (origin.run.mode === 'audit-unit' && origin.run.unit === run.unit);
}

// C1, C17 completion: a complete run has nothing open; closed runs have
// their report.
// A path a delegate's answer named and the census did not cover is handed
// to the lead: before close, each needs a census item that covers it
// (classified, naming obligations), excludes it (excluded, or affects null
// with a reason), or leaves it unresolved (unknown, with frontier or
// deferred-scope debt whose `requires` names the path).
function discoveryRules(c) {
  const { doc } = c;
  if (doc.run.status !== 'complete' && doc.run.status !== 'incomplete') return;
  const unresolvedDebt = doc.debt.out.filter((d) => d.kind === 'frontier' || d.kind === 'deferred-scope');
  // In a flow run, a recorded edge whose evidence or target is the path disposes of it too.
  const edgeItems = (doc.census.edges ?? []).flatMap((g) => [g.evidence, g.to].filter((a) => a !== null)
    .map((a) => ({ path: parseAnchor(a).path, status: g.status, affects: g.affects, reason: g.reason })));
  doc.delegations.forEach((d, i) => (d.discovered ?? []).forEach((file, j) => {
    const items = [...doc.census.items, ...edgeItems].filter((item) => globMatches(item.path, file));
    const where = `$.delegations[${i}].discovered[${j}]`;
    const disposed = items.some((item) => (item.status === 'classified' && Array.isArray(item.affects) && item.affects.length > 0)
      || item.status === 'excluded'
      || (item.status === 'classified' && item.affects === null && typeof item.reason === 'string' && item.reason.trim() !== ''));
    if (disposed) return;
    if (items.some((item) => item.status === 'unknown')) {
      if (!unresolvedDebt.some((debt) => debt.requires.includes(file))) {
        c.add(where, `${file} (found by ${d.role}) is unknown in the census; record frontier or deferred-scope debt whose requires names it`);
      }
      return;
    }
    c.add(where, `${file} (found by ${d.role}) has no census disposition: cover it (an item naming obligations), exclude it with a reason, or record it as unknown with frontier debt`);
  }));
}

// Flow Review (BETA, protocol §10): a flow run reviews the code reached from
// its resolved entries over the edges the lead records, and nothing else.
// - The flow fields exist exactly in flow runs, and the budget is the one the
//   entries give (recomputed: a hand edit is refused).
// - Edges expand forward only: `from` is an entry or an earlier classified
//   edge with a target, so the graph has no cycle and every edge has a depth.
// - A node is a code location: the same file, with overlapping lines (or no
//   lines). An edge into a node already reached (an entry, or an earlier
//   edge's target) is a real relationship, recorded and covered like any
//   other (a cycle A -> B -> A, or two callers of one service), but it is a
//   revisit: nothing expands from it, so a node is explored once. Excluded
//   means out of scope, never "already visited".
// - Beyond max_depth, an edge only records the frontier: it is unknown. At
//   most max_edges edges; reaching the limit blocks every all-enumerated
//   claim (render.mjs coverageBlockers), as unknown edges do.
// - Classified edges name their target and the obligations covering them;
//   excluded and unknown ones give a reason (for unknown: the next step).
// - Evidence, dependency anchors and finding traces stay inside the reviewed
//   boundary: entry paths and edge evidence or target paths. No silent
//   expansion into the rest of the project.
// - A closed run hands every unknown edge on as frontier or deferred-scope
//   debt naming its evidence anchor; a complete one cites every entry.
// The same code location: one file, and overlapping lines (or no lines on either side).
const sameNode = (a, b) => a.path === b.path
  && (a.lines === null || b.lines === null || (a.lines[0] <= b.lines[1] && b.lines[0] <= a.lines[1]));

function flowRules(c) {
  const { doc } = c;
  const { run, scope, census, budget } = doc;
  const fields = { entries: scope.entries, edges: census.edges, max_depth: budget.max_depth, max_edges: budget.max_edges };
  if (run.mode !== 'flow') {
    if (fields.entries !== undefined) c.add('$.scope.entries', 'is written only in flow runs');
    if (fields.edges !== undefined) c.add('$.census.edges', 'is recorded only in flow runs');
    if (fields.max_depth !== undefined || fields.max_edges !== undefined) c.add('$.budget', 'max_depth and max_edges are flow-run limits only');
    return;
  }
  const missing = Object.entries(fields).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length) {
    c.add('$', `a flow run records ${missing.join(', ')} (new-run writes them)`);
    return;
  }
  if (scope.change.length) c.add('$.scope.change', 'a flow run has no change: it reviews the current source from its entries');
  if (run.base !== null) c.add('$.run.base', 'a flow run builds on no base');
  scope.entries.forEach((e, i) => {
    if (e.id !== `E${i + 1}`) c.add(`$.scope.entries[${i}].id`, `must be E${i + 1}`);
    if (e.lines[1] < e.lines[0]) c.add(`$.scope.entries[${i}].lines`, 'must be [from, to] with from <= to');
  });
  const plan = flowPlanOf(scope.entries).budget;
  for (const key of ['lead_tool_calls', 'subagent_calls', 'obligations_max', 'reserve_pct', 'max_depth', 'max_edges']) {
    if (budget[key] !== plan[key]) c.add(`$.budget.${key}`, `must be ${plan[key]}, as new-run sets it from the entries`);
  }
  if (run.runtime.required_lead_model !== 'opus-high') c.add('$.run.runtime.required_lead_model', 'flow runs require opus-high');

  const edges = census.edges;
  duplicates(edges.map((g) => g.id), '$.census.edges', c);
  if (edges.length > budget.max_edges) {
    c.add('$.census.edges', `${edges.length} edges exceed max_edges ${budget.max_edges}: stop expanding, and hand the rest on as frontier debt`);
  }
  const entryIds = new Set(scope.entries.map((e) => e.id));
  const obligations = new Set(doc.obligations.map((o) => o.id));
  const depth = new Map();
  const paths = [];
  // Nodes reached so far (entries first, then each new edge target, in
  // record order), and the edges that first reached a new node.
  const reached = scope.entries.map((e) => ({ path: e.path, lines: e.lines, by: e.id }));
  const firstReach = new Set();
  edges.forEach((g, i) => {
    const at = `$.census.edges[${i}]`;
    const target = g.to === null ? null : parseAnchor(g.to);
    const seen = target === null ? null : reached.find((n) => sameNode(n, target));
    let d = null;
    if (entryIds.has(g.from)) d = 1;
    else if (depth.has(g.from)) {
      const parent = edges.find((x) => x.id === g.from);
      if (parent.status !== 'classified' || parent.to === null) c.add(`${at}.from`, `${g.from} is not a classified edge with a target: only a reviewed path expands`);
      else if (!firstReach.has(g.from)) c.add(`${at}.from`, `${g.from} revisits a node already reached: a revisit keeps its relationship but is not expanded again; expand from the first path to that node`);
      d = depth.get(g.from) + 1;
    } else {
      c.add(`${at}.from`, `${g.from} is not an entry or an earlier edge: edges expand forward only, so the graph has no cycle (record a path back into reviewed code as a classified revisit)`);
    }
    if (seen && g.status === 'excluded') {
      c.add(`${at}.status`, `${g.to} was already reached (${seen.by}): a revisit is a real relationship, so record it as classified; excluded means out of scope`);
    }
    if (target !== null && !seen && g.status === 'classified') {
      reached.push({ path: target.path, lines: target.lines, by: g.id });
      firstReach.add(g.id);
    }
    if (d !== null && !depth.has(g.id)) depth.set(g.id, d);
    if (d !== null && d > budget.max_depth + 1) c.add(at, `is at depth ${d}, past max_depth ${budget.max_depth}: record the frontier once, as an unknown edge at depth ${budget.max_depth + 1}`);
    else if (d === budget.max_depth + 1 && g.status !== 'unknown') c.add(`${at}.status`, `an edge past max_depth ${budget.max_depth} only records the frontier: it must be unknown`);
    if (target !== null) {
      const repeat = paths.find((p) => p.from === g.from && p.kind === g.kind && sameNode(p.target, target));
      if (repeat) c.add(at, `repeats ${g.from} -> ${g.to} (${g.kind}) as ${repeat.id}: reuse the recorded edge`);
      paths.push({ id: g.id, from: g.from, kind: g.kind, target });
    }
    if (g.status === 'classified') {
      if (g.to === null) c.add(`${at}.to`, 'a classified edge names its target; an unresolved target is an unknown edge');
      if (!Array.isArray(g.affects) || g.affects.length === 0) c.add(`${at}.affects`, 'a classified edge names the obligations that cover it');
    } else if (blank(g.reason)) {
      c.add(`${at}.reason`, g.status === 'unknown' ? 'an unknown edge names the next validation step' : 'an excluded edge says why it is not reviewed');
    }
    (g.affects ?? []).forEach((ref, j) => obligations.has(ref) || c.add(`${at}.affects[${j}]`, `${ref} is not an obligation of this run`));
  });

  if (run.status === 'abandoned') return;
  const boundary = new Set([
    ...scope.entries.map((e) => e.path),
    ...edges.flatMap((g) => [g.evidence, g.to].filter((a) => a !== null).map((a) => parseAnchor(a).path)),
  ]);
  const inside = (anchor, where) => {
    const file = parseAnchor(anchor).path;
    if (!boundary.has(file)) c.add(where, `${file} is outside the reviewed flow (its entries and recorded edges): record the path as an edge, or leave it out`);
  };
  doc.obligations.forEach((o, i) => {
    o.evidence.forEach((e, j) => inside(e.anchor, `$.obligations[${i}].evidence[${j}]`));
    o.assumptions.forEach((a, j) => a.kind === 'dependency' && inside(a.anchor, `$.obligations[${i}].assumptions[${j}]`));
  });
  doc.findings.forEach((f, i) => f.trace.forEach((s, j) => inside(s.anchor, `$.findings[${i}].trace[${j}]`)));
  if (run.status !== 'complete' && run.status !== 'incomplete') return;
  const frontier = doc.debt.out.filter((d) => d.kind === 'frontier' || d.kind === 'deferred-scope');
  const names = (text, anchor) => new RegExp(`(^|[\\s,;(\\[])${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,;:)\\].](?!\\d))`).test(text);
  edges.forEach((g, i) => g.status === 'unknown' && !frontier.some((d) => names(d.requires, g.evidence))
    && c.add(`$.census.edges[${i}]`, `the unknown path ${g.id} (${g.evidence}) needs frontier or deferred-scope debt whose requires names ${g.evidence}`));
  if (run.status === 'complete') {
    // An evidence anchor cites an entry when it names its file and overlaps its lines (or names the whole file).
    const cites = (anchor, e) => {
      const a = parseAnchor(anchor);
      return a.path === e.path && (a.lines === null || (a.lines[0] <= e.lines[1] && a.lines[1] >= e.lines[0]));
    };
    scope.entries.forEach((e, i) => doc.obligations.some((o) => o.evidence.some((ev) => cites(ev.anchor, e)))
      || c.add(`$.scope.entries[${i}]`, `a complete flow run concludes on every entry: no obligation's evidence cites ${e.path}:${e.lines[0]}-${e.lines[1]}`));
  }
}

function completionRules(c, present) {
  const { doc } = c;
  const { run } = doc;
  if (run.status === 'complete') {
    doc.obligations.forEach((o, i) => o.status === 'open'
      && c.add(`$.obligations[${i}].status`, 'a complete run has no open obligation; close as incomplete'));
    doc.findings.forEach((f, i) => f.verdict === 'candidate'
      && c.add(`$.findings[${i}].verdict`, 'a complete run has no unverified candidate; close as incomplete'));
    // Inherited debt carried on is still open: the run did not finish it.
    doc.debt.in.forEach((d, i) => d.disposition === 'carried' && blocksCompletion(c, d)
      && c.add(`$.debt.in[${i}].disposition`, 'a complete run carries no open debt; discharge it, mark it obsolete, or close as incomplete'));
    // A plan, and the audit close, claim nothing beyond what discovery and the census establish.
    if (run.mode === 'audit-plan' || isAuditClose(run)) {
      if (!doc.snapshot.discovery_complete) c.add('$.snapshot.discovery_complete', `a complete ${isAuditClose(run) ? 'audit close' : 'audit plan'} needs complete discovery; close as incomplete`);
      doc.census.items.forEach((item, i) => item.status === 'unknown'
        && c.add(`$.census.items[${i}].status`, `a complete ${isAuditClose(run) ? 'audit close' : 'audit plan'} leaves no unknown census item; close as incomplete`));
    }
    if (isAuditClose(run)) {
      doc.scope.units.forEach((u, i) => !['complete', 'out_of_scope'].includes(u.status)
        && c.add(`$.scope.units[${i}].status`, `the audit closes complete only when every unit is complete or out of scope; ${u.id} is ${u.status}`));
      if (!doc.scope.units.some((u) => u.status === 'complete')) c.add('$.scope.units', 'the audit closes complete only when at least one unit was reviewed (complete)');
      doc.scope.units.forEach((u, i) => u.status === 'complete' && !unitClassified(u)
        && c.add(`$.scope.units[${i}]`, `the audit closes complete only when every reviewed unit is classified; ${u.id} has no tier or no tier basis (classify it in a re-plan)`));
    }
    // An Incremental run with no changed file, whose inherited obligations are
    // all current, reviewed them without recording them again (the effective
    // baseline): not empty. A changed file still needs a recorded obligation.
    const inheritsAny = run.mode === 'incremental' && (doc.freshness?.obligations.length ?? 0) > 0 && doc.freshness.changed_files.length === 0;
    const ledgerOnly = run.mode === 'audit-plan' || isAuditClose(run);
    if (ledgerOnly ? doc.scope.units.length === 0 : doc.obligations.length === 0 && !inheritsAny) {
      c.add(ledgerOnly ? '$.scope.units' : '$.obligations', 'a complete run cannot be empty; close as incomplete with a reason');
    }
  }
  if ((run.status === 'complete' || run.status === 'incomplete') && !present.report) {
    c.add('run directory', 'a closed run has report.md (C1)');
  }
  // Close writes report.md before records.json, so an interrupted close can
  // leave a report the records never confirmed. An abandoned run has none.
  if (run.status === 'abandoned' && present.report) {
    c.add('run directory: report.md', 'an abandoned run has no report.md; this one is left by an interrupted close and is not a result');
  }
}

// C9: a closed run's footprint covers exactly the files it cites, so a later
// run can tell which of them changed.
function footprintRules(c) {
  const { doc } = c;
  if (doc.run.status !== 'complete' && doc.run.status !== 'incomplete') return;
  const cited = citedPaths(doc);
  const recorded = new Set(Object.keys(doc.footprint));
  for (const file of cited) {
    if (!recorded.has(file)) c.add('$.footprint', `${file} is cited but has no entry; run footprint before closing (C9)`);
  }
  const citedSet = new Set(cited);
  for (const file of recorded) {
    if (!citedSet.has(file)) c.add(`$.footprint[${JSON.stringify(file)}]`, 'is not cited by the run; run footprint again');
  }
}

function namespaceRules(c) {
  if (c.doc.run.status !== 'open') return;
  for (const other of c.runIds) {
    if (other === c.id) continue;
    const { doc, errors } = c.read(other);
    if (!doc) c.add('$.run.status', `${other} in ${c.ns} cannot be read (${errors[0]}), so this run cannot be shown to be the only open one`);
    else if (doc.run?.status === 'open') c.add('$.run.status', `${other} is also open in ${c.ns}; one open run per namespace (C5)`);
  }
}

// ---------------------------------------------------------------- entry

// Returns { run_dir, status, errors, warnings }. Throws RunError (or
// FsGuardError) when the run cannot be located safely.
// Close mode (`document`, `closing`): checks the records `close` is about to
// write instead of the file, and counts report.md as present because close
// renders it before writing the records.
export function checkRun(root, runArg, { officialAuditsEnabled = false, document, closing = false } = {}) {
  const { ns, id, rel } = parseRunArg(runArg);
  const dir = resolveReviewPath(root, rel, { expectDirectory: true, minDepth: 3 });
  if (!fs.existsSync(dir)) throw new RunError(`no run directory .nth-review/${rel}`);

  const errors = [];
  const warnings = [];
  let full = false;
  const push = (message) => {
    if (full) return;
    if (errors.length < LIMITS.errors - 1) errors.push(message);
    else {
      errors.push(`error limit (${LIMITS.errors}) reached; further errors omitted`);
      full = true;
    }
  };
  const result = (doc) => ({ run_dir: `.nth-review/${rel}`, status: doc?.run?.status ?? null, errors, warnings });

  const present = checkDirectory(dir, push);
  if (closing) present.report = true;
  const { doc, errors: structure } = document === undefined
    ? readRun(root, ns, id)
    : { doc: document, errors: validateStructure(document) };
  structure.forEach(push);
  if (!doc || structure.length) return result(doc);

  const c = {
    root, ns, id, doc,
    kind: parseNamespace(ns).kind,
    runIds: listRuns(root, ns).ids,
    officialAuditsEnabled,
    add: (where, message) => push(`${where}: ${message}`),
    warn: (message) => warnings.push(message),
    // Another run of the namespace; a link or other unsafe path there is
    // reported as an error of this check, not a refusal of the whole check.
    read: (otherId) => {
      try {
        return readRun(root, ns, otherId);
      } catch (error) {
        if (error?.refusal === true) return { doc: undefined, errors: [error.message] };
        throw error;
      }
    },
  };
  identityRules(c);
  const parents = parentRules(c);
  // Debt comes from the immediate parent: continues when set, else base (C4).
  const parentRole = doc.run.continues !== null ? 'continues' : doc.run.base !== null ? 'base' : null;
  debtRules(c, parentRole, parentRole ? parents[parentRole] : null);
  abandonRules(c);
  referenceRules(c);
  verdictRules(c);
  budgetRules(c);
  routingRules(c);
  coverageRules(c, parents.base);
  ledgerRules(c, parents.base);
  completionRules(c, present);
  discoveryRules(c);
  flowRules(c);
  if (present.patch && doc.run.status !== 'open') c.add('run directory: patch.json', 'a closed run holds no pending patch; apply it (or apply an empty one) before close');
  footprintRules(c);
  namespaceRules(c);
  return result(doc);
}
