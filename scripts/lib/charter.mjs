// `charter` (M2-T7; decisions N3, C19): the owner's explicit creation of an
// official audit namespace, `.nth-review/audits/<id>/charter.json`. Gated:
// refused while OFFICIAL_AUDITS_ENABLED (nthr.mjs) is false, which it stays
// until the release criteria pass. Never replaced, only in a new audits/
// namespace, and never created by any other command (new-run refuses an
// audit namespace without one).
import fs from 'node:fs';
import path from 'node:path';
import { utc } from './close.mjs';
import { parseNamespace, resolveReviewPath, writeAtomic } from './fsguard.mjs';
import { RunError } from './runs.mjs';
import { CHARTER_PROFILES, CHARTER_SCHEMA_ID, DECISION_LIMITS, validateCharter } from './schema.mjs';

const GATE_CLOSED = 'official audits are disabled: OFFICIAL_AUDITS_ENABLED is false until the release criteria pass';

// Creates the charter. Returns the result; throws RunError (or FsGuardError)
// on a refusal, writing nothing.
export function createCharter(root, {
  ns, owner, scope, exclusions, official = false, profile = 'standard', budgetSessions = null,
} = {}, { now = new Date(), officialAuditsEnabled = false } = {}) {
  if (typeof ns !== 'string') throw new RunError('--ns is required');
  const { kind } = parseNamespace(ns);
  if (kind !== 'audit') throw new RunError(`a charter is only for an audits/<id> namespace, not ${ns}`);
  if (!officialAuditsEnabled) throw new RunError(GATE_CLOSED);
  if (official !== true) throw new RunError("charter needs --official: the owner's explicit authorization of an official audit");
  if (typeof owner !== 'string' || owner.trim() === '' || owner.length > DECISION_LIMITS.by || /[\t\r\n]/.test(owner)) {
    throw new RunError(`--owner is required: who authorizes the audit (one line, at most ${DECISION_LIMITS.by} characters)`);
  }
  if (typeof scope !== 'string' || scope.trim() === '') throw new RunError('--scope is required: what the audit covers');
  if (typeof exclusions !== 'string' || exclusions.trim() === '') throw new RunError('--exclusions is required: what the owner excludes from the audit, or "none"');
  if (!CHARTER_PROFILES.includes(profile)) throw new RunError(`--profile must be one of ${CHARTER_PROFILES.join(', ')}`);
  if (budgetSessions !== null && !/^[1-9]\d{0,3}$/.test(String(budgetSessions))) throw new RunError('--budget-sessions must be a whole number from 1 to 9999');

  // A charter starts a new namespace and is never replaced.
  const dir = resolveReviewPath(root, ns, { expectDirectory: true, minDepth: 2 });
  if (fs.existsSync(path.join(dir, 'charter.json'))) throw new RunError(`${ns} is already chartered; a charter is never replaced`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new RunError(`${ns} already holds other files; a charter starts a new audit namespace`);

  const charter = {
    schema: CHARTER_SCHEMA_ID,
    official: true,
    namespace: ns,
    owner,
    scope,
    exclusions,
    profile,
    budget_sessions: budgetSessions === null ? null : Number(budgetSessions),
    created: utc(now),
  };
  const problems = validateCharter(charter);
  if (problems.length) throw new RunError(`the charter cannot be recorded: ${problems[0]}`);
  writeAtomic(root, `${ns}/charter.json`, `${JSON.stringify(charter, null, 2)}\n`, { exclusive: true });
  return { charter: `.nth-review/${ns}/charter.json`, namespace: ns, owner, profile, budget_sessions: charter.budget_sessions, created: charter.created };
}
