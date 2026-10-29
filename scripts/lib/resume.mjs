// `resume` (M2-T5; decisions C1, C4, C5, C6): what to do with a namespace's
// open run once the source may have moved since its Open snapshot.
// - continue: the snapshot still holds. Untracked, coverage or unverified
//   differences only ask the lead to reassess scope and census.
// - abandon: the tracked source changed, or a cited file is untracked,
//   absent or unverified in a repository whose untracked or unverified state
//   changed. Without --apply this is a plan, and nothing changes. With
//   --apply the run becomes `abandoned` (the only way to that status, C1)
//   and a run that `continues` it opens, carrying every unresolved
//   obligation, unverified finding and debt item forward (C4; C5 as
//   amended: accepted limitations and out-of-scope exclusions are resolved
//   and stay in the abandoned records only).
// Git is read-only; only the abandoned run's records.json is rewritten and
// the continuation's directory created. Closed runs are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { carryRequired, checkRun } from './check.mjs';
import { TEMPORARY, isLeftoverError, listed, recheckEntry, removeLeftoverTemporaries, utc, wallClockMinutes } from './close.mjs';
import { citedAtRisk } from './footprint.mjs';
import { parseNamespace, resolveReviewPath, runDir, writeAtomic } from './fsguard.mjs';
import { AUDIT_MODES, BASE_STATUSES, CONTINUES_STATUSES, RunError, auditAuthorization, createRun, listRuns, prepareRun, readRun, requireRun } from './runs.mjs';
import { parseAnchor } from './schema.mjs';
import { compareSnapshots, takeSnapshot } from './snapshot.mjs';

export const RESUME_RECHECK_COMMAND = 'nthr resume: source recheck';
const clip = (value, max = 600) => {
  const one = String(value ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};

// Leftover temporary files of a killed write in a run directory (not removed).
function temporaries(root, rel) {
  const found = [];
  for (const sub of [rel, `${rel}/packs`]) {
    const dir = resolveReviewPath(root, sub, { expectDirectory: true, minDepth: 3 });
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (TEMPORARY.test(name) && fs.lstatSync(path.join(dir, name)).isFile()) found.push(`${sub}/${name}`);
    }
  }
  return found;
}

// The continuation's `new-run` options: same mode, slug, unit and base;
// the change re-derived from the run's scope (an Incremental run is sized
// since its base again).
function continuationSpec(ns, doc) {
  return {
    ns,
    mode: doc.run.mode,
    slug: doc.run.slug,
    unit: doc.run.unit,
    base: doc.run.base,
    continues: doc.run.id,
    change: doc.run.mode === 'incremental' ? [] : doc.scope.change.map((c) => (c.working_tree ? c.repo : `${c.repo}:${c.range}`)),
    // A flow continuation resolves the same selectors again, on the source as it is now.
    ...(doc.run.mode === 'flow' ? { entry: doc.scope.entries.map((e) => e.selector) } : {}),
  };
}

const DEBT_KIND = Object.freeze({
  'needs-runtime': 'runtime', 'needs-owner-intent': 'owner-decision', 'needs-owner-fact': 'owner-fact',
  budget: 'budget', frontier: 'frontier', verification: 'verification',
});
const obligationKind = (o) => (o.status === 'open' ? DEBT_KIND[o.open_reason] ?? 'verification' : 'verification');
const OBLIGATION_PRIORITY = Object.freeze({ violated: 'high', open: 'medium', held: 'medium' });
function findingPriority(f) {
  if (['critical', 'high'].includes(f.severity) || ['security', 'financial', 'data-integrity'].includes(f.impact_dimension)) return 'high';
  return ['low', 'informational'].includes(f.severity) ? 'low' : 'medium';
}
const citesAny = (o, files) => [...o.evidence, ...o.assumptions.filter((a) => a.kind === 'dependency')]
  .some((e) => files.has(parseAnchor(e.anchor)?.path));

// The abandoned run's debt (in `final`, mutated), C5 as amended (owner
// decision, 2026-10-26): every undecided inherited item carried and handed
// on under its own id, the lead's debt-out kept, and a new item for every
// carry-required item (check's `carryRequired`: open or violated
// obligations, held ones on unverified or absent evidence, unverified
// findings) and every held obligation citing a file resume found at risk,
// unless a debt item already refers to it. `accepted` and `out-of-scope`
// obligations are resolved: they stay in the records, never in new debt.
function carryDebt(final, parent, citedFiles = []) {
  const id = final.run.id;
  const carriedIn = [];
  for (const item of final.debt.in) {
    if (item.disposition === null) {
      item.disposition = 'carried';
      item.note ??= 'carried on abandon (resume)';
    }
    if (item.disposition !== 'carried' || final.debt.out.some((d) => d.id === item.id)) continue;
    const origin = parent?.debt.out.find((d) => d.id === item.id);
    if (!origin) throw new RunError(`debt-in ${item.id} is not in the debt-out of ${item.from_run}; the chain is inconsistent`);
    final.debt.out.push({
      id: item.id,
      kind: origin.kind,
      refs: final.obligations.filter((o) => o.links.includes(item.id)).map((o) => o.id),
      requires: origin.requires,
      priority: origin.priority,
    });
    carriedIn.push(item.id);
  }

  const referenced = new Set(final.debt.out.flatMap((d) => d.refs));
  const own = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/D(\\d+)$`);
  let n = Math.max(0, ...final.debt.out.map((d) => Number(own.exec(d.id)?.[1] ?? 0)));
  const generated = [];
  const add = (item) => {
    n += 1;
    const entry = { id: `${id}/D${n}`, ...item };
    final.debt.out.push(entry);
    generated.push(entry);
  };
  const required = new Set(carryRequired(final).map((item) => item.id));
  const atRisk = new Set(citedFiles);
  for (const o of final.obligations) {
    const carried = required.has(o.id) || (o.status === 'held' && citesAny(o, atRisk));
    if (!carried || referenced.has(o.id)) continue;
    const was = o.status === 'open' ? `open (${o.open_reason})` : o.status === 'held' ? 'held on evidence that is unverified, absent or at risk' : o.status;
    add({
      kind: obligationKind(o),
      refs: [o.id],
      requires: `${o.id} was ${was} when ${id} was abandoned: re-establish "${clip(o.claim)}" against the current source`,
      priority: OBLIGATION_PRIORITY[o.status] ?? 'medium',
    });
  }
  for (const f of final.findings) {
    if (!required.has(f.id) || referenced.has(f.id)) continue;
    let requires;
    if (f.verdict === 'candidate') requires = `verify ${f.id} (from ${id}) against the current source: ${clip(f.summary)}`;
    else if (f.verdict === 'needs_validation') requires = `validate ${f.id} (from ${id}): ${clip(f.validation_plan)}`;
    else requires = `complete the verification of ${f.id} (from ${id}) against the current source: ${clip(f.summary)}`;
    add({ kind: 'verification', refs: [f.id], requires, priority: findingPriority(f) });
  }
  // The lead's assumption-changed marks come from facts outside Git, so the
  // continuation's own `fresh` cannot find them again: an inherited
  // obligation so marked and not yet re-recorded is handed on (protocol §8).
  const recorded = new Set(final.obligations.map((o) => o.id));
  for (const entry of final.freshness?.obligations ?? []) {
    if (entry.class !== 'assumption-changed' || recorded.has(entry.id)) continue;
    add({
      kind: 'verification',
      refs: [],
      requires: `${entry.id} was marked assumption-changed in ${id} (${clip(entry.reason)}) and not reassessed before ${id} was abandoned: reassess ${entry.id} fully against the current source`,
      priority: 'high',
    });
  }
  return { carriedIn, generated };
}

// The namespace's runs, read once: refuses unreadable ones, records that name
// another run, and states only a crash or a hand edit can produce.
function readNamespace(root, ns) {
  const { ids } = listRuns(root, ns);
  const runs = ids.map((id) => {
    const { doc, errors } = readRun(root, ns, id);
    if (!doc || errors.length) {
      throw new RunError(`run ${id} in ${ns} cannot be read (${errors[0]}); fix or remove it first (an empty run directory is left by an interrupted new-run or resume)`);
    }
    if (doc.run.namespace !== ns || doc.run.id !== id) throw new RunError(`run ${id} in ${ns}: its records name ${doc.run.namespace}/${doc.run.id}`);
    return doc;
  });
  const open = runs.filter((d) => d.run.status === 'open');
  // An abandoned run that no run continues: an apply interrupted after its commit point.
  const interrupted = runs.filter((d) => d.run.status === 'abandoned' && !runs.some((o) => o.run.continues === d.run.id));
  if (open.length > 1) throw new RunError(`${open.length} runs are open in ${ns} (${listed(open.map((d) => d.run.id))}); only one may be (C5). Close or remove the extra ones by hand`);
  if (open.length && interrupted.length) {
    throw new RunError(`${ns} has an open run (${open[0].run.id}) and an abandoned run with no continuation (${listed(interrupted.map((d) => d.run.id))}); resolve it by hand`);
  }
  if (interrupted.length > 1) throw new RunError(`${ns} has ${interrupted.length} abandoned runs with no continuation (${listed(interrupted.map((d) => d.run.id))}); resolve them by hand`);
  if (!open.length && !interrupted.length) throw new RunError(`no open run in ${ns}; start one with new-run`);
  return { ids, open: open[0] ?? null, interrupted: interrupted[0] ?? null };
}

// Its parent chain, as new-run requires it. Returns the immediate parent.
function parentOf(root, ns, doc, ids) {
  const base = doc.run.base === null ? null : requireRun(root, ns, doc.run.base, ids, 'base', BASE_STATUSES);
  const continues = doc.run.continues === null ? null : requireRun(root, ns, doc.run.continues, ids, 'continues', CONTINUES_STATUSES);
  for (const parent of [base, continues].filter(Boolean)) {
    if (AUDIT_MODES.includes(parent.run.mode) !== AUDIT_MODES.includes(doc.run.mode) || (parent.run.mode === 'flow') !== (doc.run.mode === 'flow')) {
      throw new RunError(`${parent.run.id} is a ${parent.run.mode} run; the ${doc.run.mode} run ${doc.run.id} cannot build on it`);
    }
  }
  return continues ?? base;
}

// A flow continuation re-resolves the entry selectors. A symbol selector
// follows its definition; a line selector does not, so when its file's
// identity changed since Open, the continuation is refused.
function staleLineSelectors(doc, prepared) {
  if (doc.run.mode !== 'flow') return;
  const stale = doc.scope.entries.filter((e, i) => e.symbol === null && prepared.records.scope.entries[i]?.identity.blob !== e.identity.blob);
  if (stale.length) {
    throw new RunError(`the files of line selectors ${stale.map((e) => e.selector).join(', ')} changed since Open, so those lines may now hold other code. Close this run with --status incomplete --reason snapshot-changed, then open a new flow run with selectors checked by \`nthr resolve\` (a #Symbol selector follows its definition)`);
  }
}

const summaryOf = (spec, prepared) => ({
  mode: spec.mode, slug: spec.slug, unit: spec.unit, base: spec.base, continues: spec.continues, change: spec.change,
  run: prepared.records.run.id, debt_in: prepared.records.debt.in.map((d) => d.id),
  // Flow: what the selectors resolve to now (a line selector may now name other code: confirm it).
  ...(spec.mode === 'flow' ? { entries: prepared.records.scope.entries.map((e) => ({ id: e.id, selector: e.selector, anchor: `${e.path}:${e.lines[0]}-${e.lines[1]}`, state: e.identity.state })) } : {}),
});

// Resumes the namespace's open run. Returns the result, or { errors } (exit 1:
// the abandoned records would fail check; nothing written). Throws RunError
// on a refusal (exit 2; nothing written).
export function resumeRun(root, ns, {
  apply = false, now = new Date(), officialAuditsEnabled = false, gitOptions, snapshot: snapshotOptions = {}, io = {},
} = {}) {
  if (typeof ns !== 'string') throw new RunError('--ns is required');
  // An official audit namespace answers nothing while audits are disabled,
  // not even `continue` (N3, C19).
  if (parseNamespace(ns).kind === 'audit') {
    const refusal = auditAuthorization(root, ns, officialAuditsEnabled);
    if (refusal) throw new RunError(refusal);
  }
  const { ids, open, interrupted } = readNamespace(root, ns);
  const prepareSettings = { now, officialAuditsEnabled, gitOptions, snapshot: snapshotOptions };

  // An apply interrupted after its commit point: open the continuation now.
  if (interrupted) {
    const spec = continuationSpec(ns, interrupted);
    const prepared = prepareRun(root, spec, prepareSettings);
    staleLineSelectors(interrupted, prepared);
    const plan = {
      action: 'abandon',
      cause: 'interrupted',
      run: interrupted.run.id,
      run_dir: `.nth-review/${runDir(ns, interrupted.run.id)}`,
      source: null,
      changed: { tracked: [], cited: [] },
      abandon: null,
      debt: { out: interrupted.debt.out.map((d) => d.id) },
      continuation: summaryOf(spec, prepared),
    };
    if (!apply) return { errors: [], applied: false, ...plan, next: `nthr resume --ns ${ns} --apply` };
    const created = createRun(root, prepared, { io });
    return { errors: [], applied: true, ...plan, run: created.run_id, run_dir: created.run_dir, abandoned: { run: interrupted.run.id, run_dir: plan.run_dir, closed: interrupted.run.closed }, continuation: created, removed_temporary: [] };
  }

  const doc = open;
  const id = doc.run.id;
  const rel = runDir(ns, id);
  if (now.getTime() < Date.parse(doc.run.opened)) {
    throw new RunError(`the clock reads ${utc(now)}, before the run opened (${doc.run.opened}); correct the system clock first`);
  }
  const parent = parentOf(root, ns, doc, ids);
  const compared = compareSnapshots(doc.snapshot, takeSnapshot(root, { ...snapshotOptions, gitOptions }));
  const source = { tracked: compared.tracked, untracked: compared.untracked, coverage: compared.coverage, action: compared.action };
  const repoPaths = doc.snapshot.repos.map((r) => r.path);
  const affected = compared.untracked === 'unverified' ? repoPaths : [...new Set([...compared.repos.untracked, ...compared.repos.unverified])];

  // A cited file that may have changed unseen (citedAtRisk): the evidence may
  // rest on something that changed. A tracked change is the cause first.
  const cited = compared.tracked === 'changed' ? [] : citedAtRisk(root, doc, compared, { gitOptions });
  const cause = compared.tracked === 'changed' ? 'tracked-changed' : cited.length ? 'cited-untracked' : null;

  if (cause === null) {
    return {
      errors: [],
      action: 'continue',
      applied: false,
      run: id,
      run_dir: `.nth-review/${rel}`,
      source,
      reassess: compared.action === 'reassess'
        ? { repos: affected, instruction: `Reassess scope and census for ${listed(affected) || 'the project'}, then close with --reassessed` }
        : null,
      temporary: temporaries(root, rel),
    };
  }

  // Abandon: the run's final records and its continuation, both complete in
  // memory before anything is written.
  const final = structuredClone(doc);
  final.run.status = 'abandoned';
  final.run.incomplete_reason = 'snapshot-changed';
  final.run.closed = utc(now);
  final.budget.spent.wall_clock_min = wallClockMinutes(final.run.opened, final.run.closed);
  final.checks = [...final.checks, recheckEntry(compared, false, {
    command: RESUME_RECHECK_COMMAND,
    extra: [
      ...(cited.length ? [`cited untracked, absent or unverified: ${listed(cited.map((c) => c.path))}`] : []),
      'abandoned by resume',
    ],
  })];
  const { carriedIn, generated } = carryDebt(final, parent, cited.map((c) => c.path));
  const checked = checkRun(root, `${ns}/runs/${id}`, { officialAuditsEnabled, document: final });
  const errors = checked.errors.filter((message) => !isLeftoverError(message, { abandoning: true })); // apply removes those files
  if (errors.length) return { errors };
  const spec = continuationSpec(ns, final);
  const prepared = prepareRun(root, spec, { ...prepareSettings, pending: final });
  staleLineSelectors(doc, prepared);

  const plan = {
    action: 'abandon',
    cause,
    run: id,
    run_dir: `.nth-review/${rel}`,
    source,
    changed: { tracked: compared.repos.tracked, cited },
    abandon: { status: 'abandoned', incomplete_reason: 'snapshot-changed', closed: final.run.closed },
    debt: { carried_in: carriedIn, out: final.debt.out.map((d) => d.id), generated },
    continuation: summaryOf(spec, prepared),
  };
  if (!apply) return { errors: [], applied: false, ...plan, temporary: temporaries(root, rel), next: `nthr resume --ns ${ns} --apply` };

  // The abandoned records are the commit point; a crash after it leaves an
  // abandoned run with no continuation, which the next resume finishes.
  // An interrupted close may have left report.md, and the lead an unapplied
  // patch.json: an abandoned run has neither.
  const removedTemporary = removeLeftoverTemporaries(root, rel, { abandoning: true });
  writeAtomic(root, `${rel}/records.json`, `${JSON.stringify(final, null, 2)}\n`, { rename: io.rename });
  const created = createRun(root, prepared, { io });
  return {
    errors: [],
    applied: true,
    ...plan,
    run: created.run_id,
    run_dir: created.run_dir,
    abandoned: { run: id, run_dir: `.nth-review/${rel}`, closed: final.run.closed },
    continuation: created,
    removed_temporary: removedTemporary,
    warnings: checked.warnings,
  };
}
