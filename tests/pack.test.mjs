import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { PACK_LIMITS, buildPack } from '../scripts/lib/pack.mjs';
import { commitAll, linkDirectory, makeRepo, write } from './helpers/repo.mjs';
import { at, closeRun, nthr, readRecords, writeRecords } from './helpers/runs.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

const numbered = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

// A repository with the sources the packs cite, and an open run whose
// finding F-1 traces `trace` (anchors) under obligation OB-1.
function fixture(t, trace, { extraFiles = {}, configure } = {}) {
  const base = makeTempDir(t);
  const root = fs.realpathSync.native(makeRepo(path.join(base, 'repo'), {
    'src/a.js': numbered(100),
    'src/crlf.txt': 'first\r\nsecond\r\nthird\r\n',
    'src/short.js': numbered(5),
    'docs/spec.md': `# Spec\n\nintro\n\n## Rules\n\n${numbered(30, 'rule')}`,
    ...extraFiles,
  }));
  configure?.(root, base);
  const opened = nthr(['new-run', '--ns', 'experiments/packs', '--mode', 'task', '--slug', 'p', '--change', '.'], { cwd: root, now: at(1) });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.scope.intent = [{ id: 'I1', anchor: 'docs/spec.md#Rules', note: 'the transfer rules' }];
  doc.obligations = [{
    id: 'OB-1', checks: ['PACK'], claim: 'Transfers check ownership.', scope: 'transfer', acceptance: 'Ownership is enforced before the write.',
    coverage: 'named-subset', coverage_method: 'the transfer path', status: 'violated', open_reason: null, source_trace: 'consistent',
    evidence: [{ anchor: 'src/a.js:20-22', note: 'the write' }], intent: ['I1'],
    assumptions: [{ kind: 'dependency', anchor: 'src/short.js:2', fact: null, observed: null, note: 'guard helper' }], links: ['F-1'],
  }];
  doc.findings = [{
    id: 'F-1', fingerprint: 'packs/f1', kind: 'defect', verdict: 'candidate', severity: 'high', impact_dimension: 'financial',
    obligation: 'OB-1', summary: 'The target account is not checked.',
    trace: trace.map((anchor, i) => ({ role: i === 0 ? 'entrypoint' : 'sink', anchor, note: `step ${i + 1}` })),
    counterevidence: [{ anchor: null, note: 'COUNTER-NOTE from an earlier refuter' }], validation_plan: null,
    verification: { role: 'R5', model: 'opus', outcome: 'corrected', corrections: 'EARLIER-REFUTER-CONCLUSION', incomplete: true },
    decision: 'pending',
  }];
  writeRecords(root, runDir, doc);
  return { root, runDir, base };
}

const pack = (root, runDir, args = []) => nthr(['pack', '--run', runDir, '--for', 'F-1', ...args], { cwd: root });
const packText = (root, runDir, id = 'F-1') => fs.readFileSync(path.join(root, ...runDir.split('/'), 'packs', `${id}.md`), 'utf8');

test('a finding pack: claim, obligation, intent and numbered, centred excerpts; no other conclusion', (t) => {
  const { root, runDir } = fixture(t, ['src/a.js:20-22', 'src/crlf.txt:2']);
  const r = pack(root, runDir);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  assert.equal(r.json.result.pack, `${runDir}/packs/F-1.md`);
  const text = packText(root, runDir);
  assert.match(text, /^# Evidence pack: F-1\n/);
  assert.match(text, /- Item: finding F-1 \(defect, severity high, financial\)/);
  assert.match(text, /- Claim: The target account is not checked\./);
  assert.match(text, /- Obligation OB-1: Transfers check ownership\./);
  assert.match(text, /- Acceptance: Ownership is enforced before the write\./);
  // 15 lines centred on 20-22: 14..28, with the cited lines marked.
  assert.match(text, /### 1\. src\/a\.js:20-22 · entrypoint\nNote: step 1\n```\n 14 \| line 14\n/);
  assert.match(text, />20 \| line 20\n>21 \| line 21\n>22 \| line 22\n 23 \| line 23/);
  assert.match(text, / 28 \| line 28\n```/);
  // CRLF: no carriage return reaches the pack.
  assert.ok(!text.includes('\r'));
  assert.match(text, / 1 \| first\n>2 \| second\n 3 \| third/);
  // Intent excerpt from its heading (numbers padded to a common width);
  // the dependency assumption is not part of a finding pack.
  assert.match(text, /### 3\. docs\/spec\.md#Rules · intent I1\nNote: the transfer rules\n```\n> 5 \| ## Rules/);
  assert.ok(!text.includes('src/short.js'));
  // A refuter never sees an earlier conclusion.
  for (const hidden of ['COUNTER-NOTE', 'EARLIER-REFUTER-CONCLUSION', 'candidate', 'corrected']) assert.ok(!text.includes(hidden), hidden);
  // Rendering is deterministic.
  assert.equal(pack(root, runDir).code, EXIT.OK);
  assert.equal(packText(root, runDir), text);
});

test('unavailable evidence is marked, not fatal: missing, binary, secret, linked, past the end, unknown heading, long lines', (t) => {
  const { root, runDir } = fixture(t, [
    'src/missing.js:3', 'src/blob.bin', '.env:1', 'linked/out.txt:1', 'src/short.js:8-9', 'docs/spec.md#Nowhere', 'src/long.js:1', 'src/a.js',
  ], {
    extraFiles: { 'src/long.js': `${'x'.repeat(2000)}\n` },
    configure: (root, base) => {
      fs.writeFileSync(path.join(root, 'src', 'blob.bin'), Buffer.from([0x50, 0x4b, 0, 1, 2, 0, 3]));
      write(root, '.env', 'TOKEN=secret-value\n');
      write(base, 'outside/out.txt', 'outside the project\n');
      linkDirectory(path.join(base, 'outside'), path.join(root, 'linked'));
    },
  });
  const opened = t.mock.method(fs, 'openSync');
  const r = pack(root, runDir);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const text = packText(root, runDir);
  assert.match(text, /src\/missing\.js:3 · entrypoint\nNote: step 1\n> unavailable: missing: the file does not exist/);
  assert.match(text, /src\/blob\.bin · sink\nNote: step 2\n> unavailable: binary: not excerpted/);
  assert.match(text, /\.env:1 · sink\nNote: step 3\n> unavailable: secret: never read/);
  assert.match(text, /linked\/out\.txt:1 · sink\nNote: step 4\n> unavailable: link: not followed/);
  assert.match(text, /src\/short\.js:8-9 · sink\nNote: step 5\n> range 8–9 is past the end of the file \(5 lines\)/);
  assert.match(text, /docs\/spec\.md#Nowhere · sink\nNote: step 6\n> heading "Nowhere" not found/);
  assert.match(text, /src\/long\.js:1 · sink\nNote: step 7\n> lines longer than 300 characters are cut\n/);
  assert.match(text, new RegExp(`>1 \\| ${'x'.repeat(PACK_LIMITS.lineChars)} … \\[line cut at 300 characters\\]`));
  assert.match(text, /src\/a\.js · sink\nNote: step 8\n> the first 15 of 100 lines\n```\n  1 \| line 1/);
  assert.ok(!text.includes('TOKEN=') && !text.includes('outside the project'));
  const read = opened.mock.calls.map((c) => path.relative(root, String(c.arguments[0])).split(path.sep).join('/'));
  assert.ok(!read.some((p) => p === '.env' || p.startsWith('linked')), `never opened: ${read}`);
  assert.deepEqual(r.json.result.marked.map((m) => m.anchor).sort(), [
    '.env:1', 'docs/spec.md#Nowhere', 'linked/out.txt:1', 'src/a.js', 'src/blob.bin', 'src/long.js:1', 'src/missing.js:3', 'src/short.js:8-9',
  ].sort());
});

test('caps: 10 anchors, 15 lines each, 6 KB in total, every cut marked; each file read once', (t) => {
  const long = Array.from({ length: 60 }, (_, i) => `${String(i + 1).padStart(3, '0')} ${'y'.repeat(280)}`).join('\n') + '\n';
  const trace = Array.from({ length: 12 }, (_, i) => `src/wide.js:${i * 4 + 1}-${i * 4 + 40}`);
  const { root, runDir } = fixture(t, trace, { extraFiles: { 'src/wide.js': long } });
  const opened = t.mock.method(fs, 'openSync');
  const r = pack(root, runDir);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const text = packText(root, runDir);
  assert.ok(Buffer.byteLength(text, 'utf8') <= PACK_LIMITS.bytes, `${Buffer.byteLength(text)} bytes`);
  assert.equal(r.json.result.bytes, Buffer.byteLength(text, 'utf8'));
  assert.ok(r.json.result.included.length <= 10);
  const why = r.json.result.omitted.map((o) => o.why);
  assert.equal(why.filter((w) => w === 'anchor cap (10)').length, 3, 'the 11th and 12th trace anchors and the intent are over the anchor cap');
  assert.ok(why.some((w) => w === 'size cap (6 KB)'), 'later excerpts are dropped for size');
  assert.match(text, /## Not included\n/);
  assert.match(text, /> the middle 15 of the cited 40 lines/);
  assert.match(text, /> cut to fit the pack size cap/);
  for (const block of text.split('```').filter((_, i) => i % 2 === 1)) {
    assert.ok(block.trim().split('\n').length <= PACK_LIMITS.lines);
  }
  const wideOpens = opened.mock.calls.filter((c) => String(c.arguments[0]).endsWith('wide.js')).length;
  assert.equal(wideOpens, 1, 'twelve anchors into one file: one read');
});

test('an obligation pack: evidence, dependency and intent; footprint-unverified evidence is marked', (t) => {
  const base = makeTempDir(t);
  const { root, runDir } = fixture(t, ['src/a.js:1'], {
    configure: (root) => {
      write(base, 'clean.mjs', 'process.stdin.pipe(process.stdout);\n');
      rawGit(root, ['config', 'filter.passthrough.clean', `node "${path.join(base, 'clean.mjs').replaceAll('\\', '/')}"`]);
      write(root, '.gitattributes', 'short.js filter=passthrough\n');
      commitAll(root);
      write(root, 'src/short.js', numbered(5, 'edited'));
    },
  });
  const fp = nthr(['footprint', '--run', runDir], { cwd: root });
  assert.equal(fp.code, EXIT.OK, JSON.stringify(fp.json));
  assert.equal(readRecords(root, runDir).footprint['src/short.js'].state, 'unverified');
  const r = nthr(['pack', '--run', runDir, '--for', 'OB-1', '--anchor', 'src/crlf.txt:1'], { cwd: root });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const text = packText(root, runDir, 'OB-1');
  assert.match(text, /- Item: obligation OB-1 \(coverage named-subset: the transfer path\)/);
  assert.match(text, /### 1\. src\/a\.js:20-22 · evidence/);
  assert.match(text, /### 2\. src\/short\.js:2 · dependency\nNote: guard helper\n> unverified identity: filter \(footprint\)\n```/);
  assert.match(text, /### 3\. src\/crlf\.txt:1 · requested/);
  assert.match(text, /### 4\. docs\/spec\.md#Rules · intent I1/);
  // Packs are allowed run files (C18): check reports nothing about the directory.
  const checked = nthr(['check', '--run', runDir], { cwd: root });
  assert.ok((checked.json.errors ?? []).every((e) => !e.startsWith('run directory')), JSON.stringify(checked.json));
});

test('refusals: unknown item, bad extra anchor, a closed run; nothing written', (t) => {
  const { root, runDir } = fixture(t, ['src/a.js:1']);
  const packs = path.join(root, ...runDir.split('/'), 'packs');
  assert.equal(nthr(['pack', '--run', runDir, '--for', 'F-9'], { cwd: root }).code, EXIT.USAGE);
  assert.equal(nthr(['pack', '--run', runDir, '--for', 'F-1', '--anchor', '../x.js'], { cwd: root }).code, EXIT.USAGE);
  assert.equal(nthr(['pack', '--run', runDir], { cwd: root }).code, EXIT.USAGE);
  assert.ok(!fs.existsSync(packs));
  closeRun(root, runDir);
  const closed = pack(root, runDir);
  assert.equal(closed.code, EXIT.USAGE);
  assert.match(closed.json.errors[0], /packs are written only while a run is open/);
  assert.ok(!fs.existsSync(packs));
  // buildPack itself never writes.
  assert.equal(typeof buildPack(root, readRecords(root, runDir), 'F-1').text, 'string');
  assert.ok(!fs.existsSync(packs));
});

test('review fixes: multi-byte and hostile text never breaks the 6 KB cap; headings with # and inside code', (t) => {
  const wide = '漢'.repeat(4000);
  const { root, runDir } = fixture(t, ['docs/csharp.md#C# usage', 'src/a.js:1'], {
    extraFiles: { 'docs/csharp.md': '# Notes\n\n```\n## C# usage\n```\n\n## C# usage\n\nreal section\n' },
  });
  const doc = readRecords(root, runDir);
  doc.findings[0].summary = `${wide}\r# Injected`;
  doc.findings[0].trace.forEach((s) => { s.note = wide; });
  doc.obligations[0].claim = wide;
  doc.obligations[0].acceptance = wide;
  writeRecords(root, runDir, doc);
  const r = pack(root, runDir);
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.json));
  const text = packText(root, runDir);
  assert.ok(Buffer.byteLength(text, 'utf8') <= PACK_LIMITS.bytes, `${Buffer.byteLength(text, 'utf8')} bytes`);
  assert.ok(!/^# Injected/m.test(text), 'a carriage return cannot start a heading');
  // The heading inside a code fence is skipped; `## C# usage` keeps its #.
  assert.match(text, /### 1\. docs\/csharp\.md#C# usage · entrypoint\n/);
  assert.ok(text.includes('>7 | ## C# usage') || text.includes('> 7 | ## C# usage'), text);
});

// The boundary test: only security, privacy and operator-spend findings get it,
// decided by the helper per finding (impact dimension or obligation checks).
test('boundary test: relevant findings only, with the model, cost and scope lines by check; never in other packs; never cut', (t) => {
  const { root, runDir } = fixture(t, ['src/a.js:20-22']);
  const doc = readRecords(root, runDir);
  const withFinding = (impact, checks, obligation = 'OB-1') => {
    const d = structuredClone(doc);
    d.obligations[0].checks = checks;
    d.findings[0].impact_dimension = impact;
    d.findings[0].obligation = obligation;
    return buildPack(root, d, 'F-1').text;
  };
  const has = (text, line) => text.includes(line);
  const BASE = '## Boundary test';
  const MODEL = '- Model path:';
  const COST = '- Cost:';
  const SCOPE = '- Scope: an owner or tenant column';
  // Irrelevant: a financial correctness finding, a LOGIC one, and an obligation pack.
  for (const [impact, checks] of [['financial', ['PACK']], ['correctness', ['LOGIC.3']], ['data-integrity', ['ATOMIC.1', 'RESOURCE.1']]]) {
    assert.ok(!has(withFinding(impact, checks), BASE), `${impact} ${checks}: no boundary test`);
  }
  assert.ok(!has(buildPack(root, doc, 'OB-1').text, BASE), 'an obligation pack never carries it');
  // A security finding under AUTHZ.2: the base block and the scope line only.
  const authz = withFinding('security', ['AUTHZ.2']);
  assert.ok(has(authz, BASE) && has(authz, SCOPE) && !has(authz, MODEL) && !has(authz, COST));
  assert.ok(authz.indexOf(BASE) < authz.indexOf('### 1.'), 'before the excerpts');
  assert.match(authz, /- Crossing: whose data, account, tenant, shared capacity or paid spend is affected beyond the actor's own permissions\?/);
  // Relevant by its checks alone: an availability finding under LLM.4 and LLM.2 gets model and cost lines.
  const llm = withFinding('availability', ['LLM.4', 'LLM.2']);
  assert.ok(has(llm, BASE) && has(llm, MODEL) && has(llm, COST) && !has(llm, SCOPE));
  assert.ok(has(withFinding('correctness', ['LLM']), MODEL), 'a whole LLM module check');
  assert.ok(has(withFinding('availability', ['RESOURCE.2']), COST), 'operator spend');
  // A privacy finding with no obligation: the base block only.
  const privacy = withFinding('privacy', ['PACK'], null);
  assert.ok(has(privacy, BASE) && !has(privacy, MODEL) && !has(privacy, COST) && !has(privacy, SCOPE));
  // Deterministic, verdict-free, and never cut by the size cap.
  assert.equal(withFinding('security', ['AUTHZ.2']), authz);
  const block = authz.slice(authz.indexOf(BASE), authz.indexOf('### 1.'));
  for (const word of ['candidate', 'confirmed', 'corrected', 'rejected', 'needs_validation']) assert.ok(!block.includes(word), word);
  const big = structuredClone(doc);
  big.obligations[0].checks = ['AUTHZ.4', 'LLM.4'];
  big.findings[0].impact_dimension = 'security';
  big.findings[0].trace = Array.from({ length: 12 }, (_, i) => ({ role: 'propagation', anchor: `src/a.js:${i * 8 + 1}-${i * 8 + 8}`, note: 'x'.repeat(500) }));
  const capped = buildPack(root, big, 'F-1').text;
  assert.ok(Buffer.byteLength(capped, 'utf8') <= PACK_LIMITS.bytes);
  assert.ok(has(capped, BASE) && has(capped, MODEL) && has(capped, COST) && has(capped, SCOPE) && has(capped, 'If a point has no answer, nothing is crossed'));
});
