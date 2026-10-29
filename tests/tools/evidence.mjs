// G5 evidence preservation (M5-T4R readiness, B2). Library-only test tooling:
// Enable never installs it.
//
// It inventories a matrix's evidence (the kit's ledger, answers, adjudications,
// reports, history and tooling; the row fixtures and adjudication sandboxes in
// the temporary folder; the guard logs; the session transcripts in the Claude
// Code configuration; the matrix root), copies it into an archive outside Git
// and outside the temporary folder, and writes two manifests:
//   - <archive>/manifest.json: every file, its sha256, size and provenance;
//   - a hash-only kit manifest (no content, no absolute path) that may be
//     committed, so a later `verify` can prove the archive unchanged.
// Sources are only read, never moved or changed. Evidence the ledger names
// but nothing on disk holds is listed as missing.
//
// Usage: node evidence.mjs <command> [--config <dir>] [--root <matrix root>] [--ledger <file>]
//   inventory                      what would be archived, and what is missing (read-only)
//   archive --to <dir> [--kit-manifest <file>]
//   verify --archive <dir> [--kit-manifest <file>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_LEDGER, projectSlug, readLedger, sha256 } from './matrix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = path.resolve(HERE, '..', '..');
// The repository root (`<kit>` in labels). The sealed M5-T4 manifest was taken
// in the nth-dev-kit checkout, so its kit labels carry the old module prefix.
const KIT = REVIEW;
export const MANIFEST_SCHEMA = 'nthr-evidence-manifest@1';
// A `<kit>/…` label's path in this repository, for labels of either layout.
export const productPathOfLabel = (label) => label.replace(/^<kit>\/(?:agents\/claude\/integrations\/review\/)?/, '');
export const DEFAULT_KIT_MANIFEST = path.join(REVIEW, 'tests', 'fixtures', 'g5-evidence-m5t4.json');
// The sealed G5 evidence that is never published, as .gitignore patterns from
// the repository root (docs/DEVELOPMENT.md, Private evidence).
export const PRIVATE_EVIDENCE = ['tests/fixtures/g5-ledger.jsonl', 'tests/fixtures/g5-evidence-m5t4.json', 'tests/fixtures/g5-criteria/', 'tests/fixtures/*/adjudications/', 'tests/fixtures/*/reports/', 'tests/fixtures/*/history/'];
export const EVIDENCE_ABSENT = 'the sealed G5 evidence is not present in this copy (it is not published: docs/DEVELOPMENT.md)';
// 'present' (the ledger, its manifest and the criteria are there), 'absent'
// (none of the private evidence: a public copy) or 'partial' (anything else,
// which is never valid).
export function sealedEvidenceState(review = REVIEW) {
  const fixtures = path.join(review, 'tests', 'fixtures');
  const dirs = fs.existsSync(fixtures) ? fs.readdirSync(fixtures, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const exists = (pattern) => {
    const [head, ...rest] = pattern.replace(/^tests\/fixtures\//, '').replace(/\/$/, '').split('/');
    return (head === '*' ? dirs : [head]).some((d) => fs.existsSync(path.join(fixtures, d, ...rest)));
  };
  const found = PRIVATE_EVIDENCE.map(exists);
  if (!found.some(Boolean)) return 'absent';
  return found.slice(0, 3).every(Boolean) ? 'present' : 'partial';
}

// Matrix folders in the temporary folder and in the configuration's projects:
// a row fixture (`w<code>-`), an adjudication sandbox (`r<code>-`), and the
// isolation probes' folders (`wz-`, `wk-probe-`, `probe-`).
const ROW_FOLDER = /^(?:[wr][a-z]-[A-Za-z0-9]{6}|wk-probe-[A-Za-z0-9]+|probe-[A-Za-z0-9]+)$/;
const GUARD_FOLDER = /^sg-[A-Za-z0-9]{6}$/;
// Kit files that make up the evidence, relative to the review integration.
const KIT_EVIDENCE = [
  /^tests\/fixtures\/g5-ledger[^/]*\.jsonl$/,
  /^tests\/fixtures\/[^/]+\/(answers\.json|adjudications\/.+|reports\/.+|history\/.+|tree\/.+)$/,
  /^tests\/fixtures\/(README\.md|build\.mjs)$/,
  /^tests\/tools\/.+$/,
  /^tests\/(m4\/operator\.mjs|helpers\/.+|G5-REPEAT-PLAN\.md)$/,
  /^VALIDATION\.md$/,
];

const posix = (p) => p.split(path.sep).join('/');
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
export function inside(child, parent) {
  const rel = path.relative(fold(real(parent)), fold(real(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const hashFile = (file) => sha256(fs.readFileSync(file));

// The places evidence lives. Every path is absolute here; labels replace them.
export function makeWorld({ config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), root = null, ledger = DEFAULT_LEDGER, tmp = os.tmpdir(), kit = KIT, review = REVIEW } = {}) {
  return { config: path.resolve(config), root: root ? path.resolve(root) : null, ledger: path.resolve(ledger), tmp: path.resolve(tmp), kit: path.resolve(kit), review: path.resolve(review), tmpSlug: projectSlug(tmp) };
}

// A label never holds an absolute path or the user's name: the bases become
// <tmp>, <config>, <root> or <kit>, and the temporary folder's project slug
// (which spells out the profile path) becomes <tmp-slug>.
export function labelOf(world, abs) {
  for (const [base, name] of [[world.root, '<root>'], [path.join(world.config, 'projects'), '<config>/projects'], [world.config, '<config>'], [world.tmp, '<tmp>'], [world.kit, '<kit>']]) {
    if (base && inside(abs, base)) {
      const rel = posix(path.relative(real(base), real(abs)));
      return `${name}${rel ? `/${rel}` : ''}`.replace(new RegExp(world.tmpSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<tmp-slug>');
    }
  }
  throw new Error(`outside every evidence base: ${labelSafe(abs)}`);
}
const labelSafe = (p) => path.basename(p);
const archivePathOf = (label) => `files/${label.replace(/^<(tmp|config|root|kit)>/, '$1').replaceAll('<tmp-slug>', 'tmp-slug')}`;

// Session and run ids the ledger names, with the events that name them.
export function ledgerRefs(ledgerFile) {
  const sessions = new Map();
  const runs = new Map();
  const add = (map, key, ref) => { if (key) map.set(key, [...(map.get(key) ?? []), ref]); };
  for (const line of readLedger(ledgerFile)) {
    const e = JSON.parse(line);
    const ref = { seq: e.seq, event: e.event, ...(e.row ? { row: e.row } : {}) };
    add(sessions, e.session_id, ref);
    add(sessions, e.adjudicator_session_id, ref);
    if (e.event === 'closed' || e.event === 'voided') add(runs, e.run_id, ref);
  }
  return { sessions, runs };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) out.push({ abs, link: true });
    else if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push({ abs });
  }
  return out;
}
const listDirs = (dir, pattern) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && pattern(e.name)).map((e) => path.join(dir, e.name)) : []);

// Every evidence file, grouped by the folder it came from, plus what is missing.
export function collect(world) {
  const refs = ledgerRefs(world.ledger);
  const groups = [];
  const group = (cls, dir, files) => groups.push({ class: cls, dir, files });
  const kitFiles = walk(world.review).filter((f) => KIT_EVIDENCE.some((re) => re.test(posix(path.relative(world.review, f.abs)))));
  group('kit', world.review, kitFiles);
  for (const dir of listDirs(world.tmp, (n) => ROW_FOLDER.test(n))) {
    const name = path.basename(dir);
    group(/^[wr][a-n]-/.test(name) ? (name.startsWith('r') ? 'sandbox' : 'fixture') : 'probe', dir, walk(dir));
  }
  for (const dir of listDirs(world.tmp, (n) => GUARD_FOLDER.test(n))) group('guard-log', dir, walk(dir));
  // Claude Code may spell the drive in either case (`C--…`, `c--…`).
  const prefix = `${world.tmpSlug}-`.toLowerCase();
  const matrixSlug = (n) => n.toLowerCase().startsWith(prefix) && ROW_FOLDER.test(n.slice(prefix.length));
  for (const dir of listDirs(path.join(world.config, 'projects'), matrixSlug)) group(/-[wr][a-n]-[A-Za-z0-9]{6}$/.test(dir) ? 'transcript' : 'probe-transcript', dir, walk(dir));
  for (const dir of listDirs(path.join(world.tmp, 'claude'), matrixSlug)) group('claude-tmp', dir, walk(dir));
  const missing = [];
  if (world.root && fs.existsSync(world.root)) group('matrix-root', world.root, walk(world.root).filter((f) => path.basename(f.abs) !== 'driver.lock'));
  else missing.push({ class: 'matrix-root', label: '<root>', why: world.root ? 'the matrix root does not exist' : 'the matrix root was not supplied (--root)' });

  const files = [];
  const seenSessions = new Set();
  const seenRuns = new Set();
  for (const g of groups) {
    for (const f of g.files) {
      const label = labelOf(world, f.abs);
      const provenance = [];
      const sid = /(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl$|\/)/.exec(label)?.[1];
      if (sid && refs.sessions.has(sid)) { provenance.push(...refs.sessions.get(sid)); if (label.endsWith(`${sid}.jsonl`)) seenSessions.add(sid); }
      const run = /\/runs\/([^/]+)\//.exec(label)?.[1];
      if (run && refs.runs.has(run)) { provenance.push(...refs.runs.get(run)); seenRuns.add(run); }
      files.push({ class: g.class, group: labelOf(world, g.dir), abs: f.abs, label, link: Boolean(f.link), provenance });
    }
  }
  for (const [sid, r] of refs.sessions) if (!seenSessions.has(sid)) missing.push({ class: 'transcript', label: `<config>/projects/*/${sid}.jsonl`, why: 'the ledger names this session; no transcript was found', provenance: r });
  for (const [run, r] of refs.runs) if (!seenRuns.has(run)) missing.push({ class: 'records', label: `*/.nth-review/**/runs/${run}/`, why: 'the ledger names this run; no records were found', provenance: r });
  return { files, missing, groups: groups.map((g) => labelOf(world, g.dir)) };
}

// Summaries of a collection, for `inventory` and the manifests.
function totals(files) {
  const by = {};
  for (const f of files) { const t = (by[f.class] ??= { files: 0, bytes: 0 }); t.files += 1; t.bytes += f.size ?? (f.link ? 0 : fs.statSync(f.abs).size); }
  return by;
}

export function inventory(world) {
  const { files, missing, groups } = collect(world);
  return { schema: MANIFEST_SCHEMA, ledger_sha256: hashFile(world.ledger), groups: groups.length, totals: totals(files), missing, cleanup: cleanupSetting(world) };
}

// Claude Code deletes local transcripts older than `cleanupPeriodDays` (30 by
// default). Read only that key; changing it is the owner's decision.
export function cleanupSetting(world) {
  let value = null;
  try { value = JSON.parse(fs.readFileSync(path.join(world.config, 'settings.json'), 'utf8')).cleanupPeriodDays ?? null; } catch { /* unreadable or absent */ }
  return { cleanupPeriodDays: value, effective_days: value ?? 30, source: value === null ? 'default' : '<config>/settings.json' };
}

// The destination must be a new or empty folder outside Git, the temporary
// folder, the configuration, the matrix root and the kit.
export function destinationProblems(world, to) {
  const problems = [];
  const dest = path.resolve(to);
  for (const [base, name] of [[world.tmp, 'the temporary folder'], [world.config, 'the Claude Code configuration'], [world.root, 'the matrix root'], [world.kit, 'the kit']]) {
    if (base && inside(dest, base)) problems.push(`inside ${name}`);
  }
  let probe = dest;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: probe, encoding: 'utf8', windowsHide: true });
  if (git.status === 0 && git.stdout.trim() === 'true') problems.push('inside a Git work tree');
  if (fs.existsSync(dest) && (!fs.statSync(dest).isDirectory() || fs.readdirSync(dest).length)) problems.push('not a new or empty folder');
  return problems;
}

// Only the owner (and the operating system) may open the archive.
export function restrictAccess(dir) {
  if (process.platform !== 'win32') { fs.chmodSync(dir, 0o700); return { restricted: (fs.statSync(dir).mode & 0o077) === 0, method: 'chmod 700' }; }
  // The System32 tools by full path: Git Bash puts a POSIX whoami first on PATH.
  const sys = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
  const who = spawnSync(sys('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = /"(S-1-[0-9-]+)"/.exec(who.stdout ?? '')?.[1];
  if (!sid) throw new Error('cannot resolve the current user to restrict the archive');
  const set = spawnSync(sys('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true });
  if (set.status !== 0) throw new Error(`icacls failed: ${(set.stderr || set.stdout).trim()}`);
  const show = spawnSync(sys('icacls.exe'), [dir], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  const broad = /(Everyone|BUILTIN\\Users|Authenticated Users|NT AUTHORITY\\INTERACTIVE):/i.test(show);
  return { restricted: !broad, method: 'icacls: inheritance removed; the current user and SYSTEM only' };
}

// Copies every evidence file, never moving or changing it: the source is hashed
// before and after the copy, and the copy is hashed again.
export function archive(world, to, { kitManifest = DEFAULT_KIT_MANIFEST, now = new Date().toISOString() } = {}) {
  const problems = destinationProblems(world, to);
  if (problems.length) throw new Error(`refused: the archive destination is ${problems.join('; ')}`);
  const dest = path.resolve(to);
  fs.mkdirSync(dest, { recursive: true });
  const access = restrictAccess(dest);
  if (!access.restricted) throw new Error('refused: the archive folder is still open to other users');
  const ledgerBefore = hashFile(world.ledger);
  const { files, missing } = collect(world);
  const entries = [];
  for (const f of files) {
    const base = { class: f.class, group: f.group, label: f.label, provenance: f.provenance };
    if (f.link) { entries.push({ ...base, status: 'link', sha256: null, size: 0 }); continue; }
    const target = path.join(dest, ...archivePathOf(f.label).split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let before;
    let stat;
    try {
      before = hashFile(f.abs);
      stat = fs.statSync(f.abs);
      fs.copyFileSync(f.abs, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      entries.push({ ...base, status: 'unreadable', why: error.code ?? 'error', sha256: null, size: 0 });
      continue;
    }
    const after = hashFile(f.abs);
    const copy = hashFile(target);
    const status = before !== after ? 'changed-during-copy' : copy !== before ? 'copy-mismatch' : 'archived';
    entries.push({ ...base, archive_path: archivePathOf(f.label), size: stat.size, mtime: stat.mtime.toISOString(), sha256: before, status });
  }
  if (hashFile(world.ledger) !== ledgerBefore) throw new Error('the ledger changed while it was archived');
  const manifest = {
    schema: MANIFEST_SCHEMA, created_at: now, ledger_sha256: ledgerBefore, kit_head: gitHead(world.kit),
    bases: { '<tmp>': world.tmp, '<config>': world.config, '<root>': world.root, '<kit>': world.kit },
    access, cleanup: cleanupSetting(world), totals: totals(entries), missing, groups: groupDigests(entries), files: entries,
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const kit = kitManifestOf(manifest, world);
  if (kitManifest) fs.writeFileSync(kitManifest, `${JSON.stringify(kit, null, 2)}\n`);
  return { manifest, kit, problems: entries.filter((e) => !['archived', 'link'].includes(e.status)).map((e) => `${e.label}: ${e.status}`) };
}

const gitHead = (dir) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout?.trim() || null;

// Each folder's digest: the sha256 of its sorted `relative path NUL sha256` lines.
export function groupDigests(entries) {
  const by = new Map();
  for (const e of entries) if (e.sha256) by.set(e.group, [...(by.get(e.group) ?? []), e]);
  return [...by].map(([label, list]) => ({
    label, class: list[0].class, files: list.length, bytes: list.reduce((n, e) => n + e.size, 0),
    tree_sha256: sha256(list.map((e) => `${e.label.slice(label.length + 1)}\0${e.sha256}\n`).sort().join('')),
  })).sort((a, b) => a.label.localeCompare(b.label));
}

// The committable view: hashes only, every folder's digest, and file by file
// the kit evidence, the run records and the session transcripts. No absolute
// path, no base folder and no content.
export function kitManifestOf(manifest, world) {
  const keep = (e) => e.class === 'kit' || e.label.includes('/.nth-review/') || /\/[0-9a-f-]{36}\.jsonl$/.test(e.label) || /\/subagents\/[^/]+\.jsonl$/.test(e.label) || e.label.endsWith('/verdicts.json');
  const kit = {
    schema: MANIFEST_SCHEMA, view: 'hash-only', created_at: manifest.created_at, ledger_sha256: manifest.ledger_sha256, kit_head: manifest.kit_head,
    access: { restricted: manifest.access.restricted }, cleanup: manifest.cleanup, totals: manifest.totals, missing: manifest.missing, groups: manifest.groups,
    files: manifest.files.filter(keep).map(({ class: c, label, size, sha256: h, status, provenance }) => ({ class: c, label, size, sha256: h, status, ...(provenance.length ? { provenance } : {}) })),
  };
  assertNoAbsolute(JSON.stringify(kit), world);
  return kit;
}

export function assertNoAbsolute(text, world) {
  const forms = [world.tmp, world.config, world.kit, world.root, os.homedir()].filter(Boolean).flatMap((p) => [p, posix(p), p.replaceAll('\\', '\\\\')]);
  const hit = forms.find((f) => text.toLowerCase().includes(f.toLowerCase()));
  if (hit) throw new Error('the kit manifest would hold an absolute path');
  if (/[A-Za-z]:[\\/]/.test(text)) throw new Error('the kit manifest would hold a drive path');
}

// Re-hashes every archived file against the archive's manifest, reports files
// the manifest does not list, and checks the archive's manifest against the
// committed kit manifest. Without the kit manifest, an archive whose
// manifest.json was edited along with its files cannot be told apart, so the
// result says it is not anchored.
export function verify(dir, { kitManifest = null } = {}) {
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const listed = new Set();
  for (const e of manifest.files) {
    if (e.status === 'link') continue;
    if (!e.archive_path) { problems.push(`${e.label}: ${e.status} when archived`); continue; }
    const file = path.join(dir, ...e.archive_path.split('/'));
    if (!e.archive_path.startsWith('files/') || !inside(file, path.join(dir, 'files'))) { problems.push(`${e.label}: its archive path leaves the archive`); continue; }
    listed.add(path.resolve(file).toLowerCase());
    if (!fs.existsSync(file)) { problems.push(`${e.label}: missing from the archive`); continue; }
    const h = hashFile(file);
    if (h !== e.sha256) problems.push(`${e.label}: sha256 differs from the manifest`);
    if (e.status !== 'archived') problems.push(`${e.label}: ${e.status} when archived`);
  }
  if (fs.existsSync(path.join(dir, 'files'))) {
    for (const f of walk(path.join(dir, 'files'))) if (!listed.has(path.resolve(f.abs).toLowerCase())) problems.push(`${posix(path.relative(dir, f.abs))}: in the archive but not in its manifest`);
  }
  const recomputed = groupDigests(manifest.files);
  if (JSON.stringify(recomputed) !== JSON.stringify(manifest.groups)) problems.push('the manifest\'s folder digests do not match its files');
  if (kitManifest) {
    const kit = JSON.parse(fs.readFileSync(kitManifest, 'utf8'));
    if (kit.ledger_sha256 !== manifest.ledger_sha256) problems.push('the ledger sha256 differs from the kit manifest');
    if (JSON.stringify(kit.groups) !== JSON.stringify(manifest.groups)) problems.push('the folder digests differ from the kit manifest');
    const byLabel = new Map(manifest.files.map((e) => [e.label, e]));
    for (const k of kit.files) if (byLabel.get(k.label)?.sha256 !== k.sha256) problems.push(`${k.label}: differs from the kit manifest`);
  }
  return { ok: problems.length === 0, anchored: Boolean(kitManifest), files: manifest.files.length, problems };
}

export function main(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i].replace(/^--/, '');
    if (!['config', 'root', 'ledger', 'to', 'archive', 'kit-manifest'].includes(flag)) { process.stderr.write(`unknown argument ${rest[i]}\n`); return 2; }
    opts[flag] = rest[++i];
  }
  const world = makeWorld({ config: opts.config, root: opts.root, ledger: opts.ledger });
  const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  if (command === 'inventory') { out(inventory(world)); return 0; }
  if (command === 'archive') {
    if (!opts.to) { process.stderr.write('usage: archive --to <dir> [--config <dir>] [--root <dir>] [--kit-manifest <file>]\n'); return 2; }
    const r = archive(world, opts.to, { kitManifest: opts['kit-manifest'] ?? DEFAULT_KIT_MANIFEST });
    out({ files: r.manifest.files.length, totals: r.manifest.totals, missing: r.manifest.missing.length, access: r.manifest.access, problems: r.problems });
    return r.problems.length ? 1 : 0;
  }
  if (command === 'verify') {
    if (!opts.archive) { process.stderr.write('usage: verify --archive <dir> [--kit-manifest <file>]\n'); return 2; }
    const kitManifest = opts['kit-manifest'] ?? (fs.existsSync(DEFAULT_KIT_MANIFEST) ? DEFAULT_KIT_MANIFEST : null);
    const r = verify(opts.archive, { kitManifest });
    out(r);
    return r.ok ? 0 : 1;
  }
  process.stderr.write('usage: evidence.mjs <inventory|archive|verify> [--config <dir>] [--root <dir>] [--ledger <file>] [--to <dir>] [--archive <dir>] [--kit-manifest <file>]\n');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
