// `decide` and `status` (M2-T6; decisions C2, C3).
// - decide: an owner decision about a finding fingerprint, appended to the
//   namespace's decisions.json. Closed runs are never written (C1, C2).
//   Append-only, with provenance (seq, supersedes, by, date, seen_in). An
//   exclusive lock makes concurrent writers wait their turn: a second writer
//   is refused, never silently lost.
// - status: a read-only, deterministic overview of one or every namespace:
//   runs, outstanding debt, findings with their latest decision, and the
//   decision history.
// Decisions are records only: no command acts on them, and a decision never
// authorizes changing code.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { listed, utc } from './close.mjs';
import { followUpCommand } from './render.mjs';
import { byteCompare } from './discover.mjs';
import { listNamespaces, parseNamespace, resolveReviewPath, writeAtomic } from './fsguard.mjs';
import { RunError, auditAuthorization, listRuns, readCharter, readRun } from './runs.mjs';
import {
  DECISIONS_SCHEMA_ID, DECISION_LIMITS, LIMITS, OWNER_DECISIONS, VOCAB, parseRecords, validateDecisions,
} from './schema.mjs';

export const DECISION_NOTICE = 'Owner decisions are records only: no nthr command acts on them, and a decision never authorizes changing code.';
const MAX_LOCK_BYTES = 4096;

// The namespace's decisions.json: { doc (null when absent), errors }.
export function readDecisions(root, ns) {
  const file = resolveReviewPath(root, `${ns}/decisions.json`, { minDepth: 3 });
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch {
    return { doc: null, errors: [] };
  }
  if (stats.size > LIMITS.bytes) return { doc: null, errors: [`decisions.json: is ${stats.size} bytes; at most ${LIMITS.bytes} allowed`] };
  const { value, errors } = parseRecords(fs.readFileSync(file));
  if (errors.length) return { doc: null, errors: errors.map((e) => `decisions.json: ${e}`) };
  const problems = validateDecisions(value);
  if (!problems.length && value.namespace !== ns) problems.push(`$.namespace: must be ${ns}, the namespace it is in`);
  return problems.length ? { doc: null, errors: problems.map((e) => `decisions.json: ${e}`) } : { doc: value, errors: [] };
}

// Every readable run of the namespace (a run that cannot be read is listed in
// `unreadable`, never fatal).
function readRuns(root, ns) {
  const { ids, strays } = listRuns(root, ns);
  const docs = [];
  const unreadable = [];
  for (const id of ids) {
    let read;
    try {
      read = readRun(root, ns, id);
    } catch (error) {
      // A link, a non-file or an I/O error: reported without any path.
      read = { doc: undefined, errors: [`records.json cannot be read (${error?.code ?? error?.name ?? 'error'})`] };
    }
    if (!read.doc || read.errors.length) unreadable.push({ id, problem: read.errors[0] });
    else docs.push(read.doc);
  }
  return { ids, strays, docs, unreadable };
}

function lockedMessage(lockPath, ns) {
  let holder = 'an unreadable lock';
  try {
    const fd = fs.openSync(lockPath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_LOCK_BYTES);
      const lock = JSON.parse(buffer.subarray(0, fs.readSync(fd, buffer, 0, MAX_LOCK_BYTES, 0)).toString('utf8'));
      holder = `pid ${lock.pid} since ${lock.created}`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // keep "an unreadable lock"
  }
  return `the decisions of ${ns} are locked by another decide (${holder}). If no decide is running, delete .nth-review/${ns}/decisions.lock and retry`;
}

// Removes the lock only when it is still ours.
function releaseLock(lockPath, token) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === token) fs.rmSync(lockPath);
  } catch {
    // gone, unreadable, or someone else's: leave it
  }
}

// Records an owner decision. Returns the result, or { errors } (exit 1: an
// existing decisions.json is invalid and is never overwritten). Throws
// RunError on a refusal (exit 2; nothing written).
export function decide(root, { ns, fingerprint, decision, note, by } = {}, { now = new Date(), officialAuditsEnabled = false, io = {} } = {}) {
  if (typeof ns !== 'string') throw new RunError('--ns is required');
  const { kind } = parseNamespace(ns);
  if (typeof fingerprint !== 'string' || fingerprint === '') throw new RunError('--fingerprint is required');
  if (!OWNER_DECISIONS.includes(decision)) throw new RunError(`--decision must be one of ${OWNER_DECISIONS.join(', ')}`);
  if (typeof note !== 'string' || note.trim() === '') throw new RunError('--note is required: say why');
  if (typeof by !== 'string' || by.trim() === '' || by.length > DECISION_LIMITS.by || /[\t\r\n]/.test(by)) {
    throw new RunError(`--by is required: who decides (one line, at most ${DECISION_LIMITS.by} characters)`);
  }
  if (kind === 'audit') {
    const refusal = auditAuthorization(root, ns, officialAuditsEnabled);
    if (refusal) throw new RunError(refusal);
  }

  // The fingerprint must belong to a finding of this namespace (open runs count).
  const { docs, unreadable } = readRuns(root, ns);
  const seenIn = docs.flatMap((d) => d.findings.filter((f) => f.fingerprint === fingerprint).map((f) => ({ run: d.run.id, finding: f.id })))
    .sort((a, b) => byteCompare(a.run, b.run) || byteCompare(a.finding, b.finding));
  if (!seenIn.length) {
    const also = unreadable.length ? `; runs that could not be read: ${listed(unreadable.map((u) => u.id))}` : '';
    throw new RunError(`unknown fingerprint ${JSON.stringify(fingerprint)} in ${ns}: no finding of its runs has it${also}`);
  }

  // One writer at a time: the lock is created exclusively; a second writer is
  // refused with instructions (a stale lock is never broken automatically).
  const lockPath = resolveReviewPath(root, `${ns}/decisions.lock`, { minDepth: 3 });
  const token = randomBytes(16).toString('hex');
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new RunError(lockedMessage(lockPath, ns));
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, created: utc(now), token }));
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true }); // created by this call: ours to remove
    throw error;
  }
  fs.closeSync(fd);
  try {
    // Read again under the lock: the entry follows whatever is there now.
    const current = readDecisions(root, ns);
    if (current.errors.length) return { errors: current.errors };
    const doc = current.doc ?? { schema: DECISIONS_SCHEMA_ID, namespace: ns, decisions: [] };
    if (doc.decisions.length >= DECISION_LIMITS.entries) {
      throw new RunError(`decisions.json of ${ns} holds ${DECISION_LIMITS.entries} entries, the most it can`);
    }
    const supersedes = doc.decisions.findLast((d) => d.fingerprint === fingerprint)?.seq ?? null;
    const entry = {
      seq: doc.decisions.length + 1, fingerprint, decision, note, by, date: utc(now), supersedes,
      seen_in: seenIn.slice(0, DECISION_LIMITS.seenIn),
    };
    const next = { ...doc, decisions: [...doc.decisions, entry] };
    const problems = validateDecisions(next);
    if (problems.length) throw new RunError(`the decision cannot be recorded: ${problems[0]}`);
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(text) > LIMITS.bytes) {
      throw new RunError(`decisions.json of ${ns} would exceed ${LIMITS.bytes} bytes, the most it can hold; nothing was written`);
    }
    writeAtomic(root, `${ns}/decisions.json`, text, { rename: io.rename });
    return { errors: [], decisions: `.nth-review/${ns}/decisions.json`, entry, notice: DECISION_NOTICE };
  } finally {
    releaseLock(lockPath, token);
  }
}

// ---------------------------------------------------------------- status

// One namespace's file that cannot be read (a link, a directory, an I/O
// error) is reported in place, without any path; it never stops `status`.
const unreadableFile = (name, error) => `${name} cannot be read (${error?.code ?? error?.name ?? 'error'})`;

function namespaceStatus(root, ns) {
  const { kind } = parseNamespace(ns);
  let listing;
  let problem = null;
  try {
    listing = readRuns(root, ns);
  } catch (error) {
    problem = unreadableFile('runs/', error);
    listing = { ids: [], strays: [], docs: [], unreadable: [] };
  }
  const { ids, strays, docs, unreadable } = listing;
  const byId = new Map(docs.map((d) => [d.run.id, d]));
  const problems = new Map(unreadable.map((u) => [u.id, u.problem]));
  const runs = ids.map((id) => {
    const d = byId.get(id);
    return d
      ? { id, mode: d.run.mode, status: d.run.status, base: d.run.base, continues: d.run.continues, opened: d.run.opened, closed: d.run.closed, findings: d.findings.length, problem: null }
      : { id, mode: null, status: null, base: null, continues: null, opened: null, closed: null, findings: 0, problem: problems.get(id) ?? null };
  });

  // Outstanding debt: what the latest closed runs hand on (a closed run that
  // another closed run builds on has passed its debt along). The open run's
  // in-progress records do not count.
  const closed = docs.filter((d) => d.run.status !== 'open');
  const builtOn = new Set(closed.flatMap((d) => [d.run.base, d.run.continues]).filter((x) => x !== null));
  const items = new Map();
  for (const d of closed.filter((c) => !builtOn.has(c.run.id))) {
    for (const item of d.debt.out) items.set(item.id, { id: item.id, kind: item.kind, priority: item.priority, from_run: d.run.id });
  }
  const byKind = Object.fromEntries(VOCAB.debtKind.map((k) => [k, 0]));
  for (const item of items.values()) byKind[item.kind] += 1;

  // Findings by fingerprint, with the latest decision.
  let read;
  try {
    read = readDecisions(root, ns);
  } catch (error) {
    read = { doc: null, errors: [unreadableFile('decisions.json', error)] };
  }
  const entries = read.doc?.decisions ?? [];
  const latestDecision = new Map();
  for (const e of entries) latestDecision.set(e.fingerprint, e);
  const seen = new Map();
  for (const d of docs) {
    for (const f of d.findings) seen.set(f.fingerprint, [...(seen.get(f.fingerprint) ?? []), { run: d.run.id, f }]);
  }
  const findings = [...seen.keys()].sort(byteCompare).map((fingerprint) => {
    const list = seen.get(fingerprint).sort((a, b) => byteCompare(a.run, b.run) || byteCompare(a.f.id, b.f.id));
    const lastRun = list.at(-1).run;
    const { run, f } = list.find((x) => x.run === lastRun);
    const decision = latestDecision.get(fingerprint) ?? null;
    return {
      fingerprint,
      latest: { run, id: f.id, kind: f.kind, verdict: f.verdict, severity: f.severity, summary: f.summary, decision_at_close: f.decision },
      seen_in: list.map((x) => ({ run: x.run, finding: x.f.id })),
      decision: decision && { seq: decision.seq, decision: decision.decision, note: decision.note, by: decision.by, date: decision.date, supersedes: decision.supersedes },
    };
  });
  const supersededBy = new Map(entries.filter((e) => e.supersedes !== null).map((e) => [e.supersedes, e.seq]));

  let charter = null;
  if (kind === 'audit') {
    let c;
    try {
      c = readCharter(root, ns);
    } catch (error) {
      c = { valid: false, problem: unreadableFile('charter.json', error) };
    }
    charter = c === null
      ? { valid: false, problem: 'no charter.json', owner: null, profile: null, created: null }
      : { valid: c.valid, problem: c.problem ?? null, owner: c.charter?.owner ?? null, profile: c.charter?.profile ?? null, created: c.charter?.created ?? null };
  }
  // The next step for this namespace: continue an open run, finish an
  // interrupted resume, or follow up the latest closed run. Null when a run
  // cannot be read: then nothing is certain.
  const latestClosed = docs.filter((d) => d.run.status === 'complete' || d.run.status === 'incomplete').sort((a, b) => byteCompare(a.run.id, b.run.id)).at(-1);
  const open = docs.find((d) => d.run.status === 'open');
  const interrupted = docs.find((d) => d.run.status === 'abandoned' && !docs.some((c) => c.run.continues === d.run.id));
  let next = null;
  if (problem === null && unreadable.length === 0) {
    if (open) next = { reason: 'open', run: open.run.id, command: `nthr resume --ns ${ns}` };
    else if (interrupted) next = { reason: 'interrupted', run: interrupted.run.id, command: `nthr resume --ns ${ns} --apply` };
    else if (latestClosed) next = { reason: 'closed', run: latestClosed.run.id, command: followUpCommand(latestClosed.run, latestClosed) };
  }
  return {
    namespace: ns,
    kind,
    problem,
    charter,
    next,
    runs,
    run_strays: strays,
    open_runs: docs.filter((d) => d.run.status === 'open').map((d) => d.run.id),
    debt: {
      complete: problem === null && unreadable.length === 0,
      total: items.size,
      by_kind: byKind,
      items: [...items.values()].sort((a, b) => byteCompare(a.id, b.id)),
    },
    findings,
    decisions: {
      valid: read.errors.length === 0,
      problem: read.errors[0] ?? null,
      entries: entries.map((e) => ({
        seq: e.seq, fingerprint: e.fingerprint, decision: e.decision, note: e.note, by: e.by, date: e.date,
        supersedes: e.supersedes, superseded_by: supersededBy.get(e.seq) ?? null,
      })),
      orphans: [...new Set(entries.map((e) => e.fingerprint))].filter((fp) => !seen.has(fp)).sort(byteCompare),
    },
  };
}

// The status of `ns`, or of every namespace. Reads only; writes nothing.
export function status(root, ns) {
  let namespaces;
  let strays = [];
  if (ns !== undefined) {
    parseNamespace(ns);
    const dir = resolveReviewPath(root, ns, { expectDirectory: true, minDepth: 2 });
    if (!fs.existsSync(dir)) throw new RunError(`there is no namespace ${ns}`);
    namespaces = [ns];
  } else {
    ({ namespaces, strays } = listNamespaces(root));
  }
  return { notice: DECISION_NOTICE, strays, namespaces: namespaces.map((n) => namespaceStatus(root, n)) };
}

