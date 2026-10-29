// `footprint` (M2-T1): the identity of every file an open run cites
// (decision C9, under strict read-only Git), so a later run can tell which
// cited files changed. Each path is resolved once, against the working tree
// as it is now, in its owning repository (C8: the longest repository prefix
// of the run's snapshot). Nothing runs that git would otherwise delegate:
// filter drivers are disabled (git.mjs), so a file that needs one is
// `unverified`, as is anything the helper cannot or must not read.
import fs from 'node:fs';
import path from 'node:path';
import { byteCompare } from './discover.mjs';
import { isIntegrationPath, runDir, writeAtomic } from './fsguard.mjs';
import { filterDriversOf, git, refusePartialCloneOnOldGit } from './git.mjs';
import { parseAnchor, validateStructure } from './schema.mjs';
import { RunError, readRun } from './runs.mjs';
import { UNTRACKED_LIMITS, gitBytes, isSecretPath, probe, readStatus, splitNul } from './snapshot.mjs';

const BATCH_CHARS = 8_000; // keeps every command line well under Windows' limit

// Every file a run cites: evidence, intent, dependency assumptions, finding
// traces and counterevidence (`path#Heading` and `path:L1-L2` cite `path`).
// Sorted by path bytes, without duplicates.
export function citedPaths(doc) {
  const anchors = [
    ...doc.scope.intent.map((i) => i.anchor),
    ...doc.obligations.flatMap((o) => [
      ...o.evidence.map((e) => e.anchor),
      ...o.assumptions.filter((a) => a.kind === 'dependency').map((a) => a.anchor),
    ]),
    ...doc.findings.flatMap((f) => [
      ...f.trace.map((step) => step.anchor),
      ...f.counterevidence.map((c) => c.anchor).filter((a) => a !== null),
    ]),
    // Flow runs: the entry points and every recorded path's evidence and target.
    ...(doc.scope.entries ?? []).map((e) => e.path),
    ...(doc.census.edges ?? []).flatMap((g) => [g.evidence, g.to].filter((a) => a !== null)),
  ];
  return [...new Set(anchors.map((a) => parseAnchor(a).path))].sort(byteCompare);
}

// C8: the longest repository path that is a prefix of `file`, or null.
export function owningRepository(file, repoPaths) {
  let best = null;
  for (const repo of repoPaths) {
    const matches = repo === '.' || file.startsWith(`${repo}/`);
    if (matches && (best === null || best === '.' || (repo !== '.' && repo.length > best.length))) best = repo;
  }
  return best;
}

export function batches(items, size = (item) => item.length) {
  const out = [];
  let current = [];
  let length = 0;
  for (const item of items) {
    if (current.length && length + size(item) > BATCH_CHARS) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += size(item) + 1;
  }
  if (current.length) out.push(current);
  return out;
}

const literal = (rel) => `:(literal)${rel}`;
const unverified = (reason) => ({ blob: null, state: 'unverified', reason });

// A directory between the repository top and `rel` holding its own `.git`:
// the file belongs to a repository the snapshot does not cover.
function insideNestedRepository(repoDir, rel) {
  const segments = rel.split('/').slice(0, -1);
  let dir = repoDir;
  for (const segment of segments) {
    dir = path.join(dir, segment);
    try {
      fs.lstatSync(path.join(dir, '.git'));
      return true;
    } catch {
      // no .git here
    }
  }
  return false;
}

// True when every component of `rel` exists with exactly that name. On a
// case-insensitive file system a differently-cased path still opens, but git
// knows the file by its own case, so its state could not be told.
function exactCase(repoDir, rel, listings) {
  let dir = repoDir;
  for (const segment of rel.split('/')) {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, new Set(fs.readdirSync(dir)));
      } catch {
        listings.set(dir, new Set());
      }
    }
    if (!listings.get(dir).has(segment)) return false;
    dir = path.join(dir, segment);
  }
  return true;
}

// Identities of `rels` (paths inside the repository at `repoDir`), as a Map.
function repositoryIdentities(repoDir, rels, gitOptions) {
  const result = new Map();
  try {
    fs.lstatSync(path.join(repoDir, '.git'));
  } catch {
    for (const rel of rels) result.set(rel, unverified('repository-unavailable'));
    return result;
  }
  refusePartialCloneOnOldGit(repoDir, gitOptions);
  const drivers = filterDriversOf(repoDir, gitOptions);
  const options = { ...gitOptions, filterDrivers: drivers };

  // Local classification first: nothing is read that must not be.
  const dirs = new Map();
  const listings = new Map();
  const readable = [];
  for (const rel of rels) {
    const probed = probe(repoDir, rel, dirs);
    if (probed.state === 'link') result.set(rel, unverified('link'));
    else if (insideNestedRepository(repoDir, rel)) result.set(rel, unverified('nested-repository'));
    else if (probed.state === 'absent') result.set(rel, { blob: null, state: 'absent', reason: null });
    else if (!exactCase(repoDir, rel, listings)) result.set(rel, unverified('case-mismatch'));
    else if (isSecretPath(rel)) result.set(rel, unverified('secret'));
    else if (probed.state === 'symlink') result.set(rel, unverified('link'));
    else if (probed.state !== 'file') result.set(rel, unverified('unreadable'));
    else readable.push(rel);
  }

  // A configured filter driver would decide this file's blob; it never runs.
  if (drivers.length && readable.length) {
    const configured = new Set(drivers);
    const filtered = new Set();
    for (const batch of batches(readable)) {
      const out = gitBytes(repoDir, ['check-attr', '-z', 'filter', '--', ...batch], options).toString('utf8').split('\0');
      for (let i = 0; i + 2 < out.length; i += 3) if (configured.has(out[i + 2])) filtered.add(out[i]);
    }
    for (const rel of filtered) result.set(rel, unverified('filter'));
  }
  const hashable = readable.filter((rel) => !result.has(rel));
  if (hashable.length === 0) return result;

  // Working-tree blobs: git's own conversions, no filter driver, never -w.
  // A batch that fails (a file vanished, locked or unconvertible) is retried
  // path by path; a path that still fails is unverified, not fatal.
  const worktree = new Map();
  const hashObject = (paths) => git(repoDir, ['hash-object', '--', ...paths], options);
  for (const batch of batches(hashable)) {
    const out = hashObject(batch);
    if (out.status === 0) {
      const oids = out.stdout.toString('utf8').trim().split('\n');
      if (oids.length === batch.length) {
        batch.forEach((rel, i) => worktree.set(rel, oids[i]));
        continue;
      }
    }
    for (const rel of batch) {
      const one = hashObject([rel]);
      if (one.status === 0) worktree.set(rel, one.stdout.toString('utf8').trim());
    }
  }
  // Index entries (stage 0, or unmerged) and staged changes.
  const index = new Map();
  const unmerged = new Set();
  for (const batch of batches(hashable.map(literal))) {
    for (const record of splitNul(gitBytes(repoDir, ['ls-files', '--stage', '-z', '--', ...batch], options))) {
      const text = record.toString('utf8');
      const tab = text.indexOf('\t');
      const [, oid, stage] = text.slice(0, tab).split(' ');
      const rel = text.slice(tab + 1);
      if (stage === '0') index.set(rel, oid);
      else unmerged.add(rel);
    }
  }
  // Any status entry (staged, unstaged, intent-to-add) means the path differs
  // from HEAD. Filtered paths never get here, so git's verdict is reliable.
  const changed = new Set();
  for (const batch of batches(hashable.filter((rel) => index.has(rel)).map(literal))) {
    for (const entry of readStatus(repoDir, options, batch, { includeReview: true }).entries) changed.add(entry.rel);
  }

  for (const rel of hashable) {
    const blob = worktree.get(rel);
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(blob ?? '')) {
      result.set(rel, unverified('unreadable'));
    } else if (index.has(rel) && !changed.has(rel) && index.get(rel) === blob) {
      result.set(rel, { blob, state: 'clean', reason: null });
    } else if (index.has(rel) || unmerged.has(rel)) {
      result.set(rel, { blob, state: 'dirty', reason: null });
    } else {
      result.set(rel, { blob, state: 'untracked', reason: null });
    }
  }
  return result;
}

// The working-tree identities of project-relative `files`, each in its owning
// repository among `repoPaths` (C8), without writing anything. Returns
// { identities: Map(file -> identity), outside: [files in no repository] }.
// Shared by the footprint and by `fresh` (target identities).
export function identitiesOf(root, files, repoPaths, { gitOptions } = {}) {
  const byRepo = new Map();
  const outside = [];
  for (const file of files) {
    const repo = owningRepository(file, repoPaths);
    if (repo === null) outside.push(file);
    else byRepo.set(repo, [...(byRepo.get(repo) ?? []), file]);
  }
  const identities = new Map();
  for (const [repo, list] of [...byRepo].sort(([a], [b]) => byteCompare(a, b))) {
    const repoDir = repo === '.' ? root : path.join(root, ...repo.split('/'));
    const rels = list.map((f) => (repo === '.' ? f : f.slice(repo.length + 1)));
    // A repository directory replaced by a link since Open is never followed.
    if (repo !== '.' && probe(root, `${repo}/.git`, new Map()).state === 'link') {
      list.forEach((file) => identities.set(file, unverified('link')));
      continue;
    }
    const found = repositoryIdentities(repoDir, rels, gitOptions);
    list.forEach((file, i) => identities.set(file, found.get(rels[i])));
  }
  return { identities, outside };
}

// Cited files that may have changed since Open without the tracked state
// showing it (`compared`, from compareSnapshots): the evidence may rest on
// something that changed. Shared by resume (cause cited-untracked) and close.
// - an untracked, absent or unverified cited file in a repository whose
//   untracked state differs (its untracked list or hashed content changed);
// - an unverified (unhashable) cited file where a change could go unseen:
//   untracked hashing was partial, or the repository's tracked state is
//   unproven;
// - an untracked cited file that the Open snapshot may not have hashed: its
//   repository skipped files for the byte or file budget, or skipped files
//   for size and this one is over the size limit now. Such a file's edits
//   change no snapshot state.
// Any other untracked file in a repository whose untracked state is equal was
// hashed into an equal state at both ends, so it is not at risk, even when
// another repository's hashing was partial. [{ path, state, reason }]
const AT_RISK = new Set(['untracked', 'absent', 'unverified']);
export function citedAtRisk(root, doc, compared, { gitOptions } = {}) {
  const repoPaths = doc.snapshot.repos.map((r) => r.path);
  const changed = new Set(compared.repos.untracked);
  const uncertain = new Set(compared.untracked === 'unverified' ? repoPaths : compared.repos.unverified);
  if (changed.size === 0 && uncertain.size === 0) return [];
  const atOpen = new Map(doc.snapshot.repos.map((r) => [r.path, r.untracked?.skipped ?? {}]));
  const unhashedAtOpen = (file, repo) => {
    const skipped = atOpen.get(repo) ?? {};
    if ((skipped.budget ?? 0) > 0) return true;
    if ((skipped.size ?? 0) === 0) return false;
    try {
      return fs.statSync(path.join(root, ...file.split('/'))).size > UNTRACKED_LIMITS.fileBytes;
    } catch {
      return true;
    }
  };
  const { identities } = identitiesOf(root, citedPaths(doc), repoPaths, { gitOptions });
  return [...identities]
    .filter(([file, identity]) => {
      const repo = owningRepository(file, repoPaths);
      return (AT_RISK.has(identity.state) && changed.has(repo)) || (identity.state === 'unverified' && uncertain.has(repo))
        || (identity.state === 'untracked' && uncertain.has(repo) && unhashedAtOpen(file, repo));
    })
    .map(([file, identity]) => ({ path: file, state: identity.state, reason: identity.reason }));
}

// Flow runs: cited files that are untracked and ignored by Git (identitiesOf
// calls them untracked; `ls-files --others --exclude-standard`, which the
// snapshot's untracked state is built from, does not list them). Entry files
// are excepted: close re-resolves them and compares their identity.
function ignoredUntracked(root, doc, identities, repoPaths, gitOptions) {
  const entryFiles = new Set((doc.scope.entries ?? []).map((e) => e.path));
  const byRepo = new Map();
  for (const [file, identity] of identities) {
    if (identity.state !== 'untracked' || entryFiles.has(file)) continue;
    const repo = owningRepository(file, repoPaths);
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), file]);
  }
  const ignored = [];
  for (const [repo, files] of byRepo) {
    const repoDir = repo === '.' ? root : path.join(root, ...repo.split('/'));
    const rels = files.map((f) => (repo === '.' ? f : f.slice(repo.length + 1)));
    const listed = new Set();
    for (const batch of batches(rels.map(literal))) {
      for (const bytes of splitNul(gitBytes(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...batch], gitOptions))) {
        listed.add(bytes.toString('utf8'));
      }
    }
    files.forEach((file, i) => listed.has(rels[i]) || ignored.push(file));
  }
  return ignored.sort(byteCompare);
}

// The footprint of `doc` (parsed records@1) against the working tree now,
// without writing anything. Returns { errors } when a cited path is in no
// repository of the snapshot, or is an untracked copy of this integration's
// installed files (no snapshot covers it, so nothing could ever invalidate a
// conclusion resting on it), else { errors: [], footprint }.
export function computeFootprint(root, doc, { gitOptions } = {}) {
  const repoPaths = doc.snapshot.repos.map((r) => r.path);
  const { identities, outside } = identitiesOf(root, citedPaths(doc), repoPaths, { gitOptions });
  if (outside.length) {
    return { errors: outside.map((file) => `${file}: is cited but is inside none of the snapshot's repositories (C8)`) };
  }
  const uncovered = [...identities.keys()]
    .filter((file) => identities.get(file).state === 'untracked' && isIntegrationPath(owningRepository(file, repoPaths), file))
    .sort(byteCompare);
  if (uncovered.length) {
    return { errors: uncovered.map((file) => `${file}: is cited but is an untracked copy of this integration's installed files, which no snapshot covers; cite the reviewed source instead`) };
  }
  if (doc.run.mode === 'flow') {
    const ignored = ignoredUntracked(root, doc, identities, repoPaths, gitOptions);
    if (ignored.length) {
      return { errors: ignored.map((file) => `${file}: is cited but is ignored by Git, so no snapshot covers it and a change to it could never be seen; cite a tracked or non-ignored file, or record the path as an unknown edge`) };
    }
  }
  const footprint = {};
  for (const file of [...identities.keys()].sort(byteCompare)) footprint[file] = identities.get(file);
  return { errors: [], footprint };
}

// A short account of a footprint: entry count, states, unverified paths.
export function footprintSummary(footprint) {
  const states = { clean: 0, dirty: 0, untracked: 0, absent: 0, unverified: 0 };
  for (const identity of Object.values(footprint)) states[identity.state] += 1;
  return {
    paths: Object.keys(footprint).length,
    states,
    unverified: Object.entries(footprint).filter(([, v]) => v.state === 'unverified').map(([file, v]) => ({ path: file, reason: v.reason })),
  };
}

// Computes the footprint of the open run `<ns>/runs/<id>` and writes it into
// its records.json. Returns { errors } when the records cannot be used, else
// the summary. Throws RunError when the run is not open.
export function footprintRun(root, ns, id, { gitOptions } = {}) {
  const { doc, errors } = readRun(root, ns, id);
  if (!doc || errors.length) return { errors };
  if (doc.run.status !== 'open') {
    throw new RunError(`run ${id} is ${doc.run.status}; only an open run gets a footprint (C1)`);
  }
  const computed = computeFootprint(root, doc, { gitOptions });
  if (computed.errors.length) return { errors: computed.errors };
  doc.footprint = computed.footprint;
  const problems = validateStructure(doc);
  if (problems.length) throw new Error(`footprint built invalid records: ${problems.join('; ')}`);
  writeAtomic(root, `${runDir(ns, id)}/records.json`, `${JSON.stringify(doc, null, 2)}\n`);
  return { errors: [], ...footprintSummary(computed.footprint) };
}
