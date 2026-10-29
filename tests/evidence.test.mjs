// M5-T4R readiness (B2): the evidence archive. Disposable folders stand in for
// the temporary folder, the Claude Code configuration and the kit; nothing real
// is archived, and no session is started.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DEFAULT_KIT_MANIFEST, EVIDENCE_ABSENT, archive, destinationProblems, inventory, makeWorld, productPathOfLabel, sealedEvidenceState, verify } from './tools/evidence.mjs';
import { DEFAULT_LEDGER, projectSlug } from './tools/matrix.mjs';
import { REVIEW_DIR, initRepo, makeTempDir } from './helpers/tmp.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const SID1 = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const SID3 = '33333333-3333-4333-8333-333333333333';

// A matrix's leftovers: L1's fixture and sandbox, a guard log, L1's review and
// adjudication transcripts. L2's transcript and records are gone.
function fakeWorld(t) {
  const base = makeTempDir(t, 'ev-');
  const tmp = path.join(base, 'tmp');
  const config = path.join(base, 'cfg');
  const kit = path.join(base, 'kit');
  const review = path.join(kit, 'agents', 'claude', 'integrations', 'review');
  fs.mkdirSync(tmp, { recursive: true });
  const slug = projectSlug(tmp);
  const ledger = put(path.join(review, 'tests', 'fixtures', 'g5-ledger.jsonl'), [
    { seq: 1, event: 'registered' },
    { seq: 2, event: 'closed', row: 'L1', session_id: SID1, run_id: 'RUN1' },
    { seq: 3, event: 'adjudication-frozen', row: 'L1', run_id: 'RUN1', adjudicator_session_id: SID2 },
    { seq: 4, event: 'closed', row: 'L2', session_id: SID3, run_id: 'RUN3' },
  ].map((e) => JSON.stringify(e)).join('\n').concat('\n'));
  const files = [
    ledger,
    put(path.join(review, 'tests', 'fixtures', 'syn-x', 'answers.json'), '{"sealed":true}\n'),
    put(path.join(review, 'tests', 'fixtures', 'syn-x', 'reports', 'RUN1.score.json'), '{"score":1}\n'),
    put(path.join(review, 'tests', 'tools', 'tool.mjs'), 'export {};\n'),
    put(path.join(review, 'VALIDATION.md'), '# v\n'),
    put(path.join(tmp, 'wa-AAAAAA', '.nth-review', 'experiments', 'x', 'runs', 'RUN1', 'records.json'), '{"run":"RUN1"}\n'),
    put(path.join(tmp, 'wa-AAAAAA', 'api', 'src.js'), 'module.exports = 1;\n'),
    put(path.join(tmp, 'ra-AAAAAA', 'verdicts.json'), '{"findings":{}}\n'),
    put(path.join(tmp, 'sg-QQQQQQ', 'log.jsonl'), '{"decision":"allow"}\n'),
    put(path.join(config, 'projects', `${slug}-wa-AAAAAA`, `${SID1}.jsonl`), '{"type":"user"}\n'),
    put(path.join(config, 'projects', `${slug}-wa-AAAAAA`, SID1, 'subagents', 'agent-1.jsonl'), '{"type":"assistant"}\n'),
    put(path.join(config, 'projects', `${slug}-ra-AAAAAA`, `${SID2}.jsonl`), '{"type":"user"}\n'),
  ];
  const excluded = [
    put(path.join(review, 'tests', 'notes.md'), 'not evidence\n'),
    put(path.join(tmp, 'unrelated', 'x.txt'), 'not a matrix folder\n'),
    put(path.join(config, 'projects', 'C--elsewhere', 's.jsonl'), '{}\n'),
  ];
  const world = makeWorld({ config, ledger, tmp, kit, review });
  return { base, tmp, config, kit, review, world, files, excluded };
}
const snapshot = (files) => files.map((f) => `${f}\0${sha(fs.readFileSync(f))}\0${fs.statSync(f).mtimeMs}`);

test('inventory: finds every evidence class and lists what the ledger names but nothing holds; writes nothing', (t) => {
  const w = fakeWorld(t);
  const before = snapshot([...w.files, ...w.excluded]);
  const inv = inventory(w.world);
  assert.deepEqual(snapshot([...w.files, ...w.excluded]), before);
  assert.deepEqual(Object.fromEntries(Object.entries(inv.totals).map(([k, v]) => [k, v.files])), { kit: 5, fixture: 2, sandbox: 1, 'guard-log': 1, transcript: 3 });
  const missing = inv.missing.map((m) => `${m.class} ${m.label}`);
  assert.ok(missing.includes('matrix-root <root>'));
  assert.ok(missing.includes(`transcript <config>/projects/*/${SID3}.jsonl`), 'L2 review transcript is missing');
  assert.ok(missing.some((m) => m.startsWith('records ') && m.includes('RUN3')), 'L2 records are missing');
  assert.ok(!missing.some((m) => m.includes(SID1) || m.includes(SID2) || m.includes('RUN1/')));
  assert.equal(inv.cleanup.effective_days, 30);
});

test('archive destination: refused inside the temporary folder, the configuration, the kit or a Git work tree, or when not empty', (t) => {
  const w = fakeWorld(t);
  const problems = (to) => destinationProblems(w.world, to).join('; ');
  assert.match(problems(path.join(w.tmp, 'arch')), /temporary folder/);
  assert.match(problems(path.join(w.config, 'arch')), /configuration/);
  assert.match(problems(path.join(w.kit, 'arch')), /the kit/);
  const repo = path.join(w.base, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  assert.match(problems(path.join(repo, 'deep', 'arch')), /Git work tree/);
  put(path.join(w.base, 'full', 'x'), 'x');
  assert.match(problems(path.join(w.base, 'full')), /not a new or empty folder/);
  assert.equal(problems(path.join(w.base, 'archive')), '');
  assert.throws(() => archive(w.world, path.join(w.tmp, 'arch'), { kitManifest: null }), /refused: the archive destination is inside the temporary folder/);
});

test('archive: copies without moving or changing a source, restricts the folder, and writes a hash-only kit manifest', (t) => {
  const w = fakeWorld(t);
  const before = snapshot(w.files);
  const to = path.join(w.base, 'archive');
  const kitManifest = path.join(w.base, 'kit-manifest.json');
  const r = archive(w.world, to, { kitManifest });
  assert.deepEqual(snapshot(w.files), before, 'sources byte- and time-identical');
  assert.deepEqual(r.problems, []);
  assert.equal(r.manifest.files.length, w.files.length);
  for (const e of r.manifest.files) {
    assert.equal(e.status, 'archived');
    assert.equal(sha(fs.readFileSync(path.join(to, ...e.archive_path.split('/')))), e.sha256);
  }
  const records = r.manifest.files.find((e) => e.label.endsWith('/runs/RUN1/records.json'));
  assert.deepEqual(records.provenance, [{ seq: 2, event: 'closed', row: 'L1' }], 'a run is identified by the events that open and close its attempt');
  assert.deepEqual(r.manifest.files.find((e) => e.label.endsWith(`${SID2}.jsonl`)).provenance, [{ seq: 3, event: 'adjudication-frozen', row: 'L1' }]);
  assert.equal(r.manifest.ledger_sha256, sha(fs.readFileSync(w.world.ledger)));
  assert.equal(r.manifest.access.restricted, true);
  if (process.platform === 'win32') {
    const acl = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [to], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(acl, /BUILTIN\\Users|Authenticated Users|Everyone/);
  } else assert.equal(fs.statSync(to).mode & 0o077, 0);
  const text = fs.readFileSync(kitManifest, 'utf8');
  for (const p of [w.base, w.base.replaceAll('\\', '/'), w.base.replaceAll('\\', '\\\\'), w.world.tmpSlug]) assert.ok(!text.toLowerCase().includes(p.toLowerCase()), 'no absolute path or slug');
  const kit = JSON.parse(text);
  assert.equal(kit.view, 'hash-only');
  assert.ok(kit.files.some((e) => e.label === `<config>/projects/<tmp-slug>-wa-AAAAAA/${SID1}.jsonl`));
  assert.ok(kit.files.some((e) => e.label === '<tmp>/ra-AAAAAA/verdicts.json'));
  assert.ok(!kit.files.some((e) => e.label.endsWith('/api/src.js')), 'bulk fixture files are covered by their folder digest only');
  assert.ok(kit.groups.some((g) => g.label === '<tmp>/wa-AAAAAA' && g.files === 2));
  assert.equal(verify(to, { kitManifest }).ok, true);
  assert.throws(() => archive(w.world, to, { kitManifest: null }), /not a new or empty folder/, 'an archive is never written twice');
});

test('verify: a changed, removed or substituted archive file is reported', (t) => {
  const w = fakeWorld(t);
  const to = path.join(w.base, 'archive');
  const kitManifest = path.join(w.base, 'kit-manifest.json');
  const { manifest } = archive(w.world, to, { kitManifest });
  const at = (suffix) => path.join(to, ...manifest.files.find((e) => e.label.endsWith(suffix)).archive_path.split('/'));
  fs.writeFileSync(at('/records.json'), '{"run":"EDITED"}\n');
  fs.rmSync(at('/verdicts.json'));
  const r = verify(to, { kitManifest });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /records\.json: sha256 differs/.test(p)));
  assert.ok(r.problems.some((p) => /verdicts\.json: missing from the archive/.test(p)));
  // A manifest edited to match the tampered file still disagrees with the committed kit manifest.
  const m = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8'));
  m.files.find((e) => e.label.endsWith('/records.json')).sha256 = sha(fs.readFileSync(at('/records.json')));
  fs.writeFileSync(path.join(to, 'manifest.json'), JSON.stringify(m));
  assert.ok(verify(to, { kitManifest }).problems.some((p) => /differs from the kit manifest|folder digests/.test(p)));
  assert.equal(verify(to).anchored, false, 'without the kit manifest the result says it is not anchored');
  // A file added to the archive, and a manifest path that leaves it, are reported.
  put(path.join(to, 'files', 'tmp', 'planted.txt'), 'x');
  m.files[0].archive_path = 'files/../../outside.txt';
  fs.writeFileSync(path.join(to, 'manifest.json'), JSON.stringify(m));
  const again = verify(to, { kitManifest });
  assert.ok(again.problems.some((p) => /files\/tmp\/planted\.txt: in the archive but not in its manifest/.test(p)));
  assert.ok(again.problems.some((p) => /its archive path leaves the archive/.test(p)));
});

test('the committed kit manifest pins the historical M5-T4 evidence byte for byte', (t) => {
  const state = sealedEvidenceState();
  if (state === 'absent') { t.skip(EVIDENCE_ABSENT); return; }
  assert.equal(state, 'present', 'only part of the sealed G5 evidence is present');
  const kit = JSON.parse(fs.readFileSync(DEFAULT_KIT_MANIFEST, 'utf8'));
  assert.equal(kit.ledger_sha256, '7aa36b1666e031808199087d1456526384d47de459c98b862b4edb1bde8f1f18');
  assert.equal(sha(fs.readFileSync(DEFAULT_LEDGER)), kit.ledger_sha256);
  const immutable = kit.files.filter((e) => e.class === 'kit' && /\/tests\/fixtures\/(g5-ledger\.jsonl|[^/]+\/(answers\.json|adjudications\/|reports\/|history\/))/.test(e.label));
  assert.ok(immutable.length > 50);
  // Taken in the nth-dev-kit checkout: the labels carry the old module prefix, mapped onto this repository.
  for (const e of immutable) assert.equal(sha(fs.readFileSync(path.join(REVIEW_DIR, ...productPathOfLabel(e.label).split('/')))), e.sha256, e.label);
  assert.deepEqual([...new Set(immutable.map((e) => e.label.split('/').slice(0, 5).join('/')))], ['<kit>/agents/claude/integrations/review'], 'the sealed labels keep their original layout');
});

test('the G5 criteria are captured verbatim from the delivery roadmap, with provenance', (t) => {
  const state = sealedEvidenceState();
  if (state === 'absent') { t.skip(EVIDENCE_ABSENT); return; }
  assert.equal(state, 'present', 'only part of the sealed G5 evidence is present');
  const dir = path.join(REVIEW_DIR, 'tests', 'fixtures', 'g5-criteria');
  const source = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
  const excerpt = fs.readFileSync(path.join(dir, 'roadmap-section-4.md'));
  assert.equal(sha(excerpt), source.excerpt_sha256);
  assert.match(excerpt.toString('utf8'), /^## 4\. Gates\n[\s\S]*\*\*G5 Synthetic\*\*[\s\S]*\*\*G5 thresholds\*\*[\s\S]*\*\*Sonnet vs Opus High lead\*\*/);
  assert.equal(source.lines, '65-91');
  // The source roadmap lives in a private project; its location is in the unpublished tests/tools/private.json.
  const privateFile = path.join(REVIEW_DIR, 'tests', 'tools', 'private.json');
  const roadmap = fs.existsSync(privateFile) ? JSON.parse(fs.readFileSync(privateFile, 'utf8')).roadmapSource : null;
  const local = roadmap ? path.resolve(REVIEW_DIR, roadmap) : null;
  if (!local || !fs.existsSync(local)) { t.skip('the source roadmap is not on this machine'); return; }
  const lines = fs.readFileSync(local, 'utf8').split('\n');
  assert.equal(`${lines.slice(64, 91).join('\n')}\n`, excerpt.toString('utf8'), 'the source still holds the same text at lines 65-91');
});
