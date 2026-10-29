// M5-T4 session guard. Library-only test tooling: Enable never installs it.
//
// A Claude Code PreToolUse hook for the matrix's review and adjudication
// sessions, passed per session with `--settings`. Claude Code runs it before
// every tool call of the session and of its subagents; exit code 2 blocks the
// call. It is the boundary that read deny rules cannot draw on their own:
// a shell command reads and writes with the user's full file access.
//
// It allows only:
// - the tools a review needs (never web, MCP, PowerShell, notebooks or tools
//   with outside effects; no subagents for the adjudicator);
// - file reads inside the session's own folder (--root), and inside its own
//   Claude Code project folder, where Claude Code saves large tool results;
// - file writes where the role writes: the reviewer under <root>/.nth-review/,
//   the adjudicator only <root>/verdicts.json;
// - shell commands from a small grammar: the review helper (reviewer only),
//   read-only Git without any option that reaches another repository or file,
//   writes a file or runs another program, and a few read-only commands; every
//   path inside the root; no substitution, variable, glob, input redirection or
//   output redirection other than to /dev/null.
// It fails closed: malformed input, an unknown tool or an unwritable log blocks.
// Every decision is appended to --log, so the audit can prove that each
// executed call passed the guard.
//
// Usage (as a hook): node session-guard.mjs --role reviewer|adjudicator --root <dir> --log <file>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const COMMON_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ToolSearch'];
const ROLE_TOOLS = {
  reviewer: new Set([...COMMON_TOOLS, 'Write', 'Edit', 'MultiEdit', 'Agent', 'Task', 'SendMessage', 'Skill']),
  adjudicator: new Set([...COMMON_TOOLS, 'Write']),
};
const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'cat-file', 'blame', 'annotate', 'grep', 'shortlog', 'describe', 'merge-base', 'diff-tree', 'name-rev', 'for-each-ref', 'show-ref', 'whatchanged']);
const GIT_GLOBAL_OK = new Set(['--no-pager', '-P', '--literal-pathspecs', '--no-optional-locks', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']);
// Options that read another file or repository, write a file, or run a program.
const GIT_ARG_BLOCKED = /^(--no-index|--output(=.*)?|--ext-diff|--textconv|--filters|--open-files-in-pager(=.*)?|-O.*|--exec(=.*)?|--upload-pack(=.*)?|--receive-pack(=.*)?|--git-dir(=.*)?|--work-tree(=.*)?|--paginate|--contents(=.*)?|--file(=.*)?|-f)$/;
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'nl', 'grep', 'egrep', 'fgrep', 'diff', 'stat', 'file']);
const FILTERS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'grep', 'egrep', 'fgrep', 'cat', 'nl']);
const PLAIN = new Set(['pwd', 'true', 'echo']);

// ---------------------------------------------------------------- paths

const fold = (p) => (WIN ? p.toLowerCase() : p);
// A shell or tool path as an absolute local path: Git Bash `/c/x` is `C:\x`.
export function localPath(p, base) {
  let s = String(p);
  const msys = /^\/([A-Za-z])(\/|$)(.*)$/.exec(s);
  if (WIN && msys) s = `${msys[1]}:\\${msys[3]}`;
  return path.resolve(base, s);
}
// The real location of a path whose tail may not exist yet.
function real(p) {
  let probe = p;
  const rest = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return p;
    rest.unshift(path.basename(probe));
    probe = parent;
  }
  try { return path.join(fs.realpathSync.native(probe), ...rest); } catch { return p; }
}
export function inside(p, dir) {
  const a = fold(real(path.resolve(p)));
  const b = fold(real(path.resolve(dir)));
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// ---------------------------------------------------------------- shell grammar

// Words and operators, or a reason to refuse. Quotes are literal except for
// the characters that would make bash do more than the guard can see.
export function tokenize(cmd) {
  const out = [];
  let word = null;
  const push = () => { if (word !== null) out.push({ t: 'word', v: word }); word = null; };
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (c === '\n' || c === '\r') return { error: 'multi-line command' };
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return { error: 'unclosed quote' };
      word = (word ?? '') + cmd.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < cmd.length && cmd[j] !== '"'; j += 1) {
        if (cmd[j] === '$' || cmd[j] === '`' || cmd[j] === '\n') return { error: 'substitution or line break inside quotes' };
        if (cmd[j] === '\\' && /["\\$`\n]/.test(cmd[j + 1] ?? '')) return { error: 'escape inside quotes' };
        v += cmd[j];
      }
      if (j >= cmd.length) return { error: 'unclosed quote' };
      word = (word ?? '') + v;
      i = j;
      continue;
    }
    if (c === '&' && cmd[i + 1] === '&') { push(); out.push({ t: 'op', v: '&&' }); i += 1; continue; }
    if (c === '|' && cmd[i + 1] === '|') { push(); out.push({ t: 'op', v: '||' }); i += 1; continue; }
    if (c === '|' || c === ';') { push(); out.push({ t: 'op', v: c }); continue; }
    if (c === '>' || (c === '2' && word === null && cmd[i + 1] === '>')) {
      // Only discarding output: `>/dev/null`, `2>/dev/null`, `2>&1`.
      const m = /^(2?>)\s*(\/dev\/null|&1)(?=$|[\s;&|])/.exec(cmd.slice(i));
      if (!m || (m[1] === '>' && m[2] === '&1')) return { error: 'output redirection' };
      push();
      i += m[0].length - 1;
      continue;
    }
    if ('<`$(){}\\!&'.includes(c)) return { error: `shell character ${c}` };
    if ((c === '~' || c === '#') && word === null) return { error: `shell character ${c}` };
    word = (word ?? '') + c;
  }
  push();
  return { tokens: out };
}

const looksLikePath = (v) => /[\\/]/.test(v) || /^[A-Za-z]:/.test(v) || v === '..' || v === '.';
// Every argument that names a place must be inside the root. A glob may only
// expand below a folder inside the root, and never climbs with `..`.
function pathArgsOk(args, cwd, root) {
  for (const a of args) {
    if (/(^|[=:])~/.test(a)) return `a home-folder path: ${a}`;
    const value = a.startsWith('--') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    if (value === '/dev/null') continue;
    const g = value.search(/[*?[]/);
    if (g >= 0) {
      if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return `a glob that climbs: ${a}`;
      const fixed = value.slice(0, g).replace(/[^\\/]*$/, '');
      if (fixed && !inside(localPath(fixed, cwd), root)) return `a glob outside the review: ${a}`;
      continue;
    }
    if (!looksLikePath(value)) continue;
    if (!inside(localPath(value, cwd), root)) return `a path outside the review: ${a}`;
  }
  return null;
}

function gitOk(args, cwd, root) {
  let i = 0;
  let dir = cwd;
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-C') {
      const d = args[i + 1];
      if (d === undefined) return 'git -C without a folder';
      dir = localPath(d, dir);
      if (!inside(dir, root)) return 'git -C outside the review';
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_OK.has(a)) continue;
    if (a.startsWith('-')) return `git option ${a}`;
    break;
  }
  const sub = args[i];
  if (!GIT_READ.has(sub)) return `git ${sub ?? '(none)'} is not a read-only command here`;
  const rest = args.slice(i + 1);
  const bad = rest.find((x) => GIT_ARG_BLOCKED.test(x));
  if (bad) return `git option ${bad}`;
  return pathArgsOk(rest, dir, root);
}

// One simple command; returns [reason or null, new cwd].
function commandOk(words, ctx, cwd, position) {
  const [head, ...args] = words;
  if (!head) return ['empty command', cwd];
  if (head.includes('=')) return ['environment assignment', cwd];
  if (position > 0) {
    if (!FILTERS.has(head)) return [`${head} after a pipe`, cwd];
    if (args.some((a) => looksLikePath(a) || /^-o|^--output/.test(a))) return [`${head} with a file after a pipe`, cwd];
    const operands = args.filter((a) => !a.startsWith('-'));
    if (['grep', 'egrep', 'fgrep'].includes(head) ? operands.length > 1 : operands.length > 0 && !['head', 'tail', 'cut', 'tr'].includes(head)) return [`${head} with a file after a pipe`, cwd];
    return [null, cwd];
  }
  if (head === 'cd') {
    if (args.length !== 1) return ['cd needs one folder', cwd];
    const next = localPath(args[0], cwd);
    return inside(next, ctx.root) ? [null, next] : ['cd outside the review', cwd];
  }
  if (PLAIN.has(head)) return [null, cwd];
  if (head === 'node') {
    if (args.length === 1 && ['--version', '-v'].includes(args[0])) return [null, cwd];
    if (ctx.role !== 'reviewer') return ['node is not available here', cwd];
    const helper = path.join(ctx.root, '.claude', 'skills', 'nth-review', 'scripts', 'nthr.mjs');
    if (!args[0] || fold(localPath(args[0], cwd)) !== fold(path.resolve(helper))) return ['node runs only the review helper', cwd];
    return [pathArgsOk(args.slice(1), cwd, ctx.root), cwd];
  }
  if (head === 'git') return [gitOk(args, cwd, ctx.root), cwd];
  if (READERS.has(head)) return [pathArgsOk(args, cwd, ctx.root), cwd];
  return [`${head} is not available here`, cwd];
}

export function bashOk(command, ctx, cwd) {
  const tk = tokenize(String(command ?? ''));
  if (tk.error) return tk.error;
  let dir = cwd;
  let words = [];
  let position = 0;
  const flush = () => {
    const [why, next] = commandOk(words, ctx, dir, position);
    words = [];
    if (why) return why;
    dir = next;
    return null;
  };
  for (const tok of tk.tokens) {
    if (tok.t === 'word') { words.push(tok.v); continue; }
    const why = flush();
    if (why) return why;
    position = tok.v === '|' ? position + 1 : 0;
  }
  return flush();
}

// ---------------------------------------------------------------- decisions

// The session's own Claude Code project folder (large tool results).
export function ownFolder(input) {
  const t = String(input.transcript_path ?? '').replace(/\\/g, '/');
  const m = /^(.*\/projects\/[^/]+)\//.exec(t);
  return m && input.session_id ? path.resolve(`${m[1]}/${input.session_id}`) : null;
}

export function decide({ role, root, input }) {
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input ?? {};
  const cwd = input?.cwd ? path.resolve(input.cwd) : path.resolve(root);
  if (!ROLE_TOOLS[role]) return 'unknown role';
  if (!ROLE_TOOLS[role].has(tool)) return `the ${tool || 'unnamed'} tool is not available here`;
  if (!inside(cwd, root)) return 'the session is outside the review';
  const own = ownFolder(input);
  const readable = (p) => inside(localPath(p, cwd), root) || (own !== null && inside(localPath(p, cwd), own));
  if (tool === 'Read') return ti.file_path && readable(ti.file_path) ? null : 'a read outside the review';
  if (tool === 'Grep' || tool === 'Glob') {
    if (ti.path && !readable(ti.path)) return 'a search outside the review';
    for (const key of ['pattern', 'glob']) {
      const v = ti[key];
      if (tool === 'Grep' && key === 'pattern') continue;
      if (typeof v === 'string' && (/(^|[\\/])\.\.([\\/]|$)/.test(v) || /^([A-Za-z]:|[\\/]|~)/.test(v))) return 'a search pattern outside the review';
    }
    return null;
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    if (!ti.file_path) return 'a write without a file';
    const target = localPath(ti.file_path, cwd);
    if (role === 'reviewer') return inside(target, path.join(root, '.nth-review')) ? null : 'a write outside the review records';
    return fold(real(target)) === fold(real(path.join(path.resolve(root), 'verdicts.json'))) ? null : 'a write other than verdicts.json';
  }
  if (tool === 'Bash') return bashOk(ti.command, { role, root: path.resolve(root) }, cwd);
  // Messages only to this session's own subagents (a recovery) or its main
  // conversation, never to another Claude session on the machine.
  if (tool === 'SendMessage') return /^(main|a[0-9a-f]{8,40})$/.test(String(ti.to ?? '')) ? null : 'a message outside this session';
  return null; // the remaining allowed tools touch no file
}

// ---------------------------------------------------------------- hook entry

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  let input = null;
  let reason;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
    reason = args.role && args.root ? decide({ role: args.role, root: args.root, input }) : 'guard misconfigured';
  } catch (e) {
    reason = `guard error: ${e.message}`;
  }
  const entry = {
    ts: new Date().toISOString(), session_id: input?.session_id ?? null, agent_id: input?.agent_id ?? null, tool_use_id: input?.tool_use_id ?? null,
    tool: input?.tool_name ?? null, decision: reason ? 'block' : 'allow', reason: reason ?? null, input_keys: input ? Object.keys(input).sort() : [],
  };
  try {
    fs.mkdirSync(path.dirname(args.log), { recursive: true });
    fs.appendFileSync(args.log, `${JSON.stringify(entry)}\n`);
  } catch {
    reason = reason ?? 'guard log unavailable';
  }
  if (reason) {
    process.stderr.write(`Blocked by the review sandbox: ${reason}. Stay inside this folder and use the review helper, read-only git and the file tools.\n`);
    return 2;
  }
  // An explicit approval. The session has no allow rules of its own for shell
  // commands or writes, so without this answer (the guard crashed, is missing
  // or timed out) Claude Code refuses those calls.
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'review sandbox' } })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
