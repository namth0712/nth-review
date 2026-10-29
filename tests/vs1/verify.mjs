// VS1 verifier. Library-only test tooling. Run it AFTER the isolated Opus
// High session has reviewed the fixture; it judges the closed run against
// the VS1 pass criteria (delivery roadmap §3, as amended by the owner on
// 2026-10-26: no `status` criterion; the lead is Opus High).
//
// Usage: node tests/vs1/verify.mjs <fixture directory>
// Prints one JSON object; exit 0 when every criterion passes, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRun } from '../../scripts/lib/check.mjs';
import { closeRun } from '../../scripts/lib/close.mjs';
import { listRuns, readRun } from '../../scripts/lib/runs.mjs';
import { parseAnchor } from '../../scripts/lib/schema.mjs';
import { CONTROL, PLANTED, VS1, symbolLines } from './fixture.mjs';

// True when `anchor` cites `target.path` within (or without lines, anywhere in) `range`.
function cites(anchor, target, range) {
  const parsed = anchor ? parseAnchor(anchor) : null;
  if (!parsed || parsed.path !== target.path) return false;
  if (!parsed.lines) return true;
  return parsed.lines[0] <= range[1] && parsed.lines[1] >= range[0];
}

// The criteria that depend only on the closed records and the run's files.
export function recordCriteria(doc, { planted, control, packExists }) {
  const results = [];
  const add = (id, pass, detail) => results.push({ id, pass, detail });
  const runtime = doc.run.runtime;
  add('lead-opus-high', runtime.required_lead_model === 'opus-high' && /opus/i.test(runtime.lead_model ?? '') && runtime.lead_effort === 'high' && runtime.triggers.includes('authorization'),
    `required ${runtime.required_lead_model}; lead ${runtime.lead_model} (effort ${runtime.lead_effort}); triggers ${runtime.triggers.join(', ') || 'none'}`);
  const r3 = doc.delegations.filter((d) => d.role === 'R3' && d.agent === 'Explore' && d.model === 'sonnet' && d.completed);
  add('plan-critique', r3.length >= 1, `${r3.length} completed R3 plan-critique delegation(s)`);
  const plantedFindings = doc.findings.filter((f) => f.kind === 'defect' && f.verdict === 'confirmed' && f.trace.some((s) => cites(s.anchor, PLANTED, planted)));
  const refuted = plantedFindings.filter((f) => f.verification.role === 'R5' && f.verification.model === 'opus'
    && !f.verification.incomplete && ['confirmed', 'corrected'].includes(f.verification.outcome));
  add('planted-confirmed', refuted.length >= 1,
    plantedFindings.length ? `${plantedFindings.map((f) => `${f.id} (${f.verification.role}, ${f.verification.outcome})`).join(', ')}` : 'no confirmed defect traces the planted handler');
  add('evidence-first', refuted.length >= 1 && refuted.every((f) => packExists(f.id)), refuted.map((f) => `${f.id}: pack ${packExists(f.id) ? 'present' : 'missing'}`).join(', ') || 'no refuted planted finding');
  const controlConfirmed = doc.findings.filter((f) => f.verdict === 'confirmed' && f.trace.some((s) => cites(s.anchor, CONTROL, control)));
  add('control-not-confirmed', controlConfirmed.length === 0, controlConfirmed.length ? `confirmed: ${controlConfirmed.map((f) => f.id).join(', ')}` : 'the correct handler has no confirmed finding');
  const unfinished = doc.delegations.filter((d) => !d.completed || d.recovery_messages > 1);
  add('delegations-complete', doc.delegations.length > 0 && unfinished.length === 0,
    `${doc.delegations.length} delegation(s); ${unfinished.length} incomplete or over one recovery`);
  return results;
}

export function verifyVs1(fixture) {
  const root = fs.realpathSync.native(fixture);
  const criteria = [];
  const add = (id, pass, detail) => criteria.push({ id, pass, detail });
  const { ids } = listRuns(root, VS1.ns);
  const closed = ids.map((id) => ({ id, ...readRun(root, VS1.ns, id) }))
    .filter((r) => r.doc && ['complete', 'incomplete'].includes(r.doc.run.status));
  const latest = closed.at(-1);
  const runDir = latest ? path.join(root, '.nth-review', ...VS1.ns.split('/'), 'runs', latest.id) : null;
  add('closed-run', Boolean(latest && fs.existsSync(path.join(runDir, 'records.json')) && fs.existsSync(path.join(runDir, 'report.md'))),
    latest ? `${latest.id} (${latest.doc.run.status}${latest.doc.run.incomplete_reason ? `: ${latest.doc.run.incomplete_reason}` : ''})` : `no closed run in ${VS1.ns}`);
  if (!latest) return { pass: false, run: null, criteria };

  const rel = `${VS1.ns}/runs/${latest.id}`;
  const checked = checkRun(root, rel);
  add('check-passes', checked.errors.length === 0, checked.errors.length ? checked.errors.slice(0, 5).join(' | ') : 'check exits 0');
  const planted = symbolLines(path.join(root, ...PLANTED.path.split('/')), PLANTED.symbol);
  const control = symbolLines(path.join(root, ...CONTROL.path.split('/')), CONTROL.symbol);
  criteria.push(...recordCriteria(latest.doc, {
    planted,
    control,
    packExists: (id) => fs.existsSync(path.join(runDir, 'packs', `${id}.md`)),
  }));

  // A second close must be refused and change nothing.
  const before = fs.readFileSync(path.join(runDir, 'records.json'));
  let refused = false;
  let detail = '';
  try {
    closeRun(root, VS1.ns, latest.id, { status: 'complete' });
    detail = 'a second close was accepted';
  } catch (error) {
    refused = error?.refusal === true;
    detail = error.message;
  }
  const unchanged = fs.readFileSync(path.join(runDir, 'records.json')).equals(before);
  add('second-close-refused', refused && unchanged, `${detail}${unchanged ? '' : '; records changed'}`);
  return { pass: criteria.every((c) => c.pass), run: rel, criteria };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    process.stderr.write('usage: node verify.mjs <fixture directory>\n');
    process.exitCode = 2;
  } else {
    const result = verifyVs1(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.pass ? 0 : 1;
  }
}
