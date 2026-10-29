// RQ-1 @3 (tests/RELEASE-GATE-3.md): the runner's curated security package,
// its supplementary registration, and the D5 environment pins. No session is
// started. Every package here is a TEST DOUBLE built by the test itself: it is
// recorded with `testDouble`, and B7 never counts one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildCuratedFixture, manifest } from './fixtures/build.mjs';
import {
  CHAINS, ROWS, appendLedger, curatedLocation, curatedNeedles, curatedProblem, denyFor, labelMentions, pinProblems, planBatch,
  recordCuratedPackage, registerSupplement, transcriptVersions, verifyLedger,
} from './tools/matrix.mjs';
import { commitAll, makeRepo, write } from './helpers/repo.mjs';
import { makeTempDir, rawGit } from './helpers/tmp.mjs';

// A test-double package: one repository with two commits, bundled.
function testPackage(t, { thin = false, head = null } = {}) {
  const src = makeRepo(path.join(makeTempDir(t, 'nthr-src-'), 'p'), { 'src/app.js': 'export const a = 1;\n' });
  write(src, 'src/app.js', 'export const a = 2;\n');
  commitAll(src, 'change');
  const real = rawGit(src, ['rev-parse', 'HEAD']).trim();
  const pkg = makeTempDir(t, 'nthr-pkg-');
  fs.mkdirSync(path.join(pkg, 'repos'));
  rawGit(src, ['bundle', 'create', path.join(pkg, 'repos', 'root.bundle'), ...(thin ? ['HEAD~1..HEAD'] : ['--all'])]);
  fs.writeFileSync(path.join(pkg, 'answers.json'), JSON.stringify({ schema: 'nthr-fixture-answers@1', heads: { '.': head ?? real } }));
  fs.writeFileSync(path.join(pkg, 'attestation.txt'), 'TEST DOUBLE: written by an nth-review test, not by an independent curator.\n');
  return { pkg, head: real };
}
function context(t) {
  const root = makeTempDir(t, 'nthr-rq2-');
  return { root, ledger: path.join(root, 'ledger.jsonl'), state: { rows: {} } };
}
const IMPL = { frozen: true, head: 'h'.repeat(40), digest: 'i'.repeat(64), files: [], environment: { digest: 'e'.repeat(64), files: [] } };
function registered(ctx, version = '2.1.312') {
  appendLedger(ctx.ledger, { event: 'isolation-verified', claude_version: version, passed: true, checks: {}, implementation_sha256: IMPL.digest, environment_sha256: IMPL.environment.digest });
  appendLedger(ctx.ledger, { event: 'registered', chains: CHAINS, implementation: { head: IMPL.head, digest: IMPL.digest, files: [], environment: IMPL.environment }, skill_sha256: 's'.repeat(64), versions: { claude_code: version } });
}

test('a curated package is recorded once, by digest, from outside the kit, Git and the temporary folder; a test double only when marked', (t) => {
  const ctx = context(t);
  const { pkg, head } = testPackage(t);
  assert.throws(() => recordCuratedPackage(ctx, pkg, { changes: ['.:HEAD~1..HEAD'] }), /keep the curated package outside the kit, every Git work tree and the temporary folder/);
  assert.throws(() => recordCuratedPackage(ctx, pkg, { changes: [], testDouble: true }), /give the review's --change specs/);
  assert.throws(() => recordCuratedPackage(ctx, pkg, { changes: ['api:a..b'], testDouble: true }), /not <repo>:<a>\.\.<b> for a repository of the package/);
  assert.throws(() => recordCuratedPackage(ctx, pkg, { changes: ['constructor:a..b'], testDouble: true }), /not <repo>:<a>\.\.<b> for a repository of the package/);
  // Inside a Git work tree is never "outside Git".
  assert.equal(curatedLocation(makeRepo(path.join(makeTempDir(t, 'nthr-in-git-'), 'r'), { 'a.txt': 'a\n' })).outside_git, false);
  // When Git cannot answer (here: not found), the folder is not taken to be outside Git.
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try { assert.equal(curatedLocation(makeTempDir(t, 'nthr-no-git-')).outside_git, false); } finally { process.env.PATH = savedPath; }
  const ev = recordCuratedPackage(ctx, pkg, { changes: ['.:HEAD~1..HEAD'], testDouble: true });
  assert.equal(ev.event, 'curated-package');
  assert.equal(ev.test_double, true);
  assert.deepEqual(ev.heads, { '.': head });
  assert.match(ev.package_sha256, /^[0-9a-f]{64}$/);
  assert.match(ev.attestation_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(ev.location_checks, { outside_kit: true, outside_git: true, outside_tmp: false });
  assert.ok(!fs.readFileSync(ctx.ledger, 'utf8').toLowerCase().includes(pkg.toLowerCase().replace(/\\/g, '\\\\')), 'the ledger holds no path');
  assert.equal(ctx.state.curated.dir, fs.realpathSync.native(pkg));
  // Heads the bundle does not hold, and a package without an attestation, are refused.
  const wrong = testPackage(t, { head: '1'.repeat(40) });
  assert.throws(() => recordCuratedPackage(context(t), wrong.pkg, { changes: ['.:a..b'], testDouble: true }), /no ref of root\.bundle holds the head the answers record/);
  fs.rmSync(path.join(wrong.pkg, 'attestation.txt'));
  assert.throws(() => recordCuratedPackage(context(t), wrong.pkg, { changes: ['.:a..b'], testDouble: true }), /exactly one attestation/);
});

test('every session is denied the recorded package, the audit flags a tool input naming it, and a moved or changed package stops the matrix', (t) => {
  const ctx = context(t);
  const { pkg } = testPackage(t);
  assert.equal(curatedProblem(ctx), null, 'no package recorded: nothing to check');
  recordCuratedPackage(ctx, pkg, { changes: ['.:HEAD~1..HEAD'], testDouble: true });
  const rule = `//${fs.realpathSync.native(pkg).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase())}`;
  const own = makeTempDir(t, 'wa-');
  for (const role of ['reviewer', 'adjudicator']) assert.ok(denyFor(ctx, 'L1', role, own).denyRoots.includes(rule), role);
  const transcript = path.join(makeTempDir(t, 'nthr-tx-'), 's.jsonl');
  const use = (input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input }] } });
  fs.writeFileSync(transcript, [use({ file_path: path.join(pkg, 'repos', 'root.bundle') }), use({ file_path: 'api/src/x.js' })].join('\n'));
  assert.deepEqual(labelMentions([transcript], { needles: curatedNeedles(ctx.state.curated.dir) }).map((h) => h.match), ['the curated package']);
  assert.equal(curatedProblem(ctx), null);
  fs.appendFileSync(path.join(pkg, 'answers.json'), ' ');
  assert.match(curatedProblem(ctx), /changed since it was recorded/);
  delete ctx.state.curated;
  assert.match(curatedProblem(ctx), /folder is unknown or gone/);
});

test('the curated fixture builds from bundles only: the recorded heads, deterministic, no remote or package path left, the skill installed', (t) => {
  const { pkg, head } = testPackage(t);
  const bundles = { '.': path.join(pkg, 'repos', 'root.bundle') };
  const out = (n) => path.join(makeTempDir(t, `nthr-cur${n}-`), 'f');
  const a = buildCuratedFixture(bundles, out(1), { heads: { '.': head } });
  const b = buildCuratedFixture(bundles, out(2), { heads: { '.': head } });
  assert.deepEqual(a.heads, { '.': head });
  assert.deepEqual(manifest(a.fixture), manifest(b.fixture), 'two builds, the same bytes');
  assert.equal(rawGit(a.fixture, ['remote']).trim(), '');
  assert.ok(fs.existsSync(path.join(a.fixture, '.claude', 'skills', 'nth-review', 'SKILL.md')), 'installed by Enable');
  // The bundle is fetched from a scratch copy (`nthr-b-*/p.bundle`): FETCH_HEAD and the reflog would name it.
  const gitFiles = fs.readdirSync(path.join(a.fixture, '.git'), { recursive: true }).map((f) => path.join(a.fixture, '.git', f)).filter((f) => fs.statSync(f).isFile());
  for (const needle of [path.basename(pkg).toLowerCase(), 'nthr-b-', 'p.bundle']) {
    assert.ok(!gitFiles.some((f) => fs.readFileSync(f).toString('latin1').toLowerCase().includes(needle)), `no ${needle} in .git`);
  }
  assert.throws(() => buildCuratedFixture(bundles, out(3), { heads: { '.': '1'.repeat(40) } }), /no ref in the bundle holds the recorded head/);
  const thin = testPackage(t, { thin: true });
  assert.throws(() => buildCuratedFixture({ '.': path.join(thin.pkg, 'repos', 'root.bundle') }, out(4), { heads: { '.': thin.head } }), /the bundle does not verify/);
  assert.throws(() => buildCuratedFixture({ api: bundles['.'] }, out(5), { heads: { api: head } }), /needs the root repository/);
});

test('the security rows register only after the main registration and a recorded package, on the same implementation and version, once', (t) => {
  const ctx = context(t);
  const ok = { implementation: IMPL, version: '2.1.312' };
  assert.throws(() => registerSupplement(ctx, ok), /the main plan is not registered/);
  registered(ctx);
  assert.throws(() => registerSupplement(ctx, ok), /record the curated package after the main registration/);
  assert.deepEqual(planBatch(ctx, ['SB1']).problems, ['SB1 runs only after a curated package is recorded and its rows registered (register-supplement)']);
  assert.ok(!planBatch(ctx, []).order.includes('SB1'), 'a default batch leaves them out');
  const { pkg } = testPackage(t);
  const cur = recordCuratedPackage(ctx, pkg, { changes: ['.:HEAD~1..HEAD'], testDouble: true });
  assert.throws(() => registerSupplement(ctx, { ...ok, implementation: { ...IMPL, frozen: false, files: [{ path: 'x', git: 'modified' }] } }), /not frozen/);
  assert.throws(() => registerSupplement(ctx, { ...ok, version: '2.1.313' }), /verified on Claude Code 2\.1\.312, not 2\.1\.313/);
  assert.throws(() => registerSupplement(ctx, { ...ok, version: null }), /refused/);
  const sup = registerSupplement(ctx, ok);
  assert.equal(sup.curated_seq, cur.seq);
  assert.equal(sup.test_double, true);
  assert.deepEqual(sup.chains, [['SB1', 'SB2']]);
  assert.deepEqual(sup.plan.map((r) => [r.id, r.model, r.expected.required_lead_model]), [['SB1', 'opus', 'opus-high'], ['SB2', 'opus', 'opus-high']]);
  assert.throws(() => registerSupplement(ctx, ok), /already registered/);
  assert.throws(() => recordCuratedPackage(ctx, pkg, { changes: ['.:HEAD~1..HEAD'], testDouble: true }), /already registered on a recorded package/);
  const plan = planBatch(ctx, []);
  assert.deepEqual(plan.order.slice(-2), ['SB1', 'SB2']);
  assert.equal(plan.problems.length, 0);
  assert.match(plan.rows.find((r) => r.row === 'SB1').command, /^\/nth-review task --ns experiments\/app --slug app --change \.:HEAD~1\.\.HEAD$/);
  // The ledger binds every security row to the registered package.
  assert.equal(verifyLedger(ctx.ledger, { answersDir: null }).ok, true);
  appendLedger(ctx.ledger, { event: 'pre-run', row: 'SB1', answers: 'curated', answers_sha256: 'x'.repeat(64), package_sha256: sup.package_sha256 });
  const v = verifyLedger(ctx.ledger, { answersDir: null });
  assert.match(v.problems.join('; '), /SB1 \(seq \d+\): the package or answers differ from the registered ones/);
  assert.match(v.unchecked.join('; '), /SB1: the curated answers \(package folder not given\)/);
  const withPkg = verifyLedger(ctx.ledger, { answersDir: null, external: { dir: pkg, evidenceDir: path.join(ctx.root, 'curated') } });
  assert.equal(withPkg.unchecked.length, 0);
  assert.match(withPkg.problems.join('; '), /SB1: the curated answers changed since the run/);
});

test('a security row that starts before its supplement is a ledger problem', (t) => {
  const ctx = context(t);
  registered(ctx);
  appendLedger(ctx.ledger, { event: 'pre-run', row: 'SB1', answers: 'curated', answers_sha256: 'a'.repeat(64), package_sha256: 'b'.repeat(64) });
  assert.match(verifyLedger(ctx.ledger, { answersDir: null }).problems.join('; '), /SB1 \(seq \d+\): a security row started before the supplement/);
});

test('D5: the lead on its row\'s model pin, delegates within the pins, transcripts on the registered version', (t) => {
  const tx =path.join(makeTempDir(t, 'nthr-tx-'), 's.jsonl');
  fs.writeFileSync(tx, `${JSON.stringify({ type: 'assistant', version: '2.1.312' })}\n${JSON.stringify({ type: 'user', version: '2.1.312' })}\n`);
  assert.deepEqual(transcriptVersions([tx]), ['2.1.312']);
  const versions = { claude_code: '2.1.312' };
  const metrics = (lead, delegate = 'claude-sonnet-5-5') => ({ lead: { models: { values: lead } }, delegations: [{ transcript: { models: { values: [delegate] } } }], unlinked_transcripts: [] });
  assert.deepEqual(pinProblems(metrics(['claude-opus-5-5']), 'opus', versions, [tx]), []);
  assert.deepEqual(pinProblems(metrics(['claude-sonnet-5-5']), 'sonnet', versions, [tx]), []);
  assert.deepEqual(pinProblems(metrics(['claude-opus-5-6']), 'opus', versions, [tx]), ['lead model claude-opus-5-6, pinned claude-opus-5-5']);
  assert.deepEqual(pinProblems(metrics(['claude-opus-5-5']), 'sonnet', versions, [tx]), ['lead model claude-opus-5-5, pinned claude-sonnet-5-5']);
  assert.deepEqual(pinProblems(metrics(['claude-opus-5-5'], 'claude-haiku-5-5'), 'opus', versions, [tx]), ['delegate model claude-haiku-5-5']);
  assert.deepEqual(pinProblems(metrics([]), 'opus', versions, []), ['no resolved lead model']);
  fs.appendFileSync(tx, `${JSON.stringify({ type: 'assistant', version: '2.1.313' })}\n`);
  assert.deepEqual(pinProblems(metrics(['claude-opus-5-5']), 'opus', versions, [tx]), ['transcript version 2.1.313, registered 2.1.312']);
  // Each row's routing reaches the security rows too.
  assert.ok(ROWS.filter((r) => r.external).every((r) => r.model === 'opus'));
});
