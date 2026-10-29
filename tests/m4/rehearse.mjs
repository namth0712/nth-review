// M4-T3 lifecycle rehearsal. Builds throwaway installed packages (each in its
// own throwaway CLAUDE_CONFIG_DIR, as the plugin manager lays one out, with its
// manifest) and synthetic projects under the OS temporary directory, runs
// operator.mjs (the transcription of INSTALL.md) through every scenario,
// including a crash at every write point, and records the observed result of
// each. Nothing outside the temporary root is written; this repository is only read.
// Usage: node rehearse.mjs [--keep] [--json <file>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ENTRIES, lfDigest, makePackageCache, registerPackage, writeReceipt } from '../helpers/library.mjs';
import { buildManifest } from '../tools/runtime-manifest.mjs';
import { Crash, SKILL_REL, STATE_REL, Stop, disable, enable, loadPackage, makeIO, sha, update } from './operator.mjs';

const REVIEW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The source checkout: Enable never installs from it.
const KIT = REVIEW;
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-m4-'));
const rows = [];
const p = (...parts) => path.join(...parts);
const at = (P, rel) => path.join(P, ...rel.split('/'));
const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };

function record(n, scenario, expect, observed, ok, status) {
  rows.push({ n, scenario, expect, observed, status: status ?? (ok ? 'pass' : 'fail') });
}

// ------------------------------------------------------------- fixtures

function git(cwd, gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function initRepo(dir, files, commit) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'rehearsal'], ['user.email', 'r@test.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(dir, ['config', k, v]);
  for (const [rel, text] of Object.entries(files)) write(at(dir, rel), text);
  if (commit.length) { git(dir, ['add', '--', ...commit]); git(dir, ['commit', '-q', '-m', 'fixture']); }
}

// Installed packages, as `claude plugin install` lays them out (INSTALL.md, Package).
// v2 is the current package; v1 is older (two changed files, census.md not yet
// shipped, legacy.md later dropped); v3 is newer (protocol.md changed).
const VERSIONS = { v1: '0.9.0-rehearsal', v2: null, v3: '1.1.0-rehearsal' };
function makeConfig(name, variant) {
  const config = p(ROOT, name);
  makePackageCache(config, {
    version: VERSIONS[variant],
    edit: (dir) => {
      const mod = (rel) => at(dir, rel);
      if (variant === 'v1') {
        fs.appendFileSync(mod('reference/routing.md'), '\n<!-- rehearsal v1 -->\n');
        fs.appendFileSync(mod('scripts/lib/render.mjs'), '// rehearsal v1\n');
        fs.rmSync(mod('reference/census.md'));
        write(mod('reference/legacy.md'), '# Legacy reference (rehearsal v1 only)\n');
        // The v1 package's own INSTALL.md lists v1's runtime files.
        const doc = at(dir, 'INSTALL.md');
        fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('`records.md`, `census.md`, `taxonomy.md`', '`records.md`, `legacy.md`, `taxonomy.md`'));
      }
      if (variant === 'v3') fs.appendFileSync(mod('reference/protocol.md'), '\n<!-- rehearsal v3 -->\n');
    },
  });
  return config;
}
// The installed package folder of a config, from its plugin registry.
const packageDir = (config) => JSON.parse(fs.readFileSync(p(config, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['nth-review@nth-review'][0].installPath;
// A copy of a config, its registry pointed at the copy's own package; `mutate(packageDir)` then changes it.
function cloneConfig(from, name, mutate) {
  const to = p(ROOT, name);
  fs.cpSync(from, to, { recursive: true });
  const rel = path.relative(from, packageDir(from));
  const version = JSON.parse(fs.readFileSync(p(from, rel, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  registerPackage(to, p(to, rel), version);
  mutate(p(to, rel), to);
  return to;
}
const writeManifest = (dir) => fs.writeFileSync(p(dir, 'runtime-manifest.json'), `${JSON.stringify(buildManifest(dir), null, 2)}\n`);

const BASE = p(ROOT, 'baselines');
function makeBaselines() {
  initRepo(p(BASE, 'rich'), {
    'src/app.js': 'export const answer = 42;\n',
    'README.md': '# Fixture\n',
    'CLAUDE.md': '# Project instructions\n',
    '.claude/settings.json': '{ "permissions": { "allow": [] } }\n',
    '.claude/agents/helper.md': '# user agent\n',
    '.claude/skills/other/SKILL.md': '---\nname: other\ndescription: a user skill\n---\nbody\n',
    '.nth-review/experiments/demo/decisions.json': '{"schema":"nth-review/decisions@1","entries":[]}\n',
  }, ['src/app.js', 'README.md', 'CLAUDE.md', '.claude/settings.json']);
  initRepo(p(BASE, 'bare'), { 'src/app.js': 'export const answer = 42;\n' }, ['src/app.js']);
  fs.mkdirSync(p(BASE, 'parent'), { recursive: true });
  initRepo(p(BASE, 'parent', 'a'), { 'index.js': 'a\n' }, ['index.js']);
  initRepo(p(BASE, 'parent', 'b'), { 'index.js': 'b\n' }, ['index.js']);
  write(p(BASE, 'parent', '.nth-review', 'experiments', 'demo', 'decisions.json'), '{}\n');
}
let projectCount = 0;
function project(kind) {
  projectCount += 1;
  const dir = p(ROOT, 'p', `${kind}-${projectCount}`);
  fs.cpSync(p(BASE, kind), dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------- observation

function snapshot(root) {
  const out = new Map();
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      const full = p(dir, e.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(full)}`);
      else if (st.isDirectory()) { out.set(rel, 'dir'); walk(full, `${rel}/`); }
      else out.set(rel, `file:${sha(fs.readFileSync(full))}`);
      if (rel.endsWith('.git/index')) out.set(`${rel}#mtime`, String(st.mtimeMs));
    }
  };
  walk(root, '');
  return out;
}
function diff(a, b) {
  const d = [];
  for (const [k, v] of a) if (b.get(k) !== v) d.push(`${b.has(k) ? '~' : '-'}${k}`);
  for (const k of b.keys()) if (!a.has(k)) d.push(`+${k}`);
  return d.sort();
}
const isIntegration = (entry) => {
  const rel = entry.slice(1);
  return ['.claude', '.claude/skills', '.claude/nth-dev-kit-hooks', SKILL_REL, STATE_REL].includes(rel)
    || rel.startsWith(`${SKILL_REL}/`) || rel.startsWith('.claude/nth-dev-kit-hooks/.');
};
const outside = (d) => d.filter((e) => !isIntegration(e));
// Documented limit: a crash before Enable's first state write, or after Disable
// deleted the state file, can leave these empty and unrecorded.
const EMPTY_LEFTOVERS = ['+.claude', '+.claude/nth-dev-kit-hooks'];

function attempt(op, P, config, opts = {}) {
  const io = makeIO({ crashAt: opts.crashAt ?? 0 });
  const ctx = { P, config, kit: KIT, io, home: opts.home };
  try {
    const r = op(ctx);
    return { outcome: r.result, report: r.report ?? [], trace: io.trace };
  } catch (error) {
    if (error instanceof Stop) return { outcome: error.kind, items: error.items, trace: io.trace };
    if (error instanceof Crash) return { outcome: 'crash', at: error.message, trace: io.trace };
    return { outcome: 'error', items: [String(error.stack ?? error)], trace: io.trace };
  }
}
const short = (r) => `${r.outcome}${r.items ? ` (${r.items.slice(0, 2).join('; ')}${r.items.length > 2 ? '; …' : ''})` : ''}, ${r.trace.length} writes`;

function installProblems(P, lib) {
  const problems = [];
  const dir = at(P, SKILL_REL);
  const files = [];
  const walk = (d, prefix) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(p(d, e.name), `${prefix}${e.name}/`); else files.push(prefix + e.name); } };
  if (!exists(dir)) return ['no skill folder'];
  walk(dir, '');
  if (files.sort().join('|') !== lib.sorted.join('|')) problems.push(`file set differs: ${files.filter((f) => !lib.files.has(f)).join(',')} / ${lib.sorted.filter((f) => !files.includes(f)).join(',')}`);
  for (const rel of lib.sorted) if (exists(at(dir, rel)) && sha(fs.readFileSync(at(dir, rel))) !== lib.files.get(rel).digest) problems.push(`bytes differ: ${rel}`);
  const state = JSON.parse(fs.readFileSync(at(P, STATE_REL), 'utf8'));
  if (state.skill.pending) problems.push('pending left');
  if (state.library !== lib.digest) problems.push('library digest');
  const expected = Object.fromEntries(lib.sorted.map((rel) => [rel, lib.files.get(rel).digest]));
  if (JSON.stringify(state.skill.files) !== JSON.stringify(Object.fromEntries(Object.keys(expected).sort().map((k) => [k, expected[k]])))) problems.push('state files differ');
  return problems;
}

// At a crash point: every file in the skill folder is provable from the state
// file, and SKILL.md is never present beside a folder that matches no single version.
function crashInvariants(P, libs) {
  const problems = [];
  const dir = at(P, SKILL_REL);
  const statePath = at(P, STATE_REL);
  const state = exists(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const files = [];
  const walk = (d, prefix) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(p(d, e.name), `${prefix}${e.name}/`); else files.push(prefix + e.name); } };
  if (exists(dir)) walk(dir, '');
  const real = files.filter((f) => !/(^|\/)\.[^/]+\.nth-tmp$/.test(f));
  for (const rel of real) {
    const h = sha(fs.readFileSync(at(dir, rel)));
    if (!state || (h !== state.skill.files[rel] && h !== state.skill.pending?.[rel])) problems.push(`unprovable: ${rel}`);
  }
  if (real.includes('SKILL.md')) {
    const consistent = libs.some((lib) => real.length === lib.sorted.length && lib.sorted.every((rel) => real.includes(rel) && sha(fs.readFileSync(at(dir, rel))) === lib.files.get(rel).digest));
    if (!consistent) problems.push('SKILL.md present beside a mixed folder');
  }
  return { problems, tmp: files.filter((f) => /\.nth-tmp$/.test(f)).length + (exists(at(P, '.claude/nth-dev-kit-hooks')) ? fs.readdirSync(at(P, '.claude/nth-dev-kit-hooks')).filter((n) => n.endsWith('.nth-tmp')).length : 0) };
}

// The user's documented recovery from a temporary-file conflict: remove it, rerun.
function removeTemps(P) {
  const removed = [];
  const visit = (d) => {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) visit(p(d, e.name));
      else if (/^\..+\.nth-tmp$/.test(e.name)) { fs.rmSync(p(d, e.name)); removed.push(e.name); }
    }
  };
  visit(at(P, SKILL_REL));
  visit(at(P, '.claude/nth-dev-kit-hooks'));
  return removed;
}
function rerun(op, P, config) {
  let r = attempt(op, P, config);
  let tempsRemoved = 0;
  if (r.outcome === 'conflict' && r.items.every((i) => i.startsWith('temporary file'))) {
    tempsRemoved = removeTemps(P).length;
    r = attempt(op, P, config);
  }
  return { r, tempsRemoved };
}

// ------------------------------------------------------------- scenarios

function main() {
  makeBaselines();
  const v1 = makeConfig('config-v1', 'v1');
  const v2 = makeConfig('config-v2', 'v2');
  const v3 = makeConfig('config-v3', 'v3');
  const L1 = loadPackage(v1);
  const L2 = loadPackage(v2);
  const L3 = loadPackage(v3);
  const baseRich = snapshot(p(BASE, 'rich'));
  const baseBare = snapshot(p(BASE, 'bare'));

  // 1. Clean Enable and repeated Enable.
  for (const kind of ['rich', 'bare', 'parent']) {
    const P = project(kind);
    const before = snapshot(P);
    const r = attempt(enable, P, v2);
    const after = snapshot(P);
    const added = diff(before, after);
    const problems = installProblems(P, L2);
    record('1', `Clean Enable (${kind} project)`, 'enabled; only the 27 files, the state file and created directories added; rest byte-identical',
      `${short(r)}; ${added.length} paths added (${outside(added).length} outside integration paths); install ${problems.length ? problems.join(',') : 'exact'}`,
      r.outcome === 'enabled' && !outside(added).length && !problems.length);
    const again = attempt(enable, P, v2);
    const after2 = snapshot(P);
    record('1', `Repeated Enable (${kind})`, 'unchanged, 0 writes, tree identical', `${short(again)}; ${diff(after, after2).length} paths changed`,
      again.outcome === 'unchanged' && !again.trace.length && !diff(after, after2).length);
    if (kind === 'rich') {
      const nthr = at(P, `${SKILL_REL}/scripts/nthr.mjs`);
      const ver = spawnSync(process.execPath, [nthr, 'version'], { cwd: P, encoding: 'utf8', windowsHide: true });
      const audit = spawnSync(process.execPath, [nthr, 'new-run', '--ns', 'audits/x', '--mode', 'audit-plan', '--slug', 'p'], { cwd: P, encoding: 'utf8', windowsHide: true });
      const after3 = snapshot(P);
      record('1', 'Installed helper: `version`, and the official-audit gate', 'version exits 0; audit-plan new-run exits 2 and writes nothing',
        `version exit ${ver.status}; audit exit ${audit.status}; ${diff(after2, after3).length} paths changed`, ver.status === 0 && audit.status === 2 && !diff(after2, after3).length);
      // 4 and 15. Clean Disable restores the pre-Enable tree exactly; repeated Disable.
      const d = attempt(disable, P, v2);
      const restored = diff(baseRich, snapshot(P));
      record('4/15', 'Clean Disable (rich): exact restoration', 'disabled; tree identical to before Enable, .claude user content and .nth-review intact',
        `${short(d)}; ${restored.length} paths differ from the pre-Enable tree`, d.outcome === 'disabled' && !restored.length);
      const d2 = attempt(disable, P, v2);
      record('4', 'Repeated Disable (rich)', 'not enabled, 0 writes', short(d2), d2.outcome === 'not-enabled' && !d2.trace.length);
    } else {
      const d = attempt(disable, P, v2);
      const restored = diff(kind === 'bare' ? baseBare : snapshot(p(BASE, 'parent')), snapshot(P));
      record('4/15', `Clean Disable (${kind}): exact restoration`, `disabled; tree identical to before Enable${kind === 'bare' ? ', .claude/ removed again' : ''}`,
        `${short(d)}; ${restored.length} paths differ`, d.outcome === 'disabled' && !restored.length);
    }
  }

  // 2 and 3. Update from an older install, and repeated Update.
  {
    const P = project('rich');
    attempt(enable, P, v1);
    const before = snapshot(P);
    const u = attempt(update, P, v2);
    const changed = diff(before, snapshot(P));
    const problems = installProblems(P, L2);
    const expected = [`~${SKILL_REL}/reference/routing.md`, `~${SKILL_REL}/scripts/lib/render.mjs`, `+${SKILL_REL}/reference/census.md`, `-${SKILL_REL}/reference/legacy.md`, `~${STATE_REL}`].sort();
    record('2', 'Update v1 → v2 (2 changed, 1 new, 1 dropped file)', `updated; exactly ${expected.length} paths change; SKILL.md deleted and rewritten (same bytes)`,
      `${short(u)}; changed: ${changed.map((c) => c.replace(`${SKILL_REL}/`, '')).join(' ')}; trace starts ${u.trace.slice(0, 3).join(' > ')}; install ${problems.length ? problems.join(',') : 'exact'}`,
      u.outcome === 'updated' && JSON.stringify(changed) === JSON.stringify(expected) && !problems.length && u.trace[2] === 'rm SKILL.md');
    const after = snapshot(P);
    const u2 = attempt(update, P, v2);
    record('3', 'Repeated Update (no library change)', 'unchanged, 0 writes', `${short(u2)}; ${diff(after, snapshot(P)).length} paths changed`, u2.outcome === 'unchanged' && !u2.trace.length && !diff(after, snapshot(P)).length);
    const e = attempt(enable, P, v2);
    record('3', 'Enable after Update (current)', 'unchanged, 0 writes', short(e), e.outcome === 'unchanged' && !e.trace.length);
    const d = attempt(disable, P, v2);
    record('4/15', 'Disable after an Update: exact restoration', 'tree identical to before the first Enable', `${short(d)}; ${diff(baseRich, snapshot(P)).length} paths differ`, d.outcome === 'disabled' && !diff(baseRich, snapshot(P)).length);
  }

  // 5. Interrupted Enable at every write point: fresh, and over an older install.
  crashLoop('5', 'Enable (fresh, rich)', 'rich', null, enable, v2, [L2], baseRich);
  crashLoop('5', 'Enable (fresh, bare: creates .claude/)', 'bare', null, enable, v2, [L2], baseBare);
  crashLoop('5', 'Enable over a v1 install (acts as an update)', 'rich', v1, enable, v2, [L1, L2], baseRich);
  // 6 and 7. Interrupted Update at every write point; recovery; Disable after it.
  crashLoop('6/7', 'Update v1 → v2', 'rich', v1, update, v2, [L1, L2], baseRich);
  // 6. An interrupted Update, then a newer library, then Update (and crashes in that one too).
  {
    const probe = project('rich');
    attempt(enable, probe, v1);
    const n = attempt(update, probe, v2).trace.length;
    let ok = 0;
    const failures = [];
    for (let k1 = 1; k1 < n; k1 += 1) {
      const P = project('rich');
      attempt(enable, P, v1);
      attempt(update, P, v2, { crashAt: k1 });
      const { r } = rerun(update, P, v3);
      const problems = r.outcome === 'updated' ? installProblems(P, L3) : [r.outcome];
      if (!problems.length && !outside(diff(baseRich, snapshot(P))).length) ok += 1; else failures.push(`k${k1}: ${problems.join(',')}`);
    }
    record('6', 'Update v1 → v2 interrupted at each point, then the library moves to v3, then Update', 'every case finishes at v3; nothing outside changes',
      `${ok}/${n - 1} finished at v3${failures.length ? `; failed ${failures.slice(0, 3).join(' | ')}` : ''}`, ok === n - 1);
    // A crash in that second Update as well: the first one stops right after
    // routing.md was replaced, so that file sits at its v2 pending hash.
    const k1 = (() => { const P = project('rich'); attempt(enable, P, v1); return attempt(update, P, v2).trace.indexOf('rename reference/routing.md') + 2; })();
    let ok2 = 0;
    let total2 = 0;
    const failures2 = [];
    for (let k2 = 1; k2 <= 60; k2 += 1) {
      const P = project('rich');
      attempt(enable, P, v1);
      attempt(update, P, v2, { crashAt: k1 });
      removeTemps(P);
      const r2 = attempt(update, P, v3, { crashAt: k2 });
      if (r2.outcome !== 'crash') break;
      total2 += 1;
      const inv = crashInvariants(P, [L1, L2, L3]);
      const { r } = rerun(update, P, v3);
      const problems = [...inv.problems, ...(r.outcome === 'updated' || r.outcome === 'unchanged' ? installProblems(P, L3) : [r.outcome])];
      if (!problems.length) ok2 += 1; else failures2.push(`k${k2}: ${problems.join(',')}`);
    }
    record('6', `Two interrupted Updates in a row (v2, stopped before action ${k1}; then v3, stopped before each of its actions), then Update`, 'every file stays provable; every case finishes at v3',
      `${ok2}/${total2} finished at v3${failures2.length ? `; failed ${failures2.slice(0, 3).join(' | ')}` : ''}`, total2 > 0 && ok2 === total2);
  }
  // Disable interrupted at every point.
  for (const [kind, base] of [['rich', baseRich], ['bare', baseBare]]) {
    const probe = project(kind);
    attempt(enable, probe, v2);
    const n = attempt(disable, probe, v2).trace.length;
    let ok = 0;
    const failures = [];
    const leftovers = [];
    for (let k = 1; k <= n; k += 1) {
      const P = project(kind);
      attempt(enable, P, v2);
      attempt(disable, P, v2, { crashAt: k });
      const { r } = rerun(disable, P, v2);
      const d = diff(base, snapshot(P));
      const ended = r.outcome === 'disabled' || r.outcome === 'not-enabled';
      if (ended && !d.length) ok += 1;
      else if (ended && d.every((e) => EMPTY_LEFTOVERS.includes(e))) leftovers.push(`k${k}: ${d.join(' ')} (reported: ${r.report.join('; ') || 'nothing'})`);
      else failures.push(`k${k}: ${r.outcome} ${d.slice(0, 2).join(',')}`);
    }
    record('4/5', `Disable (${kind}) stopped before each of its ${n} write actions, then rerun`, 'every case restores the pre-Enable tree exactly, except the documented empty leftovers, which Disable reports',
      `${ok}/${n} exact${leftovers.length ? `; ${leftovers.length} left only empty dirs: ${leftovers.join(' | ')}` : ''}${failures.length ? `; failed ${failures.slice(0, 3).join(' | ')}` : ''}`,
      ok + leftovers.length === n && !failures.length);
  }

  // 8. Locally modified, deleted or conflicting files.
  {
    const cases = [
      ['changed bytes', 'scripts/lib/render.mjs', (f) => fs.appendFileSync(f, '// local change\n')],
      ['line endings only (LF → CRLF)', 'reference/routing.md', (f) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'))],
      ['final newline removed', 'SKILL.md', (f) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n$/, ''))],
    ];
    for (const [label, rel, change] of cases) {
      const P = project('rich');
      attempt(enable, P, v1);
      change(at(P, `${SKILL_REL}/${rel}`));
      const changedHash = sha(fs.readFileSync(at(P, `${SKILL_REL}/${rel}`)));
      const s0 = snapshot(P);
      const e = attempt(enable, P, v2);
      const u = attempt(update, P, v2);
      const untouched = !diff(s0, snapshot(P)).length;
      record('8', `Modified file (${label}: ${rel}) at Enable and Update`, 'conflict, 0 writes, file preserved byte-for-byte',
        `Enable ${short(e)}; Update ${short(u)}; tree ${untouched ? 'unchanged' : 'CHANGED'}`,
        e.outcome === 'conflict' && u.outcome === 'conflict' && !e.trace.length && !u.trace.length && untouched);
      const d = attempt(disable, P, v1);
      const keptHash = exists(at(P, `${SKILL_REL}/${rel}`)) ? sha(fs.readFileSync(at(P, `${SKILL_REL}/${rel}`))) : null;
      const st = JSON.parse(fs.readFileSync(at(P, STATE_REL), 'utf8'));
      const left = [];
      const walk = (dd, prefix) => { for (const en of fs.readdirSync(dd, { withFileTypes: true })) { if (en.isDirectory()) walk(p(dd, en.name), `${prefix}${en.name}/`); else left.push(prefix + en.name); } };
      walk(at(P, SKILL_REL), '');
      const d2 = attempt(disable, P, v1);
      fs.rmSync(at(P, `${SKILL_REL}/${rel}`)); // the user resolves the conflict by removing the file
      const d3 = attempt(disable, P, v1);
      const restored = !diff(baseRich, snapshot(P)).length;
      record('8', `Disable with that modified file (${rel})`, 'keeps only that file and a state recording only it; rerun 0 writes; after the user removes it, Disable restores the tree exactly',
        `${short(d)}; kept ${left.join(',')} (hash ${keptHash === changedHash ? 'unchanged' : 'CHANGED'}); state records ${Object.keys(st.skill.files).join(',')}; rerun ${short(d2)}; final ${short(d3)}, tree ${restored ? 'exact' : 'DIFFERS'}`,
        d.outcome === 'conflict' && keptHash === changedHash && left.join() === rel && Object.keys(st.skill.files).join() === rel && !d2.trace.length && d3.outcome === 'disabled' && restored);
    }
    // Deleted files: Update refuses, Enable repairs.
    for (const rel of ['reference/protocol.md', 'SKILL.md']) {
      const P = project('rich');
      attempt(enable, P, v2);
      fs.rmSync(at(P, `${SKILL_REL}/${rel}`));
      const s0 = snapshot(P);
      const u = attempt(update, P, v2);
      const same = !diff(s0, snapshot(P)).length;
      const e = attempt(enable, P, v2);
      const problems = installProblems(P, L2);
      record('8', `Deleted file (${rel}): Update, then Enable`, 'Update: conflict, 0 writes; Enable repairs exactly that file',
        `Update ${short(u)}, tree ${same ? 'unchanged' : 'CHANGED'}; Enable ${short(e)} [${e.trace.filter((t) => t.startsWith('rename')).join(', ')}]; install ${problems.length ? problems.join(',') : 'exact'}`,
        u.outcome === 'conflict' && !u.trace.length && same && e.outcome === 'enabled' && !problems.length);
    }
    // New library file whose path is taken; dropped library file that was customized.
    {
      const P = project('rich');
      attempt(enable, P, v1);
      write(at(P, `${SKILL_REL}/reference/census.md`), '# my own census notes\n');
      const s0 = snapshot(P);
      const u = attempt(update, P, v2);
      record('8', 'Update v1 → v2 where the new file census.md already exists (user file)', 'conflict, 0 writes', `${short(u)}; tree ${diff(s0, snapshot(P)).length ? 'CHANGED' : 'unchanged'}`,
        u.outcome === 'conflict' && !u.trace.length && !diff(s0, snapshot(P)).length);
    }
    {
      const P = project('rich');
      attempt(enable, P, v1);
      fs.appendFileSync(at(P, `${SKILL_REL}/reference/legacy.md`), 'my notes\n');
      const s0 = snapshot(P);
      const u = attempt(update, P, v2);
      record('8', 'Update v1 → v2 where the dropped file legacy.md was customized', 'conflict, 0 writes', `${short(u)}; tree ${diff(s0, snapshot(P)).length ? 'CHANGED' : 'unchanged'}`,
        u.outcome === 'conflict' && !u.trace.length && !diff(s0, snapshot(P)).length);
    }
    {
      const P = project('rich');
      attempt(enable, P, v1);
      write(at(P, `${SKILL_REL}/reference/notes.md`), '# my notes\n');
      const s0 = snapshot(P);
      const e = attempt(enable, P, v1);
      const sameE = !diff(s0, snapshot(P)).length;
      const u = attempt(update, P, v2);
      const kept = exists(at(P, `${SKILL_REL}/reference/notes.md`));
      const d = attempt(disable, P, v2);
      const after = diff(baseRich, snapshot(P));
      record('8', 'Unrecorded user file in the skill folder', 'Enable: conflict, 0 writes; Update: proceeds, file left and reported; Disable: removes the rest, leaves the file and its folders',
        `Enable ${short(e)} (tree ${sameE ? 'unchanged' : 'CHANGED'}); Update ${short(u)}, reported "${u.report.join('; ')}", kept ${kept}; Disable ${short(d)}; left ${after.join(' ')}`,
        e.outcome === 'conflict' && !e.trace.length && sameE && u.outcome === 'updated' && kept && d.outcome === 'disabled'
          && JSON.stringify(after) === JSON.stringify([`+.claude/skills/nth-review`, `+${SKILL_REL}/reference`, `+${SKILL_REL}/reference/notes.md`]));
    }
  }

  // 9. Git-tracked targets.
  {
    const P = project('rich');
    write(at(P, `${SKILL_REL}/SKILL.md`), 'team copy\n');
    git(P, ['add', '--', `${SKILL_REL}/SKILL.md`]);
    git(P, ['commit', '-q', '-m', 'team copy of the skill']);
    fs.rmSync(at(P, SKILL_REL), { recursive: true }); // tracked, but absent from the working tree
    const s0 = snapshot(P);
    const e = attempt(enable, P, v2);
    record('9', 'A tracked skill file (deleted from the working tree, still in the index)', 'conflict (tracked), 0 writes, Git untouched',
      `${short(e)}; tree incl. .git ${diff(s0, snapshot(P)).length ? 'CHANGED' : 'unchanged'}`, e.outcome === 'conflict' && e.items.some((i) => i.startsWith('tracked')) && !e.trace.length && !diff(s0, snapshot(P)).length);
  }
  {
    const P = project('rich');
    write(at(P, STATE_REL), '{}\n');
    git(P, ['add', '--', STATE_REL]);
    git(P, ['commit', '-q', '-m', 'tracked state']);
    fs.rmSync(at(P, STATE_REL));
    const s0 = snapshot(P);
    const e = attempt(enable, P, v2);
    record('9', 'A tracked state file path', 'conflict (tracked), 0 writes', short(e), e.outcome === 'conflict' && e.items.some((i) => i.startsWith('tracked')) && !e.trace.length && !diff(s0, snapshot(P)).length);
  }
  {
    const earlier = rows.filter((r) => r.status !== 'unverified');
    record('9', 'Tracked `.claude/settings.json` (rich fixture) does not block Enable; .git byte-identical through every operation',
      'Enable succeeds; every tree comparison includes .git (HEAD, refs, objects, index bytes and index mtime, info/exclude)',
      `${earlier.filter((r) => r.status === 'pass').length}/${earlier.length} earlier rows passed with .git inside their comparisons`, earlier.every((r) => r.status === 'pass'));
  }

  // 10. Unowned skill directories and case collisions.
  {
    const P = project('rich');
    write(at(P, `${SKILL_REL}/SKILL.md`), '---\nname: nth-review\ndescription: someone else\n---\nbody\n');
    const s0 = snapshot(P);
    const e = attempt(enable, P, v2);
    const u = attempt(update, P, v2);
    const d = attempt(disable, P, v2);
    record('10', 'An unowned nth-review folder (no state file)', 'Enable: conflict (lost state); Update: not enabled; Disable: reports it user-owned; 0 writes each',
      `Enable ${short(e)}; Update ${short(u)}; Disable ${short(d)} "${d.report.join('')}"; tree ${diff(s0, snapshot(P)).length ? 'CHANGED' : 'unchanged'}`,
      e.outcome === 'conflict' && u.outcome === 'stopped' && d.outcome === 'not-enabled' && ![e, u, d].some((r) => r.trace.length) && !diff(s0, snapshot(P)).length);
  }
  for (const [label, kind, make] of [
    ['`.claude/skills/NTH-Review/` (case-only variant)', 'rich', (P) => write(at(P, '.claude/skills/NTH-Review/SKILL.md'), 'x\n')],
    ['`.claude/Skills/` (case-only variant of a parent)', 'bare', (P) => write(at(P, '.claude/Skills/x/SKILL.md'), 'x\n')],
  ]) {
    const P = project(kind);
    make(P);
    const s0 = snapshot(P);
    const e = attempt(enable, P, v2);
    record('10', `Case collision: ${label}`, 'conflict, 0 writes', `${short(e)}`, e.outcome === 'conflict' && e.items.some((i) => i.includes('case')) && !e.trace.length && !diff(s0, snapshot(P)).length);
  }
  {
    const P = project('rich');
    attempt(enable, P, v1);
    fs.renameSync(at(P, `${SKILL_REL}/reference`), at(P, `${SKILL_REL}/Reference`));
    const s0 = snapshot(P);
    const u = attempt(update, P, v2);
    const d = attempt(disable, P, v2);
    record('10', 'Installed folder renamed by case only (`reference` → `Reference`)', 'Update and Disable: conflict, 0 writes',
      `Update ${short(u)}; Disable ${short(d)}`, u.outcome === 'conflict' && d.outcome === 'conflict' && !u.trace.length && !d.trace.length && !diff(s0, snapshot(P)).length);
  }
  record('10', 'Unicode-normalization collisions', 'n/a: every target name is ASCII, which has a single normalization form; the check runs but cannot trigger on these names', 'not applicable', true, 'unverified');

  // 11. Symlinks and junctions.
  for (const [label, rel, setup] of [
    ['junction at `.claude/skills/nth-review`', SKILL_REL, 'fresh'],
    ['junction at `.claude/nth-dev-kit-hooks`', '.claude/nth-dev-kit-hooks', 'fresh'],
    ['junction at `.claude`', '.claude', 'fresh'],
    ['junction at installed `scripts/lib`', `${SKILL_REL}/scripts/lib`, 'installed'],
  ]) {
    const P = project('rich');
    if (setup === 'installed') attempt(enable, P, v2);
    const elsewhere = p(ROOT, 'elsewhere', String(projectCount));
    if (exists(at(P, rel))) fs.cpSync(at(P, rel), elsewhere, { recursive: true }); else fs.mkdirSync(elsewhere, { recursive: true });
    if (exists(at(P, rel))) fs.rmSync(at(P, rel), { recursive: true });
    fs.mkdirSync(path.dirname(at(P, rel)), { recursive: true });
    fs.symlinkSync(elsewhere, at(P, rel), 'junction');
    const s0 = snapshot(P);
    const sE = snapshot(elsewhere);
    const results = [attempt(enable, P, v2), attempt(update, P, v2), attempt(disable, P, v2)];
    const okAll = results.every((r) => (r.outcome === 'conflict' || (r.outcome === 'stopped' && setup === 'fresh')) && !r.trace.length);
    record('11', `Windows ${label}`, 'Enable, Update and Disable refuse it, 0 writes; the junction target untouched',
      results.map((r, i) => `${['Enable', 'Update', 'Disable'][i]} ${short(r)}`).join('; '),
      okAll && !diff(s0, snapshot(P)).length && !diff(sE, snapshot(elsewhere)).length);
  }
  for (const [label, type] of [['directory symbolic link at `.claude/skills`', 'dir'], ['file symbolic link for an installed file', 'file']]) {
    const P = project('rich');
    try {
      fs.symlinkSync(type === 'dir' ? p(ROOT, 'baselines') : at(P, 'README.md'), at(P, type === 'dir' ? '.claude/skills-link' : 'link-probe'), type);
      record('11', `POSIX-style ${label}`, 'refused', 'symbolic links can be created here; not exercised by this run', false, 'unverified');
    } catch (error) {
      record('11', `${label}`, 'refused like a junction', `cannot create on this machine (${error.code}: no Developer Mode or privilege); unverified`, true, 'unverified');
    }
  }

  // 12. Temporary files, receipts and state files.
  for (const [label, rel] of [
    ['`.SKILL.md.nth-tmp` in the skill folder', `${SKILL_REL}/.SKILL.md.nth-tmp`],
    ['`.render.mjs.nth-tmp` in `scripts/lib/`', `${SKILL_REL}/scripts/lib/.render.mjs.nth-tmp`],
    ['`.review.state.json.nth-tmp` in the state folder', '.claude/nth-dev-kit-hooks/.review.state.json.nth-tmp'],
  ]) {
    const P = project('rich');
    attempt(enable, P, v1);
    write(at(P, rel), 'partial');
    const s0 = snapshot(P);
    const results = [attempt(enable, P, v2), attempt(update, P, v2), attempt(disable, P, v2)];
    const refused = results.every((r) => r.outcome === 'conflict' && !r.trace.length) && !diff(s0, snapshot(P)).length;
    fs.rmSync(at(P, rel));
    const u = attempt(update, P, v2);
    record('12', `Leftover ${label}`, 'Enable, Update and Disable: conflict, 0 writes; after the user removes it, Update proceeds',
      `${results.map((r, i) => `${['Enable', 'Update', 'Disable'][i]} ${r.outcome}/${r.trace.length}`).join(', ')}; after removal Update ${short(u)}`, refused && u.outcome === 'updated');
  }
  const registry = (config) => p(config, 'plugins', 'installed_plugins.json');
  const editJson = (f, change) => { const doc = JSON.parse(fs.readFileSync(f, 'utf8')); change(doc); fs.writeFileSync(f, JSON.stringify(doc)); };
  const manifestOf = (dir) => p(dir, 'runtime-manifest.json');
  const packageCases = [
    ['the package is not installed (no plugin registry)', (dir, config) => fs.rmSync(registry(config))],
    ['invalid plugin registry JSON', (dir, config) => fs.writeFileSync(registry(config), '{"version": 2,')],
    ['the registry has no nth-review entry', (dir, config) => editJson(registry(config), (r) => { delete r.plugins['nth-review@nth-review']; })],
    ['the registry points at the source checkout, outside the plugin cache', (dir, config) => editJson(registry(config), (r) => { r.plugins['nth-review@nth-review'][0].installPath = KIT; })],
    ['the package folder is missing', (dir) => fs.rmSync(dir, { recursive: true })],
    ['missing package manifest', (dir) => fs.rmSync(manifestOf(dir))],
    ['invalid package manifest JSON', (dir) => fs.writeFileSync(manifestOf(dir), '{"schemaVersion": 1,')],
    ['a manifest for another package', (dir) => editJson(manifestOf(dir), (m) => { m.package = 'other'; })],
    ['missing package file', (dir) => fs.rmSync(at(dir, 'reference/census.md'))],
    ['package file changed after the manifest (digest mismatch)', (dir) => fs.appendFileSync(at(dir, 'scripts/nthr.mjs'), '// tampered\n')],
    ['a runtime file missing from both the manifest and the package', (dir) => {
      editJson(manifestOf(dir), (m) => { delete m.files['reference/census.md']; }); fs.rmSync(at(dir, 'reference/census.md'));
    }],
    ['a runtime file present but with no manifest entry', (dir) => editJson(manifestOf(dir), (m) => { delete m.files['scripts/lib/render.mjs']; })],
    ['no manifest entry for INSTALL.md', (dir) => editJson(manifestOf(dir), (m) => { delete m.files['INSTALL.md']; })],
    ['a duplicate manifest key', (dir) => {
      const t = fs.readFileSync(manifestOf(dir), 'utf8');
      fs.writeFileSync(manifestOf(dir), t.replace('"files": {', '"files": {\n    "SKILL.md": "0000000000000000000000000000000000000000000000000000000000000000",'));
    }],
  ];
  let packageN = 0;
  for (const [label, mutate] of packageCases) {
    packageN += 1;
    const config = cloneConfig(v2, `config-package-${packageN}`, mutate);
    const P = project('rich');
    const s0 = snapshot(P);
    const e = attempt(enable, P, config);
    const P2 = project('rich');
    attempt(enable, P2, v1);
    const s2 = snapshot(P2);
    const u = attempt(update, P2, config);
    record('12', `Package: ${label}`, 'Enable and Update stop before writing, with install-or-repair guidance; no fallback to the source checkout',
      `Enable ${short(e)}; Update ${short(u)}`, e.outcome === 'stopped' && u.outcome === 'stopped' && !e.trace.length && !u.trace.length
        && !diff(s0, snapshot(P)).length && !diff(s2, snapshot(P2)).length && e.items.some((i) => /install or repair the nth-review plugin/.test(i)));
  }
  {
    // A package file its own INSTALL.md does not list is never installed.
    const config = cloneConfig(v2, 'config-package-extra', (dir) => { write(at(dir, 'reference/extra.md'), '# extra\n'); writeManifest(dir); });
    const P = project('rich');
    const e = attempt(enable, P, config);
    const problems = installProblems(P, loadPackage(config));
    record('12', 'Package: an unlisted extra file in the package (in its manifest)', 'Enable installs exactly the listed runtime files; the extra file is not installed',
      `${short(e)}; extra installed: ${exists(at(P, `${SKILL_REL}/reference/extra.md`))}; install ${problems.length ? problems.join(',') : 'exact'}`,
      e.outcome === 'enabled' && !exists(at(P, `${SKILL_REL}/reference/extra.md`)) && !problems.length);
  }
  {
    // A Git failure other than "not a git repository" must not skip the tracked check.
    const P = project('rich');
    fs.appendFileSync(at(P, '.git/config'), '\n[broken\n');
    const s0 = snapshot(P);
    const e = attempt(enable, P, v2);
    record('9', 'Git cannot read the repository (a corrupt `.git/config`)', 'conflict: the tracked check could not run; 0 writes (never treated as "no work tree")',
      short(e), e.outcome === 'conflict' && e.items.some((i) => /tracked check could not run/.test(i)) && !e.trace.length && !diff(s0, snapshot(P)).length);
  }
  const stateCases = [
    ['invalid JSON', (t) => `${t.slice(0, 20)}`],
    ['unknown schemaVersion', (t) => t.replace('"schemaVersion": 1', '"schemaVersion": 2')],
    ['a key outside the runtime paths', (t) => t.replace('"SKILL.md":', '"../escape.md":')],
    ['a duplicate key', (t) => t.replace('"files": {', '"files": {\n      "SKILL.md": "0000000000000000000000000000000000000000000000000000000000000000",')],
    ['a bad hash', (t) => t.replace(/"SKILL\.md": "[0-9a-f]{64}"/, '"SKILL.md": "XYZ"')],
    ['a bad createdDirs entry', (t) => t.replace('"createdDirs": [', '"createdDirs": [\n    "src",')],
    ['a wrong skill path', (t) => t.replace('"path": "skills/nth-review"', '"path": "skills/other"')],
    ['a bad pending key', (t) => t.replace('"files": {', '"pending": { "scripts/lib/Bad.mjs": "0000000000000000000000000000000000000000000000000000000000000000" },\n    "files": {')],
  ];
  for (const [label, mutate] of stateCases) {
    const P = project('rich');
    attempt(enable, P, v2);
    const f = at(P, STATE_REL);
    const text = fs.readFileSync(f, 'utf8');
    const mutated = mutate(text);
    fs.writeFileSync(f, mutated);
    const s0 = snapshot(P);
    const results = [attempt(enable, P, v2), attempt(update, P, v2), attempt(disable, P, v2)];
    record('12', `State file: ${label}`, 'Enable, Update and Disable: conflict, 0 writes',
      results.map((r, i) => `${['Enable', 'Update', 'Disable'][i]} ${r.outcome}/${r.trace.length}`).join(', '),
      mutated !== text && results.every((r) => r.outcome === 'conflict' && !r.trace.length) && !diff(s0, snapshot(P)).length);
  }
  for (const [label, where] of [['<P> is the config directory', 'config'], ['<P> inside the installed package', 'package'], ['<P> is the home directory', 'home'], ['<P> is the source checkout', 'source']]) {
    const config = cloneConfig(v2, `config-overlap-${where}`, () => {});
    const P = where === 'config' ? config : where === 'package' ? p(packageDir(config), 'reference') : where === 'source' ? KIT : project('bare');
    const s0 = snapshot(P);
    const e = attempt(enable, P, config, { home: where === 'home' ? P : undefined });
    record('12', `Refused project location: ${label}`, 'conflict, 0 writes', short(e), e.outcome === 'conflict' && !e.trace.length && !diff(s0, snapshot(P)).length);
  }

  // 13. A pre-existing personal nth-review skill.
  {
    const config = cloneConfig(v2, 'config-personal', () => {});
    write(p(config, 'skills', 'nth-review', 'SKILL.md'), '---\nname: nth-review\ndescription: personal copy\n---\npersonal\n');
    const sPersonal = snapshot(p(config, 'skills'));
    const P = project('rich');
    const e = attempt(enable, P, config);
    const u = attempt(update, P, config);
    const d = attempt(disable, P, config);
    record('13', 'A personal `<config>/skills/nth-review/`', 'Enable and Update report the shadowing and proceed; the personal copy stays byte-identical through Enable, Update and Disable',
      `Enable ${short(e)} "${e.report.filter((x) => x.includes('shadows')).join('')}"; Update ${short(u)}, ${u.report.some((x) => x.includes('shadows')) ? 'reported' : 'NOT reported'}; Disable ${short(d)}; personal copy ${diff(sPersonal, snapshot(p(config, 'skills'))).length ? 'CHANGED' : 'unchanged'}`,
      e.outcome === 'enabled' && e.report.some((x) => x.includes('shadows')) && u.report.some((x) => x.includes('shadows')) && d.outcome === 'disabled' && !diff(sPersonal, snapshot(p(config, 'skills'))).length);
  }
  // 15. The package alone activates nothing; Enable in one project leaves another untouched.
  {
    const P = project('rich');
    const s0 = snapshot(P);
    const config = makeConfig('config-inactive', 'v2');
    const afterInstall = diff(s0, snapshot(P));
    const other = project('bare');
    const sOther = snapshot(other);
    const e = attempt(enable, P, config);
    record('15', 'Package installed, then Enable in one project only', 'installing the package changes no project; Enable changes only its own project; the other project stays byte-identical, with no state file',
      `after install ${afterInstall.length} paths changed in the project; Enable ${short(e)}; other project ${diff(sOther, snapshot(other)).length ? 'CHANGED' : 'unchanged'}, state file ${exists(at(other, STATE_REL)) ? 'present' : 'absent'}`,
      !afterInstall.length && e.outcome === 'enabled' && !diff(sOther, snapshot(other)).length && !exists(at(other, STATE_REL)));
  }
  // 16. A project enabled by nth-dev-kit's earlier runbook, from its library copy.
  {
    const config = makeConfig('config-legacy', 'v2');
    const lib = p(config, 'nth-dev-kit');
    const module = p(lib, 'agents', 'claude', 'integrations', 'review');
    for (const entry of RUNTIME_ENTRIES) fs.cpSync(p(KIT, entry), p(module, entry), { recursive: true });
    fs.copyFileSync(p(KIT, 'INSTALL.md'), p(lib, 'agents', 'claude', 'integrations', 'review.md'));
    writeReceipt(lib);
    // The legacy Enable wrote the receipt's LF bytes and its digest over the 27 receipt entries.
    const receipt = JSON.parse(fs.readFileSync(p(lib, '.nth-dev-kit-library.json'), 'utf8')).files;
    const MODULE = 'agents/claude/integrations/review/';
    const runtime = Object.keys(receipt).filter((k) => k.startsWith(MODULE)).map((k) => k.slice(MODULE.length)).sort();
    const legacyDigest = sha(runtime.map((rel) => `${rel} ${receipt[MODULE + rel]}`).join('\n'));
    const P = project('rich');
    for (const rel of runtime) write(at(P, `${SKILL_REL}/${rel}`), fs.readFileSync(p(module, ...rel.split('/'))).toString('utf8').replace(/\r\n/g, '\n'));
    write(at(P, STATE_REL), `${JSON.stringify({ schemaVersion: 1, library: legacyDigest, skill: { path: 'skills/nth-review', files: Object.fromEntries(runtime.map((rel) => [rel, receipt[MODULE + rel]])) }, createdDirs: ['.claude/nth-dev-kit-hooks'] }, null, 2)}\n`);
    const sLib = snapshot(lib);
    const s0 = snapshot(P);
    const u = attempt(update, P, config);
    const unchangedProject = !diff(s0, snapshot(P)).length;
    const d = attempt(disable, P, config);
    const left = outside(diff(s0, snapshot(P)));
    record('16', 'A project enabled by nth-dev-kit\'s earlier runbook (legacy library copy present)',
      'its state is read as is: the legacy library digest equals the package digest, Update changes nothing and reports the legacy copy, Disable removes the copy; the legacy library stays byte-identical; .nth-review/ untouched',
      `legacy digest ${legacyDigest === L2.digest ? 'equals' : 'DIFFERS FROM'} the package digest; Update ${short(u)}${u.report.some((x) => /legacy nth-dev-kit library/.test(x)) ? ', legacy copy reported' : ', legacy copy NOT reported'}; Disable ${short(d)}; legacy library ${diff(sLib, snapshot(lib)).length ? 'CHANGED' : 'unchanged'}`,
      legacyDigest === L2.digest && u.outcome === 'unchanged' && unchangedProject && u.report.some((x) => /legacy nth-dev-kit library/.test(x))
        && d.outcome === 'disabled' && !left.length && !diff(sLib, snapshot(lib)).length && exists(at(P, '.nth-review/experiments/demo/decisions.json')));
  }
  // 17. A custom configuration directory (CLAUDE_CONFIG_DIR) with a space in its path.
  {
    const config = makeConfig('custom config dir', 'v2');
    const P = project('bare');
    const e = attempt(enable, P, config);
    const problems = installProblems(P, loadPackage(config));
    const d = attempt(disable, P, config);
    record('17', 'A custom configuration directory (a path with a space)', 'Enable installs from that configuration\'s package; Disable removes it',
      `Enable ${short(e)}; install ${problems.length ? problems.join(',') : 'exact'}; Disable ${short(d)}`, e.outcome === 'enabled' && !problems.length && d.outcome === 'disabled');
  }
  record('14', 'Unrelated files and review data intact', 'no path outside the integration paths changes in any scenario',
    'checked in every row above against full-tree snapshots (application source, CLAUDE.md, .claude/settings.json, other skills and agents, .nth-review/, .git)', true);
}

// For every write point of `op`: crash there, check the invariants, then (a) the
// user's documented recovery (remove a temporary file if one is named, rerun the
// same operation) reaches the clean result, and (b) Disable after the crash
// restores the pre-Enable tree.
function crashLoop(n, label, kind, preVersion, op, config, libs, baseline) {
  const prepare = () => {
    const P = project(kind);
    if (preVersion) attempt(enable, P, preVersion);
    return P;
  };
  const total = attempt(op, prepare(), config).trace.length;
  const finalLib = libs[libs.length - 1];
  const tally = { invariant: 0, rerun: 0, rerunDisable: 0, rerunLeftovers: 0, disable: 0, temps: 0, leftovers: [] };
  const failures = [];
  for (let k = 1; k <= total; k += 1) {
    for (const path2 of ['rerun', 'disable']) {
      const P = prepare();
      const r = attempt(op, P, config, { crashAt: k });
      if (r.outcome !== 'crash') { failures.push(`k${k}: no crash (${r.outcome})`); continue; }
      const inv = crashInvariants(P, libs);
      if (path2 === 'rerun') {
        if (!inv.problems.length) tally.invariant += 1; else failures.push(`k${k} ${r.at}: ${inv.problems.join(',')}`);
        if (inv.tmp) tally.temps += 1;
        const { r: again } = rerun(op, P, config);
        const problems = ['enabled', 'updated', 'unchanged'].includes(again.outcome) ? installProblems(P, finalLib) : [`${again.outcome} ${again.items?.join(',') ?? ''}`];
        const out = outside(diff(baseline, snapshot(P)));
        if (!problems.length && !out.length) tally.rerun += 1; else failures.push(`k${k} rerun: ${problems.join(',')} ${out.join(',')}`);
        // Then a later Disable: exact, or only the documented empty leftovers.
        const d = attempt(disable, P, config);
        const left = diff(baseline, snapshot(P));
        if (d.outcome === 'disabled' && !left.length) tally.rerunDisable += 1;
        else if (d.outcome === 'disabled' && left.every((e) => EMPTY_LEFTOVERS.includes(e))) tally.rerunLeftovers += 1;
        else failures.push(`k${k} rerun then disable: ${d.outcome} ${left.slice(0, 3).join(',')}`);
      } else {
        const { r: d } = rerun(disable, P, config);
        const left = diff(baseline, snapshot(P));
        const ended = d.outcome === 'disabled' || d.outcome === 'not-enabled';
        if (ended && !left.length) tally.disable += 1;
        else if (ended && left.every((e) => EMPTY_LEFTOVERS.includes(e))) tally.leftovers.push(`k${k} before "${r.at.replace(/^(\S+) /, '$1 ')}": ${left.join(' ')}`);
        else failures.push(`k${k} disable: ${d.outcome} ${left.slice(0, 3).join(',')}`);
      }
    }
  }
  const leftoverNote = tally.leftovers.length ? ` (+${tally.leftovers.length} that left only empty unrecorded dirs: ${tally.leftovers.join(' | ')})` : '';
  record(n, `${label}: stopped before each of its ${total} write actions`,
    'at every point each file is provable and SKILL.md never sits beside a mixed folder; rerunning the same operation (after removing a named temporary file) reaches the clean result; Disable, directly or after that rerun, restores the pre-Enable tree, except the documented empty leftovers',
    `invariants ${tally.invariant}/${total}; rerun ${tally.rerun}/${total} (${tally.temps} needed a temporary file removed), then Disable exact ${tally.rerunDisable}/${total}${tally.rerunLeftovers ? ` (+${tally.rerunLeftovers} empty leftovers)` : ''}; Disable directly: exact ${tally.disable}/${total}${leftoverNote}${failures.length ? `; FAILURES ${failures.slice(0, 4).join(' | ')}` : ''}`,
    tally.invariant === total && tally.rerun === total && tally.rerunDisable + tally.rerunLeftovers === total && tally.disable + tally.leftovers.length === total && !failures.length);
}

try {
  main();
} catch (error) {
  record('-', 'rehearsal harness', 'completes', String(error.stack ?? error), false);
} finally {
  const width = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  for (const r of rows) console.log(`${width(r.status.toUpperCase(), 10)} ${width(r.n, 5)} ${r.scenario}\n           observed: ${r.observed}`);
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\n${rows.length} rows: ${count('pass')} pass, ${count('fail')} fail, ${count('unverified')} unverified. Root: ${ROOT}${keep ? ' (kept)' : ''}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ platform: `${process.platform} ${os.release()}`, node: process.version, rows }, null, 2));
  if (!keep) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exitCode = count('fail') ? 1 : 0;
}
