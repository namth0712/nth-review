// M5-T4 validation matrix (gate G5). Library-only test tooling: Enable never
// installs it.
//
// Each row runs in a fresh headless Claude Code session on a freshly built
// fixture. The row is then audited for leakage, judged by a fresh blind
// adjudicator session that never sees the answers, frozen by sha256 in an
// append-only, hash-chained ledger, and only then scored against the sealed
// answers. The ledger lives in the kit and holds no absolute path; machine
// state with paths (fixture folders, streams, metrics) stays under --root,
// outside the kit.
//
// Usage: node matrix.mjs <command> --root <dir> [--ledger <file>] [--concurrency <n>] [rows...]
//   plan            the rows, their chains, models and commands
//   register        append the `registered` event (the pre-registered expectations)
//   record-isolation <summary.json>   record a passed isolation check for the installed Claude Code
//   drive [rows] [--max-budget <usd>] [--dry-run]   prepare, run, audit, adjudicate and score each row,
//                   chain by chain; --dry-run prints the batch, its gates and dependencies and runs nothing
//   costs           every matrix session's transcript cost: counted, voided and retried attempts
//   export <rows>   copy scored rows' score and metrics next to the answers
//   record-audit-rule --reason <why>   record the boundary from which audits use AUDIT_RULE
//   rescore --reason <why> [--label <name> | --diagnostic rule4-v2] <rows>
//                   re-score from the frozen adjudication; earlier scores stay; a diagnostic never becomes the score
//                   (refused unless the plan is registered with the current answers and
//                   the isolation was verified on the installed Claude Code version)
//   void <row> <reason...>   abandon a row's attempt so the next drive rebuilds it
//   escalation      a Sonnet lead on the records of each triggered row must fail `check`
//   verify-ledger   the hash chain, the order of events and unchanged answers
//   summary         every row and the G5 dimensions, as JSON
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, buildCuratedFixture, buildFixture, heads as repoHeads } from '../fixtures/build.mjs';
import { GATE, GATE_FILE, MODEL_PINS } from './gate-version.mjs';
import { RUNTIME_ENTRIES } from '../helpers/library.mjs';
import { observedCost, treeDigest, validateBlind } from './score.mjs';
import { makeRelativizer } from './transcript-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = path.resolve(HERE, '..', '..');
// This repository (the source checkout); before its move, the nth-dev-kit checkout.
const KIT = REVIEW;
const FIXTURES = path.join(REVIEW, 'tests', 'fixtures');
export const DEFAULT_LEDGER = path.join(FIXTURES, 'g5-ledger.jsonl');
const NTHR = path.join('.claude', 'skills', 'nth-review', 'scripts', 'nthr.mjs');
const TIMEOUT_REVIEW_MS = 75 * 60 * 1000;
const TIMEOUT_ADJUDICATE_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------- the plan

export const ROWS = [
  { id: 'L1', fixture: 'syn-ledger', model: 'opus' },
  { id: 'L2', fixture: 'syn-ledger', model: 'opus' },
  { id: 'I1c', fixture: 'syn-ledger-inc', from: 'L1', model: 'opus' },
  { id: 'I1r', fixture: 'syn-ledger-inc-rewritten', from: 'L1', model: 'opus' },
  { id: 'I1d', fixture: 'syn-ledger-inc-dirty', from: 'L1', model: 'opus' },
  { id: 'I2c', fixture: 'syn-ledger-inc', from: 'L2', model: 'opus' },
  { id: 'I2r', fixture: 'syn-ledger-inc-rewritten', from: 'L2', model: 'opus' },
  { id: 'I2d', fixture: 'syn-ledger-inc-dirty', from: 'L2', model: 'opus' },
  { id: 'D1', fixture: 'syn-debt', model: 'opus' },
  { id: 'D2', fixture: 'syn-debt', base: 'D1', model: 'opus' },
  { id: 'SO1', fixture: 'syn-shelf', model: 'opus' },
  { id: 'SS1', fixture: 'syn-shelf', model: 'sonnet' },
  { id: 'SO2', fixture: 'syn-shelf', model: 'opus' },
  { id: 'SS2', fixture: 'syn-shelf', model: 'sonnet' },
  // RQ-1 @2, B7: two Opus rows on the independently curated security fixture,
  // run only after its package is recorded and the supplement registered.
  { id: 'SB1', fixture: 'curated-security', model: 'opus', external: true },
  { id: 'SB2', fixture: 'curated-security', model: 'opus', external: true },
];
// The 14 core rows' chains (the main registration), and the security rows'
// (the supplementary registration, on the same frozen implementation).
export const CHAINS = [['L1', 'I1c', 'I1r', 'I1d'], ['L2', 'I2c', 'I2r', 'I2d'], ['D1', 'D2'], ['SO1', 'SS1', 'SO2', 'SS2']];
export const SUPPLEMENT_CHAINS = [['SB1', 'SB2']];
export const CORE_IDS = CHAINS.flat();
const row = (id) => ROWS.find((r) => r.id === id) ?? fail(`unknown row ${id}`);
// Each row's folders in the temporary directory carry a neutral two-letter code
// (`w<x>-…` for its fixture, `r<x>-…` for its adjudication sandbox), so every
// session can be denied every other row's folders, including ones made later.
export const codeOf = (id) => String.fromCharCode(97 + ROWS.findIndex((r) => r.id === id));
// A security row's folders also carry a fixed mark and its run's token
// (`wo-nthsec-<token>-…`): every other session still denies them by the
// two-letter rule, and the row's own session denies its earlier folders by the
// marked prefix, never another project's folders that only share the two
// letters (125 `rp-*` folders once put SB2's adjudicator far over the limit).
// The token comes from the security rows' registration, so it differs per matrix.
export const SECURITY_MARK = 'nthsec-';
export function securityToken(file) {
  const line = readLedger(file).find((l) => JSON.parse(l).event === 'registered-supplement');
  return line ? sha256(line).slice(0, 8) : null;
}
export function folderPrefix(r, role, file) {
  const base = `${role === 'adjudicator' ? 'r' : 'w'}${codeOf(r.id)}-`;
  if (!r.external) return base;
  const token = securityToken(file);
  if (!token) fail(`${r.id}: the security rows are not registered (register-supplement)`);
  return `${base}${SECURITY_MARK}${token}-`;
}
export const answersName = (fixture) => (fixture.startsWith('syn-ledger-inc') ? 'syn-ledger-inc' : fixture);
const isIncremental = (r) => Boolean(r.from || r.base);

// Pre-registered before any run: what routing each row must record.
export const EXPECTED = {
  L: { required_lead_model: 'opus-high', triggers_include: ['task-size', 'authorization', 'money'] },
  I: { required_lead_model: 'opus-high', triggers_include: [] },
  D1: { required_lead_model: 'opus-high', triggers_include: ['money'] },
  D2: { required_lead_model: 'opus-high', triggers_include: [] },
  S: { required_lead_model: 'sonnet', triggers_exactly: [] },
  SB: { required_lead_model: 'opus-high', triggers_include: ['authorization'] },
};
export const expectedFor = (r) => (r.id.startsWith('SB') ? EXPECTED.SB : r.id.startsWith('L') ? EXPECTED.L : r.id.startsWith('I') ? EXPECTED.I : r.id === 'D1' ? EXPECTED.D1 : r.id === 'D2' ? EXPECTED.D2 : EXPECTED.S);

// ---------------------------------------------------------------- helpers

function fail(message) { throw new Error(message); }
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const posixRule = (p) => `//${path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase())}`;
const ABSOLUTE = /[A-Za-z]:[\\/]|(^|[\s"'(=])\/(c|d|Users|home|tmp)\//;
const now = () => new Date().toISOString();
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const projectSlug = (cwd) => fs.realpathSync.native(cwd).replace(/[^A-Za-z0-9]/g, '-');
export const transcriptPath = (cwd, sessionId) => path.join(configDir(), 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (dir, args) => spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '--no-optional-locks', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).stdout.trim();

// The tree digest is shared with the scorer (score.mjs), so the frozen pre-run
// value and the scorer's check use one implementation.
export { treeDigest };
export function diffDigests(before, after) {
  const changes = [];
  for (const [rel, h] of Object.entries(after)) if (before[rel] === undefined) changes.push(`added ${rel}`); else if (before[rel] !== h) changes.push(`changed ${rel}`);
  for (const rel of Object.keys(before)) if (after[rel] === undefined) changes.push(`removed ${rel}`);
  return changes;
}

// ---------------------------------------------------------------- ledger

export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}
export function appendLedger(file, entry) {
  const lines = readLedger(file);
  const record = { seq: lines.length + 1, ts: now(), prev_sha256: lines.length ? sha256(lines[lines.length - 1]) : null, ...entry };
  const text = JSON.stringify(record);
  if (ABSOLUTE.test(text)) fail(`ledger entry holds an absolute path: ${entry.event} ${entry.row ?? ''}`);
  fs.appendFileSync(file, `${text}\n`);
  return record;
}
// The chain, the order of each row's events, the pre-run point against the
// session's first transcript record, and the answers still unchanged.
// `external` ({ dir, evidenceDir }): the curated package and the matrix
// root's `curated/` folder, for the security rows' answers and frozen
// adjudications. Without it, those files are listed as `unchecked`.
export function verifyLedger(file, { answersDir = FIXTURES, external = null } = {}) {
  const lines = readLedger(file);
  const problems = [];
  const unchecked = [];
  const events = [];
  lines.forEach((line, i) => {
    let e;
    try { e = JSON.parse(line); } catch { problems.push(`line ${i + 1}: not JSON`); return; }
    if (e.seq !== i + 1) problems.push(`line ${i + 1}: seq ${e.seq}`);
    const prev = i ? sha256(lines[i - 1]) : null;
    if (e.prev_sha256 !== prev) problems.push(`line ${i + 1}: broken chain`);
    events.push(e);
  });
  const ORDER = ['pre-run', 'closed', 'audited', 'adjudication-frozen', 'scored'];
  const byRow = {};
  // Only a row's last attempt counts: events up to its last `voided` are history.
  for (const e of events.filter((x) => x.row)) {
    if (e.event === 'voided') byRow[e.row] = [];
    else (byRow[e.row] ??= []).push(e);
  }
  for (const [id, es] of Object.entries(byRow)) {
    const seen = es.map((e) => ORDER.indexOf(e.event)).filter((x) => x >= 0);
    if (seen.some((x, i) => i && x < seen[i - 1])) problems.push(`${id}: events out of order`);
    const pre = es.find((e) => e.event === 'pre-run');
    const closed = es.find((e) => e.event === 'closed');
    if (pre && closed?.session_first_ts && !(pre.ts < closed.session_first_ts)) problems.push(`${id}: the pre-run record is not before the session`);
    const frozen = es.find((e) => e.event === 'adjudication-frozen');
    const scored = es.find((e) => e.event === 'scored');
    if (scored && !frozen) problems.push(`${id}: scored without a frozen adjudication`);
    const curatedRow = pre?.answers === 'curated';
    if (frozen?.verdicts_sha256 && pre?.answers && (curatedRow ? external?.evidenceDir : answersDir)) {
      const file = curatedRow
        ? path.join(external.evidenceDir, 'adjudications', `${frozen.run_id}.blind.json`)
        : path.join(answersDir, pre.answers, 'adjudications', `${frozen.run_id}.blind.json`);
      if (!fs.existsSync(file)) problems.push(`${id}: the frozen adjudication file is missing`);
      else if (sha256(fs.readFileSync(file)) !== frozen.verdicts_sha256) problems.push(`${id}: the adjudication file differs from its frozen sha256`);
    } else if (frozen?.verdicts_sha256 && curatedRow) unchecked.push(`${id}: the frozen adjudication (curated evidence folder not given)`);
    if (pre?.answers_sha256 && curatedRow) {
      if (!external?.dir) unchecked.push(`${id}: the curated answers (package folder not given)`);
      else if (sha256(fs.readFileSync(path.join(external.dir, 'answers.json'))) !== pre.answers_sha256) problems.push(`${id}: the curated answers changed since the run`);
    } else if (pre?.answers_sha256 && answersDir) {
      const file = path.join(answersDir, pre.answers, 'answers.json');
      if (fs.existsSync(file) && sha256(fs.readFileSync(file)) !== pre.answers_sha256) problems.push(`${id}: the answers changed since the run`);
    }
  }
  // RQ-1 @2: a security row runs only after the supplement, on the package it names.
  const supplement = events.find((e) => e.event === 'registered-supplement');
  if (supplement) {
    const cur = events.find((e) => e.seq === supplement.curated_seq);
    if (!cur || cur.event !== 'curated-package' || cur.seq > supplement.seq) problems.push('the supplement names no earlier curated-package event');
    else if (cur.package_sha256 !== supplement.package_sha256 || cur.answers_sha256 !== supplement.answers_sha256) problems.push('the supplement\'s digests differ from its curated-package event');
  }
  for (const e of events.filter((x) => x.event === 'pre-run' && x.answers === 'curated')) {
    if (!supplement || supplement.seq > e.seq) problems.push(`${e.row} (seq ${e.seq}): a security row started before the supplement`);
    else if (e.answers_sha256 !== supplement.answers_sha256 || e.package_sha256 !== supplement.package_sha256) problems.push(`${e.row} (seq ${e.seq}): the package or answers differ from the registered ones`);
  }
  // Every audit recorded after an `audit-corrected` event names that rule; every one before it does not.
  const corrected = events.find((e) => e.event === 'audit-corrected');
  if (corrected) {
    for (const e of events.filter((x) => x.event === 'audited' || x.event === 'adjudication-frozen')) {
      if (e.seq > corrected.seq && e.audit_rule !== corrected.rule) problems.push(`${e.row}: an audit after seq ${corrected.seq} does not name ${corrected.rule}`);
      if (e.seq < corrected.seq && e.audit_rule === corrected.rule) problems.push(`${e.row}: an audit before seq ${corrected.seq} names ${corrected.rule}`);
    }
  }
  const registered = events.find((e) => e.event === 'registered');
  const firstPre = events.find((e) => e.event === 'pre-run');
  if (firstPre && (!registered || registered.seq > firstPre.seq)) problems.push('the plan was not registered before the first run');
  // A registration with an implementation manifest (M5-T4R) binds every attempt to it.
  if (registered?.implementation) {
    for (const e of events.filter((x) => x.event === 'pre-run')) {
      if (e.kit?.implementation_sha256 !== registered.implementation.digest || e.kit?.frozen !== true) problems.push(`${e.row} (seq ${e.seq}): the pre-run implementation differs from the registered one`);
      if (e.kit?.environment_sha256 !== registered.implementation.environment.digest) problems.push(`${e.row} (seq ${e.seq}): the session configuration differs from the registered one`);
      if (e.skill_sha256 !== registered.skill_sha256) problems.push(`${e.row} (seq ${e.seq}): the installed skill differs from the registered one`);
    }
    // A row's official score comes from the registered scorer (a later `rescored` event names its own).
    const scorer = registered.implementation.files.find((f) => f.path === 'tests/tools/score.mjs')?.sha256;
    for (const e of events.filter((x) => x.event === 'scored')) {
      if (e.scorer_sha256 !== scorer) problems.push(`${e.row} (seq ${e.seq}): scored by a scorer other than the registered one`);
    }
  }
  return { ok: problems.length === 0, events: events.length, rows: Object.keys(byRow).length, voided: events.filter((e) => e.event === 'voided').map((e) => `${e.row}: ${e.reason}`), problems, unchecked };
}

// The installed Claude Code version, as `claude --version` prints it.
export function claudeVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
  return (r.stdout ?? '').trim().split(/\s+/)[0] || null;
}
// Paid rows run only on the Claude Code version whose isolation (the session
// guard's fail-closed behaviour) was last verified and recorded in the ledger.
export function isolationOk(file, version) {
  const ev = readLedger(file).map((l) => JSON.parse(l)).filter((e) => e.event === 'isolation-verified').at(-1);
  if (!ev) return 'the session isolation is not verified';
  if (!ev.passed) return 'the last isolation check did not pass';
  if (ev.claude_version !== version) return `the isolation was verified on Claude Code ${ev.claude_version}, not ${version}`;
  return null;
}

// The plan must be registered, with the answers the files hold now.
export function registeredOk(file, answersDir = FIXTURES) {
  const reg = readLedger(file).map((l) => JSON.parse(l)).find((e) => e.event === 'registered');
  if (!reg) return 'the plan is not registered';
  for (const [name, sha] of Object.entries(reg.answers_sha256 ?? {})) {
    if (sha256(fs.readFileSync(path.join(answersDir, name, 'answers.json'))) !== sha) return `${name} answers changed since registration`;
  }
  return null;
}

// ---------------------------------------------------------------- RQ-1 @2

const eventsOf = (file) => readLedger(file).map((l) => JSON.parse(l));
export const registeredEvent = (file) => eventsOf(file).find((e) => e.event === 'registered') ?? null;
export const curatedEvent = (file) => eventsOf(file).filter((e) => e.event === 'curated-package').at(-1) ?? null;
export const supplementEvent = (file) => eventsOf(file).find((e) => e.event === 'registered-supplement') ?? null;
const isExternal = (id) => Boolean(ROWS.find((r) => r.id === id)?.external);

// The curated security package (SECURITY-FIXTURE-SPEC.md): `answers.json`, one
// `attestation.<ext>` (the curator's statement) and `repos/<repo>.bundle`
// (`root.bundle` for `.`). Read only; nothing in it is run.
export function curatedPackage(dir) {
  const real = fs.realpathSync.native(dir);
  const answersFile = path.join(real, 'answers.json');
  if (!fs.existsSync(answersFile)) fail('the curated package has no answers.json');
  const attestations = fs.readdirSync(real).filter((n) => /^attestation\.[A-Za-z0-9]+$/.test(n));
  if (attestations.length !== 1) fail('the curated package needs exactly one attestation.<ext> file: the curator\'s independence statement');
  const reposDir = path.join(real, 'repos');
  const names = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((n) => n.endsWith('.bundle')).sort() : [];
  if (!names.includes('root.bundle')) fail('the curated package needs repos/root.bundle');
  const repoOf = (n) => (n === 'root.bundle' ? '.' : n.slice(0, -'.bundle'.length));
  const hash = (file) => sha256(fs.readFileSync(file));
  const entries = [['answers.json', hash(answersFile)], [attestations[0], hash(path.join(real, attestations[0]))], ...names.map((n) => [`repos/${n}`, hash(path.join(reposDir, n))])];
  return {
    dir: real, answersFile,
    answers_sha256: entries[0][1], attestation_sha256: entries[1][1],
    bundles: Object.fromEntries(names.map((n) => [repoOf(n), path.join(reposDir, n)])),
    bundle_sha256: names.map((n, i) => ({ repo: repoOf(n), sha256: entries[i + 2][1] })),
    package_sha256: sha256(entries.map(([p, h]) => `${p} ${h}`).sort().join('\n')),
  };
}
// Where the package lies: never in the kit, a Git work tree or the temporary
// folder. Recorded only as a digest; the path stays in state.json.
export function curatedLocation(dir) {
  const real = fs.realpathSync.native(dir).toLowerCase();
  const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  // Outside Git only when Git says so: an error (dubious ownership, no Git) proves nothing.
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } });
  const outsideGit = probe.status !== 0 && /not a git repository/i.test(probe.stderr ?? '');
  return {
    location_sha256: sha256(real),
    outside_kit: !inside(real, fs.realpathSync.native(KIT).toLowerCase()),
    outside_git: outsideGit,
    outside_tmp: !inside(real, fs.realpathSync.native(os.tmpdir()).toLowerCase()),
  };
}
function bundleHeads(file) {
  const res = spawnSync('git', ['bundle', 'list-heads', file], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) fail(`a bundle cannot be read: ${(res.stderr ?? '').split('\n')[0]}`);
  return res.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((x) => /^[0-9a-f]{40}$/.test(x));
}
const CHANGE = /^([^:\s]+):([^\s.][^\s]*)\.\.([^\s]+)$/;

// Records the package before any security row: its digests, the curator's
// attestation digest, the heads and the review's --change specs. Refused once
// the security rows are registered or have started. `testDouble` marks a
// synthetic package built by tests: B7 never counts one.
export function recordCuratedPackage(ctx, dir, { changes = [], testDouble = false, locate = curatedLocation } = {}) {
  const events = eventsOf(ctx.ledger);
  if (events.some((e) => e.event === 'registered-supplement')) fail('refused: the security rows are already registered on a recorded package');
  if (events.some((e) => e.event === 'pre-run' && isExternal(e.row))) fail('refused: a security row has already started');
  const pkg = curatedPackage(dir);
  const loc = locate(pkg.dir);
  if (!testDouble && !(loc.outside_kit && loc.outside_git && loc.outside_tmp)) fail('refused: keep the curated package outside the kit, every Git work tree and the temporary folder (SECURITY-FIXTURE-SPEC.md §1)');
  const answers = readJson(pkg.answersFile);
  if (answers.schema !== 'nthr-fixture-answers@1') fail('refused: answers.json is not nthr-fixture-answers@1');
  const heads = answers.heads ?? {};
  if (JSON.stringify(Object.keys(heads).sort()) !== JSON.stringify(Object.keys(pkg.bundles).sort())) fail('refused: the bundles and the answers\' heads name different repositories');
  for (const [repo, file] of Object.entries(pkg.bundles)) {
    if (!bundleHeads(file).includes(heads[repo])) fail(`refused: no ref of ${repo === '.' ? 'root' : repo}.bundle holds the head the answers record`);
  }
  if (!changes.length) fail('refused: give the review\'s --change specs (<repo>:<a>..<b>), from the curator\'s note');
  for (const c of changes) {
    const m = CHANGE.exec(c);
    if (!m || !Object.hasOwn(heads, m[1])) fail(`refused: --change ${c} is not <repo>:<a>..<b> for a repository of the package`);
  }
  const ev = appendLedger(ctx.ledger, {
    event: 'curated-package', gate: GATE, package_sha256: pkg.package_sha256, bundles: pkg.bundle_sha256,
    answers_sha256: pkg.answers_sha256, attestation_sha256: pkg.attestation_sha256, heads, changes,
    location_sha256: loc.location_sha256, location_checks: { outside_kit: loc.outside_kit, outside_git: loc.outside_git, outside_tmp: loc.outside_tmp },
    test_double: testDouble,
  });
  ctx.state.curated = { dir: pkg.dir, seq: ev.seq, changes };
  saveState(ctx.root, ctx.state);
  return ev;
}

// Once a package is recorded, every session runs only while it is the
// recorded one, at the recorded place (so the deny rule names it).
export function curatedProblem(ctx, { locate = curatedLocation } = {}) {
  const ev = curatedEvent(ctx.ledger);
  if (!ev) return null;
  const dir = ctx.state.curated?.dir;
  if (!dir || !fs.existsSync(dir)) return 'a curated package is recorded, but its folder is unknown or gone (state.json curated.dir)';
  if (locate(dir).location_sha256 !== ev.location_sha256) return 'the curated package folder is not the recorded one';
  if (curatedPackage(dir).package_sha256 !== ev.package_sha256) return 'the curated package changed since it was recorded';
  return null;
}

// D5 (RQ-1 @3): the versions a registration records. Auto-update is not
// required to be off: a Claude Code update during the matrix stops it at the
// next row, audit or score (versionProblem), so versions never mix.
export function toolVersions(version = claudeVersion()) {
  const gitVersion = (spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout ?? '').trim();
  return { claude_code: version, node: process.version, git: gitVersion, os: `${os.platform()} ${os.release()} ${os.arch()}`, model_pins: MODEL_PINS };
}
// The installed Claude Code must stay the registered one for every step.
export function versionProblem(file, version) {
  const reg = registeredEvent(file);
  if (!reg?.versions) return null;
  return version && reg.versions.claude_code === version ? null : `Claude Code is ${version ?? 'not found'}, but the matrix was registered on ${reg.versions.claude_code}`;
}
// Every `version` a transcript's records carry.
export function transcriptVersions(files) {
  const out = new Set();
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /"version":"([^"]+)"/.exec(line);
      if (m) out.add(m[1]);
    }
  }
  return [...out];
}
// A row's resolved models and Claude Code versions against the registered
// pins: the lead on its row's pin, delegates and unlinked sessions within the
// pins, every transcript record on the registered version.
export function pinProblems(metrics, model, versions, transcripts = []) {
  const problems = [];
  const pin = MODEL_PINS[model];
  const allowed = Object.values(MODEL_PINS);
  const lead = metrics?.lead?.models?.values ?? [];
  if (!lead.length) problems.push('no resolved lead model');
  for (const m of lead) if (m !== pin) problems.push(`lead model ${m}, pinned ${pin}`);
  for (const d of metrics?.delegations ?? []) for (const m of d.transcript?.models?.values ?? []) if (!allowed.includes(m)) problems.push(`delegate model ${m}`);
  for (const u of metrics?.unlinked_transcripts ?? []) for (const m of u.models?.values ?? []) if (!allowed.includes(m)) problems.push(`unlinked session model ${m}`);
  if (versions?.claude_code) for (const v of transcriptVersions(transcripts)) if (v !== versions.claude_code) problems.push(`transcript version ${v}, registered ${versions.claude_code}`);
  return problems;
}

// The security rows' registration: after the main one, on the same frozen
// implementation, skill, Claude Code version and configuration, naming the
// recorded package.
export function registerSupplement(ctx, { implementation = implementationManifest(), version = claudeVersion(), locate = curatedLocation } = {}) {
  const events = eventsOf(ctx.ledger);
  const reg = events.find((e) => e.event === 'registered');
  if (!reg) fail('refused: the main plan is not registered');
  if (events.some((e) => e.event === 'registered-supplement')) fail('refused: the security rows are already registered');
  const cur = events.filter((e) => e.event === 'curated-package').at(-1);
  if (!cur || cur.seq < reg.seq) fail('refused: record the curated package after the main registration (record-curated-package)');
  const unfrozen = implementationOk(ctx.ledger, implementation);
  if (unfrozen) fail(`refused: ${unfrozen}`);
  const unverified = isolationOk(ctx.ledger, version);
  if (unverified) fail(`refused: ${unverified}`);
  const drift = versionProblem(ctx.ledger, version);
  if (drift) fail(`refused: ${drift}`);
  const curated = curatedProblem(ctx, { locate });
  if (curated) fail(`refused: ${curated}`);
  const external = ROWS.filter((r) => r.external);
  return appendLedger(ctx.ledger, {
    event: 'registered-supplement', gate: GATE, plan: external.map((r) => ({ id: r.id, fixture: r.fixture, model: r.model, expected: expectedFor(r) })),
    chains: SUPPLEMENT_CHAINS, curated_seq: cur.seq, package_sha256: cur.package_sha256, answers_sha256: cur.answers_sha256, test_double: cur.test_double === true,
    implementation_sha256: implementation.digest, skill_sha256: reg.skill_sha256, versions: reg.versions ?? null,
  });
}

// ---------------------------------------------------------------- sessions

// Reviewer: the routing the row requires. Sonnet gets no effort flag (the
// session then runs at high, observed in M5-T4); Opus always gets high.
export function reviewerArgs(r, prompt, { denyRoots, denyFiles = [], settings = null, budgetUsd = null }) {
  const model = r.model === 'sonnet' ? ['--model', 'sonnet'] : ['--model', 'opus', '--effort', 'high'];
  return ['-p', prompt, ...model, '--output-format', 'stream-json', '--verbose', ...PERMISSIONS, ...guardFlags(settings), ...budgetFlags(budgetUsd),
    '--disallowedTools', 'WebFetch', 'WebSearch', 'PowerShell', 'NotebookEdit', ...GIT_WRITES, ...denyRules(denyRoots, denyFiles)];
}
// Permissions (M5-T4 isolation): the default mode, prompts answered by nobody,
// and no allow rule for shell commands or writes. The session guard's explicit
// approval is the only way such a call runs, so a guard that crashes, is
// missing or times out lets none through; the hook also blocks on failure.
// Reads keep their deny rules, which do not depend on the guard.
const PERMISSIONS = ['--permission-mode', 'default', '--permission-prompts', 'none'];
// Claude Code stops a print-mode session once its spend reaches this cap.
const budgetFlags = (usd) => (usd ? ['--max-budget-usd', usd.toFixed(2)] : []);
// The owner's spending cap for one drive: a review session gets what is left
// minus a reserve for its adjudication; the adjudicator gets the rest. A
// session whose cost is not reported counts at its full cap.
export const ADJUDICATION_RESERVE_USD = 3;
export function sessionCap(ctx, role) {
  if (!ctx.budget) return null;
  const left = ctx.budget.cap - ctx.budget.spent;
  const cap = role === 'reviewer' ? left - ADJUDICATION_RESERVE_USD : left;
  return cap >= 0.5 ? Math.floor(cap * 100) / 100 : 0;
}
function charge(ctx, cost, cap) {
  if (!ctx.budget) return;
  ctx.budget.spent += Number.isFinite(cost) ? cost : cap ?? 0;
  saveState(ctx.root, { ...ctx.state, budget: ctx.budget });
}

// The session guard (session-guard.mjs) as this session's PreToolUse hook, and
// no MCP server. The settings go in a file under the matrix root.
const guardFlags = (settings) => (settings ? ['--strict-mcp-config', '--settings', settings] : []);
// The hook runs node directly (no shell), and any failure of it blocks the call.
export function guardHook({ role, root, log, script = path.join(HERE, 'session-guard.mjs') }) {
  return { type: 'command', command: process.execPath, args: [script, '--role', role, '--root', path.resolve(root), '--log', path.resolve(log)], onFailure: 'block', timeout: 30 };
}
// Claude Code's block message names the hook command, so the guard runs from a
// neutral copy in the temporary folder (denied to every session), never from
// the kit; its log sits beside it.
export function stageGuard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  const script = path.join(dir, 'guard.mjs');
  fs.copyFileSync(path.join(HERE, 'session-guard.mjs'), script);
  return { dir, script, log: path.join(dir, 'log.jsonl'), sha256: sha256(fs.readFileSync(script)) };
}
export function writeGuardSettings(file, opts, hook = guardHook(opts)) {
  const doc = { hooks: { PreToolUse: [{ matcher: '*', hooks: [hook] }] } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}
const denyRules = (roots, files) => [...roots.flatMap((d) => [`Read(${d}/**)`, `Grep(${d}/**)`, `Glob(${d}/**)`]), ...files.map((f) => `Read(${f})`)];
// Direct Git write forms are refused up front; `git -C <dir> <write>` is caught by the audit.
const GIT_WRITES = ['add', 'commit', 'push', 'reset', 'checkout', 'restore', 'stash', 'rebase', 'merge', 'tag', 'branch', 'gc'].map((c) => `Bash(git ${c}:*)`);
// Adjudicator: Opus at high effort, read-only Git, no node, no agents, no edits.
export function adjudicatorArgs(prompt, { denyRoots, denyFiles = [], settings = null, budgetUsd = null }) {
  return ['-p', prompt, '--model', 'opus', '--effort', 'high', '--output-format', 'stream-json', '--verbose', ...PERMISSIONS, ...guardFlags(settings), ...budgetFlags(budgetUsd),
    '--disallowedTools', 'WebFetch', 'WebSearch', 'PowerShell', 'Agent', 'Task', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash(node:*)', ...GIT_WRITES, ...denyRules(denyRoots, denyFiles)];
}
export function adjudicatorPrompt(runDirRel) {
  return fs.readFileSync(path.join(HERE, 'adjudicator-prompt.md'), 'utf8').replace(/\{\{RUN_DIR\}\}/g, runDirRel);
}
// What a session may not read (M5-T4 preflight):
// - the folder above the kit: the kit with its answers, the research worktrees;
// - in the configuration: the installed kit, file history, plans, to-dos, shell
//   snapshots, debug logs, session state and the prompt history, and the
//   project folders of every session under that folder (this development
//   session's transcripts hold the answers), every project's memory and the
//   configuration's state file;
// - every other Claude Code configuration in the home folder, whole, and the
//   state files there (otherConfigurations);
// - in the temporary folder: the matrix root, those sessions' scratchpads and
//   task outputs, the earlier review fixtures (`ledger-*`, `nthr-*`) and their
//   sessions' folders, the escalation copies;
// - every other row's fixture and sandbox, and their sessions' project folders;
//   a reviewer also no sandbox of its own row, an adjudicator no fixture;
// - the folders and project folders of voided attempts;
// - under the session's own row code, every folder but its own: earlier
//   attempts and earlier matrices (M5-T4's fixtures, sandboxes and transcripts
//   carry the same codes), each denied by its exact path (M5-T4R, B1).
// The session's own folder (`ownDir`, the fixture or the sandbox) and its own
// project folder stay readable: Claude Code writes large tool results there
// and the model reads them back.
// The folder that holds this repository's development checkouts, research and
// sessions: three levels above it (as it was two above the
// nth-dev-kit checkout before the move). Never a filesystem root, nor a folder
// holding the temporary folder or the home folder: those hold the session's own
// folders. Then the nearest lower level that qualifies, or the repository itself.
export function kitParentOf(kit = KIT) {
  const holds = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  for (const up of [3, 2, 1]) {
    const dir = path.resolve(kit, ...Array(up).fill('..'));
    if (path.parse(dir).root === dir || holds(dir, os.tmpdir()) || holds(dir, os.homedir())) continue;
    return dir;
  }
  return kit;
}
export function denyRootsFor(root, role = 'reviewer', ownId = null, voided = [], { ownDir = null, bound = false } = {}) {
  const tmp = posixRule(os.tmpdir());
  const cfg = posixRule(configDir());
  const projects = `${cfg}/projects`;
  const tmpSlug = projectSlug(os.tmpdir());
  const kitParent = kitParentOf();
  const roots = [
    posixRule(kitParent), posixRule(root),
    ...['nth-dev-kit', 'file-history', 'plans', 'todos', 'shell-snapshots', 'debug', 'session-env'].map((d) => `${cfg}/${d}`),
    // The installed nth-review package and its marketplace copy hold tests/ and the sealed answers.
    `${cfg}/plugins/cache/nth-review`, `${cfg}/plugins/marketplaces/nth-review`,
    `${projects}/${projectSlug(kitParent)}*`,
    `${tmp}/claude/${projectSlug(kitParent)}*`, `${tmp}/ledger-*`, `${tmp}/nthr-*`, `${tmp}/esc-*`, `${tmp}/sg-*`,
    ...['ledger', 'nthr'].flatMap((n) => [`${projects}/${tmpSlug}-${n}-*`, `${tmp}/claude/${tmpSlug}-${n}-*`]),
    // Every project's memory in this configuration, and every other configuration whole.
    `${projects}/*/memory`, ...otherConfigurations().roots,
  ];
  for (const r of ROWS) {
    const x = codeOf(r.id);
    const own = r.id === ownId;
    for (const [prefix, ownRole] of [['w', 'reviewer'], ['r', 'adjudicator']]) {
      // A security row's own folders are only the marked ones (folderPrefix).
      if (own && role === ownRole) roots.push(...sameCodeRoots(`${prefix}${x}-${r.external ? SECURITY_MARK : ''}`, ownDir, { bound }));
      else roots.push(`${tmp}/${prefix}${x}-*`, `${projects}/${tmpSlug}-${prefix}${x}-*`, `${tmp}/claude/${tmpSlug}-${prefix}${x}-*`);
    }
  }
  for (const slug of voided) roots.push(`${projects}/${slug}`);
  return roots;
}
// Every folder that exists now under the session's own code, except the
// session's own: in the temporary folder, the configuration's projects and
// Claude Code's temporary project folders. Exact, so the own folder stays
// open; complete, because the matrix runs one session at a time and only a
// later session can create another folder with this code. `bound` (the
// command-line preflight) exempts nothing, so it counts at least as many.
function sameCodeRoots(prefix, ownDir, { bound = false } = {}) {
  if (!bound && (!ownDir || !fs.existsSync(ownDir))) fail(`the session's own folder is required to deny the rest of its row code (${prefix}*)`);
  const own = new Set(bound ? [] : [path.basename(fs.realpathSync.native(ownDir)), projectSlug(ownDir)].map((n) => n.toLowerCase()));
  const tmpSlug = projectSlug(os.tmpdir());
  const places = [[os.tmpdir(), prefix], [path.join(configDir(), 'projects'), `${tmpSlug}-${prefix}`], [path.join(os.tmpdir(), 'claude'), `${tmpSlug}-${prefix}`]];
  const out = [];
  for (const [dir, start] of places) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.toLowerCase().startsWith(start.toLowerCase()) && !own.has(e.name.toLowerCase())) out.push(posixRule(path.join(dir, e.name)));
    }
  }
  return out;
}
export const denyFilesFor = () => [`${posixRule(configDir())}/history.jsonl`, `${posixRule(configDir())}/.claude.json`, ...otherConfigurations().files];
// The other Claude Code configurations in the home folder (`.claude`,
// `.claude-alt`, `.claude-api`, ...: every folder named `.claude*` but the
// matrix's own), and the state files there (`.claude.json` and its backups).
// Their transcripts, memory and history belong to other work, so each is
// denied whole. The matrix's own configuration keeps the finer rules above:
// its sessions' own project folders must stay readable.
export function otherConfigurations({ home = os.homedir(), config = configDir() } = {}) {
  const key = (p) => (process.platform === 'linux' ? p : p.toLowerCase());
  const real = (p) => key(fs.existsSync(p) ? fs.realpathSync.native(p) : path.resolve(p));
  const own = real(config);
  const roots = [];
  const files = [];
  if (!fs.existsSync(home)) return { roots, files };
  for (const name of fs.readdirSync(home).filter((n) => /^\.claude/i.test(n)).sort()) {
    const abs = path.join(home, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) { if (real(abs) !== own) roots.push(posixRule(abs)); }
    else if (st.isFile()) files.push(posixRule(abs));
  }
  return { roots, files };
}
// Windows limits a command line to 32,767 characters, and the deny rules grow
// with every earlier folder of a row's code. A session whose command would
// not fit is refused before it starts: it costs nothing and never runs with
// fewer rules. Archiving earlier matrices' folders out of the temporary folder
// is what shortens the list.
export const COMMAND_LINE_LIMIT = 32000;
export const commandLineLength = (args) => args.reduce((n, a) => n + a.length + 3, 'claude'.length);
export function commandLineProblem(args) {
  const n = commandLineLength(args);
  return n > COMMAND_LINE_LIMIT ? `the session command line is ${n} characters, over ${COMMAND_LINE_LIMIT}; archive earlier matrices' folders of this row code` : null;
}
// The deny lists for one row's session, with every voided attempt's project
// folders, keyed to the session's own folder.
// Once a curated package is recorded, its folder is denied to every session.
export function denyFor(ctx, id, role, ownDir, { bound = false, voided = [] } = {}) {
  const curated = ctx.state.curated?.dir ? [posixRule(ctx.state.curated.dir)] : [];
  return { denyRoots: [...denyRootsFor(ctx.root, role, id, [...Object.values(ctx.state.voided ?? {}).flat(), ...voided], { ownDir, bound }), ...curated], denyFiles: denyFilesFor() };
}
// Every command line a batch needs, bounded before any paid session:
// - the deny lists as they stand now, exempting no own folder (a session
//   exempts only its own), plus the attempts the drive itself will void (an
//   interrupted row is voided before it runs again; any other void stops the drive);
// - the helper's longest run id and namespace where a run is not known yet;
// - the drive's whole spending cap in the budget flag, and the settings file
//   name the runner will use.
// Each row's adjudicator is bounded before its review is paid for.
const RUN_ID_BOUND = '9'.repeat(92); // YYYYMMDD-HHMMSS-incremental-<64-character slug>
const RUN_DIR_BOUND = path.join('.nth-review', 'experiments', 'x'.repeat(64), 'runs', RUN_ID_BOUND);
const STAMP_BOUND = '9'.repeat(13); // Date.now() in the guard settings file name
export function commandLineBounds(ctx, ids) {
  const pending = ids.map(row).filter((r) => !ctx.state.rows[r.id]?.scored);
  const willVoid = pending.flatMap((r) => {
    const s = ctx.state.rows[r.id];
    return s?.started && !s?.closed ? [s.fixture_dir, s.sandbox].filter((d) => d && fs.existsSync(d)).map(projectSlug) : [];
  });
  const budgetUsd = ctx.budget?.cap ?? null;
  const known = { ...ctx.state, rows: Object.fromEntries(ROWS.map((x) => [x.id, { ...(ctx.state.rows[x.id] ?? {}), run_id: ctx.state.rows[x.id]?.run_id ?? RUN_ID_BOUND }])) };
  const out = [];
  for (const r of pending) {
    const s = ctx.state.rows[r.id] ?? {};
    const deny = (role) => denyFor(ctx, r.id, role, null, { bound: true, voided: willVoid });
    if (!s.closed) {
      const prompt = s.prompt ?? `${commandFor(r, known)}\n\n${operatorNote(r)}`;
      out.push({ row: r.id, role: 'reviewer', length: commandLineLength(reviewerArgs(r, prompt, { ...deny('reviewer'), settings: path.join(ctx.root, 'guard', `${r.id}-${STAMP_BOUND}.settings.json`), budgetUsd })) });
    }
    if (!s.frozen) {
      out.push({ row: r.id, role: 'adjudicator', length: commandLineLength(adjudicatorArgs(adjudicatorPrompt(s.run_dir ?? RUN_DIR_BOUND), { ...deny('adjudicator'), settings: path.join(ctx.root, 'guard', `${r.id}-adj-${STAMP_BOUND}.settings.json`), budgetUsd })) });
    }
  }
  return out;
}
// The preflight: any bound over the limit refuses the batch, before anything is paid.
export function commandLinePreflight(ctx, ids, { limit = COMMAND_LINE_LIMIT } = {}) {
  const bounds = commandLineBounds(ctx, ids);
  const over = bounds.filter((b) => b.length > limit);
  const longest = bounds.reduce((m, b) => (!m || b.length > m.length ? b : m), null);
  return { limit, longest, over, problems: over.map((b) => `${b.row} ${b.role}: up to ${b.length} characters, over ${limit}`) };
}
// The curated package's folder in the forms a tool input may name it.
export const curatedNeedles = (dir) => (dir ? [...new Set([dir.replace(/\\/g, '/').toLowerCase(), posixRule(dir).slice(1).toLowerCase()])] : []);

function runClaude(args, cwd, streamFile, timeoutMs) {
  return new Promise((resolve) => {
    const out = fs.openSync(streamFile, 'w');
    const err = fs.openSync(`${streamFile}.err`, 'w');
    const started = Date.now();
    let done = false;
    const finish = (code, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.closeSync(out);
      fs.closeSync(err);
      resolve({ code, error, wall_s: Math.round((Date.now() - started) / 1000), timed_out: Date.now() - started >= timeoutMs });
    };
    // A session never updates Claude Code under the matrix (the isolation was verified on one version).
    const child = spawn('claude', args, { cwd, stdio: ['ignore', out, err], windowsHide: true, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
    const timer = setTimeout(() => { try { spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); } catch { child.kill(); } }, timeoutMs);
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code));
  });
}
export function streamFacts(file) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = parsed.find((x) => x.type === 'system' && x.subtype === 'init');
  const result = [...parsed].reverse().find((x) => x.type === 'result');
  return { session_id: init?.session_id ?? result?.session_id ?? null, result_subtype: result?.subtype ?? null, is_error: result?.is_error ?? null, cost_usd: result?.total_cost_usd ?? null, result_text: typeof result?.result === 'string' ? result.result.slice(0, 400) : null };
}

// ---------------------------------------------------------------- audit

const LABELS = /answers\.json|tests[\\/]{1,2}fixtures|[\\/]nth-dev-kit(?:[\\/"]|$)|nth-review[\\/]{1,2}research|g5-ledger|[\\/]nth-review[\\/]{1,2}(?:tests|RELEASE\.md|VALIDATION\.md|MIGRATION-VALIDATION\.md|INSTALL\.md|README\.md|\.claude-plugin)(?:[\\/"]|$)|plugins[\\/]{1,2}(?:cache|marketplaces)[\\/]{1,2}nth-review/i;
// The owner's private labels (the project that holds the research folder),
// from the unpublished tests/tools/private.json when it exists.
const PRIVATE_LABELS = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(HERE, 'private.json'), 'utf8')).labels ?? []).map((l) => String(l).toLowerCase()); } catch { return []; }
})();
// Tool inputs that name the sealed side, the kit or the research folder.
export function labelMentions(transcriptFiles, { needles = [] } = {}) {
  const hits = [];
  for (const file of transcriptFiles) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"tool_use"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      for (const block of rec.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        const text = JSON.stringify(block.input ?? {});
        // A JSON-encoded Windows path doubles each backslash.
        const flat = text.replace(/\\\\/g, '/').toLowerCase();
        const m = text.match(LABELS)?.[0] ?? PRIVATE_LABELS.find((l) => flat.includes(l));
        if (m) hits.push({ tool: block.name, match: m });
        if (needles.some((n) => flat.includes(n))) hits.push({ tool: block.name, match: 'the curated package' });
      }
    }
  }
  return hits;
}
// The audit's own-output rule. v1 (registered at preflight, applied to every
// audit up to the `audit-corrected` ledger event): a `Read` of the session's
// own project folder was not leakage. v2 (owner decision D, after batch 4;
// audits recorded after that event only): a `Read`, `Grep` or `Glob` whose
// path is exactly one of the session's verified tool-result files (see
// verifiedToolResults) is not leakage. Nothing else is exempt: no other file
// in any Claude project folder, no shell command, no Git.
export const AUDIT_RULE = 'own-tool-results-v2';
const OWN_OUTPUT_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// The tool-result files Claude Code announced in this session's own
// transcripts ("saved to: <path>"), kept only when the file lies directly in
// <config>/projects/<the session's folder>/<the session id>/tool-results/, is
// a regular file and not a link, and its real path stays there. Returned in
// the metrics tool's printed form, for exact comparison.
export function verifiedToolResults(transcriptFiles, { cwd, sessionId, config = configDir(), home = os.homedir() }) {
  if (!cwd || !sessionId) return [];
  const root = path.join(config, 'projects', projectSlug(cwd), sessionId, 'tool-results');
  const fold = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  let realRoot;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return [];
    realRoot = fs.realpathSync.native(root);
    if (fold(realRoot) !== fold(path.resolve(root))) return [];
  } catch { return []; }
  const shown = makeRelativizer({ fixture: cwd, tmp: os.tmpdir(), home });
  const out = new Set();
  // Only this exact session's own transcripts can announce its files.
  const sessionFile = fold(path.join(config, 'projects', projectSlug(cwd), `${sessionId}.jsonl`));
  const subagents = fold(path.join(config, 'projects', projectSlug(cwd), sessionId, 'subagents')) + path.sep;
  for (const file of transcriptFiles) {
    if (!file || !fs.existsSync(file)) continue;
    const f = fold(path.resolve(file));
    if (f !== sessionFile && !(f.startsWith(subagents) && f.endsWith('.jsonl'))) continue;
    // Decoded strings of each record (the raw JSONL escapes backslashes).
    const texts = [];
    const collect = (v) => { if (typeof v === 'string') { if (v.includes('saved to:')) texts.push(v); } else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x); };
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('saved to:')) continue;
      try { collect(JSON.parse(line)); } catch { /* not a record */ }
    }
    for (const m of texts.flatMap((t) => [...t.matchAll(/saved to:\s*((?:[A-Za-z]:)?[\\/][^\r\n"<>|*?]*?[\\/]tool-results[\\/][A-Za-z0-9._-]+)/g)])) {
      const candidate = path.resolve(m[1]);
      if (fold(path.dirname(candidate)) !== fold(path.resolve(root))) continue;
      try {
        const st = fs.lstatSync(candidate);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        if (fold(path.dirname(fs.realpathSync.native(candidate))) !== fold(realRoot)) continue;
      } catch { continue; }
      out.add(shown.place(candidate).shown);
    }
  }
  return [...out];
}

// Executed unsafe actions invalidate a row; denied attempts are counted apart.
export function classifySafety(safety, { ownFiles = [] } = {}) {
  const unsafe = [];
  const add = (category, list, predicate = () => true) => {
    for (const x of list ?? []) if (predicate(x)) unsafe.push({ category, agent: x.agent, tool: x.tool, outcome: x.outcome, detail: x.path ?? x.command ?? x.detail ?? null });
  };
  // AUDIT_RULE: only a Read, Grep or Glob of exactly one of the session's verified tool-result files is its own output.
  const fold = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const verified = new Set(ownFiles.map((f) => fold(String(f).replace(/\\/g, '/'))));
  const own = (x) => OWN_OUTPUT_TOOLS.has(x.tool) && typeof x.path === 'string' && !/[*?[\]{}]/.test(x.path) && verified.has(fold(x.path.replace(/\\/g, '/')));
  add('outside path', safety.outside_paths, (x) => !own(x));
  add('git write', safety.git_writes);
  add('web', safety.web);
  add('network', safety.network);
  add('sensitive', safety.sensitive, (x) => !x.note);
  add('write outside .nth-review', safety.writes, (x) => x.kind === 'file tool' && (x.inside_fixture === false || !/(^|[\\/])\.nth-review[\\/]/.test(String(x.path ?? ''))) && !/verdicts\.json$/.test(String(x.path ?? '')));
  add('inline-code write', safety.writes, (x) => x.kind === 'inline code');
  const executed = unsafe.filter((u) => u.outcome !== 'denied');
  const denied = unsafe.filter((u) => u.outcome === 'denied');
  const deniedIds = new Set((safety.writes ?? []).concat(safety.outside_paths ?? []).filter((x) => x.outcome === 'denied').map((x) => x.tool_use));
  const benignDenials = (safety.denials?.list ?? []).filter((d) => !deniedIds.has(d.tool_use)).length;
  const leakage = executed.filter((u) => ['outside path', 'git write', 'web', 'network', 'sensitive', 'write outside .nth-review'].includes(u.category));
  return { executed, denied, benign_denials: benignDenials, leakage };
}

// ---------------------------------------------------------------- state

function loadState(root) {
  const file = path.join(root, 'state.json');
  return fs.existsSync(file) ? readJson(file) : { rows: {} };
}
function saveState(root, state) {
  fs.writeFileSync(path.join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}
function log(root, message) {
  fs.appendFileSync(path.join(root, 'progress.log'), `${now()} ${message}\n`);
}
function runsIn(dir) {
  const base = path.join(dir, '.nth-review');
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (fs.existsSync(path.join(p, 'records.json'))) out.push(path.relative(dir, p).replace(/\\/g, '/'));
      else walk(p);
    }
  };
  walk(base);
  return out.sort();
}

// ---------------------------------------------------------------- steps

// ---------------------------------------------------------------- implementation freeze (M5-T4R, B3)

// The repository files that decide how a G5 row runs, is judged and is
// measured: what Enable installs as the skill, the lifecycle document and the
// package manifests it reads, the runner, guard, metrics, scorer, evidence tool
// and adjudicator prompt, the fixture builder with its templates, the Enable
// transcription and helpers it uses, the sealed answers, the written criteria
// and the repeat's plan. Ledgers and earlier scores are evidence, not inputs.
// (Before the move to its own repository these paths carried the prefix
// `agents/claude/integrations/review/`, and the lifecycle document was
// `agents/claude/integrations/review.md`.)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MATERIAL = [
  /^INSTALL\.md$/,
  /^runtime-manifest\.json$/,
  /^\.claude-plugin\/[^/]+$/,
  new RegExp(`^(${RUNTIME_ENTRIES.map(esc).join('|')})(/|$)`),
  /^tests\/(tools\/.+|fixtures\/(build\.mjs|README\.md|g5-criteria\/.+|[^/]+\/(answers\.json|tree\/.+))|m4\/operator\.mjs|helpers\/(library|tmp)\.mjs|G5-REPEAT-PLAN\.md|RELEASE-GATE(-[23])?\.md)$/,
];

// The session isolation (deny-rule path forms, project-folder names, the
// guard's path handling) was verified live on Windows only (M5-T4 seq 9).
// Elsewhere every command that records isolation, registers or starts a paid
// session refuses, rather than run with an unproven sandbox.
export const VERIFIED_PLATFORMS = Object.freeze(['win32']);
export function platformProblem(platform = process.platform) {
  return VERIFIED_PLATFORMS.includes(platform)
    ? null
    : `the matrix's session isolation is verified only on ${VERIFIED_PLATFORMS.join(', ')}; on ${platform} it is unproven, so no session is started`;
}
export const isMaterial = (rel) => MATERIAL.some((re) => re.test(rel));
export function materialFiles(kit = KIT) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(kit, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
      if (!rel && e.name === '.git') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && isMaterial(child)) out.push(child);
    }
  };
  walk('');
  return out.sort();
}
// Each file's Git state against HEAD (clean, modified, untracked, ignored or
// deleted), and the tracked files that are gone: a deleted or renamed-away
// material file is not frozen either.
function gitStates(kit) {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', '.'], { cwd: kit, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`git status failed in the kit: ${(r.stderr || '').trim()}`);
  const states = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    const xy = parts[i].slice(0, 2);
    states.push([parts[i].slice(3), xy === '??' ? 'untracked' : xy === '!!' ? 'ignored' : xy.includes('D') ? 'deleted' : 'modified']);
    if (/[RC]/.test(xy[0])) {
      i += 1; // the source path follows; a rename takes it away from HEAD
      if (xy[0] === 'R') states.push([parts[i], 'deleted']);
    }
  }
  return {
    of: (rel) => states.find(([p]) => p === rel || (p.endsWith('/') && rel.startsWith(p)))?.[1] ?? 'clean',
    deleted: states.filter(([p, s]) => s === 'deleted' && !p.endsWith('/')).map(([p]) => p),
  };
}
const digestOf = (entries) => sha256(entries.map((e) => `${e.path}\0${e.sha256}\n`).join(''));
// The configuration the sessions run under shapes them too: its global
// instructions, rules, agents, skills, hook scripts, settings and plugin pins.
// Hashed only, never copied (settings may hold credentials); outside Git, so
// pinned by digest. Files that change by themselves (status caches, state
// files, sync markers) are left out.
const ENVIRONMENT = ['CLAUDE.md', 'rules', 'agents', 'skills', 'output-styles', 'nth-dev-kit-hooks', 'settings.json', 'plugins/installed_plugins.json'];
const VOLATILE = /(^|\/)(nth-status\/.*|[^/]*\.state\.json|\.last-complete-round)$/;
export function environmentManifest(config = configDir()) {
  const files = [];
  const add = (rel) => {
    const abs = path.join(config, ...rel.split('/'));
    if (!fs.existsSync(abs) || VOLATILE.test(rel)) return;
    if (fs.statSync(abs).isDirectory()) for (const e of fs.readdirSync(abs)) add(`${rel}/${e}`);
    else files.push({ path: `<config>/${rel}`, sha256: sha256(fs.readFileSync(abs)) });
  };
  for (const rel of ENVIRONMENT) add(rel);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { digest: digestOf(files), files };
}
// What a G5 matrix runs: the HEAD, every material file with its sha256 and Git
// state, and the session configuration. `frozen` only when every material file
// equals HEAD, so a dirty work tree is never taken for a frozen implementation.
export function implementationManifest({ kit = KIT, config = configDir() } = {}) {
  const states = gitStates(kit);
  const files = materialFiles(kit).map((rel) => ({ path: rel, sha256: sha256(fs.readFileSync(path.join(kit, ...rel.split('/')))), git: states.of(rel) }));
  for (const rel of states.deleted) if (isMaterial(rel) && !files.some((f) => f.path === rel)) files.push({ path: rel, sha256: null, git: 'deleted' });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { head: git(kit, ['rev-parse', 'HEAD']) || null, frozen: files.every((f) => f.git === 'clean'), digest: digestOf(files), files, environment: environmentManifest(config) };
}
const listDiff = (before, after) => {
  const a = new Map(before.map((f) => [f.path, f.sha256]));
  const b = new Map(after.map((f) => [f.path, f.sha256]));
  const out = [...b].filter(([p, h]) => a.get(p) !== h).map(([p]) => (a.has(p) ? `changed ${p}` : `added ${p}`));
  return [...out, ...[...a.keys()].filter((p) => !b.has(p)).map((p) => `removed ${p}`)].slice(0, 8).join(', ');
};
// Paid rows run only on the registered implementation, still frozen, under the registered configuration.
export function implementationOk(file, current) {
  const reg = readLedger(file).map((l) => JSON.parse(l)).find((e) => e.event === 'registered');
  if (!reg?.implementation) return 'the registration records no implementation manifest';
  if (!current.frozen) return `the implementation is not frozen: ${current.files.filter((f) => f.git !== 'clean').slice(0, 8).map((f) => `${f.git} ${f.path}`).join(', ')}`;
  if (current.digest !== reg.implementation.digest) return `the material files changed since registration: ${listDiff(reg.implementation.files, current.files)}`;
  if (current.environment.digest !== reg.implementation.environment.digest) return `the session configuration changed since registration: ${listDiff(reg.implementation.environment.files, current.environment.files)}`;
  return null;
}
const kitSummary = (impl) => ({ head: impl.head, frozen: impl.frozen, implementation_sha256: impl.digest, environment_sha256: impl.environment.digest });
function stillRegistered(ctx, id, step) {
  const problem = implementationOk(ctx.ledger, implementationManifest()) ?? versionProblem(ctx.ledger, claudeVersion()) ?? curatedProblem(ctx);
  if (problem) ctx.abort = `${id}, before its ${step}: ${problem}`;
  return !problem;
}
// The skill a row's fixture will hold, from a throwaway build (registration only).
function builtSkillSha256() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-skill-'));
  try {
    buildFixture('syn-shelf', path.join(dir, 'f'));
    return treeDigest(path.join(dir, 'f', '.claude', 'skills', 'nth-review')).sha256;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The fact the lead cannot observe (its own effort) and that no one answers
// during an unattended run. It says nothing about the code under review.
export function operatorNote(r) {
  const session = r.model === 'sonnet' ? 'Sonnet at its default effort, which is high' : 'Opus at high effort (set with --effort high)';
  return `Operator note for this unattended run: this session runs on ${session}. Nobody will reply to questions until the session ends, so record anything you would ask as the protocol says and continue to the close.`;
}

export function commandFor(r, state) {
  if (r.external) return `/nth-review task --ns experiments/app --slug app ${(state.curated?.changes ?? []).map((c) => `--change ${c}`).join(' ')}`;
  if (r.base) return `/nth-review incremental --ns experiments/payouts --slug payouts-r2 --base ${state.rows[r.base].run_id}`;
  if (r.from) return `/nth-review incremental --ns experiments/ledger --slug ledger-inc --base ${state.rows[r.from].run_id}`;
  return COMMANDS[r.fixture];
}

function prepare(ctx, r) {
  const { root, ledger, state } = ctx;
  const s = (state.rows[r.id] ??= {});
  if (s.prepared) return;
  let dir;
  let curated = null;
  if (r.external) {
    // RQ-1 @2, B7: from the recorded curated package, read but never run.
    const problem = curatedProblem(ctx);
    if (problem) fail(`${r.id}: ${problem}`);
    const ev = curatedEvent(ledger);
    curated = { ev, pkg: curatedPackage(state.curated.dir) };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), folderPrefix(r, 'reviewer', ctx.ledger)));
    buildCuratedFixture(curated.pkg.bundles, dir, { heads: ev.heads });
  } else if (r.base) {
    const b = state.rows[r.base];
    if (!b?.closed || !b?.sandboxed) fail(`${r.id}: ${r.base} has not closed and been copied for adjudication`);
    // A copy of the base row's fixture, so the base keeps its own tree and a voided attempt leaves nothing behind.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), folderPrefix(r, 'reviewer', ctx.ledger)));
    fs.cpSync(b.fixture_dir, dir, { recursive: true });
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), folderPrefix(r, 'reviewer', ctx.ledger)));
    const from = r.from ? state.rows[r.from] : null;
    if (r.from && !from?.closed) fail(`${r.id}: ${r.from} has not closed`);
    buildFixture(r.fixture, dir, from ? { from: from.fixture_dir } : {});
  }
  const answers = curated ? 'curated' : answersName(r.fixture);
  const answersText = fs.readFileSync(curated ? curated.pkg.answersFile : path.join(FIXTURES, answers, 'answers.json'));
  const repoNames = curated ? Object.keys(curated.ev.heads) : ['.', 'api', 'admin'];
  const repos = Object.fromEntries(repoNames.filter((x) => fs.existsSync(path.join(dir, x, '.git'))).map((x) => [x, x]));
  const tree = treeDigest(dir);
  s.fixture_dir = dir;
  s.tree_before = tree.files;
  s.runs_before = runsIn(dir);
  s.command = commandFor(r, state);
  s.prompt = `${s.command}\n\n${operatorNote(r)}`;
  const skill = treeDigest(path.join(dir, '.claude', 'skills', 'nth-review'));
  const impl = ctx.implementation ?? implementationManifest();
  const registered = readLedger(ledger).map((l) => JSON.parse(l)).find((e) => e.event === 'registered');
  if (registered?.skill_sha256 && skill.sha256 !== registered.skill_sha256) {
    fs.rmSync(dir, { recursive: true, force: true });
    delete s.fixture_dir;
    ctx.abort = `${r.id}: the installed skill differs from the registered one`;
    return;
  }
  appendLedger(ledger, {
    event: 'pre-run', row: r.id, fixture: r.fixture, answers, answers_sha256: sha256(answersText),
    heads: repoHeads(dir, repos), tree_sha256: tree.sha256, skill_sha256: skill.sha256, kit: kitSummary(impl),
    model: r.model, effort: r.model === 'opus' ? 'high' : 'default (observed high)', command: s.command, operator_note: operatorNote(r),
    ...(ctx.version ? { claude_version: ctx.version } : {}),
    ...(curated ? { external: true, package_sha256: curated.ev.package_sha256, curated_seq: curated.ev.seq } : {}),
  });
  s.prepared = true;
  saveState(root, state);
  log(root, `${r.id} prepared`);
}

async function run(ctx, r) {
  const { root, ledger, state } = ctx;
  const s = state.rows[r.id];
  if (s.closed || s.failed) return;
  if (s.started) { voidRow(ctx, r.id, 'interrupted: the driver stopped during the session'); return; }
  const tag = `${r.id}-${Date.now()}`;
  s.tag = tag;
  const stream = path.join(root, `${tag}.stream.jsonl`);
  s.started = now();
  saveState(root, state);
  log(root, `${r.id} session started (${r.model})`);
  const guard = stageGuard();
  s.guard_log = guard.log;
  s.guard_sha256 = guard.sha256;
  const settings = writeGuardSettings(path.join(root, 'guard', `${tag}.settings.json`), { role: 'reviewer', root: s.fixture_dir, log: guard.log, script: guard.script });
  saveState(root, state);
  const cap = sessionCap(ctx, 'reviewer');
  if (cap === 0) { ctx.abort = `the spending cap leaves no room for ${r.id}`; delete s.started; saveState(root, state); return; }
  s.budget_cap_usd = cap;
  const args = reviewerArgs(r, s.prompt, { ...denyFor(ctx, r.id, 'reviewer', s.fixture_dir), settings, budgetUsd: cap });
  const tooLong = commandLineProblem(args);
  if (tooLong) { ctx.abort = `${r.id}: ${tooLong}`; delete s.started; saveState(root, state); return; }
  const res = await runClaude(args, s.fixture_dir, stream, TIMEOUT_REVIEW_MS);
  const facts = streamFacts(stream);
  charge(ctx, facts.cost_usd, cap);
  s.costs = { review_usd: facts.cost_usd };
  const newRuns = runsIn(s.fixture_dir).filter((x) => !s.runs_before.includes(x));
  s.stream = stream;
  s.session_id = facts.session_id;
  s.transcript = facts.session_id ? transcriptPath(s.fixture_dir, facts.session_id) : null;
  s.run_dir = newRuns.length === 1 ? newRuns[0] : null;
  const records = s.run_dir ? readJson(path.join(s.fixture_dir, s.run_dir, 'records.json')) : null;
  s.run_id = records?.run?.id ?? null;
  let first = null;
  if (s.transcript && fs.existsSync(s.transcript)) {
    for (const line of fs.readFileSync(s.transcript, 'utf8').split('\n')) {
      try { const t = JSON.parse(line).timestamp; if (t && (!first || t < first)) first = t; } catch { /* skip */ }
    }
  }
  const closed = records?.run?.status && records.run.status !== 'open' && records?.run?.closed;
  appendLedger(ledger, {
    event: 'closed', row: r.id, session_id: facts.session_id, session_first_ts: first, exit_code: res.code, wall_s: res.wall_s, timed_out: res.timed_out,
    result_subtype: facts.result_subtype, is_error: facts.is_error, run_id: s.run_id, run_dir: s.run_dir, run_status: records?.run?.status ?? null,
    incomplete_reason: records?.run?.incomplete_reason ?? null, runs_created: newRuns.length, cost_usd: facts.cost_usd, budget_cap_usd: cap,
  });
  if (!closed) {
    const why = facts.result_subtype === 'error_max_budget_usd'
      ? `stopped at the spending cap of $${cap} before the run closed`
      : `the session ended without a closed run (exit ${res.code}${res.timed_out ? ', timed out' : ''}${res.error ? `, ${res.error}` : ''}${facts.result_text ? `: ${facts.result_text}` : ''})`;
    const errText = fs.existsSync(`${stream}.err`) ? fs.readFileSync(`${stream}.err`, 'utf8').slice(-2000) : '';
    if (res.error || (facts.is_error && LIMIT.test(`${facts.result_text ?? ''} ${errText}`))) {
      // Infrastructure, not a review result: abandon the attempt and stop.
      ctx.abort = why;
      voidRow(ctx, r.id, `infrastructure: ${why}`.slice(0, 300));
      return;
    }
    s.failed = why;
  } else s.closed = true;
  saveState(root, state);
  log(root, `${r.id} ${s.closed ? `closed ${records.run.status}` : `FAILED ${s.failed}`} in ${res.wall_s}s`);
}

const LIMIT = /usage limit|limit reached|hit your limit|rate.?limit|overloaded|credit balance/i;

// Abandon a row's attempt: the ledger says why, and the next drive rebuilds
// the row in a new fixture. Only for infrastructure failures or by hand.
export function voidRow(ctx, id, reason) {
  const s = ctx.state.rows[id] ?? {};
  appendLedger(ctx.ledger, { event: 'voided', row: id, reason, run_id: s.run_id ?? null, session_id: s.session_id ?? null, costs_usd: s.costs ?? null });
  // The attempt's folders move under the matrix root, which no session may read;
  // a retry also may not read the attempt's project folders.
  ctx.state.voided ??= {};
  const n = (ctx.state.voided[id] ??= []).length;
  for (const [key, dir] of [['fixture', s.fixture_dir], ['sandbox', s.sandbox]]) {
    if (!dir || !fs.existsSync(dir)) continue;
    const shared = Object.entries(ctx.state.rows).some(([other, o]) => other !== id && (o.fixture_dir === dir || o.sandbox === dir));
    if (shared) continue;
    ctx.state.voided[id].push(projectSlug(dir));
    const dest = path.join(ctx.root, 'voided', `${id}-${n + 1}-${key}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(dir, dest); } catch { fs.cpSync(dir, dest, { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  delete ctx.state.rows[id];
  saveState(ctx.root, ctx.state);
  log(ctx.root, `${id} VOIDED ${reason}`);
}

function metricsFor(transcript, stream, recordsFile, fixtureDir, out) {
  const args = [path.join(HERE, 'transcript-metrics.mjs'), '--session', transcript, '--stream', stream, '--fixture', fixtureDir, ...(recordsFile ? ['--records', recordsFile] : [])];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) fail(`transcript-metrics: ${res.stderr}`);
  fs.writeFileSync(out, res.stdout);
  return JSON.parse(res.stdout);
}
// Proof that the guard saw every tool call: each tool use in the transcripts
// has a guard decision, and none the guard blocked has a successful result.
export function guardCoverage(transcriptFiles, logFile) {
  const uses = new Map();
  const results = new Map();
  for (const file of transcriptFiles) {
    if (!file || !fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('tool_')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      for (const b of rec.message?.content ?? []) {
        if (b.type === 'tool_use') uses.set(b.id, b.name);
        if (b.type === 'tool_result') results.set(b.tool_use_id, Boolean(b.is_error));
      }
    }
  }
  const entries = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const byId = new Map(entries.filter((e) => e.tool_use_id).map((e) => [e.tool_use_id, e]));
  const problems = [];
  // A call refused before the hook (a deny rule, a disabled tool) never ran: only executed calls need a decision.
  const executed = [...uses.keys()].filter((id) => results.get(id) === false);
  const missing = executed.filter((id) => !byId.has(id));
  if (!entries.length && executed.length) problems.push('no guard decision was logged: the guard did not run');
  else if (missing.length) problems.push(`${missing.length} tool calls without a guard decision`);
  const blocked = entries.filter((e) => e.decision === 'block');
  const executedDespiteBlock = blocked.filter((e) => e.tool_use_id && results.get(e.tool_use_id) === false);
  if (executedDespiteBlock.length) problems.push(`${executedDespiteBlock.length} blocked calls have a successful result`);
  return { tool_uses: uses.size, executed: executed.length, refused_before_guard: [...uses.keys()].filter((id) => results.get(id) === true && !byId.has(id)).length, allowed: entries.filter((e) => e.decision === 'allow').length, blocked, missing, problems };
}

function subagentFiles(transcript) {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];
}

function audit(ctx, r) {
  const { root, ledger, state } = ctx;
  const s = state.rows[r.id];
  if (s.audited || !s.closed) return;
  const recordsFile = path.join(s.fixture_dir, s.run_dir, 'records.json');
  const metrics = metricsFor(s.transcript, s.stream, recordsFile, s.fixture_dir, path.join(root, `${s.tag ?? r.id}.metrics.json`));
  const ownFiles = verifiedToolResults([s.transcript, ...subagentFiles(s.transcript)], { cwd: s.fixture_dir, sessionId: s.session_id });
  const safety = classifySafety(metrics.safety, { ownFiles });
  const labels = labelMentions([s.transcript, ...subagentFiles(s.transcript)], { needles: curatedNeedles(state.curated?.dir) });
  const guard = guardCoverage([s.transcript, ...subagentFiles(s.transcript)], s.guard_log);
  const after = treeDigest(s.fixture_dir).files;
  const treeChanges = diffDigests(s.tree_before, after);
  // D5: a registration with pinned versions binds every row's models and Claude Code version.
  const versions = registeredEvent(ledger)?.versions ?? null;
  const pins = versions ? pinProblems(metrics, r.model, versions, [s.transcript, ...subagentFiles(s.transcript)]) : [];
  if (pins.length) ctx.abort = `${r.id}: ${pins[0]} (the environment drifted from the registration)`;
  const reasons = [
    ...safety.leakage.map((u) => `${u.category} executed by ${u.agent}`),
    ...labels.map((l) => `a ${l.tool} input names ${l.match}`),
    ...guard.problems,
    ...treeChanges.map((c) => `fixture ${c}`),
    ...pins.map((p) => `pin: ${p}`),
  ];
  s.valid = reasons.length === 0;
  s.metrics = path.join(root, `${s.tag ?? r.id}.metrics.json`);
  // A copy for the adjudicator, without the skill: taken now, before any later row writes here.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), folderPrefix(r, 'adjudicator', ctx.ledger)));
  fs.cpSync(s.fixture_dir, sandbox, { recursive: true, filter: (src) => !path.relative(s.fixture_dir, src).replace(/\\/g, '/').startsWith('.claude') });
  s.sandbox = sandbox;
  s.sandbox_tree = treeDigest(sandbox).files;
  s.sandboxed = true;
  appendLedger(ledger, {
    event: 'audited', row: r.id, run_id: s.run_id, valid: s.valid, invalid_reasons: reasons,
    unsafe_executed: safety.executed.map((u) => `${u.category} (${u.agent}, ${u.tool})`), unsafe_denied: safety.denied.map((u) => `${u.category} (${u.agent}, ${u.tool})`),
    benign_denials: safety.benign_denials, records_sha256: sha256(fs.readFileSync(recordsFile)), audit_rule: AUDIT_RULE, own_tool_results_verified: ownFiles.length,
    guard: { sha256: s.guard_sha256 ?? null, tool_uses: guard.tool_uses, executed: guard.executed, allowed: guard.allowed, refused_before_guard: guard.refused_before_guard, blocked: guard.blocked.map((b) => `${b.tool}: ${String(b.reason ?? '').replace(/[A-Za-z]:[\\/][^\s]*|(^|\s)\/(?:[A-Za-z]|Users|home|tmp)\/[^\s]*|~\/[^\s]*/g, ' <path>').trim()}`) },
  });
  s.audited = true;
  saveState(root, state);
  log(root, `${r.id} audited: ${s.valid ? 'valid' : `INVALID ${reasons.join('; ')}`}`);
}

async function adjudicate(ctx, r) {
  const { root, ledger, state } = ctx;
  const s = state.rows[r.id];
  if (s.frozen || !s.audited) return;
  const stream = path.join(root, `${s.tag ?? r.id}.adj.stream.jsonl`);
  log(root, `${r.id} adjudicator started`);
  const adjTag = `${r.id}-adj-${Date.now()}`;
  const adjGuard = stageGuard();
  s.adj_guard_log = adjGuard.log;
  const adjDeny = { ...denyFor(ctx, r.id, 'adjudicator', s.sandbox), settings: writeGuardSettings(path.join(root, 'guard', `${adjTag}.settings.json`), { role: 'adjudicator', root: s.sandbox, log: adjGuard.log, script: adjGuard.script }) };
  const adjCap = sessionCap(ctx, 'adjudicator');
  if (adjCap === 0) { ctx.abort = `the spending cap leaves no room for ${r.id}'s adjudication`; return; }
  const adjArgs = adjudicatorArgs(adjudicatorPrompt(s.run_dir), { ...adjDeny, budgetUsd: adjCap });
  const adjTooLong = commandLineProblem(adjArgs);
  if (adjTooLong) { ctx.abort = `${r.id}'s adjudication: ${adjTooLong}`; return; }
  const res = await runClaude(adjArgs, s.sandbox, stream, TIMEOUT_ADJUDICATE_MS);
  const facts = streamFacts(stream);
  charge(ctx, facts.cost_usd, adjCap);
  s.costs = { ...(s.costs ?? {}), adjudication_usd: facts.cost_usd };
  const verdictsFile = path.join(s.sandbox, 'verdicts.json');
  const recordsDoc = readJson(path.join(s.fixture_dir, s.run_dir, 'records.json'));
  // Before the freeze: a file the scorer would reject gets one repair turn in
  // the same session, which still has seen no answer.
  const problemsOf = () => {
    if (!fs.existsSync(verdictsFile)) return ['verdicts.json was not written'];
    let doc;
    try { doc = JSON.parse(fs.readFileSync(verdictsFile, 'utf8')); } catch (e) { return [`verdicts.json is not JSON: ${e.message}`]; }
    if (doc.schema !== 'nthr-adjudication-blind@1') return ['schema must be nthr-adjudication-blind@1'];
    return validateBlind(doc, null, null, recordsDoc, null).summary.problems ?? [];
  };
  let problems = problemsOf();
  let repaired = null;
  if (problems.length && facts.session_id) {
    const repairStream = path.join(root, `${s.tag ?? r.id}.adj-repair.stream.jsonl`);
    const prompt = `verdicts.json cannot be used yet: ${problems.slice(0, 20).join('; ')}. Fix only these problems in verdicts.json (the shape and values given earlier; anchors as path:line or path:L1-L2 with a plain hyphen), change no judgement, and reply with one line.`;
    const repCap = sessionCap(ctx, 'adjudicator');
    const repArgs = ['--resume', facts.session_id, ...adjudicatorArgs(prompt, { ...adjDeny, budgetUsd: repCap })];
    const repTooLong = commandLineProblem(repArgs);
    if (repTooLong) log(root, `${r.id} repair turn not started: ${repTooLong}`);
    const rep = repCap === 0 || repTooLong ? { code: null } : await runClaude(repArgs, s.sandbox, repairStream, TIMEOUT_ADJUDICATE_MS);
    if (repCap !== 0 && !repTooLong) charge(ctx, streamFacts(repairStream).cost_usd, repCap);
    s.costs = { ...(s.costs ?? {}), repair_usd: streamFacts(repairStream).cost_usd };
    repaired = { problems_before: problems.slice(0, 20), exit_code: rep.code, cost_usd: streamFacts(repairStream).cost_usd };
    problems = problemsOf();
  }
  const bytes = fs.existsSync(verdictsFile) ? fs.readFileSync(verdictsFile) : null;
  const transcript = facts.session_id ? transcriptPath(s.sandbox, facts.session_id) : null;
  const recordsFile = path.join(s.fixture_dir, s.run_dir, 'records.json');
  const notes = [];
  let metrics = null;
  if (transcript && fs.existsSync(transcript)) {
    metrics = metricsFor(transcript, stream, null, s.sandbox, path.join(root, `${s.tag ?? r.id}.adj.metrics.json`));
    const safety = classifySafety(metrics.safety, { ownFiles: verifiedToolResults([transcript], { cwd: s.sandbox, sessionId: facts.session_id }) });
    for (const u of safety.leakage) notes.push(`${u.category} executed`);
    for (const l of labelMentions([transcript], { needles: curatedNeedles(state.curated?.dir) })) notes.push(`names ${l.match}`);
    const models = metrics.lead?.models?.values ?? [];
    const efforts = metrics.lead?.effort?.values ?? [];
    // D5: with pinned versions, the adjudicator resolves to the Opus pin exactly.
    const pinned = registeredEvent(ledger)?.versions ? (m) => m === MODEL_PINS.opus : (m) => /opus/.test(m);
    if (!(models.length === 1 && pinned(models[0]) && efforts.length === 1 && efforts[0] === 'high')) notes.push(`routing ${models.join(',')}/${efforts.join(',')}`);
    if ((metrics.delegations ?? []).length) notes.push('delegated');
    for (const p of guardCoverage([transcript], s.adj_guard_log).problems) notes.push(p);
  } else notes.push('no adjudicator transcript');
  if (facts.session_id && facts.session_id === s.session_id) notes.push('same session as the reviewer');
  const sandboxChanges = diffDigests(s.sandbox_tree, treeDigest(s.sandbox).files).filter((c) => c !== 'added verdicts.json');
  for (const c of sandboxChanges) notes.push(`sandbox ${c}`);
  if (!bytes) notes.push('no verdicts.json');
  const independent = notes.length === 0;
  const frozen = appendLedger(ledger, {
    event: 'adjudication-frozen', row: r.id, run_id: s.run_id, verdicts_sha256: bytes ? sha256(bytes) : null,
    records_sha256: sha256(fs.readFileSync(recordsFile)), adjudicator_session_id: facts.session_id, exit_code: res.code, wall_s: res.wall_s,
    independent, independence_problems: notes, adjudicator_cost_usd: facts.cost_usd, repair: repaired, problems_after_repair: problems.slice(0, 20), audit_rule: AUDIT_RULE,
  });
  s.frozen = true;
  s.adjudication = { stream, transcript, sha256: frozen.verdicts_sha256, independent, notes, metrics: metrics ? path.join(root, `${s.tag ?? r.id}.adj.metrics.json`) : null };
  if (bytes) {
    const dir = evidenceDir(ctx, r, 'adjudications');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${s.run_id}.blind`);
    fs.writeFileSync(`${base}.json`, bytes);
    fs.writeFileSync(`${base}.meta.json`, `${JSON.stringify({
      schema: 'nthr-adjudication-freeze@1', row: r.id, run: s.run_id, sha256: frozen.verdicts_sha256, records_sha256: frozen.records_sha256,
      ledger_seq: frozen.seq, adjudicator: 'a fresh headless Claude Code session (Opus, high effort) that saw the run records and the source only', adjudicator_session_id: facts.session_id,
      independent, ...(independent ? {} : { independence_note: notes.join('; ') }),
      authorship_note: 'The fixture, its answers and the adjudicator prompt were written by the development session; the prompt holds no answer.',
    }, null, 2)}\n`);
    s.adjudication.file = `${base}.json`;
  }
  saveState(root, state);
  log(root, `${r.id} adjudication frozen (${independent ? 'independent' : `NOT independent: ${notes.join('; ')}`})`);
}

// The row's latest attempt's pre-run record (after its last voided event).
export function preRunEvent(ledgerFile, id) {
  let found = null;
  for (const e of readLedger(ledgerFile).map((l) => JSON.parse(l))) {
    if (e.row !== id) continue;
    if (e.event === 'voided') found = null;
    if (e.event === 'pre-run') found = e;
  }
  return found;
}
const scorerSha = () => sha256(fs.readFileSync(path.join(HERE, 'score.mjs')));
// Where a row's frozen adjudication and exported scores go: next to the kit's
// sealed answers, or, for the curated security rows, under the matrix root,
// never in the kit (the curated answers stay out of development's reach).
export function evidenceDir(ctx, r, kind) {
  return r.external ? path.join(ctx.root, 'curated', kind) : path.join(FIXTURES, answersName(r.fixture), kind);
}
function answersFileFor(ctx, r) {
  if (!r.external) return path.join(FIXTURES, answersName(r.fixture), 'answers.json');
  const problem = curatedProblem(ctx);
  if (problem) fail(`${r.id}: ${problem}`);
  const file = path.join(ctx.state.curated.dir, 'answers.json');
  if (sha256(fs.readFileSync(file)) !== preRunEvent(ctx.ledger, r.id)?.answers_sha256) fail(`${r.id}: the curated answers differ from the pre-run record`);
  return file;
}
function runScorer(ctx, r, s, extra = []) {
  const answers = answersFileFor(ctx, r);
  const args = [path.join(HERE, 'score.mjs'), '--answers', answers, '--run', path.join(s.fixture_dir, s.run_dir), '--fixture', s.fixture_dir, '--metrics', s.metrics, ...extra];
  if (s.adjudication?.file) args.push('--adjudication', s.adjudication.file, '--adjudication-meta', s.adjudication.file.replace(/\.json$/, '.meta.json'));
  const pre = preRunEvent(ctx.ledger, r.id);
  if (pre?.tree_sha256) args.push('--pre-run-tree', pre.tree_sha256);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) fail(`${r.id} score: ${res.stderr}`);
  return res;
}

function scoreRow(ctx, r) {
  const { root, ledger, state } = ctx;
  const s = state.rows[r.id];
  if (s.scored || !s.frozen) return;
  const res = runScorer(ctx, r, s);
  const out = path.join(root, `${s.tag ?? r.id}.score.json`);
  fs.writeFileSync(out, res.stdout);
  const sc = JSON.parse(res.stdout);
  s.score = out;
  exportRow(r, s, { root });
  appendLedger(ledger, {
    event: 'scored', row: r.id, run_id: s.run_id, score_sha256: sha256(res.stdout), scorer_sha256: scorerSha(), official: sc.official, adjudication: sc.adjudication?.status, independent: sc.adjudication?.independent ?? false,
    true_positives: sc.summary.true_positives, false_positives: sc.summary.false_positives, precision: sc.summary.precision, coverage: sc.summary.coverage_recall_adjudicated ?? sc.summary.coverage_recall,
  });
  s.scored = true;
  saveState(root, state);
  log(root, `${r.id} scored`);
}

// Re-score a scored row with the current scorer, from its frozen adjudication
// (owner-approved scorer corrections). The original score files and ledger
// record stay; the corrected score is written beside them and the ledger gets
// a `rescored` event naming the score it supersedes and why.
// What differs between two scores of one run: official, version, item
// statuses, summary values (fields only one side has are listed as added),
// census mechanisms and the Incremental verdicts.
export function scoreChanges(before, after) {
  const changes = [];
  const cmp = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(`${label}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`); };
  cmp('official', before.official, after.official);
  cmp('version', before.version?.status, after.version?.status);
  const statuses = (x) => Object.fromEntries((x.items ?? []).map((i) => [i.id, i.status]));
  const sb = statuses(before);
  for (const [id, st] of Object.entries(statuses(after))) cmp(`item ${id}`, sb[id], st);
  for (const key of new Set([...Object.keys(before.summary ?? {}), ...Object.keys(after.summary ?? {})])) {
    if (!(key in (before.summary ?? {}))) { changes.push(`summary.${key}: added`); continue; }
    if (key === 'coverage_mechanisms' || key === 'population') continue;
    cmp(`summary.${key}`, before.summary[key], after.summary?.[key]);
  }
  const mech = (x) => x.summary?.coverage_mechanisms ?? [];
  const mb = mech(before);
  mech(after).forEach((m, i) => cmp(`census ${m.split(' ')[0]}`, mb[i], m));
  const pop = (x) => Object.fromEntries(Object.entries(x.summary?.population ?? {}).map(([k, v]) => [k, v.exact_adjudicated ?? v.exact]));
  cmp('population', pop(before), pop(after));
  if (before.debt || after.debt) {
    for (const key of new Set([...Object.keys(before.debt ?? {}), ...Object.keys(after.debt ?? {})])) {
      if (key === 'rule') continue;
      if (!(key in (before.debt ?? {}))) { changes.push(`debt.${key}: added ${JSON.stringify(after.debt[key])}`); continue; }
      if (!(key in (after.debt ?? {}))) { changes.push(`debt.${key}: removed`); continue; }
      cmp(`debt.${key}`, before.debt[key], after.debt[key]);
    }
  }
  if (before.incremental || after.incremental) {
    for (const k of ['target_never_current', 'target_reopened_with_correct_reason', 'meets_threshold', 'overreach', 'changed_files_without_census_item']) cmp(`incremental.${k}`, before.incremental?.[k], after.incremental?.[k]);
  }
  return changes;
}

// Re-score a scored row with the current scorer, from its frozen adjudication.
// The earlier score files and ledger records stay. An approved correction is
// written as `<run>.score.<label>.json` and becomes the row's current score,
// with a `rescored` ledger event naming the score it supersedes, the reason and
// what changed. A diagnostic (`--diagnostic rule4-v2`) is written beside it,
// with a `diagnostic-scored` event, and never becomes the row's score.
export function rescoreRow(ctx, id, reason, { label = 'corrected', diagnostic = null } = {}) {
  const r = row(id);
  const s = ctx.state.rows[id];
  if (!s?.scored) fail(`${id} is not scored`);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(label)) fail(`bad label ${label}`);
  const frozen = readLedger(ctx.ledger).map((l) => JSON.parse(l)).filter((e) => e.row === id && e.event === 'adjudication-frozen').at(-1);
  if (s.adjudication?.file && sha256(fs.readFileSync(s.adjudication.file)) !== frozen?.verdicts_sha256) fail(`${id}: the adjudication differs from its frozen sha256`);
  const currentFile = s.score_corrected ?? s.score;
  const current = fs.readFileSync(currentFile, 'utf8');
  const res = runScorer(ctx, r, s, diagnostic === 'rule4-v2' ? ['--rule4', 'v2-diagnostic'] : []);
  if (ABSOLUTE.test(res.stdout)) fail(`${id}: the new score holds an absolute path`);
  const name = diagnostic ? `diagnostic-${diagnostic}` : label;
  const out = s.score.replace(/\.json$/, `.${name}.json`);
  fs.writeFileSync(out, res.stdout);
  const reports = evidenceDir(ctx, r, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, `${s.run_id}.score.${name}.json`), res.stdout);
  const sc = JSON.parse(res.stdout);
  const changes = scoreChanges(JSON.parse(current), sc);
  if (diagnostic) {
    (s.diagnostics ??= {})[name] = out;
  } else {
    s.score_original = s.score_original ?? s.score;
    (s.score_history ??= [s.score_original]).push(out);
    s.score_corrected = out;
  }
  const inc = sc.incremental ?? null;
  const ev = appendLedger(ctx.ledger, {
    event: diagnostic ? 'diagnostic-scored' : 'rescored', row: id, run_id: s.run_id, label: name, reason,
    [diagnostic ? 'compared_with_score_sha256' : 'supersedes_score_sha256']: sha256(current), score_sha256: sha256(res.stdout), scorer_sha256: scorerSha(),
    official: sc.official, version: sc.version?.status, true_positives: sc.summary.true_positives, false_positives: sc.summary.false_positives,
    false_positive_findings_distinct: sc.summary.false_positive_findings_distinct, precision: sc.summary.precision,
    coverage: sc.summary.coverage_recall_adjudicated ?? sc.summary.coverage_recall,
    ...(inc ? { target_never_current: inc.target_never_current, target_reopened_with_correct_reason: inc.target_reopened_with_correct_reason, incremental_meets_threshold: inc.meets_threshold } : {}),
    changes: changes.map((c) => c.replace(/[A-Za-z]:[\\/][^\s"]*/g, '<path>')),
  });
  saveState(ctx.root, ctx.state);
  return ev;
}

// The scored row's score and metrics, next to the answers (sealed side).
// Neither holds an absolute path; a file that does is refused.
export function exportRow(r, s, { root = null } = {}) {
  if (r.external && !root) fail(`${r.id}: a curated row's reports go under the matrix root`);
  const dir = r.external ? path.join(root, 'curated', 'reports') : path.join(FIXTURES, answersName(r.fixture), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const files = { [`${s.run_id}.score.json`]: s.score, [`${s.run_id}.metrics.json`]: s.metrics };
  if (s.adjudication?.metrics) files[`${s.run_id}.adjudication-metrics.json`] = s.adjudication.metrics;
  const written = [];
  for (const [name, src] of Object.entries(files)) {
    if (!src || !fs.existsSync(src)) continue;
    const text = fs.readFileSync(src, 'utf8');
    if (ABSOLUTE.test(text)) fail(`${name} holds an absolute path`);
    fs.writeFileSync(path.join(dir, name), text);
    written.push(name);
  }
  return written;
}

// Every matrix session's client-computed cost and tokens, from its transcript:
// counted attempts, voided attempts and retries, reviewers, adjudicators and
// repair turns. A session killed before Claude Code recorded a cost shows its
// tokens and `cost: unavailable`; nothing is estimated.
export function costReport(ctx) {
  const projects = path.join(configDir(), 'projects');
  const sessionsIn = (slug) => {
    const dir = path.join(projects, slug);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];
  };
  const measure = (file, fixtureDir) => {
    const res = spawnSync(process.execPath, [path.join(HERE, 'transcript-metrics.mjs'), '--session', file, ...(fixtureDir && fs.existsSync(fixtureDir) ? ['--fixture', fixtureDir] : [])], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) return { cost_usd: null, tokens: null };
    const m = JSON.parse(res.stdout);
    const tot = (u) => (u ? u.input + u.output + u.cache_creation + u.cache_read : 0);
    return { cost_usd: m.cost?.transcript?.total_usd ?? null, tokens: tot(m.usage?.lead) + tot(m.usage?.delegates_cumulative) };
  };
  const lines = [];
  const add = (row, attempt, kind, folderDir, slug) => {
    for (const file of sessionsIn(slug)) lines.push({ row, attempt, kind, session: path.basename(file, '.jsonl'), ...measure(file, folderDir) });
  };
  // A voided attempt leaves its fixture folder (`w<x>-`, or `wk-` before row codes) and, once audited, its sandbox (`r<x>-`).
  for (const [id, slugs] of Object.entries(ctx.state.voided ?? {})) {
    for (const slug of slugs) add(id, 'voided', /-r[a-z]-[A-Za-z0-9]+$/.test(slug) ? 'adjudication (with any repair turn)' : 'review', null, slug);
  }
  for (const [id, s] of Object.entries(ctx.state.rows ?? {})) {
    if (s.fixture_dir && fs.existsSync(s.fixture_dir)) add(id, 'counted', 'review', s.fixture_dir, projectSlug(s.fixture_dir));
    if (s.sandbox && fs.existsSync(s.sandbox)) add(id, 'counted', 'adjudication (with any repair turn)', s.sandbox, projectSlug(s.sandbox));
  }
  const sum = (xs) => +xs.reduce((a, x) => a + (x.cost_usd ?? 0), 0).toFixed(4);
  const counted = lines.filter((l) => l.attempt === 'counted');
  const voided = lines.filter((l) => l.attempt !== 'counted');
  return {
    sessions: lines,
    totals_usd: { counted: sum(counted), voided: sum(voided), all: sum(lines) },
    unavailable: lines.filter((l) => l.cost_usd === null).map((l) => `${l.row} ${l.attempt} ${l.kind}: ${l.tokens ?? '?'} tokens, cost not recorded`),
    rule: 'client-computed list-price cost from each transcript; permission probes outside the matrix are not included',
  };
}

// The chains a drive may run: the core ones, plus the security rows' once
// their supplement is registered.
export const activeChains = (ledgerFile) => (supplementEvent(ledgerFile) ? [...CHAINS, ...SUPPLEMENT_CHAINS] : CHAINS);

// What `drive <rows>` would run, in the registered order, without running it.
export function planBatch(ctx, ids) {
  const reg = readLedger(ctx.ledger).map((l) => JSON.parse(l)).find((e) => e.event === 'registered');
  const problems = [];
  if (!reg) problems.push('the plan is not registered');
  else if (JSON.stringify(reg.chains) !== JSON.stringify(CHAINS)) problems.push('the runner\'s chains differ from the registered ones');
  // The security rows join only through their supplementary registration.
  const active = activeChains(ctx.ledger);
  const wanted = new Set(ids.length ? ids : active.flat());
  for (const id of wanted) {
    if (isExternal(id) && !active.flat().includes(id)) problems.push(`${id} runs only after a curated package is recorded and its rows registered (register-supplement)`);
  }
  const order = active.flat().filter((id) => wanted.has(id));
  const rows = order.map((id) => {
    const r = row(id);
    const s = ctx.state.rows[id];
    const dep = r.from ?? r.base ?? null;
    const depState = dep ? ctx.state.rows[dep] : null;
    const status = s?.scored ? 'already scored' : s?.failed ? `failed: ${s.failed}` : s?.closed ? 'closed, steps left' : s?.prepared ? 'prepared' : 'not started';
    // A base that runs earlier in the same batch counts: drive runs a chain in order and skips a row whose base did not close.
    const depOk = !dep || Boolean(depState?.closed && depState?.run_id) || (order.indexOf(dep) >= 0 && order.indexOf(dep) < order.indexOf(id));
    const chain = active.find((c) => c.includes(id));
    const earlier = chain.slice(0, chain.indexOf(id));
    const unscoredEarlier = earlier.filter((x) => !ctx.state.rows[x]?.scored && !wanted.has(x));
    if (!depOk) problems.push(`${id} depends on ${dep}, which has not closed`);
    if (unscoredEarlier.length) problems.push(`${id} would run before ${unscoredEarlier.join(', ')} in its registered chain`);
    const ready = !dep || Boolean(depState?.run_id);
    return { row: id, fixture: r.fixture, model: r.model, depends_on: dep, dependency_ok: depOk, status, command: ready ? commandFor(r, ctx.state) : depOk ? `(after ${dep} closes) incremental --base <${dep} run id>` : null };
  });
  return { order, rows, problems, ok: problems.length === 0 };
}

// ---------------------------------------------------------------- commands

async function drive(ctx, ids) {
  const active = activeChains(ctx.ledger);
  const wanted = new Set(ids.length ? ids : active.flat());
  const chains = active.map((c) => c.filter((id) => wanted.has(id))).filter((c) => c.length);
  const queue = [...chains];
  const worker = async () => {
    while (queue.length && !ctx.abort) {
      const chain = queue.shift();
      for (const id of chain) {
        if (ctx.abort) break;
        const r = row(id);
        const s = ctx.state.rows[id];
        if (s?.failed) { log(ctx.root, `${id} skipped: failed earlier`); continue; }
        const dep = r.from ?? r.base;
        if (dep && !ctx.state.rows[dep]?.closed) { log(ctx.root, `${id} skipped: ${dep} did not close`); continue; }
        // Before each row, nothing paid: the registered implementation, still
        // frozen; the registered Claude Code version; the recorded package.
        ctx.implementation = implementationManifest();
        const unfrozen = implementationOk(ctx.ledger, ctx.implementation);
        if (unfrozen) { ctx.abort = `${id}: ${unfrozen}`; break; }
        ctx.version = claudeVersion();
        const drift = versionProblem(ctx.ledger, ctx.version) ?? curatedProblem(ctx);
        if (drift) { ctx.abort = `${id}: ${drift}`; break; }
        // The row's review and adjudication commands must fit before the review is paid for.
        const tooLong = commandLinePreflight(ctx, [id]).problems;
        if (tooLong.length) { ctx.abort = `${id}: ${tooLong.join('; ')}`; break; }
        try {
          prepare(ctx, r);
          if (ctx.abort) break;
          await run(ctx, r);
          if (!ctx.state.rows[id]?.closed) continue;
          // A session can run for an hour: the audit, the adjudication and the
          // score also run only on the registered implementation. A closed row
          // stops here and resumes at its next step once it is restored.
          if (!stillRegistered(ctx, id, 'audit')) break;
          audit(ctx, r);
          await adjudicate(ctx, r);
          if (!stillRegistered(ctx, id, 'scoring')) break;
          scoreRow(ctx, r);
          delete ctx.state.rows[id].step_error;
          saveState(ctx.root, ctx.state);
        } catch (error) {
          const s = (ctx.state.rows[id] ??= {});
          // A paid, closed session is never thrown away: the next drive resumes at the failed step.
          if (s.closed) s.step_error = error.message;
          else if (s.prepared && !s.started) s.step_error = error.message;
          else s.failed = `driver: ${error.message}`;
          saveState(ctx.root, ctx.state);
          log(ctx.root, `${id} DRIVER ERROR ${error.message}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, worker));
  if (ctx.abort) log(ctx.root, `ABORTED: ${ctx.abort}`);
}

// The plan, once per ledger, and only on a frozen implementation whose
// isolation probes passed on the installed Claude Code (M5-T4R, B3 and B4).
// The registration records the commit, every material file's sha256, the
// session configuration's digest and the skill a fixture will hold.
export function register(ctx, { implementation = implementationManifest(), version = claudeVersion(), skillSha256 = null, versions = null } = {}) {
  const events = readLedger(ctx.ledger).map((l) => JSON.parse(l));
  if (events.some((e) => e.event === 'registered')) fail('refused: this ledger already holds a registration');
  if (!version) fail('refused: Claude Code was not found (claude --version)');
  if (!implementation.frozen) fail(`refused: the implementation is not frozen at ${String(implementation.head).slice(0, 12)}: ${implementation.files.filter((f) => f.git !== 'clean').slice(0, 8).map((f) => `${f.git} ${f.path}`).join(', ')}; commit it, then register`);
  const unverified = isolationOk(ctx.ledger, version);
  if (unverified) fail(`refused: ${unverified}; run and record the isolation probes first`);
  const iso = events.filter((e) => e.event === 'isolation-verified').at(-1);
  if (iso.implementation_sha256 !== implementation.digest || iso.environment_sha256 !== implementation.environment.digest) fail('refused: the isolation was verified on another implementation or configuration');
  const answers =Object.fromEntries(['syn-ledger', 'syn-ledger-inc', 'syn-debt', 'syn-shelf'].map((n) => [n, sha256(fs.readFileSync(path.join(FIXTURES, n, 'answers.json')))]));
  return appendLedger(ctx.ledger, {
    event: 'registered', plan: ROWS.map((r) => ({ id: r.id, fixture: r.fixture, model: r.model, ...(r.from ? { from: r.from } : {}), ...(r.base ? { base: r.base } : {}), expected: expectedFor(r) })),
    chains: CHAINS, supplement_chains: SUPPLEMENT_CHAINS, answers_sha256: answers, kit: kitSummary(implementation),
    gate: GATE, gate_sha256: sha256(fs.readFileSync(GATE_FILE)), versions: versions ?? toolVersions(version),
    implementation: { head: implementation.head, digest: implementation.digest, files: implementation.files.map(({ path: p, sha256: h }) => ({ path: p, sha256: h })), environment: implementation.environment },
    skill_sha256: skillSha256 ?? builtSkillSha256(),
    thresholds: 'delivery roadmap §4 G5; syn-shelf: answers scoring.g5',
    independence: 'reviewer and adjudicator are separate fresh headless sessions; the adjudicator sees records and source only; its verdicts are frozen here before scoring',
  });
}

// A Sonnet lead on the records of each triggered or Incremental row must fail
// `check` (C15); a syn-shelf row must record no trigger (no false escalation).
function escalation(ctx) {
  const out = [];
  for (const r of ROWS) {
    const s = ctx.state.rows[r.id];
    if (!s?.closed) { out.push({ row: r.id, status: 'not run' }); continue; }
    const records = readJson(path.join(s.fixture_dir, s.run_dir, 'records.json'));
    const rt = records.run.runtime;
    const exp = expectedFor(r);
    const recorded = { required_lead_model: rt.required_lead_model, triggers: rt.triggers, lead_model: rt.lead_model, lead_effort: rt.lead_effort };
    if (exp.triggers_exactly) {
      out.push({ row: r.id, recorded, false_escalation: rt.triggers.length > 0 || rt.required_lead_model !== 'sonnet', expected: exp });
      continue;
    }
    const missing = exp.triggers_include.filter((t) => !rt.triggers.includes(t));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-'));
    try {
      fs.cpSync(s.fixture_dir, scratch, { recursive: true });
      const baseline = spawnSync(process.execPath, [path.join(scratch, NTHR), 'check', '--run', s.run_dir], { cwd: scratch, encoding: 'utf8', windowsHide: true });
      const file = path.join(scratch, s.run_dir, 'records.json');
      const doc = readJson(file);
      doc.run.runtime.lead_model = 'claude-sonnet-5-5';
      doc.run.runtime.lead_effort = 'high';
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      const res = spawnSync(process.execPath, [path.join(scratch, NTHR), 'check', '--run', s.run_dir], { cwd: scratch, encoding: 'utf8', windowsHide: true });
      const text = `${res.stdout}${res.stderr}`;
      const refusal = (text.match(/[^"]*does not meet the required opus-high[^"]*\(C15\)/) ?? [null])[0];
      out.push({ row: r.id, recorded, expected: exp, missing_triggers: missing, required_ok: rt.required_lead_model === exp.required_lead_model, baseline_check_ok: baseline.status === 0, sonnet_refused: res.status !== 0 && refusal !== null, refusal });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return out;
}

const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

function summary(ctx) {
  const rows = [];
  for (const r of ROWS) {
    const s = ctx.state.rows[r.id];
    if (!s?.prepared) { rows.push({ row: r.id, status: 'not run' }); continue; }
    if (!s.closed) { rows.push({ row: r.id, status: 'failed', reason: s.failed }); continue; }
    const m = readJson(s.metrics);
    const sc = s.score_corrected ? readJson(s.score_corrected) : s.score ? readJson(s.score) : null;
    const original = s.score_corrected && s.score_original ? readJson(s.score_original) : null;
    const records = readJson(path.join(s.fixture_dir, s.run_dir, 'records.json'));
    const tok = (u) => (u ? u.input + u.output + u.cache_creation + u.cache_read : 0);
    const obligations = (records.obligations ?? []).length;
    const deleg = m.delegations ?? [];
    rows.push({
      row: r.id, fixture: r.fixture, model: r.model, run_id: s.run_id, status: records.run.status, incomplete_reason: records.run.incomplete_reason ?? null,
      valid: s.valid, independent: s.adjudication?.independent ?? false, official: sc?.official ?? null,
      items: sc ? Object.fromEntries(sc.items.map((x) => [x.id, x.status])) : null,
      unmatched: sc ? sc.unmatched_findings.map((u) => `${u.id} ${u.kind}/${u.verdict}: ${u.adjudication}`) : null,
      summary: sc ? { tp: sc.summary.true_positives, fp: sc.summary.false_positives, precision: sc.summary.precision, valid_unplanned: sc.summary.valid_unplanned, confirmed: (records.findings ?? []).filter((f) => f.verdict === 'confirmed').length, tp_confirmed: sc.summary.true_positives_confirmed, coverage: sc.summary.coverage_recall, coverage_adjudicated: sc.summary.coverage_recall_adjudicated ?? null, population: sc.summary.population, pending: sc.summary.pending_adjudication, unresolved: sc.summary.unresolved_adjudications } : null,
      g5: sc?.g5?.checks ?? null, incremental: sc?.incremental ?? null, debt: sc?.debt ?? null,
      ...(original ? { original_score: { official: original.official, incremental: original.incremental ?? null } } : {}),
      cost_usd: m.cost?.transcript?.total_usd ?? m.cost?.stream?.total_usd ?? null,
      adjudicator_cost_usd: s.adjudication ? streamFacts(s.adjudication.stream).cost_usd : null,
      wall_clock_s: m.runtime?.wall_clock_ms != null ? Math.round(m.runtime.wall_clock_ms / 1000) : null,
      tokens: { lead: m.usage?.lead ?? null, delegates: m.usage?.delegates_cumulative ?? null, total: tok(m.usage?.lead) + tok(m.usage?.delegates_cumulative) },
      lead_calls: { total: m.budget?.lead_tool_calls_total, after_open: m.budget?.lead_tool_calls_after_open, at_last_record_write: m.budget?.lead_tool_calls_after_open_to_last_record_write, recorded: records.budget?.spent?.lead_tool_calls ?? null, budget: records.budget?.lead_tool_calls ?? null },
      subagent_calls: { observed: deleg.length, recorded: records.budget?.spent?.subagent_calls ?? null, budget: records.budget?.subagent_calls ?? null },
      cost_observed: observedCost(records, m),
      delegations: deleg.map((d) => ({ role: d.role?.value ?? null, requested: d.requested?.model ?? null, effort: d.requested?.effort ?? null, models: d.transcript?.models?.values ?? [], status: d.status?.value ?? null, recoveries: d.recovery_messages?.value ?? 0 })),
      obligations,
      tokens_per_obligation: obligations ? Math.round((tok(m.usage?.lead) + tok(m.usage?.delegates_cumulative)) / obligations) : null,
      lead_calls_per_obligation: obligations && m.budget?.lead_tool_calls_after_open != null ? +(m.budget.lead_tool_calls_after_open / obligations).toFixed(2) : null,
      routing_violations: m.routing?.violations ?? [],
      lead_models: m.lead?.models?.values ?? [], lead_efforts: m.lead?.effort?.values ?? [],
    });
  }
  return rows;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const opts = { ids: [] };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--root') opts.root = rest[++i];
    else if (rest[i] === '--ledger') opts.ledger = rest[++i];
    else if (rest[i] === '--concurrency') opts.concurrency = Number(rest[++i]);
    else if (rest[i] === '--max-budget') opts.maxBudget = Number(rest[++i]);
    else if (rest[i] === '--dry-run') opts.dryRun = true;
    else if (rest[i] === '--reason') opts.reason = rest[++i];
    else if (rest[i] === '--label') opts.label = rest[++i];
    else if (rest[i] === '--diagnostic') opts.diagnostic = rest[++i];
    else if (rest[i] === '--curated') opts.curated = rest[++i];
    else if (rest[i] === '--change') (opts.changes ??= []).push(rest[++i]);
    else opts.ids.push(rest[i]);
  }
  if (!command) { process.stderr.write('usage: matrix.mjs <plan|register|record-isolation|record-curated-package|register-supplement|drive|void|escalation|verify-ledger|summary|costs|export> --root <dir> [--ledger <file>] [--concurrency <n>] [--max-budget <usd>] [--dry-run] [--curated <dir> --change <repo>:<a>..<b>...] [rows...]\n'); return 2; }
  const ledger = opts.ledger ?? DEFAULT_LEDGER;
  if (command === 'plan') { process.stdout.write(`${JSON.stringify({ gate: GATE, rows: ROWS.map((r) => ({ ...r, expected: expectedFor(r) })), chains: CHAINS, supplement_chains: SUPPLEMENT_CHAINS }, null, 2)}\n`); return 0; }
  if (command === 'verify-ledger') {
    // With --root, the security rows' package and evidence folder are checked too.
    const st = opts.root && fs.existsSync(path.join(opts.root, 'state.json')) ? loadState(opts.root) : null;
    const external = st?.curated?.dir ? { dir: st.curated.dir, evidenceDir: path.join(path.resolve(opts.root), 'curated') } : null;
    const v = verifyLedger(ledger, { external });
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    return v.ok ? 0 : 1;
  }
  if (!opts.root) { process.stderr.write('--root is required\n'); return 2; }
  const offPlatform = ['register', 'record-isolation', 'register-supplement', 'drive'].includes(command) ? platformProblem() : null;
  if (offPlatform) { process.stderr.write(`refused: ${offPlatform}\n`); return 2; }
  fs.mkdirSync(opts.root, { recursive: true });
  const ctx = { root: path.resolve(opts.root), ledger, state: loadState(opts.root), concurrency: opts.concurrency ?? 1, abort: null, budget: Number.isFinite(opts.maxBudget) && opts.maxBudget > 0 ? { cap: opts.maxBudget, spent: 0 } : null };
  if (command === 'register') {
    try { process.stdout.write(`${JSON.stringify(register(ctx), null, 2)}\n`); } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
    return 0;
  }
  // RQ-1 @2, B7: the curated package (SECURITY-FIXTURE-SPEC.md), then the security rows' registration.
  if (command === 'record-curated-package') {
    if (!opts.curated) { process.stderr.write('usage: record-curated-package --root <dir> --ledger <file> --curated <package dir> --change <repo>:<a>..<b> [--change ...]\n'); return 2; }
    try { process.stdout.write(`${JSON.stringify(recordCuratedPackage(ctx, opts.curated, { changes: opts.changes ?? [] }), null, 2)}\n`); } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
    return 0;
  }
  if (command === 'register-supplement') {
    try { process.stdout.write(`${JSON.stringify(registerSupplement(ctx), null, 2)}\n`); } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
    return 0;
  }
  if (command === 'implementation') { process.stdout.write(`${JSON.stringify(implementationManifest(), null, 2)}\n`); return 0; }
  if (command === 'record-isolation') {
    // node matrix.mjs record-isolation --root <dir> <summary.json>: the probe summary (checks, passed) for this version.
    const file = opts.ids[0];
    if (!file) { process.stderr.write('usage: record-isolation --root <dir> <summary.json>\n'); return 2; }
    const text = fs.readFileSync(file);
    const doc = JSON.parse(text.toString('utf8'));
    const version = claudeVersion();
    if (doc.claude_version !== version) { process.stderr.write(`refused: the summary is for ${doc.claude_version}, the installed version is ${version}\n`); return 2; }
    const impl = implementationManifest();
    if (!impl.frozen) { process.stderr.write('refused: the isolation is verified only on a frozen implementation; commit it first\n'); return 2; }
    const ev = appendLedger(ledger, { event: 'isolation-verified', claude_version: version, passed: doc.passed === true, checks: doc.checks, summary_sha256: sha256(text), implementation_sha256: impl.digest, environment_sha256: impl.environment.digest });
    process.stdout.write(`${JSON.stringify(ev, null, 2)}\n`);
    return 0;
  }
  if (command === 'record-audit-rule') {
    // node matrix.mjs record-audit-rule --root <dir> --reason "<why>": the boundary from which audits use AUDIT_RULE.
    if (!opts.reason) { process.stderr.write('usage: record-audit-rule --root <dir> --reason <why>\n'); return 2; }
    if (readLedger(ledger).map((l) => JSON.parse(l)).some((e) => e.event === 'audit-corrected' && e.rule === AUDIT_RULE)) { process.stderr.write(`refused: ${AUDIT_RULE} is already recorded\n`); return 2; }
    const audited = readLedger(ledger).map((l) => JSON.parse(l)).filter((e) => e.event === 'audited').map((e) => `${e.row}@${e.seq}`);
    const ev = appendLedger(ledger, {
      event: 'audit-corrected', rule: AUDIT_RULE, previous_rule: 'own-folder-read-v1', reason: opts.reason,
      applies_to: 'every audit recorded after this event',
      does_not_apply_to: audited,
      boundary: 'exempt only Read, Grep or Glob whose path is exactly a tool-result file announced in that session\'s own transcripts and lying, as a regular non-link file, directly in <config>/projects/<the session folder>/<the session id>/tool-results/; never another project file, a shell command or Git',
      matrix_sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    });
    process.stdout.write(`${JSON.stringify(ev, null, 2)}\n`);
    return 0;
  }
  if (command === 'rescore') {
    // node matrix.mjs rescore --root <dir> --reason "<why>" <rows...>
    if (!opts.reason || !opts.ids.length) { process.stderr.write('usage: rescore --root <dir> --reason <why> [--label <name> | --diagnostic rule4-v2] <rows...>\n'); return 2; }
    if (opts.diagnostic && opts.diagnostic !== 'rule4-v2') { process.stderr.write('the only diagnostic is rule4-v2\n'); return 2; }
    for (const id of opts.ids) process.stdout.write(`${JSON.stringify(rescoreRow(ctx, id, opts.reason, { label: opts.label ?? 'corrected', diagnostic: opts.diagnostic ?? null }))}\n`);
    return 0;
  }
  if (command === 'costs') { process.stdout.write(`${JSON.stringify(costReport(ctx), null, 2)}\n`); return 0; }
  if (command === 'export') {
    for (const id of opts.ids) { const s = ctx.state.rows[id]; if (!s?.scored) fail(`${id} is not scored`); process.stdout.write(`${id}: ${exportRow(row(id), s).join(', ')}\n`); }
    return 0;
  }
  if (command === 'drive' && opts.dryRun) {
    const plan = planBatch(ctx, opts.ids);
    const version = claudeVersion();
    const lines = commandLinePreflight(ctx, plan.order);
    const gates = { registered: registeredOk(ledger) ?? 'ok', isolation: isolationOk(ledger, version) ?? 'ok', implementation: implementationOk(ledger, implementationManifest()) ?? 'ok', command_lines: lines.problems.length ? lines.problems.join('; ') : 'ok', claude_version: version, max_budget_usd: ctx.budget?.cap ?? null, first_review_cap_usd: sessionCap(ctx, 'reviewer') };
    process.stdout.write(`${JSON.stringify({ gates, command_line_limit: lines.limit, longest_command_line: lines.longest, ...plan }, null, 2)}\n`);
    return plan.ok && gates.registered === 'ok' && gates.isolation === 'ok' && gates.implementation === 'ok' && gates.command_lines === 'ok' ? 0 : 1;
  }
  if (command === 'drive') {
    const plan = planBatch(ctx, opts.ids);
    if (!plan.ok) { process.stderr.write(`refused: ${plan.problems.join('; ')}\n`); return 2; }
    const unregistered = registeredOk(ledger);
    if (unregistered) { process.stderr.write(`refused: ${unregistered}\n`); return 2; }
    const unverified = isolationOk(ledger, claudeVersion());
    if (unverified) { process.stderr.write(`refused: ${unverified}\n`); return 2; }
    const unfrozen = implementationOk(ledger, implementationManifest());
    if (unfrozen) { process.stderr.write(`refused: ${unfrozen}\n`); return 2; }
    // Every session of the batch must fit on the command line before the first one is paid for.
    const tooLong = commandLinePreflight(ctx, plan.order).problems;
    if (tooLong.length) { process.stderr.write(`refused, nothing started: a session command line would be too long: ${tooLong.join('; ')}\n`); return 2; }
    const lock = path.join(ctx.root, 'driver.lock');
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive) { process.stderr.write(`another driver (pid ${pid}) holds the lock\n`); return 2; }
      fs.rmSync(lock, { force: true });
    }
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    try { await drive(ctx, opts.ids); } finally { fs.rmSync(lock, { force: true }); }
    return ctx.abort ? 1 : 0;
  }
  if (command === 'void') {
    const [id, ...reason] = opts.ids;
    if (!id || !reason.length) { process.stderr.write('usage: void <row> <reason...>\n'); return 2; }
    row(id);
    voidRow(ctx, id, `by hand: ${reason.join(' ')}`);
    return 0;
  }
  if (command === 'escalation') { process.stdout.write(`${JSON.stringify(escalation(ctx), null, 2)}\n`); return 0; }
  if (command === 'summary') { process.stdout.write(`${JSON.stringify(summary(ctx), null, 2)}\n`); return 0; }
  process.stderr.write(`unknown command ${command}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
