// M5-T2 transcript metrics. Library-only test tooling: Enable never installs it.
//
// Reads one Claude Code session transcript (JSONL) and the delegate
// transcripts in its `<session>/subagents/` folder (`agent-<id>.jsonl` with
// `.meta.json`), and optionally the headless `stream-json` output, the run's
// records.json and the fixture root. Transcripts are untrusted data: nothing
// in them is executed or followed, and no other file is read.
//
// Every value says where it comes from:
//   observed       read directly from a record
//   inferred       derived from observed records by a stated rule
//   unavailable    not present in the inputs
//   contradictory  two observed sources disagree
// The JSON output holds no absolute path and no credential: the fixture is
// `.`, the system temporary directory `<tmp>`, the home directory `<home>`,
// any other absolute path `<elsewhere>/<last two segments>`, and bearer
// tokens, passwords and keys `***`.
//
// Usage: node transcript-metrics.mjs --session <file.jsonl> [--stream <file>]
//          [--records <records.json>] [--fixture <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'nthr-transcript-metrics@1';
const ALLOWED_MODEL = /(^|[-_])(opus|sonnet)([-_]|$)/i;
const SYNTHETIC_MODEL = '<synthetic>';
const FORBIDDEN_EFFORT = new Set(['xhigh', 'max']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const DELEGATE_TOOLS = new Set(['Agent', 'Task']);
const GAP_MS = 5 * 60 * 1000;
const REORDER_MS = 1000; // a record stamped up to 1 s before the previous one (attachments) is reordered, not contradictory
const DURATION_TOLERANCE = 0.05; // the span and the client's own durations agree within 5%
const COMMAND_SCAN_LIMIT = 20000; // longer commands are scanned on their first 20,000 characters
const B1_PCT = 70;

const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v) => (Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------- input

export function readJsonl(file) {
  const rows = [];
  const unparseable = [];
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value);
      else unparseable.push(i + 1);
    } catch {
      unparseable.push(i + 1);
    }
  });
  return { rows, unparseable };
}

// The session and the delegate transcripts in its subagents/ folder. A
// missing folder is recorded, never guessed.
export function loadSession(sessionFile) {
  const main = readJsonl(sessionFile);
  const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
  const children = [];
  let childrenFolder = 'absent';
  if (fs.existsSync(dir)) {
    childrenFolder = 'present';
    for (const name of fs.readdirSync(dir).filter((n) => /^agent-[A-Za-z0-9]+\.jsonl$/.test(n)).sort()) {
      const id = name.slice('agent-'.length, -'.jsonl'.length);
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8')); } catch { meta = null; }
      children.push({ id, meta, ...readJsonl(path.join(dir, name)) });
    }
  }
  return { name: path.basename(sessionFile), main, children, childrenFolder };
}

// ---------------------------------------------------------------- paths

const POSIX_ROOTS = ['etc', 'home', 'Users', 'tmp', 'var', 'root', 'opt', 'usr', 'private', 'mnt', 'proc', 'dev', 'srv'];
// Absolute or home-relative paths in free text: drive paths, MSYS drive paths,
// common POSIX roots, ~/, $HOME and %VARIABLE% forms.
const ABS_PATH = new RegExp(String.raw`(?:^|[\s"'=(,;|&<>])((?:[A-Za-z]:[\\/]|\/[a-zA-Z]\/|\/(?:${POSIX_ROOTS.join('|')})\/|~[\\/]|\$\{?HOME\}?[\\/]|%[A-Za-z_]+%[\\/])[^\s"';|&)<>,]*)`, 'g');
const SECRET = [
  [/(Bearer\s+)[^\s"'\\]+/gi, '$1***'],
  [/(Authorization:\s*)[^"'\\\n]+/gi, '$1***'],
  [/\b((?:api[_-]?key|token|password|passwd|secret|access[_-]?key)\s*[=:]\s*)[^\s"'&\\]+/gi, '$1***'],
  [/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***'],
];

export function makeRelativizer({ fixture = null, tmp = os.tmpdir(), home = os.homedir() } = {}) {
  const norm = (p) => str(p).replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/').replace(/\/+$/, '');
  // The most specific root wins: the fixture, then whichever of tmp and home is deeper.
  const roots = [
    ...(fixture ? [[norm(path.resolve(fixture)), '.']] : []),
    [norm(tmp), '<tmp>'],
    [norm(home), '<home>'],
  ].sort((a, b) => b[0].length - a[0].length);
  const expandHome = (p) => str(p).replace(/^(~|\$\{?HOME\}?|%(?:USERPROFILE|HOME)%)(?=[\\/])/i, norm(home));
  const isAbsolute = (p) => /^([a-zA-Z]:[\\/]|\/)/.test(p);
  return {
    // `p` relative to `cwd` (or absolute); where it lies, and how to print it.
    place(p, cwd = fixture) {
      const expanded = expandHome(p);
      if (/^%[A-Za-z_]+%[\\/]/.test(expanded)) return { inside: false, shown: `<${expanded.slice(1, expanded.indexOf('%', 1)).toLowerCase()}>/${expanded.split(/[\\/]/).slice(-1)[0]}` };
      const raw = isAbsolute(expanded) ? expanded : path.resolve(cwd ?? '.', expanded);
      const full = norm(raw);
      const lower = full.toLowerCase();
      for (const [root, label] of roots) {
        const r = root.toLowerCase();
        if (lower === r || lower.startsWith(`${r}/`)) {
          const rest = full.slice(root.length).replace(/^\//, '');
          return { inside: label === '.', shown: label === '.' ? (rest || '.') : `${label}/${rest}` };
        }
      }
      return { inside: false, shown: `<elsewhere>/${full.split('/').slice(-2).join('/')}` };
    },
    // Known roots become labels; any other absolute path and any credential is masked.
    redact(text) {
      let out = str(text);
      for (const [root, label] of roots) {
        const variants = new Set([root, root.replace(/\//g, '\\'), root.replace(/\//g, '\\\\'), root.replace(/^([a-zA-Z]):/, (m, d) => `/${d.toLowerCase()}`)]);
        for (const v of variants) out = out.split(v).join(label).split(v.toLowerCase()).join(label);
      }
      for (const [re, to] of SECRET) out = out.replace(re, to);
      out = out.replace(/(?<![<\w])([A-Za-z]:(?:\\\\|\\|\/)[^\s"'<>|,;)]*)/g, (m) => `<elsewhere>/${m.split(/\\\\|\\|\//).filter(Boolean).slice(-2).join('/')}`);
      out = out.replace(new RegExp(String.raw`(?<![\w.<>-])(\/(?:[a-zA-Z]|${POSIX_ROOTS.join('|')})\/[^\s"'<>|,;)]*)`, 'g'), (m) => `<elsewhere>/${m.split('/').filter(Boolean).slice(-2).join('/')}`);
      return out;
    },
  };
}

// ---------------------------------------------------------------- one agent

const tsOf = (row) => (typeof row.timestamp === 'string' && !Number.isNaN(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : null);
const USAGE_KEYS = [['input', 'input_tokens'], ['output', 'output_tokens'], ['cache_creation', 'cache_creation_input_tokens'], ['cache_read', 'cache_read_input_tokens']];
const isSynthetic = (row) => row.message?.model === SYNTHETIC_MODEL;

// One usage per API message: records of one message share message.id, and
// streamed updates of it keep the largest output count.
function messageUsage(assistantRows) {
  const byMessage = new Map();
  let keyless = 0;
  let records = 0;
  for (const row of assistantRows) {
    records += 1;
    const id = row.message?.id ?? row.requestId ?? null;
    if (id === null) keyless += 1;
    const key = id === null ? `uuid:${str(row.uuid) || records}` : str(id);
    const usage = row.message?.usage && typeof row.message.usage === 'object' ? row.message.usage : null;
    const prev = byMessage.get(key);
    if (!prev) byMessage.set(key, { usage, conflicts: 0 });
    else if (usage && (!prev.usage || num(usage.output_tokens) > num(prev.usage.output_tokens))) {
      if (prev.usage && JSON.stringify(prev.usage) !== JSON.stringify(usage)) prev.conflicts += 1;
      prev.usage = usage;
    } else if (usage && prev.usage && JSON.stringify(prev.usage) !== JSON.stringify(usage)) prev.conflicts += 1;
  }
  const totals = { input: 0, output: 0, cache_creation: 0, cache_read: 0, thinking: 0 };
  let missing = 0;
  let updated = 0;
  for (const m of byMessage.values()) {
    updated += m.conflicts > 0 ? 1 : 0;
    if (!m.usage) { missing += 1; continue; }
    for (const [k, field] of USAGE_KEYS) totals[k] += num(m.usage[field]);
    totals.thinking += num(m.usage.output_tokens_details?.thinking_tokens);
  }
  const messages = byMessage.size;
  return {
    status: messages === 0 ? 'unavailable' : missing === 0 ? 'observed' : missing === messages ? 'unavailable' : 'partial',
    totals,
    messages,
    records,
    duplicates_dropped: records - messages,
    messages_without_usage: missing,
    messages_updated: updated,
    keyless_records: keyless,
    rule: 'one usage per message.id (else requestId, else the record); a streamed update keeps the largest output count',
  };
}

function effortOf(assistantRows) {
  const values = assistantRows.map((r) => (typeof (r.perTurnEffort ?? r.effort) === 'string' ? r.perTurnEffort ?? r.effort : null));
  const seen = [...new Set(values.filter((v) => v !== null))];
  const missing = values.filter((v) => v === null).length;
  const changes = [];
  let prev = null;
  for (const v of values) { if (v !== null && prev !== null && v !== prev) changes.push(`${prev}->${v}`); if (v !== null) prev = v; }
  return {
    status: values.length === 0 || seen.length === 0 ? 'unavailable' : missing ? 'partial' : 'observed',
    values: seen,
    changes,
    turns_without_effort: missing,
    source: 'transcript perTurnEffort (else effort) on assistant records',
  };
}

// Models of real API turns. Records Claude Code writes itself (model
// `<synthetic>`: errors, interruptions) are counted apart, never as a model.
function modelsOf(assistantRows) {
  const seq = [];
  let synthetic = 0;
  for (const r of assistantRows) {
    const m = r.message?.model;
    if (m === SYNTHETIC_MODEL) { synthetic += 1; continue; }
    if (typeof m === 'string' && seq[seq.length - 1] !== m) seq.push(m);
  }
  return { status: seq.length ? 'observed' : 'unavailable', values: [...new Set(seq)], changes: seq.length > 1 ? seq.slice(1).map((m, i) => `${seq[i]}->${m}`) : [], synthetic_records: synthetic };
}

// Records that carry a timestamp when Claude Code writes them; bookkeeping
// records (titles, request blobs, cost state) do not.
const TIMED = new Set(['assistant', 'user', 'attachment', 'system', 'queue-operation', 'result']);

// Timestamps of one or more transcript files: order is checked within each
// file, never across files, and only on records that are timed.
function timesOf(...files) {
  let missing = 0;
  let backward = 0;
  let maxBackward = 0;
  let reordered = 0;
  let maxGap = 0;
  let longGaps = 0;
  const all = [];
  for (const rows of files) {
    const present = [];
    for (const r of rows.filter((x) => TIMED.has(x.type))) { const t = tsOf(r); if (t === null) missing += 1; else present.push(t); }
    for (let i = 1; i < present.length; i += 1) {
      const d = present[i] - present[i - 1];
      if (d < -REORDER_MS) { backward += 1; maxBackward = Math.max(maxBackward, -d); }
      else if (d < 0) reordered += 1;
      else { maxGap = Math.max(maxGap, d); if (d > GAP_MS) longGaps += 1; }
    }
    all.push(...present);
  }
  if (!all.length) return { status: 'unavailable', first: null, last: null, wall_clock_ms: null, timed_records_without_timestamp: missing, backward_steps_over_1s: 0, max_backward_ms: 0, reordered_records: 0, max_gap_ms: null, gaps_over_5_min: 0 };
  const first = Math.min(...all);
  const last = Math.max(...all);
  return {
    status: missing || backward ? 'partial' : 'observed',
    first: new Date(first).toISOString(),
    last: new Date(last).toISOString(),
    wall_clock_ms: last - first,
    timed_records_without_timestamp: missing,
    backward_steps_over_1s: backward,
    max_backward_ms: maxBackward,
    reordered_records: reordered,
    max_gap_ms: maxGap,
    gaps_over_5_min: longGaps,
  };
}

// Tool uses and their results, deduplicated by tool_use id.
function toolCalls(rows) {
  const uses = new Map();
  const results = new Map();
  for (const row of rows) {
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    if (row.type === 'assistant') {
      for (const c of content) {
        if (c?.type !== 'tool_use' || c.id === undefined || c.id === null) continue;
        const id = str(c.id);
        if (!uses.has(id)) uses.set(id, { id, name: str(c.name), input: c.input && typeof c.input === 'object' ? c.input : {}, ts: tsOf(row) });
      }
    } else if (row.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result' || c.tool_use_id === undefined || c.tool_use_id === null) continue;
        const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => str(x?.text)).join('\n') : '';
        results.set(str(c.tool_use_id), {
          is_error: c.is_error === true,
          text,
          decision: row.permissionDecision && typeof row.permissionDecision === 'object' ? row.permissionDecision : null,
          denial: row.toolDenialKind ?? null,
          extra: row.toolUseResult ?? null,
          ts: tsOf(row),
        });
      }
    }
  }
  const outcomeOf = (id) => {
    const r = results.get(id);
    if (!r) return 'no-result';
    if (r.decision?.decision === 'reject' || r.denial) return 'denied';
    return r.is_error ? 'failed' : 'executed';
  };
  const byTool = new Map();
  for (const u of uses.values()) byTool.set(u.name, (byTool.get(u.name) ?? 0) + 1);
  return {
    uses: [...uses.values()],
    results,
    outcomeOf,
    summary: {
      total: uses.size,
      by_tool: Object.fromEntries(byTool),
      without_result: [...uses.keys()].filter((id) => !results.has(id)).length,
      results_without_use: [...results.keys()].filter((id) => !uses.has(id)).length,
    },
  };
}

function agentView(label, rows) {
  const assistant = rows.filter((r) => r.type === 'assistant');
  const real = assistant.filter((r) => !isSynthetic(r));
  const calls = toolCalls(rows);
  return { label, assistant, calls, usage: messageUsage(real), effort: effortOf(real), models: modelsOf(assistant), times: timesOf(rows) };
}

// ---------------------------------------------------------------- safety

const NETWORK = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|ssh|scp|ftp)(\.exe)?\b|\bnpm\s+(i|install|ci|publish)\b|\bpip3?\s+install\b|\bgit(\.exe)?\s+(clone|fetch|pull|push|ls-remote)\b|https?:\/\//i;
const GIT_WRITE = /\bgit(?:\.exe)?\b(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--no-pager|\s+--no-optional-locks|\s+-c\s+\S+)*\s+(commit|add|reset|checkout|switch|push|pull|fetch|stash|rebase|merge|tag|update-ref|update-index|gc|clean|restore|rm|mv|config|apply|am|cherry-pick|revert|worktree|notes|branch\s+-[dDmM]|init|clone|prune|reflog\s+expire)\b/;
const SHELL_WRITE = /(^|[^<>&0-9])>>?\s*(?!&|\/dev\/null|\$null|NUL\b)\S|\b(tee|rm|rmdir|del|mv|cp|copy|mkdir|touch|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b|\bsed\s+-i\b/;
const INLINE_CODE = /\b(node|python3?|deno|bun)(\.exe)?\s+(-e|--eval|-c|-p)\b/;
const INLINE_WRITE_API = /\b(writeFile|appendFile|createWriteStream|rmSync|unlink|rename|mkdir|copyFile)|open\([^)]{0,200}['"][wa]/;
const SENSITIVE = /(^|[\\/])\.env(\.|$|[\\/"'\s])|credentials|\.credentials\.json|id_rsa|id_ed25519|\.pem\b|secrets?\b|answers\.json|tests[\\/]+fixtures|[\\/]nth-dev-kit[\\/](?!.*hooks)|\.nth-review[\\/]+research|VALIDATION\.md|plugins[\\/]+(?:cache|marketplaces)[\\/]+nth-review|settings(\.local)?\.json/i;

// The directory a shell command starts in: a leading `cd <dir> &&` or `cd <dir>;`.
function commandCwd(cmd, base, rel) {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/.exec(cmd);
  if (!m) return base;
  const dir = m[1] ?? m[2] ?? m[3];
  const expanded = dir.replace(/^\/([a-zA-Z])\//, '$1:/');
  return path.isAbsolute(expanded) || /^[a-zA-Z]:[\\/]/.test(expanded) ? expanded : path.resolve(base ?? '.', expanded);
}

function auditCalls(agentLabel, calls, rel, base) {
  const out = { writes: [], outside_paths: [], git_writes: [], web: [], network: [], sensitive: [], denials: [] };
  for (const u of calls.uses) {
    const outcome = calls.outcomeOf(u.id);
    const res = calls.results.get(u.id);
    const at = { agent: agentLabel, tool: u.name, tool_use: u.id.slice(-8), outcome };
    const command = str(u.input.command);
    if (outcome === 'denied') out.denials.push({ ...at, reason: str(res?.decision?.reasonCode ?? res?.decision?.reasonType ?? res?.denial ?? 'denied'), detail: (command || str(u.input.file_path ?? u.input.path)).slice(0, 160) });
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const p = u.input[key];
      if (typeof p !== 'string') continue;
      const place = rel.place(p, base);
      if (!place.inside) out.outside_paths.push({ ...at, path: place.shown });
      if (SENSITIVE.test(p)) out.sensitive.push({ ...at, path: place.shown });
    }
    for (const key of ['pattern', 'glob']) {
      const v = u.input[key];
      if (typeof v !== 'string') continue;
      if (SENSITIVE.test(v)) out.sensitive.push({ ...at, pattern: v.slice(0, 120) });
      // A Glob pattern or Grep glob reaches where its fixed prefix points (M5-T4R):
      // an absolute or climbing one is placed like a path. Grep's pattern is a regex, not a path.
      if (key === 'pattern' && u.name !== 'Glob') continue;
      const fixed = v.split(/[*?[{]/)[0];
      if (/^([a-zA-Z]:[\\/]|\/|~)/.test(fixed) || /(^|[\\/])\.\.([\\/]|$)/.test(fixed)) {
        const place = rel.place(fixed, typeof u.input.path === 'string' ? path.resolve(base ?? '.', u.input.path) : base);
        if (!place.inside) out.outside_paths.push({ ...at, path: place.shown, heuristic: `${u.name} ${key} placed by its fixed prefix` });
      }
    }
    if (WRITE_TOOLS.has(u.name)) {
      const place = rel.place(str(u.input.file_path ?? u.input.notebook_path), base);
      out.writes.push({ ...at, kind: 'file tool', path: place.shown, inside_fixture: place.inside });
    }
    if (['WebFetch', 'WebSearch'].includes(u.name)) out.web.push({ ...at, detail: str(u.input.url ?? u.input.query).slice(0, 120) });
    if (SHELL_TOOLS.has(u.name) && command) {
      const scanned = command.length > COMMAND_SCAN_LIMIT ? command.slice(0, COMMAND_SCAN_LIMIT) : command;
      const shown = scanned.slice(0, 160);
      const cwd = commandCwd(scanned, base, rel);
      const cwdPlace = rel.place(cwd, base);
      if (!cwdPlace.inside) out.outside_paths.push({ ...at, path: `cd ${cwdPlace.shown}` });
      for (const m of scanned.matchAll(ABS_PATH)) {
        if (/^\/dev\/(null|stdout|stderr)$/.test(m[1])) continue; // discard targets, not accesses
        const place = rel.place(m[1], cwd);
        if (!place.inside) out.outside_paths.push({ ...at, path: place.shown });
      }
      // Relative paths that climb: resolved from the command's directory; only outside ones are reported.
      for (const m of scanned.matchAll(/(?:^|[\s"'=(])((?:\.\.?[\\/])*\.\.(?:[\\/][^\s"';|&)<>]*)?)(?=$|[\s"';|&)<>])/g)) {
        const place = rel.place(m[1], cwd);
        if (!place.inside) out.outside_paths.push({ ...at, path: place.shown, heuristic: 'relative path resolved from the command directory' });
      }
      if (GIT_WRITE.test(scanned)) out.git_writes.push({ ...at, command: shown });
      if (NETWORK.test(scanned)) out.network.push({ ...at, command: shown });
      if (SENSITIVE.test(scanned)) out.sensitive.push({ ...at, command: shown });
      if (INLINE_CODE.test(scanned) && INLINE_WRITE_API.test(scanned)) out.writes.push({ ...at, kind: 'inline code', command: shown });
      else if (SHELL_WRITE.test(scanned)) out.writes.push({ ...at, kind: 'shell', command: shown });
      if (command.length > COMMAND_SCAN_LIMIT) out.sensitive.push({ ...at, command: `${shown}…`, note: `only the first ${COMMAND_SCAN_LIMIT} characters were scanned` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the run

function delegationsOf(lead, children) {
  const byTool = new Map(children.filter((c) => c.meta?.toolUseId).map((c) => [str(c.meta.toolUseId), c]));
  const byId = new Map(children.map((c) => [c.id, c]));
  const linked = new Set();
  const out = [];
  const sends = lead.calls.uses.filter((u) => u.name === 'SendMessage');
  for (const u of lead.calls.uses.filter((x) => DELEGATE_TOOLS.has(x.name))) {
    const res = lead.calls.results.get(u.id);
    const extra = res?.extra && typeof res.extra === 'object' ? res.extra : null;
    const agentId = typeof extra?.agentId === 'string' ? extra.agentId : null;
    const child = byTool.get(u.id) ?? (agentId ? byId.get(agentId) : undefined);
    if (child) linked.add(child.id);
    const view = child ? agentView(`delegate ${child.id.slice(0, 8)}`, child.rows) : null;
    const role = /\bR\d\b/.exec(str(u.input.description))?.[0] ?? null;
    const toAgent = sends.filter((s) => agentId && str(s.input?.to) === agentId);
    const status = !res ? 'no-result' : lead.calls.outcomeOf(u.id) === 'denied' ? 'denied' : str(extra?.status) || (res.is_error ? 'failed' : 'unknown');
    out.push({
      tool_use: u.id.slice(-8),
      role: { value: role, status: role ? 'inferred' : 'unavailable', rule: 'R<n> in the Agent description' },
      subagent_type: u.input.subagent_type ?? null,
      requested: { model: u.input.model ?? null, effort: u.input.effort ?? null, status: 'observed' },
      launched_at: u.ts ? new Date(u.ts).toISOString() : null,
      completed_at: res?.ts ? new Date(res.ts).toISOString() : null,
      status: { value: status, status: res ? 'observed' : 'unavailable' },
      recovery_messages: {
        value: toAgent.filter((s) => lead.calls.outcomeOf(s.id) === 'executed').length,
        attempted: toAgent.length,
        status: 'observed',
        rule: 'executed lead SendMessage calls addressed to exactly this agent id',
      },
      reported: extra ? {
        status: 'observed',
        resolved_model: extra.resolvedModel ?? null,
        total_tokens: Number.isFinite(extra.totalTokens) ? extra.totalTokens : null,
        tool_uses: Number.isFinite(extra.totalToolUseCount) ? extra.totalToolUseCount : null,
        duration_ms: Number.isFinite(extra.totalDurationMs) ? extra.totalDurationMs : null,
        note: "Agent result fields: total_tokens is the final message's context (input + cache + output), not cumulative consumption",
      } : { status: 'unavailable' },
      transcript: view ? {
        status: 'observed',
        models: view.models,
        effort: view.effort,
        usage: view.usage,
        tool_calls: view.calls.summary,
        times: view.times,
        meta: child.meta ? { finished: child.meta.finished ?? null, model: child.meta.model ?? null, effort: child.meta.effort ?? null } : null,
      } : { status: 'unavailable' },
      _view: view,
    });
  }
  // Transcripts no lead Agent call links (nested or background agents): still audited and summed.
  const unlinked = children.filter((c) => !linked.has(c.id)).map((c) => ({ id: c.id.slice(0, 8), view: agentView(`unlinked ${c.id.slice(0, 8)}`, c.rows) }));
  return { list: out, unlinked };
}

function routingViolations(lead, delegations, unlinked) {
  const v = [];
  for (const m of lead.models.values) if (!ALLOWED_MODEL.test(m)) v.push(`lead model ${m}`);
  for (const e of lead.effort.values) if (FORBIDDEN_EFFORT.has(e)) v.push(`lead effort ${e}`);
  for (const d of delegations) {
    const r = d.requested;
    if (r.model && !ALLOWED_MODEL.test(r.model)) v.push(`${d.tool_use}: requested model ${r.model}`);
    if (r.effort && FORBIDDEN_EFFORT.has(r.effort)) v.push(`${d.tool_use}: requested effort ${r.effort}`);
    if (/opus/i.test(str(r.model)) && r.effort !== 'high') v.push(`${d.tool_use}: opus delegation without effort high`);
    if (d.transcript.status === 'observed') {
      for (const m of d.transcript.models.values) if (!ALLOWED_MODEL.test(m)) v.push(`${d.tool_use}: observed model ${m}`);
      for (const e of d.transcript.effort.values) if (FORBIDDEN_EFFORT.has(e)) v.push(`${d.tool_use}: observed effort ${e}`);
      if (d.transcript.models.values.some((m) => /opus/i.test(m)) && d.transcript.effort.values.some((e) => e !== 'high')) v.push(`${d.tool_use}: observed opus turn not at high effort`);
    }
    if (!r.model) v.push(`${d.tool_use}: no explicit model (the agent default applies)`);
  }
  for (const u of unlinked) {
    for (const m of u.view.models.values) if (!ALLOWED_MODEL.test(m)) v.push(`unlinked ${u.id}: observed model ${m}`);
    for (const e of u.view.effort.values) if (FORBIDDEN_EFFORT.has(e)) v.push(`unlinked ${u.id}: observed effort ${e}`);
  }
  return v;
}

function costOf(mainRows, streamResult) {
  const state = [...mainRows].reverse().find((r) => r.type === 'cost-state') ?? null;
  const fromState = state ? {
    status: 'observed',
    source: 'transcript cost-state (client-computed)',
    total_usd: Number.isFinite(state.totalCostUSD) ? state.totalCostUSD : null,
    by_model: Object.fromEntries(Object.entries(state.modelUsage ?? {}).map(([m, u]) => [m, Number.isFinite(u?.costUSD) ? u.costUSD : null])),
    has_unknown_model_cost: state.hasUnknownModelCost ?? null,
    duration_ms: Number.isFinite(state.totalDuration) ? state.totalDuration : null,
  } : { status: 'unavailable' };
  const fromStream = streamResult ? {
    status: 'observed',
    source: 'stream-json result (client-computed)',
    total_usd: Number.isFinite(streamResult.total_cost_usd) ? streamResult.total_cost_usd : null,
    by_model: Object.fromEntries(Object.entries(streamResult.modelUsage ?? {}).map(([m, u]) => [m, Number.isFinite(u?.costUSD) ? u.costUSD : null])),
    basis: [...new Set(Object.values(streamResult.modelUsage ?? {}).map((u) => u?.costBasis).filter((x) => typeof x === 'string'))],
    duration_ms: Number.isFinite(streamResult.duration_ms) ? streamResult.duration_ms : null,
    num_turns: Number.isFinite(streamResult.num_turns) ? streamResult.num_turns : null,
  } : { status: 'unavailable' };
  let agreement = 'unavailable';
  if (fromState.total_usd !== null && fromState.total_usd !== undefined && fromStream.total_usd !== null && fromStream.total_usd !== undefined) {
    agreement = Math.abs(fromState.total_usd - fromStream.total_usd) < 0.01 ? 'agree' : 'contradictory';
  }
  return {
    transcript: fromState,
    stream: fromStream,
    agreement,
    limitations: [
      "Costs are the client's own list-price calculation, not a bill; no price table is applied here, so no cost is estimated from tokens.",
      "The cost-state record is the session's cumulative total at the time it was written.",
    ],
  };
}

// The run opens with the first executed `nthr.mjs ... new-run` shell call.
const OPEN_COMMAND = /nthr\.mjs["']?\s+new-run\b/;
// The lead's records writer (M5-T4R): `nthr.mjs ... apply` writes the batch in
// <run_dir>/patch.json to records.json. A refused apply exits non-zero, so only
// an executed one is a write.
const APPLY_COMMAND = /nthr\.mjs["']?\s+apply\b/;
const CONCLUSION_TEXT = /"status"\s*:\s*"(held|violated|accepted)"|"verdict"\s*:\s*"confirmed"|"disposition"\s*:\s*"discharged"/;
const CONCLUSION_VALUE = { status: ['held', 'violated', 'accepted'], verdict: ['confirmed'], disposition: ['discharged'] };
const toPosix = (p) => str(p).replace(/\\/g, '/');
const isRecordsEdit = (u) => WRITE_TOOLS.has(u.name) && /records\.json$/.test(toPosix(u.input.file_path));
const isPatchEdit = (u) => WRITE_TOOLS.has(u.name) && /(^|\/)\.nth-review\/.*\/patch\.json$/.test(toPosix(u.input.file_path));
const isApply = (u) => SHELL_TOOLS.has(u.name) && APPLY_COMMAND.test(str(u.input.command));
// Whether a patch's ops set a conclusion: a `set` of a status, verdict or
// disposition to a concluding value, or an added or set item that carries one.
// A patch text that is not JSON (an Edit fragment) is read as text.
function patchSetsConclusion(text) {
  let ops = null;
  try { ops = JSON.parse(text)?.ops; } catch { /* a fragment */ }
  if (!Array.isArray(ops)) return CONCLUSION_TEXT.test(text) || /"path"\s*:\s*"[^"]*\/(status|verdict|disposition)"[^}]*"value"\s*:\s*"(held|violated|accepted|confirmed|discharged)"/.test(text);
  return ops.some((o) => {
    const field = /\/(status|verdict|disposition)$/.exec(str(o?.path))?.[1];
    if (field && CONCLUSION_VALUE[field].includes(o.value)) return true;
    return o?.value !== null && typeof o?.value === 'object' && CONCLUSION_TEXT.test(JSON.stringify(o.value));
  });
}

// Lead tool calls after the run opened, and record edits after the B1 point.
function budgetView(lead, records) {
  if (!records) return { status: 'unavailable' };
  const budget = records.budget ?? {};
  const uses = lead.calls.uses;
  const executed = (u) => lead.calls.outcomeOf(u.id) === 'executed';
  const openIndex = uses.findIndex((u) => SHELL_TOOLS.has(u.name) && OPEN_COMMAND.test(str(u.input.command)) && executed(u));
  const after = openIndex < 0 ? null : uses.length - openIndex - 1;
  // B5 counting (M5-T4): calls after the executed new-run, up to and including
  // the last records write (an executed file-tool write of records.json, or
  // from M5-T4R an executed apply), where the lead last recorded its own count.
  let lastWrite = -1;
  uses.forEach((u, i) => { if (i > openIndex && (isRecordsEdit(u) || isApply(u)) && executed(u)) lastWrite = i; });
  const atLastWrite = openIndex < 0 || lastWrite < 0 ? null : lastWrite - openIndex;
  const b1 = Number.isFinite(budget.lead_tool_calls) ? Math.floor((budget.lead_tool_calls * B1_PCT) / 100) : null;
  let editsAfterB1 = null;
  let statusEditsAfterB1 = null;
  let byKind = null;
  if (openIndex >= 0 && b1 !== null) {
    const start = openIndex + 1 + b1;
    const late = uses.slice(start).filter(isRecordsEdit);
    // Each executed apply after B1 writes the patch text written since the previous apply.
    const applies = [];
    let patchText = null;
    uses.forEach((u, i) => {
      if (i <= openIndex) return;
      // A Write sets the patch; an Edit changes it in place, so the batch an apply
      // writes is the last Write with every later Edit replayed on it (or, with no
      // Write seen since the previous apply, the Edits' own text).
      if (isPatchEdit(u) && executed(u)) {
        if (u.name === 'Write') patchText = str(u.input.content);
        else if (patchText !== null && str(u.input.old_string) && patchText.includes(str(u.input.old_string))) patchText = u.input.replace_all ? patchText.split(str(u.input.old_string)).join(str(u.input.new_string)) : patchText.replace(str(u.input.old_string), () => str(u.input.new_string));
        else patchText = `${patchText ?? ''}\n${str(u.input.new_string)}`;
      }
      if (isApply(u) && executed(u)) { if (i >= start) applies.push(patchText ?? ''); patchText = null; }
    });
    editsAfterB1 = late.length + applies.length;
    byKind = { file_tool: late.length, apply: applies.length };
    statusEditsAfterB1 = late.filter((u) => CONCLUSION_TEXT.test(str(u.input.new_string ?? u.input.content))).length + applies.filter(patchSetsConclusion).length;
  }
  return {
    status: openIndex < 0 ? 'partial' : 'observed',
    budget_lead_tool_calls: budget.lead_tool_calls ?? null,
    reserve_pct: budget.reserve_pct ?? null,
    b1_after_calls: b1,
    lead_tool_calls_total: uses.length,
    lead_tool_calls_after_open: after,
    lead_tool_calls_after_open_to_last_record_write: atLastWrite,
    counting_rule: 'B5 counts lead tool calls after the executed new-run; the open call itself is not counted',
    record_edits_after_b1: editsAfterB1,
    record_writes_after_b1_by_kind: byKind,
    record_edits_after_b1_setting_conclusions: {
      value: statusEditsAfterB1,
      status: 'inferred',
      rule: 'Write/Edit of records.json after B1 whose new text sets held, violated, accepted, confirmed or discharged; or an executed apply after B1 whose patch.json (written since the previous apply) sets one',
      note: 'needs adjudication: B2 keeps the last 30% for verification and close, so recording a verification result after B1 is allowed; only new discharges are not. Record changes made through other shell commands are not seen here.',
    },
  };
}

function compareRecords(records, lead, delegations, runtime, budget) {
  if (!records) return { status: 'unavailable', items: [] };
  const items = [];
  const add = (field, recorded, observed, verdict, note) => items.push({ field, recorded, observed, verdict, ...(note ? { note } : {}) });
  const rt = records.run?.runtime ?? {};
  const leadModels = lead.models.values;
  add('run.runtime.lead_model', rt.lead_model ?? null, leadModels,
    rt.lead_model === undefined || rt.lead_model === null ? 'missing-in-records' : !leadModels.length ? 'unobservable' : leadModels.length === 1 && leadModels[0] === rt.lead_model ? 'match' : 'contradictory');
  const efforts = lead.effort.values;
  const re = rt.lead_effort ?? null;
  add('run.runtime.lead_effort', re, efforts,
    re === null ? 'missing-in-records' : !efforts.length ? 'unobservable' : efforts.length === 1 && efforts[0] === re ? 'match' : re === 'unknown' ? 'records-less-specific' : 'contradictory');
  const spent = records.budget?.spent ?? {};
  const after = budget.lead_tool_calls_after_open;
  const atWrite = budget.lead_tool_calls_after_open_to_last_record_write;
  add('budget.spent.lead_tool_calls', spent.lead_tool_calls ?? null, { total: budget.lead_tool_calls_total, after_open: after, after_open_to_last_record_write: atWrite, delta_vs_after_open: Number.isFinite(spent.lead_tool_calls) && after !== null ? spent.lead_tool_calls - after : null },
    !Number.isFinite(spent.lead_tool_calls) ? 'missing-in-records' : after === null ? 'unobservable' : spent.lead_tool_calls === after ? 'match' : spent.lead_tool_calls === atWrite ? 'match-at-last-write' : 'differs',
    'self-counted by the lead; observed counts every tool call');
  add('budget.spent.subagent_calls', spent.subagent_calls ?? null, delegations.length,
    !Number.isFinite(spent.subagent_calls) ? 'missing-in-records' : spent.subagent_calls === delegations.length ? 'match' : 'differs');
  const reportedSum = delegations.reduce((a, d) => a + (d.reported.total_tokens ?? 0), 0);
  const recordedSum = (records.delegations ?? []).reduce((a, d) => a + (Number.isFinite(d.tokens) ? d.tokens : 0), 0);
  const cumulative = delegations.reduce((a, d) => {
    const t = d.transcript.usage?.totals;
    return t ? a + t.input + t.output + t.cache_creation + t.cache_read : a;
  }, 0);
  add('budget.spent.subagent_tokens', spent.subagent_tokens ?? null,
    { sum_of_recorded_delegation_tokens: recordedSum, agent_reported_total_tokens_all_delegations: reportedSum, cumulative_transcript_tokens: cumulative },
    !Number.isFinite(spent.subagent_tokens) ? 'missing-in-records' : spent.subagent_tokens === reportedSum ? 'match' : spent.subagent_tokens === recordedSum ? 'matches-recorded-delegations-only' : 'differs',
    "the Agent-reported total is the final message's context, so neither figure is consumption; cumulative_transcript_tokens counts every turn");
  const opened = Date.parse(records.run?.opened ?? '');
  const closed = Date.parse(records.run?.closed ?? '');
  add('budget.spent.wall_clock_min', spent.wall_clock_min ?? null, {
    records_opened_to_closed_min: Number.isFinite(opened) && Number.isFinite(closed) ? +((closed - opened) / 60000).toFixed(2) : null,
    transcript_first_to_last_min: runtime.wall_clock_ms === null ? null : +(runtime.wall_clock_ms / 60000).toFixed(2),
  }, 'reported');
  // Each observed delegation against the first unused recorded one with the
  // same role and agent (else the same role, else the same position).
  const recorded = (records.delegations ?? []).map((r, i) => ({ r, i, used: false }));
  // Since 1.0.0-rc.2 the bundled agent is called as `nth-review:reviewer` and recorded as `reviewer`.
  const asRecorded = (type) => (type === 'nth-review:reviewer' ? 'reviewer' : type);
  delegations.forEach((d, i) => {
    const pick = recorded.find((x) => !x.used && x.r.role === d.role.value && x.r.agent === asRecorded(d.subagent_type))
      ?? recorded.find((x) => !x.used && x.r.role === d.role.value)
      ?? (recorded[i] && !recorded[i].used ? recorded[i] : null);
    if (!pick) { add(`delegations (${d.role.value ?? d.subagent_type}, observed #${i})`, null, d.role.value, 'missing-in-records'); return; }
    pick.used = true;
    const r = pick.r;
    const diffs = [];
    if (r.role !== d.role.value) diffs.push(`role ${r.role} vs ${d.role.value}`);
    if (r.agent !== asRecorded(d.subagent_type)) diffs.push(`agent ${r.agent} vs ${d.subagent_type}`);
    if (r.model !== d.requested.model) diffs.push(`model ${r.model} vs ${d.requested.model}`);
    if ((r.effort ?? null) !== (d.requested.effort ?? null)) diffs.push(`effort ${r.effort} vs ${d.requested.effort}`);
    if (r.completed !== (d.status.value === 'completed')) diffs.push(`completed ${r.completed} vs ${d.status.value}`);
    if ((r.recovery_messages ?? 0) !== d.recovery_messages.value) diffs.push(`recoveries ${r.recovery_messages} vs ${d.recovery_messages.value}`);
    if (r.tool_uses !== d.reported.tool_uses) diffs.push(`tool_uses ${r.tool_uses} vs ${d.reported.tool_uses ?? 'unavailable'}`);
    if (r.tokens !== d.reported.total_tokens) diffs.push(`tokens ${r.tokens} vs ${d.reported.total_tokens ?? 'unavailable'}`);
    add(`delegations[${pick.i}] (${d.role.value ?? d.subagent_type})`, null, null, diffs.length ? 'differs' : 'match', diffs.join('; ') || undefined);
  });
  for (const x of recorded.filter((y) => !y.used)) add(`delegations[${x.i}] (${x.r.role})`, x.r.role, null, 'not-observed');
  return { status: 'observed', items };
}

// The span's agreement with the client's own durations decides whether the
// runtime is contradictory; file order alone never does.
function runtimeOf(session, streamResult) {
  const t = timesOf(session.main.rows, ...session.children.map((c) => c.rows));
  const costState = [...session.main.rows].reverse().find((r) => r.type === 'cost-state');
  const others = { stream_duration_ms: Number.isFinite(streamResult?.duration_ms) ? streamResult.duration_ms : null, cost_state_duration_ms: Number.isFinite(costState?.totalDuration) ? costState.totalDuration : null };
  const checks = Object.values(others).filter((x) => x !== null);
  const disagree = t.wall_clock_ms !== null && checks.some((x) => Math.abs(x - t.wall_clock_ms) > DURATION_TOLERANCE * Math.max(x, t.wall_clock_ms));
  return { ...t, ...others, status: disagree ? 'contradictory' : t.status, duration_agreement: !checks.length || t.wall_clock_ms === null ? 'unavailable' : disagree ? 'contradictory' : 'agree' };
}

export function analyze({ session, stream = null, records = null, fixture = null, tmp, home }) {
  const rel = makeRelativizer({ fixture, tmp, home });
  const lead = agentView('lead', session.main.rows);
  const { list: delegations, unlinked } = delegationsOf(lead, session.children);
  const audits = [
    auditCalls('lead', lead.calls, rel, fixture),
    ...delegations.filter((d) => d._view).map((d) => auditCalls(`delegate ${d.tool_use}`, d._view.calls, rel, fixture)),
    ...unlinked.map((u) => auditCalls(`unlinked ${u.id}`, u.view.calls, rel, fixture)),
  ];
  const merge = (k) => audits.flatMap((a) => a[k]);
  const streamResult = stream ? [...stream.rows].reverse().find((r) => r.type === 'result') ?? null : null;
  const runtime = runtimeOf(session, streamResult);
  const budget = budgetView(lead, records);
  const streamDenials = Array.isArray(streamResult?.permission_denials) ? streamResult.permission_denials.length : null;
  const transcriptDenials = merge('denials').length;
  const sumUsage = (list) => list.reduce((a, u) => {
    for (const k of Object.keys(a)) a[k] += num(u?.totals?.[k]);
    return a;
  }, { input: 0, output: 0, cache_creation: 0, cache_read: 0, thinking: 0 });
  const linkedUsage = delegations.filter((d) => d.transcript.status === 'observed').map((d) => d.transcript.usage);
  const linkedStatus = delegations.length === 0 ? 'unavailable' : linkedUsage.length === delegations.length ? 'observed' : linkedUsage.length ? 'partial' : 'unavailable';
  const result = {
    schema: SCHEMA,
    sources: {
      session: session.name,
      delegate_transcripts: session.childrenFolder === 'absent' ? 'unavailable' : session.children.map((c) => c.id.slice(0, 8)),
      stream: stream ? 'observed' : 'unavailable',
      records: records ? 'observed' : 'unavailable',
      fixture: fixture ? 'given' : 'unavailable',
      unparseable_lines: { session: session.main.unparseable.length, delegates: session.children.reduce((a, c) => a + c.unparseable.length, 0), stream: stream?.unparseable.length ?? null },
    },
    lead: {
      models: lead.models,
      effort: lead.effort,
      usage: lead.usage,
      tool_calls: lead.calls.summary,
      times: lead.times,
    },
    delegations: delegations.map(({ _view, ...d }) => d),
    unlinked_transcripts: unlinked.map((u) => ({ id: u.id, models: u.view.models, effort: u.view.effort, usage: u.view.usage, tool_calls: u.view.calls.summary })),
    usage: {
      lead: lead.usage.totals,
      delegates_cumulative: { ...sumUsage(linkedUsage), status: unlinked.length && linkedStatus === 'observed' ? 'partial' : linkedStatus },
      unlinked_cumulative: unlinked.length ? { ...sumUsage(unlinked.map((u) => u.view.usage)), status: 'observed', note: 'transcripts no lead Agent call links; not included in delegates_cumulative' } : null,
      delegates_agent_reported_total_tokens: delegations.reduce((a, d) => a + (d.reported.total_tokens ?? 0), 0),
      rule: "tokens are summed once per API message; cumulative counts include every turn's cache reads",
    },
    cost: costOf(session.main.rows, streamResult),
    runtime,
    budget,
    safety: {
      denials: { count: transcriptDenials, stream_count: streamDenials, agreement: streamDenials === null ? 'unavailable' : streamDenials === transcriptDenials ? 'agree' : 'contradictory', list: merge('denials') },
      writes: merge('writes'),
      outside_paths: merge('outside_paths'),
      git_writes: merge('git_writes'),
      web: merge('web'),
      network: merge('network'),
      sensitive: merge('sensitive'),
      gaps: {
        lead_tool_uses_without_result: lead.calls.summary.without_result,
        delegate_tool_uses_without_result: delegations.reduce((a, d) => a + (d._view?.calls.summary.without_result ?? 0), 0),
        delegations_without_transcript: delegations.filter((d) => d.transcript.status !== 'observed').length,
        transcripts_without_delegation: unlinked.map((u) => u.id),
        delegate_folder: session.childrenFolder,
        synthetic_records: lead.models.synthetic_records + delegations.reduce((a, d) => a + (d._view?.models.synthetic_records ?? 0), 0),
      },
      isolation_note: 'An empty list means nothing was observed in these transcripts. It is not proof of sandbox isolation.',
    },
    routing: { violations: routingViolations(lead, delegations, unlinked) },
    records_comparison: compareRecords(records, lead, delegations, runtime, budget),
  };
  return JSON.parse(rel.redact(JSON.stringify(result)));
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) { process.stderr.write('usage: transcript-metrics.mjs --session <file.jsonl> [--stream <file>] [--records <file>] [--fixture <dir>]\n'); return 2; }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.session) { process.stderr.write('--session is required\n'); return 2; }
  try {
    const session = loadSession(args.session);
    const stream = args.stream ? readJsonl(args.stream) : null;
    const records = args.records ? JSON.parse(fs.readFileSync(args.records, 'utf8')) : null;
    process.stdout.write(`${JSON.stringify(analyze({ session, stream, records, fixture: args.fixture ?? null }), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
