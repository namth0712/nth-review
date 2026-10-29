// Flow Review (BETA): resolving entry selectors against the current source.
// A selector is `<path>#<Symbol>` (an identifier, or `Container.member`),
// `<path>:<line>` or `<path>:<from>-<to>`; the path is project-root-relative,
// starting with its repository directory. Resolution reads only the working
// tree (no Git history), never follows a link, never opens a secret, and
// never guesses: no match, or more than one, is a problem, not a choice.
import { REVIEW_DIR, isIntegrationPath } from './fsguard.mjs';
import { identitiesOf, owningRepository } from './footprint.mjs';
import { readSource } from './pack.mjs';
import { parseAnchor } from './schema.mjs';

export const MAX_ENTRIES = 8;
const SYMBOL = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/;
const RESOLVABLE = new Set(['clean', 'dirty', 'untracked']);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Definition patterns by file extension: each takes an escaped name and
// matches a line that defines it. Calls and references never match.
const JS_MOD = '(?:(?:public|private|protected|static|async|override|readonly|get|set|abstract)\\s+)*';
const OPEN_SIGNATURE = '(?#open-signature)';
const FAMILIES = [
  [['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'], (n) => [
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\s*[<(]`,
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`,
    `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=`,
    `^\\s*${JS_MOD}\\*?${n}\\s*(?:<[^>]*>)?\\s*\\([^=]*\\{\\s*$`,
    // A method whose parameters continue on later lines: a definition only when
    // the line that closes them opens a body (see definitions()).
    `${OPEN_SIGNATURE}^\\s*${JS_MOD}\\*?${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*$`,
    `^\\s*['"]?${n}['"]?\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|[A-Za-z_$][\\w$]*\\s*=>)`,
  ]],
  [['py'], (n) => [`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`, `^\\s*class\\s+${n}\\b`]],
  [['go'], (n) => [`^func\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*[[(]`, `^type\\s+${n}\\s`]],
  [['rs'], (n) => [
    `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s+${n}\\b`,
    `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|mod)\\s+${n}\\b`,
    `^\\s*impl(?:<[^>]*>)?\\s+(?:[\\w:<>]+\\s+for\\s+)?${n}\\b`,
  ]],
  [['rb'], (n) => [`^\\s*def\\s+(?:self\\.)?${n}\\b`, `^\\s*(?:class|module)\\s+${n}\\b`]],
  [['php'], (n) => [
    `^\\s*(?:(?:public|private|protected|static|abstract|final)\\s+)*function\\s+&?${n}\\s*\\(`,
    `^\\s*(?:(?:abstract|final|readonly)\\s+)*(?:class|interface|trait|enum)\\s+${n}\\b`,
  ]],
  [['kt', 'kts'], (n) => [
    `^\\s*(?:(?:public|private|internal|protected|override|suspend|open|inline|operator|abstract)\\s+)*fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?${n}\\s*[(<]`,
    `^\\s*(?:(?:public|private|internal|protected|data|sealed|open|abstract|enum)\\s+)*(?:class|object|interface)\\s+${n}\\b`,
  ]],
  [['java', 'cs'], (n) => [
    // A method needs a modifier, so a call statement never matches.
    `^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|async|override|virtual|sealed|default)\\s+)+[\\w<>\\[\\],.?\\s]*?\\b${n}\\s*\\(`,
    `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\\s+)*(?:class|interface|record|enum|struct)\\s+${n}\\b`,
  ]],
];
export const SYMBOL_EXTENSIONS = Object.freeze(FAMILIES.flatMap(([exts]) => exts));

function patternsFor(file, name) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
  const family = FAMILIES.find(([exts]) => exts.includes(ext));
  return family ? family[1](escape(name)).map((p) => {
    const open = p.startsWith(OPEN_SIGNATURE);
    const re = new RegExp(open ? p.slice(OPEN_SIGNATURE.length) : p);
    re.openSignature = open;
    return re;
  }) : null;
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;
const CLOSING = /^\s*(?:[}\])]|end\b)/;

// A signature whose parameters span lines: the definition line opens more
// parentheses than it closes. The signature then ends on the line that
// closes them (`): Promise<T> => {`, `):`), within MAX_SIGNATURE_LINES;
// unbalanced parentheses keep the definition line alone.
const MAX_SIGNATURE_LINES = 60;
const parenDepth = (line) => {
  let depth = 0;
  for (const ch of line) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
  return depth;
};
function signatureEnd(lines, i) {
  let depth = parenDepth(lines[i]);
  let j = i;
  while (depth > 0 && j + 1 < lines.length && j - i < MAX_SIGNATURE_LINES) {
    j += 1;
    depth += parenDepth(lines[j]);
  }
  return depth === 0 ? j : i;
}

// The block a definition at index `i` opens: its signature (which may span
// lines), then the following lines indented deeper than the definition
// (blank lines included), plus one closing line at its own indentation
// (`}`, `)`, `]` or `end`). Returns the index of its last line.
export function blockEnd(lines, i) {
  const own = indentOf(lines[i]);
  const head = signatureEnd(lines, i);
  let last = head;
  for (let j = head + 1; j < lines.length; j += 1) {
    if (lines[j].trim() === '') continue;
    if (indentOf(lines[j]) > own) {
      last = j;
      continue;
    }
    if (CLOSING.test(lines[j]) && indentOf(lines[j]) === own) last = j;
    break;
  }
  return last;
}

// Lines (0-based) in [from, to] defining `name`.
// Lines longer than MAX_DEFINITION_LINE (minified or generated code) are
// never tested: that bounds the pattern work on pathological input.
export const MAX_DEFINITION_LINE = 2000;
function definitions(lines, patterns, from, to) {
  const found = [];
  for (let i = from; i <= to; i += 1) {
    if (lines[i].length > MAX_DEFINITION_LINE) continue;
    const opens = (re) => !re.openSignature || /\{\s*$/.test(lines[signatureEnd(lines, i)]);
    if (patterns.some((re) => re.test(lines[i]) && opens(re))) found.push(i);
  }
  return found;
}

const candidates = (file, found, lines) => found.map((i) => `${file}:${i + 1}-${blockEnd(lines, i) + 1}`).join(', ');

// The [from, to] lines (1-based) a symbol selector names, or { problem }.
function resolveSymbol(file, lines, symbol) {
  const [outer, inner] = symbol.split('.');
  const outerPatterns = patternsFor(file, outer);
  if (!outerPatterns) {
    return { problem: `symbol selectors are supported for ${SYMBOL_EXTENSIONS.map((e) => `.${e}`).join(' ')} files only; use a line selector (${file}:<from>-<to>)` };
  }
  const found = definitions(lines, outerPatterns, 0, lines.length - 1);
  if (found.length === 0) return { problem: `no definition of ${outer} in ${file}; check the name, or use a line selector (${file}:<from>-<to>)` };
  if (found.length > 1) return { problem: `${found.length} definitions of ${outer} in ${file} (${candidates(file, found, lines)}); choose one with a line selector` };
  const start = found[0];
  if (inner === undefined) return { lines: [start + 1, blockEnd(lines, start) + 1] };
  const end = blockEnd(lines, start);
  const members = definitions(lines, patternsFor(file, inner), start + 1, end);
  if (members.length === 0) return { problem: `no definition of ${inner} inside ${outer} (${file}:${start + 1}-${end + 1}); use a line selector` };
  if (members.length > 1) return { problem: `${members.length} definitions of ${inner} inside ${outer} (${candidates(file, members, lines)}); choose one with a line selector` };
  return { lines: [members[0] + 1, blockEnd(lines, members[0]) + 1] };
}

// Resolves `selectors` against the working tree under `root`, in the
// repositories `repoPaths` (a snapshot's, or discovery's). Returns
// { entries, problems }: entries only when there is no problem at all.
export function resolveEntries(root, selectors, repoPaths, { gitOptions } = {}) {
  const problems = [];
  if (!Array.isArray(selectors) || selectors.length === 0) return { entries: [], problems: ['a flow run needs at least one --entry'] };
  if (selectors.length > MAX_ENTRIES) return { entries: [], problems: [`at most ${MAX_ENTRIES} entries; a larger workflow is several flow runs`] };
  const parsed = [];
  for (const selector of selectors) {
    const anchor = parseAnchor(selector);
    let symbol = null;
    if (anchor?.heading !== null && anchor?.heading !== undefined) {
      symbol = anchor.heading;
      if (!SYMBOL.test(symbol)) {
        problems.push(`${selector}: the symbol must be an identifier or Container.member`);
        continue;
      }
    }
    if (!anchor) problems.push(`${selector}: not a selector; use <path>#<Symbol>, <path>:<line> or <path>:<from>-<to>`);
    else if (anchor.lines === null && symbol === null) problems.push(`${selector}: a whole file is not an entry point; name a symbol (#Name) or lines (:from-to)`);
    else if (anchor.path.split('/')[0].toLowerCase() === REVIEW_DIR) problems.push(`${selector}: review records are never an entry point`);
    else parsed.push({ selector, path: anchor.path, lines: anchor.lines, symbol });
  }
  const { identities, outside } = identitiesOf(root, parsed.map((p) => p.path), repoPaths, { gitOptions });
  const cache = new Map();
  const dirs = new Map();
  const entries = [];
  for (const p of parsed) {
    const repo = owningRepository(p.path, repoPaths);
    const identity = identities.get(p.path);
    if (outside.includes(p.path) || repo === null) {
      problems.push(`${p.selector}: ${p.path} is inside none of the project's repositories`);
      continue;
    }
    const rel = repo === '.' ? p.path : p.path.slice(repo.length + 1);
    if (isIntegrationPath(repo, rel) && identity?.state === 'untracked') {
      problems.push(`${p.selector}: this integration's installed files are never an entry point`);
      continue;
    }
    if (!identity || !RESOLVABLE.has(identity.state)) {
      const why = identity?.state === 'absent' ? 'does not exist in the current source (renamed or deleted?)' : `cannot be verified (${identity?.reason ?? 'unreadable'})`;
      problems.push(`${p.selector}: ${p.path} ${why}`);
      continue;
    }
    const source = readSource(root, p.path, cache, dirs);
    if (source.problem) {
      problems.push(`${p.selector}: ${p.path}: ${source.problem}`);
      continue;
    }
    let lines = p.lines;
    if (p.symbol !== null) {
      const found = resolveSymbol(p.path, source.lines, p.symbol);
      if (found.problem) {
        problems.push(`${p.selector}: ${found.problem}`);
        continue;
      }
      lines = found.lines;
    } else if (lines[1] > source.lines.length) {
      problems.push(`${p.selector}: ${p.path} has ${source.lines.length} lines; the selector names ${lines[0]}-${lines[1]} (has the file changed?)`);
      continue;
    }
    const duplicate = entries.find((e) => e.path === p.path && e.lines[0] === lines[0] && e.lines[1] === lines[1]);
    if (duplicate) {
      problems.push(`${p.selector}: resolves to the same code as ${duplicate.selector} (${p.path}:${lines[0]}-${lines[1]})`);
      continue;
    }
    entries.push({
      id: `E${entries.length + 1}`,
      selector: p.selector,
      path: p.path,
      repo,
      symbol: p.symbol,
      lines,
      identity: { blob: identity.blob, state: identity.state, reason: identity.reason },
    });
  }
  return problems.length ? { entries: [], problems } : { entries, problems };
}

// The anchor an entry stands for in records: `<path>:<from>-<to>`.
export const entryAnchor = (entry) => `${entry.path}:${entry.lines[0]}-${entry.lines[1]}`;
