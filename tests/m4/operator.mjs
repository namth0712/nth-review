// M4-T3 rehearsal operator: a literal transcription of the Enable, Update and
// Disable procedures in INSTALL.md, used only to rehearse them in throwaway
// projects. It is not the integration: the package ships the procedure as
// instructions, and this file never runs in a project on its own. Step
// comments cite INSTALL.md. Every mutating action goes through `io`, which can
// stop the operation at the n-th action to simulate a crash.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILL_REL = '.claude/skills/nth-review';
export const STATE_REL = '.claude/nth-dev-kit-hooks/review.state.json';
const CREATED_DIRS = ['.claude', '.claude/nth-dev-kit-hooks', '.claude/skills'];
const RUNTIME_KEY = /^(?:SKILL\.md|THIRD-PARTY-NOTICES\.md|reference\/[a-z0-9-]+\.md|scripts\/nthr\.mjs|scripts\/lib\/[a-z0-9-]+\.mjs)$/;
const HASH = /^[0-9a-f]{64}$/;
export const PACKAGE_ID = 'nth-review@nth-review';
export const LEGACY_LIBRARY = ['nth-dev-kit', 'agents', 'claude', 'integrations', 'review'];

export class Stop extends Error {
  constructor(kind, items) {
    super(`${kind}: ${items.join('; ')}`);
    this.kind = kind; // 'conflict' (Validation or preflight) or 'stopped' (a precondition)
    this.items = items;
  }
}
export class Crash extends Error {}

export const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const lfCanonical = (bytes) => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
const abs = (P, rel) => path.join(P, ...rel.split('/'));
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Mutating actions, counted; `crashAt` stops before the n-th one completes.
export function makeIO({ crashAt = 0 } = {}) {
  const trace = [];
  const step = (label) => {
    trace.push(label);
    if (trace.length === crashAt) throw new Crash(label);
  };
  return {
    trace,
    mkdir(p, label) { step(`mkdir ${label}`); fs.mkdirSync(p); },
    // INSTALL.md, Writing a file: temporary name, verify, rename.
    writeFile(p, bytes, label) {
      const tmp = path.join(path.dirname(p), `.${path.basename(p)}.nth-tmp`);
      step(`write-tmp ${label}`);
      fs.writeFileSync(tmp, bytes, { flag: 'wx' });
      if (sha(fs.readFileSync(tmp)) !== sha(bytes)) throw new Error(`verify failed: ${label}`);
      step(`rename ${label}`);
      fs.renameSync(tmp, p);
    },
    rm(p, label) { step(`rm ${label}`); fs.rmSync(p); },
    rmdir(p, label) { step(`rmdir ${label}`); fs.rmdirSync(p); },
  };
}

// Duplicate or case-only-different keys within any object of a parsed JSON text.
function duplicateKeys(text) {
  let i = 0;
  const found = [];
  const ws = () => { while (/\s/.test(text[i] ?? '')) i += 1; };
  const str = () => {
    let j = i + 1;
    while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    const value = JSON.parse(text.slice(i, j + 1));
    i = j + 1;
    return value;
  };
  const value = () => {
    ws();
    if (text[i] === '{') {
      i += 1;
      const seen = new Set();
      ws();
      if (text[i] === '}') { i += 1; return; }
      for (;;) {
        ws();
        const key = str();
        if (seen.has(key.toLowerCase())) found.push(key);
        seen.add(key.toLowerCase());
        ws(); i += 1; value(); ws();
        if (text[i] === ',') { i += 1; continue; }
        i += 1;
        return;
      }
    }
    if (text[i] === '[') {
      i += 1; ws();
      if (text[i] === ']') { i += 1; return; }
      for (;;) { value(); ws(); if (text[i] === ',') { i += 1; continue; } i += 1; return; }
    }
    if (text[i] === '"') { str(); return; }
    while (i < text.length && !/[,}\]\s]/.test(text[i])) i += 1;
  };
  value();
  return found;
}

// Enable step 4: the installed package, its manifest verified, and the runtime
// files that the package's own copy of INSTALL.md lists. Never the source checkout.
const SAFE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]+$/;

// The runtime-file table row of INSTALL.md (see the runtime-files table there).
function listedRuntimeFiles(docText) {
  const row = docText.split('\n').find((line) => line.startsWith('| `<P>/.claude/skills/nth-review/`'));
  if (!row) return [];
  const files = [];
  for (const group of row.split('|')[1].split('<br>').slice(1)) {
    let dir = '';
    for (const [, name] of group.matchAll(/`([^`]+)`/g)) {
      if (name.includes('/')) dir = name.slice(0, name.lastIndexOf('/') + 1);
      files.push(name.includes('/') ? name : dir + name);
    }
  }
  return files.sort();
}

// INSTALL.md, Enable 4: the package the plugin manager installed, never a source
// checkout. Its install path comes from <config>/plugins/installed_plugins.json
// and must lie inside <config>/plugins/cache/.
const REPAIR = 'install or repair the nth-review plugin (INSTALL.md, Package)';
export function loadPackage(config) {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(config, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch (error) {
    throw new Stop('stopped', [`the nth-review package is not installed (${error.code ?? 'invalid plugin registry'})`, REPAIR]);
  }
  const entries = registry?.plugins?.[PACKAGE_ID];
  const paths = Array.isArray(entries) ? [...new Set(entries.map((e) => e?.installPath).filter((p) => typeof p === 'string'))] : [];
  if (!paths.length) throw new Stop('stopped', ['the nth-review package is not installed', REPAIR]);
  if (paths.length > 1) throw new Stop('stopped', [`the nth-review package has ${paths.length} install paths`, REPAIR]);
  const cache = path.join(config, 'plugins', 'cache');
  let root;
  try { root = fs.realpathSync(paths[0]); } catch { throw new Stop('stopped', ['the nth-review package folder is missing', REPAIR]); }
  const cacheReal = exists(cache) ? fs.realpathSync(cache) : null;
  if (!cacheReal || !root.startsWith(cacheReal + path.sep)) throw new Stop('stopped', ['the nth-review package is not inside <config>/plugins/cache/', REPAIR]);
  let manifest;
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8');
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Stop('stopped', [`invalid or missing package manifest (${error.code ?? 'JSON'})`, REPAIR]);
  }
  if (manifest?.schemaVersion !== 1 || manifest.package !== 'nth-review' || typeof manifest.files !== 'object' || !manifest.files) {
    throw new Stop('stopped', ['invalid package manifest', REPAIR]);
  }
  const problems = duplicateKeys(text).map((key) => `duplicate manifest key: ${key}`);
  const verified = new Map();
  for (const [key, digest] of Object.entries(manifest.files)) {
    if (!SAFE_PATH.test(key)) { problems.push(`unsafe manifest path: ${key}`); continue; }
    let bytes;
    try { bytes = fs.readFileSync(abs(root, key)); } catch { problems.push(`missing package file: ${key}`); continue; }
    const lf = lfCanonical(bytes);
    if (sha(lf) !== digest) { problems.push(`digest mismatch: ${key}`); continue; }
    verified.set(key, { bytes: lf, digest });
  }
  const docKey = 'INSTALL.md';
  if (!Object.hasOwn(manifest.files, docKey)) problems.push('no manifest entry for INSTALL.md');
  const listed = verified.has(docKey) ? listedRuntimeFiles(verified.get(docKey).bytes.toString('utf8')) : [];
  const files = new Map();
  for (const rel of listed) {
    if (!RUNTIME_KEY.test(rel)) problems.push(`not a runtime path: ${rel}`);
    else if (!Object.hasOwn(manifest.files, rel)) problems.push(`no manifest entry for runtime file: ${rel}`);
    else if (verified.has(rel)) files.set(rel, verified.get(rel));
  }
  if (problems.length) throw new Stop('stopped', [...problems, REPAIR]);
  const sorted = [...files.keys()].sort();
  const digest = sha(sorted.map((rel) => `${rel} ${files.get(rel).digest}`).join('\n'));
  return { files, sorted, digest, root, version: manifest.version };
}

// INSTALL.md, Legacy installations: what Enable and Update report, never touch.
function legacyReport(config) {
  return exists(path.join(config, ...LEGACY_LIBRARY))
    ? ['a legacy nth-dev-kit library copy of nth-review exists under <config>/nth-dev-kit/; it is not used, and nth-dev-kit manages it; left alone']
    : [];
}

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), `${rel}/`));
    else out.push(rel);
  }
  return out.sort();
}

function readState(P) {
  const p = abs(P, STATE_REL);
  if (!exists(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  let state;
  try { state = JSON.parse(text); } catch { throw new Stop('conflict', ['state file: invalid JSON']); }
  const problems = [];
  if (state?.schemaVersion !== 1) problems.push('state file: unknown schemaVersion');
  if (state?.skill?.path !== 'skills/nth-review') problems.push('state file: skill path');
  for (const field of ['files', 'pending']) {
    const map = state?.skill?.[field];
    if (map === undefined && field === 'pending') continue;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) { problems.push(`state file: ${field} is not an object`); continue; }
    for (const [key, hash] of Object.entries(map)) {
      if (!RUNTIME_KEY.test(key)) problems.push(`state file: bad key ${key}`);
      if (typeof hash !== 'string' || !HASH.test(hash)) problems.push(`state file: bad hash for ${key}`);
    }
  }
  if (state?.library !== undefined && !(typeof state.library === 'string' && HASH.test(state.library))) problems.push('state file: bad library digest');
  if (!Array.isArray(state?.createdDirs) || state.createdDirs.some((d) => !CREATED_DIRS.includes(d))) problems.push('state file: bad createdDirs');
  for (const key of duplicateKeys(text)) problems.push(`state file: duplicate key ${key}`);
  if (problems.length) throw new Stop('conflict', problems);
  return { files: { ...state.skill.files }, pending: { ...(state.skill.pending ?? {}) }, library: state.library, createdDirs: [...state.createdDirs] };
}

// INSTALL.md: whether the state changed is judged by its parsed content, not its formatting.
function sameState(P, state) {
  const p = abs(P, STATE_REL);
  if (!exists(p)) return false;
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  const current = { files: parsed.skill.files, pending: parsed.skill.pending ?? {}, library: parsed.library, createdDirs: parsed.createdDirs };
  return serialize(current).equals(serialize(state));
}

const serialize = (state) => {
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const skill = { path: 'skills/nth-review', files: sortObj(state.files) };
  if (Object.keys(state.pending ?? {}).length) skill.pending = sortObj(state.pending);
  const out = { schemaVersion: 1 };
  if (state.library) out.library = state.library;
  out.skill = skill;
  out.createdDirs = CREATED_DIRS.filter((d) => state.createdDirs.includes(d));
  return Buffer.from(`${JSON.stringify(out, null, 2)}\n`, 'utf8');
};

// INSTALL.md, Validation 1-4.
export function validate(ctx, runtimeRels) {
  const { P, config } = ctx;
  const state = readState(P);
  const problems = [];
  const realP = fs.realpathSync(P);
  // 2. Paths: every component of every target, from <P> down.
  const targets = new Set(['.claude', '.claude/skills', SKILL_REL, '.claude/nth-dev-kit-hooks', STATE_REL]);
  const rels = new Set([...runtimeRels, ...Object.keys(state?.files ?? {}), ...Object.keys(state?.pending ?? {})]);
  for (const rel of rels) {
    const parts = rel.split('/');
    for (let k = 1; k <= parts.length; k += 1) targets.add(`${SKILL_REL}/${parts.slice(0, k).join('/')}`);
  }
  for (const rel of targets) {
    const p = abs(P, rel);
    const parent = path.dirname(p);
    const name = path.basename(p);
    if (exists(parent) && fs.lstatSync(parent).isDirectory()) {
      for (const entry of fs.readdirSync(parent)) {
        if (entry !== name && (entry.toLowerCase() === name.toLowerCase() || entry.normalize('NFC') === name.normalize('NFC'))) {
          problems.push(`name differs only in case or normalization: ${path.posix.join(path.posix.dirname(rel), entry)}`);
        }
      }
    }
    if (!exists(p)) continue;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { problems.push(`link, junction or reparse point: ${rel}`); continue; }
    const real = fs.realpathSync(p);
    if (!(real === realP || real.startsWith(realP + path.sep))) problems.push(`outside <P>: ${rel}`);
  }
  const home = ctx.home ?? os.homedir();
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  for (const [label, dir] of [['config', config], ['package', path.join(config, 'plugins', 'cache', 'nth-review')], ['source checkout', ctx.kit]].filter(([, d]) => d && exists(d))) {
    const real = fs.realpathSync(dir);
    if (inside(realP, real) || inside(real, realP)) problems.push(`<P> overlaps the ${label}`);
  }
  if (realP === fs.realpathSync(home)) problems.push('<P> is the home directory');
  // 3. Git, read-only: rev-parse and ls-files only.
  const git = (args) => spawnSync('git', args, { cwd: P, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status === 0) {
    const listed = git(['ls-files', '-z', '--', SKILL_REL, STATE_REL]);
    if (listed.status !== 0) problems.push(`git ls-files failed; the tracked check could not run: ${listed.stderr.trim()}`);
    for (const t of listed.stdout.split('\0').filter(Boolean)) problems.push(`tracked by Git: ${t}`);
  } else if (!/not a git repository/i.test(top.stderr)) {
    // Only Git's "not a git repository" means no work tree; anything else is a conflict.
    problems.push(`git rev-parse failed; the tracked check could not run: ${top.stderr.trim()}`);
  }
  // 4. Leftovers.
  const skillDir = abs(P, SKILL_REL);
  if (exists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
    for (const rel of walkFiles(skillDir)) if (/(^|\/)\.[^/]+\.nth-tmp$/.test(rel)) problems.push(`temporary file: ${SKILL_REL}/${rel}`);
  }
  const hooks = abs(P, '.claude/nth-dev-kit-hooks');
  if (exists(hooks) && !fs.lstatSync(hooks).isSymbolicLink()) {
    for (const name of fs.readdirSync(hooks)) if (/^\..+\.nth-tmp$/.test(name)) problems.push(`temporary file: .claude/nth-dev-kit-hooks/${name}`);
  }
  if (problems.length) throw new Stop('conflict', problems);
  return state;
}

const fileHash = (P, rel) => {
  const p = abs(P, `${SKILL_REL}/${rel}`);
  return exists(p) ? sha(fs.readFileSync(p)) : null;
};
const owned = (state, rel, hash) => hash !== null && state !== null && (hash === state.files[rel] || hash === state.pending[rel]);

function writePlanned(ctx, toWrite, toDelete, lib) {
  const { P, io } = ctx;
  // Enable 9 / Update 5: create the remaining directories first.
  const dirs = ['.claude/skills', SKILL_REL];
  for (const rel of toWrite) {
    const parts = rel.split('/').slice(0, -1);
    for (let k = 1; k <= parts.length; k += 1) dirs.push(`${SKILL_REL}/${parts.slice(0, k).join('/')}`);
  }
  for (const dir of [...new Set(dirs)]) if (!exists(abs(P, dir))) io.mkdir(abs(P, dir), dir);
  // SKILL.md is deleted first and written last.
  if (toWrite.includes('SKILL.md') && exists(abs(P, `${SKILL_REL}/SKILL.md`))) io.rm(abs(P, `${SKILL_REL}/SKILL.md`), 'SKILL.md');
  for (const rel of toWrite.filter((r) => r !== 'SKILL.md')) io.writeFile(abs(P, `${SKILL_REL}/${rel}`), lib.files.get(rel).bytes, rel);
  for (const rel of toDelete) io.rm(abs(P, `${SKILL_REL}/${rel}`), rel);
  if (toWrite.includes('SKILL.md')) io.writeFile(abs(P, `${SKILL_REL}/SKILL.md`), lib.files.get('SKILL.md').bytes, 'SKILL.md');
}

function checkTools() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Stop('stopped', ['Node.js 20 or later is required']);
  if (spawnSync('git', ['--version'], { windowsHide: true }).status !== 0) throw new Stop('stopped', ['Git is required']);
}

// INSTALL.md, Enable 1-11.
export function enable(ctx) {
  const { P, config, io } = ctx;
  const report = [];
  checkTools(); // 2
  const lib = loadPackage(config); // 4
  const state = validate(ctx, lib.sorted); // 5
  const skillDir = abs(P, SKILL_REL);
  // 6. Preflight.
  if (!state && exists(skillDir)) throw new Stop('conflict', ['skill folder without a state file (lost state); remove it by hand']);
  const conflicts = [];
  const toWrite = [];
  const current = {};
  for (const rel of lib.sorted) {
    const hash = fileHash(P, rel);
    const { digest } = lib.files.get(rel);
    if (hash === null) toWrite.push(rel);
    else if (owned(state, rel, hash)) { current[rel] = hash; if (hash !== digest) toWrite.push(rel); }
    else conflicts.push(`modified or unowned: ${rel}`);
  }
  const recorded = new Set([...Object.keys(state?.files ?? {}), ...Object.keys(state?.pending ?? {})]);
  if (exists(skillDir)) {
    for (const rel of walkFiles(skillDir)) if (!lib.files.has(rel) && !recorded.has(rel)) conflicts.push(`unrecorded file: ${rel}`);
  }
  // Recorded files the package no longer ships.
  const toDelete = [];
  const dropRecord = [];
  for (const rel of [...recorded].filter((r) => !lib.files.has(r)).sort()) {
    const hash = fileHash(P, rel);
    if (hash === null) dropRecord.push(rel);
    else if (owned(state, rel, hash)) { current[rel] = hash; toDelete.push(rel); }
    else conflicts.push(`modified file the package dropped: ${rel}`);
  }
  const replacing = toWrite.some((rel) => current[rel] !== undefined) || toDelete.length > 0;
  if (replacing && !toWrite.includes('SKILL.md')) toWrite.push('SKILL.md');
  if (conflicts.length) throw new Stop('conflict', conflicts);
  // 7. Shadowing, and a legacy library copy.
  if (exists(path.join(config, 'skills', 'nth-review'))) report.push('a personal <config>/skills/nth-review/ shadows the project copy; left alone');
  report.push(...legacyReport(config));
  // The final state this run must reach.
  const finalFiles = { ...(state?.files ?? {}), ...Object.fromEntries(lib.sorted.map((rel) => [rel, lib.files.get(rel).digest])) };
  for (const rel of [...toDelete, ...dropRecord]) delete finalFiles[rel];
  const finalState = { files: finalFiles, pending: {}, library: lib.digest, createdDirs: [...(state?.createdDirs ?? [])] };
  if (!toWrite.length && !toDelete.length && sameState(P, finalState)) {
    return { result: 'unchanged', report: [...report, ...verifyInstall(P, lib)] };
  }
  // 8. Directories, then the intent record.
  const created = [];
  for (const dir of ['.claude', '.claude/nth-dev-kit-hooks']) if (!exists(abs(P, dir))) { io.mkdir(abs(P, dir), dir); created.push(dir); }
  if (!exists(abs(P, '.claude/skills'))) created.push('.claude/skills');
  const createdDirs = [...new Set([...(state?.createdDirs ?? []), ...created])];
  const intent = {
    files: { ...(state?.files ?? {}), ...current },
    pending: Object.fromEntries(toWrite.map((rel) => [rel, lib.files.get(rel).digest])),
    library: lib.digest,
    createdDirs,
  };
  io.writeFile(abs(P, STATE_REL), serialize(intent), 'state (intent)');
  // 9. Files, SKILL.md last.
  writePlanned(ctx, toWrite, toDelete, lib);
  // 10. Verify, then the final state, last.
  for (const rel of lib.sorted) if (fileHash(P, rel) !== lib.files.get(rel).digest) throw new Error(`verify failed: ${rel}`);
  io.writeFile(abs(P, STATE_REL), serialize({ ...finalState, createdDirs }), 'state (final)');
  // 11. Version and report.
  return {
    result: 'enabled',
    report: [...report, ...verifyInstall(P, lib), 'offered to new sessions; a running session sees it only after a delay, so start a new one',
      'runs only when typed as /nth-review', 'optional: the local exclude lines in INSTALL.md (Git)'],
    wrote: toWrite,
  };
}

function verifyInstall(P, lib) {
  const run = spawnSync(process.execPath, [abs(P, `${SKILL_REL}/scripts/nthr.mjs`), 'version'], { cwd: P, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`nthr.mjs version failed: ${run.stderr}`);
  return [`version: ${run.stdout.trim().split('\n')[0]}`, `library ${lib.digest.slice(0, 12)}`];
}

// INSTALL.md, Update 1-6.
export function update(ctx) {
  const { P, io } = ctx;
  if (!exists(abs(P, STATE_REL))) throw new Stop('stopped', ['not enabled in this project (no state file)']); // 1
  checkTools();
  const lib = loadPackage(ctx.config); // 2
  const state = validate(ctx, lib.sorted);
  if (!lib.sorted.length) return { result: 'unchanged', report: ['the package no longer ships the skill; Disable can remove it'] }; // 3
  // 4. Preflight, all or nothing.
  const conflicts = [];
  const report = [];
  if (exists(path.join(ctx.config, 'skills', 'nth-review'))) report.push('a personal <config>/skills/nth-review/ shadows the project copy; left alone');
  report.push(...legacyReport(ctx.config));
  const toWrite = [];
  const toDelete = [];
  const dropRecord = [];
  const current = {};
  const recorded = new Set([...Object.keys(state.files), ...Object.keys(state.pending)]);
  for (const rel of lib.sorted) {
    const hash = fileHash(P, rel);
    const { digest } = lib.files.get(rel);
    if (hash !== null) {
      if (owned(state, rel, hash)) { current[rel] = hash; if (hash !== digest) toWrite.push(rel); }
      else conflicts.push(`modified or unowned: ${rel}`);
    } else if (recorded.has(rel)) {
      if (state.pending[rel] !== undefined) toWrite.push(rel);
      else conflicts.push(`deleted: ${rel} (Enable repairs it)`);
    } else toWrite.push(rel);
  }
  for (const rel of [...recorded].filter((r) => !lib.files.has(r)).sort()) {
    const hash = fileHash(P, rel);
    if (hash === null) dropRecord.push(rel);
    else if (owned(state, rel, hash)) { current[rel] = hash; toDelete.push(rel); }
    else conflicts.push(`modified file the package dropped: ${rel}`);
  }
  if (exists(abs(P, SKILL_REL))) {
    for (const rel of walkFiles(abs(P, SKILL_REL))) if (!lib.files.has(rel) && !recorded.has(rel)) report.push(`unrecorded file left in place: ${rel}`);
  }
  if ((toWrite.length || toDelete.length) && !toWrite.includes('SKILL.md')) {
    if (current['SKILL.md'] !== undefined) toWrite.push('SKILL.md');
  }
  if (conflicts.length) throw new Stop('conflict', conflicts);
  const files = { ...state.files };
  for (const rel of [...toDelete, ...dropRecord]) delete files[rel];
  for (const rel of lib.sorted) files[rel] = lib.files.get(rel).digest;
  const finalState = { files, pending: {}, library: lib.digest, createdDirs: state.createdDirs };
  if (!toWrite.length && !toDelete.length && sameState(P, finalState)) {
    return { result: 'unchanged', report };
  }
  // 5. Intent record, SKILL.md first, files, SKILL.md last, final state last.
  const intent = {
    files: { ...state.files, ...current },
    pending: Object.fromEntries(toWrite.map((rel) => [rel, lib.files.get(rel).digest])),
    library: lib.digest,
    createdDirs: state.createdDirs,
  };
  io.writeFile(abs(P, STATE_REL), serialize(intent), 'state (intent)');
  writePlanned(ctx, toWrite, toDelete, lib);
  for (const rel of lib.sorted) if (fileHash(P, rel) !== lib.files.get(rel).digest) throw new Error(`verify failed: ${rel}`);
  io.writeFile(abs(P, STATE_REL), serialize(finalState), 'state (final)');
  return { result: 'updated', report, wrote: toWrite, deleted: toDelete };
}

// INSTALL.md, Disable 1-5.
export function disable(ctx) {
  const { P, io } = ctx;
  const state = validate(ctx, []); // 1
  const skillDir = abs(P, SKILL_REL);
  if (!state) {
    const report = exists(skillDir) ? ['skills/nth-review/ is user-owned; nothing done'] : [];
    const hooks = abs(P, '.claude/nth-dev-kit-hooks');
    if (exists(hooks) && !fs.readdirSync(hooks).length) report.push('an empty .claude/nth-dev-kit-hooks/ may be left by an interrupted operation; remove it by hand');
    else if (exists(abs(P, '.claude')) && !fs.readdirSync(abs(P, '.claude')).length) report.push('an empty .claude/ may be left by an interrupted operation; remove it by hand if you did not create it');
    return { result: 'not-enabled', report };
  }
  const report = [];
  const keep = { files: {}, pending: {} };
  const recorded = [...new Set([...Object.keys(state.files), ...Object.keys(state.pending)])].sort();
  const order = recorded.includes('SKILL.md') ? ['SKILL.md', ...recorded.filter((r) => r !== 'SKILL.md')] : recorded; // 2
  for (const rel of order) { // 3
    const hash = fileHash(P, rel);
    if (hash === null) continue;
    if (owned(state, rel, hash)) io.rm(abs(P, `${SKILL_REL}/${rel}`), rel);
    else {
      report.push(`conflict, kept: ${rel}`);
      if (state.files[rel] !== undefined) keep.files[rel] = state.files[rel];
      if (state.pending[rel] !== undefined) keep.pending[rel] = state.pending[rel];
    }
  }
  if (exists(skillDir)) for (const rel of walkFiles(skillDir)) if (!recorded.includes(rel)) report.push(`unrecorded file left in place: ${rel}`);
  const rmdirIfEmpty = (rel) => {
    const p = abs(P, rel);
    if (exists(p) && fs.lstatSync(p).isDirectory() && !fs.readdirSync(p).length) io.rmdir(p, rel);
  };
  for (const rel of [`${SKILL_REL}/reference`, `${SKILL_REL}/scripts/lib`, `${SKILL_REL}/scripts`, SKILL_REL]) rmdirIfEmpty(rel);
  if (state.createdDirs.includes('.claude/skills')) rmdirIfEmpty('.claude/skills');
  const conflicted = Object.keys(keep.files).length + Object.keys(keep.pending).length > 0;
  if (!conflicted) { // 4
    io.rm(abs(P, STATE_REL), 'state');
    for (const rel of ['.claude/nth-dev-kit-hooks', '.claude']) if (state.createdDirs.includes(rel)) rmdirIfEmpty(rel);
    return { result: 'disabled', report: [...report, '.nth-review/ preserved (never read, moved or deleted)'] };
  }
  const rest = { files: keep.files, pending: keep.pending, library: state.library, createdDirs: state.createdDirs };
  if (!sameState(P, rest)) io.writeFile(abs(P, STATE_REL), serialize(rest), 'state (conflicts only)');
  return { result: 'conflict', report: [...report, '.nth-review/ preserved (never read, moved or deleted)'] };
}
