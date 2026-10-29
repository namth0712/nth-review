// `fresh` (M2-T4; protocol §10, decisions C10, C11): prioritizes the
// obligations of an open Incremental run's effective baseline (runs.mjs) against
// the current tree. It compares the base run (its Open snapshot and closed
// footprint) with the tree now for the census, compares each obligation with
// its origin (the run that last recorded it), and writes `freshness` into the
// run's records.json, and nothing else:
// - per repository, the history outcome since the base;
// - every changed file (committed range, staged, unstaged, untracked,
//   renames, deletions, transients), for census coverage (C11);
// - per inherited obligation, `touched`, `file-changed` or `current`, with
//   why, and its origin when that is not the base. An obligation still open
//   in its origin was never concluded, so it is `touched`.
// It only prioritizes: it never says an obligation holds, and never sets
// `assumption-changed` (the lead's, from facts outside Git; kept on rerun).
// Uncertainty is never `current`: an unverified identity, content that cannot
// be compared, or lost history all make an anchor `touched`. Git is strictly
// read-only (git.mjs): no filters, textconv, external diff, hooks, fsmonitor,
// signature programs or fetches, and nothing written under .git/.
import path from 'node:path';
import { byteCompare } from './discover.mjs';
import { batches, citedPaths, identitiesOf, owningRepository } from './footprint.mjs';
import { REVIEW_DIR, isIntegrationPath, runDir, writeAtomic } from './fsguard.mjs';
import { GitExecutionError, filterDriversOf, git, refusePartialCloneOnOldGit } from './git.mjs';
import { RunError, effectiveBaseline, listRuns, readRun } from './runs.mjs';
import { EMPTY_SHA256, LIMITS, parseAnchor, repoPathProblem, validateStructure } from './schema.mjs';
import { compareSnapshots, gitBytes, readFlagged, readStatus, splitNul, takeSnapshot } from './snapshot.mjs';

// Protocol §10: a changed hunk within 3 lines of a cited range touches it.
export const MARGIN = 3;
const MAX_LISTED = 20;
const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const CLASS = Object.freeze(['current', 'file-changed', 'touched']);

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decode(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null; // not UTF-8: cannot be recorded
  }
}
const repoOrder = (a, b) => (a === '.' ? -1 : b === '.' ? 1 : byteCompare(a, b));
const projectPath = (repo, rel) => (repo === '.' ? rel : `${repo}/${rel}`);
const isReviewPath = (rel) => rel.split('/')[0].toLowerCase() === REVIEW_DIR;
const listed = (items) => (items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')} and ${items.length - MAX_LISTED} more` : items.join(', '));

// One git context per repository: the partial-clone guard runs once, and the
// configured filter drivers are looked up once (and disabled on every call).
function contextOf(root, repo, gitOptions, contexts) {
  if (!contexts.has(repo)) {
    const dir = repo === '.' ? root : path.join(root, ...repo.split('/'));
    refusePartialCloneOnOldGit(dir, gitOptions);
    contexts.set(repo, { dir, options: { ...gitOptions, filterDrivers: filterDriversOf(dir, gitOptions) }, objects: new Map() });
  }
  return contexts.get(repo);
}

// `cat-file -e`: whether the object exists locally (never fetched).
function hasObject(ctx, spec) {
  if (!ctx.objects.has(spec)) ctx.objects.set(spec, git(ctx.dir, ['cat-file', '-e', spec], ctx.options).status === 0);
  return ctx.objects.get(spec);
}

// ---------------------------------------------------------------- history

// The base repository had state its commit cannot reproduce: uncommitted
// tracked changes, untracked files, tracked entries that were unverified, or
// (snapshots since tracked-key@3) flagged files present in the working tree.
const flaggedPresent = (f) => f.hashed + f.missing + Object.values(f.skipped).reduce((n, v) => n + v, 0) > 0;
const dirtyAtBase = (r) => r.porcelain_sha256 !== EMPTY_SHA256 || r.untracked.count > 0
  || r.unverified.filter + r.unverified.secret + r.unverified.unreadable > 0
  || (r.flagged !== undefined && flaggedPresent(r.flagged));

// C10, per repository of either snapshot (sorted like compareSnapshots):
// { path, outcome, detail, baseHead, targetHead, basePresent, inTarget }.
export function historyOutcomes(root, baseSnapshot, targetSnapshot, { gitOptions, contexts = new Map() } = {}) {
  const before = new Map(baseSnapshot.repos.map((r) => [r.path, r]));
  const after = new Map(targetSnapshot.repos.map((r) => [r.path, r]));
  const out = [];
  for (const repo of [...new Set([...before.keys(), ...after.keys()])].sort(repoOrder)) {
    const base = before.get(repo);
    const target = after.get(repo);
    const entry = { path: repo, baseHead: base?.head ?? null, targetHead: target?.head ?? null, basePresent: false, inTarget: Boolean(target) };
    const missing = (detail) => out.push({ ...entry, outcome: 'base-missing', detail });
    if (!target) {
      missing('repository removed since base');
      continue;
    }
    if (!base) {
      missing('repository added since base');
      continue;
    }
    if (base.head === null) {
      missing('no base commit (unborn at base)');
      continue;
    }
    const ctx = contextOf(root, repo, gitOptions, contexts);
    if (!hasObject(ctx, `${base.head}^{commit}`)) {
      missing(`base commit ${base.head} is not in the repository (rewritten or pruned history)`);
      continue;
    }
    entry.basePresent = true;
    let history;
    if (base.head === target.head) history = 'equal';
    else if (target.head === null) history = 'diverged';
    else {
      const result = git(ctx.dir, ['merge-base', '--is-ancestor', base.head, target.head], ctx.options);
      if (result.status === 0) history = 'ancestor';
      else if (result.status === 1) history = 'diverged';
      else throw new GitExecutionError(`git merge-base exited ${result.status}: ${result.stderr.toString('utf8').trim()}`);
    }
    if (dirtyAtBase(base)) out.push({ ...entry, outcome: 'base-dirty', detail: `uncommitted state at base; history ${history}` });
    else out.push({ ...entry, outcome: history, detail: `history ${history}` });
  }
  return out;
}

// ---------------------------------------------------------------- changed files

// `diff --raw -z` records: { status, oldMode, newMode, first, second } (second
// only for renames and copies), paths decoded or null.
function parseRaw(buffer) {
  const tokens = splitNul(buffer);
  const records = [];
  for (let i = 0; i < tokens.length;) {
    const meta = tokens[i].toString('latin1');
    const match = /^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z])\d*$/.exec(meta);
    if (!match) throw new GitExecutionError(`unexpected git diff --raw record ${JSON.stringify(meta)}`);
    const [, oldMode, newMode, status] = match;
    const two = status === 'R' || status === 'C';
    records.push({ status, oldMode, newMode, first: tokens[i + 1], second: two ? tokens[i + 2] : null });
    i += two ? 3 : 2;
  }
  return records;
}

// Every file of one target repository that differs from the base:
// { entries: Map(rel -> { change, from }), modeChanged: Set(rel), bad: [] }.
function changedInRepository(history, ctx) {
  const entries = new Map();
  const modeChanged = new Set();
  const bad = [];
  const consumed = new Set();
  const set = (rel, change, from = null) => entries.set(rel, { change, from });
  const name = (bytes) => {
    const rel = decode(bytes);
    if (rel === null) bad.push(JSON.stringify(bytes.toString('latin1')));
    return rel;
  };

  // W: index -> working tree, decided by content in memory (no index write).
  const worktree = new Map();
  const worktreeDeleted = new Set();
  for (const e of readStatus(ctx.dir, ctx.options).entries) {
    const rel = e.rel ?? name(e.pathBytes);
    if (rel === null) continue;
    if (e.type === 'u') {
      worktree.set(rel, 'modified');
    } else if (e.y === 'D') {
      worktreeDeleted.add(rel);
      worktree.set(rel, 'deleted');
    } else if (e.y === 'A') {
      worktree.set(rel, 'added'); // intent-to-add
    } else if (e.y !== '.') {
      worktree.set(rel, 'modified');
      if (e.fields[4] !== e.fields[5]) modeChanged.add(rel); // mI != mW
    }
  }
  // O: untracked, as the snapshot sees them (no nested repositories, no review
  // records, no untracked copy of this integration's installed files).
  const others = new Set();
  for (const bytes of splitNul(gitBytes(ctx.dir, ['ls-files', '--others', '--exclude-standard', '-z'], ctx.options))) {
    const rel = name(bytes);
    if (rel !== null && !rel.endsWith('/') && !isReviewPath(rel) && !isIntegrationPath(history.path, rel)) others.add(rel);
  }

  if (history.basePresent) {
    // A: base tree -> index (objects only, so a stat-dirty index is no issue).
    const raw = gitBytes(ctx.dir, ['diff', '--cached', '--raw', '-z', '-M', '--ignore-submodules=dirty', history.baseHead, '--'], ctx.options);
    for (const r of parseRaw(raw)) {
      const first = name(r.first);
      const second = r.second === null ? null : name(r.second);
      if (first === null || (r.second !== null && second === null)) continue;
      consumed.add(first);
      if (second !== null) consumed.add(second);
      if (isReviewPath(first) || (second !== null && isReviewPath(second))) continue;
      if (r.status === 'R') {
        if (worktreeDeleted.has(second)) set(first, 'deleted');
        else {
          set(second, 'renamed', first);
          if (r.oldMode !== r.newMode) modeChanged.add(second);
        }
      } else if (r.status === 'C' || r.status === 'A') {
        const added = second ?? first;
        if (!worktreeDeleted.has(added)) set(added, 'added');
      } else if (r.status === 'D') {
        set(first, others.has(first) ? 'untracked' : 'deleted');
      } else {
        set(first, worktreeDeleted.has(first) ? 'deleted' : 'modified');
        if (r.oldMode !== r.newMode) modeChanged.add(first);
      }
    }
  } else {
    // No base commit to compare with: everything indexed is new to the review.
    for (const bytes of splitNul(gitBytes(ctx.dir, ['ls-files', '--cached', '-z'], ctx.options))) {
      const rel = name(bytes);
      if (rel === null) continue;
      consumed.add(rel);
      if (!isReviewPath(rel) && !worktreeDeleted.has(rel)) set(rel, 'added');
    }
  }
  for (const [rel, change] of worktree) if (!consumed.has(rel) && !entries.has(rel)) set(rel, change);
  for (const rel of others) if (!entries.has(rel)) set(rel, 'untracked');

  // Transient: added or deleted inside the committed range, absent at both
  // ends (the endpoint diff cannot show it).
  if (history.basePresent && history.targetHead !== null && history.baseHead !== history.targetHead) {
    const tokens = splitNul(gitBytes(ctx.dir, [
      'log', '--format=%H', '--name-status', '-z', '--no-renames', '--diff-filter=AD', `${history.baseHead}..${history.targetHead}`, '--',
    ], ctx.options));
    const seen = new Set();
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i].toString('latin1').replace(/^\n+/, '');
      if (token === '' || OID.test(token)) continue;
      if (token !== 'A' && token !== 'D') throw new GitExecutionError(`unexpected git log record ${JSON.stringify(token)}`);
      i += 1;
      const rel = tokens[i] === undefined ? null : name(tokens[i]);
      if (rel !== null) seen.add(rel);
    }
    const candidates = [...seen].filter((rel) => !entries.has(rel) && !consumed.has(rel) && !isReviewPath(rel)).sort(byteCompare);
    const indexed = new Set();
    for (const batch of batches(candidates.map((rel) => `:(literal)${rel}`))) {
      for (const bytes of splitNul(gitBytes(ctx.dir, ['ls-files', '--cached', '-z', '--', ...batch], ctx.options))) indexed.add(decode(bytes));
    }
    for (const rel of candidates) if (!indexed.has(rel) && !others.has(rel)) set(rel, 'transient');
  }

  // Entries Git is told not to look at (assume-unchanged, skip-worktree; the
  // snapshot's readFlagged) never show in status: their working-tree content
  // is compared by hash in computeFreshness. { rel -> skip-worktree? }
  const flagged = new Map();
  for (const f of readFlagged(ctx.dir, ctx.options)) {
    const rel = f.rel ?? name(f.pathBytes);
    if (rel !== null && !entries.has(rel)) flagged.set(rel, f.skipWorktree);
  }
  return { entries, modeChanged, bad, flagged };
}

// ---------------------------------------------------------------- anchors

// Hunks of a `diff -U0`, in base line numbers: [{ start, count }], where
// count 0 is a pure insertion after line `start`. { why } when there are none.
export function parseHunks(text) {
  if (/^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text)) return { why: 'binary content changed' };
  const hunks = [];
  for (const m of text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    hunks.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return hunks.length ? { hunks } : { why: 'content differs but no hunk was located' };
}

// Whether a hunk touches the cited lines [l1, l2] widened by `margin`. A pure
// insertion after line `start` touches lines `start` and `start + 1`.
export function touches({ start, count }, l1, l2, margin = MARGIN) {
  const low = l1 - margin;
  const high = l2 + margin;
  if (count > 0) return start <= high && start + count - 1 >= low;
  return start + 1 >= low && start <= high;
}

const describe = ({ start, count }) => (count === 0 ? `insertion after ${start}` : count === 1 ? `${start}` : `${start}-${start + count - 1}`);

// The anchors an obligation rests on, in order, without duplicates: its
// evidence, its dependency assumptions (how a changed helper reaches an
// unchanged endpoint), its intent sections, and the trace and counterevidence
// of its findings. Environment assumptions are facts outside Git.
export function obligationAnchors(baseDoc, obligation) {
  const intent = new Map(baseDoc.scope.intent.map((i) => [i.id, i.anchor]));
  const list = [
    ...obligation.evidence.map((e) => ({ role: 'evidence', anchor: e.anchor })),
    ...obligation.assumptions.filter((a) => a.kind === 'dependency').map((a) => ({ role: 'dependency', anchor: a.anchor })),
    ...obligation.intent.filter((id) => intent.has(id)).map((id) => ({ role: 'intent', anchor: intent.get(id) })),
  ];
  for (const f of baseDoc.findings) {
    if (f.obligation !== obligation.id && !obligation.links.includes(f.id)) continue;
    list.push(...f.trace.map((s) => ({ role: 'trace', anchor: s.anchor })));
    list.push(...f.counterevidence.filter((c) => c.anchor !== null).map((c) => ({ role: 'counterevidence', anchor: c.anchor })));
  }
  const seen = new Set();
  return list.filter(({ role, anchor }) => !seen.has(`${role}\0${anchor}`) && seen.add(`${role}\0${anchor}`));
}

// `parts` joined with "; ", cut to fit a record string.
function joinReason(parts) {
  let out = '';
  for (let i = 0; i < parts.length; i += 1) {
    const next = out ? `${out}; ${parts[i]}` : parts[i];
    if (next.length > LIMITS.string - 40) return `${out} ... and ${parts.length - i} more`;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------- freshness

// The freshness of the open incremental run `doc` against its effective
// `baseline` ({ base, entries }, runs.mjs) and the tree now (`targetSnapshot`).
// Pure apart from read-only Git. Returns { freshness, repos (with detail) }.
// Throws RunError when a changed file cannot be recorded, so census coverage
// (C11) is never silently incomplete.
export function computeFreshness(root, doc, baseline, { gitOptions, targetSnapshot }) {
  const baseDoc = baseline.base;
  const contexts = new Map();
  const repos = historyOutcomes(root, baseDoc.snapshot, targetSnapshot, { gitOptions, contexts });
  const byRepo = new Map(repos.map((r) => [r.path, r]));
  const baseRepos = baseDoc.snapshot.repos.map((r) => r.path);
  const targetRepos = targetSnapshot.repos.map((r) => r.path);

  // Changed files, per repository present now.
  const changed = new Map();
  const modeChanged = new Set();
  const bad = [];
  const flagged = new Map();
  for (const history of repos.filter((r) => r.inTarget)) {
    const found = changedInRepository(history, contextOf(root, history.path, gitOptions, contexts));
    for (const [rel, { change, from }] of found.entries) {
      const file = projectPath(history.path, rel);
      changed.set(file, { path: file, change, from: from === null ? null : projectPath(history.path, from) });
    }
    for (const rel of found.modeChanged) modeChanged.add(projectPath(history.path, rel));
    for (const [rel, skipWorktree] of found.flagged) flagged.set(projectPath(history.path, rel), skipWorktree);
    bad.push(...found.bad.map((b) => `${history.path}: ${b}`));
  }

  // Assume-unchanged and skip-worktree entries: the working-tree content
  // against the index entry, by hash. Unverifiable content is listed as
  // modified (the census must look at it); a skip-worktree file absent from
  // the working tree (sparse checkout) is not a change.
  const flaggedFiles = [...flagged.keys()].sort(byteCompare);
  const { identities: flaggedIdentities } = identitiesOf(root, flaggedFiles, targetRepos, { gitOptions });
  for (const file of flaggedFiles) {
    const identity = flaggedIdentities.get(file);
    if (!identity || identity.state === 'dirty' || identity.state === 'unverified') changed.set(file, { path: file, change: 'modified', from: null });
    else if (identity.state === 'absent' && !flagged.get(file)) changed.set(file, { path: file, change: 'deleted', from: null });
  }

  // Identities now of every file the base cites, and of every file an
  // inherited obligation rests on; a file the base cites whose two known
  // identities differ is a change even when Git shows none (a file dirty at
  // base and restored since).
  const cited = citedPaths(baseDoc);
  const anchorsOf = new Map(baseline.entries.map((e) => [e, obligationAnchors(e.doc, e.obligation)]));
  const inherited = [...anchorsOf.values()].flat().map((a) => parseAnchor(a.anchor)?.path).filter((p) => p !== undefined);
  const { identities } = identitiesOf(root, [...new Set([...cited, ...inherited])].sort(byteCompare), targetRepos, { gitOptions });
  const renamedTo = new Map([...changed.values()].filter((c) => c.change === 'renamed').map((c) => [c.from, c.path]));
  const known = (identity) => identity && identity.state !== 'unverified';
  for (const file of cited) {
    const repo = owningRepository(file, baseRepos);
    if (repo === null || repo !== owningRepository(file, targetRepos) || byRepo.get(repo).outcome === 'base-missing') continue;
    if (changed.has(file) || renamedTo.has(file)) continue;
    const before = baseDoc.footprint?.[file];
    const after = identities.get(file);
    if (!known(before) || !known(after)) continue;
    const beforeAbsent = before.state === 'absent';
    const afterAbsent = after.state === 'absent';
    let change = null;
    if (beforeAbsent && !afterAbsent) change = 'added';
    else if (!beforeAbsent && afterAbsent) change = 'deleted';
    else if (!beforeAbsent && before.blob !== after.blob) change = 'modified';
    if (change) changed.set(file, { path: file, change, from: null });
  }

  for (const c of changed.values()) {
    if (repoPathProblem(c.path) || (c.from !== null && repoPathProblem(c.from))) bad.push(c.path);
  }
  if (bad.length) {
    throw new RunError(`changed files that a record cannot name (":", "#", "*", "?", a trailing dot or space, or not UTF-8): ${listed(bad)}. Rename them, or review this change as a task run`);
  }
  if (changed.size > LIMITS.arrayItems) {
    throw new RunError(`${changed.size} changed files exceed the ${LIMITS.arrayItems} a run can record; review this change as task runs`);
  }
  const changedFiles = [...changed.values()].sort((a, b) => byteCompare(a.path, b.path));

  // Obligations, each compared with its origin: the base itself, or an older
  // run of the ancestry, whose history, renames and mode changes since then
  // are computed once, when first needed.
  const comparisons = new Map([[baseDoc.run.id, { id: baseDoc.run.id, where: 'base', doc: baseDoc, repos: baseRepos, byRepo, modeChanged, renamedTo }]]);
  const comparisonOf = (originDoc) => {
    const originId = originDoc.run.id;
    if (!comparisons.has(originId)) {
      const histories = historyOutcomes(root, originDoc.snapshot, targetSnapshot, { gitOptions, contexts });
      const originModes = new Set();
      const originRenames = new Map();
      for (const history of histories.filter((r) => r.inTarget)) {
        const found = changedInRepository(history, contextOf(root, history.path, gitOptions, contexts));
        for (const [rel, { change, from }] of found.entries) if (change === 'renamed') originRenames.set(projectPath(history.path, from), projectPath(history.path, rel));
        for (const rel of found.modeChanged) originModes.add(projectPath(history.path, rel));
      }
      comparisons.set(originId, {
        id: originId, where: `origin ${originId}`, doc: originDoc, repos: originDoc.snapshot.repos.map((r) => r.path),
        byRepo: new Map(histories.map((r) => [r.path, r])), modeChanged: originModes, renamedTo: originRenames,
      });
    }
    return comparisons.get(originId);
  };
  const hunkCache = new Map();
  const anchorCache = new Map();
  const classifyAnchor = (anchor, cmp) => {
    const key = `${cmp.id}\0${anchor}`;
    if (anchorCache.has(key)) return anchorCache.get(key);
    const result = decideAnchor(anchor, cmp);
    anchorCache.set(key, result);
    return result;
  };
  const decideAnchor = (anchor, cmp) => {
    const { where } = cmp;
    const touched = (why) => ({ level: 2, why });
    const parsed = parseAnchor(anchor);
    if (parsed === null) return touched('not a valid anchor');
    const file = parsed.path;
    const baseOwner = owningRepository(file, cmp.repos);
    const targetOwner = owningRepository(file, targetRepos);
    if (targetOwner === null) return touched('no repository holds it now');
    if (baseOwner !== targetOwner) return touched(`owning repository changed (${baseOwner ?? 'none'} -> ${targetOwner})`);
    const history = cmp.byRepo.get(baseOwner);
    if (history.outcome === 'base-missing') return touched(`history base-missing in ${baseOwner}${where === 'base' ? '' : ` since ${where}`}`);
    const before = cmp.doc.footprint?.[file];
    if (!before) return touched(`not in the ${where} footprint`);
    if (before.state === 'unverified') return touched(`${where} identity unverified (${before.reason})`);
    const after = identities.get(file);
    if (!after) return touched('no identity now');
    if (after.state === 'unverified') return touched(`target identity unverified (${after.reason})`);
    const beforeAbsent = before.state === 'absent';
    const afterAbsent = after.state === 'absent';
    // Evidence on a file absent at the origin was never verified (C13, as
    // `unverified` above): never current, whatever the file does now.
    if (beforeAbsent && afterAbsent) return touched(`absent at ${where} and now: the cited evidence never existed`);
    if (beforeAbsent) return touched(`added since ${where}`);
    if (afterAbsent) return touched(cmp.renamedTo.has(file) ? `renamed to ${cmp.renamedTo.get(file)}` : 'deleted');
    if (before.blob === after.blob) {
      return cmp.modeChanged.has(file) ? { level: 1, why: 'content unchanged; mode or type changed' } : { level: 0, why: null };
    }
    if (parsed.lines === null) return touched(parsed.heading === null ? 'whole-file anchor; content changed' : 'heading anchor; content changed');
    const hunkKey = `${cmp.id}\0${file}`;
    if (!hunkCache.has(hunkKey)) hunkCache.set(hunkKey, hunksOf(file, baseOwner, before, after, history, where));
    const found = hunkCache.get(hunkKey);
    if (found.why) return touched(found.why);
    const [l1, l2] = parsed.lines;
    const hit = found.hunks.find((h) => touches(h, l1, l2));
    if (hit) return touched(`${where} lines ${l1}-${l2} changed (hunk ${describe(hit)})`);
    return { level: 1, why: `changed at ${where} lines ${found.hunks.map(describe).join(', ')}; none within ${MARGIN} lines of ${l1}-${l2}` };
  };
  // Hunks between the content at the origin and the content now, in the origin's lines.
  const hunksOf = (file, repo, before, after, history, where) => {
    const ctx = contextOf(root, repo, gitOptions, contexts);
    const rel = repo === '.' ? file : file.slice(repo.length + 1);
    if (!hasObject(ctx, before.blob)) return { why: `${where} content unavailable (${before.state} at ${where}, not in the object database)` };
    let out;
    if (after.state === 'clean' || hasObject(ctx, after.blob)) {
      // Blob to blob: no path, so no attributes, conversions or drivers.
      out = gitBytes(ctx.dir, ['diff', '-U0', before.blob, after.blob], ctx.options);
    } else if (before.state === 'clean' && history.basePresent) {
      out = gitBytes(ctx.dir, ['diff', '-U0', history.baseHead, '--', `:(literal)${rel}`], ctx.options);
    } else {
      return { why: 'working-tree content cannot be compared with the base content' };
    }
    return parseHunks(out.toString('utf8'));
  };

  // One entry per inherited obligation, in resolution order. `origin` is
  // written only when it is not the base. The lead's `assumption-changed`
  // is kept (with the resolved origin, never a recorded one).
  const recorded = new Map((doc.freshness?.obligations ?? []).filter((o) => o.class === 'assumption-changed').map((o) => [o.id, o]));
  const obligations = baseline.entries.map((entry) => {
    const o = entry.obligation;
    const origin = entry.origin === baseDoc.run.id ? {} : { origin: entry.origin };
    if (recorded.has(o.id)) return { id: o.id, class: 'assumption-changed', reason: recorded.get(o.id).reason, ...origin };
    if (o.status === 'open') return { id: o.id, class: 'touched', reason: `open in ${entry.origin}; never concluded`, ...origin };
    const anchors = anchorsOf.get(entry);
    if (anchors.length === 0) return { id: o.id, class: 'touched', reason: 'cites no file anchor', ...origin };
    const cmp = comparisonOf(entry.doc);
    const results = anchors.map((a) => ({ ...a, ...classifyAnchor(a.anchor, cmp) }));
    const level = Math.max(...results.map((r) => r.level));
    if (level === 0) {
      const files = new Set(anchors.map((a) => parseAnchor(a.anchor)?.path)).size;
      return { id: o.id, class: 'current', reason: `${files} cited file${files === 1 ? '' : 's'} unchanged`, ...origin };
    }
    const reason = joinReason(results.filter((r) => r.level === level).map((r) => `${r.role} ${r.anchor}: ${r.why}`));
    return { id: o.id, class: CLASS[level], reason, ...origin };
  });

  return {
    freshness: {
      base_run: baseDoc.run.id,
      repos: repos.map((r) => ({ path: r.path, outcome: r.outcome })),
      changed_files: changedFiles,
      obligations,
    },
    repos: repos.map((r) => ({ path: r.path, outcome: r.outcome, detail: r.detail })),
  };
}

// The effective baseline of the incremental run `doc`: its base and every
// validated ancestor, as `new-run` requires them (runs.mjs).
function baselineOf(root, ns, doc) {
  if (doc.run.mode !== 'incremental') throw new RunError(`run ${doc.run.id} is a ${doc.run.mode} run; freshness is only for incremental runs`);
  return effectiveBaseline(root, ns, doc.run.base, listRuns(root, ns).ids);
}

// Close (C10, C11): the recorded freshness must be the one the tree gives
// now, so a stale or hand-edited class, or a skipped or added obligation, is
// refused. Only `assumption-changed` (the lead's) may replace a computed class.
export function verifyFreshness(root, ns, doc, targetSnapshot, { gitOptions } = {}) {
  const baseline = baselineOf(root, ns, doc);
  if (doc.freshness === null) throw new RunError('an incremental run needs freshness before it closes: run fresh, reassess, then close');
  const { freshness } = computeFreshness(root, doc, baseline, { gitOptions, targetSnapshot });
  if (JSON.stringify(freshness) !== JSON.stringify(doc.freshness)) {
    throw new RunError('the recorded freshness is not the one the tree gives now (stale, or edited by hand): run fresh again, reassess, then close');
  }
}

// Computes the freshness of the open incremental run `<ns>/runs/<id>` and
// writes it into its records.json. Returns { errors } when the records
// cannot be used, else the summary. Throws RunError on a refusal.
export function freshRun(root, ns, id, { gitOptions, snapshot: snapshotOptions = {} } = {}) {
  const { doc, errors } = readRun(root, ns, id);
  if (!doc || errors.length) return { errors };
  if (doc.run.status !== 'open') throw new RunError(`run ${id} is ${doc.run.status}; only an open run gets freshness (C1)`);
  const baseline = baselineOf(root, ns, doc);
  const baseDoc = baseline.base;
  const target = takeSnapshot(root, { ...snapshotOptions, gitOptions });
  const source = compareSnapshots(doc.snapshot, target);
  if (source.tracked === 'changed') {
    throw new RunError(`the tracked source changed since Open (${listed(source.repos.tracked)}), so freshness would describe a tree the run was not opened on. Resume the run`);
  }
  const computed = computeFreshness(root, doc, baseline, { gitOptions, targetSnapshot: target });
  doc.freshness = computed.freshness;
  const problems = validateStructure(doc);
  if (problems.length) throw new Error(`fresh built invalid records: ${problems.join('; ')}`);
  writeAtomic(root, `${runDir(ns, id)}/records.json`, `${JSON.stringify(doc, null, 2)}\n`);

  const byChange = {};
  for (const c of computed.freshness.changed_files) byChange[c.change] = (byChange[c.change] ?? 0) + 1;
  const ids = (cls) => computed.freshness.obligations.filter((o) => o.class === cls).map((o) => o.id);
  return {
    errors: [],
    base_run: baseDoc.run.id,
    repos: computed.repos,
    changed_files: { total: computed.freshness.changed_files.length, by_change: byChange },
    obligations: {
      touched: ids('touched'),
      'file-changed': ids('file-changed'),
      'assumption-changed': ids('assumption-changed'),
      current: ids('current').length,
    },
    source: { tracked: source.tracked, untracked: source.untracked, coverage: source.coverage, action: source.action },
  };
}
