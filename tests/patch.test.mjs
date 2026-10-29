// `apply` (the records writer) and the subagent discovery handoff (check),
// in disposable repositories.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { makeRepo } from './helpers/repo.mjs';
import { at, closeRun, nthr, readRecords, recordsFile, writeRecords } from './helpers/runs.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const patchFile = (root, runDir) => path.join(root, ...runDir.split('/'), 'patch.json');
const writePatch = (root, runDir, base, ops) => fs.writeFileSync(patchFile(root, runDir), JSON.stringify({ schema: 'nth-review/patch@1', base, ops }));
const apply = (root, runDir) => nthr(['apply', '--run', runDir], { cwd: root });

function openRun(t, ns = 'experiments/patch') {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { 'src/a.js': 'a\n', 'src/b.js': 'b\n', 'docs/spec.md': '# Rules\n' }));
  const opened = nthr(['new-run', '--ns', ns, '--mode', 'task', '--slug', 'p', '--change', '.'], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  return { root, runDir: opened.json.result.run_dir, base: opened.json.result.records_sha256 };
}

const obligation = (id, extra = {}) => ({
  id, checks: ['LOGIC.1'], claim: `${id} claim`, scope: 'src', acceptance: 'acceptance',
  coverage: 'named-subset', coverage_method: 'read', status: 'held', open_reason: null, source_trace: 'consistent',
  evidence: [{ anchor: 'src/a.js:1', note: 'read' }], intent: ['I1'], assumptions: [], links: [], ...extra,
});

test('apply: one batch of related updates in one write; the patch is removed; new digest and check result returned', (t) => {
  const { root, runDir, base } = openRun(t);
  assert.equal(base, sha(recordsFile(root, runDir)), 'new-run prints the digest of the records it wrote');
  writePatch(root, runDir, base, [
    { op: 'set', path: '/run/runtime/lead_model', value: 'claude-opus-5-5' },
    { op: 'set', path: '/run/runtime/lead_effort', value: 'high' },
    { op: 'set', path: '/scope/summary', value: 'screened' },
    { op: 'add', path: '/scope/intent', value: { id: 'I1', anchor: 'docs/spec.md#Rules', note: 'rules' } },
    { op: 'add', path: '/census/items', value: { id: 'CI-a', path: 'src/a.js', mechanism: 'module', status: 'classified', reason: null, affects: ['OB-1'] } },
    { op: 'add', path: '/obligations', value: obligation('OB-1', { status: 'open', open_reason: 'frontier', source_trace: 'not-traced', evidence: [] }) },
    { op: 'set', path: '/budget/spent/lead_tool_calls', value: 4 },
  ]);
  const r = apply(root, runDir);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  assert.equal(r.json.result.applied, 7);
  assert.ok(!fs.existsSync(patchFile(root, runDir)), 'patch.json is removed after it is applied');
  assert.equal(r.json.result.records_sha256, sha(recordsFile(root, runDir)));
  assert.equal(r.json.result.check.valid, true, JSON.stringify(r.json.result.check));
  const doc = readRecords(root, runDir);
  assert.equal(doc.obligations[0].id, 'OB-1');
  assert.equal(doc.run.runtime.lead_effort, 'high');

  // Items are addressed by id: a second batch updates one field of each.
  const second = r.json.result.records_sha256;
  writePatch(root, runDir, second, [
    { op: 'set', path: '/obligations/OB-1/status', value: 'held' },
    { op: 'set', path: '/obligations/OB-1/open_reason', value: null },
    { op: 'set', path: '/obligations/OB-1/source_trace', value: 'consistent' },
    { op: 'add', path: '/obligations/OB-1/evidence', value: { anchor: 'src/a.js:1', note: 'read' } },
    { op: 'remove', path: '/census/items/CI-a' },
    { op: 'add', path: '/census/items', value: { id: 'CI-a2', path: 'src/*.js', mechanism: 'modules', status: 'classified', reason: null, affects: ['OB-1'] } },
  ]);
  const r2 = apply(root, runDir);
  assert.equal(r2.code, EXIT.OK, JSON.stringify(r2.json));
  const after = readRecords(root, runDir);
  assert.deepEqual([after.obligations[0].status, after.obligations[0].evidence.length, after.census.items.map((i) => i.id)], ['held', 1, ['CI-a2']]);
  // check and the failure output carry the digest too.
  const checked = nthr(['check', '--run', runDir], { cwd: root });
  assert.equal(checked.json.result.records_sha256, sha(recordsFile(root, runDir)));
});

test('apply refuses a stale, protected, invalid or malformed patch and writes nothing', (t) => {
  const { root, runDir, base } = openRun(t);
  const before = fs.readFileSync(recordsFile(root, runDir));
  const refused = (ops, pattern, { stale = false, raw } = {}) => {
    if (raw !== undefined) fs.writeFileSync(patchFile(root, runDir), raw);
    else writePatch(root, runDir, stale ? 'f'.repeat(64) : base, ops);
    const r = apply(root, runDir);
    assert.equal(r.code, EXIT.INVALID, JSON.stringify(r.json));
    assert.match(r.json.errors.join('\n'), pattern);
    assert.equal(r.json.records_sha256, base, 'the refusal names the current digest');
    assert.ok(fs.readFileSync(recordsFile(root, runDir)).equals(before), 'records.json unchanged');
    assert.ok(fs.existsSync(patchFile(root, runDir)), 'the refused patch stays for the lead to fix');
  };
  refused([{ op: 'set', path: '/scope/summary', value: 'x' }], /stale: records\.json changed since/, { stale: true });
  for (const [p, value] of [
    ['/snapshot/reconstructible', true],
    ['/budget/lead_tool_calls', 999],
    ['/budget/spent/wall_clock_min', 1],
    ['/run/status', 'complete'],
    ['/run/id', 'x'],
    ['/scope/change', []],
    ['/footprint', {}],
    ['/schema', 'x'],
    ['/obligations', []],
  ]) refused([{ op: 'set', path: '/scope/summary', value: 'ok' }, { op: 'set', path: p, value }], /refused: /);
  refused([{ op: 'add', path: '/debt/in', value: { id: 'x', from_run: 'y', disposition: null, note: null } }], /refused: debt\.in comes from the parent run/);
  refused([{ op: 'set', path: '/scope/summary', value: 42 }], /summary/);
  // Seen in a real run: replacing the whole intent list names the right fix.
  refused([{ op: 'set', path: '/scope/intent', value: [] }], /scope\.intent is never replaced or removed whole: add each entry/);
  refused([{ op: 'add', path: '/obligations', value: obligation('OB-1') }, { op: 'add', path: '/obligations', value: obligation('OB-1') }], /OB-1 already exists/);
  refused([{ op: 'set', path: '/obligations/OB-9/status', value: 'held' }], /does not exist/);
  refused([{ op: 'rename', path: '/scope/summary' }], /op must be one of set, add, remove/);
  refused([], /must be nth-review\/patch@1/, { raw: JSON.stringify({ schema: 'x', base, ops: [] }) });
  refused([], /not valid JSON/, { raw: '{ not json' });
});

test('apply interrupted after its write: the leftover patch is refused as stale, never applied twice; an empty batch clears it', (t) => {
  const { root, runDir, base } = openRun(t);
  // Items without an id: resending this batch would append them again.
  const batch = [
    { op: 'add', path: '/checks', value: { command: 'git diff --stat', cwd: '.', result: 'ok', proves: 'size', not_proven: 'behaviour' } },
    { op: 'set', path: '/budget/spent/lead_tool_calls', value: 3 },
  ];
  writePatch(root, runDir, base, batch);
  const leftover = fs.readFileSync(patchFile(root, runDir));
  const first = apply(root, runDir);
  assert.equal(first.code, EXIT.OK, JSON.stringify(first.json));
  // The crash window: records.json written, patch.json not yet removed.
  fs.writeFileSync(patchFile(root, runDir), leftover);
  const written = fs.readFileSync(recordsFile(root, runDir));

  const again = apply(root, runDir);
  assert.equal(again.code, EXIT.INVALID, JSON.stringify(again.json));
  assert.match(again.json.errors.join('\n'), /stale[\s\S]*interrupted apply[\s\S]*never resend[\s\S]*empty ops/);
  assert.equal(again.json.records_sha256, first.json.result.records_sha256);
  assert.deepEqual(fs.readFileSync(recordsFile(root, runDir)), written, 'nothing is written');
  assert.equal(readRecords(root, runDir).checks.length, 1, 'the batch is in once');

  // Clearing it: an empty batch on the current digest only removes the patch.
  writePatch(root, runDir, first.json.result.records_sha256, []);
  const cleared = apply(root, runDir);
  assert.equal(cleared.code, EXIT.OK, JSON.stringify(cleared.json));
  assert.equal(cleared.json.result.applied, 0);
  assert.ok(!fs.existsSync(patchFile(root, runDir)));
  assert.deepEqual(readRecords(root, runDir), JSON.parse(written.toString('utf8')), 'the records are unchanged');
});

test('apply never writes a closed run; close and check refuse a pending patch', (t) => {
  const { root, runDir, base } = openRun(t);
  writePatch(root, runDir, base, []);
  const close = nthr(['close', '--run', runDir, '--status', 'incomplete', '--reason', 'owner-stopped'], { cwd: root, now: at(2) });
  assert.equal(close.code, EXIT.INVALID, JSON.stringify(close.json));
  assert.match(close.json.errors.join('\n'), /a closed run holds no pending patch/);
  assert.equal(apply(root, runDir).code, EXIT.OK, 'an empty patch clears it');

  closeRun(root, runDir, { status: 'incomplete', reason: 'owner-stopped' });
  writePatch(root, runDir, sha(recordsFile(root, runDir)), [{ op: 'set', path: '/scope/summary', value: 'late' }]);
  const late = apply(root, runDir);
  assert.equal(late.code, EXIT.USAGE, JSON.stringify(late.json));
  assert.match(late.json.errors[0], /is incomplete; a closed run is never written/);
  const checked = nthr(['check', '--run', runDir], { cwd: root });
  assert.match(checked.json.errors.join('\n'), /patch\.json: a closed run holds no pending patch/);
  assert.equal(checked.json.records_sha256, sha(recordsFile(root, runDir)), 'a failing check names the digest');
});

// A closed run whose R3 named `discovered`; `edit` disposes of them.
function discoveryRun(t, discovered, edit) {
  const { root, runDir } = openRun(t, 'experiments/disc');
  const doc = readRecords(root, runDir);
  doc.scope.intent = [{ id: 'I1', anchor: 'docs/spec.md#Rules', note: 'rules' }];
  doc.obligations = [obligation('OB-1')];
  doc.census.items = [{ id: 'CI-a', path: 'src/a.js', mechanism: 'module', status: 'classified', reason: null, affects: ['OB-1'] }];
  doc.delegations = [{ role: 'R3', agent: 'Explore', model: 'sonnet', effort: null, budget_calls: 30, tool_uses: 5, tokens: 100, completed: true, recovery_messages: 0, discovered }];
  doc.budget.spent.subagent_calls = 1;
  doc.budget.spent.subagent_tokens = 100;
  edit?.(doc);
  writeRecords(root, runDir, doc);
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  closeRun(root, runDir, { status: 'incomplete', reason: 'open-obligations' });
  return nthr(['check', '--run', runDir], { cwd: root });
}

test('discovery handoff: every path a delegate found needs a census disposition before close', (t) => {
  const missing = discoveryRun(t, ['src/b.js']);
  assert.equal(missing.code, EXIT.INVALID);
  assert.match(missing.json.errors.join('\n'), /\$\.delegations\[0\]\.discovered\[0\]: src\/b\.js \(found by R3\) has no census disposition/);

  const item = (fields) => (doc) => doc.census.items.push({ id: 'CI-b', path: 'src/b.js', mechanism: 'helper', reason: null, affects: null, ...fields });
  // Covered, excluded, or excluded by affects null with a reason; a group item covers it too.
  for (const edit of [
    item({ status: 'classified', affects: ['OB-1'] }),
    item({ status: 'excluded', reason: 'test helper only' }),
    item({ status: 'classified', reason: 'not on a changed path' }),
    item({ path: 'src/*.js', status: 'classified', affects: ['OB-1'] }),
  ]) {
    const ok = discoveryRun(t, ['src/b.js'], edit);
    assert.equal(ok.code, EXIT.OK, JSON.stringify(ok.json));
  }

  // Unresolved: unknown in the census, and debt that names the path.
  const unknown = item({ status: 'unknown', reason: 'not traced within budget' });
  const noDebt = discoveryRun(t, ['src/b.js'], unknown);
  assert.match(noDebt.json.errors.join('\n'), /src\/b\.js \(found by R3\) is unknown in the census; record frontier or deferred-scope debt/);
  const withDebt = discoveryRun(t, ['src/b.js'], (doc) => {
    unknown(doc);
    doc.debt.out.push({ id: `${doc.run.id}/D1`, kind: 'frontier', refs: ['OB-1'], requires: 'trace src/b.js callers', priority: 'medium' });
  });
  assert.equal(withDebt.code, EXIT.OK, JSON.stringify(withDebt.json));

  // A delegation without the field (older records) needs nothing.
  const legacy = discoveryRun(t, undefined, (doc) => { delete doc.delegations[0].discovered; });
  assert.equal(legacy.code, EXIT.OK, JSON.stringify(legacy.json));
});
