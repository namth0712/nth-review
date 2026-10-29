// THIRD-PARTY-NOTICES.md (M3-T7, decision D3): the upstream MIT notice is
// reproduced verbatim (byte-identical to the LICENSE verified at the pinned
// commit), the pinned commit is named in full, every adapted section is
// marked in place and listed, no other section carries the mark, and the
// notice neither implies endorsement nor licenses anything beyond its scope.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REVIEW_DIR } from './helpers/tmp.mjs';

const read = (rel) => fs.readFileSync(path.join(REVIEW_DIR, ...rel.split('/')), 'utf8');
const notice = read('THIRD-PARTY-NOTICES.md');
const COMMIT = 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8';
// SHA-256 of the upstream LICENSE bytes at COMMIT (blob 6dbc9ecb…), verified on 2026-10-26.
const LICENSE_SHA256 = 'e598e694aa506650c7192d5ea3be0e50aca0d356ea00551c53429f0b01eb6391';
// The in-place mark, with the link relative to the marked file.
const MARK = (rel) => `*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](${rel.includes('/') ? '../' : ''}THIRD-PARTY-NOTICES.md).*`;

// The SHA-256 of the fenced license block.
const licenseHash = (text) => {
  const start = text.indexOf('```text\n') + '```text\n'.length;
  return createHash('sha256').update(text.slice(start, text.indexOf('```', start)), 'utf8').digest('hex');
};

test('the MIT notice is the upstream LICENSE, byte for byte, and the pinned commit is named in full', () => {
  assert.ok(!notice.includes('\r'), 'LF only');
  const start = notice.indexOf('```text\n') + '```text\n'.length;
  const block = notice.slice(start, notice.indexOf('```', start));
  assert.equal(licenseHash(notice), LICENSE_SHA256);
  // Mutations: a reworded or re-wrapped notice is no longer the upstream text.
  assert.notEqual(licenseHash(notice.replace('free of charge', 'without charge')), LICENSE_SHA256);
  assert.notEqual(licenseHash(notice.replace('all\ncopies', 'all copies')), LICENSE_SHA256);
  assert.ok(notice.includes(`SHA-256 \`${LICENSE_SHA256}\``), 'the notice states the hash it reproduces');
  assert.match(block, /^MIT License\n\nCopyright \(c\) 2025-2026 Cloudflare, Inc\.\n\nPermission is hereby granted, free of charge/);
  assert.match(block, /The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software\./);
  assert.ok(notice.includes('https://github.com/cloudflare/security-audit-skill'));
  assert.ok(notice.includes(`\`${COMMIT}\``));
  for (const [, file, blob] of notice.matchAll(/`(skills\/security-audit\/[A-Z-]+\.md)` \(blob `([0-9a-f]+)`\)/g)) {
    assert.match(blob, /^[0-9a-f]{40}$/, file);
  }
});

test('every adapted section is listed and marked in place; no other section carries the mark', () => {
  const table = notice.slice(notice.indexOf('### Adapted wording'), notice.indexOf('### Methodology restated'));
  const listed = [...table.matchAll(/^\| `((?:reference\/)?[A-Za-z]+\.md)`, ([^|]+?) \| `([A-Z-]+\.md)`, "([^"]+)" \|/gm)].map((m) => ({ file: m[1], section: m[2].trim(), upstream: m[3], heading: m[4] }));
  assert.deepEqual(listed.map((l) => `${l.file}#${l.section}`), [
    'reference/prompts.md#R5/R6 refuter', 'reference/prompts.md#R3 plan-critique', 'reference/prompts.md#R4 judgment critic',
    'reference/taxonomy.md#Severity', 'reference/taxonomy.md#Specialized modules',
    'SKILL.md#3. Task Review', 'reference/protocol.md#7. Findings',
  ]);
  const marked = [];
  for (const rel of ['SKILL.md', 'reference/protocol.md', 'reference/routing.md', 'reference/prompts.md', 'reference/census.md', 'reference/taxonomy.md', 'reference/records.md']) {
    const text = read(rel);
    for (const part of text.split(/\n(?=## )/)) {
      if (part.includes(MARK(rel))) marked.push(`${rel}#${/^## (.+)$/m.exec(part)[1]}`);
      // Any mark carries the link that resolves from its own file.
      if (part.includes("security-audit-skill (MIT)")) assert.ok(part.includes(MARK(rel)), `${rel}: a mark with a wrong link`);
    }
  }
  assert.deepEqual(marked.sort(), listed.map((l) => `${l.file}#${l.section}`).sort(), 'the marks and the list agree');
  // The mark sits outside the delegate text, so no delegate receives it.
  for (const l of listed.filter((x) => x.file === 'reference/prompts.md')) {
    const part = read(l.file).split(/\n(?=## )/).find((p) => p.startsWith(`## ${l.section}`));
    assert.ok(part.indexOf(MARK(l.file)) < part.indexOf('~~~text'), l.section);
  }
});

test('the notice claims no endorsement and licenses nothing beyond the adapted material', () => {
  assert.match(notice, /nth-review is not affiliated with, sponsored by or endorsed by Cloudflare, Inc\./);
  assert.match(notice, /This file grants no license of its own: not to nth-review's own contributions \(including its changes to the adapted text\), not to the rest of nth-review, and not to nth-dev-kit\./);
  assert.ok(!/MIT license reproduced below governs/.test(notice), 'the adapted nth-review text is not put under MIT by this file');
  assert.match(notice, /### Written for nth-review/);
  assert.match(notice, /All 16 Markdown files at the commit/);
  for (const rel of ['SKILL.md', 'reference/protocol.md', 'reference/prompts.md', 'reference/taxonomy.md', 'THIRD-PARTY-NOTICES.md']) {
    for (const line of read(rel).split('\n').filter((l) => /endorse/i.test(l))) assert.match(line, /\bnot\b/, `${rel}: ${line}`);
  }
});
