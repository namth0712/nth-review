# records.json: `nth-review/records@1`

One `records.json` per run, under `.nth-review/<namespace>/runs/<run-id>/`. It is the single source of truth for the run; `report.md` is generated from it.

Write it as **UTF-8 without a byte-order mark**. Validate it with `node "${CLAUDE_SKILL_DIR}/scripts/nthr.mjs" check …`.

**General rules:**
- Every field below is **required**. "or null" means the value may be `null`; the key must still be present. Unknown fields are refused.
- The run's kind comes from its namespace path, never from a field: `experiments/…` is an experiment, `reviews/…` a review stream, `audits/…` an official audit.
- **Limits:** at most 5 MiB; nesting at most 64; strings at most 4,096 characters (tab, line feed and carriage return allowed; no other control characters or lone surrogates); at most 2,000 obligations. Keys `__proto__`, `constructor` and `prototype` are refused everywhere.
- Validation reports at most 100 errors, as `<path>: <problem>`, for example `$.obligations[3].evidence[0].anchor: must be an anchor…`.

## Paths and anchors

**Repository paths** are relative to the project root, with `/` separators. The first segment names the nested repository when there is one (`api/src/x.ts`); `.` is the project root itself, and is allowed only where noted. Refused:
- absolute paths and drive letters;
- backslashes, `.` and `..`, empty components;
- a component ending with a space or a dot;
- `:` and `#`;
- `*` and `?` (except census group paths);
- control characters.

**Anchors** cite source and docs:

| Form | Example |
|---|---|
| `path` | `api/src/transfer.js` |
| `path:L1` | `api/src/transfer.js:8` |
| `path:L1-L2` (L2 ≥ L1, no leading zeros) | `api/src/transfer.js:3-12` |
| `path#Heading` (docs) | `docs/ledger.md#Transfers` |

Everything after the first `#` is the heading, which may itself contain `#` (`docs/x.md#C# usage`); it is 1–200 characters.

**Ids:**

| Id | Format |
|---|---|
| Run | `YYYYMMDD-HHMMSS-<mode>-<slug>`; its mode and slug equal `run.mode` and `run.slug` |
| Debt | `<origin-run-id>/D<n>`, unchanged when carried |
| Intent | `I<n>` |
| Census recipe | `C<n>` |
| Check | a [taxonomy.md](taxonomy.md) id: `FAMILY.n` (`AUTHZ.2`), `MODULE.n` (`LLM.2`), or a module as a whole (`LEDGER`) |
| Others (obligations, findings, census items, units) | `[A-Za-z0-9._-]`, at most 64 |

## `run`

| Field | Values |
|---|---|
| `id`, `namespace`, `slug` | As above. `namespace` is `experiments/<id>`, `reviews/<id>` or `audits/<id>` (lowercase; Windows device names refused). |
| `mode` | `task` · `incremental` · `audit-plan` · `audit-unit` · `flow` |
| `unit` | audit unit id, or null |
| `base`, `continues` | run ids in the **same** namespace, or null |
| `status` | `open` · `complete` · `incomplete` · `abandoned` |
| `incomplete_reason` | `budget` · `open-obligations` · `unverified-findings` · `escalation` · `snapshot-changed` · `owner-stopped`. **Null** while `open` and when `complete`; **required** for `incomplete` and `abandoned`. |
| `opened`, `closed` | UTC `YYYY-MM-DDTHH:MM:SSZ` (milliseconds optional). `closed` is null exactly while the run is `open`. |
| `profile` | `quick` · `standard` · `deep` |

`runtime` has these fields:

| Field | Values |
|---|---|
| `required_lead_model` | `opus-high` · `sonnet` |
| `lead_model` | text, or null |
| `lead_effort` | `low` · `medium` · `high` · `xhigh` · `max` · `unknown`, or null (as configured by the user) |
| `triggers` | any of `authorization` · `money` · `schema-migration` · `concurrency` · `boundary-contract` · `ai-dispatch` · `task-size` |

## `scope`

- **`summary`:** text: the scope, and the family screening (the not-applicable family codes). The report shows it as recorded; nothing computes or checks it.
- **`change`:** `[{ repo, range, working_tree }]`. `repo` is a path or `.`; `range` is `<a>..<b>` or null.
- **`units`** (the audit ledger): `[{ id, title, tier, status, depends_on, runs, reason, scope?, basis? }]`.
  - `tier`: 1–3 or null; Tier 1 needs the R4 judgment critique.
  - `basis`: `[{ anchor, note }]`, at most 20: why the unit has its tier, each anchor with a note on what it shows. Optional in the schema, so older records stay valid. `check` requires a tier and a basis for every active unit (any status but `out_of_scope`) of a plan run that closes `complete`; it checks presence and form, never whether the tier is right, nor whether a basis anchor exists. A unit is **classified** when it has a tier and a non-empty basis. Basis anchors are not cited: they classify a unit, they are not review evidence.
  - `status`: `planned` · `in_progress` · `complete` · `incomplete` · `deferred` · `out_of_scope`. `in_progress` is not used.
  - `reason`: required for `deferred`, `out_of_scope` and `incomplete`.
  - `scope`: the unit's boundary, at most 1,000 characters. Optional in the schema, so older records stay valid; `check` requires it in every plan run.
  - `runs`: the unit runs that concluded the unit, appended only by `close`.
  - Only a plan run edits units. `close` records a unit run's result, and the audit close may only downgrade a unit (see `close`).
  - `close` is reserved: it names the audit close (`--unit close`) and is never a ledger unit.
- **`intent`:** `[{ id, anchor, note }]`, the doc sections read for intent.
- **`entries`** (flow runs only; written by `new-run`, never by the lead): `[{ id, selector, path, repo, symbol, lines, identity }]`, 1–8 resolved entry points.
  - `id` is `E1`…`E8`; `selector` is what the user gave; `symbol` is the `#Symbol` part or null; `lines` is the resolved `[from, to]`; `repo` is the owning repository; `identity` is the file's footprint identity at Open (`clean`, `dirty` or `untracked`).
  - Optional in the schema, so older records stay valid; `check` requires it exactly in flow runs. A flow run's `change` is empty.

## `budget`

- `lead_tool_calls`, `subagent_calls`, `obligations_max`: non-negative integers.
- `reserve_pct`: 0–100.
- `max_depth`, `max_edges` (flow runs only; written by `new-run`): the exploration limits of `census.edges`. `check` recomputes them, and the other limits, from `scope.entries` (see `new-run`).
- `spent`: `{ lead_tool_calls, subagent_calls, subagent_tokens, lead_tokens_observed (or null), wall_clock_min }`. `subagent_tokens` is the sum of the delegation tokens that were reported. `wall_clock_min` is written by `close`: the minutes from `opened` to `closed`, to one decimal. The lead never sets it, and close replaces any value written before it. Runs closed before this rule keep their recorded value.

## `snapshot`

`{ reconstructible, tracked_key, untracked_key, tracked_complete, discovery_complete, untracked_complete, limitations, repos }`, written by the helper.

**Strict read-only Git.** The helper never lets git run an external program or write:
- every configured filter driver (`filter.<name>.clean`, `smudge`, `process`) is disabled for each `status` and `diff`, with `required` off;
- fsmonitor is off, and the hooks path is one that cannot exist;
- `diff.autoRefreshIndex` is off, so `git diff` never rewrites the index;
- `--ignore-submodules=dirty` on `status` and `diff`, so git never runs inside a submodule, where that submodule's own filter drivers would not be disabled;
- lazy fetching is off (`GIT_NO_LAZY_FETCH`), so a partial clone fetches nothing: a change needing missing objects is refused. Git older than 2.44 ignores that switch, so there a partial clone (a promisor remote) is refused outright;
- `GIT_TRACE*` variables are removed and trace2 targets are off, so git writes no trace files;
- external diff and textconv are always off.

A tracked file whose comparison would need a filter is therefore recorded as **unverified** (below), never as clean or modified.

**Limits of that rule:**
- A filtered file that git finds clean by stat is clean, as in plain git.
- A touched or racily-clean filtered file whose raw bytes equal its committed blob is also reported clean. Real git differs only for a filter that changes its own output.
- Git's built-in conversions (`text`/`eol`, `ident`, `working-tree-encoding`) still apply; they run no external program.

**Repositories** are the project root when it is one, plus every directory up to two levels below it with a `.git` file or directory. Discovery skips `.nth-review/` and `node_modules/`, never follows symbolic links or junctions, and keeps repositories inside ignored directories. A `.git` that git does not accept as that directory's own repository is a limitation, not a repository. At least 1 and at most 100 repositories; more is a refusal.

Each repo:

| Field | Meaning |
|---|---|
| `path` | path or `.`; repositories are ordered `.` first, then by the bytes of their UTF-8 paths |
| `head` | a full object id; **null exactly when `unborn`** |
| `branch` | text of at most 1,024 characters, or null when detached |
| `unborn`, `is_worktree`, `is_submodule` | booleans. A worktree's git directory differs from its common directory. A submodule is registered in its superproject's index. |
| `porcelain_sha256` | the `git status --porcelain=v2 -z --no-renames --untracked-files=no --ignore-submodules=dirty` entries, without branch headers. A submodule shows only commit changes here; its working tree is covered by its own snapshot. |
| `staged_sha256` | the entries with a staged change; they carry the index blob ids |
| `unstaged_sha256` | each entry with an unstaged change, with the working-tree content identity: sha256 of the file bytes, or of the link text for a symbolic link; a submodule's checked-out commit. Git filters are not applied. |
| `unverified` | `{ filter, secret, unreadable, sha256 }`: tracked entries with an unstaged change that are **not verified**, by reason, and a digest of path, reason and identity. See below. |
| `flagged` | `{ count, sha256, hashed, missing, sparse, skipped }`: tracked files marked **assume-unchanged** or **skip-worktree** (`ls-files -v`), which `status` never compares, so an edit to one would otherwise go unseen. See below. Absent in snapshots written before `tracked-key@3`. |
| `untracked` | see below |

**Unverified tracked entries:**
- **`filter`:** git reported a working-tree change for a file whose `filter` attribute names a configured driver. Without the driver, git compared raw bytes with a cleaned blob, so the report is uncertain. The entry stays out of `porcelain_sha256`, `staged_sha256` and `unstaged_sha256`, except its staged side when it has one, so a mere touch never moves `tracked_key`. Its raw bytes are still hashed (read by the helper, no filter) into `unverified.sha256`.
- **`secret`:** a tracked secret file with an unstaged change. Its content is never read.
- **`unreadable`:** a tracked file with an unstaged change that cannot be read, or is reached through a link.

**`flagged`** (since `tracked-key@3`): every assume-unchanged entry (a lower-case `ls-files -v` tag) or skip-worktree entry (`S` or `s`), minus `.nth-review/`. Each is observed in its working tree, without git:
- `hashed`: read as raw bytes, or the link text for a symbolic link. No git conversion is used, so no filter can run. Where git tracks the executable bit (`core.fileMode`, true by default), the bit is part of the identity, so a `chmod` is seen as `status` would see it.
- `missing`: an assume-unchanged file that is not in the working tree (a deletion).
- `sparse`: a skip-worktree file that is not in the working tree (a sparse checkout).
- `skipped`: `{ secret, size, budget, link, unreadable }`, not read. The reasons are as for untracked files; a flagged file is checked against its own budget of 5,000 files, 1 MiB each and 64 MiB in total, shared by all repositories. Each skip is a `flagged-not-hashed` limitation.

`hashed`, `missing`, `sparse` and all `skipped` add up to `count`. `sha256` is the digest of every entry's flag, observed state (the content identity, or the reason it was not read) and path. A content edit, a flag set, cleared or switched, a deletion and a reappearance all change it.

Every digest is sha256 hex over entries sorted by path bytes. A clean repository has the digest of empty input. Entries under the repository's top-level `.nth-review/` are left out everywhere. A tracked file with an unstaged change is read in full, whatever its size. A `git status` or untracked listing larger than 64 MiB fails the snapshot; ignore rules or a narrower `--root` are the remedy.

**`untracked`** covers `git ls-files --others --exclude-standard`, minus `.nth-review/`, minus this integration's installed files in the root repository (`.claude/skills/nth-review/` and `.claude/nth-dev-kit-hooks/review.state.json`, exact case, files only: a tracked copy counts as tracked state, and a repository at that path still counts), and minus the discovered repositories inside this one:

| Field | Meaning |
|---|---|
| `count` | number of untracked entries |
| `list_sha256` | digest of the full list of names (never capped) |
| `sample` | the first 50 paths records can store, in byte order |
| `content_sha256` | digest of `path` + content identity for every hashed file: a content change shows here even when the list does not change |
| `hashed` | files whose content is in `content_sha256` |
| `skipped` | `{ secret, size, budget, repository, link, unreadable }`: files whose content was **not** hashed, by reason. `hashed` plus all `skipped` equals `count`. |

The `skipped` reasons:
- `secret`: the name matches the secret list below; never opened.
- `size`: larger than 1 MiB.
- `budget`: beyond 5,000 files examined or 64 MiB read. These limits are shared by all repositories, in snapshot order.
- `repository`: a repository git does not descend into (deeper than discovery).
- `link`: reached through a symbolic link or junction.
- `unreadable`: vanished, unreadable, not a regular file, or a name that is not UTF-8.

**Secret names** (case-insensitive; `*` is any text): `.env`, `.env.*`, `*.env`, `.envrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `*.gpg`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `.git-credentials`, `credentials`, `credentials.*`, `secrets.*`, `*.secret`, `*.secrets`, `*.tfvars`, `*.tfstate`, `*.tfstate.*`. Files below a `.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube` or `.docker` directory are also secret. The helper never opens these files, tracked or untracked. Their names are still listed and counted.

**`limitations`** (at most 100, sorted by path bytes, then code) say what the snapshot does not cover. `path` is the nearest path records can store:

| Code | Meaning |
|---|---|
| `root-not-a-repository` | the root is not a repository; files outside the discovered repositories are not covered |
| `enclosing-repository` | the root is inside a repository whose top is above the root; that repository is not covered |
| `not-a-repository` | a `.git` that git does not accept as that directory's repository |
| `symlink-skipped` | a symbolic link or junction to a repository, not followed |
| `unreadable-directory` | a directory discovery could not list |
| `undecodable-directory` | a directory whose name is not valid UTF-8 (POSIX) or holds a lone surrogate (Windows); it is not scanned |
| `unrepresentable-path` | a repository whose path records cannot store (for example, it contains `#`) |
| `scan-limit` | discovery stopped after 20,000 directories |
| `secret-not-hashed` | a tracked secret file with an unstaged change: its content changes are not detected |
| `file-not-hashed` | a tracked file with an unstaged change that could not be read, or is reached through a link |
| `filter-not-run` | a tracked file whose working-tree comparison needs a filter driver, which never runs |
| `submodule-not-covered` | a submodule that is not a discovered repository (deeper than two levels): its working tree is not checked, because the superproject's status never runs git inside submodules. A submodule is any gitlink in the index, with or without a `.gitmodules` entry (an embedded repository added with `git add`) |
| `flagged-not-hashed` | an assume-unchanged or skip-worktree file whose content was not read (secret, size, budget, link or unreadable): its content changes are not detected |
| `truncated` | more than 100 limitations: the list keeps the first 99, then this entry (path `.`) |

**Keys and coverage flags:**
- **`tracked_key`** (`tracked-key@3`) is the sha256 over every repository's path, `head`, `branch`, `unborn`, `is_worktree`, `is_submodule`, `porcelain_sha256`, `staged_sha256`, `unstaged_sha256`, `flagged.count` and `flagged.sha256`.
  - A changed repository set therefore changes it (C7).
  - So does an edit to a flagged file, although `git status` shows nothing.
  - Nothing untracked changes it: names, content, skip counts and `limitations` are all outside the key, and so is a write under `.nth-review/`.
- **`untracked_key`** is the sha256 over every repository's path and `untracked` fields except `sample`, under the version `untracked-key@2`. A content-only change to a hashed untracked file changes it. Snapshots before @2 counted the integration's installed files; a key from @1 compared with one from @2 gives untracked `changed`, so the lead reassesses (never abandons).
- **`tracked_complete`** is true exactly when no repository has unverified tracked entries or skipped flagged files.
- **`untracked_complete`** is true exactly when every untracked file was hashed (`hashed = count` in every repository). When it is false, equal keys do not prove the skipped files are unchanged: they stay **unverified**.
- **`discovery_complete`** is false when a limitation is `scan-limit`, `unreadable-directory`, `undecodable-directory`, `unrepresentable-path` or `submodule-not-covered`. Then the repository list is not exhaustive, and no obligation may claim `all-enumerated` coverage (`check`).
- **`reconstructible`** is true when discovery is complete, tracked state is complete, and every repository has no status entries, no untracked files and no flagged file in the working tree. Only `sparse` entries are allowed, because a present flagged file is never shown to match its commit.

`check` refuses flags that claim more than the counts and limitations show.

**On resume** (decision C5, as adjusted), the two snapshots compare as follows:
- **Tracked state changed** (`tracked_key` differs): the run is abandoned.
- **Tracked state unverified** (equal keys, but an unverified tracked entry on either side): the run continues, with scope reassessed. Equal keys prove nothing about content that was never compared. The exception is when every unverified entry was observed (`filter` only) and both sides' `unverified` are identical: the bytes did not change in between, and the state is equal.
- **Untracked state or coverage changed**, or cannot be verified because hashing or discovery was partial: the run continues, but scope and census are reassessed for the affected repositories.
- **Otherwise:** the run continues.
- **A skipped flagged file** (`flagged.skipped`) counts as an unverified tracked entry: equal keys then give `unverified`, never `equal`.
- **A snapshot written before `tracked-key@3`** has no `flagged`. Both sides are then compared on the @2 fields only:
  - a difference there is `changed`;
  - otherwise the result is `unverified` (reassess) and **never `equal`**, because the old snapshot never looked at flagged files.
  - Closed runs keep their snapshots unchanged.

The helper's `compareSnapshots` implements this comparison. `resume` adds one rule: a cited file whose state is untracked, absent or unverified, in a repository whose untracked or unverified state changed, forces abandon.

## `checks`

`[{ command, cwd, result, proves, not_proven }]`: deterministic checks run, and what each does and does not prove.

## `census`

- **`recipes`:** `[{ id: C<n>, pattern, scope, hits, limits }]`.
- **`items`:** `[{ id, path, mechanism, status, reason, affects }]`.
  - `path` may be `.` or a group using `*`/`?`.
  - `status`: `classified` · `unknown` · `excluded`.
  - `reason`: required for `unknown` and `excluded`.
  - `affects`: obligation ids, or null. In an Incremental run, every changed file needs an item; this is enforced by `check`.
  - An `unknown` item whose `affects` is null or empty has no established relationship, so it bears on **every** obligation: no concluded one may then claim `all-enumerated`. Name the obligations it could belong to, to scope it. An `excluded` item that names an obligation takes that obligation's `all-enumerated` claim away (C13).
- **`edges`** (flow runs only; the lead's): `[{ id, from, to, kind, evidence, status, reason, affects }]`, the execution paths recorded from the entries. Optional in the schema; `check` requires it exactly in flow runs.
  - `id` is `G<n>`. `from` is an entry id (`E<n>`), or an earlier edge id meaning that edge's target: the graph only expands forward, so it has no cycle and every edge has a depth (an entry's edges are at depth 1).
  - A node is a code location: one file, with overlapping lines (or no lines). An edge into a node already reached (an entry, or an earlier edge's target) is still a real relationship, recorded as `classified` (a cycle, or a shared dependency), but nothing expands from it: each node is explored once, from the first edge that reached it. Recording such an edge as `excluded` is refused.
  - `to`: the target anchor (prefer a line anchor: `#` is a Markdown heading), or null when it cannot be resolved statically.
  - `kind`: `route` · `call` · `data` · `event` · `job` · `dynamic` · `external` · `guard` · `error`.
  - `evidence`: the anchor where the relationship is in the source (the call, registration, publish or query).
  - `status` and `affects` as for items: `classified` (covered: a target, and the obligations covering it), `excluded` (with the reason it is out of scope; never for a node already reached), or `unknown` (with the next validation step in `reason`).
  - Unknown edges bear on `all-enumerated` claims as unknown items do, and also on every obligation covering an edge on their path from the entry (the frontier lies inside its population). Reaching `max_edges` bears on every obligation.

## `obligations`

| Field | Values |
|---|---|
| `id`, `checks` (1–20) | ids |
| `claim`, `acceptance` | non-empty text |
| `scope`, `coverage_method` | text |
| `coverage` | `all-enumerated` · `named-subset` · `sample` · `excluded` |
| `status` | `held` · `violated` · `open` · `accepted` · `out-of-scope` |
| `open_reason` | `needs-runtime` · `needs-owner-intent` · `needs-owner-fact` · `budget` · `frontier` · `verification`. **Required exactly when `status` is `open`.** |
| `source_trace` | `consistent` · `inconsistent` · `not-traced` |
| `evidence` | `[{ anchor, note }]` |
| `intent` | intent ids |
| `links` | finding, obligation or debt ids |

**`assumptions`:** what the claim relies on. All five keys are always present:

| `kind` | `anchor` | `fact` | `observed` |
|---|---|---|---|
| `dependency`: a helper, guard or boundary contract in the repository. **Cite it, so a change to it reopens the obligation.** | a valid anchor | null | null |
| `environment`: a fact outside Git (process count, configuration held in the database, a deployed setting) | null | non-empty text | `yes` · `no` · `unknown` |

Both kinds also carry a `note`.

## `findings`

| Field | Values |
|---|---|
| `id`, `fingerprint` | the fingerprint is stable for one root cause across runs |
| `kind` | `defect` · `risk` · `doc-drift` |
| `verdict` | `candidate` · `confirmed` · `needs_validation` · `rejected`. `confirmed` rests on the source alone; a claim that holds only if a fact outside the source holds (deployment, configuration, runtime behaviour, data, owner knowledge) is `needs_validation`, and its `validation_plan` names that fact. |
| `severity` | `critical` · `high` · `medium` · `low` · `informational`, or null |
| `impact_dimension` | `security` · `privacy` · `data-integrity` · `financial` · `availability` · `correctness` · `operability` · `maintainability`, or null |
| `obligation` | obligation id, or null |
| `summary` | non-empty text |
| `trace` | `[{ role, anchor, note }]`; role is `entrypoint` · `propagation` · `sink` |
| `counterevidence` | `[{ anchor (or null), note }]` |
| `validation_plan` | text, or null |
| `decision` | at close: `pending` · `fix` · `accept` · `false-positive` · `known-item`. Later owner decisions go to the namespace's `decisions.json`, never into a closed run. |

**`verification`:**
- `role`: `R5` · `R6` · `none`.
- `model`: `opus` · `sonnet`, or null.
- `outcome`: `confirmed` · `corrected` · `needs_validation` · `rejected`, or null.
- `corrections`: text, or null.
- `incomplete`: boolean.

Which combinations are allowed (for example, a `confirmed` defect needs a completed verification) is checked by `check`, not by this schema.

## `debt`

**`in`:** `[{ id, from_run, disposition, note }]`, the items inherited from the immediate `base` or `continues` run.
- `disposition`: `discharged` · `carried` · `obsolete`, or null.
- **While the run is `open`, a disposition may stay null. A closed run needs one for every item.**
- `discharged` and `obsolete` need a `note` saying why.

**`out`:** `[{ id, kind, refs, requires, priority }]`. A carried item reappears here with the same id.
- `kind`: `runtime` · `owner-decision` · `owner-fact` · `deferred-scope` · `frontier` · `verification` · `budget`.
- `priority`: `high` · `medium` · `low`.

## `delegations`

`[{ role, agent, model, effort, budget_calls, tool_uses, tokens, completed, recovery_messages, discovered? }]`

| Field | Values |
|---|---|
| `role` | `R2` · `R3` · `R4` · `R5` · `R6` · `R7` |
| `agent` | `Explore` · `reviewer` · `verifier` (`reviewer` is the bundled `nth-review:reviewer`, [routing.md](routing.md)) |
| `model` | `opus` · `sonnet`: no other model may be recorded |
| `effort` | `high`, or null |
| `tool_uses`, `tokens` | integers from the delegate's task notification, or null when it was not observed (never 0 for unknown) |
| `recovery_messages` | 0–5 |
| `discovered` | optional: repository-relative paths the delegate's answer named that no census item covered (at most 200). Before close, each needs a census disposition (see `check` rules). Older records without it stay valid. |

## `footprint` and `freshness`

**`footprint`** maps every **cited** file to `{ blob, state, reason }`. It is written by `footprint --run <dir>` while the run is open, and is always computed again by `close`.

**Cited files** are those named by anchors in:
- intent;
- evidence;
- dependency assumptions;
- finding traces;
- counterevidence.

`path:L1-L2` and `path#Heading` cite `path`. Unit `scope` and `basis` are never cited: they describe the audit plan, not the evidence of this run. Dependency assumptions stay in the footprint so that a change to a helper or contract an obligation relies on can reopen it (C11).

Each path is resolved once, in its owning repository, which is the longest repository path of the run's snapshot that prefixes it (C8). A cited path inside none of them is an error (exit 1). So is a cited `untracked` copy of this integration's installed files in the root repository (see `untracked`): no snapshot covers it, so nothing could invalidate a conclusion resting on it. A tracked copy can be cited. In a flow run, a cited file that Git ignores (other than an entry file, which close re-resolves) is also an error: no snapshot covers it, so a change to it could never be seen.

| `state` | `blob` | Meaning |
|---|---|---|
| `clean` | the committed blob | tracked; the working tree equals the index, and nothing is staged |
| `dirty` | the working-tree blob | tracked, with a staged or unstaged change, or unmerged |
| `untracked` | the working-tree blob | exists, not in the index (including ignored files and the new name of a rename) |
| `absent` | null | the file does not exist (deleted, renamed away, or never there) |
| `unverified` | null | the helper cannot or must not establish the identity; `reason` says why |

Blobs come from `git hash-object` with git's own conversions (`text`/`eol`, `ident`) but **no filter driver**, so they are comparable with committed blobs. The index is read with `ls-files --stage`, and staged changes with `status` limited to the cited paths. Nothing is written but the run's own `records.json`.

`reason` is null except for `unverified`:
- `filter`: the file's `filter` attribute names a configured driver, which never runs, so its blob cannot be computed;
- `secret`: the name matches the secret list; the file is never opened;
- `link`: the path is a symbolic link, or is reached through one or through a junction (including a repository directory replaced by one since Open);
- `unreadable`: not a regular file, or could not be read (a failing `hash-object` batch is retried path by path);
- `case-mismatch`: the path exists only under a different letter case (a case-insensitive file system), so git's view of it cannot be told;
- `nested-repository`: the file is inside another repository that the snapshot does not cover;
- `repository-unavailable`: the owning repository is gone;
- `source-changed`: written by `close --reason snapshot-changed` for every path in a repository whose tracked state changed since Open. The current identity is not the one the evidence was taken from.

An `unverified` path is never treated as clean, current or absent. Later runs must reassess anything that cites it.

`check` requires a `complete` or `incomplete` run's footprint to have exactly one entry per cited file.

**`freshness`** is written by `fresh` in Incremental runs, otherwise null, and `close` validates it. It is `{ base_run, repos, changed_files, obligations }`:
- `repos[].outcome`: `equal` · `ancestor` · `diverged` · `base-missing` · `base-dirty`.
- `changed_files[]` is `{ path, change, from }`.
  - `change`: `added` · `modified` · `deleted` · `renamed` · `transient` · `untracked`.
  - `from` is set exactly when `renamed`.
- `obligations[]` is `{ id, class, reason, origin? }`, one per obligation of the **effective baseline** (see `fresh`), with class `touched` · `file-changed` · `assumption-changed` · `current`. `origin` is the run that last recorded the obligation, written only when it is not `base_run`. Records without `origin` stay valid.

## `fresh`

`fresh --run <dir>` prioritizes the obligations of the run's **effective baseline** against the tree now. It writes `freshness` into the open Incremental run's `records.json`, atomically, and nothing else. It never says an obligation holds, and never sets `assumption-changed`.

**Effective baseline.** The latest recorded version of every obligation inherited through the base ancestry:
- It starts at the base, and follows `run.base` only while the run is `incremental`: a task run is a full baseline. `continues` and abandoned runs are never followed; an abandoned run's work reaches its continuation through debt (C5).
- The nearest run that records an id is that obligation's **origin**, and its version is the authoritative one. So an obligation that stayed `current` (not recorded again) in one run is still reviewed by every later run, and unchanged obligations are never copied forward.
- Every ancestor is validated like a base: a run of the same namespace, with valid records naming it, `complete` or `incomplete`, and not an audit run. No ancestor's `freshness` is read.
- Bounds: at most 100 runs in the ancestry, and at most 2,000 obligations.
- `new-run` resolves it at Open (so `resume` does too), and the Incremental obligation cap is its size + 15.

**Refused** (exit 2, nothing written) when:
- the run is not open;
- the run is not `incremental`;
- the base, or any ancestor of the effective baseline, is missing, invalid, from another namespace, open, abandoned or an audit run, or the ancestry loops, is longer than 100 runs or holds more than 2,000 obligations. The refusal names the ancestor; the way out is a new Task Review baseline;
- the tracked source changed since the run's Open snapshot (resume instead);
- more than 10,000 files changed;
- a changed file has a name a record cannot hold (`:`, `#`, `*`, `?`, a trailing dot or space, or not UTF-8).

**Inputs:**
- the base run's Open snapshot and closed footprint, for the history outcomes and changed files;
- for each obligation, its **origin** run's Open snapshot, closed footprint (the identity of every cited file there), intent sections and findings. Each anchor is decided against the origin; "base" below means the origin, and a reason names a non-base origin as `origin <run-id>`;
- a snapshot now;
- read-only Git (`git.mjs`).

Each run recomputes everything, and two runs on the same tree write the same bytes. An `assumption-changed` entry (the lead's, from facts outside Git) is kept, with its reason and the resolved origin, while its obligation is in the effective baseline.

**History outcome per repository** (C10). The repositories are those of either snapshot. B is the base head; H is the head now. The first match wins:

| Outcome | When |
|---|---|
| `base-missing` | the repository is gone now, or new since the base, or was unborn at base, or B is not in it any more (`cat-file -e`: rewritten or pruned history) |
| `base-dirty` | the base snapshot had uncommitted tracked changes, untracked files or unverified tracked entries in it, so its commit cannot reproduce the reviewed state |
| `equal` | B = H (history only: working changes are in `changed_files`) |
| `ancestor` | B is an ancestor of H |
| `diverged` | otherwise (both present) |

**`changed_files`** lists every file that differs from the base, per repository present now:
- **Base commit present:**
  - committed and staged changes come from `diff --cached --raw -M B` (objects only, renames detected);
  - unstaged changes come from `status` (content compared in memory; the index is never written);
  - untracked files come from `ls-files --others --exclude-standard`, minus the integration's installed files in the root repository (as in `untracked`). They are listed every run, because the base snapshot holds only their digest.
- A staged rename whose new name was then deleted from the working tree is `deleted` (of the old name).
- An addition that is absent again is not a change.
- **`transient`:** a path added or deleted inside B..H (`log --name-status`) that is absent at both ends.
- **`base-missing` repository:** every indexed file is `added`, and every untracked file is `untracked`.
- **A cited file** whose base and current identities are both known and differ is listed even when Git shows nothing (a file dirty at base, restored since).
- **Entries Git is told not to look at** (`assume-unchanged`, `skip-worktree`; `ls-files -v`) never appear in `status`, so their working-tree content is compared with the index entry by hash:
  - a difference, or content that cannot be verified, is `modified`;
  - an assume-unchanged file that is missing is `deleted`;
  - a skip-worktree file that is missing (sparse checkout) is not a change.

**Obligation classes.** An obligation's anchors are:
- its evidence;
- its **dependency assumptions**, which are how a changed helper reaches an obligation whose endpoint is unchanged;
- its intent sections;
- the trace and counterevidence of its findings.

Each anchor is decided in this order, and the first match wins:
1. **Touched** when:
   - its owning repository changed, or none holds it now;
   - its repository is `base-missing`;
   - the base or the current identity is `unverified`;
   - it was added, renamed (`renamed to <path>`) or deleted;
   - it was absent at the base and is absent now: evidence on a file that never existed was never verified (v1.0 RC; before it, such an obligation stayed `current`).
2. **Unchanged blob:** `current`, or `file-changed` when only the file mode or type changed.
3. **Whole-file or `#Heading` anchor** whose content changed: `touched`.
4. **Line anchor:** hunks in base line numbers.
   - Base and current blobs are compared blob to blob when both are in the object database; otherwise the base commit's file is compared with the working tree.
   - A hunk within **3 lines** of the cited range is `touched`. A pure insertion after line `n` touches lines `n` and `n + 1`. Other hunks are `file-changed`.
   - Base content that Git never stored (dirty or untracked at base), binary content, or content that cannot be compared is `touched`.

Whitespace-only hunks count.

**Class per obligation:**
- An obligation whose origin version is `open` was never concluded: `touched` ("open in <origin>; never concluded").
- `touched` beats `file-changed`, which beats `current`.
- An obligation with no file anchor is `touched`.
- `reason` names the deciding anchors as `<role> <anchor>: <why>`; for `current`, it is "N cited files unchanged".

**Limits:**
- A helper the obligation never cited reaches the lead only through `changed_files` and its census item (C11).
- Heading anchors cover the whole file.
- In a `base-dirty` repository, `changed_files` is relative to the base **commit**:
  - an uncited file that was dirty at base and has been restored since is not listed;
  - the outcome tells the lead that the reviewed base state cannot be reproduced;
  - a mode change is likewise seen against the base commit.
- **Recovery:** while `fresh` refuses (a tracked change since Open, an unrecordable name, too many changes), the run cannot close, because `check` requires `freshness`. The way out is to abandon it through `resume` (M2-T5).

**Git safety:** every call is allowlisted and read-only:
- filter drivers are disabled, and `--no-ext-diff --no-textconv` is forced;
- fsmonitor and hooks are off, there is no signature program (`log.showSignature=false`), and there is no lazy fetch;
- the diff algorithm, rename limit, hunk merging and `log.showRoot` are pinned;
- nothing is written under `.git/`.

## `apply`

`apply --run <run_dir>` is how the lead writes `records.json`. The lead writes `<run_dir>/patch.json` (UTF-8 without BOM, at most 5 MiB); `apply` applies it in memory, validates the result, writes `records.json` atomically, removes `patch.json` and runs `check`.

```json
{ "schema": "nth-review/patch@1", "base": "<records_sha256>",
  "ops": [{ "op": "set", "path": "/obligations/OB-1/status", "value": "held" },
          { "op": "add", "path": "/census/items", "value": { "id": "CI-9", "…": "…" } },
          { "op": "remove", "path": "/census/items/CI-3" }] }
```

- **`base`** is the sha256 of `records.json` as the helper last printed it (`records_sha256` from `new-run`, `apply`, `check`, `footprint` and `fresh`, and from a failing `check` or `apply`). Any other value is **stale** and refused: records.json changed since the patch was built.
- **`path`** is `/`-separated (JSON Pointer escapes `~0`, `~1`). In an array, a segment is an item's `id` when its items have ids, else its index.
- **Ops** (at most 500, applied in order): `set` replaces a value or sets an object key; `add` appends to an array (an `id` already present is refused: use `set`); `remove` deletes an array item.
- **Lead fields only:** `run.runtime`; `scope.summary` and `scope.intent` (and `scope.units` in a plan run); `census`, `obligations`, `findings`, `delegations` and `checks` (items and fields, or `add` to the list; never the whole section); `debt.out`; a `debt.in` item's `disposition` and `note`; `budget.spent` fields except `wall_clock_min`; a `freshness` class set to `assumption-changed`, with its `reason`. Everything else (the rest of `run`, `scope.change`, `snapshot`, the budget limits, `footprint`, the rest of `freshness`) is refused.
- **Refused, with nothing written** (exit 1, the patch stays for the lead to fix): a stale `base`; a malformed patch; an unknown op or path; a protected field; records that would not pass the schema. A closed run is never written (exit 2).
- **Result:** `applied` (the op count), the new `records_sha256`, and `check` (`valid`, `errors`, `warnings`). An empty `ops` only removes `patch.json`.
- **A failing `check` does not undo the write:** an open run's records may fail `check` midway; `apply` still exits 0 and returns the failures, and `close` refuses until they are fixed.
- **Interrupted `apply`:** a crash after the write and before the removal leaves `records.json` updated and `patch.json` with the old `base`. The next `apply` refuses it as stale, so it is never applied twice. Resending a batch is not idempotent (items without an `id` are appended again; index paths shift), so read `records.json` first, and clear an already-written batch with an empty `ops` on the current digest.
- **One helper command on a run at a time:** `apply`, `fresh`, `footprint`, `close` and `resume --apply` each read, validate and replace `records.json`, with no lock between them (only `decisions.json` is locked). Two at once on one run may lose one's write.

## `new-run`

`new-run --ns <ns> --mode <mode> --slug <slug> [--base <run-id>] [--continues <run-id>] [--change <repo> | <repo>:<a>..<b>]… [--unit <id>] [--entry <selector>]…` writes the skeleton: status `open`, the snapshot, the budget, the required lead model and the inherited debt. Everything else starts empty. It refuses (exit 2), leaving nothing behind, when:
- the namespace, mode or slug is invalid, or the mode does not fit the namespace: `reviews/` takes `task`, `incremental` and `flow`; `audits/` takes `audit-plan` and `audit-unit`; `experiments/` takes all five;
- a `flow` run has `--change` or `--base`, no `--entry`, or an entry that does not resolve (see Flow entries); another mode has `--entry`. A flow run and a run of another mode never build on each other (base or continues), and a flow run continues only an abandoned flow run (resume);
- the namespace is `audits/…` while official audits are disabled, or without a complete owner `charter.json` for that namespace. A charter is written only by `charter`; `new-run` never creates one;
- another run in the namespace is `open` (continue it, or use `resume`), or a run there cannot be read;
- `--base` or `--continues` is not a run id of the same namespace (the legacy top-level `runs/` never is), fails validation, or is open. A base must be `complete` or `incomplete`; a continued run may also be `abandoned`. Audit runs build only on audit runs, other runs only on other runs.
- an `abandoned` run in the namespace has no run continuing it (an interrupted `resume --apply`), unless this run is its continuation. `resume --apply` opens it, so the abandoned run's carried work is never left behind.
- `incremental` or `audit-unit` has no `--base`, or `--unit` does not name a unit of the base's ledger (`close`, the audit close, needs none);
- **Full Audit** (C20): the audit chain would fork or get a second root. The base must be the chain head: the closed audit run no other closed audit run builds on. A unit is refused unless it is `planned` or `incomplete` in the base's ledger, classified (a tier and a basis), with every unit in its `depends_on` `complete`. `--continues` names only the abandoned run this run carries on (same mode, base and unit, as `resume` opens it): any other parent would take debt-in past the chain head and drop its debt (C4);
- a `task` run has no `--change` (an unsized task would get the smallest budget and a Sonnet lead);
- a `--change` names an unknown repository or a revision that is not a commit;
- the run id already exists.

**Debt-in** is the complete debt-out of the immediate parent: the `--continues` run when given, else the `--base` run. Each item has `from_run` set to that parent and a null disposition.

**Units ledger:** audit runs copy it from their base.

**Size** comes from `git diff --numstat`:
- `<repo>:<a>..<b>` counts that committed range;
- `<repo>` counts its working tree against HEAD, plus its untracked files as files. Their lines are never read (an untracked file may be a secret), so a working-tree change with untracked files gives `size.verified: false` (v1.0 RC; before it, twelve new 1,000-line files sized as S);
- an Incremental run without `--change` counts each repository's working tree against its commit in the base snapshot. The size is unknown when that commit is gone or the repository is new.

Paths under `.nth-review/`, and the integration's untracked installed files in the root repository, are never counted. A range is its net diff, never the sum of its commits. For a file with a filter attribute, lines would compare raw bytes with the cleaned blob (filters never run). So a working-tree change in a repository with unverified filtered entries gives `size.verified: false`. A task then gets the M budget and `opus-high` (size class `unverified`); an Incremental run gets the 80-call cap.

Assume-unchanged and skip-worktree files are invisible to `git diff`, so an edit to one is never counted. A working-tree size (`<repo>`, or an Incremental run without `--change`) in a repository whose snapshot shows a flagged file present, deleted or not read is therefore also `size.verified: false`, with the same budget and lead. That is `flagged.hashed + missing + skipped > 0`; sparse entries are absent by design and excepted. A committed range is exact and unaffected. **An uncertain size is never classified as small** (owner decision, 2026-10-26). A range whose objects are missing from a partial clone is refused: nothing is fetched. Files are counted once per repository; lines are summed over the `--change` specs. In a repository with no commit yet, staged and unstaged lines are added together.

| Mode | Lead tool calls | Subagent calls | `obligations_max` | Required lead |
|---|---|---|---|---|
| `task` S (≤ 400 lines and ≤ 15 files) | 40 | 3 | 15 | `sonnet` |
| `task` M (≤ 1,500 lines and ≤ 40 files) | 70 | 5 | 30 | `opus-high`, trigger `task-size` |
| `task` larger (L) | 70 | 5 | 30 | `opus-high`, trigger `task-size` |
| `incremental` | 20 + 2 per changed file + 3 per debt-in item, at most 80 (80 when the size is unknown) | 3 | effective-baseline obligations + 15 | `opus-high` (Sonnet needs `fresh` results, which come later) |
| `audit-plan` | 50 | 2 | 0 | `opus-high` |
| `audit-unit` | 60 | 4 | 25 | `opus-high` |
| `flow` | 60 + 10 per entry after the first, at most 90 | 5 | 20 + 5 per entry after the first, at most 40 | `opus-high` |

`reserve_pct` is 30. The values are initial; V-COST calibrates them.

A flow run has no change size: its budget comes from its entries, and it always requires `opus-high`, because a small entry can reach money, authorization or persistence code. Its limits are `max_depth` 4 and `max_edges` 40 + 20 per entry after the first + 20 per entry repository after the first, at most 120.

## `preview`

`preview` takes exactly the options of `new-run` and shows what it would open: the size, the budget, the required lead model, the triggers, the debt-in count, a flow run's resolved entries and the snapshot's limitations. It refuses whatever `new-run` refuses, with the same message. It writes nothing: no run directory, no records, and Git only read-only, without optional locks. The result adds `writes: "nothing"`, `start` (the Claude Code commands the required lead allows: `claude --model opus --effort high`, plus `claude --model sonnet` for `sonnet`) and a `note`: `new-run` sizes the source again when it opens and assigns the run id, and a trigger the lead finds at Plan raises `sonnet` to `opus-high`. It has no `run_dir` or `run_id`. The budget caps tool calls, not money; review.md lists observed costs.

## Flow entries

A selector is `<path>#<Symbol>`, `<path>:<line>` or `<path>:<from>-<to>`. The path is project-root-relative, starting with its repository directory. `resolve --entry <selector>…` prints the resolution (read-only; it opens nothing); `new-run --mode flow` resolves the same way after its snapshot and refuses on any problem, writing nothing. Resolution needs no Git history and never guesses:
- the file must exist in a discovered repository and be `clean`, `dirty` or `untracked`; a secret, link, filtered, case-mismatched or missing file is refused, and so are `.nth-review/` and this integration's untracked installed files;
- a line selector must lie within the file; a bare path is refused (a whole file is not an entry point);
- `Symbol` is an identifier, or `Container.member` (the member inside the container's indented block). It matches definitions only, by a per-language pattern table: `.js` `.mjs` `.cjs` `.jsx` `.ts` `.tsx` `.mts` `.cts` (function, class, const or let binding, method, object property), `.py`, `.go`, `.rs`, `.rb`, `.php`, `.kt` `.kts`, `.java` and `.cs` (a method needs a modifier). Other files take line selectors. No match, or more than one, is refused, listing the candidate lines;
- the resolved lines run from the definition through its signature (which may span lines: it ends where its parentheses close) to the end of its indented block; a JavaScript or TypeScript method whose parameters span lines counts as a definition only when the line that closes them opens a body, so a call is never one; two selectors resolving to the same lines are refused; at most 8 entries.

## `pack`

`pack --run <dir> --for <finding or obligation id> [--anchor <anchor>]…` writes the evidence pack `packs/<id>.md` of an **open** run (protocol §6). Writing it again replaces it.

**Contents:**
- the claim:
  - for a finding: its summary, kind, severity and impact, plus its obligation's claim and acceptance;
  - for an obligation: its claim, scope, acceptance and coverage;
- numbered excerpts of the item's anchors, in this order:
  - a finding's trace, or an obligation's evidence and dependency assumptions;
  - in a flow run, the `evidence` and `to` of each edge whose `affects` names the item's obligation (shown as `edge G<n> <kind>`), so a delegate starts from the recorded paths;
- for a finding whose `impact_dimension` is `security` or `privacy`, or whose obligation has an `AUTHN`, `AUTHZ`, `INJECT`, `LLM`, `WEB-SESSION` or `INTEGRATION` check (the family, the module or one of its checks) or `RESOURCE.2`: a **Boundary test** before the excerpts, never cut by the size cap. It asks for the actor, the failing control, what is crossed beyond the actor's own permissions, and what the trace reaches, and adds a model-path line (an `LLM` check), a cost line (`RESOURCE.2` or `LLM.4`) and a scope line (`AUTHZ.2`, `AUTHZ.4` or `OBJSTORE.1`). It holds questions only, no verdict. Obligation packs and other findings never get it;
  - any `--anchor` extras;
  - the intent of the item's obligation.

A pack never shows a verdict, a verification, its corrections or counterevidence, so a refuter sees no earlier conclusion.

**Limits:**
- at most 10 anchors;
- 15 lines per anchor, centred on the cited range:
  - the middle 15 lines of a longer range;
  - a `#Heading` from the heading line;
  - a whole-file anchor from line 1;
- lines cut at 300 characters;
- 6 KB in total. The last excerpts are shortened, then dropped, to fit.

Every cut is marked in the pack: `> …` lines, and a final **Not included** list.

**Sources are read without git, and each file at most once per pack.** Excerpts are skipped, and marked, for any of these:
- a missing file;
- a binary file (NUL in the first 8 KB);
- a secret name (never opened);
- a symbolic link or a path through a junction (never followed);
- a file over 8 MiB, or one that is not a regular file;
- a range past the end of the file;
- an unknown heading.

A path whose footprint is `unverified` is marked with its reason. CRLF endings are shown as plain lines.

## `close` and `report.md`

`close --run <dir> --status complete|incomplete [--reason <incomplete reason>] [--reassessed]` is the only way an open run becomes `complete` or `incomplete` (C1). `abandoned` comes only from `resume`.

Nothing changes until every step passes. The steps, in order:
1. **Source recheck.** It takes a snapshot now and compares it with the run's Open snapshot (`compareSnapshots`):
   - **Tracked change:** refused (exit 2). The only alternative is an explicit `--status incomplete --reason snapshot-changed`.
   - **Reassessment needed:** untracked or coverage changes, or tracked or untracked state that cannot be verified. Refused (exit 2) until the lead reassesses scope and census and closes with `--reassessed`.

   The Open snapshot is **never replaced**. The result is added to `checks` as `nthr close: source recheck`, with what it proves and what it does not.

   **Incremental runs:** unless closing `incomplete` with `snapshot-changed`, `freshness` is computed again in memory. It must equal the recorded one, except that `assumption-changed` entries are the lead's. Otherwise the close is refused (exit 2): run `fresh` again, reassess, then close. A stale or hand-edited class can therefore never be closed.
   **Every mode** (v1.0 RC; before it, Flow runs only): unless closing `incomplete` with `snapshot-changed`, a cited file that may have changed unseen is refused (exit 2), and `--reassessed` does not lift it: run `resume`, which abandons the run for the same cause (`cited-untracked`). A cited file is at risk when it is untracked, absent or unverified in a repository whose untracked state differs (its untracked list or hashed content changed), or when it is unverified (unhashable) where untracked hashing was partial or the repository's tracked state is unproven, or when it is untracked and the Open snapshot may not have hashed it (its repository skipped files for the byte or file budget, or for size and this file is over the 1 MiB limit now). Any other untracked file in a repository whose untracked state is equal was hashed into an equal state at both ends, so it is not at risk. `--reassessed` covers scope and census only: without this refusal the footprint would record the edited file's new identity as the one reviewed, and a later `fresh` would call the conclusion `current`.

   **Flow runs** also refuse (exit 2), unless closing `incomplete` with `snapshot-changed`, an entry that no longer resolves exactly as at Open (same lines, same identity). This also catches an edit to a git-ignored entry file, which no snapshot sees. `resume` does not re-resolve entries, so the remedy is that explicit close, then a new flow run with checked selectors.
2. **Footprint.** It is computed again against the current tree. In a flow run it also covers the entry files and every edge's evidence and target. Every cited file of a repository whose tracked state changed, and every cited file at risk (above), is recorded `unverified` with reason `source-changed` (reachable only with an explicit `snapshot-changed` close): its identity now is not the one the evidence was taken from.
   - `close` also sets `run.closed` and computes `budget.spent.wall_clock_min` from `opened` and `closed`.
   - A clock that reads earlier than `opened` is refused (exit 2).
   - **Full Audit:** the audit close also adds, per unit with a run, a `checks` entry `nthr close: unit summary`: what that unit's last run left unresolved (open and violated obligations, confirmed defects by severity, `needs_validation`, unverified findings, risks, debt handed on), counted from its records. A unit run's own ledger unit gets the run appended to `runs`, and the status `complete`, or `incomplete` with the reason `run <id> closed incomplete (<reason>)`. At the audit close (`--unit close`), every `complete` unit is rechecked: the footprint of its last run is computed again, and if a cited file's identity changed, is unverified or absent, or that run cannot be read, the unit becomes `incomplete` with the reason. Nothing unverifiable stays complete.
3. **Check** in close mode, on the records as they will be written. A failure is exit 1, and nothing is written, not even a leftover temporary file removed.
4. **Writes.** `report.md` is written first, then `records.json` **last**. Both are atomic. If anything fails before the second write, the run stays open with the old records, and `close` can simply be run again. A temporary file left by a killed write (`.<name>.<pid>.<hex>.tmp`) is removed by the next `close` that passes every refusal check, the check included, and by `resume --apply`. A `report.md` that an interrupted close left, and an unapplied `patch.json`, in a run that `resume --apply` then abandons are removed with them, before its commit point: an abandoned run has neither, and `check` refuses either. The patch is never applied; the abandoned records are the ones carried on.

After this, every write command (`footprint`, `pack`, `close`) refuses the run.

**`report.md`** is rendered only from the records and the helper version, so it is byte-identical for the same records and the same helper. The run table names the helper (`Helper`: nthr version, protocol and records schema). Its order is:

0. **Summary** (unnumbered), before the gaps:
   - what the status means: `complete` is the method finished within its scope and `check` accepted, never a verdict on the code, and only obligations marked Verified in section 3 are Verified; `incomplete` says work remained (section 1 says what). A plan and the audit close say that no obligation there is concluded for the project, and never use the word Verified;
   - obligation counts (held, with how many are Verified, violated, open, accepted, out of scope);
   - findings: confirmed by severity (and risks), plus candidates, `needs_validation` and rejected, with the reminder that candidates and `needs_validation` findings are leads;
   - debt handed on, unknown census items, and in a flow run unknown paths;
   - **Next step:** the follow-up command (`followUpCommand`): `/nth-review incremental --ns <ns> --slug <new-slug> --base <run id>` after a Task or Incremental run; a new `/nth-review flow` with the same `--entry` selectors after a flow run (it is not a baseline); `nthr status --ns <ns>` after an audit run.
1. **Gaps:**
   - in audit runs, the audit units:
     - outside `audits/`, a first line: "Not an official audit";
     - a line scoping the report: a plan reviews no unit; a unit run concludes its unit only; the audit close says "Whole audit: complete at this snapshot" only when it is complete, every unit is complete or out of scope, and at least one unit is complete, and otherwise says why not (units not complete, no unit reviewed, the close incomplete);
     - counts, the reviewed and not reviewed units, and a table with each unit's scope, status, the last run that concluded it, and its reason;
     - at the audit close, what each unit's last run left unresolved (its `unit summary` entries).

     "Verified" is never said of the whole audit, and no obligation of a plan or of the audit close is ever shown as Verified;
   - the source state at Close;
   - snapshot coverage at Open;
   - open obligations;
   - unverified findings (candidates, `needs_validation`, incomplete verification);
   - unverified or missing evidence, including held obligations that rest on it;
   - review debt (inherited dispositions and debt handed on);
   - unknown census items;
   - untested properties (environment assumptions not observed true, untraced sources).
2. **Coverage:**
   - the scope summary and family screening, as recorded in `scope.summary` (never computed);
   - in an Incremental run, freshness against the base: the history outcome per repository, changed-file counts, and each inherited obligation's class with what this run did (re-recorded with its status, or concluded in its origin run);
   - census recipes and items, and obligation coverage.
3. **Correctness:**
   - held obligations, with their evidence method;
   - violated obligations, with their findings;
   - accepted and out-of-scope obligations.

   **"Verified"** is shown only when all of these hold (C13):
   - the obligation is held and `all-enumerated`;
   - discovery was complete;
   - the close recheck proved the tracked state and coverage equal to Open;
   - its cited evidence and dependencies are neither `unverified` nor `absent`;
   - no census item contradicts the claim: no `unknown` item names it or names no obligation, and no `excluded` item names it. Such an obligation is listed under unverified or missing evidence, even in records `check` would refuse.
4. **Findings** by severity, each with its verdict, decision, verification and trace.
5. **Delegations.**
6. **Cost:** budget against spent, with each row's source: the lead's own counts are labelled "recorded by the lead" (the helper cannot observe tool calls; only the session transcript does), the obligation count is counted from the records, and the open-to-close minutes are computed by close. When any delegation's `tokens` is null, the subagent token total is shown as a lower bound ("at least N"), naming those delegations' roles.

## `resume`

`resume --ns <ns> [--apply]` decides what happens to the namespace's open run once the source may have moved (C5). It compares the run's Open snapshot with one taken now (`compareSnapshots`). The result names `run`: the run to work in next.

**`continue`:** the tracked state is equal, and no cited file is at risk. Nothing is written.
- If untracked, coverage or unverified state differs, `reassess` names the repositories, and the lead reassesses scope and census, then closes with `--reassessed`.
- `temporary` lists leftover temporary files without removing them.

**`abandon`:** the run is abandoned when either holds:
- the tracked state changed (`cause: tracked-changed`);
- a cited file is untracked, absent or unverified in a repository whose untracked or unverified state differs (`cause: cited-untracked`).

The output gives the plan:
- the run's final fields;
- the debt carried in, handed out and generated;
- the continuation (mode, slug, unit, base, change and debt-in);
- `next`.

**Without `--apply`, nothing changes.** The plan runs the same steps as `--apply`, so it fails wherever `--apply` would.

**`--apply`**, in this order, with everything validated in memory before the first write:
1. Leftover temporary files of the run are removed.
2. The run's `records.json` becomes `abandoned` (the commit point):
   - `incomplete_reason: snapshot-changed`, `closed`, and `wall_clock_min` from `opened` and `closed`;
   - a `nthr resume: source recheck` entry in `checks`;
   - **debt**:
     - every undecided debt-in item becomes `carried` (note: "carried on abandon (resume)"), and every carried item is repeated in `debt.out` with its own id, kind, `requires` and priority;
     - the lead's own `debt.out` is kept;
     - **C5, as amended (owner decision, 2026-10-26):** a new `<run-id>/D<n>` item is added for every **carry-required** item that no `debt.out` item already refers to:
       - an `open` or `violated` obligation;
       - a `held` obligation whose evidence or dependency file has an `unverified` or `absent` footprint (an unverified claim);
       - a `held` obligation citing a file that `resume` found untracked, absent or unverified (`changed.cited`);
       - an unverified finding: `candidate`, `needs_validation`, or with an incomplete verification, whatever its verdict;
       - an inherited obligation the lead marked `assumption-changed` in `freshness` and has not re-recorded (v1.0 RC): the continuation's own `fresh` cannot find a fact outside Git again. Its item has empty `refs` (the obligation is not one of this run's) and a `requires` that names it.

       `accepted` limitations and `out-of-scope` exclusions are **resolved**: they stay in the abandoned records unchanged, as history, and are never turned into debt. The lead may still hand one on in its own `debt.out`.

     | Generated from | Kind | Priority |
     |---|---|---|
     | `open` obligation | by `open_reason`: needs-runtime → `runtime`, needs-owner-intent → `owner-decision`, needs-owner-fact → `owner-fact`, budget, frontier, verification | `medium` |
     | `violated` obligation | `verification` | `high` |
     | `held` obligation on unverified, absent or at-risk evidence | `verification` | `medium` |
     | finding (candidate, needs_validation or incomplete verification) | `verification` | `high` for critical or high severity, or a security, financial or data-integrity impact; `low` for low or informational; otherwise `medium` |
     | `assumption-changed` mark not re-recorded | `verification` | `high` |
   - Obligations, findings, snapshot, footprint and everything else stay as they were.
   - The final records must pass `check`. Otherwise the result is exit 1 and nothing is written.
3. A new run opens with `continues` set to the abandoned one:
   - same mode, slug, unit and base, and a snapshot taken now;
   - `--change` is re-derived from the run's scope, and a flow run's `--entry` selectors from its `scope.entries`, resolved again on the current source (the plan lists what they resolve to now). A symbol selector follows its definition; a line selector whose file changed since Open is refused, because its lines may now hold other code: close the run `incomplete` (`snapshot-changed`) and open a new one. An Incremental run is sized since its base again. A symbolic range such as `HEAD~1..HEAD` is evaluated against the current source, as the plan shows.
   - Its debt-in is the abandoned run's whole debt-out, undecided (C4).

An abandoned run has no `report.md` (C1: the report comes from `close`), and its records never change again.

**Interrupted `--apply`:** an abandoned run that no run continues (a crash between steps 2 and 3) is reported as `cause: interrupted`, and the next `--apply` opens its continuation.

**Refused** (exit 2, nothing changed) when:
- the namespace is `audits/…` while official audits are disabled, or without a complete owner charter: an official audit answers nothing then, not even `continue`;
- there is no open run;
- more than one run is open;
- a run of the namespace cannot be read, or its records name another run;
- an open run sits next to an abandoned run with no continuation, or two such runs exist;
- the parent chain is invalid (a base or continued run that is missing, from another namespace, invalid, open or of the wrong status, or mixes audit and non-audit modes);
- the clock reads earlier than `opened`;
- the continuation cannot be opened.

Git is read-only, as for `close`. Closed runs and other namespaces are never written.

## `decide`

`decide --ns <ns> --fingerprint <f> --decision fix|accept|false-positive|known-item --note <text> --by <name>` records an owner decision about a finding fingerprint (C2). It is run only on the user's explicit request.

**Owner decisions are records only: no nthr command acts on them, and a decision never authorizes changing code.** The `decide` and `status` output repeat this notice.

**Storage:** decisions go to `.nth-review/<ns>/decisions.json`, never into a run; closed runs stay immutable (C1). The file is `{ schema: "nth-review/decisions@1", namespace, decisions: [...] }`. It is **append-only**, and each entry has:

| Field | Meaning |
|---|---|
| `seq` | 1, 2, …: its position |
| `fingerprint` | a finding fingerprint that some run of the namespace (open runs included) has |
| `decision` | `fix` · `accept` · `false-positive` · `known-item` (`pending` is only the value at close) |
| `note` | why, required |
| `by` | who, one line of at most 128 characters |
| `date` | UTC, from the helper's clock |
| `supersedes` | the `seq` of the previous entry for the same fingerprint, or null: an earlier decision is never changed, only superseded |
| `seen_in` | `[{ run, finding }]`, sorted: where the fingerprint was found when the decision was made |

At most 10,000 entries and 5 MiB.

**Writes:**
1. The fingerprint is checked against the namespace's runs.
2. `.nth-review/<ns>/decisions.lock` is created exclusively.
3. `decisions.json` is read again under the lock, the entry is appended, and the file is written atomically.
4. The lock is removed only if it is still this writer's own.

**A second writer is refused while the lock exists** (exit 2), so no decision is ever silently lost. A lock left by a crash is never broken automatically: the message names its pid and time and tells the owner to delete it.

**Refused** (exit 2, nothing written) when:
- the fingerprint is in no readable run of the namespace (unreadable runs are named);
- the decision is outside the vocabulary;
- `--note` or `--by` is missing;
- the namespace is an audit namespace without the official-audit gate and a charter;
- the lock exists;
- the file is full (10,000 entries), or the append would take it past 5 MiB.

A lock whose own write fails is removed at once.

An existing `decisions.json` that fails validation is exit 1 and is never overwritten.

## `status`

`status [--ns <ns>]` reads one namespace, or every namespace under `.nth-review/{experiments,reviews,audits}/`, and writes nothing (not even a lock).

**Output:** deterministic, with every list sorted. Per namespace:
- `runs`: id, mode, status, base, continues, opened, closed, number of findings, and `problem` for a run that cannot be read. An unreadable run is reported, never fatal.
- `problem`: null, or why the namespace's `runs/` could not be listed. A `runs/`, `decisions.json` or `charter.json` that cannot be read (a link, a directory, an I/O error) is reported in place, by name and error code and never by an absolute path, and the other namespaces are still shown.
- `open_runs`.
- `next`: the next step, `{ reason, run, command }`: `open` (continue it, or `nthr resume --ns <ns>` once the source moved), `interrupted` (an abandoned run that no run continues: `nthr resume --ns <ns> --apply`), or `closed` (the latest closed run's follow-up command, as in the report's Summary). Null when the namespace or one of its runs cannot be read, or it has no run.
- `debt`: the outstanding debt, meaning the `debt.out` of the closed runs that no other closed run builds on (by base or continues), deduplicated by id. An open run's in-progress records do not count. It gives `total`, `by_kind` (every kind) and `items`; `complete` is false when a run could not be read.
- `findings`: one per fingerprint, with:
  - its latest occurrence (highest run id), with verdict, severity and the decision at close;
  - every place it was seen;
  - its latest owner decision.
- `decisions`: every entry with `superseded_by`, whether the file is valid, and `orphans` (decided fingerprints that no readable run has any more).
- `charter`: for audit namespaces.

An unknown `--ns` is exit 2.

## `charter`

`charter --ns audits/<id> --owner <name> --scope <text> --exclusions <text> --official [--profile quick|standard|deep] [--budget-sessions 1-9999]` creates an official audit namespace (N3, C19). `--exclusions` is explicit: what the owner excludes, or "none".

**Refused** (exit 2, nothing written), in this order:
1. the namespace is not `audits/<id>`;
2. **the release switch `OFFICIAL_AUDITS_ENABLED` in `nthr.mjs` is false**, which it stays until the release criteria pass;
3. `--official`, the owner's explicit authorization, is missing;
4. the owner, scope, exclusions, profile or session budget is missing or invalid;
5. a charter already exists: it is **never replaced**;
6. the namespace already holds other files.

**`charter.json`:** `{ schema: "nth-review/charter@1", official: true, namespace, owner, scope, exclusions, profile, budget_sessions, created }`. It is written exclusively: the target is created by a hard link that fails if anything is there, so a racing writer cannot replace it either.

`new-run` and `check` read it to admit audit runs and to copy the profile; neither ever creates one. They admit only a complete charter (every field valid) that names this namespace: a partial or hand-made file is not the owner's authorization.

## `check` rules

`check --run .nth-review/<ns>/runs/<run-id>` reads the run and its parent and writes nothing.
- **Exit 1** lists the errors, at most 100, as `<path>: <problem>`.
- **Exit 2** means the run cannot be located safely.
- **Warnings** do not fail the check.

After the schema above, it enforces:
- **Directory (C18):** only `records.json`, `report.md`, `packs/<id>.md` and, while the run is open, a pending `patch.json`. No other file, no temporary file, no link. A `complete` or `incomplete` run has `report.md` and no `patch.json`, so `close` refuses a run with a pending patch. An `abandoned` run has no `report.md` (one there was left by an interrupted close).
- **Namespace (N1–N5, C5, C19):**
  - `run.namespace` and `run.id` match the directory, and the mode fits the namespace;
  - `audits/` needs official audits enabled and a valid charter;
  - `base` and `continues` are readable runs of the same namespace with the statuses `new-run` requires (N2), and never the legacy top-level `runs/` (N5);
  - an open run is the only open run of its namespace.
- **Debt (C4):**
  - debt-in is exactly the parent's debt-out, with `from_run` set to the parent; no parent means no debt-in;
  - a `carried` item reappears in debt-out with the same id; a `discharged` or `obsolete` one does not;
  - a new id is `<run-id>/D<n>`;
  - every id originates in a run of this namespace, so an official run cannot carry debt from another namespace;
  - `refs` name obligations or findings of the run;
  - **an `abandoned` run** (C5, as amended) hands on every carry-required item: some `debt.out` entry's `refs` names each open or violated obligation, each held obligation on unverified or absent footprint evidence, and each unverified finding. `accepted` and `out-of-scope` obligations are not required, but may be named.
- **References:**
  - ids are unique;
  - `intent`, `links`, `obligation`, `affects` and `depends_on` name existing items;
  - `run.unit` is set exactly for `audit-unit` and names a ledger unit, or `close`; no ledger unit is named `close`;
  - `depends_on` has no cycle, and no unit depends on itself.
- **Verdicts and evidence (C12):**
  - `held` and `accepted` obligations cite evidence;
  - `held` has no linked confirmed defect, and no linked defect that is still a `candidate` or `needs_validation` (it stays `open` / `verification` until the finding is verified; `needs_validation` makes it `violated`);
  - `violated` links a `confirmed` or `needs_validation` finding.
  - The verdict follows the refuter (v1.0 RC): an incomplete verification leaves a `candidate`; with a completed R5 or R6 verification, `rejected` needs the outcome `rejected`, and `needs_validation` never follows a `rejected` outcome; a rejected defect needs a completed R5 or R6 verification that rejected it (the lead never rejects a defect on its own).
  - A `risk` has no severity and no refuter, and is `candidate` or `confirmed`.
  - `needs_validation` has no severity and has a plan.
  - `rejected` has counterevidence.
  - `confirmed` and `needs_validation` findings have a trace, and a confirmed defect or doc-drift has a severity.
  - A confirmed defect has a completed R5 or R6 verification that `confirmed` or `corrected` it.
  - A confirmed doc-drift has such a verification, or role `none` with every trace anchor an exact line.
  - A critical or high defect, or one whose impact is `financial`, `security` or `data-integrity`, is verified by R5, whether the refuter confirmed, corrected or rejected it (and a `needs_validation` one a refuter decided).
  - Role `none` has a null model and outcome; R5 uses `opus`, R6 `sonnet`.
- **Delegations (C16, C17):**
  - roles use their agent and model: R2 and R3 `Explore`/`sonnet`; R4 and R5 `reviewer`/`opus`; R6 `reviewer`/`sonnet`; R7 `verifier`/`sonnet`;
  - an `opus` delegation has effort `high`; R4 appears only in `audit-unit` runs;
  - a Tier-1 unit run closes `complete` only with a completed R4 delegation;
  - there is at most one recovery message;
  - every completed R5 or R6 verification has a matching completed delegation;
  - in a flow run, a recorded edge whose `evidence` or `to` path matches a `discovered` path disposes of it like an item;
  - in a `complete` or `incomplete` run, every `discovered` path has a census disposition: an item whose `path` (or group) matches it and that covers it (`classified`, naming obligations), excludes it (`excluded`, or `classified` with `affects: null` and a reason), or leaves it `unknown` with `frontier` or `deferred-scope` debt whose `requires` names the path.
- **Flow runs (BETA):**
  - `scope.entries`, `census.edges`, `budget.max_depth` and `budget.max_edges` exist exactly in flow runs; a flow run has no `change` and no `base`; entry ids are `E1`… in order;
  - the budget and limits equal those `new-run` derives from the entries, and the lead model is `opus-high`;
  - edge ids are unique; `from` is an entry or an earlier `classified` edge with a target that first reached its node (a revisit is never expanded); an edge into an already-reached node is not `excluded`; an edge deeper than `max_depth` is `unknown`, and none is deeper than `max_depth` + 1; at most `max_edges` edges; a repeated `from`, target node and `kind` is refused;
  - a `classified` edge has a target and names obligations; an `excluded` or `unknown` edge has a reason; `affects` names obligations of the run;
  - obligation evidence, dependency anchors and finding traces lie inside the reviewed boundary: the entry paths and the edges' `evidence` and `to` paths (intent and counterevidence may lie outside);
  - a `complete` or `incomplete` run hands every `unknown` edge on as `frontier` or `deferred-scope` debt whose `requires` contains its `evidence` anchor;
  - a `complete` run cites every entry: some obligation's evidence names its file and overlaps its lines.
- **Lead model (C15):**
  - audit and Incremental runs require `opus-high`;
  - triggers require `opus-high`;
  - a task run whose budget is not the S row (M, L or unverified size, which the helper-owned budget records) keeps the `task-size` trigger, so the lead cannot lower the requirement `new-run` derived;
  - a run that records no `lead_model` is not checked against C15 (a known limit: SKILL §2 requires recording it, `check` does not).
  - a recorded `lead_model` is Opus or Sonnet, and Opus when `opus-high` is required;
  - `lead_effort` is never `xhigh` or `max`, and is not `low` or `medium` under `opus-high`.
- **Budget (C14, B3):**
  - a `complete` or `incomplete` run over budget fails, unless it is `incomplete` with reason `budget`;
  - an open run over budget gets a warning;
  - `spent.subagent_calls` covers the recorded delegations, and `spent.subagent_tokens` covers their tokens;
  - obligations stay within `obligations_max` + 20%.
- **Coverage (C11):**
  - a closed `incremental` run has `freshness`, whose `base_run` is the run's base;
  - every changed file is covered by at least one census item with `affects`, or with `affects` null and a reason. The item's path is exact, or a group whose `*` and `?` match within one path segment.
  - in a `complete` or `incomplete` Incremental run, the effective baseline resolves (otherwise `$.run.base` names the broken ancestor), and `freshness.obligations` names each of its obligations exactly once, with no other id, and with its resolved origin (`origin` omitted exactly when it is `base_run`). Close recomputes the classes themselves;
  - there, every entry whose class is not `current` is re-recorded under its id, and a `held` or `accepted` one does not carry its origin version's `evidence` unchanged, in any order (a conclusion is reassessed, never carried forward). This catches a copy; it cannot prove that a reassessment happened;
  - an obligation recorded under an inherited id, whatever its class, keeps that version's `claim`: another claim is a new obligation that would silently replace the inherited one, and needs an id the effective baseline does not use;
  - other modes have `freshness` null;
  - with `discovery_complete` false, no obligation is `all-enumerated`;
  - no concluded obligation (any status but `open`) is `all-enumerated` while a census item contradicts it: an `unknown` item that names it or names no obligation, or an `excluded` item that names it (C13). An `open` obligation's coverage is still a target. This applies to open and closed runs alike.
- **Completion:**
  - a `complete` run has no `open` obligation and no `candidate` finding;
  - it is not empty: obligations, or the units ledger for `audit-plan`. An Incremental run with no changed file, whose freshness names inherited obligations, reviewed them, so it is not empty even when all are `current`. With a changed file, it still needs a recorded obligation.
  - a `complete` audit plan, and a `complete` audit close, have complete discovery and no `unknown` census item; the audit close also needs every unit `complete` or `out_of_scope`, at least one unit `complete`, every `complete` unit classified, and is not empty when its ledger is not.
- **Full Audit ledger (C20):**
  - the audit chain is linear: among the namespace's closed audit runs there is one root, and no two share a base (not checked for an abandoned run);
  - every unit of a plan run has a `scope`; in a `complete` plan run, every active one also has a tier and a `basis` of anchors with notes;
  - a re-plan that raises a `complete` unit to Tier 1 reopens it (`planned`);
  - a plan run with a base keeps every unit and its `runs`, sets only `planned`, `deferred` or `out_of_scope`, and keeps `complete` and `incomplete` only unchanged; `in_progress` is never used. It never puts an existing unit `out_of_scope` (the charter's exclusions are fixed; a new unit may start out of scope), and never lowers a unit's priority (tier 1 before 2 before 3 before none), so a Tier-1 unit cannot shed R4;
  - in an audit run, `continues` names only an abandoned run of the same mode, base and unit;
  - a unit run is allowed by its base's ledger (`planned` or `incomplete`, dependencies `complete`);
  - an open or abandoned unit run keeps its base's ledger unchanged; a closed one changes only its own unit, as `close` records it;
  - the audit close changes no unit, except a `complete` one downgraded to `incomplete` with a reason, and records no obligation of its own.
- **Footprint (C9):** a `complete` or `incomplete` run's footprint has exactly one entry per cited file, none missing and none extra.
- **Inherited debt:** a `complete` run carries none on (no debt-in `carried`). It discharges or obsoletes each item, or closes as `incomplete`. In Full Audit (C20, protocol §8), a unit run is blocked only by carried debt from an earlier run of the same unit (an origin that cannot be read blocks), and a plan run by none; the audit close keeps the strict rule.
- **Close mode:** `close` runs these rules on the records it is about to write, counting `report.md` as present.
