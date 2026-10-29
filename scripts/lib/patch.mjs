// `apply`: the lead's records writer. It applies <run_dir>/patch.json to the
// open run's records.json in one atomic write, so related updates are one
// batch rather than many edits or a generator script. A patch is refused,
// with nothing written, when it is stale (its `base` is not the sha256 of
// records.json as it is now), touches a helper-owned or immutable field, or
// leaves records that are not structurally valid. On success patch.json is
// removed, and the result carries the new digest and the check result.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { checkRun } from './check.mjs';
import { resolveReviewPath, runDir, writeAtomic } from './fsguard.mjs';
import { RunError } from './runs.mjs';
import { LIMITS, parseRecords, validateStructure } from './schema.mjs';

export const PATCH_SCHEMA = 'nth-review/patch@1';
export const PATCH_FILE = 'patch.json';
const MAX_OPS = 500;
const OPS = ['set', 'add', 'remove'];

export const recordsSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The sha256 of an existing run's records.json bytes, or null.
export function recordsDigestOf(root, ns, id) {
  const file = resolveReviewPath(root, `${runDir(ns, id)}/records.json`, { minDepth: 3 });
  return fs.existsSync(file) ? recordsSha256(fs.readFileSync(file)) : null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// `/a/b/OB-1/status` → ['a', 'b', 'OB-1', 'status'] (JSON Pointer escapes).
function parsePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p === '/') return null;
  return p.slice(1).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
}

// The lead may write only these parts of records.json (SKILL.md guardrails);
// everything else is the helper's or immutable. Returns a reason, or null.
function protectedReason(doc, seg, op, value) {
  const [top, second, third, fourth] = seg;
  const exactly = (n) => seg.length === n;
  switch (top) {
    case 'run':
      return second === 'runtime' && seg.length >= 3 ? null : 'only run.runtime is the lead\'s; the rest of run is the helper\'s';
    case 'scope':
      if (second === 'summary' && exactly(2) && op === 'set') return null;
      if (second === 'intent' && (seg.length >= 3 || op === 'add')) return null;
      if (second === 'intent') return 'scope.intent is never replaced or removed whole: add each entry ({ op: "add", path: "/scope/intent", value: {...} }), or address one by its id';
      if (second === 'units' && (seg.length >= 3 || op === 'add') && doc.run.mode === 'audit-plan') return null;
      return 'scope.change (and units outside a plan run) are the helper\'s; write scope.summary or scope.intent items';
    case 'census': case 'obligations': case 'findings': case 'delegations': case 'checks':
      return seg.length >= 2 || op === 'add' ? null : `add to ${top}, or address one of its items or fields; never replace or remove the whole section`;
    case 'debt':
      if (second === 'out' && (seg.length >= 3 || op === 'add')) return null;
      if (second === 'in' && exactly(4) && op === 'set' && (fourth === 'disposition' || fourth === 'note')) return null;
      return 'debt.in comes from the parent run: only its disposition and note are the lead\'s';
    case 'budget':
      if (second === 'spent' && exactly(3) && op === 'set' && third !== 'wall_clock_min') return null;
      return 'the budget limits are the helper\'s, and close computes budget.spent.wall_clock_min';
    case 'freshness':
      if (second === 'obligations' && exactly(4) && op === 'set' && third !== undefined) {
        if (fourth === 'class') return value === 'assumption-changed' ? null : 'a freshness class may only be set to assumption-changed';
        if (fourth === 'reason') return null; // only with an assumption-changed class (checked after the ops)
      }
      return 'freshness is the helper\'s, except setting a class to assumption-changed with its reason';
    default:
      return `${top} is the helper's (snapshot, footprint and the schema version are never written by the lead)`;
  }
}

// The container and key that `seg` addresses in `doc`; array elements by
// their `id` when they have one, else by index.
function locate(doc, seg) {
  let node = doc;
  for (let i = 0; i < seg.length - 1; i += 1) {
    node = child(node, seg[i]);
    if (node === undefined) return { error: `/${seg.slice(0, i + 1).join('/')} does not exist` };
  }
  const last = seg[seg.length - 1];
  if (Array.isArray(node)) {
    const index = indexOf(node, last);
    return index === -1 ? { container: node, key: null, missing: last } : { container: node, key: index };
  }
  if (isObject(node)) return { container: node, key: last };
  return { error: `/${seg.slice(0, -1).join('/')} is not an object or array` };
}

// In an array whose items have ids, a segment is an id and nothing else
// (records.md, apply): a missing id never falls back to a position.
function indexOf(array, segment) {
  const byId = array.findIndex((item) => isObject(item) && item.id === segment);
  if (byId !== -1) return byId;
  if (array.some((item) => isObject(item) && typeof item.id === 'string')) return -1;
  if (/^(0|[1-9]\d*)$/.test(segment) && Number(segment) < array.length) return Number(segment);
  return -1;
}

function child(node, segment) {
  if (Array.isArray(node)) {
    const index = indexOf(node, segment);
    return index === -1 ? undefined : node[index];
  }
  return isObject(node) && Object.hasOwn(node, segment) ? node[segment] : undefined;
}

// Applies `ops` to a copy of `doc`. Returns { doc, errors }.
export function applyOps(doc, ops) {
  const next = structuredClone(doc);
  const errors = [];
  ops.forEach((o, i) => {
    const where = `$.ops[${i}]`;
    if (!isObject(o) || !OPS.includes(o.op)) return errors.push(`${where}: op must be one of ${OPS.join(', ')}`);
    const extra = Object.keys(o).filter((k) => !['op', 'path', 'value'].includes(k));
    if (extra.length) return errors.push(`${where}: unknown key ${extra[0]}`);
    if ((o.op === 'remove') === Object.hasOwn(o, 'value')) return errors.push(`${where}: ${o.op === 'remove' ? 'remove takes no value' : `${o.op} needs a value`}`);
    const seg = parsePath(o.path);
    if (!seg) return errors.push(`${where}.path: must be a path such as /obligations/OB-1/status`);
    const refused = protectedReason(next, seg, o.op, o.value);
    if (refused) return errors.push(`${where}.path ${o.path}: refused: ${refused}`);
    const found = locate(next, seg);
    if (found.error) return errors.push(`${where}.path ${o.path}: ${found.error}`);
    const { container, key } = found;
    if (o.op === 'add') {
      const target = key === null ? undefined : container[key];
      if (!Array.isArray(target)) return errors.push(`${where}.path ${o.path}: add appends to an existing array`);
      if (isObject(o.value) && typeof o.value.id === 'string' && target.some((item) => isObject(item) && item.id === o.value.id)) {
        return errors.push(`${where}: ${o.value.id} already exists in ${o.path}; use set to replace it`);
      }
      target.push(structuredClone(o.value));
    } else if (o.op === 'set') {
      if (key === null) return errors.push(`${where}.path ${o.path}: no item ${found.missing}; use add to append one`);
      container[key] = structuredClone(o.value);
    } else {
      if (!Array.isArray(container) || key === null) return errors.push(`${where}.path ${o.path}: remove deletes an existing array item`);
      container.splice(key, 1);
    }
    return undefined;
  });
  // A freshness reason may change only with an assumption-changed class.
  (next.freshness?.obligations ?? []).forEach((f, i) => {
    const before = doc.freshness?.obligations.find((o) => o.id === f.id);
    if (before && before.reason !== f.reason && f.class !== 'assumption-changed') {
      errors.push(`$.freshness.obligations[${i}].reason: only an assumption-changed class takes a new reason`);
    }
  });
  return { doc: next, errors };
}

// Applies the pending patch of the open run `<ns>/runs/<id>`.
export function applyPatch(root, ns, id, { officialAuditsEnabled = false } = {}) {
  const rel = runDir(ns, id);
  const recordsFile = resolveReviewPath(root, `${rel}/records.json`, { minDepth: 3 });
  const patchFile = resolveReviewPath(root, `${rel}/${PATCH_FILE}`, { minDepth: 3 });
  if (!fs.existsSync(recordsFile)) throw new RunError(`no records.json in .nth-review/${rel}`);
  if (!fs.existsSync(patchFile)) throw new RunError(`no ${PATCH_FILE} in .nth-review/${rel}; write the patch there first`);
  const bytes = fs.readFileSync(recordsFile);
  const digest = recordsSha256(bytes);
  const { value: doc, errors: parseErrors } = parseRecords(bytes);
  if (parseErrors.length) return { errors: parseErrors, records_sha256: digest };
  if (doc?.run?.status !== 'open') throw new RunError(`run ${id} is ${doc?.run?.status}; a closed run is never written (C1)`);

  const patchBytes = fs.readFileSync(patchFile);
  if (patchBytes.length > LIMITS.bytes) return { errors: [`${PATCH_FILE}: larger than ${LIMITS.bytes} bytes`], records_sha256: digest };
  const { value: patch, errors: patchErrors } = parseRecords(patchBytes);
  if (patchErrors.length) return { errors: patchErrors.map((e) => e.replace(/^\$/, PATCH_FILE)), records_sha256: digest };
  const shape = [];
  if (!isObject(patch)) shape.push(`${PATCH_FILE}: must be an object { schema, base, ops }`);
  else {
    const extra = Object.keys(patch).filter((k) => !['schema', 'base', 'ops'].includes(k));
    if (patch.schema !== PATCH_SCHEMA) shape.push(`${PATCH_FILE}.schema: must be ${PATCH_SCHEMA}`);
    if (typeof patch.base !== 'string') shape.push(`${PATCH_FILE}.base: must be the records_sha256 the helper last printed`);
    if (!Array.isArray(patch.ops) || patch.ops.length > MAX_OPS) shape.push(`${PATCH_FILE}.ops: must be an array of at most ${MAX_OPS} ops`);
    if (extra.length) shape.push(`${PATCH_FILE}: unknown key ${extra[0]}`);
  }
  if (shape.length) return { errors: shape, records_sha256: digest };
  // A stale patch may be one an interrupted apply already wrote (a crash
  // after the write, before the removal). Resending it would not be safe:
  // items without an id are appended again and index paths shift.
  if (patch.base !== digest) {
    return {
      errors: [`${PATCH_FILE}.base: stale: records.json changed since (it is now ${digest}). Read records.json before rebuilding: if an interrupted apply already wrote this batch, never resend it; clear the patch with an empty ops on base ${digest}`],
      records_sha256: digest,
    };
  }

  const { doc: next, errors } = applyOps(doc, patch.ops);
  if (errors.length) return { errors, records_sha256: digest };
  const structure = validateStructure(next);
  if (structure.length) return { errors: structure, records_sha256: digest };

  const text = `${JSON.stringify(next, null, 2)}\n`;
  writeAtomic(root, `${rel}/records.json`, text);
  fs.rmSync(patchFile);
  const checked = checkRun(root, rel, { officialAuditsEnabled });
  return {
    errors: [],
    run_dir: `.nth-review/${rel}`,
    applied: patch.ops.length,
    records_sha256: recordsSha256(Buffer.from(text, 'utf8')),
    check: { valid: checked.errors.length === 0, errors: checked.errors, warnings: checked.warnings },
  };
}
