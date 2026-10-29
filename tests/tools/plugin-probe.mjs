#!/usr/bin/env node
// Package probe: the real `claude plugin` commands, offline, in a throwaway
// configuration, against a disposable copy of this repository, with the
// Enable/Update/Disable transcription (tests/m4/operator.mjs) reading what the
// plugin manager really installed. At each stage a headless session reports
// its skill and agent inventory. No model call: the configuration has no login, the
// environment carries no credentials, the API address is unreachable, every
// session must stop at "Not logged in", and any reported cost fails the probe.
// Delegation sessions talk only to a local stand-in for the Messages API
// (127.0.0.1, a dummy key): it shows which agent the Agent tool resolves.
// Nothing outside the temporary root is written.
//
//   node tests/tools/plugin-probe.mjs [--keep] [--json <file>] [--general-agent <file>]
//
// --general-agent: the user-level `reviewer` agent of the coexistence rows
// (default: a synthetic one), for example another kit's own reviewer. Only read.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stop, disable, enable, loadPackage, makeIO, update } from '../m4/operator.mjs';
import { manifestText } from './runtime-manifest.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const generalAgent = args.includes('--general-agent') ? path.resolve(args[args.indexOf('--general-agent') + 1]) : null;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-plugin-'));
const SRC = path.join(ROOT, 'source', 'nth-review');
const CONFIG = path.join(ROOT, 'config dir');
const CONFIG2 = path.join(ROOT, 'config two');
const ID = 'nth-review@nth-review';
const rows = [];
const sessions = [];
const delegations = [];
const record = (n, scenario, observed, ok) => rows.push({ n, scenario, observed, status: ok ? 'pass' : 'fail' });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// A clean environment: only what a process needs to start, never a credential
// or the calling session's variables; the throwaway configuration; no updates,
// no nonessential traffic; an API address nothing listens on.
const BASE = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'LOGNAME', 'SHELL', 'LANG'];
const envFor = (cfg, extra = {}) => ({
  ...Object.fromEntries(BASE.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
  CLAUDE_CONFIG_DIR: cfg, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ...extra,
});

const run = (cwd, a, cfg = CONFIG) => spawnSync('claude', a, { cwd, env: envFor(cfg), encoding: 'utf8', windowsHide: true, timeout: 120000 });
function claudeIn(cfg, cwd, ...a) {
  const r = run(cwd, ['plugin', ...a], cfg);
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
const claude = (cwd, ...a) => claudeIn(CONFIG, cwd, ...a);
const list = (cwd) => { const r = claude(cwd, 'list', '--json'); try { return JSON.parse(r.out); } catch { return null; } };
const entry = (cwd) => list(cwd)?.find((p) => p.id === ID) ?? null;
// What a headless session in `cwd` loads, from its init message: the
// nth-review skills, and every agent named reviewer (bundled or not).
function inventory(cwd, cfg = CONFIG) {
  const r = run(cwd, ['-p', 'probe', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '0.01'], cfg);
  const lines = (r.stdout ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = lines.find((x) => x.type === 'system' && x.subtype === 'init');
  const result = lines.find((x) => x.type === 'result');
  const s = { cwd: path.basename(cwd), text: String(result?.result ?? `exit ${r.status} ${(r.stderr ?? '').slice(0, 160)}`).trim(), cost: result?.total_cost_usd ?? null };
  sessions.push(s);
  const names = (list, re) => (list ?? []).map((k) => (typeof k === 'string' ? k : k?.name)).filter((k) => re.test(k ?? '')).sort();
  return init ? { skills: names(init.skills, /nth-review/), agents: names(init.agents, /(^|:)reviewer$/) } : null;
}
const show = (inv) => (inv === null ? 'NO INIT MESSAGE' : `skills [${inv.skills.join(', ')}] agents [${inv.agents.join(', ')}]`);
const same = (inv, skills, agents) => inv !== null && JSON.stringify(inv.skills) === JSON.stringify([...skills].sort()) && JSON.stringify(inv.agents) === JSON.stringify([...agents].sort());
const AGENT = ['nth-review:reviewer'];

// A local stand-in for the Messages API, so that a session delegates with no
// model. Its "lead" asks the Agent tool once for the subagent type its prompt
// names ("CALL <type>"); every other request gets a short text answer. The
// subagent's own request shows which agent definition Claude Code resolved:
// its instructions (in the system prompt), its model and its tools.
const textOf = (c) => (typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? (typeof x.content === 'string' ? x.content : JSON.stringify(x.content ?? ''))).join(' '));
function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { /* an empty request */ }
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"not_found_error","message":"probe mock"}}'); return; }
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":0}'); return; }
      const msgs = j.messages ?? [];
      const tools = (j.tools ?? []).map((t) => t.name);
      const agentTool = tools.find((t) => t === 'Agent' || t === 'Task');
      const call = /CALL ([A-Za-z0-9:_-]+)/.exec(JSON.stringify(msgs))?.[1];
      const called = msgs.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_use'));
      const results = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((x) => x.type === 'tool_result') : []));
      const role = agentTool && call ? (called ? 'lead-after' : 'lead-call') : tools.length ? 'subagent' : 'aux';
      requests.push({ role, call, model: j.model, tools, system: textOf(j.system), results: results.map((r) => ({ is_error: Boolean(r.is_error), text: textOf(r.content).slice(0, 300) })) });
      const blocks = role === 'lead-call'
        ? [{ type: 'tool_use', id: 'toolu_probe', name: agentTool, input: { subagent_type: call, description: 'R6 probe', prompt: 'Probe only. Reply exactly: No material findings.', model: 'sonnet' } }]
        : [{ type: 'text', text: role === 'subagent' ? 'No material findings.' : 'done' }];
      const stop = role === 'lead-call' ? 'tool_use' : 'end_turn';
      const message = { id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
      if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...message, content: blocks, stop_reason: stop })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message });
      blocks.forEach((b, index) => {
        ev('content_block_start', { index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { ...b, input: {} } });
        ev('content_block_delta', { index, delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        ev('content_block_stop', { index });
      });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 0 } });
      ev('message_stop', {});
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() })));
}
let mock = null;
// One headless session in `cwd` that delegates to `type` through the mock.
function delegate(cwd, cfg, type) {
  const from = mock.requests.length;
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', `CALL ${type}`, '--output-format', 'stream-json', '--verbose', '--max-turns', '4'], { cwd, env: envFor(cfg, { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'probe-local-mock-key' }), windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill(), 120000);
    p.on('close', () => {
      clearTimeout(timer);
      const result = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.type === 'result');
      const mine = mock.requests.slice(from);
      const sub = mine.find((r) => r.role === 'subagent') ?? null;
      const launch = mine.flatMap((r) => r.results)[0] ?? null;
      const d = { cwd: path.basename(cwd), type, requests: mine.length, cost: result?.total_cost_usd ?? null, launch, sub };
      delegations.push(d);
      resolve(d);
    });
  });
}
// The bundled agent: its first instruction line, and its tools.
const BUNDLED = { line: 'Independently review completed code changes.', tools: ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'] };
const isBundled = (d) => Boolean(d.sub) && d.sub.system.includes(BUNDLED.line) && /sonnet/.test(d.sub.model ?? '') && d.sub.tools.includes('Glob') && d.sub.tools.every((t) => BUNDLED.tools.includes(t));
const notFound = (d) => Boolean(d.launch?.is_error) && /not found/i.test(d.launch.text) && !d.sub;
const showD = (d) => (d.sub ? `launched: model ${d.sub.model}, tools [${d.sub.tools.join(', ')}]${d.sub.system.includes(BUNDLED.line) ? ', bundled instructions' : ''}` : `refused: ${(d.launch?.text ?? 'no answer').slice(0, 90)}`);
function git(cwd, a) { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); }
function project(name) {
  const dir = path.join(ROOT, 'projects', name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'probe'], ['user.email', 'p@test.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(dir, ['config', k, v]);
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(dir, '.nth-review', 'reviews', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nth-review', 'reviews', 'x', 'decisions.json'), '{"schema":"nth-review/decisions@1","entries":[]}\n');
  git(dir, ['add', 'src']);
  git(dir, ['commit', '-q', '-m', 'probe']);
  return dir;
}
function snapshot(root) {
  const out = new Map();
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { out.set(rel, 'dir'); walk(full, `${rel}/`); } else out.set(rel, sha(fs.readFileSync(full)));
    }
  };
  walk(root, '');
  return out;
}
const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
function op(fn, P, config = CONFIG) {
  try { return fn({ P, config, kit: REPO, io: makeIO() }); } catch (e) { return { result: e instanceof Stop ? `${e.kind}: ${e.items.join('; ')}` : `error: ${e.message}` }; }
}
// Where the plugin manager installed the package.
const e1Dir = () => { try { return JSON.parse(fs.readFileSync(path.join(CONFIG, 'plugins', 'installed_plugins.json'), 'utf8')).plugins[ID]?.[0]?.installPath ?? ''; } catch { return ''; } };
const enabledIn = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins?.[ID]; } catch { return undefined; } };
const projectSettings = (dirs) => dirs.flatMap((p) => ['settings.json', 'settings.local.json'].map((f) => path.join(p, '.claude', f))).filter((f) => fs.existsSync(f));
// Mtimes of the machine's real Claude Code configuration files, to show they are untouched.
const REAL = [path.join(os.homedir(), '.claude.json'), ...fs.readdirSync(os.homedir()).filter((n) => /^\.claude/i.test(n)).map((n) => path.join(os.homedir(), n, 'settings.json'))].filter((f) => fs.existsSync(f));
const realMtimes = () => REAL.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join('|');

async function main() {
  const version = { out: (run(ROOT, ['--version']).stdout ?? '').trim() };
  const before = realMtimes();
  fs.cpSync(REPO, SRC, { recursive: true, filter: (s) => !/[\\/]\.git$/.test(s) });
  fs.mkdirSync(CONFIG);
  const A = project('a');
  const B = project('b');
  const sA = snapshot(A);
  const sB = snapshot(B);

  const v = claude(A, 'validate', SRC);
  record('P1', 'validate the package', `exit ${v.code}: ${v.out.split('\n').filter((l) => /passed|error|fail/i.test(l)).join(' ')}`, v.code === 0);
  const m = claude(A, 'marketplace', 'add', SRC);
  const i = claude(A, 'install', ID);
  const e1 = entry(A);
  record('P2', 'install: disabled by default, user scope, in the custom configuration', `${i.out.split('\n').pop()} | ${JSON.stringify(e1 && { version: e1.version, scope: e1.scope, enabled: e1.enabled })}`,
    m.code === 0 && i.code === 0 && e1?.enabled === false && e1?.scope === 'user' && fs.existsSync(path.join(CONFIG, 'plugins', 'cache', 'nth-review')));
  const details = () => {
    const out = claude(A, 'details', ID).out;
    return { out, counts: Object.fromEntries([...out.matchAll(/^\s*(Skills|Agents|Hooks|MCP servers|LSP servers) \((\d+)\)/gm)].map(([, k, n]) => [k, Number(n)])) };
  };
  // `claude plugin details` counts no agent declared by path, enabled or not
  // (observed with Claude Code 2.1.312): its Agents count is recorded, not
  // checked. The session inventory (P7) is the check that the agent loads.
  const d = details();
  const plugin = JSON.parse(fs.readFileSync(path.join(SRC, '.claude-plugin', 'plugin.json'), 'utf8'));
  record('P3', 'the skill project and the declared agent reviewer; no hook or server', `${JSON.stringify(d.counts)}; declared agents ${JSON.stringify(plugin.agents)}`,
    Object.keys(d.counts).length === 5 && d.counts.Skills === 1 && /\bproject\b/.test(d.out) && d.counts.Hooks === 0 && d.counts['MCP servers'] === 0 && d.counts['LSP servers'] === 0
    && JSON.stringify(plugin.agents) === '["./plugin-agents/reviewer.md"]' && fs.existsSync(path.join(e1Dir(), 'plugin-agents', 'reviewer.md')));
  record('P4', 'install changed no project', `project A ${changed(sA, snapshot(A)).length} paths changed, project B ${changed(sB, snapshot(B)).length}`, !changed(sA, snapshot(A)).length && !changed(sB, snapshot(B)).length);
  const again = claude(A, 'install', ID);
  record('P5', 'a repeated install is safe', `exit ${again.code}: ${again.out.split('\n').pop()}; still ${entry(A)?.enabled === false ? 'disabled' : 'ENABLED'}`, entry(A)?.enabled === false && entry(A)?.version === e1?.version);
  const k0 = inventory(A);
  record('P6', 'installed but disabled: no nth-review skill, and no agent named reviewer at all', `A ${show(k0)}`, same(k0, [], []));

  const pe = claude(A, 'enable', ID);
  const kA1 = inventory(A);
  const kB1 = inventory(B);
  const d2 = details();
  record('P7', 'enable the plugin: /nth-review:project and the bundled nth-review:reviewer in every project, never the review skill; no other reviewer needed',
    `${pe.out.split('\n').pop()} | enabled ${entry(A)?.enabled}; details ${JSON.stringify(d2.counts)}; A ${show(kA1)}; B ${show(kB1)}; projects changed ${changed(sA, snapshot(A)).length + changed(sB, snapshot(B)).length}`,
    pe.code === 0 && entry(A)?.enabled === true && same(kA1, ['nth-review:project'], AGENT) && same(kB1, ['nth-review:project'], AGENT) && !changed(sA, snapshot(A)).length && !changed(sB, snapshot(B)).length);
  // Scenario A, nothing else installed: the Agent tool resolves the namespaced name, and only it.
  const dA = await delegate(A, CONFIG, 'nth-review:reviewer');
  const dA0 = await delegate(A, CONFIG, 'reviewer');
  record('P7a', 'the Agent tool resolves nth-review:reviewer to the bundled agent; a bare reviewer is not found', `nth-review:reviewer ${showD(dA)}; reviewer ${showD(dA0)}`,
    isBundled(dA) && notFound(dA0));

  const lib = (() => { try { return loadPackage(CONFIG); } catch (err) { return { error: err.items?.join('; ') ?? err.message }; } })();
  record('P8', 'Enable reads the package the plugin manager installed', lib.error ?? `${lib.sorted.length} runtime files, version ${lib.version}, inside the plugin cache`, !lib.error && lib.sorted.length === 27);
  const en = op(enable, A);
  const kA2 = inventory(A);
  const kB2 = inventory(B);
  record('P9', 'Enable in project A only: /nth-review there, nowhere else', `A: ${en.result} ${show(kA2)}; B: ${show(kB2)}, ${changed(sB, snapshot(B)).length} paths changed`,
    en.result === 'enabled' && same(kA2, ['nth-review', 'nth-review:project'], AGENT) && same(kB2, ['nth-review:project'], AGENT) && !changed(sB, snapshot(B)).length);
  // The installed copy resolves: its helper runs, and its skill delegates to the bundled agent.
  const helper = spawnSync(process.execPath, [path.join(A, '.claude', 'skills', 'nth-review', 'scripts', 'nthr.mjs'), 'version'], { cwd: A, encoding: 'utf8', windowsHide: true });
  const installedSkill = fs.readFileSync(path.join(A, '.claude', 'skills', 'nth-review', 'SKILL.md'), 'utf8');
  record('P9a', 'the project copy resolves: its helper runs at the package version, and its skill names nth-review:reviewer', `nthr version exit ${helper.status}: ${(helper.stdout ?? '').trim()}; plugin ${plugin.version}`,
    helper.status === 0 && (helper.stdout ?? '').includes(plugin.version) && installedSkill.includes('`nth-review:reviewer`'));
  // A user agent named reviewer coexists with the bundled one and replaces nothing.
  const own = path.join(CONFIG, 'agents', 'reviewer.md');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '---\nname: reviewer\ndescription: a user agent with the same name (probe)\ntools: Read\n---\nprobe\n');
  const kA2b = inventory(A);
  fs.rmSync(path.dirname(own), { recursive: true, force: true });
  record('P9b', 'a user agent named reviewer coexists with nth-review:reviewer', `A ${show(kA2b)}`, same(kA2b, ['nth-review', 'nth-review:project'], ['nth-review:reviewer', 'reviewer']));

  // A new release: one runtime file changes and the version moves.
  const pj = path.join(SRC, '.claude-plugin', 'plugin.json');
  const original = fs.readFileSync(pj, 'utf8');
  const probe2 = `${plugin.version}-probe2`;
  fs.writeFileSync(pj, original.replace(/"version": "[^"]+"/, `"version": "${probe2}"`));
  fs.appendFileSync(path.join(SRC, 'reference', 'routing.md'), '\n<!-- probe release 2 -->\n');
  fs.writeFileSync(path.join(SRC, 'runtime-manifest.json'), manifestText(SRC));
  const up = claude(A, 'update', ID);
  const e2 = entry(A);
  const upA = op(update, A);
  const routing = fs.readFileSync(path.join(A, '.claude', 'skills', 'nth-review', 'reference', 'routing.md'), 'utf8');
  record('P10', 'an independent package update, then Update in project A', `${up.out.split('\n').pop()} | now ${e2?.version}; Update ${upA.result}; new routing.md ${routing.includes('probe release 2') ? 'installed' : 'MISSING'}; B ${changed(sB, snapshot(B)).length} changed`,
    e2?.version === probe2 && upA.result === 'updated' && routing.includes('probe release 2') && !changed(sB, snapshot(B)).length);
  const upAgain = op(update, A);
  record('P11', 'Update again changes nothing', upAgain.result, upAgain.result === 'unchanged');

  // Rollback: the earlier release again.
  fs.writeFileSync(pj, original);
  fs.copyFileSync(path.join(REPO, 'reference', 'routing.md'), path.join(SRC, 'reference', 'routing.md'));
  fs.writeFileSync(path.join(SRC, 'runtime-manifest.json'), manifestText(SRC));
  const back = claude(A, 'update', ID);
  const rb = op(update, A);
  const routing2 = fs.readFileSync(path.join(A, '.claude', 'skills', 'nth-review', 'reference', 'routing.md'), 'utf8');
  record('P12', 'rollback to the earlier release, then Update', `${back.out.split('\n').pop()} | now ${entry(A)?.version}; Update ${rb.result}; routing.md ${routing2.includes('probe release 2') ? 'NOT rolled back' : 'rolled back'}`,
    entry(A)?.version === e1?.version && rb.result === 'updated' && !routing2.includes('probe release 2'));

  const dis = op(disable, A);
  const left = changed(sA, snapshot(A));
  const kA3 = inventory(A);
  record('P13', 'Disable restores project A, .nth-review/ kept; /nth-review gone', `${dis.result}; ${left.length} paths differ from before Enable: ${left.slice(0, 3).join(', ')}; A ${show(kA3)}`,
    dis.result === 'disabled' && !left.length && same(kA3, ['nth-review:project'], AGENT));
  const pd = claude(A, 'disable', ID);
  const kA4 = inventory(A);
  record('P14', 'disable the plugin: no nth-review skill and no bundled agent', `${pd.out.split('\n').pop()} | enabled ${entry(A)?.enabled}; A ${show(kA4)}`, pd.code === 0 && entry(A)?.enabled === false && same(kA4, [], []));
  const un = claude(A, 'uninstall', ID, '-y');
  record('P15', 'uninstall', `${un.out.split('\n').pop()}; installed: ${entry(A) ? 'yes' : 'no'}; projects unchanged: ${!changed(sA, snapshot(A)).length && !changed(sB, snapshot(B)).length}`,
    un.code === 0 && !entry(A) && !changed(sA, snapshot(A)).length && !changed(sB, snapshot(B)).length);
  const userSetting = enabledIn(path.join(CONFIG, 'settings.json'));
  const files = projectSettings([A, B]);
  record('P16', 'not enabled at the end; no project settings file ever written', `configuration enabledPlugins["${ID}"] = ${userSetting}; project settings files: ${files.length}`, userSetting !== true && !files.length);

  // Scenarios B and C, and enabling for one project: a second configuration
  // that already has a general agent named reviewer at user level (another
  // kit's, installed as <config>/agents/reviewer.md), a project D with its own
  // reviewer, and the plugin enabled for project C only (--scope local).
  const generalText = generalAgent ? fs.readFileSync(generalAgent) : Buffer.from('---\nname: reviewer\ndescription: a general reviewer for coding work (probe)\ntools: Read, Grep\n---\nGENERAL-REVIEWER-PROBE: review completed coding work.\n');
  const generalFile = path.join(CONFIG2, 'agents', 'reviewer.md');
  fs.mkdirSync(path.dirname(generalFile), { recursive: true });
  fs.writeFileSync(generalFile, generalText);
  const generalLine = generalText.toString('utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  const sameAsBundled = generalText.toString('utf8').includes(BUNDLED.line);
  const C = project('c');
  const D = project('d');
  const projectAgent = path.join(D, '.claude', 'agents', 'reviewer.md');
  fs.mkdirSync(path.dirname(projectAgent), { recursive: true });
  fs.writeFileSync(projectAgent, '---\nname: reviewer\ndescription: the project\'s own reviewer (probe)\ntools: Grep\n---\nPROJECT-REVIEWER-PROBE\n');
  const userAgents = () => snapshot(path.join(CONFIG2, 'agents'));
  const sC = snapshot(C);
  const sD = snapshot(D);
  const sG = userAgents();
  const m2 = claudeIn(CONFIG2, C, 'marketplace', 'add', SRC);
  const i2 = claudeIn(CONFIG2, C, 'install', ID);
  const l2 = claudeIn(CONFIG2, C, 'enable', ID, '--scope', 'local');
  const kC = inventory(C, CONFIG2);
  const kD = inventory(D, CONFIG2);
  record('C1', 'enabled for project C only (--scope local): its command and agent in C, nothing of it in D; the other reviewer agents stay available', `${l2.out.split('\n').pop()} | C ${show(kC)}; D ${show(kD)}`,
    m2.code === 0 && i2.code === 0 && l2.code === 0 && same(kC, ['nth-review:project'], ['nth-review:reviewer', 'reviewer']) && same(kD, [], ['reviewer']));
  const nC = await delegate(C, CONFIG2, 'nth-review:reviewer');
  const gC = await delegate(C, CONFIG2, 'reviewer');
  const pD = await delegate(D, CONFIG2, 'reviewer');
  const nD = await delegate(D, CONFIG2, 'nth-review:reviewer');
  const isGeneral = (d) => Boolean(d.sub) && d.sub.system.includes(generalLine) && (sameAsBundled || !d.sub.system.includes(BUNDLED.line));
  record('C2', 'with another agent named reviewer present, nth-review:reviewer still resolves to the bundled agent', `C: ${showD(nC)}`, isBundled(nC));
  record('C3', `a bare reviewer resolves to the user's own agent in C and to the project's own agent in D, never to the bundled one${sameAsBundled ? ' (the given user agent has the same text as the bundled one)' : ''}`,
    `C: ${showD(gC)}; D: ${showD(pD)}`, isGeneral(gC) && Boolean(pD.sub) && pD.sub.system.includes('PROJECT-REVIEWER-PROBE') && !pD.sub.system.includes(BUNDLED.line) && JSON.stringify(pD.sub.tools) === '["Grep"]');
  record('C4', 'in project D, where the plugin is not enabled, nth-review:reviewer does not exist', `D: ${showD(nD)}`, notFound(nD));
  // nth-review's own lifecycle in C, then the plugin updated, disabled and uninstalled: the other agents never change.
  const en2 = op(enable, C, CONFIG2);
  const up2 = claudeIn(CONFIG2, C, 'update', ID);
  const upC = op(update, C, CONFIG2);
  const dis2 = op(disable, C, CONFIG2);
  const pd2 = claudeIn(CONFIG2, C, 'disable', ID, '--scope', 'local');
  const un2 = claudeIn(CONFIG2, C, 'uninstall', ID, '-y');
  const gAfter = await delegate(C, CONFIG2, 'reviewer');
  const leftC = changed(sC, snapshot(C)).filter((p) => !['.claude', '.claude/settings.local.json'].includes(p));
  record('C5', 'Enable, Update and Disable in C, then the plugin updated, disabled and uninstalled: the other reviewer files unchanged, C restored apart from Claude Code\'s own settings.local.json, D untouched; a bare reviewer still resolves as before',
    `Enable ${en2.result}, plugin update exit ${up2.code}, Update ${upC.result}, Disable ${dis2.result}; plugin disable exit ${pd2.code}, uninstall exit ${un2.code}; user agents changed ${changed(sG, userAgents()).length}, other changes in C ${leftC.length}, changes in D ${changed(sD, snapshot(D)).length}; reviewer afterwards: ${showD(gAfter)}`,
    en2.result === 'enabled' && up2.code === 0 && upC.result === 'unchanged' && dis2.result === 'disabled' && pd2.code === 0 && un2.code === 0
    && !changed(sG, userAgents()).length && !leftC.length && !changed(sD, snapshot(D)).length && isGeneral(gAfter));

  const paid = sessions.filter((s) => s.cost !== null && s.cost !== 0);
  const unblocked = sessions.filter((s) => !/not logged in/i.test(s.text));
  record('P17', 'no session reached a model: every one stopped at "Not logged in", cost 0', `${sessions.length} sessions; costs ${[...new Set(sessions.map((s) => s.cost))].join(', ')}; ${unblocked.length ? `not blocked: ${unblocked.map((s) => `${s.cwd} "${s.text.slice(0, 60)}"`).join('; ')}` : 'all "Not logged in"'}`,
    sessions.length > 0 && !paid.length && !unblocked.length);
  record('P17b', 'every delegation session talked only to the local stand-in (127.0.0.1, a dummy key): cost 0', `${delegations.length} sessions, ${mock.requests.length} requests answered locally; costs ${[...new Set(delegations.map((x) => x.cost))].join(', ')}`,
    delegations.length > 0 && delegations.every((x) => x.requests > 0 && x.cost === 0));
  record('P18', 'the machine\'s own Claude Code configuration files untouched', `${REAL.length} files checked`, realMtimes() === before);
  return version.out;
}

let claudeVersion = '';
try { mock = await startMock(); claudeVersion = await main(); } catch (error) { record('-', 'probe harness', String(error.stack ?? error), false); }
finally {
  mock?.close();
  for (const r of rows) console.log(`${r.status.toUpperCase().padEnd(5)} ${r.n.padEnd(4)} ${r.scenario}\n           ${r.observed}`);
  const fail = rows.filter((r) => r.status !== 'pass').length;
  console.log(`\n${rows.length} rows: ${rows.length - fail} pass, ${fail} fail. Claude Code ${claudeVersion}. Root: ${ROOT}${keep ? ' (kept)' : ''}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ platform: `${process.platform} ${os.release()}`, node: process.version, claude: claudeVersion, rows, sessions, delegations: delegations.map((x) => ({ ...x, sub: x.sub && { model: x.sub.model, tools: x.sub.tools } })) }, null, 2));
  if (!keep) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
}
