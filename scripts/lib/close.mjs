// `close` (M2-T3; decisions C1, C5, C9, C13): the only way an open run
// becomes complete or incomplete. In order, and changing nothing until the
// end:
// 1. recheck the source state against the snapshot taken at Open: a tracked
//    change refuses the close (unless it is explicitly closed as
//    incomplete/snapshot-changed); an untracked or coverage change, or state
//    that cannot be verified, needs an explicit --reassessed;
// 2. compute the footprint (in memory);
// 3. check the final records in close mode;
// 4. write report.md, then records.json last (both atomic).
// The original snapshot is never replaced; the recheck is recorded in
// `checks`, so the report re-renders from the records alone.
import fs from 'node:fs';
import path from 'node:path';
import { checkRun } from './check.mjs';
import { citedAtRisk, computeFootprint, footprintSummary, owningRepository } from './footprint.mjs';
import { resolveEntries } from './flow.mjs';
import { verifyFreshness } from './fresh.mjs';
import { resolveReviewPath, runDir, writeAtomic } from './fsguard.mjs';
import { RECHECK_COMMAND, renderReport } from './render.mjs';
import { RunError, isAuditClose, readRun } from './runs.mjs';
import { LIMITS, VOCAB } from './schema.mjs';
import { compareSnapshots, takeSnapshot } from './snapshot.mjs';

const MAX_LISTED = 20;
export const listed = (paths) => (paths.length > MAX_LISTED ? `${paths.slice(0, MAX_LISTED).join(', ')} and ${paths.length - MAX_LISTED} more` : paths.join(', '));

// The ledger after a unit run closes: its unit gets the run and its result.
function withUnitResult(final) {
  const { run } = final;
  return final.scope.units.map((u) => (u.id !== run.unit ? u : {
    ...u,
    runs: [...u.runs, run.id],
    status: run.status,
    reason: run.status === 'complete' ? null : `run ${run.id} closed incomplete (${run.incomplete_reason})`,
  }));
}

// The ledger at the audit close: a complete unit stays complete only while
// every file its last run cited has the identity that run recorded. A change,
// an unverified or absent identity, or a last run that cannot be read makes
// it incomplete, with the reason; nothing unverifiable stays complete.
function withDrift(root, ns, units, { gitOptions }) {
  const cut = (text) => (text.length > LIMITS.string - 40 ? `${text.slice(0, LIMITS.string - 60)} ... (cut)` : text);
  return units.map((u) => {
    if (u.status !== 'complete') return u;
    const last = u.runs.at(-1);
    const downgrade = (why) => ({ ...u, status: 'incomplete', reason: cut(`audit close: ${why}`) });
    if (last === undefined) return downgrade('no unit run concluded it');
    const { doc, errors } = readRun(root, ns, last);
    if (!doc || errors.length) return downgrade(`its last run ${last} cannot be read`);
    const now = computeFootprint(root, doc, { gitOptions });
    if (now.errors.length) return downgrade(`the files its last run ${last} cites cannot be identified now`);
    const changed = Object.entries(doc.footprint).filter(([file, then]) => {
      const current = now.footprint[file];
      return !current || then.state === 'unverified' || current.state === 'unverified' || current.state !== then.state || current.blob !== then.blob;
    }).map(([file]) => file);
    return changed.length ? downgrade(`files cited by ${last} changed or cannot be verified since: ${changed.join(', ')}`) : u;
  });
}

// One `checks` entry per unit that has a run: what its last run left
// unresolved, counted from that run's records (C13: the report shows it).
export const UNIT_SUMMARY_COMMAND = 'nthr close: unit summary';
function unitSummaries(root, ns, units) {
  return units.filter((u) => u.runs.length).map((u) => {
    const last = u.runs.at(-1);
    const { doc, errors } = readRun(root, ns, last);
    let result;
    if (!doc || errors.length) result = `${u.id} (${last}): its records cannot be read`;
    else {
      const count = (list, pred) => list.filter(pred).length;
      const confirmed = doc.findings.filter((f) => f.verdict === 'confirmed' && f.kind === 'defect');
      const bySeverity = ['critical', 'high', 'medium', 'low', 'informational'].map((sev) => [sev, count(confirmed, (f) => f.severity === sev)]).filter(([, n]) => n).map(([sev, n]) => `${n} ${sev}`);
      result = [
        `${u.id} (${last})`,
        `open obligations ${count(doc.obligations, (o) => o.status === 'open')}`,
        `violated ${count(doc.obligations, (o) => o.status === 'violated')}`,
        `confirmed defects ${confirmed.length}${bySeverity.length ? ` (${bySeverity.join(', ')})` : ''}`,
        `needs_validation ${count(doc.findings, (f) => f.verdict === 'needs_validation')}`,
        `unverified findings ${count(doc.findings, (f) => f.verdict === 'candidate' || f.verification.incomplete)}`,
        `risks ${count(doc.findings, (f) => f.kind === 'risk')}`,
        `debt handed on ${doc.debt.out.length}`,
      ].join('; ');
    }
    return { command: UNIT_SUMMARY_COMMAND, cwd: '.', result, proves: `what ${last} recorded`, not_proven: 'that its conclusions still hold beyond the drift check; the run report has the details' };
  });
}

// The `checks` entry that records a source recheck: close's by default, or
// `command` (resume's), with `extra` result parts.
export function recheckEntry(compared, reassessed, { command = RECHECK_COMMAND, extra = [] } = {}) {
  const parts = [`tracked ${compared.tracked}`, `untracked ${compared.untracked}`, `coverage ${compared.coverage}`, `action ${compared.action}`];
  if (compared.repos.tracked.length) parts.push(`tracked differs in: ${listed(compared.repos.tracked)}`);
  if (compared.repos.unverified.length) parts.push(`tracked unverified in: ${listed(compared.repos.unverified)}`);
  if (compared.repos.untracked.length) parts.push(`untracked differs in: ${listed(compared.repos.untracked)}`);
  if (compared.action === 'reassess' && command === RECHECK_COMMAND) parts.push(reassessed ? 'the lead declared scope and census reassessed (--reassessed)' : 'not reassessed');
  parts.push(...extra);
  const proves = compared.tracked === 'equal'
    ? 'The tracked source state at Close equals the snapshot taken at Open.'
    : compared.tracked === 'changed'
      ? `Nothing about the Open snapshot: tracked source changed; the run is ${command === RECHECK_COMMAND ? 'closed' : 'abandoned'} as snapshot-changed.`
      : 'The tracked keys are equal, but some tracked content could not be observed.';
  const notProven = [
    compared.tracked === 'unverified' ? 'the content of unverified tracked entries' : null,
    compared.untracked !== 'equal' ? 'that untracked files are unchanged' : null,
    compared.coverage !== 'equal' ? 'that the repository set and coverage are unchanged' : null,
  ].filter(Boolean);
  return {
    command,
    cwd: '.',
    result: parts.join('; '),
    proves,
    not_proven: notProven.length ? `Not proven: ${notProven.join('; ')}.` : 'Nothing beyond the limits of the snapshot itself.',
  };
}

export const utc = (date) => `${date.toISOString().slice(0, 19)}Z`;

// Owner decision (2026-10-26): the wall clock is never the lead's estimate.
// It is the time from Open to Close, in minutes to one decimal, computed from
// the run's recorded UTC timestamps.
export const wallClockMinutes = (opened, closed) => Math.round((Date.parse(closed) - Date.parse(opened)) / 6000) / 10;

// fsguard.writeAtomic's temporary name: `.<name>.<pid>.<12 hex>.tmp`.
export const TEMPORARY = /^\.[A-Za-z0-9][A-Za-z0-9._-]*\.\d+\.[0-9a-f]{12}\.tmp$/;

// A write killed mid-way leaves its temporary file, which `check` rightly
// flags. Close (recovery) removes only those files, only in this open run's
// directory and its packs/, and never through a link. Resume, abandoning a
// run (`abandoning`), also removes the report.md an interrupted close left
// (close writes it before records.json, so the records never confirmed it)
// and an unapplied patch.json (never applied: the abandoned records are the
// ones carried on).
export function removeLeftoverTemporaries(root, rel, { abandoning = false } = {}) {
  const removed = [];
  for (const sub of [rel, `${rel}/packs`]) {
    const dir = resolveReviewPath(root, sub, { expectDirectory: true, minDepth: 3 });
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const leftover = TEMPORARY.test(name) || (abandoning && sub === rel && (name === 'report.md' || name === 'patch.json'));
      if (leftover && fs.lstatSync(file).isFile()) {
        fs.rmSync(file);
        removed.push(`${sub}/${name}`);
      }
    }
  }
  return removed;
}

// `check` errors about leftovers that close and resume remove themselves, and
// only once every other refusal has passed: a killed write's temporary file;
// for resume (`abandoning`), also the report.md an interrupted close left and
// an unapplied patch.json in the run it abandons. Close never ignores a
// pending patch: the lead applies or clears it first.
export const isLeftoverError = (message, { abandoning = false } = {}) => {
  const match = /^run directory: (?:packs\/)?([^:/]+):/.exec(message);
  if (!match) return false;
  if (TEMPORARY.test(match[1])) return true;
  return abandoning && (/^run directory: report\.md: an abandoned run/.test(message) || /^run directory: patch\.json: a closed run holds no pending patch/.test(message));
};

// Closes the open run `<ns>/runs/<id>`. Returns { errors } (exit 1, nothing
// changed) or the result. Throws RunError (exit 2, nothing changed) when the
// close is refused. `io.rename` is passed to the atomic writes (tests).
export function closeRun(root, ns, id, {
  status, reason = null, reassessed = false, now = new Date(), officialAuditsEnabled = false, gitOptions, snapshot: snapshotOptions = {}, io = {},
} = {}) {
  if (status !== 'complete' && status !== 'incomplete') {
    throw new RunError('--status must be complete or incomplete (a run is abandoned only through resume)');
  }
  if (status === 'complete' && reason !== null) throw new RunError('--reason is only for --status incomplete');
  if (status === 'incomplete' && !VOCAB.incompleteReason.includes(reason)) {
    throw new RunError(`--status incomplete needs --reason: ${VOCAB.incompleteReason.join(', ')}`);
  }
  const { doc, errors } = readRun(root, ns, id);
  if (!doc || errors.length) return { errors };
  if (doc.run.status !== 'open') throw new RunError(`run ${id} is already ${doc.run.status}; a closed run never changes (C1)`);
  if (now.getTime() < Date.parse(doc.run.opened)) {
    throw new RunError(`the clock reads ${utc(now)}, before the run opened (${doc.run.opened}); correct the system clock, then close`);
  }

  // 1. The source must still be the one the evidence was taken from.
  const current = takeSnapshot(root, { ...snapshotOptions, gitOptions });
  const compared = compareSnapshots(doc.snapshot, current);
  const explicitlyChanged = status === 'incomplete' && reason === 'snapshot-changed';
  if (compared.tracked === 'changed' && !explicitlyChanged) {
    throw new RunError(`the tracked source changed since Open (${listed(compared.repos.tracked)}), so evidence may come from a different state. Resume the run, or close it explicitly with --status incomplete --reason snapshot-changed`);
  }
  if (compared.tracked !== 'changed' && compared.action === 'reassess' && !reassessed) {
    throw new RunError(`since Open: tracked ${compared.tracked}, untracked ${compared.untracked}, coverage ${compared.coverage}. Reassess scope and census for ${listed([...new Set([...compared.repos.untracked, ...compared.repos.unverified])]) || 'the project'}, then close with --reassessed`);
  }
  // `--reassessed` covers scope and census, never a cited file that may have
  // changed unseen (citedAtRisk): its evidence may be stale, and the footprint
  // would record the new identity as reviewed. That is a resume, in every
  // mode, as resume itself decides (cause cited-untracked).
  const risk = citedAtRisk(root, doc, compared, { gitOptions });
  if (risk.length && !explicitlyChanged && compared.tracked !== 'changed') {
    throw new RunError(`files this review cites may have changed since Open (${risk.map((r) => `${r.path} ${r.state}`).join(', ')}); run \`nthr resume --ns ${ns}\`, or close with --status incomplete --reason snapshot-changed`);
  }
  // A flow run (BETA) concludes on its entries: every entry must still
  // resolve exactly as at Open (same lines, same content identity). Resume
  // does not re-resolve entries, so the remedy is an explicit close.
  if (doc.run.mode === 'flow' && !explicitlyChanged) {
    const { entries, problems } = resolveEntries(root, doc.scope.entries.map((e) => e.selector), doc.snapshot.repos.map((r) => r.path), { gitOptions });
    const moved = problems.length ? problems : doc.scope.entries.filter((e, i) => JSON.stringify(e) !== JSON.stringify(entries[i])).map((e) => `${e.id} ${e.selector}`);
    if (moved.length) {
      throw new RunError(`the selected entries no longer resolve as at Open (${moved.join('; ')}); close with --status incomplete --reason snapshot-changed, then open a new flow run with checked selectors`);
    }
  }
  // An incremental run's freshness must be the one this tree gives (M2-T4):
  // a stale or hand-edited class is refused. Not after a tracked change.
  if (doc.run.mode === 'incremental' && !explicitlyChanged) verifyFreshness(root, ns, doc, current, { gitOptions });

  // 2-3. The records as they will be written, checked before anything is.
  const fp = computeFootprint(root, doc, { gitOptions });
  if (fp.errors.length) return { errors: fp.errors };
  // These identities come from a tree that is not the one the evidence was
  // taken from: never let a later run treat them as the evidence's. That is
  // every cited file of a repository whose tracked state changed, and every
  // cited file that may have changed unseen (only reachable here with an
  // explicit snapshot-changed close).
  const changed = new Set(compared.tracked === 'changed' ? compared.repos.tracked : []);
  const atRisk = new Set(risk.map((r) => r.path));
  const repos = doc.snapshot.repos.map((r) => r.path);
  for (const [file, identity] of Object.entries(fp.footprint)) {
    if ((changed.has(owningRepository(file, repos)) || atRisk.has(file)) && identity.state !== 'unverified') {
      fp.footprint[file] = { blob: null, state: 'unverified', reason: 'source-changed' };
    }
  }
  const final = structuredClone(doc);
  final.footprint = fp.footprint;
  final.checks = [...final.checks, recheckEntry(compared, reassessed)];
  final.run.status = status;
  final.run.incomplete_reason = reason;
  final.run.closed = utc(now);
  final.budget.spent.wall_clock_min = wallClockMinutes(final.run.opened, final.run.closed);
  // Full Audit (C20): close records the unit's result in the ledger, and the
  // audit close downgrades a complete unit whose cited files changed since
  // its last run (the freshness of earlier units, protocol §10).
  if (final.run.mode === 'audit-unit') {
    final.scope.units = isAuditClose(final.run) ? withDrift(root, ns, final.scope.units, { gitOptions }) : withUnitResult(final);
    // The audit close also records, per unit, what its last run left
    // unresolved, so the whole-audit report shows the findings and debt.
    if (isAuditClose(final.run)) final.checks = [...final.checks, ...unitSummaries(root, ns, final.scope.units)];
  }
  const checked = checkRun(root, `${ns}/runs/${id}`, { officialAuditsEnabled, document: final, closing: true });
  const blocking = checked.errors.filter((message) => !isLeftoverError(message)); // removed below
  if (blocking.length) return { errors: blocking };
  // Recovery from a killed earlier write: only after every refusal above,
  // the check included, so a refused close changes nothing.
  const removedTemporary = removeLeftoverTemporaries(root, runDir(ns, id));

  // 4. report.md, then records.json last: a failure before the second write
  // leaves the run open, and a later close starts over.
  const rel = runDir(ns, id);
  writeAtomic(root, `${rel}/report.md`, renderReport(final), { rename: io.rename });
  writeAtomic(root, `${rel}/records.json`, `${JSON.stringify(final, null, 2)}\n`, { rename: io.rename });
  return {
    errors: [],
    run_dir: `.nth-review/${rel}`,
    status,
    reason,
    report: `.nth-review/${rel}/report.md`,
    source: { tracked: compared.tracked, untracked: compared.untracked, coverage: compared.coverage, action: compared.action, reassessed },
    footprint: footprintSummary(fp.footprint),
    removed_temporary: removedTemporary,
    warnings: checked.warnings,
  };
}
