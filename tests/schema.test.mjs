import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { LIMITS, VOCAB, parseAnchor, parseRecords, validateRecords, validateStructure } from '../scripts/lib/schema.mjs';
import { REVIEW_DIR } from './helpers/tmp.mjs';
import { BASE, OID, RUN, mutate, validRecords, where } from './helpers/records.mjs';

const clone = (v) => structuredClone(v);

function expectOne(doc, keys, pattern) {
  const errors = validateStructure(doc);
  assert.equal(errors.length, 1, `${where(keys)} → ${JSON.stringify(errors)}`);
  assert.ok(errors[0].startsWith(where(keys)), `expected an error at ${where(keys)}, got ${errors[0]}`);
  if (pattern) assert.match(errors[0], pattern);
}

test('valid documents pass, open and in every closed state', () => {
  for (const status of ['open', 'complete', 'incomplete', 'abandoned']) {
    const doc = validRecords({ status });
    if (status === 'complete') doc.run.incomplete_reason = null;
    assert.deepEqual(validateStructure(doc), [], status);
  }
  assert.deepEqual(validateRecords(JSON.stringify(validRecords())), []);
});

test('every closed-vocabulary field rejects an unknown value with exactly one error', () => {
  const cases = [
    ['run', 'status'], ['run', 'mode'], ['run', 'profile'], ['run', 'incomplete_reason'],
    ['run', 'runtime', 'required_lead_model'], ['run', 'runtime', 'lead_effort'], ['run', 'runtime', 'triggers', 0],
    ['scope', 'units', 0, 'status'], ['census', 'items', 0, 'status'],
    ['obligations', 0, 'coverage'], ['obligations', 0, 'status'], ['obligations', 1, 'open_reason'],
    ['obligations', 0, 'source_trace'],
    ['findings', 0, 'kind'], ['findings', 0, 'verdict'], ['findings', 0, 'severity'],
    ['findings', 0, 'impact_dimension'], ['findings', 0, 'trace', 0, 'role'],
    ['findings', 0, 'verification', 'role'], ['findings', 0, 'verification', 'model'],
    ['findings', 0, 'verification', 'outcome'], ['findings', 0, 'decision'],
    ['debt', 'in', 0, 'disposition'], ['debt', 'out', 0, 'kind'], ['debt', 'out', 0, 'priority'],
    ['delegations', 0, 'role'], ['delegations', 0, 'agent'], ['delegations', 0, 'model'], ['delegations', 0, 'effort'],
    ['snapshot', 'limitations', 0, 'code'],
    ['footprint', 'api/src/transfer.js', 'state'], ['freshness', 'repos', 0, 'outcome'],
    ['freshness', 'changed_files', 0, 'change'], ['freshness', 'obligations', 0, 'class'],
  ];
  for (const keys of cases) {
    const doc = mutate(validRecords(), keys, 'bogus');
    const errors = validateStructure(doc);
    assert.equal(errors.length, 1, `${where(keys)} → ${JSON.stringify(errors)}`);
    assert.ok(errors[0].startsWith(where(keys)), errors[0]);
  }
  // An assumption is validated as one record, so its errors point at it.
  expectOne(mutate(validRecords(), ['obligations', 0, 'assumptions', 1, 'observed'], 'bogus'), ['obligations', 0, 'assumptions', 1], /observed must be one of/);
  // Delegations may never record a model other than opus or sonnet.
  expectOne(mutate(validRecords(), ['delegations', 0, 'model'], 'haiku'), ['delegations', 0, 'model']);
  expectOne(mutate(validRecords(), ['delegations', 0, 'effort'], 'xhigh'), ['delegations', 0, 'effort']);
});

test('missing, unknown and mistyped fields: one error each', () => {
  expectOne(mutate(validRecords(), ['run', 'slug'], null, { remove: true }), ['run', 'slug'], /is required/);
  expectOne(mutate(validRecords(), ['footprint'], null, { remove: true }), ['footprint'], /is required/);
  expectOne(mutate(validRecords(), ['obligations', 0, 'evidence'], null, { remove: true }), ['obligations', 0, 'evidence']);
  // The kind comes from the namespace path (rule N1), never from a field.
  expectOne(mutate(validRecords(), ['run', 'kind'], 'experiment'), ['run', 'kind'], /not a records@1 field/);
  expectOne(mutate(validRecords(), ['extra'], 1), ['extra']);
  expectOne(mutate(validRecords(), ['run', 'opened'], 5), ['run', 'opened'], /must be a string/);
  expectOne(mutate(validRecords(), ['budget', 'reserve_pct'], 101), ['budget', 'reserve_pct']);
  expectOne(mutate(validRecords(), ['budget', 'spent', 'lead_tool_calls'], -1), ['budget', 'spent', 'lead_tool_calls']);
  expectOne(mutate(validRecords(), ['budget', 'spent', 'lead_tool_calls'], 1.5), ['budget', 'spent', 'lead_tool_calls']);
  expectOne(mutate(validRecords(), ['schema'], 'nth-review/records@2'), ['schema']);
  expectOne(mutate(validRecords(), ['obligations', 0, 'claim'], '   '), ['obligations', 0, 'claim'], /empty/);
  expectOne(mutate(validRecords(), ['obligations', 0, 'checks'], []), ['obligations', 0, 'checks']);
  expectOne(mutate(validRecords(), ['snapshot', 'repos'], []), ['snapshot', 'repos']);
  expectOne(mutate(validRecords(), ['run', 'namespace'], 'experiments/CON'), ['run', 'namespace']);
  expectOne(mutate(validRecords(), ['run', 'namespace'], 'runs/legacy'), ['run', 'namespace']);
});

test('anchors: valid forms are accepted', () => {
  for (const a of ['a.js', 'api/src/x.ts', 'api/src/x.ts:7', 'api/src/x.ts:10-24', 'api/src/x.ts:5-5',
    'docs/x.md#Heading', 'docs/x.md#Heading with spaces', 'docs/x.md#C# usage', 'dự án/tệp.ts:3',
    'api/new file.txt', 'api/b .ts/c']) {
    assert.ok(parseAnchor(a), a);
    assert.deepEqual(validateStructure(mutate(validRecords(), ['obligations', 0, 'evidence', 0, 'anchor'], a)), [], a);
  }
  assert.deepEqual(parseAnchor('a/b.ts:10-24'), { path: 'a/b.ts', lines: [10, 24], heading: null });
  assert.deepEqual(parseAnchor('d.md#H'), { path: 'd.md', lines: null, heading: 'H' });
});

test('anchors: hostile and malformed forms yield exactly one error', () => {
  const bad = [
    '', '/abs/x.ts', 'C:/x.ts', 'c:x.ts', 'C:\\x.ts', '\\x.ts', 'a\\b.ts', '../a.ts', 'a/../b.ts', 'a/./b.ts',
    'a//b.ts', 'a/', '.', 'a.ts:0', 'a.ts:01', 'a.ts:10-5', 'a.ts:1-', 'a.ts:-3', 'a.ts:x', 'a.ts:1-2-3',
    'a.ts:1:2', 'a.ts#', 'a.ts:10#h', 'a/b.ts\u0001', 'a/b\0.ts', 'a/b /c.ts', 'a/b./c',
    `a/${'x'.repeat(256)}.ts`, `${'a/'.repeat(520)}x.ts`, 'a/*.ts', 'a/b?.ts', `d.md#${'h'.repeat(201)}`,
  ];
  for (const a of bad) {
    assert.equal(parseAnchor(a), null, JSON.stringify(a));
    const keys = ['obligations', 0, 'evidence', 0, 'anchor'];
    const errors = validateStructure(mutate(validRecords(), keys, a));
    assert.equal(errors.length, 1, `${JSON.stringify(a)} → ${JSON.stringify(errors)}`);
    assert.ok(errors[0].startsWith(where(keys)), errors[0]);
  }
});

test('repository paths outside anchors follow the same rules', () => {
  expectOne(mutate(validRecords(), ['census', 'items', 0, 'path'], '/etc/passwd'), ['census', 'items', 0, 'path']);
  expectOne(mutate(validRecords(), ['scope', 'change', 0, 'repo'], '..'), ['scope', 'change', 0, 'repo']);
  expectOne(mutate(validRecords(), ['checks', 0, 'cwd'], 'C:/x'), ['checks', 0, 'cwd']);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 1, 'untracked', 'sample', 0], 'a\\b'), ['snapshot', 'repos', 1, 'untracked', 'sample', 0]);
  const doc = validRecords();
  doc.footprint['../escape.js'] = { blob: OID, state: 'clean', reason: null };
  expectOne(doc, ['footprint', '../escape.js'], /key/);
  // Census groups may use * and ?, other paths may not.
  assert.deepEqual(validateStructure(mutate(validRecords(), ['census', 'items', 0, 'path'], 'api/src/*/x?.ts')), []);
});

test('indirect dependencies are representable as dependency assumptions', () => {
  const ok = validRecords();
  assert.equal(ok.obligations[0].assumptions[0].kind, 'dependency');
  assert.deepEqual(validateStructure(ok), []);
  const keys = ['obligations', 0, 'assumptions', 0];
  expectOne(mutate(validRecords(), [...keys, 'anchor'], '../outside.js'), keys, /valid anchor/);
  expectOne(mutate(validRecords(), [...keys, 'fact'], 'x'), keys, /fact and observed null/);
  expectOne(mutate(validRecords(), [...keys, 'kind'], 'other'), keys, /kind must be one of/);
  expectOne(mutate(validRecords(), ['obligations', 0, 'assumptions', 1, 'fact'], ''), ['obligations', 0, 'assumptions', 1], /needs a fact/);
  expectOne(mutate(validRecords(), ['obligations', 0, 'assumptions', 1, 'anchor'], 'a.ts'), ['obligations', 0, 'assumptions', 1], /anchor null/);
  expectOne(mutate(validRecords(), [...keys, 'note'], null, { remove: true }), [...keys, 'note'], /is required/);
});

test('open runs may leave inherited debt undecided; closed runs may not', () => {
  const open = validRecords();
  assert.equal(open.debt.in[0].disposition, null);
  assert.deepEqual(validateStructure(open), []);
  for (const status of ['complete', 'incomplete', 'abandoned']) {
    const doc = validRecords({ status });
    if (status === 'complete') doc.run.incomplete_reason = null;
    doc.debt.in[0].disposition = null;
    expectOne(doc, ['debt', 'in', 0, 'disposition'], new RegExp(`required when the run is ${status}`));
  }
  const discharged = mutate(validRecords({ status: 'incomplete' }), ['debt', 'in', 0, 'disposition'], 'discharged');
  expectOne(discharged, ['debt', 'in', 0, 'note'], /explain/);
  expectOne(mutate(validRecords(), ['debt', 'in', 0, 'disposition'], 'obsolete'), ['debt', 'in', 0, 'note']);
});

test('run status fields: closed timestamp and incomplete reason follow the status', () => {
  expectOne(mutate(validRecords(), ['run', 'closed'], '2026-10-25T14:00:00Z'), ['run', 'closed'], /null while the run is open/);
  expectOne(mutate(validRecords(), ['run', 'incomplete_reason'], 'budget'), ['run', 'incomplete_reason'], /open/);
  expectOne(mutate(validRecords({ status: 'complete' }), ['run', 'incomplete_reason'], 'budget'), ['run', 'incomplete_reason'], /complete/);
  expectOne(mutate(validRecords({ status: 'incomplete' }), ['run', 'incomplete_reason'], null), ['run', 'incomplete_reason'], /required/);
  expectOne(mutate(validRecords({ status: 'abandoned' }), ['run', 'incomplete_reason'], null), ['run', 'incomplete_reason'], /required/);
  expectOne(mutate(validRecords({ status: 'incomplete' }), ['run', 'closed'], null), ['run', 'closed'], /required/);
  expectOne(mutate(validRecords(), ['run', 'opened'], '2026-13-01T00:00:00Z'), ['run', 'opened']);
  expectOne(mutate(validRecords(), ['run', 'id'], `20261025-131201-task-demo`), ['run', 'id'], /mode part/);
  expectOne(mutate(validRecords(), ['run', 'id'], `20261025-131201-incremental-other`), ['run', 'id'], /slug part/);
  expectOne(mutate(validRecords(), ['run', 'base'], 'not-a-run'), ['run', 'base']);
});

test('field-pair rules: open reason, reasons, head and blob consistency', () => {
  expectOne(mutate(validRecords(), ['obligations', 1, 'open_reason'], null), ['obligations', 1, 'open_reason'], /required/);
  expectOne(mutate(validRecords(), ['obligations', 0, 'open_reason'], 'budget'), ['obligations', 0, 'open_reason'], /must be null/);
  expectOne(mutate(validRecords(), ['scope', 'units', 0, 'status'], 'deferred'), ['scope', 'units', 0, 'reason']);
  expectOne(mutate(validRecords(), ['census', 'items', 1, 'reason'], null), ['census', 'items', 1, 'reason']);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 1, 'head'], null), ['snapshot', 'repos', 1, 'head']);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 1, 'untracked', 'hashed'], 2), ['snapshot', 'repos', 1, 'untracked'], /must equal count/);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 1, 'untracked', 'skipped', 'link'], 1), ['snapshot', 'repos', 1, 'untracked'], /must equal count/);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 0, 'untracked', 'sample'], ['x.txt']), ['snapshot', 'repos', 0, 'untracked', 'sample'], /more paths than count/);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 1, 'untracked', 'skipped', 'other'], 0), ['snapshot', 'repos', 1, 'untracked', 'skipped', 'other']);
  expectOne(mutate(validRecords(), ['snapshot', 'limitations', 0, 'path'], 'C:/x'), ['snapshot', 'limitations', 0, 'path']);
  // Coverage flags can never claim more than the counts and limitations show.
  expectOne(mutate(validRecords(), ['snapshot', 'untracked_complete'], true), ['snapshot', 'untracked_complete']);
  expectOne(mutate(validRecords(), ['snapshot', 'limitations', 0, 'code'], 'scan-limit'), ['snapshot', 'discovery_complete']);
  expectOne(mutate(validRecords(), ['snapshot', 'reconstructible'], true), ['snapshot', 'reconstructible']);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 1, 'unverified', 'secret'], 1), ['snapshot', 'tracked_complete']);
  expectOne(mutate(validRecords(), ['snapshot', 'tracked_complete'], false), ['snapshot', 'tracked_complete']);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 0, 'unverified', 'filter'], -1), ['snapshot', 'repos', 0, 'unverified', 'filter']);
  assert.deepEqual(validateStructure(mutate(validRecords(), ['snapshot', 'repos', 1, 'branch'], `feature/${'b'.repeat(1016)}`)), []);
  expectOne(mutate(validRecords(), ['snapshot', 'repos', 1, 'branch'], 'b'.repeat(1025)), ['snapshot', 'repos', 1, 'branch']);
  expectOne(mutate(validRecords(), ['footprint', 'api/src/transfer.js', 'blob'], null), ['footprint', 'api/src/transfer.js', 'blob']);
  expectOne(mutate(validRecords(), ['footprint', 'api/src/guards/owner.js', 'blob'], OID), ['footprint', 'api/src/guards/owner.js', 'blob'], /absent or unverified/);
  expectOne(mutate(validRecords(), ['footprint', 'api/src/guards/owner.js', 'reason'], null), ['footprint', 'api/src/guards/owner.js', 'reason']);
  expectOne(mutate(validRecords(), ['footprint', 'api/src/transfer.js', 'reason'], 'filter'), ['footprint', 'api/src/transfer.js', 'reason']);
  expectOne(mutate(validRecords(), ['footprint', 'api/src/transfer.js', 'reason'], 'bogus'), ['footprint', 'api/src/transfer.js', 'reason']);
  expectOne(mutate(validRecords(), ['freshness', 'changed_files', 0, 'from'], 'api/src/a.js'), ['freshness', 'changed_files', 0, 'from']);
  expectOne(mutate(validRecords(), ['freshness', 'changed_files', 1, 'from'], null), ['freshness', 'changed_files', 1, 'from']);
  expectOne(mutate(validRecords(), ['debt', 'out', 0, 'id'], 'D1'), ['debt', 'out', 0, 'id']);
  assert.deepEqual(validateStructure(mutate(validRecords(), ['freshness'], null)), []);
});

test('forbidden keys are reported once, wherever they appear', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const top = validateRecords(JSON.stringify(validRecords()).replace(/^\{/, `{"${key}":{"x":1},`));
    assert.equal(top.length, 1, JSON.stringify(top));
    assert.match(top[0], /forbidden key/);
    const nestedText = JSON.stringify(validRecords()).replace('"id":"OB-01"', `"id":"OB-01","${key}":1`);
    const nested = validateRecords(nestedText);
    assert.equal(nested.length, 1, JSON.stringify(nested));
    assert.match(nested[0], /\$\.obligations\[0\]/);
  }
  // JSON.parse never pollutes the prototype.
  assert.equal({}.x, undefined);
});

test('limits: strings, obligations, depth and size', () => {
  expectOne(mutate(validRecords(), ['scope', 'summary'], 'x'.repeat(LIMITS.string + 1)), ['scope', 'summary'], /at most 4096/);
  assert.deepEqual(validateStructure(mutate(validRecords(), ['scope', 'summary'], 'x'.repeat(LIMITS.string))), []);
  expectOne(mutate(validRecords(), ['run', 'runtime', 'lead_model'], 'm'.repeat(101)), ['run', 'runtime', 'lead_model']);

  const many = validRecords();
  const template = many.obligations[1];
  many.obligations = Array.from({ length: LIMITS.obligations + 1 }, (_, i) => ({ ...clone(template), id: `OB-${i}` }));
  expectOne(many, ['obligations'], /at most 2000/);

  const deep = (n) => `${'['.repeat(n)}${']'.repeat(n)}`;
  const tooDeep = parseRecords(deep(LIMITS.depth + 1));
  assert.equal(tooDeep.errors.length, 1);
  assert.match(tooDeep.errors[0], /nesting deeper than 64/);
  assert.deepEqual(parseRecords(deep(LIMITS.depth)).errors, []);
  // Brackets inside strings do not count.
  assert.deepEqual(parseRecords(JSON.stringify({ s: '['.repeat(100) })).errors, []);
  const deepObject = JSON.parse(deep(LIMITS.depth));
  assert.deepEqual(validateStructure({ ...validRecords(), scope: { ...validRecords().scope, change: deepObject } }).length >= 1, true);

  const big = Buffer.alloc(LIMITS.bytes + 1, 0x20);
  const size = parseRecords(big);
  assert.equal(size.errors.length, 1);
  assert.match(size.errors[0], /at most 5242880/);
});

test('errors are capped at 100, the last one saying so', () => {
  const doc = validRecords();
  doc.obligations[0].evidence = Array.from({ length: 100 }, () => ({ anchor: '/bad', note: '' }));
  doc.findings[0].trace = Array.from({ length: 50 }, () => ({ role: 'entrypoint', anchor: '/bad', note: '' }));
  const errors = validateStructure(doc);
  assert.equal(errors.length, LIMITS.errors);
  assert.match(errors[errors.length - 1], /error limit \(100\) reached/);
});

test('bytes: BOM, UTF-16, invalid UTF-8, malformed JSON, empty and non-object input', () => {
  const json = JSON.stringify(validRecords());
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]);
  assert.match(validateRecords(withBom)[0], /byte-order mark/);
  assert.match(validateRecords(`\uFEFF${json}`)[0], /byte-order mark/);
  assert.match(validateRecords(Buffer.from([0xff, 0xfe, 0x7b, 0x00]))[0], /UTF-16/);
  assert.match(validateRecords(Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]))[0], /not valid UTF-8/);
  assert.match(validateRecords('{"run": ')[0], /not valid JSON/);
  assert.match(validateRecords('')[0], /empty/);
  assert.match(validateRecords(42)[0], /bytes or text/);
  assert.equal(validateRecords('[]').length, 1);
  assert.equal(validateRecords('null').length, 1);
  for (const errors of [validateRecords(withBom), validateRecords('{"run": ')]) assert.equal(errors.length, 1);
});

test('string hygiene: lone surrogates and control characters, newlines allowed', () => {
  const surrogate = JSON.stringify(validRecords()).replace('"Ledger"', '"Led\\ud800ger"');
  const errors = validateRecords(surrogate);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /lone surrogate/);
  expectOne(mutate(validRecords(), ['scope', 'summary'], 'bell\u0007'), ['scope', 'summary'], /control/);
  assert.deepEqual(validateStructure(mutate(validRecords(), ['scope', 'summary'], 'line one\nline two\r\n\ttabbed')), []);
});

test('the validator never throws on arbitrary input', () => {
  const shapes = [null, 0, 1.5, '', 'x', true, [], {}, [1, 'a'], { run: 5 }, { schema: 'nth-review/records@1' }];
  for (const v of shapes) assert.ok(Array.isArray(validateStructure(v)));
  const doc = validRecords();
  for (const key of Object.keys(doc)) {
    for (const v of shapes) {
      const errors = validateStructure({ ...doc, [key]: v });
      assert.ok(Array.isArray(errors) && errors.length <= LIMITS.errors, `${key}=${JSON.stringify(v)}`);
    }
  }
});

test('ids of other runs: base, debt and run id formats', () => {
  assert.deepEqual(validateStructure(validRecords()), []);
  assert.ok(RUN.includes('incremental') && BASE.includes('task'));
  expectOne(mutate(validRecords(), ['debt', 'in', 0, 'from_run'], 'abc'), ['debt', 'in', 0, 'from_run']);
  expectOne(mutate(validRecords(), ['obligations', 0, 'links', 0], 'bad id!'), ['obligations', 0, 'links', 0]);
});

test('reference/records.md documents every vocabulary value', () => {
  const doc = readFileSync(path.join(REVIEW_DIR, 'reference', 'records.md'), 'utf8');
  for (const [name, values] of Object.entries(VOCAB)) {
    for (const value of values) assert.ok(doc.includes(`\`${value}\``), `${name}: ${value} missing from records.md`);
  }
  assert.ok(doc.includes('nth-review/records@1'));
});
