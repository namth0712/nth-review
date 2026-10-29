// Runs: lookups shared by the commands, and `new-run` (protocol-v0.1 §2
// step 1; decisions C4, C5, C14, C15, C19, C20). new-run validates
// everything, takes the snapshot, then creates the run directory exclusively
// and writes the records@1 skeleton, so a refusal leaves nothing behind.
import fs from 'node:fs';
import path from 'node:path';
import { byteCompare } from './discover.mjs';
import { REVIEW_DIR, RUN_ID, RUN_MODES, mkdirExclusive, parseNamespace, parseRunId, resolveReviewPath, runDir, writeAtomic } from './fsguard.mjs';
import { git } from './git.mjs';
import { entryAnchor, resolveEntries } from './flow.mjs';
import { LIMITS, SCHEMA_ID, parseRecords, validateCharter, validateStructure } from './schema.mjs';
import { flaggedInWorkingTree, takeSnapshot } from './snapshot.mjs';

export class RunError extends Error {
  // `problems`: several refusal reasons at once (entry resolution).
  constructor(message, problems = null) {
    super(message);
    this.name = 'RunError';
    this.refusal = true; // cli.mjs maps refusals to exit 2
    this.problems = problems;
  }
}

export const AUDIT_MODES = Object.freeze(['audit-plan', 'audit-unit']);
// Which modes each namespace kind admits (protocol-v0.1 §1).
export const MODES_BY_KIND = Object.freeze({
  experiment: RUN_MODES,
  review: Object.freeze(['task', 'incremental', 'flow']),
  audit: AUDIT_MODES,
});
// Statuses a run must have to be named as base or continues.
export const BASE_STATUSES = Object.freeze(['complete', 'incomplete']);
export const CONTINUES_STATUSES = Object.freeze(['complete', 'incomplete', 'abandoned']);

// Initial budgets (protocol-v0.1 §3; calibrated later by V-COST).
export const TASK_SIZES = Object.freeze([
  { size: 'S', lines: 400, files: 15, lead_tool_calls: 40, subagent_calls: 3, obligations_max: 15 },
  { size: 'M', lines: 1500, files: 40, lead_tool_calls: 70, subagent_calls: 5, obligations_max: 30 },
]);
export const RESERVE_PCT = 30;
const MAX_CHARTER_BYTES = 64 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- lookups

// The run ids under .nth-review/<ns>/runs/, sorted, and any other entries.
export function listRuns(root, ns) {
  const dir = resolveReviewPath(root, `${ns}/runs`, { expectDirectory: true, minDepth: 3 });
  if (!fs.existsSync(dir)) return { ids: [], strays: [] };
  const ids = [];
  const strays = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && RUN_ID.test(entry.name)) ids.push(entry.name);
    else strays.push(entry.name);
  }
  return { ids: ids.sort(byteCompare), strays: strays.sort(byteCompare) };
}

// Reads and structurally validates one run's records.json without following
// links. Returns { doc, errors }; doc is undefined when it cannot be parsed.
export function readRun(root, ns, id) {
  const file = resolveReviewPath(root, `${runDir(ns, id)}/records.json`, { minDepth: 3 });
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch {
    return { doc: undefined, errors: ['$: records.json is missing'] };
  }
  if (stats.size > LIMITS.bytes) return { doc: undefined, errors: [`$: is ${stats.size} bytes; at most ${LIMITS.bytes} allowed`] };
  const { value, errors } = parseRecords(fs.readFileSync(file));
  if (errors.length) return { doc: undefined, errors };
  return { doc: value, errors: validateStructure(value) };
}

// The charter of an audit namespace (rule N3), or null when there is none.
export function readCharter(root, ns) {
  const file = resolveReviewPath(root, `${ns}/charter.json`, { minDepth: 3 });
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (stats.size > MAX_CHARTER_BYTES) return { valid: false, problem: 'charter.json is too large' };
  const { value, errors } = parseRecords(fs.readFileSync(file));
  if (errors.length || !isObject(value)) return { valid: false, problem: 'charter.json is not a JSON object' };
  if (value.official !== true) return { valid: false, problem: 'charter.json does not say "official": true' };
  // The owner's authorization is the whole charter: owner, scope, exclusions,
  // for this namespace. A partial or hand-made file is not authorization.
  const problems = validateCharter(value);
  if (problems.length) return { valid: false, problem: `charter.json is not a complete owner charter (${problems[0]})` };
  if (value.namespace !== ns) return { valid: false, problem: `charter.json names ${value.namespace}, not ${ns}` };
  return { valid: true, charter: value };
}

// Rule N3 and decision C19: official audits need the release switch and a
// charter written by the owner's explicit `charter` command.
export function auditAuthorization(root, ns, officialAuditsEnabled) {
  if (!officialAuditsEnabled) {
    return 'official audits are disabled: OFFICIAL_AUDITS_ENABLED is false until the release criteria pass';
  }
  const charter = readCharter(root, ns);
  if (!charter) return `${ns} has no charter.json; an official audit needs the owner's explicit charter command`;
  if (!charter.valid) return `${ns}: ${charter.problem}`;
  return null;
}

// ---------------------------------------------------------------- change size

function gitOk(dir, args, gitOptions, what) {
  const result = git(dir, args, gitOptions);
  if (result.status !== 0) throw new RunError(`${what}: ${result.stderr.toString('utf8').trim() || `git ${args[0]} failed`}`);
  return result.stdout;
}

// `git diff --numstat` as a map path → changed lines (binary files count 0).
function numstat(dir, revisions, gitOptions, { cached = false } = {}) {
  // `--` keeps a file named like a revision (HEAD) from making it ambiguous.
  // `--ignore-submodules=dirty`: never run git (and its filters) inside a submodule.
  const args = ['diff', '--numstat', '-z', '--no-renames', '--ignore-submodules=dirty', ...(cached ? ['--cached'] : []), ...revisions, '--'];
  const out = gitOk(dir, args, gitOptions, 'cannot size the change');
  const lines = new Map();
  for (const record of out.toString('utf8').split('\0')) {
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first === -1 || second === -1) continue;
    const added = Number.parseInt(record.slice(0, first), 10) || 0;
    const deleted = Number.parseInt(record.slice(first + 1, second), 10) || 0;
    const file = record.slice(second + 1);
    if (file.split('/')[0].toLowerCase() === REVIEW_DIR) continue; // never part of a change, as in the snapshot
    lines.set(file, (lines.get(file) ?? 0) + added + deleted);
  }
  return lines;
}

function resolveCommit(dir, revision, gitOptions) {
  const result = git(dir, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], gitOptions);
  return result.status === 0 ? result.stdout.toString('utf8').trim() : null;
}

const REVISION = /^[^\s:\\.-][^\s:\\]{0,99}$/;

// `--change <repo>` (its working tree against HEAD, staged and unstaged, plus
// its untracked files) or `--change <repo>:<a>..<b>` (a committed range).
function parseChange(spec, repos) {
  const colon = spec.indexOf(':');
  const repo = colon === -1 ? spec : spec.slice(0, colon);
  const range = colon === -1 ? null : spec.slice(colon + 1);
  if (!repos.has(repo)) {
    throw new RunError(`--change ${spec}: unknown repository ${JSON.stringify(repo)}; repositories: ${[...repos.keys()].join(', ')}`);
  }
  if (range === null) return { repo, range: null, revisions: null };
  const parts = range.split('..');
  if (parts.length !== 2 || parts.some((p) => !REVISION.test(p) || p.endsWith('.'))) {
    throw new RunError(`--change ${spec}: the range must be <a>..<b>`);
  }
  return { repo, range, revisions: parts };
}

// Files and lines of the declared change, per decision C14.
function sizeChanges(specs, snapshot, root, gitOptions) {
  const repos = new Map(snapshot.repos.map((r) => [r.path, r]));
  const files = new Map(); // repo → Set(path)
  let lines = 0;
  let verified = true;
  const change = [];
  const seen = new Set();
  for (const spec of specs) {
    const parsed = parseChange(spec, repos);
    const key = `${parsed.repo}\0${parsed.range}`;
    if (seen.has(key)) throw new RunError(`--change ${spec} is given twice`);
    seen.add(key);
    const repo = repos.get(parsed.repo);
    const dir = repoDirectory(root, parsed.repo);
    let counted;
    if (parsed.revisions) {
      const [a, b] = parsed.revisions.map((rev) => {
        const oid = resolveCommit(dir, rev, gitOptions);
        if (!oid) throw new RunError(`--change ${spec}: ${rev} is not a commit in ${parsed.repo}`);
        return oid;
      });
      counted = numstat(dir, [a, b], gitOptions);
    } else if (repo.unborn) {
      // No HEAD yet: staged plus unstaged lines, added per file.
      counted = numstat(dir, [], gitOptions, { cached: true });
      for (const [file, n] of numstat(dir, [], gitOptions)) counted.set(file, (counted.get(file) ?? 0) + n);
    } else {
      counted = numstat(dir, ['HEAD'], gitOptions);
    }
    const set = files.get(parsed.repo) ?? new Set();
    for (const [file, n] of counted) {
      set.add(file);
      lines += n;
    }
    let untracked = 0;
    if (!parsed.revisions) {
      untracked = repo.untracked.count; // counted as files; their lines are not read
      // Filtered files compared without their filter, flagged files whose
      // edits git's diff cannot see, and untracked files whose lines are not
      // counted: the size is uncertain, never small.
      if (repo.unverified.filter > 0 || flaggedInWorkingTree(repo) || untracked > 0) verified = false;
    }
    files.set(parsed.repo, set);
    change.push({ repo: parsed.repo, range: parsed.range, working_tree: !parsed.revisions, untracked });
  }
  const total = [...files.values()].reduce((n, set) => n + set.size, 0) + change.reduce((n, c) => n + c.untracked, 0);
  return {
    change: change.map(({ repo, range, working_tree }) => ({ repo, range, working_tree })),
    files: total,
    lines,
    verified,
  };
}

// For an Incremental run without --change: every repository's working tree
// against its commit in the base snapshot. Unknown when that commit is gone
// or the repository is new.
function sizeSinceBase(baseSnapshot, snapshot, root, gitOptions) {
  const before = new Map(baseSnapshot.repos.map((r) => [r.path, r]));
  const change = [];
  let files = 0;
  let lines = 0;
  let known = true;
  let verified = true;
  for (const repo of snapshot.repos) {
    const dir = repoDirectory(root, repo.path);
    const baseHead = before.get(repo.path)?.head ?? null;
    const present = baseHead !== null && git(dir, ['cat-file', '-e', `${baseHead}^{commit}`], gitOptions).status === 0;
    if (!present || repo.unborn) {
      known = false;
      change.push({ repo: repo.path, range: null, working_tree: true });
      continue;
    }
    const counted = numstat(dir, [baseHead], gitOptions);
    files += counted.size + repo.untracked.count;
    for (const n of counted.values()) lines += n;
    if (repo.unverified.filter > 0 || flaggedInWorkingTree(repo)) verified = false;
    change.push({ repo: repo.path, range: baseHead === repo.head ? null : `${baseHead}..${repo.head}`, working_tree: true });
  }
  return { change, files: known ? files : null, lines: known ? lines : null, verified: known && verified };
}

function repoDirectory(root, repoPath) {
  return repoPath === '.' ? root : path.join(root, ...repoPath.split('/'));
}

// ---------------------------------------------------------------- budget and model

// Budget, required lead model and size-derived triggers (C14, C15;
// model-routing.md §2). Incremental runs require Opus High at Open: the
// Sonnet case depends on `fresh` results that do not exist yet.
// An unverified size (filtered files compared without their filter, or
// assume-unchanged/skip-worktree files whose edits diff cannot see) is
// treated as large: the M budget and Opus High for a task, the cap for an
// Incremental run. An uncertain size is never small.
export function initialBudget(mode, { files, lines, verified = true, debtIn = 0, baseObligations = 0, entries = 0, repos = 0 }) {
  const budget = (lead, sub, obligations) => ({
    lead_tool_calls: lead,
    subagent_calls: sub,
    obligations_max: obligations,
    reserve_pct: RESERVE_PCT,
    spent: { lead_tool_calls: 0, subagent_calls: 0, subagent_tokens: 0, lead_tokens_observed: null, wall_clock_min: 0 },
  });
  if (mode === 'task') {
    const row = verified ? TASK_SIZES.find((r) => lines <= r.lines && files <= r.files) : undefined;
    // beyond M, or unverified: the M budget; the work continues in later runs
    const size = row ? row.size : verified ? 'L' : 'unverified';
    const use = row ?? TASK_SIZES[TASK_SIZES.length - 1];
    return {
      size,
      budget: budget(use.lead_tool_calls, use.subagent_calls, use.obligations_max),
      required_lead_model: size === 'S' ? 'sonnet' : 'opus-high',
      triggers: size === 'S' ? [] : ['task-size'],
    };
  }
  if (mode === 'incremental') {
    const lead = files === null || !verified ? 80 : Math.min(80, 20 + 2 * files + 3 * debtIn);
    return { size: null, budget: budget(lead, 3, baseObligations + 15), required_lead_model: 'opus-high', triggers: [] };
  }
  if (mode === 'flow') return flowPlan(entries, repos);
  if (mode === 'audit-plan') return { size: null, budget: budget(50, 2, 0), required_lead_model: 'opus-high', triggers: [] };
  return { size: null, budget: budget(60, 4, 25), required_lead_model: 'opus-high', triggers: [] };
}

// Flow Review (BETA): the budget comes from the selected entries, never from
// a change size (there is none). Always Opus High: a small entry can reach
// money, authorization or persistence code. The exploration limits are the
// recorded graph's: at most `max_edges` edges, `max_depth` hops from an entry.
export const FLOW_LIMITS = Object.freeze({ maxDepth: 4, leadCap: 90, obligationsCap: 40, edgesCap: 120 });
export function flowPlan(entries, repos) {
  const extra = Math.max(0, entries - 1);
  const budget = {
    lead_tool_calls: Math.min(FLOW_LIMITS.leadCap, 60 + 10 * extra),
    subagent_calls: 5,
    obligations_max: Math.min(FLOW_LIMITS.obligationsCap, 20 + 5 * extra),
    reserve_pct: RESERVE_PCT,
    max_depth: FLOW_LIMITS.maxDepth,
    max_edges: Math.min(FLOW_LIMITS.edgesCap, 40 + 20 * extra + 20 * Math.max(0, repos - 1)),
    spent: { lead_tool_calls: 0, subagent_calls: 0, subagent_tokens: 0, lead_tokens_observed: null, wall_clock_min: 0 },
  };
  return { size: null, budget, required_lead_model: 'opus-high', triggers: [] };
}
// The plan a flow run's entries give: what check recomputes.
export const flowPlanOf = (entries) => flowPlan(entries.length, new Set(entries.map((e) => e.repo)).size);

// A flow continuation carries on only the abandoned flow run (resume).
export function flowContinuesProblem(continued) {
  if (continued.status === 'abandoned' && continued.mode === 'flow') return null;
  return `a flow run continues only an abandoned flow run (resume opens it), not ${continued.id}`;
}

// ---------------------------------------------------------------- new-run

// `read(id)` returns { doc, errors } for a run of `ns` (default: from disk).
export function requireRun(root, ns, id, ids, role, statuses, read = (runId) => readRun(root, ns, runId)) {
  try {
    parseRunId(id);
  } catch {
    throw new RunError(`--${role} must be a run id in ${ns} (YYYYMMDD-HHMMSS-<mode>-<slug>), not a path: ${JSON.stringify(id)}`);
  }
  if (!ids.includes(id)) {
    throw new RunError(`--${role} ${id} is not a run in ${ns}; a ${role} must be in the same namespace, and the legacy top-level runs/ is never one`);
  }
  const { doc, errors } = read(id);
  if (errors.length) throw new RunError(`--${role} ${id} fails validation: ${errors[0]}`);
  if (doc.run.namespace !== ns || doc.run.id !== id) {
    throw new RunError(`--${role} ${id}: its records name ${doc.run.namespace}/${doc.run.id}`);
  }
  if (!statuses.includes(doc.run.status)) {
    throw new RunError(`--${role} ${id} is ${doc.run.status}; it must be ${statuses.join(' or ')}`);
  }
  return doc;
}

// ---------------------------------------------------------------- Full Audit (C20)

// The audit close (protocol §10): an audit-unit run with this reserved unit
// id, never a ledger entry.
export const RESERVED_UNIT = 'close';
export const isAuditClose = (run) => run.mode === 'audit-unit' && run.unit === RESERVED_UNIT;

// C20: audit runs form one linear chain. Among the namespace's closed audit
// runs (complete or incomplete) other than run `id`, there is one root (no
// base), and no two name the same base. Returns a refusal message, or null.
export function auditChainProblem(docs, { id, base }) {
  const closed = docs.filter((d) => d.run.id !== id && AUDIT_MODES.includes(d.run.mode) && BASE_STATUSES.includes(d.run.status));
  const head = closed.find((d) => !closed.some((other) => other.run.base === d.run.id))?.run.id ?? null;
  if (base === null) return closed.length ? `the audit chain already has its root plan; every later audit run builds on its head ${head} (C20)` : null;
  const sibling = closed.find((d) => d.run.base === base);
  return sibling ? `${sibling.run.id} already builds on ${base}; the audit chain is linear: build on its head ${head} (C20)` : null;
}

// In the audit chain, `continues` names only the abandoned run this run
// carries on (resume): same mode, base and unit. Any other parent would make
// debt-in skip the chain head, and so drop its debt (C4). Returns a refusal
// message, or null.
export function auditContinuesProblem(continued, { mode, base, unit }) {
  if (continued.status === 'abandoned' && continued.mode === mode && continued.base === base && continued.unit === unit) return null;
  return `in an audit chain, --continues names only the abandoned run this run carries on (same mode, base and unit; resume opens it), not ${continued.id}`;
}

// A unit is classified when it has a tier and a reviewable basis for it:
// anchors, each with a note on what it shows. The helper checks presence and
// form only; it never judges the tier, and never infers risk from names.
export const unitClassified = (u) => u.tier !== null && Array.isArray(u.basis) && u.basis.length > 0 && u.basis.every((b) => b.note.trim() !== '');

// A unit runs only while it is planned or incomplete, once every unit it
// depends on is complete. The audit close has no ledger entry. Returns a
// refusal message, or null.
export function unitProblem(ledger, unitId) {
  if (unitId === RESERVED_UNIT) return null;
  const entry = ledger.find((u) => u.id === unitId);
  if (!entry) return `unit ${unitId} is not in the units ledger`;
  if (!['planned', 'incomplete'].includes(entry.status)) return `unit ${unitId} is ${entry.status}; only a planned or incomplete unit runs (a plan run may reopen it)`;
  if (!unitClassified(entry)) return `unit ${unitId} has no tier or no tier basis; classify it in a re-plan first`;
  const waiting = entry.depends_on.filter((dep) => ledger.find((u) => u.id === dep)?.status !== 'complete');
  return waiting.length ? `unit ${unitId} depends on ${waiting.join(', ')}, not complete yet; run ${waiting.length === 1 ? 'it' : 'them'} first` : null;
}

// The longest base ancestry an Incremental run resolves.
export const MAX_BASE_CHAIN = 100;

// The effective baseline of an Incremental run whose base is `baseId` (C11):
// the latest recorded version of every obligation inherited through the base
// ancestry, so an obligation left `current` (not recorded again) in one run is
// still reviewed by every later one. Inheritance follows `run.base` only while
// the run is incremental (a task run is a full baseline); `continues` and
// abandoned runs are never followed. The nearest run recording an id is that
// obligation's origin. Every hop is validated like a base: same namespace,
// valid records, complete or incomplete. Returns { base, entries: [{ id,
// origin, obligation, doc }] } in resolution order; throws RunError.
export function effectiveBaseline(root, ns, baseId, ids, read = (runId) => readRun(root, ns, runId)) {
  const entries = [];
  const seen = new Set();
  const visited = new Set();
  let base = null;
  for (let runId = baseId; runId !== null;) {
    if (visited.has(runId)) throw new RunError(`the base ancestry of ${baseId} loops at ${runId}`);
    if (visited.size >= MAX_BASE_CHAIN) throw new RunError(`the base ancestry of ${baseId} is longer than ${MAX_BASE_CHAIN} runs; start a new baseline with a task run`);
    visited.add(runId);
    let doc;
    try {
      doc = requireRun(root, ns, runId, ids, 'base', BASE_STATUSES, read);
    } catch (error) {
      if (runId === baseId || !(error instanceof RunError)) throw error;
      throw new RunError(`ancestor ${runId} of base ${baseId}: ${error.message}`);
    }
    if (AUDIT_MODES.includes(doc.run.mode)) throw new RunError(`${runId} is a ${doc.run.mode} run; an incremental run cannot build on it`);
    base ??= doc;
    for (const obligation of doc.obligations) {
      if (seen.has(obligation.id)) continue;
      seen.add(obligation.id);
      entries.push({ id: obligation.id, origin: runId, obligation, doc });
    }
    if (entries.length > LIMITS.obligations) {
      throw new RunError(`the effective baseline of ${baseId} has more than ${LIMITS.obligations} obligations; start a new baseline with a task run`);
    }
    runId = doc.run.mode === 'incremental' ? doc.run.base : null;
  }
  return { base, entries };
}

// Opens a run. `options`: { ns, mode, slug, base, continues, change[], unit }.
// Returns the command result; throws RunError (or FsGuardError) on refusal.
export function newRun(root, options, settings = {}) {
  return createRun(root, prepareRun(root, options, settings), { io: settings.io });
}

// Writes a prepared run: its directory, created exclusively, then its
// records.json (atomically; `io.rename` for tests). Returns the result.
export function createRun(root, { records, result }, { io = {} } = {}) {
  const rel = runDir(records.run.namespace, records.run.id);
  const dir = mkdirExclusive(root, rel); // a run-id collision is refused here too
  try {
    writeAtomic(root, `${rel}/records.json`, `${JSON.stringify(records, null, 2)}\n`, { rename: io.rename });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true }); // only what this call created
    throw error;
  }
  return result;
}

// Builds a new run's records in memory, refusing whatever `new-run` refuses,
// and writes nothing: { records, result }. `pending` (resume) is a run's
// records as they are about to be written, used in place of that run's
// records on disk.
export function prepareRun(root, options, { officialAuditsEnabled = false, now = new Date(), snapshot: snapshotOptions = {}, gitOptions, pending = null } = {}) {
  const { ns, mode, slug, base = null, continues = null, change = [], unit = null, entry = [] } = options;
  if (typeof ns !== 'string') throw new RunError('--ns is required');
  const { kind } = parseNamespace(ns);
  if (!RUN_MODES.includes(mode)) throw new RunError(`--mode must be one of ${RUN_MODES.join(', ')}`);
  if (!MODES_BY_KIND[kind].includes(mode)) {
    throw new RunError(`--mode ${mode} is not allowed in ${ns}: ${kind} namespaces take ${MODES_BY_KIND[kind].join(', ')}`);
  }
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new RunError('--slug must be lowercase a-z, 0-9 and -, at most 64');
  }
  if ((mode === 'audit-unit') !== (unit !== null)) {
    throw new RunError(mode === 'audit-unit' ? '--unit is required for audit-unit' : '--unit is only for audit-unit');
  }
  if ((mode === 'incremental' || mode === 'audit-unit') && base === null) {
    throw new RunError(`--base is required for ${mode}`);
  }
  if (mode === 'flow') {
    if (change.length) throw new RunError('a flow run reviews the current source from its --entry selectors; it takes no --change');
    if (base !== null) throw new RunError('a flow run takes no --base: flow results are not a baseline, and a flow run builds on none');
    if (entry.length === 0) throw new RunError('a flow run needs --entry: <path>#<Symbol>, <path>:<line> or <path>:<from>-<to>');
  } else if (entry.length) {
    throw new RunError('--entry is only for --mode flow');
  }
  if (mode === 'task' && change.length === 0) {
    // An unsized task would silently get the smallest budget and a Sonnet lead.
    throw new RunError('a task run needs --change: <repo> for its working tree, or <repo>:<a>..<b>');
  }
  if (kind === 'audit') {
    const refusal = auditAuthorization(root, ns, officialAuditsEnabled);
    if (refusal) throw new RunError(refusal);
  }

  // One open run per namespace (C5), and no abandoned run left without the
  // continuation that carries its work (an interrupted `resume --apply`).
  const read = (id) => (pending !== null && id === pending.run.id ? { doc: pending, errors: [] } : readRun(root, ns, id));
  const { ids } = listRuns(root, ns);
  const docs = [];
  for (const id of ids) {
    const { doc, errors } = read(id);
    if (!doc || errors.length) throw new RunError(`run ${id} in ${ns} cannot be read (${errors[0]}); fix or remove it first`);
    if (doc.run.status === 'open') {
      throw new RunError(`run ${id} is still open in ${ns}. Continue it, or run \`nthr resume --ns ${ns}\` to continue or abandon it`);
    }
    docs.push(doc);
  }

  const baseDoc = base === null ? null : requireRun(root, ns, base, ids, 'base', BASE_STATUSES, read);
  const continuesDoc = continues === null ? null : requireRun(root, ns, continues, ids, 'continues', CONTINUES_STATUSES, read);
  for (const doc of docs) {
    if (doc.run.status !== 'abandoned' || doc.run.id === continues || docs.some((d) => d.run.continues === doc.run.id)) continue;
    throw new RunError(`run ${doc.run.id} in ${ns} was abandoned, but no run continues it (an interrupted resume): run \`nthr resume --ns ${ns} --apply\` to open its continuation first`);
  }
  for (const doc of [baseDoc, continuesDoc].filter(Boolean)) {
    if (AUDIT_MODES.includes(doc.run.mode) !== AUDIT_MODES.includes(mode) || (doc.run.mode === 'flow') !== (mode === 'flow')) {
      throw new RunError(`${doc.run.id} is a ${doc.run.mode} run; a ${mode} run cannot build on it`);
    }
  }
  if (mode === 'flow' && continuesDoc) {
    const problem = flowContinuesProblem(continuesDoc.run);
    if (problem) throw new RunError(problem);
  }
  // An Incremental run reviews its effective baseline: broken ancestry is refused at Open.
  const baseline = mode === 'incremental' ? effectiveBaseline(root, ns, base, ids, read) : null;
  let units = [];
  if (AUDIT_MODES.includes(mode)) {
    const chain = auditChainProblem(docs, { id: null, base });
    if (chain) throw new RunError(chain);
  }
  if (AUDIT_MODES.includes(mode) && baseDoc) units = structuredClone(baseDoc.scope.units); // C20
  if (mode === 'audit-unit' && unit !== RESERVED_UNIT && !units.some((u) => u.id === unit)) {
    throw new RunError(`--unit ${unit} is not in the units ledger of ${base}`);
  }
  if (mode === 'audit-unit') {
    const problem = unitProblem(units, unit);
    if (problem) throw new RunError(problem);
  }
  if (AUDIT_MODES.includes(mode) && continuesDoc) {
    const problem = auditContinuesProblem(continuesDoc.run, { mode, base, unit });
    if (problem) throw new RunError(problem);
  }

  // Debt-in comes from the immediate parent only (C4).
  const parent = continuesDoc ?? baseDoc;
  const debtIn = parent
    ? parent.debt.out.map((d) => ({ id: d.id, from_run: parent.run.id, disposition: null, note: null }))
    : [];

  const snapshot = takeSnapshot(root, { ...snapshotOptions, gitOptions });
  let sized;
  let entries = null;
  if (mode === 'flow') {
    // Entries resolve against the source the snapshot just observed.
    const resolved = resolveEntries(root, entry, snapshot.repos.map((r) => r.path), { gitOptions });
    if (resolved.problems.length) throw new RunError(`--entry: ${resolved.problems.join('; ')}`, resolved.problems);
    entries = resolved.entries;
    sized = { change: [], files: null, lines: null, verified: true };
  } else if (mode === 'incremental' && change.length === 0) sized = sizeSinceBase(baseDoc.snapshot, snapshot, root, gitOptions);
  else sized = sizeChanges(change, snapshot, root, gitOptions);
  const plan = initialBudget(mode, {
    files: sized.files,
    lines: sized.lines,
    verified: sized.verified,
    debtIn: debtIn.length,
    baseObligations: baseline ? baseline.entries.length : baseDoc ? baseDoc.obligations.length : 0,
    entries: entries?.length ?? 0,
    repos: entries ? new Set(entries.map((e) => e.repo)).size : 0,
  });

  const stamp = now.toISOString();
  const runId = `${stamp.slice(0, 10).replaceAll('-', '')}-${stamp.slice(11, 19).replaceAll(':', '')}-${mode}-${slug}`;
  parseRunId(runId);
  if (ids.includes(runId)) throw new RunError(`run ${runId} already exists in ${ns}; open it a second later`);
  const charter = kind === 'audit' ? readCharter(root, ns).charter : null;
  const records = {
    schema: SCHEMA_ID,
    run: {
      id: runId,
      namespace: ns,
      mode,
      slug,
      unit,
      base,
      continues,
      status: 'open',
      incomplete_reason: null,
      opened: `${stamp.slice(0, 19)}Z`,
      closed: null,
      profile: ['quick', 'standard', 'deep'].includes(charter?.profile) ? charter.profile : 'standard',
      runtime: { required_lead_model: plan.required_lead_model, lead_model: null, lead_effort: null, triggers: plan.triggers },
    },
    scope: { summary: '', change: sized.change, units, intent: [], ...(entries ? { entries } : {}) },
    budget: plan.budget,
    snapshot,
    checks: [],
    census: { recipes: [], items: [], ...(entries ? { edges: [] } : {}) },
    obligations: [],
    findings: [],
    debt: { in: debtIn, out: [] },
    delegations: [],
    footprint: {},
    freshness: null,
  };
  const problems = validateStructure(records);
  if (problems.length) throw new Error(`new-run built invalid records: ${problems.join('; ')}`);

  const result = {
    run_dir: `.nth-review/${runDir(ns, runId)}`,
    run_id: runId,
    mode,
    // files and lines are null when an Incremental change cannot be sized
    size: { class: plan.size, files: sized.files, lines: sized.lines, verified: sized.verified },
    budget: plan.budget,
    required_lead_model: plan.required_lead_model,
    triggers: plan.triggers,
    debt_in: debtIn.length,
    ...(entries ? { entries: entries.map((e) => ({ id: e.id, selector: e.selector, anchor: entryAnchor(e), repo: e.repo, state: e.identity.state })) } : {}),
    snapshot: {
      repos: snapshot.repos.length,
      reconstructible: snapshot.reconstructible,
      tracked_complete: snapshot.tracked_complete,
      discovery_complete: snapshot.discovery_complete,
      untracked_complete: snapshot.untracked_complete,
      limitations: snapshot.limitations,
    },
  };
  return { records, result };
}
