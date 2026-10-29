// M5-T2: the transcript metrics tool, on synthetic transcripts in the observed
// Claude Code format. Each test builds the records it needs; none reads a real
// session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { analyze, loadSession, readJsonl } from './tools/transcript-metrics.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const T0 = Date.UTC(2026, 9, 26, 15, 0, 0);
const ts = (s) => new Date(T0 + s * 1000).toISOString();
const usage = (input, output, cc = 0, cr = 0, thinking = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens_details: { thinking_tokens: thinking } });
const assistant = (s, id, block, { model = 'claude-opus-5-5', u = usage(1, 10), effort = 'high', extra = {} } = {}) => ({
  type: 'assistant', uuid: `u-${id}-${s}`, timestamp: ts(s), requestId: `req-${id}`, perTurnEffort: effort, effort,
  message: { id, model, usage: u, content: [block] }, ...extra,
});
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (s, id, { error = false, text = 'ok', decision = null, denial = null, extra = null } = {}) => ({
  type: 'user', uuid: `r-${id}`, timestamp: ts(s), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: text }] },
  ...(decision ? { permissionDecision: decision } : {}), ...(denial ? { toolDenialKind: denial } : {}), ...(extra ? { toolUseResult: extra } : {}),
});

// Writes a session (and its delegates) under a temporary projects folder.
function session(t, rows, children = []) {
  const dir = makeTempDir(t, 'nthr-tx-');
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  if (children.length) {
    const sub = path.join(dir, 'sess', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    for (const c of children) {
      fs.writeFileSync(path.join(sub, `agent-${c.id}.jsonl`), c.rows.map((r) => JSON.stringify(r)).join('\n'));
      if (c.meta) fs.writeFileSync(path.join(sub, `agent-${c.id}.meta.json`), JSON.stringify(c.meta));
    }
  }
  return { dir, file, fixture: path.join(dir, 'fixture') };
}
const run = (s, opts = {}) => analyze({ session: loadSession(s.file), fixture: s.fixture, tmp: path.dirname(s.dir), home: path.join(path.dirname(s.dir), 'home'), ...opts });

test('usage: one record per API message, streamed updates keep the final count, duplicates are dropped', (t) => {
  const s = session(t, [
    assistant(1, 'm1', { type: 'thinking', thinking: '' }, { u: usage(2, 100, 50, 1000, 20) }),
    assistant(1, 'm1', toolUse('t1', 'Read', { file_path: 'a.js' }), { u: usage(2, 100, 50, 1000, 20) }),
    assistant(1, 'm1', toolUse('t2', 'Read', { file_path: 'b.js' }), { u: usage(2, 100, 50, 1000, 20) }),
    result(2, 't1'), result(2, 't2'),
    assistant(3, 'm2', { type: 'text', text: 'partial' }, { u: usage(1, 5) }),
    assistant(3, 'm2', { type: 'text', text: 'final' }, { u: usage(1, 40) }),
  ]);
  const m = run(s);
  assert.deepEqual(m.lead.usage.totals, { input: 3, output: 140, cache_creation: 50, cache_read: 1000, thinking: 20 });
  assert.equal(m.lead.usage.messages, 2);
  assert.equal(m.lead.usage.duplicates_dropped, 3);
  assert.equal(m.lead.usage.messages_updated, 1);
  assert.equal(m.lead.usage.status, 'observed');
  assert.equal(m.lead.tool_calls.total, 2);
});

test('missing usage, effort and timestamps are reported as unavailable or partial, never invented', (t) => {
  const noUsage = assistant(1, 'm1', toolUse('t1', 'Glob', { pattern: '*.js' }), { u: undefined });
  delete noUsage.message.usage;
  const noEffort = assistant(3, 'm2', { type: 'text', text: 'x' });
  delete noEffort.perTurnEffort; delete noEffort.effort; delete noEffort.timestamp;
  const s = session(t, [noUsage, result(2, 't1'), noEffort, '{not json']);
  const m = run(s);
  assert.equal(m.lead.usage.messages_without_usage, 1);
  assert.equal(m.lead.usage.status, 'partial');
  assert.equal(m.lead.usage.totals.output, 10, 'only the message that has usage counts');
  assert.equal(m.lead.effort.status, 'partial');
  assert.equal(m.lead.effort.turns_without_effort, 1);
  assert.equal(m.runtime.timed_records_without_timestamp, 1);
  assert.equal(m.runtime.status, 'partial');
  assert.equal(m.sources.unparseable_lines.session, 1);
  assert.equal(m.cost.transcript.status, 'unavailable');
  assert.equal(m.cost.agreement, 'unavailable');
});

test('mixed models and a changed effort are listed, and xhigh is a routing violation', (t) => {
  const s = session(t, [
    assistant(1, 'm1', { type: 'text', text: 'a' }, { effort: 'high' }),
    assistant(2, 'm2', { type: 'text', text: 'b' }, { effort: 'xhigh' }),
    assistant(3, 'm3', { type: 'text', text: 'c' }, { model: 'claude-sonnet-5-5', effort: 'high' }),
    assistant(4, 'm4', { type: 'text', text: 'd' }, { model: 'claude-haiku-5-5', effort: 'high' }),
  ]);
  const m = run(s);
  assert.deepEqual(m.lead.models.changes, ['claude-opus-5-5->claude-sonnet-5-5', 'claude-sonnet-5-5->claude-haiku-5-5']);
  assert.deepEqual(m.lead.effort.changes, ['high->xhigh', 'xhigh->high']);
  assert.ok(m.routing.violations.includes('lead effort xhigh'));
  assert.ok(m.routing.violations.includes('lead model claude-haiku-5-5'));
});

test('delegations: launch, linked transcript, reported totals, recoveries, and an opus delegate without effort high', (t) => {
  const child = { id: 'abc123', meta: { toolUseId: 'tA', model: 'opus', effort: 'high', finished: true }, rows: [
    assistant(5, 'c1', toolUse('ct1', 'Read', { file_path: 'x.js' }), { u: usage(1, 30, 100, 500), extra: { isSidechain: true } }),
    result(6, 'ct1'),
    assistant(7, 'c2', { type: 'text', text: 'answer' }, { u: usage(1, 50, 10, 600), extra: { isSidechain: true } }),
  ] };
  const s = session(t, [
    assistant(1, 'm1', toolUse('tA', 'Agent', { subagent_type: 'reviewer', model: 'opus', effort: 'high', description: 'R5 refute F-1' })),
    assistant(2, 'm2', toolUse('tB', 'Agent', { subagent_type: 'reviewer', model: 'opus', description: 'R5 refute F-2' })),
    result(8, 'tA', { extra: { status: 'completed', agentId: 'abc123', resolvedModel: 'claude-opus-5-5', totalTokens: 661, totalToolUseCount: 1, totalDurationMs: 2000 } }),
    assistant(9, 'm3', toolUse('tS', 'SendMessage', { to: 'abc123', message: 'finish' })),
    result(10, 'tS'),
  ], [child]);
  const m = run(s);
  const [a, b] = m.delegations;
  assert.equal(a.role.value, 'R5');
  assert.equal(a.status.value, 'completed');
  assert.equal(a.reported.total_tokens, 661);
  assert.equal(a.transcript.status, 'observed');
  assert.deepEqual(a.transcript.usage.totals, { input: 2, output: 80, cache_creation: 110, cache_read: 1100, thinking: 0 });
  assert.equal(a.recovery_messages.value, 1);
  assert.equal(b.status.value, 'no-result', 'an interrupted delegation');
  assert.equal(b.transcript.status, 'unavailable', 'its transcript is missing');
  assert.equal(m.safety.gaps.delegations_without_transcript, 1);
  assert.equal(m.safety.gaps.lead_tool_uses_without_result, 1);
  assert.ok(m.routing.violations.some((v) => /opus delegation without effort high/.test(v)));
});

test('rc.2: a call to the bundled nth-review:reviewer matches its record as reviewer; another agent still differs', (t) => {
  const records = (agent) => ({ run: { runtime: {} }, budget: { lead_tool_calls: 10, spent: {} }, delegations: [{ role: 'R6', agent, model: 'sonnet', effort: null, completed: true, recovery_messages: 0, tool_uses: 3, tokens: 10 }] });
  const s = (type) => session(t, [
    assistant(1, 'm1', toolUse('tA', 'Agent', { subagent_type: type, model: 'sonnet', description: 'R6 refute F-1' })),
    result(2, 'tA', { extra: { status: 'completed', agentId: 'zzz', totalTokens: 10, totalToolUseCount: 3 } }),
  ]);
  const item = (m) => m.records_comparison.items.find((i) => i.field.startsWith('delegations[0]'));
  const bundled = run(s('nth-review:reviewer'), { records: records('reviewer') });
  assert.ok(!/agent/.test(item(bundled).note ?? ''), item(bundled).note);
  assert.equal(bundled.delegations[0].subagent_type, 'nth-review:reviewer', 'the observed call keeps its own name');
  assert.match(item(run(s('general-purpose'), { records: records('reviewer') })).note, /agent reviewer vs general-purpose/);
});

test('a session without its delegate folder reports the transcripts unavailable', (t) => {
  const s = session(t, [
    assistant(1, 'm1', toolUse('tA', 'Agent', { subagent_type: 'Explore', model: 'sonnet', description: 'R3 plan-critique' })),
    result(2, 'tA', { extra: { status: 'completed', agentId: 'zzz', totalTokens: 10, totalToolUseCount: 3 } }),
  ]);
  const m = run(s);
  assert.equal(m.sources.delegate_transcripts, 'unavailable');
  assert.equal(m.safety.gaps.delegate_folder, 'absent');
  assert.equal(m.delegations[0].transcript.status, 'unavailable');
  assert.equal(m.usage.delegates_cumulative.status, 'unavailable');
});

test('permission denials, writes outside the fixture, inline-code writes and their outcomes', (t) => {
  const s0 = session(t, []);
  const outside = path.join(path.dirname(s0.dir), 'elsewhere', 'cp1.cjs');
  const s = session(t, [
    assistant(1, 'm1', toolUse('w1', 'Write', { file_path: outside, content: 'x' })),
    result(2, 'w1', { error: true, decision: { decision: 'reject', reasonCode: 'workingDir' }, denial: 'user-rejected' }),
    assistant(3, 'm2', toolUse('b1', 'Bash', { command: 'node -e \'require("fs").writeFileSync("records.json","{}")\'' })),
    result(4, 'b1', { error: true, decision: { decision: 'reject', reasonCode: 'bashMiss:too-complex' } }),
    assistant(5, 'm3', toolUse('e1', 'Edit', { file_path: '.nth-review/x/records.json', old_string: 'a', new_string: 'b' })),
    result(6, 'e1'),
    assistant(7, 'm4', toolUse('b2', 'Bash', { command: 'echo hi > notes.txt' })),
    result(8, 'b2', { error: true, text: 'failed' }),
  ]);
  const stream = { rows: [{ type: 'result', permission_denials: [{}, {}, {}] }], unparseable: [] };
  const m = run(s, { stream });
  assert.equal(m.safety.denials.count, 2);
  assert.equal(m.safety.denials.agreement, 'contradictory', 'the stream reports 3');
  const byTool = Object.fromEntries(m.safety.writes.map((w) => [w.tool_use, w]));
  assert.equal(byTool[('w1').slice(-8)].outcome, 'denied');
  assert.equal(byTool.w1.inside_fixture, false);
  assert.equal(byTool.b1.kind, 'inline code');
  assert.equal(byTool.b1.outcome, 'denied');
  assert.equal(byTool.e1.outcome, 'executed');
  assert.equal(byTool.b2.outcome, 'failed');
  assert.ok(m.safety.outside_paths.some((o) => o.tool === 'Write' && o.path.startsWith('<tmp>/')));
  assert.ok(!JSON.stringify(m).includes(path.dirname(s0.dir).replace(/\\/g, '/')), 'no absolute path in the output');
  assert.ok(!JSON.stringify(m).includes(path.dirname(s0.dir)), 'no absolute path in the output');
});

test('suspicious access: outside reads, parent escapes, secrets, answers, git writes, network and web', (t) => {
  const s0 = session(t, []);
  const out = path.join(path.dirname(s0.dir), 'kit', 'tests', 'fixtures', 'syn-ledger', 'answers.json');
  const s = session(t, [
    assistant(1, 'm1', toolUse('r1', 'Read', { file_path: out })),
    result(2, 'r1'),
    assistant(3, 'm2', toolUse('b1', 'Bash', { command: 'cat ../../secrets/.env' })),
    result(4, 'b1'),
    assistant(5, 'm3', toolUse('b2', 'Bash', { command: 'git -C api commit -m x' })),
    result(6, 'b2'),
    assistant(7, 'm4', toolUse('b3', 'Bash', { command: 'curl https://example.com' })),
    result(8, 'b3'),
    assistant(9, 'm5', toolUse('f1', 'WebFetch', { url: 'https://example.com' })),
    result(10, 'f1'),
    assistant(11, 'm6', toolUse('b4', 'Bash', { command: 'git -C api log --oneline -3' })),
    result(12, 'b4'),
  ]);
  const m = run(s);
  assert.ok(m.safety.outside_paths.some((o) => o.tool === 'Read'));
  assert.ok(m.safety.outside_paths.some((o) => o.heuristic && o.path.startsWith('<tmp>/')), 'a climbing relative path resolved outside the fixture');
  assert.ok(m.safety.sensitive.some((x) => x.tool === 'Read'), 'answers path');
  assert.ok(m.safety.sensitive.some((x) => x.tool === 'Bash' && /\.env/.test(x.command)));
  assert.equal(m.safety.git_writes.length, 1, 'git log is read-only');
  assert.equal(m.safety.network.length, 1);
  assert.equal(m.safety.web.length, 1);
  assert.match(m.safety.isolation_note, /not proof of sandbox isolation/);
});

test('M5-T4R audit: a Glob pattern or Grep glob that reaches outside the fixture is an outside access; one inside is not', (t) => {
  const s0 = session(t, []);
  const old = path.join(path.dirname(s0.dir), 'wa-OLD111').replace(/\\/g, '/');
  const s = session(t, [
    assistant(1, 'm1', toolUse('g1', 'Glob', { pattern: `${old}/**/records.json` })), result(2, 'g1'),
    assistant(3, 'm2', toolUse('g2', 'Glob', { pattern: '../wa-*/**' })), result(4, 'g2'),
    assistant(5, 'm3', toolUse('g3', 'Grep', { pattern: 'findings', glob: '../../wa-OLD111/**' })), result(6, 'g3'),
    assistant(7, 'm4', toolUse('g4', 'Glob', { pattern: '.nth-review/**/records.json' })), result(8, 'g4'),
    assistant(9, 'm5', toolUse('g5', 'Grep', { pattern: '/etc/passwd|..', glob: '*.js' })), result(10, 'g5'),
  ]);
  const m = run(s);
  const at = (id) => m.safety.outside_paths.filter((o) => o.tool_use === id.slice(-8));
  for (const id of ['g1', 'g2', 'g3']) assert.equal(at(id).length, 1, `${id} is outside`);
  assert.match(at('g1')[0].heuristic, /Glob pattern placed by its fixed prefix/);
  assert.equal(at('g4').length, 0, 'a pattern inside the fixture');
  assert.equal(at('g5').length, 0, "Grep's pattern is a regular expression, not a path");
});

test('cost: transcript and stream agree, disagree, or are unavailable; nothing is estimated', (t) => {
  const state = (usd) => ({ type: 'cost-state', totalCostUSD: usd, totalDuration: 1000, modelUsage: { 'claude-opus-5-5': { costUSD: usd } }, hasUnknownModelCost: false });
  const s = session(t, [assistant(1, 'm1', { type: 'text', text: 'x' }), state(1.25)]);
  const agree = run(s, { stream: { rows: [{ type: 'result', total_cost_usd: 1.25, modelUsage: { 'claude-opus-5-5': { costUSD: 1.25, costBasis: 'list' } } }], unparseable: [] } });
  assert.equal(agree.cost.agreement, 'agree');
  assert.deepEqual(agree.cost.stream.basis, ['list']);
  const disagree = run(s, { stream: { rows: [{ type: 'result', total_cost_usd: 2 }], unparseable: [] } });
  assert.equal(disagree.cost.agreement, 'contradictory');
  const none = run(session(t, [assistant(1, 'm1', { type: 'text', text: 'x' })]));
  assert.equal(none.cost.transcript.status, 'unavailable');
  assert.equal(none.cost.stream.status, 'unavailable');
  assert.ok(none.cost.limitations.some((l) => /no cost is estimated/.test(l)));
});

test('timestamps: sub-second reordering is tolerated; a larger backward step is partial; disagreeing durations are contradictory', (t) => {
  const small = run(session(t, [
    { type: 'queue-operation', timestamp: ts(10) },
    { type: 'attachment', uuid: 'a', timestamp: new Date(T0 + 9900).toISOString() },
    assistant(12, 'm1', { type: 'text', text: 'x' }),
  ]));
  assert.equal(small.runtime.reordered_records, 1);
  assert.equal(small.runtime.status, 'observed');
  const bigSession = session(t, [assistant(20, 'm1', { type: 'text', text: 'x' }), assistant(5, 'm2', { type: 'text', text: 'y' })]);
  const big = run(bigSession);
  assert.equal(big.runtime.backward_steps_over_1s, 1);
  assert.equal(big.runtime.max_backward_ms, 15000);
  assert.equal(big.runtime.status, 'partial', 'file order alone is never a contradiction');
  const agreeing = run(bigSession, { stream: { rows: [{ type: 'result', duration_ms: 15200 }], unparseable: [] } });
  assert.equal(agreeing.runtime.duration_agreement, 'agree');
  const disagreeing = run(bigSession, { stream: { rows: [{ type: 'result', duration_ms: 60000 }], unparseable: [] } });
  assert.equal(disagreeing.runtime.status, 'contradictory');
  assert.equal(disagreeing.runtime.duration_agreement, 'contradictory');
});

test('review fixes: absolute paths and credentials never reach the output; other shell forms are caught', (t) => {
  const s = session(t, [
    assistant(1, 'm1', toolUse('b1', 'Bash', { command: 'cat D:\\work\\secretproj\\f.txt /d/work/y.txt; curl -H "Authorization: Bearer sk-live-1234567890" https://x.example?token=abc123' })),
    result(2, 'b1', { decision: { decision: 'reject', reasonCode: 'x' } }),
    assistant(3, 'm2', toolUse('b2', 'Bash', { command: 'cat /etc/passwd > /tmp/x; cp ~/.ssh/id_rsa .' })),
    result(4, 'b2'),
    assistant(5, 'm3', toolUse('b3', 'Bash', { command: 'git.exe -C "my dir" commit -m x' })),
    result(6, 'b3'),
    assistant(7, 'm4', toolUse('b4', 'Bash', { command: 'cd ./api && cat ../admin/README.md 2>/dev/null' })),
    result(8, 'b4'),
  ]);
  const m = run(s);
  // Labelled short forms such as `<elsewhere>/etc/passwd` are the design; no unlabelled absolute path or secret remains.
  const text = JSON.stringify(m).replace(/<elsewhere>\/[^"\s]*/g, '<label>');
  for (const leaked of ['secretproj', 'D:\\\\work', '/d/work', 'sk-live-1234567890', 'abc123', '/etc/passwd']) assert.ok(!text.includes(leaked), `leaked ${leaked}`);
  assert.ok(m.safety.outside_paths.some((o) => o.path.endsWith('etc/passwd')));
  assert.ok(m.safety.outside_paths.some((o) => o.path.includes('<home>')), '~/ is the home directory');
  assert.equal(m.safety.git_writes.length, 1, 'git.exe with a quoted -C argument');
  assert.ok(!m.safety.outside_paths.some((o) => o.tool_use === 'b4'), 'cd ./api && ../admin stays inside the fixture');
});

test('review fixes: synthetic records, odd shapes, prototype names, the open point, unlinked transcripts, missing records', (t) => {
  const synthetic = assistant(2, 'syn', { type: 'text', text: 'interrupted' }, { model: '<synthetic>', u: usage(0, 0) });
  const odd = assistant(3, 'm2', { type: 'tool_use', id: 12345, name: 'toString', input: { command: 7 } });
  const s = session(t, [
    assistant(1, 'm1', toolUse('g0', 'Bash', { command: 'grep -n new-run SKILL.md' })),
    result(1, 'g0'),
    synthetic,
    odd,
    { type: 'user', timestamp: ts(4), message: { content: [{ type: 'tool_result', tool_use_id: 12345, is_error: true, content: 'no' }] }, permissionDecision: { decision: 'reject' } },
    assistant(5, 'm3', toolUse('o1', 'Bash', { command: 'node "./.claude/skills/nth-review/scripts/nthr.mjs" new-run --ns e/x --mode task --slug s' })),
    result(6, 'o1'),
  ], [{ id: 'orphan1', rows: [assistant(7, 'c1', toolUse('w', 'Write', { file_path: 'notes.md', content: 'x' }), { u: usage(1, 9) }), result(8, 'w')] }]);
  const records = { run: { runtime: {} }, budget: { lead_tool_calls: 10, spent: {} }, delegations: [] };
  const m = run(s, { records });
  assert.deepEqual(m.lead.models.values, ['claude-opus-5-5']);
  assert.equal(m.lead.models.synthetic_records, 1);
  assert.deepEqual(m.routing.violations, []);
  assert.equal(m.lead.tool_calls.by_tool.toString, 1);
  assert.equal(m.budget.lead_tool_calls_after_open, 0, 'the grep that mentions new-run is not the open');
  assert.deepEqual(m.unlinked_transcripts.map((u) => u.id), ['orphan1']);
  assert.ok(m.safety.writes.some((w) => w.agent === 'unlinked orphan1'));
  assert.equal(m.usage.unlinked_cumulative.output, 9);
  const field = (f) => m.records_comparison.items.find((i) => i.field === f);
  assert.equal(field('run.runtime.lead_effort').verdict, 'missing-in-records');
  assert.equal(field('budget.spent.lead_tool_calls').verdict, 'missing-in-records');
});

test('review fixes: a very long command is scanned in bounded time', (t) => {
  const long = `node -e "${'x'.repeat(400000)}" node -e "${'y'.repeat(1000)}"`;
  const s = session(t, [assistant(1, 'm1', toolUse('b1', 'Bash', { command: long })), result(2, 'b1')]);
  const start = Date.now();
  const m = run(s);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
  assert.ok(m.safety.sensitive.some((x) => /first 20000 characters/.test(x.note ?? '')));
});

test('records comparison: effort, spent counts, delegation fields and the B1 point', (t) => {
  const uses = [assistant(1, 'm0', toolUse('open', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs new-run --ns e/x --mode task --slug s' })), result(2, 'open')];
  for (let i = 0; i < 9; i += 1) uses.push(assistant(3 + i, `m${i + 1}`, toolUse(`g${i}`, 'Grep', { pattern: 'x' })), result(3 + i, `g${i}`));
  uses.push(assistant(20, 'm20', toolUse('late', 'Edit', { file_path: '.nth-review/e/x/runs/r/records.json', old_string: 'a', new_string: '"status": "held"' })), result(21, 'late'));
  const records = {
    run: { runtime: { lead_model: 'claude-opus-5-5', lead_effort: 'unknown' }, opened: ts(1), closed: ts(21) },
    budget: { lead_tool_calls: 10, reserve_pct: 30, spent: { lead_tool_calls: 10, subagent_calls: 0, subagent_tokens: 0, wall_clock_min: 0.3 } },
    delegations: [],
  };
  const m = run(session(t, uses), { records });
  const field = (f) => m.records_comparison.items.find((i) => i.field === f);
  assert.equal(field('run.runtime.lead_effort').verdict, 'records-less-specific');
  assert.equal(field('run.runtime.lead_model').verdict, 'match');
  assert.equal(field('budget.spent.lead_tool_calls').verdict, 'match');
  assert.equal(m.budget.b1_after_calls, 7);
  assert.equal(m.budget.record_edits_after_b1, 1);
  assert.equal(m.budget.record_edits_after_b1_setting_conclusions.value, 1);
  assert.equal(m.budget.record_edits_after_b1_setting_conclusions.status, 'inferred');
});

test('readJsonl skips blank lines and counts unparseable ones', (t) => {
  const dir = makeTempDir(t, 'nthr-tx-');
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, '{"type":"user"}\n\n42\nnot json\n{"type":"assistant"}\n');
  const r = readJsonl(file);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.unparseable, [3, 4]);
});

test('M5-T4 B5 counting: calls after the open, and up to the last executed records write', (t) => {
  const rows = [assistant(1, 'm0', toolUse('open', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs new-run --ns e/x --mode task --slug s' })), result(2, 'open')];
  for (let i = 0; i < 3; i += 1) rows.push(assistant(3 + i, `g${i}`, toolUse(`g${i}`, 'Grep', { pattern: 'x' })), result(3 + i, `g${i}`));
  rows.push(assistant(10, 'w1', toolUse('w1', 'Edit', { file_path: '.nth-review/e/x/runs/r/records.json', old_string: 'a', new_string: 'b' })), result(11, 'w1'));
  rows.push(assistant(12, 'w2', toolUse('w2', 'Write', { file_path: '.nth-review/e/x/runs/r/records.json', content: 'x' })), result(13, 'w2', { error: true, decision: { decision: 'reject' } }));
  rows.push(assistant(14, 'f', toolUse('f', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs footprint --run r' })), result(15, 'f'));
  const verdictFor = (spent) => {
    const records = { run: { runtime: {} }, budget: { lead_tool_calls: 40, spent: { lead_tool_calls: spent } }, delegations: [] };
    const m = run(session(t, rows), { records });
    return { m, item: m.records_comparison.items.find((i) => i.field === 'budget.spent.lead_tool_calls') };
  };
  const { m, item } = verdictFor(4);
  assert.equal(m.budget.lead_tool_calls_after_open, 6);
  assert.equal(m.budget.lead_tool_calls_after_open_to_last_record_write, 4, 'the denied write is not the last write');
  assert.equal(item.verdict, 'match-at-last-write');
  assert.equal(verdictFor(6).item.verdict, 'match');
  const off = verdictFor(9).item;
  assert.equal(off.verdict, 'differs');
  assert.equal(off.observed.delta_vs_after_open, 3);
});

test('M5-T4R (M1): an executed apply is a records write; its patch is read for conclusions after B1; a refused apply is not a write', (t) => {
  const patch = (ops) => JSON.stringify({ schema: 'nth-review/patch@1', base: 'a'.repeat(64), ops });
  const rows = [assistant(1, 'm0', toolUse('open', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs new-run --ns e/x --mode task --slug s' })), result(2, 'open')];
  rows.push(assistant(3, 'p1', toolUse('p1', 'Write', { file_path: '.nth-review/e/x/runs/r/patch.json', content: patch([{ op: 'add', path: '/census', value: { id: 'C-1' } }]) })), result(4, 'p1'));
  rows.push(assistant(5, 'a1', toolUse('a1', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs apply --run .nth-review/e/x/runs/r' })), result(6, 'a1'));
  for (let i = 0; i < 6; i += 1) rows.push(assistant(7 + i, `g${i}`, toolUse(`g${i}`, 'Grep', { pattern: 'x' })), result(7 + i, `g${i}`));
  // After B1 (7 of 10): one batch that confirms a finding, and one apply refused as stale.
  rows.push(assistant(20, 'p2', toolUse('p2', 'Write', { file_path: '.nth-review/e/x/runs/r/patch.json', content: patch([{ op: 'set', path: '/findings/F-1/verdict', value: 'confirmed' }, { op: 'set', path: '/budget/spent/lead_tool_calls', value: 10 }]) })), result(21, 'p2'));
  rows.push(assistant(22, 'a2', toolUse('a2', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs apply --run .nth-review/e/x/runs/r' })), result(23, 'a2'));
  rows.push(assistant(24, 'p3', toolUse('p3', 'Write', { file_path: '.nth-review/e/x/runs/r/patch.json', content: patch([{ op: 'set', path: '/obligations/OB-2/status', value: 'held' }]) })), result(25, 'p3'));
  rows.push(assistant(26, 'a3', toolUse('a3', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs apply --run .nth-review/e/x/runs/r' })), result(27, 'a3', { error: true, text: 'patch.json.base: stale' }));
  rows.push(assistant(28, 'c', toolUse('c', 'Bash', { command: 'node .claude/skills/nth-review/scripts/nthr.mjs close --run .nth-review/e/x/runs/r' })), result(29, 'c'));
  const records = { run: { runtime: {} }, budget: { lead_tool_calls: 10, reserve_pct: 30, spent: { lead_tool_calls: 10 } }, delegations: [] };
  const m = run(session(t, rows), { records });
  assert.equal(m.budget.lead_tool_calls_after_open, 13);
  assert.equal(m.budget.lead_tool_calls_after_open_to_last_record_write, 10, 'the last executed apply, not the refused one');
  assert.equal(m.budget.b1_after_calls, 7);
  assert.deepEqual(m.budget.record_writes_after_b1_by_kind, { file_tool: 0, apply: 1 });
  assert.equal(m.budget.record_edits_after_b1, 1);
  assert.equal(m.budget.record_edits_after_b1_setting_conclusions.value, 1, 'the confirmed verdict; the refused batch wrote nothing');
  assert.match(m.budget.record_edits_after_b1_setting_conclusions.rule, /executed apply after B1/);
  // A patch written whole and then edited in place: the apply writes the edited batch.
  const edited = rows.slice(0, rows.length - 2).filter((r) => !JSON.stringify(r).includes('"p3"') && !JSON.stringify(r).includes('"a3"'));
  const p2 = patch([{ op: 'set', path: '/findings/F-1/verdict', value: 'confirmed' }, { op: 'set', path: '/budget/spent/lead_tool_calls', value: 10 }]);
  const withEdit = edited.map((r) => (JSON.stringify(r).includes('"p2"') && r.type === 'assistant' ? assistant(20, 'p2', toolUse('p2', 'Write', { file_path: '.nth-review/e/x/runs/r/patch.json', content: p2.replace('confirmed', 'needs_validation') })) : r));
  const a2 = withEdit.findIndex((r) => JSON.stringify(r).includes('"a2"') && r.type === 'assistant');
  withEdit.splice(a2, 0, assistant(21, 'e2', toolUse('e2', 'Edit', { file_path: '.nth-review/e/x/runs/r/patch.json', old_string: '"needs_validation"', new_string: '"confirmed"' })), result(21, 'e2'));
  assert.equal(run(session(t, withEdit), { records }).budget.record_edits_after_b1_setting_conclusions.value, 1, 'the Edit is replayed on the written patch');
  // A transcript with no apply keeps its M5-T4 meaning.
  const old = run(session(t, rows.filter((r) => !JSON.stringify(r).includes('apply') && !JSON.stringify(r).includes('patch.json'))), { records });
  assert.equal(old.budget.lead_tool_calls_after_open_to_last_record_write, null);
  assert.deepEqual(old.budget.record_writes_after_b1_by_kind, { file_tool: 0, apply: 0 });
});
