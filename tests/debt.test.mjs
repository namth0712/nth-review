// Debt continuity (decision C4; owner decision 2026-10-26: keep the strict
// complete/incomplete semantics) through real commands. A chain of runs:
// A hands on debt, B continues A and carries it, C continues B and
// discharges it, D continues C and inherits nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { makeRepo } from './helpers/repo.mjs';
import { at, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const NS = 'experiments/debt-chain';

// Opens a task run (optionally continuing another) and gives it one
// obligation, held or open, so it can be checked and closed.
function openRun(root, slug, second, { continues = null, obligation = 'held' } = {}) {
  const args = ['new-run', '--ns', NS, '--mode', 'task', '--slug', slug, '--change', '.', ...(continues ? ['--continues', continues] : [])];
  const opened = nthr(args, { cwd: root, now: at(second) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.obligations = [{
    id: 'OB-1', checks: ['DEBT'], claim: 'claim', scope: 'scope', acceptance: 'acceptance', coverage: 'named-subset', coverage_method: 'm',
    status: obligation, open_reason: obligation === 'open' ? 'needs-runtime' : null, source_trace: 'consistent',
    evidence: [{ anchor: 'src/a.js:1', note: 'e' }], intent: [], assumptions: [], links: [],
  }];
  writeRecords(root, runDir, doc);
  return { runDir, id: opened.json.result.run_id };
}

const edit = (root, runDir, change) => {
  const doc = readRecords(root, runDir);
  change(doc);
  writeRecords(root, runDir, doc);
  return doc;
};
const close = (root, runDir, second, args) => nthr(['close', '--run', runDir, ...args], { cwd: root, now: at(second) });

test('debt continuity: handed on, inherited complete, carried with the same id, discharged, then gone', (t) => {
  const root = fs.realpathSync.native(makeRepo(makeTempDir(t), { 'src/a.js': 'a\n' }));

  // A: an open obligation becomes debt handed on; A closes incomplete.
  const a = openRun(root, 'a', 1, { obligation: 'open' });
  const debtA = `${a.id}/D1`;
  edit(root, a.runDir, (d) => { d.debt.out = [{ id: debtA, kind: 'runtime', refs: ['OB-1'], requires: 'a runtime test', priority: 'medium' }]; });
  assert.equal(close(root, a.runDir, 2, ['--status', 'complete']).code, EXIT.INVALID, 'an open obligation cannot close complete');
  assert.equal(close(root, a.runDir, 2, ['--status', 'incomplete', '--reason', 'open-obligations']).code, EXIT.OK);

  // B continues A: it inherits exactly A's debt-out, undecided.
  const b = openRun(root, 'b', 3, { continues: a.id });
  assert.deepEqual(readRecords(root, b.runDir).debt.in, [{ id: debtA, from_run: a.id, disposition: null, note: null }]);
  // Dropping it is refused...
  edit(root, b.runDir, (d) => { d.debt.in = []; });
  const dropped = close(root, b.runDir, 4, ['--status', 'incomplete', '--reason', 'budget']);
  assert.equal(dropped.code, EXIT.INVALID);
  assert.ok(dropped.json.errors.some((e) => e.includes(`${debtA} from ${a.id} has no entry: debt cannot be dropped`)), dropped.json.errors.join('\n'));
  // ...carrying it without handing it on is refused...
  edit(root, b.runDir, (d) => { d.debt.in = [{ id: debtA, from_run: a.id, disposition: 'carried', note: null }]; });
  const lost = close(root, b.runDir, 4, ['--status', 'incomplete', '--reason', 'budget']);
  assert.equal(lost.code, EXIT.INVALID);
  assert.ok(lost.json.errors.some((e) => /a carried item must reappear in debt\.out/.test(e)));
  // ...and a run that carries debt is never complete.
  edit(root, b.runDir, (d) => { d.debt.out = [{ id: debtA, kind: 'runtime', refs: ['OB-1'], requires: 'a runtime test', priority: 'medium' }]; });
  const carriedComplete = close(root, b.runDir, 4, ['--status', 'complete']);
  assert.equal(carriedComplete.code, EXIT.INVALID);
  assert.ok(carriedComplete.json.errors.some((e) => /a complete run carries no open debt/.test(e)));
  assert.equal(close(root, b.runDir, 4, ['--status', 'incomplete', '--reason', 'budget']).code, EXIT.OK);

  // C continues B: the same id, now from B; discharged with a note, C completes.
  const c = openRun(root, 'c', 5, { continues: b.id });
  assert.deepEqual(readRecords(root, c.runDir).debt.in, [{ id: debtA, from_run: b.id, disposition: null, note: null }]);
  edit(root, c.runDir, (d) => { d.debt.in[0].disposition = 'discharged'; });
  assert.ok(close(root, c.runDir, 6, ['--status', 'complete']).json.errors.some((e) => /must explain why the item is discharged/.test(e)));
  edit(root, c.runDir, (d) => { d.debt.in[0].note = 'covered by the new runtime test'; });
  const completed = close(root, c.runDir, 6, ['--status', 'complete']);
  assert.equal(completed.code, EXIT.OK, JSON.stringify(completed.json));
  assert.match(fs.readFileSync(path.join(root, ...c.runDir.split('/'), 'report.md'), 'utf8'), new RegExp(`\\| ${debtA.replaceAll('/', '\\/')} \\| ${b.id} \\| discharged \\| covered by the new runtime test \\|`));

  // D continues C: nothing is left to inherit.
  const d = openRun(root, 'd', 7, { continues: c.id });
  assert.deepEqual(readRecords(root, d.runDir).debt.in, []);
  for (const run of [a, b, c]) assert.equal(nthr(['check', '--run', run.runDir], { cwd: root }).code, EXIT.OK, `${run.id} still checks`);
});
