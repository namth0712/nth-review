// The effective baseline of an Incremental run (runs.mjs effectiveBaseline):
// the latest recorded version of every obligation inherited through the
// validated base ancestry. In-memory ancestries; nothing touches the disk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS } from '../scripts/lib/schema.mjs';
import { MAX_BASE_CHAIN, RunError, effectiveBaseline } from '../scripts/lib/runs.mjs';

const NS = 'experiments/chain';
const id = (n, mode = 'incremental') => `20261026-09${String(Math.floor(n / 60)).padStart(2, '0')}${String(n % 60).padStart(2, '0')}-${mode}-r${n}`;
const run = (runId, { base = null, mode = runId.split('-')[2], status = 'complete', obligations = [], continues = null, namespace = NS } = {}) => ({
  run: { id: runId, namespace, mode, status, base, continues },
  obligations: obligations.map((o) => (typeof o === 'string' ? { id: o, status: 'held' } : o)),
});
// { ids, read } over `docs`; `errors` maps an id to a validation error.
function store(docs, { errors = {} } = {}) {
  const byId = new Map(docs.map((d) => [d.run.id, d]));
  return { ids: docs.map((d) => d.run.id), read: (runId) => (errors[runId] ? { doc: undefined, errors: [errors[runId]] } : { doc: byId.get(runId), errors: [] }) };
}
const resolve = (docs, baseId, options) => {
  const { ids, read } = store(docs, options);
  return effectiveBaseline('unused', NS, baseId, ids, read);
};
const refused = (fn, pattern) => assert.throws(fn, (e) => e instanceof RunError && pattern.test(e.message));
const view = (baseline) => baseline.entries.map((e) => `${e.id}@${e.origin}`);

test('the nearest run recording an id is its origin; order is the base first, then each older ancestor', () => {
  const r1 = run(id(1, 'task'), { obligations: ['O1', 'O2', 'O3'] });
  const r2 = run(id(2), { base: r1.run.id, obligations: ['O1'] });
  const r3 = run(id(3), { base: r2.run.id, obligations: ['O2', 'O4'] });
  const baseline = resolve([r1, r2, r3], r3.run.id);
  assert.equal(baseline.base, r3);
  assert.deepEqual(view(baseline), [`O2@${r3.run.id}`, `O4@${r3.run.id}`, `O1@${r2.run.id}`, `O3@${r1.run.id}`]);
  assert.equal(baseline.entries.find((e) => e.id === 'O3').doc, r1, 'the origin version keeps its own run (evidence, findings, footprint)');
  // From the middle of the chain, only what that run inherits.
  assert.deepEqual(view(resolve([r1, r2, r3], r2.run.id)), [`O1@${r2.run.id}`, `O2@${r1.run.id}`, `O3@${r1.run.id}`]);
});

test('inheritance stops at a task run, and never follows continues or abandoned runs', () => {
  const r0 = run(id(1, 'task'), { obligations: ['OLD'] });
  const r1 = run(id(2, 'task'), { base: r0.run.id, obligations: ['O1'] }); // a task run is a full baseline
  const abandoned = run(id(3), { base: r1.run.id, status: 'abandoned', obligations: ['LOST'] });
  const r2 = run(id(4), { base: r1.run.id, continues: abandoned.run.id, obligations: ['O2'] });
  assert.deepEqual(view(resolve([r0, r1, abandoned, r2], r2.run.id)), [`O2@${r2.run.id}`, `O1@${r1.run.id}`]);
});

test('broken ancestry is refused: missing, invalid, another namespace, open, abandoned, audit, a loop, too deep, too large', () => {
  const r1 = run(id(1, 'task'), { obligations: ['O1'] });
  const r2 = run(id(2), { base: r1.run.id, obligations: ['O2'] });
  // A missing or invalid ancestor names itself and the base.
  refused(() => resolve([r2], r2.run.id), new RegExp(`^ancestor ${r1.run.id} of base ${r2.run.id}: --base ${r1.run.id} is not a run in ${NS}`));
  refused(() => resolve([r1, r2], r2.run.id, { errors: { [r1.run.id]: '$.run: bad' } }), /ancestor .* fails validation: \$\.run: bad/);
  // Records that name another namespace, or another run.
  refused(() => resolve([run(r1.run.id, { obligations: ['O1'], namespace: 'experiments/other' }), r2], r2.run.id), /its records name experiments\/other\//);
  // An ancestor from another namespace is not a run of this one.
  const foreign = run(id(3), { base: '20261026-080000-task-elsewhere', obligations: ['O3'] });
  refused(() => resolve([foreign], foreign.run.id), /is not a run in experiments\/chain; a base must be in the same namespace/);
  // Open, abandoned and audit ancestors.
  for (const status of ['open', 'abandoned']) {
    refused(() => resolve([run(r1.run.id, { status, obligations: ['O1'] }), r2], r2.run.id), new RegExp(`is ${status}; it must be complete or incomplete`));
  }
  refused(() => resolve([run(r1.run.id, { mode: 'audit-unit', obligations: ['O1'] }), r2], r2.run.id), /is a audit-unit run; an incremental run cannot build on it/);
  // A loop.
  const a = run(id(4), { base: id(5) });
  const b = run(id(5), { base: id(4) });
  refused(() => resolve([a, b], a.run.id), /loops at/);
  // Too deep: MAX_BASE_CHAIN runs resolve, one more is refused.
  const chainOf = (n) => Array.from({ length: n }, (_, i) => run(id(100 + i, i === 0 ? 'task' : 'incremental'), { base: i === 0 ? null : id(100 + i - 1, i === 1 ? 'task' : 'incremental'), obligations: [`O${i}`] }));
  const deep = chainOf(MAX_BASE_CHAIN);
  assert.equal(resolve(deep, deep.at(-1).run.id).entries.length, MAX_BASE_CHAIN);
  const deeper = chainOf(MAX_BASE_CHAIN + 1);
  refused(() => resolve(deeper, deeper.at(-1).run.id), new RegExp(`longer than ${MAX_BASE_CHAIN} runs`));
  // Too large.
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const big1 = run(id(1, 'task'), { obligations: many('A', LIMITS.obligations) });
  const big2 = run(id(2), { base: big1.run.id, obligations: ['B'] });
  refused(() => resolve([big1, big2], big2.run.id), new RegExp(`more than ${LIMITS.obligations} obligations`));
});
