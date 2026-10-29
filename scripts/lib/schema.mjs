// nth-review/records@1: the structural contract of records.json, and a
// dependency-free validator. It checks shape, types, closed vocabularies,
// anchors, limits and forbidden keys, plus the few rules that depend on the run
// being open or closed. Cross-record meaning (verdict rules, debt continuity,
// references between ids) belongs to `check`, not here.
import { RUN_ID, RUN_MODES, parseNamespace } from './fsguard.mjs';

export const SCHEMA_ID = 'nth-review/records@1';
// The helper and protocol versions (`nthr version`, and the report's Helper
// row). Here rather than in cli.mjs, which render.mjs cannot import (cycle).
export const VERSION = '1.0.0-rc.2';
export const PROTOCOL = 'v0.1';

export const LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  depth: 64,
  values: 500_000,
  string: 4096,
  key: 1024,
  path: 1024,
  obligations: 2000,
  arrayItems: 10_000,
  errors: 100,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Closed vocabularies. reference/records.md lists every value (tested).
export const VOCAB = Object.freeze({
  runStatus: ['open', 'complete', 'incomplete', 'abandoned'],
  incompleteReason: ['budget', 'open-obligations', 'unverified-findings', 'escalation', 'snapshot-changed', 'owner-stopped'],
  mode: [...RUN_MODES],
  profile: ['quick', 'standard', 'deep'],
  requiredLeadModel: ['opus-high', 'sonnet'],
  leadEffort: ['low', 'medium', 'high', 'xhigh', 'max', 'unknown'],
  trigger: ['authorization', 'money', 'schema-migration', 'concurrency', 'boundary-contract', 'ai-dispatch', 'task-size'],
  unitStatus: ['planned', 'in_progress', 'complete', 'incomplete', 'deferred', 'out_of_scope'],
  censusStatus: ['classified', 'unknown', 'excluded'],
  coverage: ['all-enumerated', 'named-subset', 'sample', 'excluded'],
  obligationStatus: ['held', 'violated', 'open', 'accepted', 'out-of-scope'],
  openReason: ['needs-runtime', 'needs-owner-intent', 'needs-owner-fact', 'budget', 'frontier', 'verification'],
  sourceTrace: ['consistent', 'inconsistent', 'not-traced'],
  assumptionKind: ['dependency', 'environment'],
  observed: ['yes', 'no', 'unknown'],
  findingKind: ['defect', 'risk', 'doc-drift'],
  verdict: ['candidate', 'confirmed', 'needs_validation', 'rejected'],
  severity: ['critical', 'high', 'medium', 'low', 'informational'],
  impactDimension: ['security', 'privacy', 'data-integrity', 'financial', 'availability', 'correctness', 'operability', 'maintainability'],
  traceRole: ['entrypoint', 'propagation', 'sink'],
  verificationRole: ['R5', 'R6', 'none'],
  verificationOutcome: ['confirmed', 'corrected', 'needs_validation', 'rejected'],
  agentModel: ['opus', 'sonnet'],
  delegationEffort: ['high'],
  delegationRole: ['R2', 'R3', 'R4', 'R5', 'R6', 'R7'],
  agent: ['Explore', 'reviewer', 'verifier'],
  decision: ['pending', 'fix', 'accept', 'false-positive', 'known-item'],
  disposition: ['discharged', 'carried', 'obsolete'],
  debtKind: ['runtime', 'owner-decision', 'owner-fact', 'deferred-scope', 'frontier', 'verification', 'budget'],
  priority: ['high', 'medium', 'low'],
  footprintState: ['clean', 'dirty', 'untracked', 'absent', 'unverified'],
  footprintReason: ['filter', 'secret', 'link', 'unreadable', 'case-mismatch', 'nested-repository', 'repository-unavailable', 'source-changed'],
  snapshotLimitation: [
    'root-not-a-repository', 'enclosing-repository', 'not-a-repository', 'symlink-skipped',
    'unreadable-directory', 'undecodable-directory', 'unrepresentable-path', 'scan-limit',
    'secret-not-hashed', 'file-not-hashed', 'filter-not-run', 'submodule-not-covered', 'flagged-not-hashed', 'truncated',
  ],
  historyOutcome: ['equal', 'ancestor', 'diverged', 'base-missing', 'base-dirty'],
  changeType: ['added', 'modified', 'deleted', 'renamed', 'transient', 'untracked'],
  freshClass: ['touched', 'file-changed', 'assumption-changed', 'current'],
  edgeKind: ['route', 'call', 'data', 'event', 'job', 'dynamic', 'external', 'guard', 'error'],
});

// Snapshot limitation codes meaning part of the tree was not scanned, or a
// repository inside it is not covered: discovery is then incomplete.
export const INCOMPLETE_DISCOVERY = Object.freeze([
  'scan-limit', 'unreadable-directory', 'undecodable-directory', 'unrepresentable-path', 'submodule-not-covered',
]);
// sha256 of empty input: the digest of a clean repository.
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const CLOSED_STATUSES = new Set(['complete', 'incomplete', 'abandoned']);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INTENT_ID = /^I[1-9]\d{0,3}$/;
export const ENTRY_ID = /^E[1-8]$/;
export const EDGE_ID = /^G[1-9]\d{0,3}$/;
const EDGE_FROM = /^(E[1-8]|G[1-9]\d{0,3})$/;
const RECIPE_ID = /^C[1-9]\d?$/;
const CHECK_ID = /^[A-Z][A-Z0-9-]{0,31}(\.[1-9]\d{0,2})?$/;
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUN_ID_BODY = RUN_ID.source.slice(1, -1);
const DEBT_ID = new RegExp(`^${RUN_ID_BODY}/D[1-9]\\d{0,5}$`);
const TIMESTAMP = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?Z$/;
const OBJECT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REV_RANGE = /^[^\s:\\]{1,100}\.\.[^\s:\\]{1,100}$/;
const LINE = /^[1-9]\d{0,8}$/;
// Allowed in text: tab, line feed, carriage return; nothing else below U+0020, no DEL.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// ---------------------------------------------------------------- paths

// A repository-root-relative path: forward slashes, no drive, no `.`/`..`,
// no trailing dot or space in a component (Windows), and none of the anchor
// delimiters `:` and `#`. `allowDot` admits "." (the project root itself);
// `allowGlob` admits `*` and `?` (census groups).
export function repoPathProblem(value, { allowDot = false, allowGlob = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) return 'must be a non-empty path';
  if (value.length > LIMITS.path) return `must be at most ${LIMITS.path} characters`;
  if (allowDot && value === '.') return null;
  if (value.includes('\\')) return 'must use / separators, not backslashes';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'must be relative, not absolute';
  if (CONTROL.test(value) || value.includes('\0')) return 'must not contain control characters';
  if (value.includes(':') || value.includes('#')) return 'must not contain ":" or "#"';
  if (!allowGlob && /[*?]/.test(value)) return 'must not contain * or ?';
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'must not contain empty, . or .. components';
    if (segment.length > 255) return 'has a component longer than 255 characters';
    if (/[ .]$/.test(segment)) return 'has a component ending with a space or a dot';
  }
  return null;
}

// `path`, `path:L1`, `path:L1-L2` (L2 >= L1) or `path#Heading`.
export function parseAnchor(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.path) return null;
  let file = value;
  let lines = null;
  let heading = null;
  const hash = value.indexOf('#');
  if (hash !== -1) {
    file = value.slice(0, hash);
    heading = value.slice(hash + 1);
    if (heading.length === 0 || heading.length > 200 || CONTROL.test(heading)) return null;
  } else {
    const match = /^(.*?):([^:]*)$/.exec(value);
    if (match) {
      file = match[1];
      const [from, to = from, extra] = match[2].split('-');
      if (extra !== undefined || !LINE.test(from) || !LINE.test(to) || Number(to) < Number(from)) return null;
      lines = [Number(from), Number(to)];
    }
  }
  if (repoPathProblem(file)) return null;
  return { path: file, lines, heading };
}

// ---------------------------------------------------------------- errors

class Errors {
  constructor(max) {
    this.max = max;
    this.list = [];
    this.full = false;
  }

  add(where, message) {
    if (this.full) return;
    if (this.list.length < this.max - 1) {
      this.list.push(`${where}: ${message}`);
    } else {
      this.list.push(`error limit (${this.max}) reached; further errors omitted`);
      this.full = true;
    }
  }
}

const child = (where, key) =>
  typeof key === 'number'
    ? `${where}[${key}]`
    : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      ? `${where}.${key}`
      : `${where}[${JSON.stringify(key)}]`;

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

// ---------------------------------------------------------------- spec nodes

const S = {
  string: (opts = {}) => ({ type: 'string', ...opts }),
  int: (opts = {}) => ({ type: 'int', min: 0, max: Number.MAX_SAFE_INTEGER, ...opts }),
  number: (opts = {}) => ({ type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, ...opts }),
  bool: (opts = {}) => ({ type: 'bool', ...opts }),
  oneOf: (values, opts = {}) => ({ type: 'enum', values, ...opts }),
  constant: (value) => ({ type: 'const', value }),
  array: (item, opts = {}) => ({ type: 'array', item, min: 0, max: LIMITS.arrayItems, ...opts }),
  object: (fields, opts = {}) => ({ type: 'object', fields, ...opts }),
  map: (key, value, opts = {}) => ({ type: 'map', key, value, max: LIMITS.arrayItems, ...opts }),
  custom: (fn, opts = {}) => ({ type: 'custom', fn, ...opts }),
};

const pattern = (re, what, opts = {}) => S.string({ pattern: re, what, ...opts });
const id = (opts) => pattern(ID, 'an id ([A-Za-z0-9._-], at most 64)', opts);
const runId = (opts) => pattern(RUN_ID, 'a run id (YYYYMMDD-HHMMSS-<mode>-<slug>)', opts);
const debtId = () => pattern(DEBT_ID, 'a debt id (<run-id>/D<n>)');
const linkId = () =>
  S.custom((v) => (typeof v === 'string' && (ID.test(v) || DEBT_ID.test(v)) ? null : 'must be a finding, obligation or debt id'));
const text = (opts) => S.string({ ...opts });
const required = (opts) => S.string({ min: 1, ...opts });
const timestamp = (opts) => pattern(TIMESTAMP, 'a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)', opts);
const repoPath = (opts = {}) =>
  S.custom((v) => repoPathProblem(v, opts), { nullable: opts.nullable });
const anchor = (opts = {}) =>
  S.custom((v) => (parseAnchor(v) ? null : 'must be an anchor: path, path:L1, path:L1-L2 or path#Heading'), opts);
const namespace = S.custom((v) => {
  try {
    parseNamespace(v);
    return null;
  } catch (error) {
    return error.message;
  }
});

const assumption = S.custom((value, where, ctx) => {
  const fields = { kind: null, anchor: null, fact: null, observed: null, note: null };
  if (!checkObjectShape(value, fields, where, ctx)) return undefined;
  if (value.kind === 'dependency') {
    if (!parseAnchor(value.anchor)) return 'a dependency assumption needs a valid anchor';
    if (value.fact !== null || value.observed !== null) return 'a dependency assumption has fact and observed null';
  } else if (value.kind === 'environment') {
    if (typeof value.fact !== 'string' || value.fact.trim() === '') return 'an environment assumption needs a fact';
    if (value.anchor !== null) return 'an environment assumption has anchor null';
    if (!VOCAB.observed.includes(value.observed)) return `observed must be one of ${VOCAB.observed.join(', ')}`;
  } else {
    return `kind must be one of ${VOCAB.assumptionKind.join(', ')}`;
  }
  if (typeof value.note !== 'string') return 'note must be a string';
  return null;
});

// The records@1 document. Every field is required; `nullable` fields may be null.
const RECORDS = S.object({
  schema: S.constant(SCHEMA_ID),
  run: S.object({
    id: runId(),
    namespace,
    mode: S.oneOf(VOCAB.mode),
    slug: pattern(SLUG, 'a slug (a-z, 0-9, -)'),
    unit: id({ nullable: true }),
    base: runId({ nullable: true }),
    continues: runId({ nullable: true }),
    status: S.oneOf(VOCAB.runStatus),
    incomplete_reason: S.oneOf(VOCAB.incompleteReason, { nullable: true }),
    opened: timestamp(),
    closed: timestamp({ nullable: true }),
    profile: S.oneOf(VOCAB.profile),
    runtime: S.object({
      required_lead_model: S.oneOf(VOCAB.requiredLeadModel),
      lead_model: text({ max: 100, nullable: true }),
      lead_effort: S.oneOf(VOCAB.leadEffort, { nullable: true }),
      triggers: S.array(S.oneOf(VOCAB.trigger), { max: VOCAB.trigger.length }),
    }),
  }),
  scope: S.object({
    summary: text(),
    change: S.array(S.object({
      repo: repoPath({ allowDot: true }),
      range: pattern(REV_RANGE, 'a revision range <a>..<b>', { nullable: true }),
      working_tree: S.bool(),
    }), { max: 200 }),
    units: S.array(S.object({
      id: id(),
      title: required({ max: 200 }),
      tier: S.int({ min: 1, max: 3, nullable: true }),
      status: S.oneOf(VOCAB.unitStatus),
      depends_on: S.array(id(), { max: 100 }),
      runs: S.array(runId(), { max: 1000 }),
      reason: text({ nullable: true }),
      scope: required({ max: 1000 }), // the unit's boundary; required in plan runs (check)
      // Why the unit has its tier: anchors to what shows its priority, each with
      // a note. Required for active units in plan runs (check); never cited.
      basis: S.array(S.object({ anchor: anchor(), note: required({ max: 1000 }) }), { max: 20 }),
    }, { optional: ['scope', 'basis'] }), { max: 500 }),
    intent: S.array(S.object({
      id: pattern(INTENT_ID, 'an intent id (I<n>)'),
      anchor: anchor(),
      note: text(),
    }), { max: 500 }),
    // Flow runs only (check): the resolved entry points, written by new-run.
    entries: S.array(S.object({
      id: pattern(ENTRY_ID, 'an entry id (E1-E8)'),
      selector: anchor(),
      path: repoPath(),
      repo: repoPath({ allowDot: true }),
      symbol: text({ max: 200, nullable: true }),
      lines: S.array(S.int({ min: 1 }), { min: 2, max: 2 }),
      identity: S.object({
        blob: pattern(OBJECT_ID, 'a full object id', { nullable: true }),
        state: S.oneOf(VOCAB.footprintState),
        reason: S.oneOf(VOCAB.footprintReason, { nullable: true }),
      }),
    }), { min: 1, max: 8 }),
  }, { optional: ['entries'] }),
  budget: S.object({
    lead_tool_calls: S.int(),
    subagent_calls: S.int(),
    obligations_max: S.int(),
    reserve_pct: S.int({ max: 100 }),
    // Flow runs only (check): exploration limits, written by new-run.
    max_depth: S.int({ min: 1, max: 20 }),
    max_edges: S.int({ min: 1, max: 1000 }),
    spent: S.object({
      lead_tool_calls: S.int(),
      subagent_calls: S.int(),
      subagent_tokens: S.int(),
      lead_tokens_observed: S.int({ nullable: true }),
      wall_clock_min: S.number(),
    }),
  }, { optional: ['max_depth', 'max_edges'] }),
  snapshot: S.object({
    reconstructible: S.bool(),
    tracked_key: pattern(SHA256, 'a sha256 hex digest'),
    untracked_key: pattern(SHA256, 'a sha256 hex digest'),
    tracked_complete: S.bool(),
    discovery_complete: S.bool(),
    untracked_complete: S.bool(),
    limitations: S.array(S.object({
      code: S.oneOf(VOCAB.snapshotLimitation),
      path: repoPath({ allowDot: true }),
    }), { max: 100 }),
    repos: S.array(S.object({
      path: repoPath({ allowDot: true }),
      head: pattern(OBJECT_ID, 'a full object id', { nullable: true }),
      branch: text({ max: LIMITS.path, nullable: true }),
      unborn: S.bool(),
      is_worktree: S.bool(),
      is_submodule: S.bool(),
      porcelain_sha256: pattern(SHA256, 'a sha256 hex digest'),
      staged_sha256: pattern(SHA256, 'a sha256 hex digest'),
      unstaged_sha256: pattern(SHA256, 'a sha256 hex digest'),
      unverified: S.object({
        filter: S.int(), secret: S.int(), unreadable: S.int(),
        sha256: pattern(SHA256, 'a sha256 hex digest'),
      }),
      // Since tracked-key@3; absent in snapshots written before it.
      flagged: S.object({
        count: S.int(),
        sha256: pattern(SHA256, 'a sha256 hex digest'),
        hashed: S.int(),
        missing: S.int(),
        sparse: S.int(),
        skipped: S.object({ secret: S.int(), size: S.int(), budget: S.int(), link: S.int(), unreadable: S.int() }),
      }),
      untracked: S.object({
        count: S.int(),
        list_sha256: pattern(SHA256, 'a sha256 hex digest'),
        sample: S.array(repoPath(), { max: 50 }),
        content_sha256: pattern(SHA256, 'a sha256 hex digest'),
        hashed: S.int(),
        skipped: S.object({
          secret: S.int(), size: S.int(), budget: S.int(), repository: S.int(), link: S.int(), unreadable: S.int(),
        }),
      }),
    }, { optional: ['flagged'] }), { min: 1, max: 100 }),
  }),
  checks: S.array(S.object({
    command: required(),
    cwd: repoPath({ allowDot: true }),
    result: text(),
    proves: text(),
    not_proven: text(),
  }), { max: 100 }),
  census: S.object({
    recipes: S.array(S.object({
      id: pattern(RECIPE_ID, 'a recipe id (C<n>)'),
      pattern: text(),
      scope: text(),
      hits: S.int(),
      limits: text(),
    }), { max: 50 }),
    items: S.array(S.object({
      id: id(),
      path: repoPath({ allowDot: true, allowGlob: true }),
      mechanism: text({ max: 200 }),
      status: S.oneOf(VOCAB.censusStatus),
      reason: text({ nullable: true }),
      affects: S.array(id(), { max: 200, nullable: true }),
    })),
    // Flow runs only (check): the execution paths recorded from the entries.
    edges: S.array(S.object({
      id: pattern(EDGE_ID, 'an edge id (G<n>)'),
      from: pattern(EDGE_FROM, 'an entry or edge id (E<n> or G<n>)'),
      to: anchor({ nullable: true }),
      kind: S.oneOf(VOCAB.edgeKind),
      evidence: anchor(),
      status: S.oneOf(VOCAB.censusStatus),
      reason: text({ nullable: true }),
      affects: S.array(id(), { max: 200, nullable: true }),
    }), { max: 1000 }),
  }, { optional: ['edges'] }),
  obligations: S.array(S.object({
    id: id(),
    checks: S.array(pattern(CHECK_ID, 'a check id (FAMILY.n or MODULE)'), { min: 1, max: 20 }),
    claim: required(),
    scope: text(),
    acceptance: required(),
    coverage: S.oneOf(VOCAB.coverage),
    coverage_method: text(),
    status: S.oneOf(VOCAB.obligationStatus),
    open_reason: S.oneOf(VOCAB.openReason, { nullable: true }),
    source_trace: S.oneOf(VOCAB.sourceTrace),
    evidence: S.array(S.object({ anchor: anchor(), note: text() }), { max: 100 }),
    intent: S.array(pattern(INTENT_ID, 'an intent id (I<n>)'), { max: 50 }),
    assumptions: S.array(assumption, { max: 50 }),
    links: S.array(linkId(), { max: 100 }),
  }), { max: LIMITS.obligations }),
  findings: S.array(S.object({
    id: id(),
    fingerprint: pattern(FINGERPRINT, 'a fingerprint'),
    kind: S.oneOf(VOCAB.findingKind),
    verdict: S.oneOf(VOCAB.verdict),
    severity: S.oneOf(VOCAB.severity, { nullable: true }),
    impact_dimension: S.oneOf(VOCAB.impactDimension, { nullable: true }),
    obligation: id({ nullable: true }),
    summary: required(),
    trace: S.array(S.object({ role: S.oneOf(VOCAB.traceRole), anchor: anchor(), note: text() }), { max: 50 }),
    counterevidence: S.array(S.object({ anchor: anchor({ nullable: true }), note: required() }), { max: 50 }),
    validation_plan: text({ nullable: true }),
    verification: S.object({
      role: S.oneOf(VOCAB.verificationRole),
      model: S.oneOf(VOCAB.agentModel, { nullable: true }),
      outcome: S.oneOf(VOCAB.verificationOutcome, { nullable: true }),
      corrections: text({ nullable: true }),
      incomplete: S.bool(),
    }),
    decision: S.oneOf(VOCAB.decision),
  }), { max: 1000 }),
  debt: S.object({
    in: S.array(S.object({
      id: debtId(),
      from_run: runId(),
      disposition: S.oneOf(VOCAB.disposition, { nullable: true }),
      note: text({ nullable: true }),
    }), { max: 2000 }),
    out: S.array(S.object({
      id: debtId(),
      kind: S.oneOf(VOCAB.debtKind),
      refs: S.array(linkId(), { max: 100 }),
      requires: required(),
      priority: S.oneOf(VOCAB.priority),
    }), { max: 2000 }),
  }),
  delegations: S.array(S.object({
    role: S.oneOf(VOCAB.delegationRole),
    agent: S.oneOf(VOCAB.agent),
    model: S.oneOf(VOCAB.agentModel),
    effort: S.oneOf(VOCAB.delegationEffort, { nullable: true }),
    budget_calls: S.int(),
    tool_uses: S.int({ nullable: true }),
    tokens: S.int({ nullable: true }),
    completed: S.bool(),
    recovery_messages: S.int({ max: 5 }),
    // Paths the delegate's answer named that the census did not cover yet;
    // each needs a census disposition before close (check). Optional, so
    // older records stay valid.
    discovered: S.array(repoPath({ allowGlob: false }), { max: 200 }),
  }, { optional: ['discovered'] }), { max: 200 }),
  footprint: S.map(
    (key) => repoPathProblem(key),
    S.object({
      blob: pattern(OBJECT_ID, 'a full object id', { nullable: true }),
      state: S.oneOf(VOCAB.footprintState),
      reason: S.oneOf(VOCAB.footprintReason, { nullable: true }),
    }),
  ),
  freshness: S.object({
    base_run: runId(),
    repos: S.array(S.object({ path: repoPath({ allowDot: true }), outcome: S.oneOf(VOCAB.historyOutcome) }), { max: 100 }),
    changed_files: S.array(S.object({
      path: repoPath(),
      change: S.oneOf(VOCAB.changeType),
      from: repoPath({ nullable: true }),
    })),
    obligations: S.array(S.object({
      id: id(),
      class: S.oneOf(VOCAB.freshClass),
      reason: text(),
      origin: runId(), // the run that last recorded it, only when not base_run
    }, { optional: ['origin'] }), { max: LIMITS.obligations }),
  }, { nullable: true }),
});

// ---------------------------------------------------------------- engine

// Checks that `value` is an object with exactly `fields` (by key), where the
// `optional` keys may be missing. Reports missing and unknown keys; forbidden
// keys were already reported by the pre-pass and are not repeated.
function checkObjectShape(value, fields, where, ctx, optional = []) {
  if (kindOf(value) !== 'object') {
    ctx.errors.add(where, `must be an object, got ${kindOf(value)}`);
    return false;
  }
  let ok = true;
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(value, key) && !optional.includes(key)) {
      ctx.errors.add(child(where, key), 'is required');
      ok = false;
    }
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key) && !FORBIDDEN_KEYS.has(key)) {
      ctx.errors.add(child(where, key), 'is not a records@1 field');
      ok = false;
    }
  }
  return ok;
}

// Returns true when `value` matches `spec` (no errors added beneath).
function check(value, spec, where, ctx) {
  if (ctx.errors.full) return false;
  if (value === null && spec.nullable) return true;
  if (ctx.badStrings.has(where)) return false; // already reported by the pre-pass
  const before = ctx.errors.list.length;
  const fail = (message) => {
    ctx.errors.add(where, message);
    return false;
  };
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return fail(`must be a string, got ${kindOf(value)}`);
      const max = spec.max ?? LIMITS.string;
      if (value.length > max) return fail(`must be at most ${max} characters`);
      if ((spec.min ?? 0) > 0 && value.trim().length < spec.min) return fail('must not be empty');
      if (spec.pattern && !spec.pattern.test(value)) return fail(`must be ${spec.what}`);
      return true;
    }
    case 'int':
      if (!Number.isSafeInteger(value)) return fail(`must be an integer, got ${kindOf(value)}`);
      if (value < spec.min || value > spec.max) return fail(`must be between ${spec.min} and ${spec.max}`);
      return true;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`must be a number, got ${kindOf(value)}`);
      if (value < spec.min || value > spec.max) return fail(`must be between ${spec.min} and ${spec.max}`);
      return true;
    case 'bool':
      return typeof value === 'boolean' || fail(`must be true or false, got ${kindOf(value)}`);
    case 'enum':
      return spec.values.includes(value) || fail(`must be one of ${spec.values.join(', ')}`);
    case 'const':
      return value === spec.value || fail(`must be ${JSON.stringify(spec.value)}`);
    case 'custom': {
      const problem = spec.fn(value, where, ctx);
      if (problem) return fail(problem);
      return ctx.errors.list.length === before;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail(`must be an array, got ${kindOf(value)}`);
      if (value.length < spec.min) return fail(`must have at least ${spec.min} item(s)`);
      if (value.length > spec.max) return fail(`must have at most ${spec.max} items`);
      value.forEach((item, i) => check(item, spec.item, child(where, i), ctx));
      return ctx.errors.list.length === before;
    }
    case 'map': {
      if (kindOf(value) !== 'object') return fail(`must be an object, got ${kindOf(value)}`);
      const keys = Object.keys(value).filter((key) => !FORBIDDEN_KEYS.has(key));
      if (keys.length > spec.max) return fail(`must have at most ${spec.max} entries`);
      for (const key of keys) {
        const problem = spec.key(key);
        if (problem) ctx.errors.add(child(where, key), `key ${problem}`);
        else check(value[key], spec.value, child(where, key), ctx);
      }
      return ctx.errors.list.length === before;
    }
    case 'object': {
      if (!checkObjectShape(value, spec.fields, where, ctx, spec.optional ?? [])) {
        if (kindOf(value) !== 'object') return false;
      }
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        if (Object.hasOwn(value, key)) check(value[key], fieldSpec, child(where, key), ctx);
      }
      return ctx.errors.list.length === before;
    }
    default:
      throw new Error(`unknown spec type ${spec.type}`);
  }
}

// Limits, forbidden keys and string hygiene for the whole value, before the
// typed pass. Returns false when a hard limit stops validation.
function prePass(root, ctx) {
  let values = 0;
  const stack = [{ value: root, where: '$', depth: 1 }];
  while (stack.length) {
    const { value, where, depth } = stack.pop();
    values += 1;
    if (values > LIMITS.values) {
      ctx.errors.add('$', `more than ${LIMITS.values} values`);
      return false;
    }
    if (typeof value === 'string') {
      let problem = null;
      if (value.length > LIMITS.string) problem = `must be at most ${LIMITS.string} characters`;
      else if (!value.isWellFormed()) problem = 'must be well-formed Unicode (lone surrogate)';
      else if (CONTROL.test(value)) problem = 'must not contain control characters';
      if (problem) {
        ctx.errors.add(where, problem);
        ctx.badStrings.add(where);
      }
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    if (depth > LIMITS.depth) {
      ctx.errors.add(where, `nesting deeper than ${LIMITS.depth}`);
      return false;
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push({ value: value[i], where: child(where, i), depth: depth + 1 });
      continue;
    }
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const key = keys[i];
      const at = child(where, key);
      if (FORBIDDEN_KEYS.has(key)) {
        ctx.errors.add(at, 'is a forbidden key');
        continue;
      }
      if (key.length > LIMITS.key) {
        ctx.errors.add(where, `has a key longer than ${LIMITS.key} characters`);
        continue;
      }
      stack.push({ value: value[key], where: at, depth: depth + 1 });
    }
    if (ctx.errors.full) return false;
  }
  return true;
}

// A snapshot repository's `flagged` counts: all non-negative integers, and
// every flagged file accounted for exactly once.
const FLAGGED_SKIPS = ['secret', 'size', 'budget', 'link', 'unreadable'];
function flaggedNumbers(f) {
  const skipped = kindOf(f.skipped) === 'object' ? f.skipped : {};
  return [f.count, f.hashed, f.missing, f.sparse, ...FLAGGED_SKIPS.map((k) => skipped[k])].every((n) => Number.isSafeInteger(n) && n >= 0);
}
const flaggedConsistent = (f) => f.hashed + f.missing + f.sparse + FLAGGED_SKIPS.reduce((n, k) => n + f.skipped[k], 0) === f.count;

// Rules that depend on more than one field of the same record.
function crossFieldRules(doc, ctx) {
  const e = ctx.errors;
  const run = doc.run;
  const isObject = (v) => kindOf(v) === 'object';
  if (!isObject(run)) return;

  const parsed = typeof run.id === 'string' ? RUN_ID.exec(run.id) : null;
  if (parsed && VOCAB.mode.includes(run.mode) && parsed[3] !== run.mode) e.add('$.run.id', 'mode part must equal run.mode');
  if (parsed && typeof run.slug === 'string' && SLUG.test(run.slug) && parsed[4] !== run.slug) e.add('$.run.id', 'slug part must equal run.slug');

  // Open vs closed (C1): only a closed run has `closed`, a reason for not
  // being complete, and a disposition for every inherited debt item.
  // Each rule below fires only on values that passed their own field check,
  // so one defect yields one error.
  const status = VOCAB.runStatus.includes(run.status) ? run.status : null;
  const closedSet = typeof run.closed === 'string' && TIMESTAMP.test(run.closed);
  const reasonSet = VOCAB.incompleteReason.includes(run.incomplete_reason);
  if (status === 'open') {
    if (closedSet) e.add('$.run.closed', 'must be null while the run is open');
    if (reasonSet) e.add('$.run.incomplete_reason', 'must be null while the run is open');
  } else if (status) {
    if (run.closed === null) e.add('$.run.closed', `is required when the run is ${status}`);
    if (status === 'complete' && reasonSet) e.add('$.run.incomplete_reason', 'must be null when the run is complete');
    if (status !== 'complete' && run.incomplete_reason === null) e.add('$.run.incomplete_reason', `is required when the run is ${status}`);
  }

  const blank = (v) => v === null || (typeof v === 'string' && v.trim() === '');
  const debtIn = isObject(doc.debt) && Array.isArray(doc.debt.in) ? doc.debt.in : [];
  debtIn.forEach((item, i) => {
    if (!isObject(item)) return;
    const where = `$.debt.in[${i}]`;
    if (item.disposition === null && status && status !== 'open') e.add(`${where}.disposition`, `is required when the run is ${status}`);
    if ((item.disposition === 'discharged' || item.disposition === 'obsolete') && blank(item.note)) {
      e.add(`${where}.note`, `must explain why the item is ${item.disposition}`);
    }
  });

  (Array.isArray(doc.obligations) ? doc.obligations : []).forEach((o, i) => {
    if (!isObject(o) || !VOCAB.obligationStatus.includes(o.status)) return;
    if (o.status === 'open' && o.open_reason === null) e.add(`$.obligations[${i}].open_reason`, 'is required when the obligation is open');
    if (o.status !== 'open' && VOCAB.openReason.includes(o.open_reason)) e.add(`$.obligations[${i}].open_reason`, 'must be null unless the obligation is open');
  });

  const needsReason = (where, status, reason, statuses) => {
    if (statuses.includes(status) && blank(reason)) e.add(`${where}.reason`, `is required when status is ${status}`);
  };
  if (isObject(doc.scope) && Array.isArray(doc.scope.units)) {
    doc.scope.units.forEach((u, i) => isObject(u) && needsReason(`$.scope.units[${i}]`, u.status, u.reason, ['deferred', 'out_of_scope', 'incomplete']));
  }
  if (isObject(doc.census) && Array.isArray(doc.census.items)) {
    doc.census.items.forEach((c, i) => isObject(c) && needsReason(`$.census.items[${i}]`, c.status, c.reason, ['unknown', 'excluded']));
  }

  if (isObject(doc.snapshot) && Array.isArray(doc.snapshot.repos)) {
    doc.snapshot.repos.forEach((r, i) => {
      if (isObject(r) && typeof r.unborn === 'boolean' && (r.head === null) !== r.unborn) {
        e.add(`$.snapshot.repos[${i}].head`, 'must be null exactly when the repository is unborn');
      }
      if (isObject(r) && isObject(r.flagged) && flaggedNumbers(r.flagged) && !flaggedConsistent(r.flagged)) {
        e.add(`$.snapshot.repos[${i}].flagged`, 'hashed, missing, sparse and all skipped counts must equal count');
      }
      const u = isObject(r) ? r.untracked : null;
      const counts = isObject(u) && isObject(u.skipped) ? [u.count, u.hashed, ...Object.values(u.skipped)] : [];
      if (counts.length === 8 && counts.every(Number.isSafeInteger)) {
        const [count, hashed, ...skipped] = counts;
        if (hashed + skipped.reduce((a, b) => a + b, 0) !== count) {
          e.add(`$.snapshot.repos[${i}].untracked`, 'hashed plus all skipped counts must equal count');
        }
        if (Array.isArray(u.sample) && u.sample.length > count) {
          e.add(`$.snapshot.repos[${i}].untracked.sample`, 'must not hold more paths than count');
        }
      }
    });

    // Coverage flags can never claim more than the repositories and
    // limitations show: partial hashing or discovery is never "complete".
    const snap = doc.snapshot;
    const repos = snap.repos.filter(isObject);
    const untracked = repos.map((r) => r.untracked).filter(isObject);
    // Only judged when every repository's own counts are consistent, so one
    // defect yields one error.
    const consistent = (u) => {
      const skipped = isObject(u.skipped) ? Object.values(u.skipped) : [];
      const numbers = [u.count, u.hashed, ...skipped];
      return skipped.length === 6 && numbers.every((n) => Number.isSafeInteger(n) && n >= 0)
        && u.hashed + skipped.reduce((a, b) => a + b, 0) === u.count;
    };
    const countsKnown = untracked.length > 0 && untracked.length === snap.repos.length && untracked.every(consistent);
    if (typeof snap.untracked_complete === 'boolean' && countsKnown
      && snap.untracked_complete !== untracked.every((u) => u.hashed === u.count)) {
      e.add('$.snapshot.untracked_complete', 'must be true exactly when every untracked file was hashed');
    }
    const codes = Array.isArray(snap.limitations) ? snap.limitations.map((l) => l?.code) : [];
    if (snap.discovery_complete === true && codes.some((c) => INCOMPLETE_DISCOVERY.includes(c))) {
      e.add('$.snapshot.discovery_complete', `must be false when a limitation is ${INCOMPLETE_DISCOVERY.join(', ')}`);
    }
    const unverified = repos.map((r) => r.unverified).filter(isObject);
    const unverifiedKnown = unverified.length > 0 && unverified.length === snap.repos.length
      && unverified.every((u) => [u.filter, u.secret, u.unreadable].every((n) => Number.isSafeInteger(n) && n >= 0));
    // Flagged files (assume-unchanged, skip-worktree; since tracked-key@3) are
    // judged only where recorded and consistent; older snapshots have none.
    const flaggedKnown = repos.every((r) => !Object.hasOwn(r, 'flagged') || (isObject(r.flagged) && flaggedNumbers(r.flagged) && flaggedConsistent(r.flagged)));
    const flaggedSkipped = (r) => (isObject(r.flagged) ? Object.values(r.flagged.skipped).reduce((a, b) => a + b, 0) : 0);
    const trackedVerified = unverifiedKnown && unverified.every((u) => u.filter + u.secret + u.unreadable === 0)
      && repos.every((r) => flaggedSkipped(r) === 0);
    if (typeof snap.tracked_complete === 'boolean' && unverifiedKnown && flaggedKnown && snap.tracked_complete !== trackedVerified) {
      e.add('$.snapshot.tracked_complete', 'must be true exactly when no tracked entry or flagged file is unverified');
    }
    if (snap.reconstructible === true && countsKnown && unverifiedKnown && flaggedKnown && (
      snap.discovery_complete === false
      || !trackedVerified
      || repos.some((r) => r.porcelain_sha256 !== EMPTY_SHA256)
      || repos.some((r) => isObject(r.flagged) && r.flagged.hashed + r.flagged.missing + flaggedSkipped(r) > 0)
      || untracked.some((u) => u.count !== 0))) {
      e.add('$.snapshot.reconstructible', 'requires complete discovery, verified clean repositories, no flagged file in the working tree and no untracked files');
    }
  }
  if (isObject(doc.footprint)) {
    for (const [key, entry] of Object.entries(doc.footprint)) {
      const blobOk = entry?.blob === null || (typeof entry?.blob === 'string' && OBJECT_ID.test(entry.blob));
      const stateOk = isObject(entry) && VOCAB.footprintState.includes(entry.state);
      const noIdentity = entry?.state === 'absent' || entry?.state === 'unverified';
      if (stateOk && blobOk && (entry.blob === null) !== noIdentity) {
        e.add(`${child('$.footprint', key)}.blob`, 'must be null exactly when the state is absent or unverified');
      }
      const reasonOk = entry?.reason === null || VOCAB.footprintReason.includes(entry?.reason);
      if (stateOk && reasonOk && (entry.reason === null) !== (entry.state !== 'unverified')) {
        e.add(`${child('$.footprint', key)}.reason`, 'is set exactly when the state is unverified');
      }
    }
  }
  if (isObject(doc.freshness) && Array.isArray(doc.freshness.changed_files)) {
    doc.freshness.changed_files.forEach((f, i) => {
      const fromOk = f?.from === null || repoPathProblem(f?.from) === null;
      if (isObject(f) && fromOk && VOCAB.changeType.includes(f.change) && (f.from !== null) !== (f.change === 'renamed')) {
        e.add(`$.freshness.changed_files[${i}].from`, 'must be set exactly when the change is renamed');
      }
    });
  }
}

// Validates a parsed records.json value. Returns at most LIMITS.errors
// messages ("<path>: <problem>"); an empty array means structurally valid.
export function validateStructure(value) {
  const ctx = { errors: new Errors(LIMITS.errors), badStrings: new Set() };
  if (!prePass(value, ctx)) return ctx.errors.list;
  check(value, RECORDS, '$', ctx);
  if (!ctx.errors.full && kindOf(value) === 'object') crossFieldRules(value, ctx);
  return ctx.errors.list;
}

// ---------------------------------------------------------------- side files

// `.nth-review/<ns>/decisions.json` (M2-T6, decision C2): owner decisions per
// finding fingerprint, append-only. `pending` is the value a finding has at
// close when nobody decided; it is never recorded as a decision.
export const DECISIONS_SCHEMA_ID = 'nth-review/decisions@1';
export const OWNER_DECISIONS = Object.freeze(VOCAB.decision.filter((d) => d !== 'pending'));
export const DECISION_LIMITS = Object.freeze({ entries: 10_000, seenIn: 1000, by: 128 });
const oneLine = (max) => S.custom((v) => (typeof v !== 'string' || v.trim() === '' || v.length > max || /[\t\r\n]/.test(v)
  ? `must be one non-empty line of at most ${max} characters`
  : null));
const DECISIONS = S.object({
  schema: S.constant(DECISIONS_SCHEMA_ID),
  namespace,
  decisions: S.array(S.object({
    seq: S.int({ min: 1 }),
    fingerprint: pattern(FINGERPRINT, 'a fingerprint'),
    decision: S.oneOf(OWNER_DECISIONS),
    note: required(),
    by: oneLine(DECISION_LIMITS.by),
    date: timestamp(),
    supersedes: S.int({ min: 1, nullable: true }),
    seen_in: S.array(S.object({ run: runId(), finding: id() }), { min: 1, max: DECISION_LIMITS.seenIn }),
  }), { max: DECISION_LIMITS.entries }),
});

// Validates a parsed decisions.json value: its shape, then the append-only
// chain (seq in order; supersedes names the previous entry for the same
// fingerprint; seen_in sorted and unique).
export function validateDecisions(value) {
  const ctx = { errors: new Errors(LIMITS.errors), badStrings: new Set() };
  if (!prePass(value, ctx)) return ctx.errors.list;
  check(value, DECISIONS, '$', ctx);
  if (ctx.errors.list.length) return ctx.errors.list;
  const latest = new Map();
  value.decisions.forEach((d, i) => {
    const where = `$.decisions[${i}]`;
    if (d.seq !== i + 1) ctx.errors.add(`${where}.seq`, `must be ${i + 1}: entries are append-only and numbered in order`);
    const previous = latest.get(d.fingerprint) ?? null;
    if (d.supersedes !== previous) ctx.errors.add(`${where}.supersedes`, `must be ${previous}: the previous entry for this fingerprint`);
    latest.set(d.fingerprint, d.seq);
    const keys = d.seen_in.map((s) => `${s.run}\u0000${s.finding}`);
    if (keys.some((k, j) => j > 0 && keys[j - 1] >= k)) ctx.errors.add(`${where}.seen_in`, 'must be sorted by run, then finding, without duplicates');
  });
  return ctx.errors.list;
}

// `.nth-review/audits/<id>/charter.json` (M2-T7, decisions N3, C19): written
// only by `charter`, never replaced.
export const CHARTER_SCHEMA_ID = 'nth-review/charter@1';
export const CHARTER_PROFILES = Object.freeze(['quick', 'standard', 'deep']);
const CHARTER = S.object({
  schema: S.constant(CHARTER_SCHEMA_ID),
  official: S.constant(true),
  namespace,
  owner: oneLine(DECISION_LIMITS.by),
  scope: required(),
  exclusions: required(),
  profile: S.oneOf(CHARTER_PROFILES),
  budget_sessions: S.int({ min: 1, max: 9999, nullable: true }),
  created: timestamp(),
});
export function validateCharter(value) {
  const ctx = { errors: new Errors(LIMITS.errors), badStrings: new Set() };
  if (!prePass(value, ctx)) return ctx.errors.list;
  check(value, CHARTER, '$', ctx);
  if (!ctx.errors.list.length && !value.namespace.startsWith('audits/')) ctx.errors.add('$.namespace', 'a charter is only for an audits/<id> namespace');
  return ctx.errors.list;
}

// Nesting depth of JSON text, counted outside strings, so a hostile document
// is refused before JSON.parse builds it.
function jsonDepthExceeds(textValue, limit) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < textValue.length; i += 1) {
    const c = textValue.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > limit) return true;
    } else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  return false;
}

// Decodes and parses records.json bytes (or text). Returns { value, errors };
// `value` is undefined when errors is non-empty.
export function parseRecords(input) {
  const fail = (message) => ({ value: undefined, errors: [`$: ${message}`] });
  let bytes;
  if (Buffer.isBuffer(input)) bytes = input;
  else if (typeof input === 'string') bytes = Buffer.from(input, 'utf8');
  else return fail('input must be bytes or text');
  if (bytes.length > LIMITS.bytes) return fail(`is ${bytes.length} bytes; at most ${LIMITS.bytes} allowed`);
  if (bytes.length === 0) return fail('is empty');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return fail('starts with a UTF-8 byte-order mark; save it as UTF-8 without BOM');
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return fail('is UTF-16; records must be UTF-8');
  let textValue;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('is not valid UTF-8');
  }
  if (jsonDepthExceeds(textValue, LIMITS.depth)) return fail(`nesting deeper than ${LIMITS.depth}`);
  try {
    return { value: JSON.parse(textValue), errors: [] };
  } catch (error) {
    return fail(`is not valid JSON (${error.message})`);
  }
}

// Bytes or text in, structural errors out.
export function validateRecords(input) {
  const { value, errors } = parseRecords(input);
  return errors.length ? errors : validateStructure(value);
}
