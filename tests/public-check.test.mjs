// The public artifact (docs/DEVELOPMENT.md, Private evidence and the public
// repository): what would be published holds no private data, .gitignore keeps
// exactly the private paths out, and each rule catches what it is for. The
// private-looking samples below are assembled at run time, so this file
// passes its own scan.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PRIVATE_PATHS, TOP_LEVEL, isPrivate, publicProblems, scanText } from './tools/public-check.mjs';
import { REVIEW_DIR, makeTempDir } from './helpers/tmp.mjs';

// A copy of this repository with only its publishable top-level entries and the private paths
// (a working copy may hold local folders that are never published).
function cleanCopy(t) {
  const dir = makeTempDir(t, 'nthr-public-');
  for (const n of fs.readdirSync(REVIEW_DIR)) {
    if (TOP_LEVEL.includes(n) || isPrivate(`${n}/`)) fs.cpSync(path.join(REVIEW_DIR, n), path.join(dir, n), { recursive: true });
  }
  return dir;
}

test('public artifact: the files that would be published hold no private data, and .gitignore keeps exactly the private paths out', (t) => {
  const dir = cleanCopy(t);
  const r = publicProblems(dir);
  assert.deepEqual(r.problems, []);
  assert.ok(r.published.includes('LICENSE') && r.published.includes('tests/fixtures/syn-debt/answers.json'));
  assert.ok(!r.published.some(isPrivate));
  assert.deepEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')), PRIVATE_PATHS.map((p) => `/${p}`));
  // A local folder, an account path in a published file, a .gitignore line removed, a stale manifest: each is reported.
  fs.mkdirSync(path.join(dir, 'notes'));
  fs.writeFileSync(path.join(dir, 'notes', 'a.md'), 'x\n');
  fs.appendFileSync(path.join(dir, 'docs', 'USAGE.md'), `\nSee ${['C:', 'Users', 'jdoe', 'repo'].join('\\')}.\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').replace('/private/\n', ''));
  fs.appendFileSync(path.join(dir, 'reference', 'routing.md'), '\n');
  const after = publicProblems(dir).problems;
  for (const re of [/^notes: an unexpected top-level entry/, /^docs\/USAGE\.md:\d+: account path: /, /^\.gitignore must list exactly/, /^runtime-manifest\.json: stale/]) {
    assert.ok(after.some((p) => re.test(p)), `${re} in ${after.join(' | ')}`);
  }
});

test('public artifact: the private paths are the sealed evidence, the private terms and the originals, never the synthetic fixtures', () => {
  for (const p of ['tests/fixtures/g5-ledger.jsonl', 'tests/fixtures/g5-evidence-m5t4.json', 'tests/fixtures/g5-criteria/source.json', 'tests/fixtures/syn-debt/reports/a.json',
    'tests/fixtures/syn-ledger/adjudications/r.blind.json', 'tests/fixtures/syn-shelf/history/h.json', 'tests/tools/private.json', 'private/originals/VALIDATION.md']) assert.ok(isPrivate(p), p);
  for (const p of ['tests/fixtures/syn-debt/answers.json', 'tests/fixtures/syn-debt/tree/root/reports/x.js', 'tests/fixtures/README.md', 'tests/tools/public-check.mjs', 'docs/private.md', 'VALIDATION.md']) assert.ok(!isPrivate(p), p);
});

test('public artifact: each rule catches its kind and accepts the synthetic placeholders', () => {
  const kinds = (text, terms) => scanText(text, terms).map((h) => h.kind);
  const at = '@';
  for (const [text, kind] of [
    [`cd ${['C:', 'Users', 'jdoe', 'src'].join('\\')}`, 'account path'],
    [`ls ${['C:', 'Users', 'jdoe'].join('/')}`, 'account path'],
    [`ls /c/${'Users'}/jdoe/x`, 'account path'],
    [`open /${'Users'}/jdoe/x`, 'account path'],
    [`cat /${'home'}/jdoe/.bashrc`, 'account path'],
    [`mail j.doe${at}mail.com`, 'e-mail address'],
    [`session ${crypto.randomUUID()}`, 'session identifier'],
    [`key ${'sk-'}ant-${'a'.repeat(20)}`, 'credential'],
    [`-----BEGIN ${'RSA PRIVATE'} KEY-----`, 'credential'],
  ]) assert.deepEqual(kinds(text), [kind], text);
  assert.deepEqual(kinds('Under Secret-Project/x', ['secret-project']), ['private term']);
  for (const text of [`${['C:', 'Users', 'me', 'x'].join('\\')}`, `/c/${'Users'}/x/.claude`, '<home>/.claude-alt/projects', `p${at}test.invalid`, `team${at}ledger.example`,
    '11111111-1111-4111-8111-111111111111', '2b7e9c41-5d6f-4a8b-9c0d-1e2f3a4b5c6d', 'D:\\work\\nth-dev-kit', 'https://github.com/namth0712/nth-review']) assert.deepEqual(kinds(text), [], text);
});
