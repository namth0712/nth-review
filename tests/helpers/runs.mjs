// Test-only helpers for run directories: run the CLI in process, and read,
// edit or write records.json fixtures directly (never through the helper's
// own write path, so tests can build states the helper would refuse).
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../../scripts/lib/cli.mjs';

// Runs one CLI invocation in process and returns { code, json, stderr }.
export function nthr(args, { cwd, now, official = false } = {}) {
  const out = [];
  const err = [];
  const code = run(args, {
    cwd,
    now,
    officialAuditsEnabled: official,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  });
  return { code, json: JSON.parse(out.join('')), stderr: err.join('') };
}

// A complete owner charter for `ns`, written directly: the test-only stand-in
// for the gated `charter` command (official audits stay disabled).
export function writeCharter(root, ns = 'audits/core', fields = {}) {
  const file = path.join(root, '.nth-review', ...ns.split('/'), 'charter.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: 'nth-review/charter@1', official: true, namespace: ns, owner: 'Owner Name', scope: 'the synthetic project',
    exclusions: 'none', profile: 'standard', budget_sessions: null, created: '2026-10-26T09:00:00Z', ...fields,
  }));
  return file;
}

// A UTC instant on 2026-10-26, `seconds` after 09:00:00.
export const at = (seconds) => new Date(Date.UTC(2026, 9, 26, 9, 0, seconds));

export const recordsFile = (root, runDir) => path.join(root, ...runDir.split('/'), 'records.json');
export const readRecords = (root, runDir) => JSON.parse(fs.readFileSync(recordsFile(root, runDir), 'utf8'));
export function writeRecords(root, runDir, doc) {
  fs.mkdirSync(path.dirname(recordsFile(root, runDir)), { recursive: true });
  fs.writeFileSync(recordsFile(root, runDir), `${JSON.stringify(doc, null, 2)}\n`);
}

// Marks an open run closed in place, the way `close` will (test-only), and
// adds a report.md. `edit(doc)` may change anything else first.
export function closeRun(root, runDir, { status = 'complete', reason = null, edit } = {}) {
  const doc = readRecords(root, runDir);
  edit?.(doc);
  doc.run.status = status;
  doc.run.incomplete_reason = reason;
  doc.run.closed = doc.run.opened;
  for (const item of doc.debt.in) item.disposition ??= 'carried';
  writeRecords(root, runDir, doc);
  fs.writeFileSync(path.join(root, ...runDir.split('/'), 'report.md'), '# report\n');
  return doc;
}

// Writes `doc` as a run of its own namespace, with report.md for closed runs.
export function writeRun(root, doc, { report = doc.run.status === 'complete' || doc.run.status === 'incomplete' } = {}) {
  const runDir = `.nth-review/${doc.run.namespace}/runs/${doc.run.id}`;
  writeRecords(root, runDir, doc);
  if (report) fs.writeFileSync(path.join(root, ...runDir.split('/'), 'report.md'), '# report\n');
  return runDir;
}
