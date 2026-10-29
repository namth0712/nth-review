// v1.0 release-candidate product experience (2026-10-28): `preview` before a
// run opens, the report's Summary and Helper row, the follow-up command, and
// `status`'s next step. Disposable repositories only, through the real CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT, VERSION } from '../scripts/lib/cli.mjs';
import { followUpCommand } from '../scripts/lib/render.mjs';
import { makeRepo, write } from './helpers/repo.mjs';
import { at, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const NS = 'experiments/ux';
const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const project = (t, files = {}) => fs.realpathSync.native(makeRepo(makeTempDir(t), { 'src/a.js': numbered(30), ...files }));
const ob = (id, coverage) => ({
  id, checks: ['LOGIC.1'], claim: `${id} claim`, scope: 'scope', acceptance: 'acceptance', coverage, coverage_method: `${id} method`,
  status: 'held', open_reason: null, source_trace: 'consistent', evidence: [{ anchor: 'src/a.js:3-5', note: 'e' }], intent: [], assumptions: [], links: [],
});

test('preview: what new-run would open, with the same refusals, and nothing written', (t) => {
  const root = project(t);
  const index = fs.readFileSync(path.join(root, '.git', 'index'));
  const args = ['--ns', NS, '--mode', 'task', '--slug', 'p', '--change', '.:HEAD..HEAD'];
  const preview = nthr(['preview', ...args], { cwd: root, now: at(1) });
  assert.equal(preview.code, EXIT.OK, JSON.stringify(preview.json));
  assert.ok(!fs.existsSync(path.join(root, '.nth-review')), 'no review directory');
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), index, 'the Git index is untouched');
  const { writes, start, note, ...shown } = preview.json.result;
  assert.equal(writes, 'nothing');
  assert.match(note, /sizes the source again/);
  assert.deepEqual(start, ['claude --model opus --effort high', 'claude --model sonnet'], 'size S allows Sonnet');
  const opened = nthr(['new-run', ...args], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, 'new-run still opens after a preview');
  const { run_dir: _d, run_id: _i, records_sha256: _s, ...expected } = opened.json.result;
  assert.deepEqual(shown, expected, 'the preview is what new-run returned, without the run id');
  // Refusal parity: an open run, a task without --change, an audit namespace.
  for (const bad of [args, ['--ns', 'experiments/ux2', '--mode', 'task', '--slug', 'p'], ['--ns', 'audits/x', '--mode', 'audit-plan', '--slug', 'p']]) {
    const a = nthr(['preview', ...bad], { cwd: root, now: at(2) });
    const b = nthr(['new-run', ...bad], { cwd: root, now: at(2) });
    assert.equal(a.code, EXIT.USAGE, JSON.stringify(a.json));
    assert.deepEqual(a.json.errors, b.json.errors);
  }
  // A larger change needs Opus at high effort only.
  const big = project(t, { 'src/big.js': numbered(500) });
  write(big, 'src/big.js', numbered(500).replaceAll('line', 'LINE')); // 1,000 changed lines: size M
  const m = nthr(['preview', '--ns', NS, '--mode', 'task', '--slug', 'm', '--change', '.'], { cwd: big, now: at(1) });
  assert.equal(m.json.result.required_lead_model, 'opus-high');
  assert.deepEqual(m.json.result.start, ['claude --model opus --effort high']);
});

test('report Summary: complete is not Verified, the counts match section 3, and the next step names the base', (t) => {
  const root = project(t);
  const opened = nthr(['new-run', '--ns', NS, '--mode', 'task', '--slug', 'r', '--change', '.:HEAD..HEAD'], { cwd: root, now: at(1) });
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  Object.assign(doc.run.runtime, { lead_model: 'claude-opus-5-5', lead_effort: 'high' });
  doc.obligations = [ob('OB-1', 'all-enumerated'), ob('OB-2', 'named-subset')];
  writeRecords(root, runDir, doc);
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  const closed = nthr(['close', '--run', runDir, '--status', 'complete'], { cwd: root, now: at(3) });
  assert.equal(closed.code, EXIT.OK, JSON.stringify(closed.json));
  const report = fs.readFileSync(path.join(root, ...runDir.split('/'), 'report.md'), 'utf8');
  assert.ok(report.indexOf('## Summary') < report.indexOf('## 1. Gaps'), 'the Summary comes first');
  assert.match(report, new RegExp(`\\| Helper \\| nthr ${VERSION.replaceAll('.', '\\.')} · protocol v0\\.1 · records nth-review/records@1 \\|`));
  assert.match(report, /`complete`: the run finished its method .* That is not a verdict on the code: only the obligations marked Verified in section 3 are Verified/);
  const verifiedRows = report.match(/^\| OB-\d+ .*\| Verified \|$/gm)?.length ?? 0;
  assert.equal(verifiedRows, 1);
  assert.match(report, /Obligations: 2 held \(1 Verified\), 0 violated, 0 open/);
  assert.match(report, new RegExp(`Next step: \`/nth-review incremental --ns ${NS} --slug <new-slug> --base ${opened.json.result.run_id}\``));
  // Cost: what the lead reported is labelled as such, apart from what the helper computed.
  assert.match(report, /^\| Lead tool calls \| \d+ \| \d+ \| recorded by the lead \|$/m);
  assert.match(report, /^\| Open to close \(minutes\) \| – \| [\d.]+ \| computed by close \|$/m);
  assert.match(report, /^The helper cannot observe tool calls/m);
});

test('follow-up command: flow runs are never a baseline; audit runs point at status', () => {
  const flow = { run: { mode: 'flow', namespace: 'reviews/orders', id: 'x' }, scope: { entries: [{ selector: 'src/o.js#create' }, { selector: 'api/r.js:3-9' }] } };
  const command = followUpCommand(flow.run, flow);
  assert.match(command, /^\/nth-review flow --ns reviews\/orders --slug <new-slug> --entry src\/o\.js#create --entry api\/r\.js:3-9 /);
  assert.ok(!command.includes('incremental') && !command.includes('--base'));
  assert.equal(followUpCommand({ mode: 'audit-plan', namespace: 'audits/core', id: 'p' }, { scope: {} }), 'nthr status --ns audits/core');
});

test('status: each namespace names its next step: continue the open run, finish an interrupted resume, or follow up', (t) => {
  const root = project(t);
  const next = () => nthr(['status', '--ns', NS], { cwd: root }).json.result.namespaces[0].next;
  const opened = nthr(['new-run', '--ns', NS, '--mode', 'task', '--slug', 's', '--change', '.:HEAD..HEAD'], { cwd: root, now: at(1) });
  assert.deepEqual(next(), { reason: 'open', run: opened.json.result.run_id, command: `nthr resume --ns ${NS}` });
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.obligations = [Object.assign(ob('OB-1', 'named-subset'), { status: 'open', open_reason: 'budget' })];
  writeRecords(root, runDir, doc);
  assert.equal(nthr(['footprint', '--run', runDir], { cwd: root }).code, EXIT.OK);
  assert.equal(nthr(['close', '--run', runDir, '--status', 'incomplete', '--reason', 'open-obligations'], { cwd: root, now: at(2) }).code, EXIT.OK);
  assert.deepEqual(next(), { reason: 'closed', run: opened.json.result.run_id, command: `/nth-review incremental --ns ${NS} --slug <new-slug> --base ${opened.json.result.run_id}` });
  // An abandoned run that no run continues: finish the interrupted resume.
  const abandoned = { ...doc, run: { ...doc.run, id: '20261026-090005-task-s', status: 'abandoned', incomplete_reason: 'snapshot-changed', closed: '2026-10-26T09:00:06Z' } };
  writeRecords(root, `.nth-review/${NS}/runs/20261026-090005-task-s`, abandoned);
  assert.deepEqual(next(), { reason: 'interrupted', run: '20261026-090005-task-s', command: `nthr resume --ns ${NS} --apply` });
  // An unreadable run: nothing is certain.
  fs.writeFileSync(path.join(root, '.nth-review', ...NS.split('/'), 'runs', '20261026-090005-task-s', 'records.json'), '{');
  assert.equal(next(), null);
});
