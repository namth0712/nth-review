// `decide` and `status` (M2-T6; decisions C2, C3): append-only owner decisions
// with provenance, no lost update under concurrent writers, closed runs never
// written, and a read-only, deterministic status. Disposable repositories.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { DECISION_NOTICE, decide } from '../scripts/lib/decisions.mjs';
import { makeRepo } from './helpers/repo.mjs';
import { at, closeRun, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const project = (t) => fs.realpathSync.native(makeRepo(path.join(makeTempDir(t), 'p'), { 'src/a.js': 'a\n' }));
const finding = (id, fingerprint, extra = {}) => ({
  id, fingerprint, kind: 'defect', verdict: 'candidate', severity: null, impact_dimension: 'correctness', obligation: null,
  summary: `${id} summary`, trace: [{ role: 'sink', anchor: 'src/a.js:1', note: 'n' }], counterevidence: [], validation_plan: null,
  verification: { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }, decision: 'pending', ...extra,
});
// A run of `ns` holding `findings`, closed (incomplete) unless `open`.
function run(root, ns, slug, second, { findings = [], open = false, continues = null, debtOut = [] } = {}) {
  const args = ['new-run', '--ns', ns, '--mode', 'task', '--slug', slug, '--change', '.', ...(continues ? ['--continues', continues] : [])];
  const opened = nthr(args, { cwd: root, now: at(second) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.findings = findings;
  doc.debt.out = debtOut.map((d) => ({ id: `${doc.run.id}/${d.id}`, kind: d.kind, refs: [], requires: 'r', priority: 'medium' }));
  writeRecords(root, runDir, doc);
  if (!open) closeRun(root, runDir, { status: 'incomplete', reason: 'budget' });
  return { runDir, id: doc.run.id };
}
const decideCli = (root, ns, fingerprint, second, { decision = 'accept', note = 'a note', by = 'owner' } = {}) => nthr(
  ['decide', '--ns', ns, '--fingerprint', fingerprint, '--decision', decision, '--note', note, '--by', by], { cwd: root, now: at(second) },
);
const decisionsFile = (root, ns) => path.join(root, '.nth-review', ...ns.split('/'), 'decisions.json');
const lockFile = (root, ns) => path.join(root, '.nth-review', ...ns.split('/'), 'decisions.lock');
// Every file under `root` (Git metadata included): path and digest.
function treeState(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .map((file) => `${path.relative(root, file)} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`)
    .sort();
}

const NS = 'reviews/app';

test('decide: append-only entries with provenance; a later decision supersedes; runs are never written', (t) => {
  const root = project(t);
  const a = run(root, NS, 'a', 1, { findings: [finding('F-1', 'api/invoices/ownership'), finding('F-2', 'web/prefix')] });
  const b = run(root, NS, 'b', 2, { findings: [finding('F-7', 'api/invoices/ownership')] });
  const runsBefore = treeState(path.join(root, '.nth-review', 'reviews', 'app', 'runs'));

  const first = decideCli(root, NS, 'api/invoices/ownership', 10, { decision: 'fix', note: 'fix before release', by: 'owner' });
  assert.equal(first.code, EXIT.OK, JSON.stringify(first.json));
  assert.equal(first.json.result.notice, DECISION_NOTICE);
  assert.deepEqual(first.json.result.entry, {
    seq: 1, fingerprint: 'api/invoices/ownership', decision: 'fix', note: 'fix before release', by: 'owner', date: '2026-10-26T09:00:10Z',
    supersedes: null, seen_in: [{ run: a.id, finding: 'F-1' }, { run: b.id, finding: 'F-7' }],
  });
  const firstEntry = JSON.stringify(JSON.parse(fs.readFileSync(decisionsFile(root, NS), 'utf8')).decisions[0]);

  const second = decideCli(root, NS, 'api/invoices/ownership', 11, { decision: 'known-item', note: 'tracked as BUG-12', by: 'lead' });
  assert.equal(second.code, EXIT.OK, JSON.stringify(second.json));
  assert.equal(second.json.result.entry.supersedes, 1);
  const stored = JSON.parse(fs.readFileSync(decisionsFile(root, NS), 'utf8'));
  assert.equal(stored.schema, 'nth-review/decisions@1');
  assert.equal(JSON.stringify(stored.decisions[0]), firstEntry, 'an earlier decision never changes');
  assert.deepEqual(stored.decisions.map((d) => [d.seq, d.decision, d.supersedes]), [[1, 'fix', null], [2, 'known-item', 1]]);
  assert.deepEqual(treeState(path.join(root, '.nth-review', 'reviews', 'app', 'runs')), runsBefore, 'closed runs are never written');
  assert.equal(fs.existsSync(lockFile(root, NS)), false, 'the lock is released');
});

test('decide refuses: an unknown fingerprint, a decision outside the vocabulary, a missing note or author, a closed audit gate', (t) => {
  const root = project(t);
  run(root, NS, 'a', 1, { findings: [finding('F-1', 'api/x')] });
  run(root, 'reviews/other', 'o', 2, { findings: [finding('F-1', 'only/elsewhere')] });
  const refused = (r, pattern) => {
    assert.equal(r.code, EXIT.USAGE, JSON.stringify(r.json));
    assert.match(r.json.errors[0], pattern);
    assert.equal(fs.existsSync(decisionsFile(root, NS)), false, 'nothing written');
  };
  refused(decideCli(root, NS, 'only/elsewhere', 3), /unknown fingerprint "only\/elsewhere" in reviews\/app/);
  refused(decideCli(root, NS, 'api/x', 3, { decision: 'pending' }), /--decision must be one of fix, accept, false-positive, known-item/);
  refused(decideCli(root, NS, 'api/x', 3, { decision: 'ignore' }), /--decision must be one of/);
  refused(decideCli(root, NS, 'api/x', 3, { note: '   ' }), /--note is required/);
  refused(decideCli(root, NS, 'api/x', 3, { by: 'two\nlines' }), /--by is required/);
  // An unreadable run is named when the fingerprint is not found elsewhere.
  fs.mkdirSync(path.join(root, '.nth-review', 'reviews', 'app', 'runs', '20261026-090009-task-bad'));
  refused(decideCli(root, NS, 'not/there', 4), /runs that could not be read: 20261026-090009-task-bad/);
  // Audits: the gate is closed.
  refused(nthr(['decide', '--ns', 'audits/core', '--fingerprint', 'x', '--decision', 'fix', '--note', 'n', '--by', 'o'], { cwd: root, now: at(5) }),
    /official audits are disabled/);
});

test('concurrent decide: a second writer is refused while the first holds the lock, then succeeds; nothing is lost', (t) => {
  const root = project(t);
  run(root, NS, 'a', 1, { findings: [finding('F-1', 'api/x'), finding('F-2', 'api/y')] });
  let inside = null;
  const rename = (from, to) => {
    // Writer A holds the lock and has read the file: writer B arrives now.
    inside = decideCli(root, NS, 'api/x', 21, { decision: 'false-positive', note: 'B', by: 'b' });
    assert.equal(fs.readFileSync(lockFile(root, NS), 'utf8').includes('"token"'), true, 'A still holds the lock');
    fs.renameSync(from, to);
  };
  const a = decide(root, { ns: NS, fingerprint: 'api/x', decision: 'accept', note: 'A', by: 'a' }, { now: at(20), io: { rename } });
  assert.deepEqual(a.errors, []);
  assert.equal(inside.code, EXIT.USAGE, JSON.stringify(inside.json));
  assert.match(inside.json.errors[0], /the decisions of reviews\/app are locked by another decide \(pid \d+ since 2026-10-26T09:00:20Z\)/);
  assert.equal(fs.existsSync(lockFile(root, NS)), false, 'A released its lock');

  const retried = decideCli(root, NS, 'api/x', 22, { decision: 'false-positive', note: 'B', by: 'b' });
  assert.equal(retried.code, EXIT.OK, JSON.stringify(retried.json));
  const stored = JSON.parse(fs.readFileSync(decisionsFile(root, NS), 'utf8')).decisions;
  assert.deepEqual(stored.map((d) => [d.seq, d.by, d.supersedes]), [[1, 'a', null], [2, 'b', 1]], 'both decisions are kept, in order');
});

test('a stale lock is never broken; a failed write keeps the old file and releases the lock; a foreign lock is left alone', (t) => {
  const root = project(t);
  run(root, NS, 'a', 1, { findings: [finding('F-1', 'api/x')] });
  assert.equal(decideCli(root, NS, 'api/x', 2).code, EXIT.OK);
  const before = fs.readFileSync(decisionsFile(root, NS));

  fs.writeFileSync(lockFile(root, NS), '{"pid": 99, "created": "2026-10-26T08:00:00Z", "token": "stale"}');
  const stale = decideCli(root, NS, 'api/x', 3);
  assert.equal(stale.code, EXIT.USAGE);
  assert.match(stale.json.errors[0], /locked by another decide \(pid 99 since 2026-10-26T08:00:00Z\)\. If no decide is running, delete \.nth-review\/reviews\/app\/decisions\.lock and retry/);
  assert.ok(fs.readFileSync(decisionsFile(root, NS)).equals(before));
  assert.ok(fs.existsSync(lockFile(root, NS)), 'a stale lock stays until the owner removes it');
  fs.rmSync(lockFile(root, NS));

  const fail = () => { throw new Error('rename failed'); };
  assert.throws(() => decide(root, { ns: NS, fingerprint: 'api/x', decision: 'fix', note: 'n', by: 'o' }, { now: at(4), io: { rename: fail } }), /rename failed/);
  assert.ok(fs.readFileSync(decisionsFile(root, NS)).equals(before), 'the old file is intact');
  assert.equal(fs.existsSync(lockFile(root, NS)), false, 'the lock is released');
  assert.deepEqual(fs.readdirSync(path.dirname(decisionsFile(root, NS))).filter((n) => n.endsWith('.tmp')), []);

  const steal = (from, to) => {
    fs.writeFileSync(lockFile(root, NS), '{"pid": 1, "created": "2026-10-26T09:00:00Z", "token": "someone-else"}');
    fs.renameSync(from, to);
  };
  decide(root, { ns: NS, fingerprint: 'api/x', decision: 'fix', note: 'n', by: 'o' }, { now: at(5), io: { rename: steal } });
  assert.match(fs.readFileSync(lockFile(root, NS), 'utf8'), /someone-else/, 'a lock that is not ours is never removed');
});

test('a corrupt decisions.json is reported (exit 1) and never overwritten', (t) => {
  const root = project(t);
  run(root, NS, 'a', 1, { findings: [finding('F-1', 'api/x')] });
  assert.equal(decideCli(root, NS, 'api/x', 2).code, EXIT.OK);
  const valid = JSON.parse(fs.readFileSync(decisionsFile(root, NS), 'utf8'));
  for (const [bytes, pattern] of [
    ['{ not json', /decisions\.json: /],
    [JSON.stringify({ ...valid, decisions: [{ ...valid.decisions[0], seq: 2 }] }), /seq: must be 1/],
    [JSON.stringify({ ...valid, decisions: [...valid.decisions, { ...valid.decisions[0], seq: 2, supersedes: null }] }), /supersedes: must be 1/],
    [JSON.stringify({ ...valid, namespace: 'reviews/other' }), /namespace: must be reviews\/app/],
  ]) {
    fs.writeFileSync(decisionsFile(root, NS), bytes);
    const r = decideCli(root, NS, 'api/x', 3);
    assert.equal(r.code, EXIT.INVALID, JSON.stringify(r.json));
    assert.ok(r.json.errors.some((e) => pattern.test(e)), r.json.errors.join('\n'));
    assert.equal(fs.readFileSync(decisionsFile(root, NS), 'utf8'), bytes, 'never overwritten');
    assert.equal(fs.existsSync(lockFile(root, NS)), false);
  }
});

test('status: read-only, deterministic and sorted; runs, outstanding debt, findings and decisions', (t) => {
  const root = project(t);
  // Created out of order.
  run(root, 'reviews/zeta', 'z', 1, { findings: [finding('F-1', 'z/one')] });
  const p = run(root, NS, 'p', 2, { findings: [finding('F-1', 'b/second'), finding('F-2', 'a/first')], debtOut: [{ id: 'D1', kind: 'runtime' }, { id: 'D2', kind: 'frontier' }] });
  const c = run(root, NS, 'c', 3, { continues: p.id, findings: [finding('F-1', 'b/second', { verdict: 'confirmed', severity: 'high' })], debtOut: [{ id: 'D1', kind: 'owner-fact' }] });
  run(root, NS, 'o', 4, { open: true, continues: c.id, debtOut: [{ id: 'D1', kind: 'budget' }] });
  fs.mkdirSync(path.join(root, '.nth-review', 'research', 'notes'), { recursive: true }); // not a namespace prefix: ignored
  assert.equal(decideCli(root, NS, 'b/second', 10, { decision: 'fix' }).code, EXIT.OK);
  assert.equal(decideCli(root, NS, 'b/second', 11, { decision: 'accept' }).code, EXIT.OK);
  assert.equal(decideCli(root, NS, 'a/first', 12, { decision: 'false-positive' }).code, EXIT.OK);

  const before = treeState(root);
  const one = nthr(['status'], { cwd: root });
  const two = nthr(['status'], { cwd: root });
  assert.equal(one.code, EXIT.OK, JSON.stringify(one.json));
  assert.deepEqual(two.json, one.json, 'deterministic');
  assert.deepEqual(treeState(root), before, 'status writes nothing, not even a lock');
  const { result } = one.json;
  assert.equal(result.notice, DECISION_NOTICE);
  assert.deepEqual(result.namespaces.map((n) => n.namespace), ['reviews/app', 'reviews/zeta']);
  const app = result.namespaces[0];
  assert.deepEqual(app.runs.map((r) => [r.id, r.status]), [[p.id, 'incomplete'], [c.id, 'incomplete'], ['20261026-090004-task-o', 'open']]);
  assert.deepEqual(app.open_runs, ['20261026-090004-task-o']);
  // Outstanding debt: only the leaf of the closed chain (C); the open run is not counted.
  assert.deepEqual([app.debt.complete, app.debt.total, app.debt.items.map((d) => d.id)], [true, 1, [`${c.id}/D1`]]);
  assert.equal(app.debt.by_kind['owner-fact'], 1);
  assert.equal(app.debt.by_kind.runtime, 0);
  assert.deepEqual(app.findings.map((f) => [f.fingerprint, f.latest.run, f.latest.verdict, f.decision?.decision ?? null]), [
    ['a/first', p.id, 'candidate', 'false-positive'],
    ['b/second', c.id, 'confirmed', 'accept'],
  ]);
  assert.deepEqual(app.decisions.entries.map((e) => [e.seq, e.fingerprint, e.supersedes, e.superseded_by]), [[1, 'b/second', null, 2], [2, 'b/second', 1, null], [3, 'a/first', null, null]]);
  assert.deepEqual(app.decisions.orphans, []);

  // One namespace; an unknown one is refused; an unreadable run is reported, not fatal.
  assert.deepEqual(nthr(['status', '--ns', 'reviews/zeta'], { cwd: root }).json.result.namespaces.map((n) => n.namespace), ['reviews/zeta']);
  assert.equal(nthr(['status', '--ns', 'reviews/none'], { cwd: root }).code, EXIT.USAGE);
  fs.rmSync(path.join(root, '.nth-review', 'reviews', 'app', 'runs', p.id, 'records.json'));
  const damaged = nthr(['status', '--ns', NS], { cwd: root });
  assert.equal(damaged.code, EXIT.OK);
  const dns = damaged.json.result.namespaces[0];
  assert.equal(dns.runs[0].problem, '$: records.json is missing');
  assert.equal(dns.debt.complete, false);
  assert.deepEqual(dns.decisions.orphans, ['a/first'], 'a decided fingerprint no readable run has any more');
});

test('review fixes: status survives a bad file, without paths; decide refuses a file that would grow past its limit; a failed lock write leaves no lock', (t) => {
  const root = project(t);
  run(root, NS, 'a', 1, { findings: [finding('F-1', 'api/x')] });
  run(root, 'reviews/fine', 'f', 2, { findings: [finding('F-1', 'ok/y')] });

  // decisions.json as a directory, and a run whose records.json is a directory.
  fs.mkdirSync(decisionsFile(root, NS));
  const brokenRun = run(root, NS, 'b', 3);
  fs.rmSync(path.join(root, ...brokenRun.runDir.split('/'), 'records.json'));
  fs.mkdirSync(path.join(root, ...brokenRun.runDir.split('/'), 'records.json'));
  const r = nthr(['status'], { cwd: root });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const output = JSON.stringify(r.json);
  assert.ok(!output.includes(JSON.stringify(root).slice(1, -1)) && !output.includes(root), 'no absolute path in the output');
  const [app, fine] = r.json.result.namespaces;
  assert.deepEqual([app.decisions.valid, app.decisions.problem], [false, 'decisions.json cannot be read (NOT_FILE)']);
  assert.match(app.runs.find((x) => x.id === brokenRun.id).problem, /^records\.json cannot be read \([A-Z_]+\)$/);
  assert.equal(app.debt.complete, false);
  assert.equal(fine.decisions.valid, true, 'another namespace is still reported');
  fs.rmSync(decisionsFile(root, NS), { recursive: true });

  // A decisions.json close to its byte limit: an append that would pass it is refused, nothing written.
  const long = 'n'.repeat(4000);
  const LIMIT = 5 * 1024 * 1024;
  const text = (n) => `${JSON.stringify({ schema: 'nth-review/decisions@1', namespace: NS, decisions: Array.from({ length: n }, (_, i) => ({
    seq: i + 1, fingerprint: 'api/x', decision: 'accept', note: long, by: 'o', date: '2026-10-26T09:00:00Z',
    supersedes: i === 0 ? null : i, seen_in: [{ run: '20261026-090001-task-a', finding: 'F-1' }],
  })) }, null, 2)}\n`;
  // The largest file that still fits: one more entry would not.
  let count = Math.floor(LIMIT / (Buffer.byteLength(text(2)) - Buffer.byteLength(text(1))));
  while (Buffer.byteLength(text(count)) > LIMIT) count -= 1;
  assert.ok(Buffer.byteLength(text(count + 1)) > LIMIT);
  fs.writeFileSync(decisionsFile(root, NS), text(count));
  const nearlyFull = fs.readFileSync(decisionsFile(root, NS));
  const full = decideCli(root, NS, 'api/x', 4, { note: long });
  assert.equal(full.code, EXIT.USAGE, JSON.stringify(full.json).slice(0, 300));
  assert.match(full.json.errors[0], /would exceed 5242880 bytes, the most it can hold; nothing was written/);
  assert.ok(fs.readFileSync(decisionsFile(root, NS)).equals(nearlyFull));
  assert.equal(fs.existsSync(lockFile(root, NS)), false);
  fs.rmSync(decisionsFile(root, NS));

  // The lock is created but cannot be written: it is removed, never left orphaned.
  const realWrite = fs.writeSync;
  let failed = false;
  t.mock.method(fs, 'writeSync', (...args) => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return realWrite(...args);
  });
  assert.throws(() => decide(root, { ns: NS, fingerprint: 'api/x', decision: 'fix', note: 'n', by: 'o' }, { now: at(5) }), /disk full/);
  assert.equal(fs.existsSync(lockFile(root, NS)), false, 'no orphaned lock');
  assert.deepEqual(decide(root, { ns: NS, fingerprint: 'api/x', decision: 'fix', note: 'n', by: 'o' }, { now: at(6) }).errors, []);
});
