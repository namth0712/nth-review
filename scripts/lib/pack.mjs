// `pack` (M2-T2): a bounded evidence pack for one finding or obligation of an
// open run (protocol-v0.1 §6), written to its packs/<id>.md. Sources are read
// directly, without git: never through a symbolic link or junction, never
// when the name is secret, and each file at most once per pack. Whatever
// cannot be shown is marked, never silently left out.
import fs from 'node:fs';
import { runDir, writeAtomic } from './fsguard.mjs';
import { parseAnchor } from './schema.mjs';
import { RunError, readRun } from './runs.mjs';
import { isSecretPath, probe } from './snapshot.mjs';

export const PACK_LIMITS = Object.freeze({
  anchors: 10,
  lines: 15, // per anchor, centred on the cited range
  bytes: 6 * 1024, // the whole pack, UTF-8
  lineChars: 300, // a longer line is cut
  fileBytes: 8 * 1024 * 1024, // a larger file is not excerpted
  textChars: 500, // claim, notes and other record text
});

// One line of record text: no line breaks of any kind, at most `max`
// characters and twice as many UTF-8 bytes (so a header always fits).
const oneLine = (text, max = PACK_LIMITS.textChars) => {
  let flat = String(text ?? '').replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
  let cut = flat.length > max;
  if (cut) flat = flat.slice(0, max);
  while (Buffer.byteLength(flat, 'utf8') > max * 2) {
    flat = [...flat].slice(0, -1).join('');
    cut = true;
  }
  return cut ? `${flat}… [cut]` : flat;
};
const shortAnchor = (anchor) => oneLine(anchor, 200);

// The bytes of a probed regular file, or null if it is no longer that file.
function readProbed(probed) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = fs.openSync(probed.abs, flags);
  } catch {
    return null;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== probed.stats.ino || opened.dev !== probed.stats.dev) return null;
    const size = Number(opened.size);
    if (size > PACK_LIMITS.fileBytes) return null;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = fs.readSync(fd, buffer, offset, size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// { lines } or { problem }, read once per path (`cache`).
export function readSource(root, file, cache, dirs) {
  if (cache.has(file)) return cache.get(file);
  let source;
  const probed = isSecretPath(file) ? null : probe(root, file, dirs);
  if (!probed) source = { problem: 'secret: never read' };
  else if (probed.state === 'absent') source = { problem: 'missing: the file does not exist' };
  else if (probed.state === 'link' || probed.state === 'symlink') source = { problem: 'link: not followed' };
  else if (probed.state !== 'file') source = { problem: 'unreadable: not a regular file' };
  else if (probed.size > PACK_LIMITS.fileBytes) source = { problem: `too large to excerpt (${probed.size} bytes)` };
  else {
    const bytes = readProbed(probed);
    if (bytes === null) source = { problem: 'unreadable: could not be read' };
    else if (bytes.subarray(0, 8000).includes(0)) source = { problem: 'binary: not excerpted' };
    else {
      const lines = bytes.toString('utf8').split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop(); // the final newline
      source = { lines };
    }
  }
  cache.set(file, source);
  return source;
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

// Markdown headings outside fenced code: [line index, text].
function headings(lines) {
  const found = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = HEADING.exec(line);
      if (m) found.push([i, m[1]]);
    }
  });
  return found;
}

// Up to PACK_LIMITS.lines lines around the cited part of `lines`.
function excerpt(parsed, lines) {
  const max = PACK_LIMITS.lines;
  const total = lines.length;
  const marks = [];
  let from;
  let to;
  if (parsed.lines) {
    [from, to] = parsed.lines;
    if (from > total) return { cited: null, start: 0, end: -1, marks: [`range ${from}–${to} is past the end of the file (${total} lines)`] };
    if (to > total) {
      marks.push(`range ${from}–${to} runs past the end of the file (${total} lines)`);
      to = total;
    }
  } else if (parsed.heading) {
    const want = parsed.heading.trim();
    const all = headings(lines);
    const match = all.find(([, h]) => h === want) ?? all.find(([, h]) => h.toLowerCase() === want.toLowerCase());
    const at = match ? match[0] : -1;
    if (at === -1) return { cited: null, start: 0, end: -1, marks: [`heading "${oneLine(want, 100)}" not found`] };
    from = at + 1;
    to = from;
  } else {
    if (total === 0) return { cited: null, start: 0, end: -1, marks: ['empty file'] };
    if (total > max) marks.push(`the first ${max} of ${total} lines`);
    return { cited: null, start: 1, end: Math.min(total, max), marks };
  }
  let start;
  let end;
  if (to - from + 1 >= max) {
    start = from + Math.floor((to - from + 1 - max) / 2);
    end = start + max - 1;
    marks.push(`the middle ${max} of the cited ${to - from + 1} lines`);
  } else if (parsed.heading) {
    start = from;
    end = Math.min(total, from + max - 1);
  } else {
    const extra = max - (to - from + 1);
    start = from - Math.floor(extra / 2);
    end = to + Math.ceil(extra / 2);
    if (start < 1) {
      end += 1 - start;
      start = 1;
    }
    if (end > total) {
      start = Math.max(1, start - (end - total));
      end = total;
    }
  }
  return { cited: [from, to], start, end, marks };
}

function renderBlock(n, anchor, block) {
  const out = [`### ${n}. ${shortAnchor(anchor.anchor)} · ${anchor.role}`];
  if (anchor.note) out.push(`Note: ${oneLine(anchor.note)}`);
  for (const mark of block.marks) out.push(`> ${mark}`);
  if (block.end >= block.start) {
    const shown = block.text;
    const width = String(block.end).length;
    const longest = Math.max(0, ...shown.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((run) => run.length))));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    out.push(fence);
    shown.forEach((text, i) => {
      const number = block.start + i;
      const cited = block.cited && number >= block.cited[0] && number <= block.cited[1];
      const line = text.length > PACK_LIMITS.lineChars ? `${text.slice(0, PACK_LIMITS.lineChars)} … [line cut at ${PACK_LIMITS.lineChars} characters]` : text;
      out.push(`${cited ? '>' : ' '}${String(number).padStart(width)} | ${line}`);
    });
    out.push(fence);
  }
  return out.join('\n');
}

// The anchors of an item, in pack order: its own sources, then requested
// extras, then intent. Duplicates keep their first role.
function itemAnchors(doc, item, extras) {
  const anchors = [];
  if (item.kind === 'finding') {
    for (const step of item.record.trace) anchors.push({ anchor: step.anchor, role: step.role, note: step.note });
  } else {
    for (const e of item.record.evidence) anchors.push({ anchor: e.anchor, role: 'evidence', note: e.note });
    for (const a of item.record.assumptions) if (a.kind === 'dependency') anchors.push({ anchor: a.anchor, role: 'dependency', note: a.note });
  }
  const obligation = item.kind === 'finding' ? doc.obligations.find((o) => o.id === item.record.obligation) : item.record;
  // Flow runs: the recorded paths that bear on the obligation, so a delegate
  // starts from them instead of searching for them again. No disposition shown.
  for (const g of doc.census.edges ?? []) {
    if (!obligation || !(g.affects ?? []).includes(obligation.id)) continue;
    anchors.push({ anchor: g.evidence, role: `edge ${g.id} ${g.kind}`, note: g.to ? `to ${g.to}` : '' });
    if (g.to) anchors.push({ anchor: g.to, role: `edge ${g.id} target`, note: '' });
  }
  for (const extra of extras) anchors.push({ anchor: extra, role: 'requested', note: '' });
  for (const intentId of obligation?.intent ?? []) {
    const intent = doc.scope.intent.find((i) => i.id === intentId);
    if (intent) anchors.push({ anchor: intent.anchor, role: `intent ${intent.id}`, note: intent.note });
  }
  const seen = new Set();
  return anchors.filter((a) => !seen.has(a.anchor) && seen.add(a.anchor));
}

function header(doc, item) {
  const r = item.record;
  const lines = [`# Evidence pack: ${r.id}`, '', `- Run: ${doc.run.id} (${doc.run.namespace})`];
  if (item.kind === 'finding') {
    // No verdict, verification or counterevidence: a refuter sees no other conclusion.
    lines.push(`- Item: finding ${r.id} (${r.kind}${r.severity ? `, severity ${r.severity}` : ''}${r.impact_dimension ? `, ${r.impact_dimension}` : ''})`);
    lines.push(`- Claim: ${oneLine(r.summary)}`);
    const obligation = doc.obligations.find((o) => o.id === r.obligation);
    if (obligation) {
      lines.push(`- Obligation ${obligation.id}: ${oneLine(obligation.claim)}`);
      lines.push(`- Acceptance: ${oneLine(obligation.acceptance)}`);
    }
  } else {
    lines.push(`- Item: obligation ${r.id} (coverage ${r.coverage}: ${oneLine(r.coverage_method, 120)})`);
    lines.push(`- Claim: ${oneLine(r.claim)}`);
    lines.push(`- Scope: ${oneLine(r.scope)}`);
    lines.push(`- Acceptance: ${oneLine(r.acceptance)}`);
  }
  lines.push(`- Limits: at most ${PACK_LIMITS.anchors} anchors, ${PACK_LIMITS.lines} lines each, ${PACK_LIMITS.bytes / 1024} KB. Lines marked > are cited.`);
  return lines.join('\n');
}

// The boundary test (security, privacy and operator spend): a finding of
// that kind is a defect of that impact only when the source shows who acts,
// which control fails, and what crosses beyond the actor's own permissions.
// Given only to the refuters of such findings, decided here per finding, so a
// pack for any other finding or for an obligation never carries it. It holds
// questions only, no verdict. (Methodology restated from Cloudflare's
// security-audit-skill; see THIRD-PARTY-NOTICES.md.)
const BOUNDARY_FAMILIES = /^(AUTHN|AUTHZ|INJECT|LLM|WEB-SESSION|INTEGRATION)(\.|$)/;
export function boundaryLines(doc, finding) {
  const checks = doc.obligations.find((o) => o.id === finding.obligation)?.checks ?? [];
  const relevant = ['security', 'privacy'].includes(finding.impact_dimension)
    || checks.some((c) => BOUNDARY_FAMILIES.test(c) || c === 'RESOURCE.2');
  if (!relevant) return [];
  const lines = [
    '## Boundary test',
    'This claim concerns security, privacy or operator spend. Settle each point from the source before treating it as a defect of that impact:',
    '- Actor: who supplies the input or triggers the action, and what may they already do?',
    '- Control: which check should refuse, scope, bind or limit it, and why does it not?',
    "- Crossing: whose data, account, tenant, shared capacity or paid spend is affected beyond the actor's own permissions?",
    '- Result: what does the trace reach: a read, a write, an action, a disclosure or a cost?',
  ];
  if (checks.some((c) => /^LLM(\.|$)/.test(c))) {
    lines.push('- Model path: instructions given to a model are no control; text that can steer the model matters only where code then grants authority, data or a sink the requester could not reach directly.');
  }
  if (checks.some((c) => c === 'RESOURCE.2' || c === 'LLM.4')) {
    lines.push('- Cost: name the input, the work or spend it buys, each bound on the way (request, queue, quota, framework or gateway in the repositories) and who pays; an absent limit alone crosses nothing.');
  }
  if (checks.some((c) => ['AUTHZ.2', 'AUTHZ.4', 'OBJSTORE.1'].includes(c))) {
    lines.push('- Scope: an owner or tenant column proves nothing until the query, key or path that reads the data applies it.');
  }
  lines.push('If a point has no answer, nothing is crossed: the claim is a risk, or a defect of the impact it does show.');
  return lines;
}

// Builds the pack text for item `itemId` of `doc` (pure apart from reading
// the cited files under `root`). Returns { text, included, omitted, marked }.
export function buildPack(root, doc, itemId, extras = []) {
  const finding = doc.findings.find((f) => f.id === itemId);
  const obligation = doc.obligations.find((o) => o.id === itemId);
  if (finding && obligation) throw new RunError(`${itemId} names both a finding and an obligation`);
  if (!finding && !obligation) throw new RunError(`${itemId} is not a finding or obligation of run ${doc.run.id}`);
  for (const extra of extras) if (!parseAnchor(extra)) throw new RunError(`--anchor ${JSON.stringify(extra)} is not an anchor (path, path:L1, path:L1-L2 or path#Heading)`);
  const item = finding ? { kind: 'finding', record: finding } : { kind: 'obligation', record: obligation };

  const anchors = itemAnchors(doc, item, extras);
  const omitted = anchors.slice(PACK_LIMITS.anchors).map((a) => ({ anchor: a.anchor, why: `anchor cap (${PACK_LIMITS.anchors})` }));
  const cache = new Map();
  const dirs = new Map();
  const blocks = anchors.slice(0, PACK_LIMITS.anchors).map((anchor) => {
    const parsed = parseAnchor(anchor.anchor);
    const source = readSource(root, parsed.path, cache, dirs);
    const marks = [];
    const recorded = doc.footprint[parsed.path];
    if (recorded?.state === 'unverified') marks.push(`unverified identity: ${recorded.reason} (footprint)`);
    if (source.problem) return { anchor, block: { cited: null, start: 0, end: -1, text: [], marks: [...marks, `unavailable: ${source.problem}`] } };
    const cut = excerpt(parsed, source.lines);
    const shown = source.lines.slice(cut.start - 1, cut.end);
    if (shown.some((l) => l.length > PACK_LIMITS.lineChars)) marks.push(`lines longer than ${PACK_LIMITS.lineChars} characters are cut`);
    return { anchor, block: { ...cut, marks: [...marks, ...cut.marks], text: shown } };
  });

  // Placed before the excerpts, so the size cap (which shortens excerpts) never cuts it.
  const boundary = finding ? boundaryLines(doc, finding) : [];
  const assemble = () => {
    const parts = [header(doc, item), ''];
    if (boundary.length) parts.push(...boundary, '');
    blocks.forEach(({ anchor, block }, i) => parts.push(renderBlock(i + 1, anchor, block), ''));
    if (omitted.length) {
      parts.push('## Not included');
      for (const o of omitted.slice(0, 10)) parts.push(`- ${shortAnchor(o.anchor)} · ${o.why}`);
      if (omitted.length > 10) parts.push(`- and ${omitted.length - 10} more`);
      parts.push('');
    }
    return parts.join('\n');
  };
  // Fit the size cap: shorten the last excerpt first; drop it when empty.
  let text = assemble();
  while (Buffer.byteLength(text, 'utf8') > PACK_LIMITS.bytes) {
    const last = [...blocks].reverse().find((b) => b.block.end >= b.block.start);
    if (!last) {
      // Only the header and markers are left: cut the text itself, marked.
      const marker = '\n[pack cut at the size cap]\n';
      let cutText = text;
      while (Buffer.byteLength(cutText + marker, 'utf8') > PACK_LIMITS.bytes) cutText = [...cutText].slice(0, -64).join('');
      text = cutText + marker;
      break;
    }
    last.block.end -= 1;
    last.block.text = last.block.text.slice(0, -1);
    if (!last.block.marks.includes('cut to fit the pack size cap')) last.block.marks.push('cut to fit the pack size cap');
    if (last.block.end < last.block.start) {
      blocks.splice(blocks.indexOf(last), 1);
      omitted.unshift({ anchor: last.anchor.anchor, why: `size cap (${PACK_LIMITS.bytes / 1024} KB)` });
    }
    text = assemble();
  }
  return {
    text,
    included: blocks.map((b) => b.anchor.anchor),
    omitted,
    marked: blocks.filter((b) => b.block.marks.length).map((b) => ({ anchor: b.anchor.anchor, marks: b.block.marks })),
  };
}

// Writes packs/<id>.md for the open run `<ns>/runs/<runId>`.
export function packRun(root, ns, runId, itemId, extras = []) {
  const { doc, errors } = readRun(root, ns, runId);
  if (!doc || errors.length) return { errors };
  if (doc.run.status !== 'open') throw new RunError(`run ${runId} is ${doc.run.status}; packs are written only while a run is open (C1)`);
  const pack = buildPack(root, doc, itemId, extras);
  const rel = `${runDir(ns, runId)}/packs/${itemId}.md`;
  writeAtomic(root, rel, pack.text);
  return {
    errors: [],
    pack: `.nth-review/${rel}`,
    bytes: Buffer.byteLength(pack.text, 'utf8'),
    included: pack.included,
    omitted: pack.omitted,
    marked: pack.marked,
  };
}
