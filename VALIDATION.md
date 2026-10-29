# nth-review validation record

> **Redacted for publication (2026-10-29):** private project names and workstation paths are replaced by placeholders ("private project A", "private project B", `<work>`, `<config>`), and one session identifier is withheld. No result, number or verdict changed. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#private-evidence-and-the-public-repository).

This file is library-only: it is never copied by Enable. It records the evidence behind each delivery gate. Plans and gate definitions live outside the kit, in the research documents that produced nth-review.

## M0: runtime compatibility probe (2026-10-25)

| | |
|---|---|
| Environment | Windows 11, Claude Code 2.1.310, Node v22.22.3, Git 2.54.0.windows.1 |
| Lead model | `--model sonnet` |
| macOS | **not probed** (no machine available) |

**Method.**
- A throwaway project (path containing a space) outside every repository, with two **project-level** skills:
  - `nth-review-probe` with `disable-model-invocation: true` and a bundled `scripts/probe.mjs`;
  - a model-invocable control skill.
- Headless `claude -p … --no-session-persistence --output-format stream-json --verbose`, with `--allowedTools` limited to `node` commands, `Agent` and read tools.
- No configuration was changed, and no session transcript was persisted.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1a | A skill with `disable-model-invocation: true` runs when the user types `/name args` | **pass** | Skill body followed directly, with no exploration. Arguments were substituted for `$ARGUMENTS`. |
| 1b | Its description is absent from the model's context | **pass** | Asked to list the skills it may invoke, the model listed the control skill but not the probe skill. The `init` event still lists both: that is the CLI's inventory, not the model's context. |
| 2 | `${CLAUDE_SKILL_DIR}` expands in the skill body | **pass** | Expanded to a forward-slash Windows path (`C:/…/skills/nth-review-probe`). `node "<that path>/scripts/probe.mjs"` ran from **both** the Bash (Git Bash) and PowerShell tools, with a space in the path. |
| 3 | Per-call `model` override on `Agent` | **pass** | Sonnet lead. `Explore` with `model: "opus"` and `reviewer` with `model: "opus"` both produced messages from `claude-opus-5-5`. |
| 3e | Per-call `effort: "high"` | **accepted, effect not observable** | The parameter reached the tool call; the stream does not expose the effort used |
| 4 | `reviewer` completes a budgeted refutation from an evidence pack | **pass** (2 of 2 runs) | 3 tool uses, about 19.6k tokens, 12–14 s each. It returned the requested JSON with `checked` and `not_checked`, and corrected the claim's wording. |
| 5 | Plugin packaging fallback | **not run** | Not needed because 1 and 2 passed |

**Decisions this settles:**
- **D1:** a plain skill (`<config>/skills/nth-review/SKILL.md`, invoked as `/nth-review`).
- **D1b:** not needed; per-call model overrides work.

**Harness finding.** Git Bash (MSYS) rewrites a native-program argument that starts with `/` into a Windows path. The first probe's prompt `/nth-review-probe …` reached Claude Code as `C:/Program Files/Git/nth-review-probe …`, and that run was discarded. Consequences:
- Headless test harnesses must set `MSYS_NO_PATHCONV=1`.
- `nthr.mjs` arguments must never need a leading `/`. Anchors and namespaces are relative by design, and `--root` defaults to the current directory.

**Observed probe cost** (list prices from the run's `modelUsage`; small probe prompts, not review work):
- 0.21 USD for the skill run (Sonnet lead plus two Opus subagents);
- 0.08 USD for the listing run.

## M1 results (gate G1: Windows green, macOS not run)

**Environment, 2026-10-26:**
- Windows 11 Pro 10.0.26200;
- Node v22.22.3;
- Git 2.54.0.windows.1 (git-lfs 3.7.1; the system config defines `filter.lfs`).

**Test command,** from the repository root. Node 22 treats a bare directory argument as a module, so use a glob:

    node --test "agents/claude/integrations/review/tests/**/*.test.mjs"

| Task | Result |
|---|---|
| M1-T1 CLI shell (`scripts/nthr.mjs`, `scripts/lib/cli.mjs`) | 14/14 pass. Covers: the JSON output contract; exit codes 0/1/2/3; `--help`/`-h`, which list `check`, `help`, `new-run` and `version`; unknown commands, options and positionals; `--root` with spaces and non-ASCII characters; root defaults and refusals; the Node ≥ 20 check; `--constructor` refused. |
| M1-T2 git wrapper (`scripts/lib/git.mjs`) | 13/13 pass. Covers: real-repo reads, with `hash-object` proven not to write; 40 mutating or unknown forms refused **before** spawning; output, external-diff and textconv options refused; `--no-ext-diff --no-textconv --no-color` forced; no shell; redirecting `GIT_*` variables removed; typed errors; a refusal is exit 2. **Strict read-only:** every call carries the pins (`core.fsmonitor=false`, `diff.autoRefreshIndex=false`, an impossible `core.hooksPath`) plus trace2 targets off, and the environment (`GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_TRACE*` removed). `status`, `diff` and `hash-object` disable every configured filter driver, dotted names included. Other commands look nothing up. An un-disableable driver name is refused. A nameless `filter.x` key is ignored, as git ignores it. Only the exact filter-driver and promisor queries, and `version`, are allowed among the new forms. |
| M1-T3 discovery (`scripts/lib/discover.mjs`) | 13/13 pass. Repository kinds found: root, nested, unborn, submodule, worktree (`.git` file), and one inside an ignored directory. Not discovered: depth 3, `.nth-review/`, `node_modules/`. Limitations reported: a non-repository root; an enclosing repository; an invalid `.git`; a junction, never followed; an unstorable path. Also covers byte order rather than locale, Windows root forms and `.GIT`, the refusal and scan limits, and proof that only `rev-parse` is spawned and no file opened. |
| M1-T4 snapshot (`scripts/lib/snapshot.mjs`) | 23/25 pass, **2 skipped**. Covers: T1 and T2; `.nth-review/` writes; unborn and detached HEAD; non-ASCII names; `core.autocrlf=true`; git settings; the six-repository project; bounded hashing and 10,001 files; secrets never opened; junctions never read; the limitation cap; proof that nothing under `.git/` changes (whole-tree digest, racy files included). **New regressions:** the snapshot contract checks below, plus a tracked secret edited between snapshots (equal keys compare `unverified`, `reassess`). **Skipped:** an untracked file symlink (needs the symlink privilege); an executable-bit change (Windows has no executable bit). |
| Strict read-only Git (`tests/filters.test.mjs`) | 7/7 pass, each with a raw-git **control** proving the mechanism would otherwise fire, and a before/after state check:

- **Custom clean filter:** a logging, content-changing filter never runs during snapshots or `new-run`. Its touched file is `unverified` (`filter-not-run`), with `tracked_key` unchanged; the same observed bytes compare `equal`; a same-size edit compares `unverified`, never `equal`. Nothing under `.git/` changes.
- **git-lfs filter-process:** nothing stored under `.git/lfs` by snapshot or sizing; the edit is unverified.
- **FSMonitor command and `post-index-change` hook:** neither runs. No file outside `.nth-review/` changes, `.git/index` included, during snapshot and `new-run`.
- **Partial clone:** nothing is fetched; sizing a range with missing objects is refused (exit 2).
- **Submodules:** a filter defined only in a submodule's own config never runs. The discovered submodule's file is unverified; a deeper submodule is reported (`submodule-not-covered`).
- **Review fixes:**
  - an unverified working-tree size gives the conservative task budget and `opus-high`;
  - `GIT_TRACE`/`GIT_TRACE2` write no file;
  - a nameless filter key is harmless;
  - a partial clone is refused on Git older than 2.44, with an injected version. |
| M1-T5 filesystem guard (`scripts/lib/fsguard.mjs`) | 14/16 pass, **2 skipped** (a real file symlink and a real directory symlink: Windows returns EPERM without the privilege). Covers: namespace and path hostility; exclusive `mkdir`; atomic write; junction escapes at every level. |
| M1-T6 records schema (`scripts/lib/schema.mjs`, `reference/records.md`) | 18/18 pass. Covers everything earlier, plus the new snapshot fields: coverage flags that claim more than the counts and limitations show are refused; a branch of up to 1,024 characters; one error per defect. |
| M1-T7 `new-run` (`scripts/lib/runs.mjs`) | 12/12 pass. Covers: a valid open skeleton (UTF-8 without BOM, LF) that passes `check`; **T4** audits refused while disabled, without a charter, or with `official: false`, and opened only with both; **T5** a cross-namespace base, a path instead of an id, a missing base, a legacy top-level `runs/` base, an abandoned base (allowed as `continues`), and a base that fails validation; **T6** an open run in the namespace refused with `nthr resume` instructions, while other namespaces stay independent; **T7** size rows S/M/L from numstat (400/401 lines, 16 files, 1,501 lines) and the working-tree count; **T8** complete debt-in from the base, or from `continues` when given; the Incremental formula, plus the 80 cap when the base commit is gone; a run-id collision; 12 argument refusals that create nothing; audit-unit ledger rules; a process launch with the entry's switch off; review fixes (task needs `--change`, a file named `HEAD`, unborn sizing). |
| M1-T8 `check` (`scripts/lib/check.mjs`) | 10/10 pass. Covers: **T9** a valid closed Incremental chain (exit 0); **T10** each of the plan's nine injected defects, exit 1 with the matching error (dropped debt, `held` without evidence, a `confirmed` defect without verification, a risk with severity, `needs_validation` without a plan, a stray file, overspend without `incomplete`/`budget`, a Sonnet lead with triggers, an opus delegation without `high`); **T11** an official run carrying debt from an `experiments/` run, plus the audit gate; 28 further defects; directory contents; open-run warnings and a second open run; structure errors; `--run` forms and a junction run directory (refused); read-only proof (write-function spies plus a whole-tree digest); review fixes (any matching census item may account for a change; linear glob matching; an unreadable sibling run is reported). |

**Full suite at the end of M1: 128 tests, 124 pass, 0 fail, 4 skipped.** The result was identical when launched from Git Bash and from PowerShell. The current totals are in the M2 section below.

The 4 skipped tests are **not** passes:
1. fsguard: a real file symlink (EPERM);
2. fsguard: a real directory symlink (EPERM);
3. snapshot: an untracked file symlink hashed by its link text (EPERM);
4. snapshot: an unstaged executable-bit change (no executable bit on Windows).

**Process launches:**
- Git Bash: the tests spawn `nthr.mjs` with `MSYS_NO_PATHCONV=1`.
- PowerShell: a manual smoke run on a throwaway repository gave `new-run` exit 0, `check` exit 0 with a backslash `--run` path, and `audits/` refused with exit 2 by the entry's `OFFICIAL_AUDITS_ENABLED = false`.

### Snapshot contract resolutions

| # | Concern | Resolution | Evidence |
|---|---|---|---|
| 1 | `tracked_key` must not depend on anything untracked | `limitations` were removed from `tracked_key`. It now covers only the repository set and each repository's tracked fields. | A regression test changes eight untracked or coverage conditions while `tracked_key` stays equal: a new file, a content-only edit, a secret, an oversize file, the file budget, a link to a repository, an invalid `.git`, and the scan limit. |
| 2 | A separate untracked identity | New `snapshot.untracked_key`, over every repository's untracked fields except `sample`. A content-only change moves it. | Regression and `compareSnapshots` tests. |
| 3 | Untracked changes reassess, never abandon | `compareSnapshots(previous, current)` returns `action`: `abandon` (tracked changed), `reassess` (untracked or coverage changed, or unverifiable) or `continue`, plus the affected repositories. `resume` (M2-T5) consumes it. A cited untracked anchor still forces abandon; that needs the footprint (M2-T1). | `compareSnapshots` tests. |
| 4 | Skipped content stays unverified | New `untracked_complete` (`hashed = count` everywhere). Equal keys with partial hashing compare as `unverified` and lead to `reassess`, never `equal`. The schema refuses `untracked_complete: true` when any file was skipped. | A same-size change to a size-skipped file: keys equal, result `unverified`. |
| 5 | Incomplete discovery is reported, never exhaustive | New `discovery_complete`. It is false on `scan-limit`, `unreadable-directory`, the new `undecodable-directory`, or `unrepresentable-path`. `reconstructible` requires it. Coverage then compares as `unverified`. `check` refuses `all-enumerated` obligations while it is false, and the schema refuses `true` beside those codes. | Scan-limit, undecodable-name (mocked `readdir`) and `check` tests. |
| 6 | Staged and unstaged detect every change kind | Already true; now pinned by tests. | Staged addition, modification, rename (`git mv`), deletion and mode (`update-index --chmod=+x`); unstaged modification, deletion, rename and intent-to-add content. Each changes `tracked_key`, the matching digest and the status digest. The unstaged executable bit is POSIX-only (skipped on Windows). |
| 7 | LFS and filter side effects | **Owner decision (2026-10-26): strict read-only by default.** Implemented in `git.mjs` and `snapshot.mjs`; see "Read-only guarantees". | `tests/filters.test.mjs` |

### Read-only guarantees

**Proven by tests on this machine** (throwaway repositories only):
- **No external program runs** from nthr's git calls:
  - configured filter drivers (clean, smudge, process; git-lfs included) are disabled for `status`, `diff` and `hash-object`;
  - fsmonitor is off;
  - hooks resolve to a directory that cannot exist;
  - external diff and textconv are off;
  - git never runs inside a submodule (`--ignore-submodules=dirty`), so a submodule's own drivers cannot run.

  Each has a test with a control showing plain git would have run it.
- **No Git metadata or working-tree write:**
  - the index is never rewritten (`--no-optional-locks`, `diff.autoRefreshIndex=false`). This was a **bug found and fixed this round**: the earlier `new-run` sizing rewrote `.git/index` and fired `post-index-change`;
  - nothing is stored under `.git/lfs`;
  - a partial clone fetches nothing (`GIT_NO_LAZY_FETCH=1`), and is refused on Git older than 2.44, where that switch does not exist;
  - no trace files are written (`GIT_TRACE*` removed, trace2 targets off).

  Whole-tree digests before and after are equal, except for the fixtures' own edits.
- **nthr's own writes** stay below `.nth-review/<ns>/` (fsguard), a refused `new-run` creates nothing, and `check` writes nothing.
- **Uncertain results are explicit:**
  - a tracked file whose comparison needs a disabled filter is `unverified` (`filter-not-run`), never clean or modified;
  - a modified tracked secret or unreadable file is `unverified`;
  - equal keys then compare `unverified` (`reassess`), never `equal`, unless every unverified entry was observed and is identical.
- **Ordinary change detection is unchanged:** every earlier change-kind test still passes, and those repositories stay `tracked_complete`, with the system `filter.lfs` configured.
- **Allowed git commands:**
  - snapshot: `rev-parse`, `status`, `ls-files`, `config` (the filter-driver query) and `check-attr`;
  - `new-run` adds `diff --numstat`, `rev-parse --verify` and `cat-file -e`.

**Residual limitations** (documented in records.md):
- **Filtered files git reports clean.** A filtered file that is not stat-dirty is clean by stat, as in plain git. A racily-clean or touched filtered file whose raw bytes equal its committed blob is also reported clean. Real git would differ only if the filter changes its own output, and a clean filter is expected not to.
- **Change sizing:** a working tree with unverified filtered files yields `size.verified: false`, which gets the conservative budget and lead. It is never sized as small.
- **C9 (footprint, M2-T1):** `hash-object` can no longer apply filters, so a filtered file's blob is not comparable with its committed blob. The footprint must mark such paths unverified.
- **Submodules:** a submodule deeper than discovery reaches is reported, not checked. A gitlink recorded without `.gitmodules` (an embedded repository added by mistake) beyond discovery depth is **not** reported: finding it would need a full index listing on every snapshot, which can exceed the 64 MiB output cap in very large repositories.
- **Version and platform:** the no-fetch guarantee relies on Git ≥ 2.44 (older Git refuses partial clones instead). Filter and hook behaviour was proven with Git 2.54 on Windows only.
- **Not neutralised:** git's own built-in conversions (`text`/`eol`, `ident`, `working-tree-encoding`) still apply. They run no external program.

### Contract adjustments in this round (records.md is the reference)

| Contract | Change | Why |
|---|---|---|
| Strict read-only Git (owner decision) | Global pins, `GIT_NO_LAZY_FETCH`, filter drivers disabled per call, `--ignore-submodules=dirty` (was `untracked`). New `repos[].unverified {filter, secret, unreadable, sha256}` and `tracked_complete`; `reconstructible` requires it. New codes `filter-not-run` and `submodule-not-covered`; the latter makes discovery incomplete. Allowlist: `check-attr -z`, the exact filter-driver `config` query, `diff --ignore-submodules=dirty`. | Requirements 1–6 of the owner decision |
| C5 resume (tracked) | Equal `tracked_key` compares `unverified` (`reassess`) while any tracked entry is unverified, unless all are observed and identical on both sides. | Requirement 5: equal keys never imply verified equality for unobserved content |
| C9 footprint (M2-T1) | `hash-object` never runs filters: filtered paths need an unverified marker in the footprint. | Consequence for M2 |
| `tracked_key` version | `nth-review/tracked-key@2`: its digests changed meaning (unverified entries left out, submodules by commit only). | No @1 key can compare equal to a new one |
| C14 sizing | `size.verified`; size class `unverified` uses the M budget and `opus-high`. | Owner decision, requirement 4 |
| C6 keys | `tracked_key` excludes `limitations`. New fields: `untracked_key`, `untracked_complete`, `discovery_complete`. `reconstructible` also requires complete discovery. New limitation code `undecodable-directory`, split from `unrepresentable-path`. | Concerns 1–5 |
| C5 resume | `compareSnapshots` defines abandon / reassess / continue. Untracked and coverage changes reassess, unverifiable state reassesses, and tracked changes abandon. | Concern 3 |
| C14 sizes | A Task larger than M is size L, with the M budget. Incremental: subagent calls 3; `obligations_max` is base obligations + 15; an unknown size gives 80 lead calls. `audit-unit`: subagent calls 4 (census assist + critique + 2 refuters). Paths under `.nth-review/` never count. | The protocol table leaves these open |
| C15 lead model | Incremental requires `opus-high` at Open, because the Sonnet case needs `fresh` results that come later. Task M and L add the `task-size` trigger. | model-routing.md §2 |
| `new-run` inputs | A `task` run requires `--change` (`<repo>` for its working tree, or `<repo>:<a>..<b>`). `experiments/` admits every mode; `reviews/` only task and incremental; `audits/` only the audit modes. A `continues` run may be `abandoned`; a `base` may not. Debt comes from `continues` when given, else `base`. | Review finding: an unsized task got the smallest budget; protocol §1 |
| C19 | `OFFICIAL_AUDITS_ENABLED = false` lives in `nthr.mjs`, which passes it to the commands. `new-run` and `check` both require the switch **and** a charter with `"official": true`. | Decision C19 and rule N3 |
| `check` additions beyond the plan's list | A `complete` run has no open obligation and no candidate. A critical or high defect, or a financial, security or data-integrity one, needs R5. Every delegation role has a fixed agent and model, and R4 appears only in audit units. Accounting covers subagent calls and tokens against delegations. The outline is capped at 120% (B3). `lead_effort` is never `xhigh` or `max`. `abandoned` runs are exempt from the `report.md` and budget rules. | Protocol §3, §7 and model-routing.md, made checkable |

The earlier M1-T3/T4 adjustments still stand. They are:
- canonical staged and unstaged change sets instead of binary patch hashes;
- untracked content identity with per-reason skip counts;
- `.nth-review/` excluded from tracked status;
- `is_submodule` from the superproject index;
- discovery limits;
- the secret-name list;
- `rev-parse --show-superproject-working-tree` added to the allowlist;
- `branch` up to 1,024 characters.

**Known limits** (documented in records.md):
- A `git status`, untracked listing or numstat over 64 MiB fails the command (exit 3).
- Tracked files with unstaged changes are read in full.
- Content changes to a modified tracked secret file are not observed (`secret-not-hashed`). The snapshot is `tracked_complete: false`, so resume compares `unverified` and reassesses.
- On Windows there is no `O_NOFOLLOW`: a file swapped for a link between the check and the open is opened but never read.

### Gate G1 status

Every G1 area is green on Windows, with the 4 skips above:
- multi-repository discovery and worktrees;
- the submodule flag;
- unborn and detached HEAD;
- non-ASCII paths and `autocrlf`;
- adversarial records;
- namespace and filesystem safety, including junctions;
- the git allowlist.

The plan's numbered tests map as follows:

| Plan tests | Covered in |
|---|---|
| T1, T2 | snapshot |
| T3, T13 | fsguard; the symlink part is skipped and the junction part passes |
| T4–T8 | `new-run` |
| T9–T11 | `check` |
| T12 | git |

The plan never defines a **T14**.

**G1 is not passed:**
- It requires 100% green on **macOS** as well, and no macOS run exists.
- The symlink cases have not run with the privilege, or on POSIX.

**Not verified yet:**
- macOS and Linux (POSIX-only paths: directory symlinks listed as one entry, undecodable names, `O_NOFOLLOW`/`O_NONBLOCK`, the executable bit);
- real symlinks;
- Node 20.x (only v22.22.3 was run);
- git-lfs behaviour on macOS.

## M2 results (in progress; G1 still Windows-only)

**Environment, 2026-10-26:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1 (git-lfs 3.7.1). Launched from Git Bash and from PowerShell.

| Task | Result |
|---|---|
| M2-T1 footprint (`scripts/lib/footprint.mjs`; `footprint --run`; the schema; a `check` rule) | 8/8 pass (`tests/footprint.test.mjs`). Coverage: <ul><li>**Cited paths:** intent, evidence, dependency assumptions (environment ones cite nothing), traces and counterevidence, each once and in byte order. Owning repository by the longest prefix.</li><li>**States, checked against independent `rev-parse HEAD:` and `hash-object` results:** clean (`HEAD:` blob); dirty, unstaged; dirty, staged; intent-to-add, even when empty (dirty, never clean); untracked; ignored but present (untracked); deleted, renamed away, `git mv` source and never-existing (absent); renamed-to (untracked); `git mv` target (dirty, keeping the blob); a CRLF working tree under `core.autocrlf=true` (clean, with the committed blob).</li><li>**Unverified, with a reason and no blob:** a filtered file, tracked or untracked (the logging filter never runs and the driver is disabled on the command line); secret names, tracked or untracked (never passed to `hash-object`); a path through a junction; a file inside an undiscovered nested repository; a directory.</li><li>**Repositories:** a nested repository's paths resolve in that repository. A path outside every repository is an error (exit 1), with nothing written.</li><li>**Safety and determinism:** deterministic and idempotent (byte-identical records on rerun); a racy file is decided by content, not stat; no file but the run's `records.json` changes, `.git/` included; a closed run is refused (exit 2) and left unchanged; only `config`, `check-attr`, `hash-object`, `ls-files` and `status` are spawned.</li><li>**Integration:** `new-run`, then cited records (with a tracked and an untracked dependency assumption), then `footprint`, close, and `check` (exit 0). A stale footprint (a missing entry, or an entry no longer cited) fails `check` with one error each.</li><li>**Review fixes:** a failing `hash-object` batch is retried path by path, and the failing path is `unreadable`; a differently-cased path is `case-mismatch` on a case-insensitive file system; a cited, staged file under `.nth-review/` is `dirty`; a repository directory replaced by a junction after Open is `link`.</li></ul> |
| M2-T2 evidence packs (`scripts/lib/pack.mjs`; `pack --run --for [--anchor]`) | 6/6 pass (`tests/pack.test.mjs`). Coverage: <ul><li>**Content:** a finding pack has the claim, the obligation's claim and acceptance, and 15 numbered lines centred on the cited range, with the cited lines marked. A CRLF file shows no carriage return. Intent is excerpted from its heading. No verdict, verification, corrections or counterevidence appear. The output is deterministic.</li><li>**Marked and never fatal:** a missing file; a binary file; a secret name (never opened, shown by an `openSync` spy); a path through a junction (never opened); a range past the end; an unknown heading; a 2,000-character line cut at 300; a whole file shown as its first 15 lines.</li><li>**Caps:** 12 anchors of 40 lines into one file give ≤ 6 KB, ≤ 10 anchors, ≤ 15 lines each, the anchor-cap and size-cap omissions listed, "the middle 15" and "cut to fit" marks, and **one read** of the file.</li><li>**Obligation pack:** evidence, dependency, requested extra and intent, in that order. A footprint-`unverified` dependency is marked. Packs are allowed run files.</li><li>**Refusals:** an unknown item, a bad extra anchor, a missing `--for` and a closed run all refuse, and nothing is written.</li><li>**Review fixes:** 4,000-character multi-byte record text stays under 6 KB (every field is byte-bounded, and a final hard cut replaces the former crash); a carriage return cannot start a heading; `## C# usage` is found, and a heading inside a code fence is skipped.</li></ul> |
| M2-T3 close and report (`scripts/lib/close.mjs`, `scripts/lib/render.mjs`; `close --run --status [--reason] [--reassessed]`) | 7/7 pass (`tests/close.test.mjs`). Coverage: <ul><li>**Integration:** new-run, then records, `pack`, `footprint`, `check`, `close --status complete` and the report. The Open snapshot is preserved; the recheck entry reads "tracked equal…"; the report is byte-identical to a fresh render; the sections come in order (Gaps first); "Verified" appears only on the held, all-enumerated obligation; `check` passes on the closed run.</li><li>**Immutable:** a second close (complete or incomplete), `footprint` and `pack` on a closed run all refuse, and records and report are unchanged.</li><li>**Source changed since Open:** a tracked edit refuses `complete` and `incomplete/budget`, writing nothing. `incomplete/snapshot-changed` closes, keeps the Open snapshot, gives a dirty footprint, and the report states the change.</li><li>**Reassessment:** an untracked file, and a tracked secret modified before Open (unverified state), each refuse without `--reassessed` and close with it. The entry records the reassessment.</li><li>**Check failures** (exit 1, nothing written): a confirmed defect without verification; `complete` with an open obligation (then `incomplete/open-obligations` closes, and the report lists it first). Abandoned, missing and invalid reasons, and `complete` with a reason, are refused.</li><li>**Failed writes:** a report crash changes nothing. A records crash leaves the run open with valid old records and no temporary files; `check` still passes; a retry closes, and the report matches.</li><li>**Unverified evidence:** a filtered dependency makes the held, all-enumerated obligation "not verified", and it is listed under Gaps.</li><li>**Review fixes:** a snapshot-changed close marks the changed repositories' footprint `unverified (source-changed)` and shows nothing as Verified; a temporary file from a killed write is flagged by `check` and removed by the next `close`; record text with CR, list markers, pipes and backslashes stays on one escaped line.</li></ul> |

**Full suite: 149 tests, 145 pass, 0 fail, 4 skipped.** The result is identical from Git Bash and from PowerShell (two runs each). The 4 skipped tests are the M1 platform cases, and they are **not** passes:
- a real file symlink;
- a real directory symlink;
- an untracked file symlink;
- the executable bit.

**Contract changes (records.md is the reference):**

| Contract | Change | Why |
|---|---|---|
| records@1 `footprint` entry | `{ blob, state, reason }`. Adds the state `unverified` and a required `reason`: `filter` · `secret` · `link` · `unreadable` · `case-mismatch` · `nested-repository` · `repository-unavailable`, set exactly for `unverified`. `blob` is null exactly for `absent` and `unverified`. | An identity the helper cannot or must not establish is explicit, never clean, current or absent |
| C9 (blob identity) | `hash-object` applies git's own conversions but never a filter driver. A path that needs a driver is `unverified` instead of carrying an incomparable blob. `clean` requires index = HEAD (no status entry) and working-tree blob = index blob, decided by content, not stat. | Strict read-only Git (owner decision, 2026-10-26) |
| Cited paths | Counterevidence anchors are included alongside intent, evidence, dependency assumptions and traces. | The plan says every anchor. A rejection that rests on changed code must be reassessable. |
| `check` | A `complete` or `incomplete` run's footprint has exactly one entry per cited file. `abandoned` runs are exempt, and open runs are not checked. | The footprint is what later runs compare against (C9, C11) |
| `close` (M2-T3) | Before anything else, the source is rechecked against the Open snapshot with `compareSnapshots`. A tracked change refuses, except `incomplete/snapshot-changed`; a reassess result needs `--reassessed`. The result is recorded as a `checks` entry; the Open snapshot is never replaced. The footprint is always recomputed (the plan says "if missing"). `check` runs in close mode on the final document. `report.md` is written before `records.json`. `--reason` takes the incomplete-reason vocabulary, not free text. The close logic lives in `scripts/lib/close.mjs` (the plan says `runs.mjs`), to avoid an import cycle with `check.mjs`. | Owner requirement: no close with evidence from a different source state |
| `check`: open debt | A `complete` run may not carry inherited debt (debt-in `carried`). Debt it hands on of its own (debt-out) is allowed. | The plan's "complete with open debt is refused", read as inherited debt left unresolved |
| Pack contents | Packs exclude verdict, verification, corrections and counterevidence. Intent is excerpted, within the 10-anchor cap. | A refuter must see no earlier conclusion (model-routing.md §3) |

**Remaining limitations (M2-T1):**
- **Point in time.** The footprint is taken when `footprint` runs, normally just before Close. It is not taken at the snapshot. A file edited between the last read and the footprint gets its current identity.
- **Filtered files.** A filtered file never gets a blob, even when it is clean. A later run treats it as unverified and reassesses.
- **Case.** A path cited in a case different from its on-disk name is `unverified` (`case-mismatch`), not guessed.
- **Time-of-check.** `hash-object` follows symbolic links. A file swapped for a link between the helper's `lstat` and the hash gets its target's identity: only a hash, never content. A FIFO swapped in would block until the 60 s timeout.
- **Absent secrets.** An absent secret path is recorded `absent`: it is seen by `lstat` alone, without reading anything.
- **Dead end in `check`.** A closed run that cites a path outside every repository can never pass `check`. `close` (M2-T3) will run the footprint first, and the footprint refuses such a path, so the run cannot be closed that way.
- **Symbolic links.** A cited symbolic link (the final component) is `unverified` (`link`) rather than hashed by its target text, because its git blob would need the repository's object format.
- **Unverified.** macOS, Linux and Node 20 runs are still missing.

**Remaining limitations (M2-T2/T3):**
- **Time between recheck and writes.** Close rechecks the source and then computes the footprint. An edit between the two is not detected. The window is the few seconds of one command.
- **Concurrent closes.** Two `close` commands on the same run at once are not locked against each other; the last records write wins. Runs are meant to have one lead.
- **Inline Markdown.** Record text in the report is single-lined and table-escaped, but inline Markdown (emphasis, links) in it still renders. Records are the lead's own.
- **Packs read the working tree as it is.** Line numbers in a pack refer to the current file, which can differ from the evidence's original lines if the file changed. The footprint and the close recheck are what detect that.
- **Incremental runs cannot close yet.** `check` requires `freshness`, which comes from `fresh` (M2-T4). *Resolved by M2-T4, below.*
- **Unverified platforms:** macOS, Linux, real symlinks and Node 20.

**VS1 readiness:** the script side of VS1 is complete on Windows: M1, M2-T1 `footprint`, M2-T2 `pack` and M2-T3 `close`/report. Still missing:
- **M3-T1 `SKILL.md`** in Task mode, with the inline R3 and R6 templates;
- **the VS1 fixture and demo;**
- **`status` (M2-T6).** It is a VS1 pass criterion ("`status` lists the run"), but the VS1 scope list leaves it out, so this needs an owner decision: add M2-T6 to VS1, or check the run with `check` and the run directory instead.

## M3-T1 results (VS1 prepared, not run)

**Environment, 2026-10-26:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

**Owner decisions, 2026-10-26:**
1. VS1 drops the pass criterion "`status` lists the run". `status` stays in M2-T6.
2. VS1 keeps the planted authorization defect, so the VS1 lead is **Opus High**, not Sonnet. Sonnet-lead comparisons belong to M5.
3. The strict complete/incomplete semantics for open review debt stay as they are. Debt continuity is made explicit and testable (`tests/debt.test.mjs`), without redesigning M2.

| Item | Result |
|---|---|
| `SKILL.md` | **Frontmatter:** exactly `name`, `description`, `disable-model-invocation: true` and `argument-hint`, with no `metadata.managed-by` (R3). **Body:** 101 lines (limit 120): guardrails, Node preflight, `new-run`, the lead-model check, the Task steps (Plan, Census, mandatory R3 plan-critique, Discharge, evidence-first Verify, Close), budget stop rules B1–B5, and the final message. The skill uses only existing commands (`new-run`, `check`, `pack`, `footprint`, `close`) and records@1 fields. |
| `reference/prompts.md` | R3 plan-critique (`Explore`, `sonnet`, 30 calls) and one refuter template with the R5 (`reviewer`, `opus`, effort `high`, 1 finding) and R6 (`reviewer`, `sonnet`, ≤ 2 findings) routing rows, each with a budget of 10 calls per finding. Every template has: the role sentence; read-only and secret rules; the project-root-relative path base; "answer before the budget is spent"; and an exact JSON answer with `checked`/`not_checked`. The refuter reads its pack first and never opens `records.json` or other packs. |
| `tests/content.test.mjs` | 8/8 pass. Checks: the exact frontmatter keys; the size limits; every relative link resolves; every helper command and option the skill names exists in the CLI; the template structure; the documented routing equals `check`'s `ROLES`; models are only Opus or Sonnet, and `xhigh`/`max` appear only as prohibitions; guardrail wording; and **independence** (no kit file outside the integration mentions `nth-review`). |
| `tests/debt.test.mjs` | 1/1 pass, using real commands across four runs. A hands its debt on. B inherits it exactly, and is refused when it drops the debt, carries it without handing it on, or tries to complete while carrying it. C receives the same id from B and discharges it with a note (no note is refused), then completes. D inherits nothing. |
| `tests/vs1.test.mjs` | 4/4 pass. **Builder:** two repositories with one change commit each; a plain, non-repository root; a byte-identical project-level copy of exactly the runtime files (no `tests/`, no `VALIDATION.md`); no answer hint in the reviewed code; the VS1 command opens a check-valid Task S run. It refuses a non-empty directory or one inside a repository. **Verifier:** a synthetic correct review, driven through `new-run`, `pack` and `close`, passes all 9 criteria. Each failure is caught by its own criterion: Sonnet or xhigh lead, no R3, R6 instead of R5, an unverified finding, a missing pack, the control confirmed, an incomplete delegation or two recoveries. |

**Review of the skill.** An independent review checked what a lead following the skill literally would produce. It found nine gaps, all fixed in `SKILL.md` and `prompts.md`:
- project-root-relative anchors that start with the repository directory;
- R5 routing that matches `check` (severity critical or high, or impact `security`, `financial` or `data-integrity`);
- the required finding fields (`fingerprint`, `obligation`, `impact_dimension`, the verification object, `decision`);
- the obligation `checks` format, the intent and recipe id formats, and `open_reason` cleared once an obligation is no longer open;
- delegation `effort` (null for Sonnet) and an explicit `model` (the `reviewer` agent defaults to Sonnet);
- "this replaces your usual report format";
- three checkpoints instead of five, so the work fits a Task S budget of 40 calls;
- `--no-ext-diff --no-textconv` on all read-only git commands;
- a refuter that never opens `records.json`.

**Full suite: 162 tests, 158 pass, 0 fail, 4 skipped.** The result is identical from Git Bash and from PowerShell (two runs each). The 4 skipped tests are the M1 platform cases, and they are **not** passes.

**Contract note.** The roadmap names "inline R3 and R6 templates" for VS1, but VS1 keeps an authorization defect, and protocol §7 (enforced by `check`) requires the **R5** Opus refuter for authorization, money and data-loss claims. With R6 alone, VS1 could not pass. The refuter template therefore carries both routing rows. R2, R4 and the rest of M3-T3 are not written.

**VS1 readiness.** The VS1 fixture, runbook and verifier are ready: `tests/vs1/fixture.mjs`, `tests/vs1/README.md` and `tests/vs1/verify.mjs`. Both command lines were smoke-tested; the verifier correctly fails before any review has run. **The review itself has not run.** It must run in an isolated Claude Code session on **Opus at high effort**, started in the fixture directory, never in this development session and never at xhigh or max:

    node agents/claude/integrations/review/tests/vs1/fixture.mjs
    # in a new terminal, in the printed directory: claude --model opus (effort high), then
    /nth-review task --ns experiments/vs1 --slug vs1 --change api:HEAD~1..HEAD --change web:HEAD~1..HEAD
    node agents/claude/integrations/review/tests/vs1/verify.mjs <fixture directory>

**Gate status:**
- G1 is still provisionally validated on **Windows only**. macOS, real symlinks and Node 20 are not run.
- VS1 is open until the isolated run passes `verify.mjs`.

## VS1 results (gate VS1: passed)

**Run, 2026-10-26:**
- An isolated Claude Code session on Opus 5.5 (`claude-opus-5-5`) at effort high, started in the fixture directory `%TEMP%/nthr-vs1-NMKPzO`.
- Run `experiments/vs1/runs/20261026-012858-task-vs1`, opened 01:28:58Z, closed 01:35:33Z as `complete`.
- The records were backed up and hashed before verification. Every fixture file was byte-identical afterwards, and the run was never edited.
- Judged from the records, the report and the session transcripts (the lead and its three delegates).

**Pass items** (roadmap §3, as amended on 2026-10-26). `tests/vs1/verify.mjs` passes all 9 criteria, and each item was also checked by hand:

| Pass item | Result |
|---|---|
| A closed run with `records.json` and `report.md` | Pass: `complete`. |
| `check` exits 0 | Pass. |
| The lead is Opus at high effort | Pass: `claude-opus-5-5`, effort `high`; triggers `authorization` and `boundary-contract`; `required_lead_model: opus-high`. |
| A mandatory plan-critique | Pass: R3, `Explore`, `sonnet`, completed with 17 tool uses. |
| The planted defect is confirmed with a refuter verification | Pass: F-1, verified by R5 (`opus`, `high`) as `confirmed`, from the evidence pack `packs/F-1.md`, which it read first. |
| The negative control is not confirmed | Pass: OB-2 (`getOrder`) is `held` on `api/src/routes/orders.js:5-10`. |
| Every delegation completes with at most one recovery | Pass: 3 of 3, 0 recoveries (`reviewer` completion 2 of 2). |
| A second `close` is refused | Pass: refused, and the records were unchanged. |
| `status` lists the run | Dropped from VS1 (owner decision 1); `status` stays in M2-T6. |

**Quality of the review:**
- **F-1:**
  - Right mechanism (no `accountId` comparison) and consequence (cross-account invoice disclosure).
  - Exact trace: `api/src/routes/index.js:7`, then `api/src/routes/invoices.js:6`, then `api/src/routes/invoices.js:7-9`.
  - High severity, impact `security`.
- **Evidence:** every recorded anchor resolves to the lines it cites, and both intent anchors name real headings. One delegate error was not recorded: R5's answer cited `api/src/store.js:21`, but the file has 7 lines.
- **Coverage:**
  - All 5 changed files are classified.
  - The plan-critique added 3 unchanged dependencies (`api/src/server.js`, `web/src/api.js`, `api/src/session.js`) and a recipe for the writers that have no caller in either repository.
  - There are 4 obligations: AUTHZ.1, AUTHZ.2 twice, and CONTRACT.1.
  - One addition beyond the 20% outline cap became `deferred-scope` debt (D3).
  - Facts outside the repositories are recorded as unobserved environment assumptions and as owner-fact debt (D1, D2).
- **Lead budget:** 12 of 40 tool calls, counted after `new-run` as the skill requires (14 for the whole session).

**F-2 was confirmed but should have been `needs_validation`.** Its claim (the web pages call `/api/...` but the routes serve `/orders/...`) holds only if no gateway outside both repositories strips `/api`. The records contain the evidence that this is an unobserved fact:
- `api/src/server.js` exports `handle()` with no listener, so an HTTP adapter outside both repositories must exist, and an `/api` mount would live there.
- The `/api` prefix predates the change: it is in the web repository's initial commit.
- The R6 refuter wrote a validation plan and called a common `/api` rewrite "a non-issue", yet answered `confirmed`.
- The lead's own debt D1 says F-2 is a false positive if such a rewrite exists.

Decision C14 (adopted from Cloudflare's rules: "`needs_validation` for facts outside source") and audit-taxonomy rule 5 make this `needs_validation`, with no severity. **Cause:** that rule never reached `SKILL.md` or the refuter template, which listed the four outcomes without defining them. F-2 stays confirmed in the VS1 run, because a closed run never changes. F-2 does not affect any pass item.

**Late token accounting.**
- The R5 answer reached the lead at 01:35:12. Its task notification, which carries the usage (22,740 tokens and 4 tool uses), was queued at the same moment but delivered only after the lead's next tool call, the one that ran `close`.
- The skill said to record "0 if none were reported", which contradicted `records.md` ("null when not observed").
- The run therefore records R5 as 0 tokens and a subagent total of 61,409. The real total is **84,149**: R3 35,184, R6 26,225 and R5 22,740. All three are within the unmeasured role estimates, except R5, which came in below its 40–80k.

**Delegation budgets.**
- Tool uses: R3 17 of 30, R5 4 of 10, R6 12 of 10.
- The harness counts the delegate's final hand-back call as a tool use, so R6 made 11 working calls, one over its budget.
- The records state this truthfully, and no protocol rule attaches a consequence, so nothing changed. For V-COST: recorded `tool_uses` = working calls + 1 in this harness.

**Wall clock (not fixed).** The lead recorded 12 minutes, but the run was open for 6.6 minutes (7.5 for the whole session). The lead has no clock and estimated the value. Fixing this changes who writes `spent.wall_clock_min` (for example, `close` computing it from `opened`), so it is left as an owner decision.

**Fixes** (the runtime files and their reference):

| File | Change |
|---|---|
| `SKILL.md` | **Verify:** a claim that holds only if a fact outside the source holds is never `confirmed`; it is `needs_validation`, with a plan naming that fact, and the lead never strengthens a refuter's outcome. **Usage:** `tool_uses` and `tokens` come from the task notification and are null, never 0, when it has not arrived. **B5:** `spent.subagent_tokens` is the sum of the reported usage. The body is 102 lines. |
| `reference/prompts.md` | The refuter template defines the four outcomes, and `validation_plan` is non-null only for `needs_validation`. |
| `reference/records.md` | Documents the meaning of `verdict`, null usage, `spent.subagent_tokens`, and the report's lower-bound token total. |
| `scripts/lib/render.mjs` | When any delegation's `tokens` is null, the Cost row shows "at least N (not reported: <roles>)". |
| `tests/close.test.mjs`, `tests/content.test.mjs` | One regression test each. Both fail on the code that ran VS1. |

**Full suite: 164 tests, 160 pass, 0 fail, 4 skipped** (the same four platform cases, which are not passes). It was launched once, from Git Bash; the changes touch no platform-dependent code.

**Gate status:**
- **VS1 passes.** The recorded run meets every pass item, by the verifier and by hand.
- The fixes came after the run. They are covered by tests, but no live review has used them yet. A rerun was not needed for the gate.
- G1 is still provisionally validated on **Windows only**. macOS, real symlinks and Node 20 are not run.
- **Open follow-ups:**
  - the wall-clock owner decision;
  - `check` does not verify that an anchor's line range exists in its file. Only `pack` marks a range past the end of a file. VS1 produced such an anchor in a delegate answer but did not record it.

## Wall-clock correction and M2-T4 `fresh` (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

### Wall clock (owner decision, 2026-10-26)
- `close` now computes `budget.spent.wall_clock_min` from the run's UTC `opened` and `closed` timestamps, in minutes to one decimal. It replaces anything the lead wrote.
- A clock that reads earlier than `opened` is refused (exit 2), and nothing changes.
- `SKILL.md` B5 now tells the lead never to set the field. The content test also checks that the skill no longer asks for wall-clock minutes.
- Runs closed before this rule keep their value: `check` never recomputes it. The VS1 run (12 recorded, 6.6 actual) still passes `verify.mjs`, all 9 criteria, and its fixture is byte-identical.
- **Tests** (`tests/close.test.mjs`):
  - a lead value of 12 becomes 6.6 for 395 seconds, and the report shows 6.6;
  - Open and Close in the same second give 0;
  - an earlier clock is refused with nothing changed;
  - `check` accepts a closed run whose value came from the lead.

### M2-T4 `fresh` (protocol §10, decisions C10, C11)
A new command, `fresh --run <dir>` (`scripts/lib/fresh.mjs`), is the deterministic Incremental freshness engine. It compares the base run (its Open snapshot plus its closed footprint) with the tree now, and writes `freshness` into the open Incremental run's `records.json`, atomically. It writes nothing else.

**History outcomes,** per repository of either snapshot:

| Outcome | When |
|---|---|
| `base-missing` | a repository removed, added, unborn at base, or whose base commit is gone (rewritten history and gc) |
| `base-dirty` | uncommitted, untracked or unverified state at base |
| `equal` | the same head |
| `ancestor` | the base head is an ancestor of the head now |
| `diverged` | otherwise |

**`changed_files`:**
- committed and staged changes, by comparing the base tree with the index;
- unstaged changes, from `status`;
- untracked files;
- renames, with `from`;
- deletions;
- intent-to-add files;
- transients: added then deleted inside the range, found with `log --name-status`;
- every indexed file of a `base-missing` repository;
- cited files whose two known identities differ while Git shows nothing;
- assume-unchanged and skip-worktree entries, compared by hash.

**Obligation classes:**
- **Anchors:** evidence, **dependency assumptions** (the indirect path: an unchanged endpoint whose helper changed), intent sections, and the trace and counterevidence of linked findings.
- **`touched`:** a hunk within ±3 lines of a cited range; a rename, deletion or addition; a whole-file or heading anchor whose content changed; any uncertainty (an unverified identity on either side, base content not in the object database, binary content, a changed owning repository, `base-missing`).
- **`file-changed`:** other hunks in the same file, or a mode-only change.
- **`current`:** the same blob.
- **Never set by the script:** `held`, and `assumption-changed` (the lead's, kept on rerun).

**Close:** for Incremental runs, close recomputes freshness and refuses (exit 2) unless it equals the recorded one. Only `assumption-changed` entries may differ, and they always mean a full reassessment, so a stale or hand-edited class can never be closed. The check rule C11 (a census item for every changed file) applies as before.

**Git safety:**
- **New pinned configuration:** `log.showSignature=false` (no gpg), `log.showRoot=true`, `diff.algorithm=myers`, `diff.indentHeuristic=true`, `diff.interHunkContext=0` and `diff.renameLimit=1000`. These make hunks, renames and transients independent of user configuration.
- **Allowlist:** gains only `ls-files -v`. Every other command `fresh` uses (`diff --cached --raw -M`, blob-to-blob `diff -U0`, `log --name-status`, `cat-file -e`, `merge-base --is-ancestor`) was already allowed.

**Code changes:**
- `footprint.mjs`: `identitiesOf` is extracted from `computeFootprint`, with unchanged behaviour (all footprint tests pass), and `batches` is exported.
- `runs.mjs`: `requireRun` is exported.
- `cli.mjs`: registers `fresh`.

**Contract:** `reference/records.md` gains a `fresh` section (refusals, inputs, the outcome table, the change rules, the anchor rules, the reason format, limits, Git safety), the close validation step, and the wall-clock rule. **No schema, vocabulary or `check` change**, so existing closed runs stay valid.

**Design and review:**
- The design came from an architect handoff, with one deliberate deviation: a pure insertion after line *n* touches lines *n* and *n + 1*, so the margin is symmetric. The handoff's own matrix contradicted its formula on the before side.
- An independent review found one defect, which is fixed. Assume-unchanged and skip-worktree entries were invisible to `changed_files`, because `status` and `diff --cached` skip them. They are now listed through `ls-files -v` and compared by hash (`tests/fresh.test.mjs`, with a raw-Git control).
- The review also led to pinning `log.showRoot` and to documenting two limits: the scope of a `base-dirty` repository, and that a refused `fresh` leaves only resume.
- It checked these and found them fine:
  - argument injection;
  - filters, textconv, external diff and fsmonitor;
  - index writes;
  - every change kind;
  - the history outcomes;
  - the margin rule;
  - the `identitiesOf` extraction;
  - the wall-clock arithmetic.

| Tests (`tests/fresh.test.mjs`, 15; `tests/helpers/history.mjs`) | Result |
|---|---|
| **Golden** (two repositories, ancestor history) | `deepEqual` against a literal `freshness`. Covers: a direct change; an **indirect** dependency change with the endpoint unchanged (`touched`), and one outside the cited lines (`file-changed`); negative controls (an unchanged file is `current`; the same file far from the change is `file-changed`; the other repository is `current`); a rename, a delete, an add, a transient, a re-added transient (`added`), a heading anchor, and staged, unstaged and untracked files. Only `records.json` changes, Git metadata included. A second run is byte-identical. A spawn spy shows every call is allowlisted and carries the pins, `diff` and `log` carry `--no-ext-diff --no-textconv`, and `hash-object` never gets `-w`. |
| **Unchanged history** | All `equal`, no changed files, all `current`. |
| **Margin** | Edits at L2+3 and L1-3 are `touched`; at L2+4 and L1-4, `file-changed`. Insertions after L2+3 and L1-4 are `touched`; after L2+4 and L1-5, `file-changed`. A deletion at the edge, a whitespace-only edit, and blob-to-blob as well as working-tree comparisons. Plus unit tests of `parseHunks` and `touches`. |
| **Change kinds** | Staged (blob to blob), unstaged, untracked, intent-to-add, a staged rename deleted from the working tree, an added-then-removed file (no change), and `rm --cached`. |
| **Hidden entries** | Assume-unchanged and skip-worktree edits are listed; a sparse-absent file is not; a raw-Git control shows `status` hides them. |
| **Histories** | Diverged (classified by content); rewritten with amend, `reflog expire` and `gc --prune=now` (`base-missing`: every anchor in that repository `touched`, its files listed); a dirty base (the blob shortcut gives `current`, unavailable base content gives `touched`, a restored file is listed). |
| **Unverified** | A filter configured now, a secret name, and a base `source-changed` entry are all `touched`. |
| **Other cases** | Binary content (`touched`), a mode-only change through `update-index --chmod` (`file-changed`, works with `core.fileMode=false`), a repository added and one removed (`base-missing`, with an `owning repository changed` reason). |
| **Refusals** (exit 2, records byte-identical) | A closed run, a task run, an unrecordable path (`#`), an invalid base, and a tracked change since Open. |
| **Close** | A hand-edited `touched` changed to `current` is refused. An `assumption-changed` entry is kept by `fresh` and accepted by close. The Incremental run then closes and passes `check`. |
| **Hostile configuration** | External diff, an attribute diff driver with textconv, fsmonitor, `log.showSignature` with a gpg program, patience diff, `diff.renames=false`, `noprefix`, `mnemonicPrefix`, `interHunkContext` and `color.ui`. The result is identical, no program runs, and the tree is unchanged. A raw-Git control runs the driver and fsmonitor. |

**Full suite: 179 tests, 175 pass, 0 fail, 4 skipped.** The result is identical from Git Bash and from PowerShell. The 4 skipped tests are the M1 platform cases, and they are **not** passes. Before M2-T4 and after the wall-clock correction, the suite was 165/161/4.

**Remaining limitations:**
- **SYN-INC exact match:** the plan's acceptance names the SYN-INC unit fixture, which belongs to M5-T1. M2-T4 instead ships the golden multi-repository scenario, built from `history.mjs` builders that M5 can reuse.
- **`base-missing` lists every file** of that repository, so a large repository can exceed the 10,000-file limit, which refuses `fresh`. Added and removed repositories map to `base-missing`, and the distinction is only in the command output.
- **Heading anchors cover the whole file.**
- **Untracked files are listed every run.**
- **Base content Git never stored** (dirty or untracked at base) is compared by blob only.
- **Uncited helpers** reach the lead only through `changed_files` and C11.
- **No way out of a refusal yet:** a refused `fresh` leaves the run unclosable until `resume` (M2-T5) can abandon it. *Resolved by M2-T5, below.*
- **Pre-existing, outside M2-T4:** the snapshot's tracked key, and so the close recheck, does not see edits to assume-unchanged or skip-worktree files, because it is built from `status`. `fresh` now covers them for freshness, but a hidden edit between Open and Close is not detected. This is a follow-up for the snapshot (M1). *Resolved by the snapshot correction, below.*
- **Unverified platforms:** macOS, Linux, real symlinks and Node 20. Gate G2 needs both OSes.

**Readiness for M2-T5 (`resume`):**
- `resume` can reuse `compareSnapshots`, `requireRun` and the close-style write path.
- Abandoning a run gives debt for every obligation that is not `held` (C5).
- Nothing in M2-T4 blocks it. M2-T5 is also what makes a refused `fresh` recoverable.

## Snapshot correction for flagged files, and M2-T5 `resume` (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

### Task A: the snapshot sees assume-unchanged and skip-worktree files (owner decision: before M2-T5)
**The bug:** tracked files with either flag never appear in `git status`, so the snapshot (`porcelain_sha256`, the staged and unstaged digests, and so `tracked_key`) missed edits to them. `close` accepted such a run as unchanged. The regression tests reproduce it: `status` is empty for the edited file, and the three @2 digests are identical before and after.

**The fix:**
- `snapshot.mjs` `readFlagged` lists the flagged entries with `ls-files -v -z`, independently of `status`. It is the one listing; `fresh` now uses it too, so the implementations are not duplicated.
- Each repository records `flagged {count, sha256, hashed, missing, sparse, skipped}`:
  - flagged files are read as **raw bytes**, so no filter can run;
  - secret names are never opened;
  - links, unreadable, oversized and over-budget files are counted in `skipped` and listed as `flagged-not-hashed` limitations;
  - the budget (`FLAGGED_LIMITS`: 5,000 files, 1 MiB each, 64 MiB in total) is separate from the untracked budget;
  - where `core.fileMode` is on, the executable bit is part of the identity.
- `tracked_key` becomes **@3**, and covers `flagged.count` and `flagged.sha256`. A content edit, a flag set, cleared or switched, a deletion, a reappearance or a mode change therefore gives tracked `changed`, and close refuses under its existing snapshot-changed rule.
- A skipped flagged file makes the state `unverified`, never `equal`, so the run must be reassessed.
- **Compatibility:** `flagged` is optional in the schema, which gained optional-field support, so runs written earlier stay valid. A snapshot without it is compared on the @2 fields: `changed` when they differ, otherwise `unverified`, **never `equal`**. VS1's closed run still passes `verify.mjs` with all 9 criteria, and its files are byte-identical.
- `reconstructible` is false while a flagged file is present in the working tree (sparse entries excepted), and `fresh` then calls the base `base-dirty`.
- **Code:** `scripts/lib/snapshot.mjs`, `schema.mjs` (vocabulary, `flagged` spec, invariants), `fresh.mjs` (shared listing, `dirtyAtBase`), `render.mjs` (message). Contract: `reference/records.md` (`snapshot` section).

**Tests** (`tests/flagged.test.mjs`, 12; one in `tests/fresh.test.mjs`):
- the regression for both flags, with a raw `status` control and the @2 digests shown blind;
- the **close regression**: a hidden edit after Open gives exit 2 and nothing written, and `--status incomplete --reason snapshot-changed` succeeds;
- an unchanged file stays `equal` after a touch, but is not reconstructible;
- flag set, cleared and switched;
- a sparse file is stable and reappears as `changed`; a missing assume-unchanged file is `changed`;
- a secret is never opened, compares `unverified`, and is a limitation;
- a filter attribute on a flagged file: hashed raw, the filter never runs, an edit is `changed`;
- limits: size and budget skips, limitations, `unverified`;
- a flagged file behind a junction is `link`;
- an ordinary repository: zeros, and equality as before;
- an old snapshot is valid and `unverified` against a new one, and a status-visible edit is `changed`;
- schema refusals;
- a `fresh` base with a flagged file is `base-dirty`.

**One test is POSIX-only and unverified:** the executable-bit test is skipped on Windows, which has no executable bit.

### Task B: M2-T5 `resume --ns <ns> [--apply]`
**What it does** (`scripts/lib/resume.mjs`, a new module, which avoids an import cycle with `runs.mjs`):
- **`continue`:** the snapshot still holds. Untracked, coverage or unverified differences return `reassess` (the repositories, and an instruction to close with `--reassessed`). Nothing is written.
- **`abandon`:** the tracked state changed, or a cited file is untracked, absent or unverified in a repository whose untracked or unverified state differs. Without `--apply`, the full plan is returned and nothing changes.
- **`--apply`:**
  1. leftover temporary files are removed;
  2. the run becomes `abandoned` (`snapshot-changed`, `closed`, the wall clock, and a `nthr resume: source recheck` entry);
  3. a run with `continues` opens: same mode, slug, unit and base, and the change re-derived.
- **Debt:**
  - every undecided debt-in item is carried and handed on under its own id;
  - the lead's own debt-out is kept;
  - new `<run>/D<n>` items cover every obligation that is not `held` and every `candidate` or `needs_validation` finding not already referred to;
  - the continuation inherits all of it. `check` passes on the whole chain.
- **Writes:** everything is built and checked in memory first. The abandoned records are the commit point; a crash after it is finished by the next `resume --apply` (`cause: interrupted`). An abandoned run has no `report.md`, and closed runs and other namespaces are never written.
- **Refusals:**
  - no open run;
  - two open runs;
  - unreadable runs, or records naming another run;
  - an open run next to an interrupted one, or two interrupted ones;
  - an invalid parent chain;
  - a clock earlier than Open;
  - a continuation that cannot be prepared;
  - records that would fail `check` (exit 1).
- **Code:**
  - `runs.mjs`: `newRun` is split into `prepareRun` and `createRun`, with unchanged behaviour; `requireRun` takes a reader; a run-id collision is refused before any write.
  - `close.mjs`: its helpers are exported for reuse.
  - `cli.mjs`: `resume`.
  - Contract: a `resume` section in `reference/records.md`, the `new-run` refusal, and the snapshot note. `SKILL.md` now routes a "still open" refusal to `resume`.

**Tests** (`tests/resume.test.mjs`, 8):
- **The lifecycle,** `new-run` → checkpoint → source change → resume → debt carried forward → `check`:
  - parent P (closed, three debt items);
  - R continues P, with held, violated, open and out-of-scope obligations, confirmed, candidate and `needs_validation` findings, inherited debt that is undecided, discharged and carried, and debt of its own;
  - after a committed change, the plan is exact and leaves the project byte-identical;
  - `--apply` gives R abandoned and C with the full debt; `check` passes on P, R and C; P, HEAD and the Git index are unchanged;
  - the next `resume` continues.
- **Continue and reassess:** an unhashed untracked secret, then an uncited untracked file. Nothing is written.
- **Cited untracked file,** edited and deleted: abandon, then `--apply` and `check`.
- **Refusals,** each leaving every byte identical: no open run; two open runs; an unreadable run; foreign records; a `continues` in another namespace; an open base; the clock; open plus interrupted; two interrupted.
- **Exit 1:** invalid records stop both the plan and `--apply`.
- **Crash recovery:** a failure at the commit point leaves R open and unchanged. A failure after it gives `interrupted`; `new-run` is then refused, so the work cannot be orphaned; `--apply` finishes; `check` passes; then `continue`.
- **A leftover temporary file** is listed by the plan and removed by `--apply`.
- **An Incremental run:** the continuation keeps its base and is sized since it, and another namespace stays byte-identical.

### Review
An independent review of both changes found two defects, both now fixed:
- **Snapshot:** a mode-only change to a flagged file still compared `equal`. The executable bit is now in the identity where `core.fileMode` is on. Its test is POSIX-only.
- **Resume:** after an interrupted `--apply`, a plain `new-run` could open a run and orphan the carried debt. `new-run` now refuses while an abandoned run has no continuation, unless it is that continuation.

It checked these and found them fine:
- digest coverage of content, flags and presence;
- unverified content that can never be `equal`;
- the legacy comparison;
- schema guards;
- no Git side effects;
- no write without `--apply`;
- debt rules C4 and C12 (ids, refs, kinds, no duplicates);
- the write order and recovery;
- the `prepareRun` split.

**Full suite: 200 tests, 195 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are the four M1 platform cases plus the new POSIX executable-bit test, and they are **not** passes.

**Residual risks:**
- **Flagged files and close:**
  - a present flagged file makes a snapshot non-reconstructible, and a fresh base `base-dirty`;
  - a flagged secret or oversized file forces `--reassessed` at every close;
  - runs opened before this change compare `unverified` at close and so need `--reassessed`.
- **Resume:**
  - a symbolic `--change` range such as `HEAD~1..HEAD` is evaluated again against the current source for the continuation (the plan shows it before `--apply`);
  - `accepted` and `out-of-scope` obligations also become debt (C5, literally); *Resolved by the C5 amendment, below.*
  - a cited file absent both at Open and now still forces abandon when its repository's untracked state changed (conservative);
  - an interrupted `mkdir` of a continuation is refused with instructions, not repaired.
- **Out of scope, known:** `sizeSinceBase` undercounts hidden edits to flagged files when sizing an Incremental budget. The full in-skill resume flow is M3. *The sizing gap is resolved below.*
- **Unverified platforms:** macOS, Linux, real symlinks, the executable bit and Node 20. G1 and G2 remain Windows-only.

**Next roadmap task: M2-T6 `decide` and `status`** (decisions C2, C3). M2-T7 `charter` (gated) follows; then gate G2, which needs both OSes.

## Lifecycle fixes, M2-T6 `decide`/`status` and M2-T7 `charter` (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

### Lifecycle fix 1: abandonment debt (owner decision; amends C5)
- `resume --apply` no longer turns **`accepted`** limitations or **`out-of-scope`** exclusions into debt. They stay in the abandoned records unchanged, as history. The lead may still hand one on.
- **Carried** (C5 as amended), as debt:
  - `open` and `violated` obligations;
  - `held` obligations whose evidence or dependency footprint is `unverified` or `absent` (unverified claims);
  - `held` obligations citing a file `resume` found at risk;
  - unverified findings (`candidate`, `needs_validation`, or an incomplete verification, whatever the verdict);
  - all inherited and lead debt, as before.
- **Machine-checkable:** one predicate, `check.mjs` `carryRequired`, built on `render.mjs` `unverifiedFinding` and `restsOnUnverified`, drives both what `resume` generates and a new `check` rule. An `abandoned` run fails `check` when a carry-required item is named in no `debt.out` entry's `refs`. Resolved obligations are never required, but are allowed. The report output is unchanged.
- **Tests** (`tests/resume.test.mjs`):
  - the lifecycle: an out-of-scope and an accepted obligation are not carried, both stay in the records, and `check` passes on P, R and C;
  - a new C5 test: a held obligation on absent evidence and a rejected finding with an incomplete verification are carried, and the lead's own debt for an accepted obligation is kept. Removing either carried item makes `check` fail with the exact message. Resolved obligations need no debt. The rule applies to abandoned runs only.
  - the cited-untracked held obligation is carried.

### Lifecycle fix 2: hidden-change sizing (owner decision)
- An edit to an assume-unchanged or skip-worktree file is invisible to `git diff`.
- A working-tree size (Task `<repo>`, or an Incremental run without `--change`) is therefore `verified: false` when the repository's snapshot shows a flagged file present, deleted or not read (`snapshot.mjs` `flaggedInWorkingTree`; sparse entries are excepted).
  - A Task run then gets size class `unverified`, the M budget, Opus High and `task-size`.
  - An Incremental run gets the 80-call cap and Opus High.
  - A committed range is unaffected. **An uncertain size is never small.**
- **Tests** (`tests/new-run.test.mjs`):
  - Incremental after a hidden assume-unchanged edit, a hidden skip-worktree edit, or a missing file: unverified, 80 calls, Opus High;
  - a sparse file: verified, 20 calls;
  - Task with a visible edit and a flagged file: unverified, 70/5/30, Opus High, `task-size`;
  - a committed range: S, verified, Sonnet.
- `tests/flagged.test.mjs` now expects the Opus High lead this rule requires.

### M2-T6: `decide` and `status` (decisions C2, C3)
- **`decide --ns --fingerprint --decision --note --by`** (`scripts/lib/decisions.mjs`):
  - appends to `.nth-review/<ns>/decisions.json` (`nth-review/decisions@1`, validated by `schema.mjs` `validateDecisions`), never to a run;
  - provenance: `seq`, `supersedes` (the previous entry for the fingerprint), `by`, `date` and `seen_in` (every run and finding that has the fingerprint);
  - an unknown fingerprint (in no readable run of the namespace) is refused, and so is `pending` or any word outside the vocabulary;
  - in audit namespaces, the official-audit gate applies.
- **No lost update:** an exclusive `decisions.lock`, a re-read under the lock, and an atomic write.
  - A second writer is refused (exit 2) and succeeds when retried.
  - A stale lock is never broken; the message tells the owner to delete it.
  - The lock is removed only by its owner, and also when its own write fails.
  - A corrupt `decisions.json` is exit 1 and is never overwritten.
  - An append that would pass 5 MiB is refused.
- **`status [--ns]`:** read-only (it writes nothing, not even a lock), deterministic, and sorted. It shows:
  - run states and open runs;
  - outstanding debt: the leaves of the closed chain, by kind, with items;
  - findings by fingerprint, with the latest occurrence and decision;
  - the decision history with `superseded_by` and orphans;
  - audit charters.
- A namespace file that cannot be read (`runs/`, `decisions.json`, `charter.json`, or a run's `records.json`) is reported in place, without paths, and never stops the overview.
- **No action on decisions:** the notice "Owner decisions are records only: no nthr command acts on them, and a decision never authorizes changing code." is in the `decide` and `status` output and in `records.md`.
- **Tests** (`tests/decisions.test.mjs`, 7):
  - provenance and supersedes, with an earlier entry byte-identical and runs untouched;
  - refusals: unknown fingerprint, vocabulary, note, author, an unreadable run named, the audit gate;
  - **concurrency**: writer B is run while A holds the lock, B is refused, A completes, B is retried, and both are kept in order;
  - a stale lock, a failed write, a foreign lock;
  - corrupt files (JSON, seq, supersedes, namespace);
  - status: sorting, determinism, the tree unchanged, leaf-only debt, the open run excluded, `superseded_by`, orphans, an unreadable run;
  - review fixes: a bad file without paths, the byte limit, a failed lock write.

### M2-T7: `charter` (gated; decisions N3, C19)
- **`charter --ns audits/<id> --owner --scope --official [--profile] [--budget-sessions]`** (`scripts/lib/charter.mjs`):
  - refused for any non-`audits/` namespace;
  - refused while `OFFICIAL_AUDITS_ENABLED` is false (**it stays false** in `scripts/nthr.mjs`);
  - refused without `--official` (the owner's explicit authorization) or with invalid arguments;
  - refused when a charter exists (**never replaced**) or the namespace already holds files.
- `charter.json` (`nth-review/charter@1`, `validateCharter`) is written exclusively: a hard link (`fsguard.writeAtomic({exclusive})`) that a racing writer cannot replace.
- `new-run` never creates a charter.
- **Tests** (`tests/charter.test.mjs`, 6):
  - refused by default, in process and through the real `nthr.mjs`, whose source keeps the switch false;
  - namespace and argument refusals;
  - **success only through the injected test gate**: created once, `readCharter` is valid, an audit-plan `new-run` copies the profile, `check` passes, a second charter is refused, and an exclusive race gives `EXISTS` with no temporary file;
  - a namespace that already holds files;
  - `new-run` never creates a charter, with the gate open or closed;
  - review fix: a stuck temporary name after the link is not a failure.

### Review
An independent review found four defects, all fixed with regression tests:
- **`status` stopped as a whole on one bad namespace file and could print absolute paths.** Each read is now guarded and reported without paths.
- **`decide` did not enforce the 5 MiB file limit.** An append that would pass it is refused.
- **A lock whose write failed was left orphaned.** It is now removed.
- **An exclusive write could report failure after the charter was in place.** Removing the temporary name is now best effort.

It checked these and found them fine:
- the agreement between generated debt and `check`;
- the sizing paths;
- the lock protocol and re-read;
- `status` determinism;
- the charter gate ordering and the race.

**Full suite: 215 tests, 210 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are the four M1 platform cases and the POSIX executable-bit test, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical.

### Gate G2 (lifecycle) readiness
Every G2 test item exists and is green **on Windows**:
- `footprint` states;
- `pack` caps;
- `close` atomicity and immutability;
- `fresh` (touched, file-changed, current, rename, delete, base-missing after rewrite and gc, base-dirty, transient);
- `resume` (continue, abandon with debt, an untracked-only change, corrupt state with two open runs);
- `decide` append-only;
- `charter` refused by default.

**G2 is not passed:** its criterion is "100% green, both OSes", and macOS has not been run. Like G1, it stays Windows-only until the suite runs on a Mac, together with real symlinks, the executable bit and Node 20.

**Remaining risks:**
- `accept` decisions do not yet suppress re-reporting in later runs (C3 needs freshness integration in the skill, M3).
- Only `status` reads `decisions.json`.
- A stale `decisions.lock` needs manual removal.
- A permanently flagged repository always gets the conservative budget.
- An abandoned run written by the previous `resume` could fail the new check rule (none exist outside tests).
- `readCharter` stays lenient (a minimal `{official: true}` is accepted, as existing tests use).
- An empty `audits/<id>` directory can remain after a failed hard link (a retry is allowed).
- Exclusive writes need a file system with hard links.

**Next roadmap task: M3-T2** (`reference/protocol.md` and `reference/routing.md`), the start of roadmap step 7 (M3-T2…T8, gate G3). G2 also needs its macOS run before it can be declared passed.

## M3-T2 protocol and routing, M3-T3 delegation prompts (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

**What was written:**

| File | Content |
|---|---|
| `reference/protocol.md` (271 lines, limit 350) | Condensed from Protocol v0.1 §2–§12 and contracts C1–C21. It covers: the **operational-state table** (what works, what is helper-only, what is disabled, what is not yet written); principles (obligations as the unit of coverage; business intent before implementation behaviour; defect, risk and doc-drift); namespaces; the lifecycle; budgets and stop rules B1–B5; the 17 concern families, each screened at Plan; obligation status rules; census kinds and the mandatory R3 critique; discharge and evidence; **the five finding categories** and **the confirmation rule**; severity anchors (generalized); debt continuity; snapshot, freshness and continuation; owner decisions vs accepted limitations; and the Task, Incremental and Full Audit modes. Every `check` rule stays in `records.md` and is linked, not repeated. |
| `reference/routing.md` (88 lines, limit 120) | Runtime models: Opus High or Sonnet only, and xhigh only for developing nth-review. It covers: roles R1–R7 with agent, model, effort, budget and state; the agents never used; the lead-model table (the Incremental Sonnet case marked not implemented); recording; the **escalation path as it really works today**; delegation rules; unmeasured cost estimates (with VS1's measurements); and the criteria for a new agent. |
| `reference/prompts.md` (101 lines) | Common rules (settings, evidence first, completion with exactly one recovery message, answers as input, agreement is not evidence) and four templates: **R2** census assist (Sonnet `Explore`, 30 calls, a pack per obligation and seed sites, seeking what a text search misses); **R3** plan-critique (Sonnet `Explore`, 30 calls, checkpointed records, plus a concern-family question and a contradictions list); **R5/R6** refuter (Opus High / Sonnet `reviewer`, 10 calls per finding, pack first, counterevidence first). Every template has explicit model and effort, a budget, its starting evidence, a counterevidence instruction, `checked`/`not_checked`, a strict JSON answer and "answer before the budget is spent". The refuter answer adds `kind` (defect, risk, doc-drift) and supporting `evidence` anchors; an outcome without them counts as not checked. |
| `SKILL.md` (105 body lines) | Links the new references and adds the concern-family screen at Plan. It also gains the confirmation and kind mapping at Verify, the second-refuter step, and the review fixes below. |

**Review.** An independent review checked the references against the code. It verified as accurate: the budgets, the lead models, ROLES, the pack contents, the freshness margin, the close rules, completion, debt-in, C11, the over-budget close, the command list, and the disabled audit statements. It found nine problems, all fixed:
1. **Escalation and continuing an open run were presented as operational.** `resume` works, but the skill only reports its result and stops. `protocol.md` §0 and `routing.md` now say so (M3-T5). A test proves that a Sonnet lead cannot close a triggered run as `incomplete` / `escalation`.
2. **R3 read the checkpointed records before the first checkpoint.** The skill now checkpoints after step 2.
3. **A refuter's `kind` of risk or doc-drift had no mapping to records.** The skill now maps it (a risk keeps no refuter role, as `check` requires).
4. **Nobody set `required_lead_model` when adding a trigger.** The lead now does, and the guardrail allows `run.runtime` and `budget.spent`.
5. **The second refuter is now in the skill.** The protocol says the finding records the second answer, and that this is the lead's rule, not `check`'s.
6. **`prompts.md` no longer claims `check` enforces the whole R5/R6 selection.** The selection lives once, in `routing.md`.
7. **Census search kinds are named** (sites, callers, …), and `census.recipes` ids are sequential.
8. **B3 is the lead's discipline;** `check` caps only the total.
9. **R3 `additions[].anchor` may be null** for a missing family.

The review also found a missing tag: `check` cites N2, which `records.md` did not name. It now does.

**Tests.** `tests/references.test.mjs` (10) holds the references to what is implemented:
- sizes, line endings and links;
- every helper command and option named exists in `COMMANDS`, and no retired names;
- every value of 11 records vocabularies (status, open reason, kind, verdict, debt kind, freshness class, history outcome, trigger, coverage, source trace, observed) and every severity appears in `protocol.md`, together with all 17 families, which R3 also covers;
- the budget table equals `TASK_SIZES` and `initialBudget`, and the lead-model rows match;
- `routing.md`, `prompts.md` and `check`'s `ROLES` agree on agent, model and effort for R2–R7;
- every template has its contract elements, and the common completion and agreement rules;
- the confirmation rule and the five categories are stated once; the official-audit switch is false and Full Audit is marked disabled; xhigh and max appear only as prohibitions;
- every rule tag `check` cites is stated in `records.md`, and no second copy of the `check` rules exists;
- the review fixes;
- the escalation limit, proven by behaviour.

`tests/content.test.mjs` was updated: the R5/R6 rows moved to `routing.md`.

**Full suite: 225 tests, 220 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical.

**Remaining limitations:**
- **Not operational in the skill:**
  - picking up an open run after `resume` (continue or `--apply`), so an escalated run can only be continued by hand;
  - Incremental mode;
  - suppression of `accept` decisions (C3).
  These belong to M3-T5 and later.
- **Not written:**
  - `taxonomy.md` and `census.md` (M3-T4). Until then, `checks` use a family code with a check number that is local to the run;
  - R4 and Full Audit (M3-T6). Official audits stay disabled.
- **Static tests check structure and consistency, not judgment.** Whether a lead applies the family screen or the confirmation rule well is measured in M5.
- **Unverified platforms:** macOS, POSIX symlinks, the executable bit and Node 20. Gates G1 and G2 remain Windows-only.

**Next roadmap task: M3-T4** (`reference/census.md` and `reference/taxonomy.md`).

## M3-T4 census and taxonomy references (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

**What was written:**

| File | Content |
|---|---|
| `reference/census.md` (117 lines, limit 150) | Coverage units (changed file, entry point, site, chain, copy) and the item statuses `classified`, `unknown` and `excluded` with their reasons. Ten search kinds recorded as `census.recipes`: `sites`, `callers`, `entries` (HTTP/API routes and their authorization gates), `schedules`, `events`, `migrations` (including database-side triggers, procedures and scheduled events), `scripts`, `mirrors` (cross-repository copies), `clients` and `dynamic` (unresolved paths). Each kind names its typical blind spots for `limits`. It also gives the procedure (including the step that applies a module when a search finds its boundary), how gaps are recorded (limits, `unknown` items, exclusions, unverified source, facts outside the repositories), R2 assist and R3 challenge, the five conditions for `all-enumerated` (the first is `snapshot.discovery_complete`, which `check` enforces), and bounded stopping. **A search that returns no further hits never proves that nothing else exists.** |
| `reference/taxonomy.md` (335 lines, limit 450) | The four screening outcomes and how each is recorded. The rules: one owning family per check; missing documentation is never proof of a defect (it is a `risk`, `needs-owner-intent`, or ARCH.3); only source-supported, independently verified findings are `confirmed`. Severity anchors and impact dimensions (moved from `protocol.md`). The 17 families, each under its own `###` heading with objective, checks (`FAMILY.n`, 101 in all), failure mechanisms, evidence and counterevidence, severity, runtime validation and indirect paths. The owner table for overlapping concerns, and 15 technology-neutral modules with `MODULE.n` checks; AI concerns are in the LLM module. |
| `reference/protocol.md` (227 lines) | The family table, census kinds table, severity table, R3 question list and census-limit rule were replaced by links, so each lives once. §0 now lists only R4 as not written. |
| `reference/prompts.md`, `SKILL.md` (106 body lines), `reference/records.md` | R2 reports the census kinds. R3 also asks which module boundary has no module check. The skill screens all 17 families in `taxonomy.md`, lists the not-applicable codes in `scope.summary`, separates a family left out for the cap or budget (`deferred-scope` debt) from one excluded by the task boundary (`out-of-scope`, `coverage: excluded`), and adds module checks in the census step. The check id row in `records.md` names `MODULE.n`. |

**Deviations from the research taxonomy** (`audit-taxonomy.md`):
- **Modules renamed to be technology-neutral:** EXPRESS → HTTP-SERVER, NEXT → SSR-WEB, MINORS-DATA → SENSITIVE-SUBJECTS, and the extension and native targets → CLIENT-TARGETS (no numbered checks in this version). The checks keep their meaning.
- **Severity anchors generalized:** the project-specific examples were dropped.
- **The runtime catalog (RT1–RT12) is not included.** Runtime validation is described per family, and a claim that needs execution stays `open` / `needs-runtime` or `needs_validation`.

**Review.** An independent review checked the references against `schema.mjs`, `check.mjs`, `render.mjs` and `records.md`. It verified the census fields, statuses, path forms and recipe limit; the `discovery_complete` and C11 rules; the report claims in `census.md`; the check id format; the severity and impact vocabularies; and that the screening mapping fits the schema. It found seven problems, all fixed:
1. **The skill contradicted the taxonomy:** it made every left-out family `deferred-scope` debt, so a boundary exclusion would have become debt that later runs must carry. The skill now separates the two cases.
2. **Modules had no operational step.** `census.md` now applies a module when a search finds its boundary, the skill says so, and R3 can name a missing module.
3. **The owner table did not cover every overlap.** It now also decides idempotency, mirrored copies, unsafe defaults and per-user caches. A module adds only to families.
4. **AUTHZ said "always the R5 refuter",** which contradicted `routing.md` and `check`. The refuter now follows `routing.md`.
5. **No finding kind fitted missing documentation.** It is now a `risk` or an `open` / `needs-owner-intent` obligation under ARCH.3; `doc-drift` is only for documents that contradict the code.
6. **SSR-WEB used one framework's vocabulary.** It is now framework-neutral, and the test also refuses framework terms.
7. **R2 had no recipe recording:** its answer has no pattern or hit count. It is now one recipe, `r2: <obligation-id>`.

The review also found tests too thin to guard what they named. The tests now pin all five `all-enumerated` conditions, and a behavioural test proves that the screening outcomes are recordable.

**Tests.** `tests/references.test.mjs` now has 16 tests (6 new, 2 updated):
- sizes, line endings, links **and their heading anchors** for all five references; the skill loads `taxonomy.md` and `census.md`;
- the severity rows in `taxonomy.md` equal the records severities, in order, and `protocol.md` keeps no second family table;
- the 17 families, in order, each with its seven fields; checks numbered 1..n, at most 7 per family, 101 in all, each matching the schema's check id format (the test holds the same expression as `schema.mjs` and asserts it);
- the screening outcomes use real records vocabularies, and the skill states the same split;
- **behaviour:** `check` accepts a run that records every screening outcome (a `scope.summary` not-applicable list, `out-of-scope` with `coverage: excluded`, `held`, `open` / `needs-owner-intent`, `deferred-scope` debt) with family and module check ids. A probe confirmed the test can fail: `check` refuses the same run with a `held` obligation without evidence, and with a lower-case check id;
- the modules: the 15 names, at most 5 checks each, numbered 1..n, adding only to families, each named in the R3 template, with the census and skill steps that apply them; no technology or framework names; and the LLM module covering the five AI concerns;
- every check id that the skill and the references cite exists in `taxonomy.md`;
- `census.md` names exactly the records@1 recipe and item fields (read from `schema.mjs`) and every census status; its kinds equal the R2 template's; all five `all-enumerated` conditions; "absence proves nothing"; the R2 recipe; the 50-recipe limit.

The behaviour of the `discovery_complete` rule was already covered by `tests/check.test.mjs`.

**Full suite: 231 tests, 226 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged.

**Remaining limitations:**
- **Static tests check structure and consistency, not judgment.** Whether a lead screens families well, picks the right census kinds, or claims `all-enumerated` only when it is justified is measured in M5.
- **`check` enforces only part of the census rules:** the `discovery_complete` rule, reasons for `unknown` and `excluded` items, and (in Incremental runs) an item for every changed file. The other `all-enumerated` conditions, the recipe kinds, and the "one search per unresolved hop" rule are the lead's discipline, challenged by R3.
- **The not-applicable family codes live in `scope.summary`,** which the report does not render. R3 reads them; the report reader does not see them.
- **Module checks are not tied to census facts by `check`:** any id matching the format is accepted.
- **`check` does not refuse `all-enumerated` when an `unknown` census item affects the obligation,** and the report can then label it "Verified". `census.md` forbids it, but only R3 would catch it.
- **Some rules are restated where the lead uses them:** the "concurrency and performance are never `held` on source alone" rule appears in `protocol.md`, `SKILL.md` and the ATOMIC and PERF sections. Tests pin each copy.
- **The `fields()` test helper parses `schema.mjs` source text,** so reformatting the schema can break it.
- **Not operational in the skill:** Incremental mode, picking up an open run after `resume`, and suppression of `accept` decisions (M3-T5 and later). R4 and Full Audit are not written (M3-T6); official audits stay disabled.
- **Unverified platforms:** macOS, POSIX symlinks, the executable bit and Node 20. Gates G1 and G2 remain Windows-only.

**Next roadmap task: M3-T5** (Incremental mode in the skill).

## Coverage-gap fix, report additions, runtime catalog, and M3-T5 Incremental Review (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

**Coverage gap (found in M3-T4).** Before this change, an obligation could claim `all-enumerated`, pass `check`, and be reported as "Verified" while an `unknown` census item bore on it.
- **The shared rule:** `coverageBlockers(doc, obligation)` in `scripts/lib/render.mjs`, used by both `check` and the report. These census items contradict an `all-enumerated` claim:
  - an `unknown` item whose `affects` names the obligation;
  - an `unknown` item whose `affects` is null or empty: with no established relationship, it bears on **every** obligation (the conservative reading);
  - an `excluded` item that names the obligation (part of its population was left out on purpose).

  An `excluded` item naming no obligation (or only other ones), an `unknown` item scoped to other obligations, and `classified` items do not block anything.
- **`check`** refuses such a claim (C13) on every **concluded** obligation (any status but `open`), in open and closed runs alike. An `open` obligation's coverage is still a target, so it never blocks a checkpoint or an abandon. `check` stays read-only.
  - `close` refuses and writes nothing.
  - A closed run is never rewritten (C1). A run closed before this change with such a claim would now fail `check --run`. None exists in the tests or in VS1, whose census items are all `classified`.
- **The report** never labels such an obligation "Verified", even from records `check` would refuse, and lists it under "Unverified or missing evidence".

**Report additions:**
- `## 2. Coverage` opens with the scope summary and family screening **as recorded** in `scope.summary`. It is shown in a table cell, so its text cannot inject structure, or as "None recorded.". Nothing computes or checks it.
- An Incremental report adds freshness against the base:
  - the history outcome per repository;
  - changed-file counts;
  - a table of the base obligations, with each one's class and what this run did with it (re-recorded with its status, or concluded in the base).

**Runtime catalog.** The research defers the runtime-experiment harness from v1 (`nth-review-decisions.md` §4), and no v1 milestone owns it. `reference/taxonomy.md` now keeps the RT1–RT12 catalog as guidance, under `## Runtime validation catalog (deferred)`:
- the isolated-environment prerequisites, made project-neutral;
- each experiment, with the checks it settles. Each mapped check id was confirmed to keep its research meaning, and the renamed modules are used.

It states that nth-review runs none of them. A `needs_validation` plan or `runtime` debt names the RT id. RT12 is an `environment` assumption plus `owner-fact` debt. No runtime engine was added.

**M3-T5 Incremental Review in the skill:**
- **`SKILL.md`** (115 body lines, limit 120):
  - `incremental --ns <ns> --slug <slug> --base <run-id>` is accepted. The §2 lead check runs **before** `new-run`, because Incremental always needs Opus at high effort; a mismatched session never opens a run.
  - A new §4 adds: `fresh`, and `status` read once; debt-in as mandatory scope; re-recording and resetting every `touched`, `file-changed` and `assumption-changed` base obligation under its id, then reassessing it; `current` obligations stay concluded in the base unless a changed file's census item bears on one; base findings recorded again as candidates with the same fingerprint and verified again; a census of every changed file; R3 when new write or authorization paths appear.
  - The guardrail lets the lead set a freshness class to `assumption-changed`, with its reason, and nothing else.
- **`check`** (C11), in `complete` and `incomplete` Incremental runs, refuses:
  - a non-current base obligation that the run does not re-record;
  - a re-recorded `held` or `accepted` one whose evidence is the base's, unchanged, in any order.

  This is the mechanical guard against carrying a stale conclusion forward. It catches a copy, not the absence of a reassessment, so the skill asks for evidence notes that say what was re-read.
- **`protocol.md`** (251 lines): the §0 rows are now operational; §10 gives the Incremental order and what carries over; a new §11 covers continuing a run.
  - On a `new-run` refusal ("still open", or abandoned with no continuation), the lead runs `resume`.
  - On `continue`, it tells the user which run this is and asks once (it may belong to another session), re-checks the lead model against the run's requirement, records itself, reruns `fresh`, and picks up at the first step not done.
  - On `abandon` with cause `tracked-changed` or `cited-untracked`, it shows the plan and asks the user once before `--apply`, then works in the `run_dir` that `--apply` prints. The abandoned run is history.
  - On cause `interrupted`, it runs `--apply`.
  - On exit 1, it fixes the records first.
- **`routing.md`:** an escalated run continues only when the user starts a new session on Opus at high effort. Nothing switches models automatically. Runtime models remain Opus at high effort or Sonnet, never xhigh.

**Pre-implementation analysis and review.** The `architect` agent mapped the work against the implementation plan (M3-T5), Protocol v0.1 §12, the decisions (§4 deferrals) and the research taxonomy (§6). An independent review then checked the result against the code. It verified:
- `coverageBlockers` and its use in the only place "Verified" is produced;
- that C13 runs before any report is written;
- the parent used for the evidence comparison (`run.base`, also in continuations);
- the `resume` fields and refusal wording;
- the model routing;
- that the RT catalog is faithful to the research.

It found five problems, all fixed:
1. **The copy check compared evidence byte for byte.** Reordering the evidence evaded it, an `accepted` copy was not caught, and an honest quick re-hold had no stated remedy. The check now compares evidence as a set and covers `accepted` too, and the skill asks for notes that say what was re-read.
2. **C13 applied to `open` obligations,** whose coverage is only a target. That could block a checkpoint, or `resume` abandoning an interrupted run. It now applies only to concluded obligations, and §11 names C13 as one cause of exit 1.
3. **§11 said `run` is always the run to work in.** For an abandon plan, `run` is the run being abandoned. §11 now says so, and points to the `run_dir` that `--apply` prints.
4. **The skill's exit-2 rule did not except the `new-run` refusals it handles.** It now does. Continuing an open run now asks the user first, because the run may belong to another session.
5. **Missing tests:** an abandoned run is exempt, reordered and `accepted` copies are refused, and an open obligation's target does not block.

**Tests** (9 new, 4 updated):
- **`tests/check.test.mjs`:**
  - C13 negatives: the original case, an unknown item naming no obligation (null or `[]`), naming it among others, an excluded item naming it, and an open run.
  - C13 positives: an unknown item scoped elsewhere, excluded items naming no obligation or another one, and `classified` items.
  - The Incremental rules: dropped, copied (also reordered, and as `accepted`), recorded again, `current`, open and abandoned; and an open obligation's `all-enumerated` target does not block.
- **`tests/close.test.mjs`:**
  - an end-to-end close refusal that writes nothing;
  - **the original false-Verified case at render level**, from inconsistent closed records, in four variants, plus three scoped or justified items that keep "Verified";
  - `check` stays read-only on a closed run;
  - the scope summary as recorded, safe from injection, and "None recorded.";
  - no freshness section in a Task report.
- **`tests/fresh.test.mjs`:**
  - the Incremental close now re-records its touched and assumption-changed obligations, and the report's freshness table is asserted;
  - a dropped or copied conclusion is refused, while a `current` one stays "concluded in base";
  - **continuing an Incremental run:** `new-run` refuses, `resume` continues and writes nothing, and `fresh` again is stable. After a tracked change, the abandon is refused while a changed file has no census item, the plan then writes nothing, and `--apply` opens a continuation that is classified against the same base.
- **`tests/references.test.mjs`:**
  - the §0 truth;
  - the Incremental skill steps for every freshness class;
  - the protocol order;
  - the continuation procedure against the helper's own refusal words and `resume` answers, including asking before continuing or abandoning;
  - no claim of automatic model switching;
  - the RT1–RT12 catalog and its deferral;
  - the escalation test now also continues the run under an Opus lead.

**Full suite: 240 tests, 235 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged.

**Remaining limitations:**
- **Chain continuity:** `current` obligations are not re-recorded (the research's "reassessed + new"). A later Incremental run based on this run therefore does not recheck the earlier conclusions. The workaround is to base it on the run that concluded them, or to run a Task Review. This is an open owner decision.
- **What `check` cannot prove:**
  - that a reassessment happened (it catches only an unchanged copy, so a confirmation must change its evidence or note);
  - that an indirectly affected `current` obligation was found (G5, measured in M5).
- **An Incremental run cannot be abandoned while a changed file has no census item.** `resume` refuses with exit 1 and writes nothing, and the lead records the census first.
- **On continuation,** the new lead's model replaces the previous lead's in `run.runtime`. The escalation trigger stays recorded, but the escalating lead's identity does not.
- **Not implemented:**
  - C3 (suppression of `accept` decisions); re-reported fingerprints show `decision: pending`;
  - the Sonnet lead for a quiet Incremental run;
  - R4 and Full Audit (M3-T6). Official audits stay disabled.
- **Static tests check structure, not judgment.** Whether a lead reassesses well is measured in M5 (SYN-INC, SYN-DEBT).
- **Unverified platforms:** macOS, POSIX symlinks, the executable bit and Node 20. Gates G1 and G2 remain Windows-only.

**Next roadmap task: M3-T6 Full Audit mode** (`audit plan | unit <id> | close` and the R4 judgment critic; `charter` stays gated until release, C19).

## Incremental chain gap: the effective baseline (owner decision, 2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

**The gap.** M3-T5 recorded it as an open limitation (*Chain continuity*). An Incremental run does not record its `current` obligations again. So a later Incremental run based on it classified only that run's own obligations, and earlier conclusions silently dropped out of review. **The owner's decision:** resolve an effective baseline through the validated run ancestry. This section closes the limitation.

**The design** (`architect` pre-analysis; one resolver shared by `new-run`, `fresh`, close and `check`):
- **`effectiveBaseline`** (`scripts/lib/runs.mjs`) walks `run.base` from the base while each run is Incremental, and stops at a Task run, which is a full baseline.
  - It never follows `continues` or abandoned runs: their work reaches the continuation through debt (C5).
  - The nearest run that records an id is that obligation's **origin**, and its version is authoritative. Unchanged obligations are never copied forward.
  - Every ancestor is validated like a base: same namespace, valid records naming it, `complete` or `incomplete`, and not an audit run. A loop, more than 100 runs, or more than 2,000 obligations is refused, and the message names the broken ancestor.
  - No ancestor's `freshness` is read, so a stale one cannot hide anything.
- **`fresh`** keeps the census (history outcomes, changed files) against the immediate base. It classifies each obligation against its **origin**:
  - the origin's footprint;
  - the history since the origin's Open snapshot, renames and mode changes;
  - the obligation's anchors in the origin run: evidence, dependency assumptions, intent, and its findings' trace and counterevidence.

  The existing uncertainty rules apply per origin: unverified, dirty with content never stored, a pruned origin head, or a changed owning repository all give `touched`. **An obligation still `open` in its origin was never concluded, so it is `touched`.** This also applies one level deep, and is documented. A lead's `assumption-changed` is kept with the resolved origin.
- **Records:** `freshness.obligations[]` gains an optional `origin`, written only when it is not `base_run`. One-level freshness is byte-identical to before. Existing records, and VS1 (a single Task run with no freshness), stay valid.
- **`check`** (complete and incomplete Incremental runs):
  - the ancestry must resolve, otherwise `$.run.base` names the broken ancestor;
  - freshness names every effective-baseline obligation exactly once, with no other id, and with its resolved origin;
  - every non-current entry is recorded again;
  - a `held` or `accepted` one must not carry its **origin** version's evidence unchanged;
  - an obligation recorded under an inherited id keeps that version's claim, so a new obligation cannot silently replace an inherited one.

  Close still recomputes the classes and refuses any difference. A `complete` Incremental run with no changed file, whose inherited obligations are all `current`, is not empty: without this, the no-duplication rule would force copies or an `incomplete` close. A changed file still needs a recorded obligation.
- **`new-run`** resolves the effective baseline at Open, so broken ancestry is refused before any work, at `resume` too. The Incremental obligation cap is the effective baseline's size + 15.
- **Report:** the freshness table lists inherited obligations; a `current` one shows "concluded in <origin run>".

**Review.** An independent review checked the change against the code. It found no path by which an inherited obligation is classified `current` while its origin evidence, dependency anchors, intent or findings changed, or its history is unverifiable:
- a pruned or unborn origin head;
- a removed, moved or re-owned repository;
- a rename since the origin;
- an unverified footprint;
- a dirty origin whose content was never stored;
- an origin version that is still open.

It found no census gap, no write to an ancestor, and no unbounded or quadratic work. It confirmed that one-level freshness is unchanged byte for byte. It found two problems, both fixed:
1. **The "not empty" exemption ignored changed files.** A `complete` run could then close with changed code and no obligation. The exemption now applies only when no file changed. A test covers both cases.
2. **A new obligation could silently replace a `current` inherited one by reusing its id.** `check` now requires a re-recorded inherited id to keep that version's claim. Negative tests cover a reused `current` id and a reused changed one; a legitimate re-record still passes.

It also noted a compatibility point. A closed Incremental run built on another Incremental run *before* this change would now fail `check`, and cannot be rewritten (C1). None exists outside the tests.

**Tests** (7 new, 3 updated, plus fixture updates):
- **The owner's three-run regression** (`tests/fresh.test.mjs`), on real Git fixtures with real closes:
  - **R1** verifies OB-1, OB-2 and OB-3.
  - **R2** changes only OB-1's line: OB-1 is `touched`, and OB-2 and OB-3 are `current` with no origin written. R2 records OB-1 again and closes.
  - **R3** changes OB-2's line. OB-2, which R2 never recorded, is found: `touched`, `origin` R1, with the reason naming R1's lines. OB-1 is `current` against **R2's** footprint; against R1 it would be `touched`. OB-3 stays `current` against R1.
  - Closing R3 without recording OB-2 again is refused, and so is recording it with R1's evidence copied. Both refusals write nothing.
  - A proper review closes, and `check` passes. The report shows "concluded in R2" and "concluded in R1".
  - **R4**, with nothing changed, resolves each obligation to its latest version across three runs: OB-2 from R3, OB-1 from R2, OB-3 from R1.
- **Variants:**
  - an indirect change through a dependency anchor;
  - a changed finding trace on an inherited violated obligation;
  - a **dirty origin**, whose content was never stored: `touched`, "content unavailable", never `current`;
  - an obligation still open in its origin;
  - an `assumption-changed` entry that names a wrong origin gets the resolved one.
- **Missing and corrupt ancestry:**
  - R1 removed: `new-run` on R2 is refused, and `check` on R2 reports `$.run.base`.
  - R1 corrupted while R3 is open: `fresh` and close refuse and write nothing; restored, R3 closes.
- **The resolver** (`tests/baseline.test.mjs`, in memory):
  - supersession and order;
  - stopping at a Task run;
  - `continues` and abandoned runs not followed;
  - missing, invalid, foreign-namespace, open, abandoned and audit ancestors;
  - a loop;
  - exactly `MAX_BASE_CHAIN` runs pass and one more is refused;
  - the 2,000-obligation limit.
- **`check`** (`tests/check.test.mjs`), on a three-run records chain:
  - a skipped inherited obligation, an id outside the baseline, a duplicate, a redundant, wrong or missing origin, a dropped changed inherited obligation, its origin's evidence copied, and another claim under a `current` or a changed inherited id;
  - an ancestor outside the namespace;
  - an all-current `complete` run with no changed file is not empty; with a changed file and no obligation it is.
- **The reference tests** pin the new rules in `records.md`, `protocol.md` and `SKILL.md`, and that the chain limitation is gone.

**Full suite: 247 tests, 242 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged. Official audits stay disabled.

**Remaining limitations:**
- **Broken ancestry blocks the chain.** If an ancestor is removed or corrupted, no Incremental run can build on its descendants; the way out is a new Task Review baseline. Closed runs are never rewritten.
- **Census vs. classification.** `changed_files` (the census) stays relative to the immediate base. An inherited anchor that changed between its origin and the base is still classified `touched` against its origin. Such a change can only arise when an intermediate run's freshness was itself unverified, and its file then has no census item.
- **Reused ids.** `check` refuses another claim under an inherited id. A new obligation that reuses an inherited id **and** copies its claim word for word cannot be told apart from recording it again.
- **Old records.** A run closed before this change that is Incremental on top of another Incremental run would now fail `check`. None exists outside the tests.
- **Cost.** Each distinct non-base origin repeats one history and changed-file pass per repository, at `fresh` and at close. This is bounded by the 100-run ancestry limit.
- **`continues` and `base` are not tied together.** A hand-run `new-run --continues A --base X` whose `X` is not `A`'s base resolves the baseline from `X`. `resume` always copies the base. This behaviour predates the change.
- **Unchanged from M3-T5:**
  - `check` cannot prove that a reassessment happened (G5 is measured in M5);
  - C3 is not implemented;
  - the Sonnet lead for a quiet Incremental run is not implemented;
  - R4 and Full Audit are M3-T6.
- **Unverified platforms:** macOS, POSIX symlinks, the executable bit and Node 20. Gates G1 and G2 remain Windows-only.

**Next roadmap task: M3-T6 Full Audit mode** (`audit plan | unit <id> | close` and the R4 judgment critic; `charter` stays gated until release, C19).

## M3-T6 Full Audit workflow and the R4 judgment critic (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell.

**Safety first.** `OFFICIAL_AUDITS_ENABLED` stays `false`. No official audit was opened, and the kit holds no `.nth-review/`.
- Every audit behaviour was exercised on disposable synthetic projects through the existing in-process test gate (`nthr(args, { official: true })`). No command-line option or environment variable reaches it (asserted).
- The skill stops on an audit request, and its frontmatter does not offer a disabled mode.

**Design** (`architect` pre-analysis against the plan card M3-T6, C19, C20, Protocol v0.1 §12 and model-routing.md):
- **`audit close`** is an `audit-unit` run with the reserved unit `close`, never a ledger unit. No new command, agent or dependency.
- **Authorization:**
  - the charter gains a required owner `exclusions` (`--exclusions`, explicit, "none" allowed);
  - `new-run`, `check`, `close`, `resume` and `decide` now admit only a **complete** charter naming its namespace. A partial or hand-made `{"official": true}` file used to pass.
  - `resume` now refuses an `audits/` namespace while disabled, even for `continue`. Before, it answered `continue` without the gate. It wrote nothing, but it told a lead to keep working in an official audit run.
- **The chain** (C20) is linear: one root plan, and every later run builds on the chain head (fork refused at Open and in `check`). In audit runs, `--continues` names only the abandoned run being carried on. Any other parent took debt-in past the head and dropped its debt.
- **The ledger** gives each unit an optional `scope` (required in plan runs), and `depends_on` has no cycles.
  - **Only a plan run edits units:** it never drops one, rewrites `runs`, concludes a unit, puts an existing unit out of scope, or lowers a priority.
  - **Gating:** a unit runs only when `planned` or `incomplete`, with its dependencies `complete`.
  - **`close` owns unit status:** a unit run's close records its own unit (`runs`, and `complete` or `incomplete` with the reason).
  - **The audit close** downgrades every `complete` unit whose last run's cited files changed or cannot be verified.
- **Completion:**
  - a plan, and the audit close, are `complete` only with complete discovery and no `unknown` census item;
  - the audit close also needs every unit `complete` or `out_of_scope`, and at least one unit `complete`, and records no obligation of its own;
  - **debt amendment** (C4 with C20; protocol §8): a unit run is blocked only by its own unit's earlier debt, a plan run by none; the audit close stays strict.
- **R4:**
  - It has its own template in `prompts.md`: `reviewer`, `opus`, `high`, at most 10 calls; packs first; questions on weak closures, coverage claims, missing paths, assumptions and severity; challenges answered in JSON.
  - It is kept apart from R3 (coverage) and R5/R6 (refutation), and is never a verification role.
  - A Tier-1 unit closes `complete` only with a completed R4. The protocol says how each challenge is handled; R4 never confirms, rejects or upgrades anything.
- **Reports** (audit runs only, so VS1 is unaffected):
  - a scoping line: a plan reviews no unit; a unit run concludes its unit only; the audit close says "Whole audit: complete at this snapshot" only when warranted, and otherwise says why not;
  - reviewed and not-reviewed units, and a ledger table with each unit's last run (provenance);
  - at the audit close, what each unit's last run left unresolved (open and violated obligations, confirmed defects by severity, unverified findings, risks, debt);
  - "Not an official audit" outside `audits/`;
  - plans and the audit close never show "Verified".

**Review.** An independent review reproduced its findings on synthetic projects. It confirmed:
- the gate paths;
- the `readCharter` tightening;
- chain linearity;
- ledger continuity;
- unit gating;
- the drift check (changed, unverified, absent, unidentifiable, unreadable);
- R4 routing and its separation;
- the debt amendment.

It found seven problems, all fixed with regression tests:
1. **`--continues` could drop the head's debt** (F1).
2. **A re-plan could move an unfinished unit out of scope,** so the audit could close "complete" with nothing reviewed (F2).
3. **The audit close could record obligations,** and so a whole-project "Verified" (F3).
4. **A re-plan could lower a tier** to skip R4 (F4).
5. **The close report did not roll up unit findings or debt** (F5).
6. **Audits in `experiments/` were not labelled unofficial** (F6).
7. **Test gaps:** the above, plus `resume`/`decide` with the gate off, and two weak assertions (F7).

Testing F7 also exposed the `resume` gap described above.

**Tests** (11 new, 5 updated):
- **`tests/audit.test.mjs`:**
  - the lifecycle (plan → Tier-1 unit with R4 → unit → audit close, with ledger provenance and scoped reports);
  - gating (dependencies, deferred and out-of-scope units, a cycle, the reserved id, a missing scope);
  - the linear chain and ledger continuity (fork, second root, hand-made fork, edits by unit runs, re-plan limits);
  - incomplete units and the debt amendment (another unit's debt does not block; the unit's own debt does);
  - an interrupted unit resumed;
  - drift (a changed file and a deleted file);
  - the `--continues` guard;
  - re-plan out-of-scope and tier guards;
  - the audit close with no reviewed unit, and with obligations;
  - plan and close never Verified, even from inconsistent records;
  - the unresolved roll-up;
  - the unofficial label;
  - the gate (`new-run`, `check`, `close`, `resume`, `decide`, the spawned CLI, a partial charter, no option or environment path).
- **`tests/references.test.mjs`:** the procedure, the ledger rules, R4's routing, template and separation, and the reports' claims.
- **Updated:** `charter.test.mjs` (exclusions) and `new-run.test.mjs` (complete charters, via a new `writeCharter` test helper).

**Full suite: 259 tests, 254 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged.

**Remaining risks and limitations:**
- **Disabled until release** (C19). The workflow has run only on synthetic fixtures. A real audit needs the release criteria (G1–G6) and an owner charter. How a lead actually plans, splits units and handles R4 challenges is measured later (M5 and M6).
- **Owner confirmation of scope and exclusions** is enforced only through the charter fields. That the lead shows them to the owner and records them in `scope.summary` is the lead's discipline. `out_of_scope` units are not matched against the charter text.
- **Tier is assigned by the lead.** R4 is required for Tier 1, and a re-plan cannot lower a tier, but the root plan's tier choice is not checked.
- **Closed records are not tamper-evident.** `check` accepts any hand edit that stays self-consistent. This predates M3-T6.
- **Budget:** R4 uses one of the 4 subagent calls of a unit run; V-COST will calibrate it.
- **Not implemented:**
  - parallel unit runs (deferred by C20);
  - `status` showing the ledger;
  - aggregating unit findings beyond the per-unit counts.
- **Unverified platforms:** macOS, POSIX symlinks, the executable bit and Node 20. Gates G1 and G2 remain Windows-only.

**Next roadmap task: M3-T7** (`THIRD-PARTY-NOTICES.md`: the MIT notice for the adapted Cloudflare prompt wording, decision D3, with upstream commit `c1c8a8c` and the list of adapted sections).

## Root audit plan tiers, and M3-T7 third-party notices (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell. Official audits stay disabled; everything ran on synthetic fixtures.

### Root audit plan tiers

**The gap** (M3-T6 review): the root plan's tiers were never checked. A unit could have no tier, or one with no stated reason, and Tier 1 (which needs R4) depended entirely on an unrecorded judgment.

**The change** (`architect` pre-analysis):
- **Each unit can record its basis:** `[{ anchor, note }]`, at most 20 entries. These are anchors to what shows the unit's priority (an owning document section, or the code that handles authorization, money or stored data), each with a note on what it shows.
  - The field is optional in the schema, so older records stay valid.
  - It is structured rather than free text, so it can be checked without parsing prose.
  - Basis anchors are not cited: they classify the unit, they are not evidence. Citing them would let one unit's basis file downgrade another unit at the audit close.
- **`check`, when a plan closes `complete`:** each active unit (any status but `out_of_scope`) needs a tier from 1 to 3 and a basis whose every note is non-blank. A plan still open, or closed `incomplete`, may leave a unit honestly unclassified rather than guess a tier. That unit cannot run until a re-plan classifies it.
  - It checks presence and form only. It never judges whether a tier is right, and never infers risk from file or dependency names.
  - The protocol tells the lead that a name alone is no basis. When nothing documents criticality, the note says so, and in doubt the lead prefers the higher tier.
- **An unclassified unit cannot run** (`new-run` and `check`: "classify it in a re-plan first"). The audit close cannot be `complete` while a `complete` unit is unclassified, and the report then lists the units that are not classified, using the same `unitClassified` rule as `check`. Basis anchors are not checked to exist, and are not tracked for change; the protocol says so.
- **Kept:** a re-plan never lowers a tier; null ranks lowest, so classifying a null tier is allowed. A Tier-1 unit completes only with a completed R4.
- **New:** a re-plan that raises a `complete` unit to Tier 1 must reopen it, so its next run is reviewed with R4. The architect found this gap: a unit raised to Tier 1 after its review would otherwise have counted as complete without R4.

### M3-T7: `THIRD-PARTY-NOTICES.md`

**Provenance.** Verified on 2026-10-26 by fetching from GitHub:
- the commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` of `cloudflare/security-audit-skill` (2026-09-14, "Clarify guidance and full audit modes");
- its file tree;
- `LICENSE`, `VALIDATION-AND-REPORTING.md`, `HUNTING.md`, `SKILL.md` and `RECONNAISSANCE.md`.

Every file's Git blob hash matched the commit tree. The MIT notice (`Copyright (c) 2025-2026 Cloudflare, Inc.`) was embedded from the fetched bytes, not retyped, and its SHA-256 (`e598e694…6391`) is stated in the notice and pinned in the test.

**What the notice lists.** The upstream text was compared with nth-review's references.
- **Adapted wording**, each section also marked in place with a pointer to the notice:
  - the R5/R6 refuter template ("Candidate-verifier prompt");
  - the R3 plan-critique questions, and R4's first question ("Coverage-critic waves");
  - the severity anchors in `taxonomy.md` ("Separate priority from certainty");
  - the module-selection rule ("Architecture summary and companion selection");
  - the second-refuter rule in `SKILL.md` §3 and `protocol.md` §7 ("Phase 5: Verify the final records with fresh eyes").

  A word comparison of all 16 upstream Markdown files at the commit against `SKILL.md` and `reference/*.md` found shared runs of five or more words only in these sections. The one exception is the five-word term "account linking and identity collision" (`taxonomy.md`, AUTHN.6), which the notice records without a mark.

  Decision D3 named only the refuter and critic prompt wording. The comparison also found the severity anchors and the module-selection sentence, so they are listed too, rather than understating the adaptation.
- **Methodology restated in our own words, listed for transparency:** the candidate gate; the verdict model; independent verification; the budget reserve; the coverage critic role and no completeness from silence; prior-run continuity; audit ledger states; plain reporting of partial passes.
- **Written for nth-review:** the helper, the records schema, obligations, the census, snapshots, footprints, freshness and the effective baseline, debt and decisions, the charter, the Full Audit chain, routing, R2, the taxonomy's families and checks, and the tests. Some apply the ideas above; the comparison found no upstream wording in them.
- **Scope:** the notice states that nth-review is not affiliated with or endorsed by Cloudflare. It reproduces the upstream notice because MIT requires it with copies of that text, and grants no license of its own: not to nth-review's contributions (including its changes to the adapted text), not to the rest of nth-review, and not to nth-dev-kit, which has no license file. `.gitattributes` keeps the file LF, so the reproduced notice stays byte-identical.

**Review.** An independent review re-fetched the upstream files and confirmed:
- the license block is byte-identical to the pinned `LICENSE`;
- the listed sections match upstream;
- no other reference file shares a run of seven or more words with upstream.

It found no hole in the tier rules, including the R4 paths and unit gating. Its points, all addressed:
1. **The scope sentence said MIT "governs" the adapted portions.** That could put the owner's own changes under MIT, so the notice now grants no license and only reproduces the upstream notice.
2. **The "not derived" list was absolute** and overlapped the methodology list. It is now "Written for nth-review", scoped to the comparison. A five-word scan of all 16 upstream Markdown files then found the second-refuter rule (now listed and marked) and one technical phrase (now noted).
3. **Classification was required in every plan status,** which pushed doubtful tiers upward. It is now required only for a `complete` plan. An unclassified unit still cannot run or count.
4. **The report reimplemented the classification rule.** It now uses `unitClassified`.
5. **The notice now says** that basis anchors are neither verified nor tracked.
6. **Test gaps:** the incomplete-plan case, the notice scope, marks in `SKILL.md` and `protocol.md`, and mark links that resolve.

**Tests** (6 new, 3 updated):
- **`tests/audit.test.mjs`** (3 new):
  - a `complete` plan close refuses a missing tier, and a missing, empty or blank basis, for deferred and Tier-1 units too;
  - a free-text basis, and an anchor outside the project, are refused;
  - an open plan may stay unclassified;
  - an out-of-scope unit needs neither;
  - a well-formed basis passes whatever the tier, and the report shows it;
  - a plan closed `incomplete` with an unclassified unit is accepted, the unit cannot run, and a re-plan classifies it;
  - a legacy unclassified ledger: the unit cannot run, and the audit close cannot be complete;
  - a re-plan classifies units without counting as a lowering, and a unit raised to Tier 1 must reopen and then needs R4.
- **`tests/notices.test.mjs`** (new, 3 tests):
  - the license block is byte-identical to the verified upstream LICENSE (by SHA-256), and the full commit is named;
  - the listed adapted sections and the in-place marks agree exactly (in `SKILL.md` and the references), each mark links correctly from its own file, and no mark sits inside delegate text;
  - no endorsement claim, the no-license scope statement is present, and nothing says MIT governs the adapted nth-review text.
- **Updated:** `tests/references.test.mjs` (tier rules in `protocol.md` and `records.md`), the `audit.test.mjs` unit helper (a default basis) and the `new-run.test.mjs` fixture.

**Full suite: 265 tests, 260 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged. `OFFICIAL_AUDITS_ENABLED` is still `false`.

**Remaining limitations:**
- **Tier correctness is a judgment that no check can make.** `check` verifies only that a basis exists and has well-formed anchors with notes; it does not verify that the anchored files exist. R3 may challenge a tier its basis does not support.
- **Legacy ledgers stop at their unclassified units** until a re-plan classifies them. A legacy plan closed `complete`, or a unit run over an unclassified ledger, now fails `check` retroactively, and closed runs are never rewritten. No real audit records exist (audits are disabled), so only synthetic data is affected.
- **The notice reflects a comparison at the pinned commit.** Upstream changes are not tracked, and a refresh is a deliberate, reviewed edit. Two limits:
  - the word comparison catches shared wording, not close paraphrase; the four files read in full were also compared by hand;
  - `report-schema.json` and the validators were not compared, and nothing in nth-review was written from them.
- **Not a legal review.** The notice follows the MIT terms as written. Whether more attribution is wanted is the owner's call.
- **Unverified platforms:** macOS, POSIX symlinks, the executable bit and Node 20. Gates G1 and G2 remain Windows-only.

**Next roadmap task: M3-T8** (static content tests: mechanically guard the skill content in `tests/content.test.mjs`).

## M3-T8 static content and consistency tests, and Gate G3 (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Launched from Git Bash and from PowerShell. Test-only change: no helper code, reference or skill text changed.

**The card** (implementation plan M3-T8) asks for these checks; this is how each is covered:
- **Exact frontmatter keys:** `content.test`, plus a new mutation check (below).
- **Size limits:** `content.test` and `references.test`.
- **Relative links resolve:** `content.test` and `references.test` (with heading anchors), plus new reachability from `SKILL.md`.
- **Budget, schema and model lines in every template:** `references.test` per named template, plus a new generic check for any template.
- **Independence:** `content.test`, unchanged. The list of kit files allowed to mention nth-review matches the card's.
- **Platform logic with an injected platform:** the earlier case test depended on the host file system (skipped where it is case-sensitive). A new host-independent test injects `win32`, `darwin` and `linux`.

Gate G3 also requires `reference/*` ids to be consistent with the `schema.mjs` enums. Before this change, `schema.test` and `references.test` checked only one direction: every value appears in the references. The new enum-drift check covers the reverse: no reference names a value the schema lacks.

**Existing coverage, kept without duplicating it:**
- the frontmatter, sizes, links, the helper commands named by the skill, the template contracts, the routing roles against `ROLES`, Opus and Sonnet only with xhigh only prohibited, the guardrails and independence (`content.test`, `references.test`);
- the 17 families and the taxonomy and census invariants (`references.test`);
- C13 "unknown coverage is never Verified" (`check.test`, `close.test`);
- the gate and charter (`audit.test`, `charter.test`, `new-run.test`);
- closed-run immutability (`close.test`, `resume.test`);
- read-only Git (`git.test`);
- `decide` never writing runs (`decisions.test`);
- the notice (`notices.test`);
- delegation effort limited to `high` by the schema (`delegationEffort: ['high']`).

**New tests** (7; the M3-T8 contract checks):

Each is a pure check that the real content passes and that a deliberate mutation of its invariant fails.

| Invariant | Test | Mutation shown to fail |
|---|---|---|
| Explicit invocation only; progressive loading | `content.test`: the frontmatter is exactly the four keys with `disable-model-invocation: true`; every runtime document (`SKILL.md`, the six references, the notice) is reachable from `SKILL.md` by links; no reference table is copied into `SKILL.md` | invocation enabled; a misspelled, extra or missing key; every link to `census.md` removed |
| Reference ids consistent with the schema (G3) | `content.test`: every inline list of values (`` `a` · `b` ``) in `SKILL.md` and the references is a subset of one `schema.mjs` vocabulary | an invented status, an invented role |
| Every delegation template states model, effort and budget in its header, and budget and strict JSON in the delegate text | `content.test`, for any `## … ~~~text` section (now 4) | the R2 budget line removed; the R4 model line removed |
| No application-code changes | `content.test`: outside `fsguard.mjs`, the helper's only write calls are the reviewed ones (close's leftover temporaries, decide's lock, new-run's cleanup of its own directory), each resolving its path inside `.nth-review`; only `git.mjs` spawns a program; no network module or `fetch` | a direct write, a spawned program, a network call |
| Refuter requirements: docs equal the validator | `content.test`: the R5 rule stated in `routing.md` and in `SKILL.md` names the same severities and impacts, and `check` refuses an R6-only verification for exactly those, over all 40 severity × impact pairs. A confirmed defect without a completed refuter, or with an incomplete one, is refused; only a mechanical doc-drift (exact-line trace) may skip the refuter, as `protocol.md` §7 says | each of the 40 pairs compares the stated with the enforced rule |
| Owner decisions and review debt stay separate | `content.test`: a debt item cannot carry a decision, a decision entry cannot carry a debt disposition (the schemas refuse both), and no module that writes runs imports `decisions.mjs` (nothing acts on decisions yet, C3) | both refused records |
| Platform logic | `fsguard.test`: `samePath` is case-insensitive under `win32` and `darwin` and exact under `linux`; Windows device names (`con`, `nul.json`, `COM1.md`, `LPT9.txt`) are refused under all three platforms, and `console.md` is accepted | the case comparison under each platform |
| Provenance | `notices.test` (strengthened): the fenced license block's hash changes when the text is reworded or re-wrapped | a reworded or re-wrapped notice |

While they were written, two mutation checks first failed to detect their mutation:
- **The template check** found the budget inside the delegate text after the header line had been removed. It now checks the header and the delegate text separately.
- **The reachability mutation** removed only some links to `census.md`. The fixed test now removes every link to it.

Both are recorded here as evidence that the mutations really are exercised.

**Full suite: 272 tests, 267 pass, 0 fail, 5 skipped.** The result is identical from Git Bash and from PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged. `OFFICIAL_AUDITS_ENABLED` is still `false`.

**Gate G3** ("M3-T8 static tests …; `reference/*` ids consistent with `schema.mjs` enums; 100% green") **is green on Windows**, from both launch shells. G3 sets no operating system; the static checks are host-independent, apart from the independence scan's `git ls-files`.

**G3 limitations:**
- **Structure and consistency, not judgment.** Whether a lead follows the procedure well is measured in M5 (G5) and M6 (G6).
- **The enum-drift check reads inline lists** written as `` `a` · `b` ``. A value named elsewhere in prose, or in a table cell without the separator, is checked only in the forward direction (every schema value is documented).
- **The effect scan matches `fs.<call>(` and `node:child_process` in source text.** A write through a destructured import or an alias would escape it. Code review remains the guard for that; the scan catches the ordinary forms.
- **The refuter-rule comparison reads the R5 cell of `routing.md` and the R5 line of `SKILL.md`.** A rule restated elsewhere is not compared.
- **The independence scan looks for the string `nth-review` only.**
- **Unverified platforms:** macOS, POSIX symlinks, the executable bit and Node 20. Gates G1 and G2 require macOS and remain Windows-only. G3 needs no particular operating system.

**Follow-up, recorded and not built:** audit-unit tier basis anchors are not checked to exist, and are not tracked for change. A unit's basis can go stale without any freshness signal; R3 may challenge it. A freshness mechanism for basis anchors is deliberately not added here.

**Next roadmap milestone: M4, the optional nth-dev-kit integration, starting with M4-T1** (the lifecycle doc `agents/claude/integrations/review.md`). Gate G4 follows M4-T1…T3.

## M4-T1 lifecycle document `agents/claude/integrations/review.md` (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Documentation only: no helper, skill, reference or test changed, and nothing was installed anywhere.

**What was written.** `agents/claude/integrations/review.md` (241 lines) defines the optional, opt-in nth-review integration and its Enable, Update and Disable lifecycle. `architect` pre-analysis compared it against:
- the plan cards M4-T1 to M4-T3, Gate G4, and decisions R1, R3, R10, D4, D6 and D7;
- the kit's model integration `task-progress.md`;
- `INSTALL.md` (runtime provenance, skills, Git safety), `docs/lifecycle.md` and `agents/claude/README.md`;
- the review module itself.

**The lifecycle:**
- **Opt-in and project-scoped.**
  - Global Install and Global Update keep the files as dormant library data.
  - Project Start and Project Update never enable it.
  - Only an explicit Enable in a project installs it, at `<P>/.claude/skills/nth-review/`.
  - Global Update never refreshes projects, so an explicit per-project Update exists.
  - Invocation stays manual (`disable-model-invocation: true`).
  - No hooks, settings, permissions, agents or background work; official audits stay disabled.
- **Managed files.**
  - Exactly the 25 runtime files: `SKILL.md`, `THIRD-PARTY-NOTICES.md`, 6 references, `scripts/nthr.mjs` and 16 library modules. This was checked against the module's directory listing.
  - `tests/` and `VALIDATION.md` are never installed.
  - The receipt is `<P>/.claude/nth-dev-kit-hooks/review.state.json`. It holds the sha256 of each file's bytes, a `library` digest (over the 25 receipt entries) that identifies the source revision, and the directories Enable created.
  - A file is kit-owned only while it is present at its recorded hash; everything else under `.claude/` is the user's.
  - A lost state file means ownership is uncertain: the folder is refused, never adopted.
- **Enable:**
  1. State `<P>` and `<config>`.
  2. Require Node.js 20 and Git.
  3. Confirm the runtime (M0-T1 and VS1 evidence cited).
  4. Verify the library receipt; never the kit checkout.
  5. Validate.
  6. Preflight, where any conflict writes nothing.
  7. Report a shadowing personal skill.
  8. Write the state file first, as an intent record.
  9. Write the files through temporary names and renames, `SKILL.md` last.
  10. Verify.

  A rerun is a no-op, and it also repairs.
- **Update:**
  - detects customized, missing, new-path-taken and dropped-customized files as conflicts, all or nothing;
  - deletes `SKILL.md` first, writes it last, and writes the state file last;
  - a missing `SKILL.md` with otherwise consistent files is the signature of an interrupted Update, and a rerun finishes it.
- **Disable:**
  - deletes only hash-matched files, `SKILL.md` first, and keeps and reports changed or unrecorded ones;
  - removes only the directories Enable created, and only when empty;
  - never touches `.nth-review/`.
- **Safety:**
  - refuses symlinks, junctions and reparse points on every component;
  - refuses real-path escapes;
  - refuses names that differ only in case or Unicode normalization (never assumed from the operating system);
  - refuses targets already tracked by Git (the check is skipped when `<P>` is in no work tree);
  - refuses a `<P>` that overlaps the config, library or kit;
  - Git is read-only throughout.
- **Untracked effect:** the installed files would be untracked inputs to the project's own reviews. The doc therefore recommends that the owner add the exclude lines `/.nth-review/`, `/.claude/skills/nth-review/` and `/.claude/nth-dev-kit-hooks/` before the first review. The kit never edits exclude files (D6). The doc also says not to run Enable, Update or Disable while a review run is open. This was checked against the code: the snapshot and `fresh` list untracked files with `ls-files --others --exclude-standard`, which honours the local exclude.

**Cross-check.** An independent cross-check confirmed:
- the 25-file set;
- the frontmatter, `${CLAUDE_SKILL_DIR}` and the audit switch;
- the model rule;
- the `version` command;
- the untracked-file mechanics;
- receipt-required project operations with no checkout fallback;
- Global Update never touching projects;
- personal-over-project skill precedence;
- conflict and write rules matching `task-progress.md`.

It found eleven problems, all fixed in the document:
1. **An interrupted Enable could not be recovered** (a skill folder without a state file is a conflict), and `createdDirs` was lost. The state file is now written first, as an intent record.
2. **A partially written `SKILL.md` could load.** Every file is now written to `.<name>.nth-tmp`, verified, then renamed. A leftover temporary file is a conflict.
3. **The project-scoped operation was not related to the kit's lifecycle.** A "Relation to the kit's lifecycle" note and a "project-local application" of the provenance rules are added. The wiring is left to M4-T2.
4. **Version identity was weak, and two hash definitions conflicted.** The state file records each file's actual bytes plus a `library` digest.
5. **The untracked effect was understated.** The exclude is now recommended before the first review, and operations are not run during an open review run.
6. **The Git check was undefined outside a work tree.** It is now defined.
7. **Two Claude Code claims were unverified** (nested discovery; a folder without `SKILL.md` not loading). The first is removed. The second, with skill loading, model invocation and `${CLAUDE_SKILL_DIR}`, becomes an explicit runtime confirmation step like `task-progress`'s.
8. **Case sensitivity was inferred from the operating system.** It now compares real paths and refuses case- or normalization-only differences.
9. **Verification gaps:** the conflict cases are now enumerated, with interrupted Enable and Disable, temporary leftovers, the audit refusal after install, pre-existing `.claude/` content and source byte-identical, `.nth-review/` unchanged in every step, and the M0-T1 check. The test command's glob form is noted as needing Node.js 21 or later; the Node 20 directory form is marked unverified.
10. **Disable removed `nth-dev-kit-hooks/` even when Enable had not created it.** It now uses `createdDirs`.
11. **Update did not say what to do with unrecorded files** (now: leave and report), nor what the repair path is (Enable).

It also suggested adding `reviewer` as a prerequisite (done; `Explore` is built in) and saying the hooks folder holds no hooks (done).

**Checks run.**
- The new document's 25-file list was compared with the module's directory listing: equal.
- All its relative links and anchors resolve.
- The documented audit refusal exits 2 (run on an empty temporary directory, removed afterwards).
- The independence test still passes.
- **Full suite: 272 tests, 267 pass, 0 fail, 5 skipped**, identical from Git Bash and PowerShell. The 5 skipped tests are platform cases, and they are **not** passes. VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged.

**Deviations from the approved cards** (to record with the owner):
- **Project scope.** The cards assumed a config-home install at `<config>/skills/nth-review/`, with state in `<config>/nth-dev-kit-hooks/` and refreshed by Global Update. The user required project scope, so the install moves to `<P>/.claude/` and gains an explicit per-project Update.
- **State-file order.** Enable writes the state file first, unlike `task-progress`, which writes it last, so that an interrupted Enable is recoverable. Update still writes it last.
- **Additions:** the `createdDirs` and `library` fields, and temporary-file writes with renames.

**Open decisions** (none blocks M4-T2):
1. Confirm the project-scope deviation, and record it in the research decisions (it supersedes the card's `<config>` paths, and makes the R3 `INSTALL.md` guard unnecessary).
2. Whether Git-tracked targets stay refused, or a team may commit the skill.
3. Whether Global Update's report should mention that project copies are never refreshed, so a stale copy is visible.
4. Whether the review module itself should ignore `.claude/skills/nth-review/` and `.claude/nth-dev-kit-hooks/`, instead of relying on the owner's exclude. That would be a code change.

**Acceptance tests for M4-T2** (the wiring), changed by the project scope:
- `prompts/claude/global/update.md` gains **no** refresh bullet for nth-review, because Global Update refreshes only integrations whose state is in the configuration.
- `install.md` lists nth-review under "never enable or refresh".
- The rows in `README.md` and `agents/claude/README.md` say opt-in, project-scoped, manual `/nth-review`, and per-project Update.
- `INSTALL.md` changes only if decision 1 keeps a guard.
- `managed/**` and `presets/**` stay untouched, and the independence test stays green.

**Acceptance tests for M4-T3** (the rehearsal): listed in the document's Verification section. In short:
- Enable's exact footprint;
- no-op reruns;
- a single-file Update;
- every conflict writes nothing;
- interruptions finish on rerun;
- Disable restores the tree exactly and preserves `.nth-review/`;
- Git `HEAD`, refs, the index and exclude are unchanged;
- both Windows shells; macOS unverified until run.

**M4-T2 readiness:** ready, provided the M4-T2 wiring follows the project-scoped acceptance above, not the card's original Global Update refresh bullet.

**Next roadmap task: M4-T2** (the kit wiring: install and update prompts, both READMEs, `INSTALL.md` only if a guard is kept). Then M4-T3, the rehearsal, and Gate G4.

## M4-T2 lifecycle wiring (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1. Documentation and static tests only. No helper, skill or reference changed, and nothing was installed anywhere. No Enable, Update or Disable was run; that is M4-T3.

**Owner decisions (M4).** The owner resolved the four open decisions of M4-T1. They are numbered here as M4 decisions 1 to 4, because the research decisions file already uses D1 to D8 for other decisions.
1. **Project scope approved.** Project-scoped installation replaces the global-install design. This amends research D1, the `<config>/skills/nth-review/` packaging.
   - Global Install and Global Update keep nth-review dormant; only an explicit per-project Enable activates it.
   - The R3 `INSTALL.md` guard (research D7) is not needed: the legacy installer never sees a project copy.
2. **Git-tracked copies are not supported in v1.** Uncertain ownership and tracked-file conflicts are refused. Nothing modifies the Git index or working tree to resolve them.
3. **Global Update states that project copies are not refreshed.** Each project needs its own explicit Update.
4. **No helper change for self-review noise during M4.**
   - The local exclude stays optional and manual.
   - The kit never edits `.git/info/exclude` or `.gitignore` (research D6).
   - No blanket exclusion may cover other integrations' or user-owned files.

**Authoritative record.** The owner approved decisions 1 to 4 in the development conversation on 2026-10-26. At the start of M5, the owner directed that their authoritative record stays in nth-dev-kit, in this section. The research decisions file in the private project A worktree, `.nth-review/research/nth-review-decisions.md`, is deliberately **not** edited. Where the two differ, this record supersedes research D1 option (a) (the `<config>` path) and the R3 `INSTALL.md` guard of research D7. The approved record:

> ## 5. Owner decisions during M4 (2026-10-26)
>
> - **D1 resolved: project scope.** nth-review installs per project at `<P>/.claude/skills/nth-review/`, with provenance in `<P>/.claude/nth-dev-kit-hooks/review.state.json`. It is installed and removed only by the explicit Enable, Update and Disable in `agents/claude/integrations/review.md`.
>   - Global Install and Global Update keep it as dormant library data. They never install it under `<config>/skills/`, and never refresh a project copy.
>   - Project Start and Project Update never enable it.
>   - This supersedes option (a)'s `<config>` path, and the R3 `INSTALL.md` guard is not needed.
> - **Git-tracked copies are not supported in v1.** A tracked file under `.claude/skills/nth-review/`, a tracked state file, or a skill folder whose ownership is uncertain is a conflict, and is refused. Nothing changes the index or the working tree to resolve it.
> - **Global Update reports** that existing project installations are not refreshed automatically: each project needs its own explicit Update.
> - **Self-review noise:** the helper is not changed during M4. The local exclude stays optional and manual. It names only `/.nth-review/`, `/.claude/skills/nth-review/` and `/.claude/nth-dev-kit-hooks/review.state.json`, and the kit never writes it (D6).

**Wiring.**
- `prompts/claude/global/install.md`:
  - nth-review is dormant library data only, never copied into `<config>/skills/` or any project;
  - it is enabled per project only, by its explicit Enable;
  - the report lists it as available dormant library data, enabled per project only.
- `prompts/claude/global/update.md`: a new bullet.
  - nth-review is project-scoped, so its copies and state live in projects, which Global Update never inspects or alters.
  - Global Update never refreshes, enables or copies it.
  - It reports that existing project installations are not refreshed automatically: each project needs its own explicit Update.
  - There is deliberately **no** "Global Update refresh" for it, unlike the config-home integrations.
- `README.md`:
  - a tree row, `review{.md,/}` (project-scoped);
  - an nth-review paragraph under Optional integrations: manual `/nth-review`; outside all presets; dormant in the library; never enabled by Project Start or Update; explicit per-project Enable, Update and Disable; each project's own Update; no hooks or background work; official audits disabled;
  - the Global Update row now says it refreshes enabled config-home integrations, never project copies.
- `agents/claude/README.md`: the same paragraph for the adapter, with the installed folder and the state-file path.
- `docs/lifecycle.md`, in generic wording (the independence test forbids naming nth-review there):
  - a second deliberate exception to "Project Start/Update is the only new activation path": an adapter may document a project-scoped optional integration, with its own explicit per-project Enable, Update and Disable;
  - Project Start and Update never run them, and Global Install and Update only store such an integration as dormant library data;
  - Global Update never refreshes it, and reports that each project needs its own Update.
- **Unchanged, by decision:**
  - `prompts/claude/project/start.md` and `update.md`: they already install no integrations, and naming nth-review there would break independence. The new tests check that they do not mention it.
  - `INSTALL.md`: not needed under project scope (decision 1).
  - `.gitattributes`: the owner's own staged `*.mjs text eol=lf` rule already covers the helper. It was not touched.
  - `managed/**` and `presets/**`: untouched.
- `agents/claude/integrations/review.md`, for decisions 2 and 4, and for the cross-checks below:
  - **The exclude** is an optional, manual step naming only the three own paths.
    - It replaces M4-T1's recommended `/.claude/nth-dev-kit-hooks/` directory, which would also have hidden other integrations' state.
    - It states that the helper is not changed to ignore them.
  - **"Tracked copies are not supported in v1"**, and nothing changes the index or working tree to resolve them. The tracked check covers only this integration's paths. A team's tracked `.claude/settings.json` or other skills never block Enable.
  - **Temporary files** are detected anywhere under the skill folder, including `reference/`, `scripts/` and `scripts/lib/`, not only at its top.
  - **Enable over an older install:**
    - the state file written first keeps each to-replace file at its old recorded hash until it is replaced;
    - `SKILL.md` is deleted before any replacement and written last;
    - the state file is written again, last, once the hashes change.
  - **Update** deletes `SKILL.md` whenever any file is written or deleted, not only when `SKILL.md` itself changes.
  - **Disable** says to finish an interrupted Update first.
  - **Four more rehearsal cases:** a tracked `settings.json` that does not block; a temporary file in `scripts/lib/`; Enable over an older install interrupted mid-way; Disable right after an interrupted Update.

**Recovery cross-check against user-owned modifications.** No case was found where a user's own content is overwritten or deleted. Five gaps were fixed, and the rest are documented limits for the M4-T3 rehearsal.

*Fixed in `review.md`:*
1. **Enable over an older install could not finish after an interruption.** Its first state write recorded the new hashes before files were replaced. An unreplaced file then matched neither its record nor the library, so a rerun reported a conflict. It now keeps the old hash until the file is replaced.
2. **A mixed version could load during Enable or Update.** `SKILL.md` was deleted only when it was itself replaced, so an unchanged `SKILL.md` stayed loadable while other files changed. It is now deleted before any write and written last. The preflight has already proved that its content is the kit's.
3. **The Git check could refuse ordinary projects.** It covered any "target directory", so a team repository that tracks `.claude/settings.json` would have been refused. It now covers only this integration's paths.
4. **A temporary file in a subfolder was not named as a leftover.** It now is, anywhere under the skill folder.
5. **Disable right after an interrupted Update** keeps the files that Update already refreshed, and reports them as conflicts. Disable proves ownership by recorded hash only, and Update writes the state file last.
   - Documented in both Disable and Interruption: finish with Update (or Enable) first. Enable re-adopts such files, which are canonically equal to the library.
   - Disable was not changed to consult the library, which would make it depend on a valid receipt.

*Documented limits:*

6. **An interrupted Update, then a user edit** to one of its files: Update and Enable both stop on that conflict. `SKILL.md` stays absent, so the skill is unavailable until the user restores or removes the file. Nothing is overwritten.
7. **A line-ending-only change** is canonically equal (INSTALL.md → Ownership comparison: CRLF and lone CR to LF only). It is kept and recorded at its actual bytes, so Disable later deletes it. Its content is the kit's.
8. **Files created by the user at recorded but unwritten paths** (an Enable interrupted after its state file):
   - a file with the library's exact bytes is deleted by Disable; with other bytes it is a conflict, and stays;
   - likewise, a directory the user creates at a recorded `createdDirs` path is removed by Disable only while it is empty.
9. **A leftover `.<name>.nth-tmp`** is a conflict that the user removes by hand.
10. **A `SKILL.md` the user deleted** is rewritten by Update as if Update had been interrupted. It is the kit's own bytes.
11. **An edited state file** (valid JSON with a changed hash) is trusted. Only invalid state is detected.

**Independent cross-check.** A `reviewer` read the wiring diff, `review.md` and the new tests against decisions 1 to 4, `docs/lifecycle.md`, `docs/ownership.md`, `INSTALL.md` and the other integrations. It found **no blocker**. It confirmed:
- no path by which Global Install/Update or Project Start/Update could enable, copy, refresh or inspect a project copy;
- the wiring sits where the other integrations' does, and states its deliberate differences;
- ambiguities 5 to 9 and fix 2's Enable half.

Its findings were handled as follows:
- **Fixed:**
  - **should-fix:** the Git-check scope (fix 3) and the interrupted Enable over an older install (fix 1);
  - **should-fix or note:** `SKILL.md` kept loadable during Update (fix 2);
  - **notes:**
    - temporary files in subfolders (fix 4);
    - the Disable-section pointer (fix 5);
    - `lifecycle.md` still calling Project Start/Update the only new activation path (now "a second deliberate exception");
    - the test's decision label;
    - in the tests: the "recommended" check is scoped to the exclude bullet, order is checked by position, the count pattern is narrowed, and UTF-8 is validated strictly.
- **Recorded as limits:** 8 (the `createdDirs` part) and 10.
- **Accepted:**
  - Global Update's "not refreshed" line is unconditional, which meets decision 3;
  - the wiring test pins the decision prose and inspects bullets only;
  - the Codex prompts and `docs/ownership.md` stay covered by the string-level independence test;
  - `review.md` keeps the internal ids (M0-T1, VS1, M4-T3) that M4-T1 introduced.

**Tests added.** `tests/integration.test.mjs`, 7 static tests. Each is a pure function over text: the real documents pass it, and a deliberate mutation of its invariant makes it fail.
- **Runtime files:**
  - `review.md`'s table lists exactly the module's files except `tests/` and `VALIDATION.md` (25);
  - every stated count equals that;
  - every file matches the documented state-key rule.

  Mutations: a dropped name, an extra module file, a missing module file, a wrong count, an uppercase name, a dropped key rule.
- **Runtime bytes:** every installed file is valid UTF-8, LF-only and without a BOM, so a written file's hash equals its receipt digest.
  - It reads the working tree. A checkout with `core.autocrlf` relies on the owner's staged `.gitattributes` rule for `*.mjs`.
- **Links:** every link and anchor in `review.md`, and the two READMEs' links to it, resolve. Mutations: a broken in-file anchor and a broken `INSTALL.md` anchor.
- **Claims:** `review.md`'s explicit invocation, disabled audits, Node.js 20 and helper commands with their options match `SKILL.md`, `nthr.mjs` and the CLI. Mutations: invocation enabled, audits enabled, an unknown `new-run` option.
- **Recovery order**, checked by position, not only by presence:
  - Enable: state file first, `SKILL.md` last, the final state write last; an unreplaced file keeps its recorded hash; `SKILL.md` is deleted before any replacement;
  - Update: `SKILL.md` deleted first, the other files, `SKILL.md` last, then the state file; all or nothing;
  - Disable: `SKILL.md` deleted first;
  - temporary names never load.

  Mutations: five, including a moved step and two swapped lines.
- **Git:**
  - the exclude is optional and manual, and names exactly the three own paths;
  - Enable reports it as optional;
  - tracked copies are refused without touching the index;
  - tracked user files elsewhere in `.claude/` never block Enable.

  Mutations: six.
- **Wiring:**
  - Global Install keeps it dormant and never copies it;
  - Global Update never refreshes it, has no refresh bullet for it, never reads project state, and reports per-project Updates;
  - both READMEs link it, and say: manual, project-scoped, never global, never enabled by Project Start/Update, explicit Enable/Update/Disable, each project's own Update;
  - `lifecycle.md` states the generic rule;
  - `lifecycle.md` and both project prompts never name the integration.

  Mutations: five.

**Checks run.**
- **Full suite: 279 tests, 274 pass, 0 fail, 5 skipped** (272 before, plus 7). The result is identical from Git Bash and PowerShell, and it was rerun after the review fixes. The 5 skipped tests are platform cases, and they are **not** passes.
- VS1 still passes `verify.mjs` (9/9, exit 0), and its fixture is byte-identical.
- Private project A is unchanged: all four repositories are at their HEADs, with the same status.
- The kit's Git index is unchanged (same mtime). `managed/`, `presets/`, `INSTALL.md` and the project prompts are untouched.
- No temporary test directory remains besides the VS1 fixture.
- Gates G1 and G2 stay verified on Windows only. macOS, POSIX symbolic links and Node.js 20 were not run.

**Remaining lifecycle risks.**
- Enable, Update and Disable are instructions for Claude, not code, and nothing has executed them yet. M4-T3 is the first run, so the fixes above are reasoned, not yet rehearsed.
- One runtime point of Enable step 3 is still unverified: that a folder without `SKILL.md` is not offered as a skill. The other points are confirmed: a project skill loads and runs as `/nth-review`, and `${CLAUDE_SKILL_DIR}` expands (M0-T1 for a config-home skill, VS1 for a project skill). Update's safety while it runs depends on the unverified point.
- A personal `<config>/skills/nth-review/` would shadow every project copy. Enable and Update only report it.
- Without the optional exclude, lifecycle operations between review runs show up as untracked changes in the project's own reviews. Decision 4 accepts this.
- A stale project copy after a Global Update is visible only through the Global Update report and that project's own Update.
- macOS and Node.js 20 remain unverified.

**M4-T3 readiness:** ready. The rehearsal cases are in `review.md` → Verification, including the four added here. Fixes 1 to 5 and limits 6 to 11 should be exercised or confirmed there, along with the "no `SKILL.md`, no skill" runtime point.

**Next roadmap task: M4-T3:**
- the rehearsal, in a throwaway project with a throwaway `CLAUDE_CONFIG_DIR` holding a receipted library, from both Windows shells;
- then Gate G4.

## M4-T3 lifecycle rehearsal (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1, Claude Code 2.1.310.
- Everything ran in disposable directories under the system temporary directory: synthetic projects, and receipted libraries each in its own throwaway `CLAUDE_CONFIG_DIR`.
- Nothing was installed into private project A or any real project. The real Claude configuration was not used.
- No model was called, and `/nth-review` was never typed. Official audits stay disabled.

### Ownership clarified first (owner instruction)

Project ownership is now **byte-exact**: a file is kit-owned only while the sha256 of its exact bytes equals its recorded hash. Anything else is modified and preserved, including a line-ending-only change, an added or removed final newline, and a file without a record. Every "canonically equal" rule in `review.md` was removed. The receipt's LF-canonical digests still check the library's own integrity, never project ownership.

Byte-exact ownership alone would break recovery: a file an interrupted operation had already refreshed would no longer match its record. So the contract gained an **intent record**:
- Enable and Update first write the state file with a `pending` hash for every file they will write, and remove `pending` in their last write.
- At every point in between, each file is at its `files` hash, at its `pending` hash, or absent, so all of it stays provable without normalizing anything.
- Update now also writes its intent record first. Previously it wrote the state last.
- Disable deletes files that match either hash, so **Disable right after an interrupted Update now restores the tree exactly**. That removes M4-T2 limit 5.

### Method

- **Operator transcription:** `tests/m4/operator.mjs` transcribes Enable, Update, Disable and Validation step by step from `review.md`. Every mutating action (mkdir, temporary write, rename, delete, rmdir) is counted, so a run can be stopped before any chosen action to simulate a crash there.
- **Rehearsal:** `tests/m4/rehearse.mjs` runs every scenario. It builds:
  - three receipted libraries: v1 (two changed files, `census.md` not yet shipped, an extra `legacy.md` that v2 drops), v2 (the current module) and v3 (one more change);
  - three synthetic projects: a Git repository with a tracked team `.claude/settings.json`, user agents and skills, `CLAUDE.md` and planted `.nth-review/` data; a bare repository with no `.claude/`; and a non-Git parent folder holding two repositories.

  Each step is judged by full-tree snapshots, `.git` included: every file's sha256, every directory, and each Git index's mtime. Reruns: `node agents/claude/integrations/review/tests/m4/rehearse.mjs`, about 3 minutes.
- **Manual operator pass:** I followed Enable steps 1 to 11, then Disable, by hand with ordinary shell commands in a fresh copy of the rich project, and compared the result with the transcription's.

### Rehearsal matrix

Final run, after the fidelity check below, from both Git Bash and PowerShell: **75 rows, 72 pass, 0 fail, 3 unverified.**

"0 writes" is the operator's own count of mutating actions, and "tree unchanged" is a full snapshot diff.

| # | Scenario | Observed result | Status |
|---|---|---|---|
| 1 | Clean Enable: rich, bare and parent-folder projects | 59, 61 and 61 writes. Only integration paths were added (31 or 33). The install matched the library byte for byte, with no `pending` left. `version` exited 0. | pass |
| 1 | Repeated Enable | `unchanged`, 0 writes, tree identical (all three projects) | pass |
| 1 | Audit gate after install | `new-run --mode audit-plan` exited 2 and wrote nothing | pass |
| 2 | Update v1 → v2 (2 changed, 1 new, 1 dropped file) | 14 writes. Order: intent record, `rm SKILL.md`, files, `SKILL.md`, final state. Exactly 5 paths changed (`routing.md`, `render.mjs`, `+census.md`, `-legacy.md`, the state file). The install was exact. | pass |
| 3 | Repeated Update; Enable after Update | `unchanged`, 0 writes, both | pass |
| 4, 15 | Clean Disable (rich, bare, parent; and after an Update) | Trees identical to before Enable. The rich project's `.claude/` user content was kept; the bare project's `.claude/` was removed again. | pass |
| 4 | Repeated Disable | `not-enabled`, 0 writes | pass |
| 5 | Enable stopped before each write action: fresh rich (59), fresh bare (61), and over a v1 install (14) | **Invariants held at every point:** every file was provable, and `SKILL.md` never sat beside a mixed folder.<br>**Rerun** reached the exact install in 59/59, 61/61 and 14/14. 27, 27 and 6 of those first needed a named temporary file removed.<br>**Disable** directly, or after the rerun: exact in 57/59, 58/61 and 14/14. The others left only empty, unrecorded `.claude/nth-dev-kit-hooks/` (and `.claude/` in bare). | pass (documented limit) |
| 6 | Update v1 → v2 stopped before each of 14 write actions | Invariants 14/14; rerun exact 14/14 | pass |
| 6 | That Update interrupted at each point, then the library moved to v3, then Update | 13/13 finished exactly at v3 | pass |
| 6 | Two interrupted Updates in a row (v2, then v3 stopped before each action), then Update | 11/11 finished exactly at v3. This exercises defect 1 below. | pass |
| 7 | Disable right after an interrupted Update | Exact restoration 14/14 | pass |
| 4, 5 | Disable stopped before each write action, then rerun: rich (31), bare (33) | Exact 30/31 and 31/33. The others stopped after the state file was deleted and left only empty `.claude/nth-dev-kit-hooks/` or `.claude/`. The rerun Disable reported them. | pass (documented limit) |
| 8 | Modified files at Enable and Update: changed bytes (`render.mjs`), **line endings only** (`routing.md`, LF → CRLF), final newline removed (`SKILL.md`) | Conflict, 0 writes, tree unchanged, in all three cases | pass |
| 8 | Disable with each modified file | It deleted everything else and kept the file byte-identical, with a state file recording only it. A rerun made 0 writes. Once the user removed the file, Disable restored the tree exactly. | pass |
| 8 | Deleted `protocol.md`; deleted `SKILL.md` | Update: conflict, 0 writes. Enable repaired exactly that file (intent record, the file, final state). | pass |
| 8 | New library file whose path is taken; customized dropped file | Conflict, 0 writes, each | pass |
| 8 | Unrecorded user file in the skill folder | Enable: conflict, 0 writes. Update proceeded and reported the file. Disable removed the rest and left only that file and its folders. | pass |
| 9 | A tracked skill file (in the index, absent from the work tree); a tracked state-file path | Conflict (tracked), 0 writes, `.git` unchanged, each | pass |
| 9 | Tracked `.claude/settings.json` | Did not block Enable. `.git` (HEAD, refs, objects, index bytes and mtime, `info/exclude`) was byte-identical in all 36 earlier comparisons. | pass |
| 9 | Git cannot read the repository (a corrupt `.git/config`) | Conflict: "the tracked check could not run", 0 writes. Before the fix, it would have been treated as "no work tree" and the check skipped (defect 7). | pass |
| 10 | An unowned `nth-review` folder with no state file | Enable: conflict (lost state). Update: not enabled. Disable: reported it user-owned. 0 writes each. | pass |
| 10 | Case collisions: `.claude/skills/NTH-Review/`, `.claude/Skills/`, and an installed `reference/` renamed `Reference/` | Conflict, 0 writes, each (Enable; Update and Disable for the rename) | pass |
| 10 | Unicode-normalization collisions | Not applicable: every target name is ASCII | unverified |
| 11 | Junctions at `.claude`, `.claude/skills/nth-review`, `.claude/nth-dev-kit-hooks`, and an installed `scripts/lib` | Every operation refused it (conflict, or "not enabled"), with 0 writes. The junction target was untouched. | pass |
| 11 | Directory and file symbolic links | Cannot be created on this machine (`EPERM`: no Developer Mode) | unverified |
| 12 | A leftover `.nth-tmp` in the skill folder, in `scripts/lib/`, and in the state folder | Enable, Update and Disable: conflict, 0 writes. After the user removed the file, Update proceeded. | pass |
| 12 | Receipt defects: missing receipt; invalid JSON; another agent; a missing library file, in the module or elsewhere in the library; a digest mismatch; a runtime file missing from both the receipt and the library; a runtime file with no receipt entry; a duplicate receipt key | Enable and Update stopped with Global Install guidance, 0 writes, and no fallback to the kit checkout | pass |
| 12 | An unlisted, receipted extra file in the library module | Enable installed exactly the listed 25 files; the extra file was not installed | pass |
| 12 | State-file defects: invalid JSON, unknown schema, a key outside the runtime paths, a duplicate key, a bad hash, a bad `createdDirs`, a wrong skill path, a bad `pending` key | Enable, Update and Disable: conflict, 0 writes, each | pass |
| 12 | Refused project locations: the config directory, inside the library, the home directory | Conflict, 0 writes | pass |
| 13 | A personal `<config>/skills/nth-review/` | Enable and Update reported the shadowing and proceeded. Disable completed. The personal copy stayed byte-identical. | pass |
| 14 | Unrelated files and review data | Application source, `CLAUDE.md`, `.claude/settings.json`, other skills and agents, `.nth-review/` and `.git` were unchanged in every row | pass |
| 15 | Exact restoration | See rows 4, 5, 7 and 8. The only exceptions are the empty unrecorded directories described under Remaining limits. | pass |

**Manual operator pass:**
- **Enable by hand.** Steps 1 to 11, with `sha256sum`, temporary names and `mv`, reached the same 25 files as the transcription and a state file with the same `files` map.
- **The transcription's Enable over that install was not a no-op.** It rewrote the state file, which exposed defects 3 and 4.
- **Disable by hand** (`SKILL.md` first, hash-checked deletes, the empty directories, the state file, `createdDirs`) left the project identical to the untouched baseline by `diff -r`, `.git` included, with the same index mtime.

### Real defects found, and the fixes

All fixes are in `agents/claude/integrations/review.md`, and the transcription follows them.
1. **A file could become unprovable after two interruptions.** This was found while transcribing.
   - Cause: the intent record replaced `pending` with a newer target while `files` still held an older hash. A file left at the earlier `pending` hash would then match neither record if the next Update was also interrupted.
   - Fix: the intent record moves each present file's just-verified hash into `files`.
   - Evidence: 13/13 and 11/11 above.
2. **Enable over an older install left a dropped file installed.** Found by the first rehearsal run.
   - Cause: Enable kept a file the new library no longer ships (`reference/legacy.md`) beside the new `SKILL.md`. That is a mixed folder: 2 of 13 stop points failed, and the final tree was not v2.
   - Fix: like Update, Enable deletes kit-owned dropped files, and deletes `SKILL.md` first when anything is deleted.
   - Evidence: 14/14.
3. **The `library` digest depended on the operator's sort.** Found by the manual pass.
   - Cause: "sorted by path" is ambiguous. The locale's `sort` gave `2c9d6d04…`; byte order gave `dc45a3ac…`.
   - Fix: byte order (`LC_ALL=C sort`), joined with LF, with no final newline.
4. **"Nothing changed" was judged by formatting.** Found by the manual pass. A state file with the same content but different JSON layout was rewritten.
   - Fix: the state is compared by its parsed content.
   - Evidence: the transcription made 0 writes over a single-line state with reordered keys.
5. **`git status` writes the index.** It was listed as read-only.
   - Observation: in a fixture, `rev-parse` and `ls-files` left `.git/index` unchanged, but `git status` rewrote it after a file's timestamp changed. `GIT_OPTIONAL_LOCKS=0 git status` did not.
   - Fix: the only Git commands are `rev-parse` and `ls-files`, and the doc says never to run `git status` here.
6. **Deleting `SKILL.md` does not stop a running session.** See Skill discovery.
   - Fix: Update and Disable now require every other Claude Code session in the project to be closed first, and a new session afterwards. The Enable report says a running session sees the skill only after a delay.
7. **A Git failure skipped the tracked check.** Found by the fidelity check.
   - Cause: Validation 3 treated any failure of `git rev-parse --show-toplevel` as "no work tree". A repository Git refuses to read (for example for dubious ownership, or a corrupt config) would pass the check silently.
   - Fix: only Git's "not a git repository" answer means no work tree; any other failure of `rev-parse` or `ls-files` is a conflict.
   - Evidence: the corrupt `.git/config` row.
8. **The runtime file set and the receipt check were underspecified.** Found by the fidelity check.
   - Cause: Enable step 4 did not say where the runtime list comes from in a newer library, or how much of the receipt to verify. The transcription took the set from the folder. With that reading, a runtime file missing from both the receipt and the library went unnoticed until `version` failed after a partial install.
   - Fix: the list comes from the library's own copy of `review.md`, and every listed file needs a receipt entry. The whole receipt is verified as `lifecycle.md` requires: safe paths, presence, digests, no duplicate key. Unlisted module files are never installed.
   - Evidence: the receipt rows.

Defects in the rehearsal harness itself were also fixed: a vacuous summary row, a temporary file that blocked one chained case, and a "not enabled" outcome counted as a failure. They are not lifecycle defects.

### Fidelity check of the transcription

The matrix is evidence for `review.md` only if `operator.mjs` follows it faithfully. An independent `reviewer` compared the two, read-only.

It found one divergence that changed what the matrix exercised. The operator deleted `SKILL.md` before creating the `reference/` and `scripts/` directories, so its stop points were not the documented order (directories first).
- **Fix:** the operator now creates every directory first.
- **Result:** the matrix was rerun, and the invariants and recoveries hold on the documented order. The counts are unchanged: 59, 61 and 14 write actions.

It also found:
- **Defects 7 and 8** above.
- **Cases where `review.md` was silent and the operator stricter.** `review.md` now states each rule:
  - the state file's required fields;
  - what Disable keeps after a conflict;
  - Update requiring Node.js and Git;
  - Update creating missing skill directories.
- **Missing reports.** The operator now reports what Enable step 11 and Disable step 5 require.
- **Accepted:**
  - the "no open review run" and "other sessions closed" preconditions are the user's to keep, not checked by the operator;
  - the operator verifies files against the library digests before the final state write. That is equivalent to checking them against their records, because the final records are those digests.

### Enable, Update and Disable recovery behavior

- **Enable** writes its intent record before any skill file; on an older install it also deletes `SKILL.md` first. It writes `SKILL.md` last and its final state last.
  - **If it stops before its intent record:** at most empty `.claude/nth-dev-kit-hooks/` (and `.claude/`) exist, unrecorded. A rerun finishes the install but cannot claim them, so a later Disable leaves them.
  - **If it stops after the intent record:** a rerun finishes it, and Disable undoes it exactly.
- **Update** follows the same order: intent record, `rm SKILL.md`, files, `SKILL.md`, final state.
  - A rerun finishes it, even after the library has moved on, and even after two interruptions in a row.
  - Disable undoes it exactly.
  - While it is unfinished, a new session does not see the skill.
- **Disable** deletes `SKILL.md` first and keeps every modified file, with a state file recording only that file.
  - A rerun after any interruption converges.
  - If it stops between deleting the state file and the last directory removal, an empty `.claude/nth-dev-kit-hooks/` or `.claude/` remains, which a rerun reports.
- **A stop between a temporary write and its rename** leaves a `.nth-tmp` file. Every operation then refuses with a conflict until the user removes it. This happened at 27 of 59 Enable stop points and 6 of 14 Update stop points: safe, but manual.

### Claude Code skill discovery (2.1.310, Windows)

**Method.**
- Headless `claude -p --output-format stream-json --verbose --no-session-persistence`, started in the synthetic project with an **unauthenticated throwaway `CLAUDE_CONFIG_DIR`**. Each turn's `init` event reports the CLI's skill inventory, then the CLI stops with "Not logged in", so no model is called.
- Messages were plain `hello`. `/nth-review` was never typed. Slash expansion was tested only with a throwaway `nth-probe` skill. The real configuration was never used.

| Case | Observed |
|---|---|
| Installed project copy, fresh session | `nth-review` listed once in `skills` and in `slash_commands` |
| Skill folder without `SKILL.md` (an unfinished Update), fresh session | Not listed |
| Only the dormant library in `<config>/nth-dev-kit/` (no Enable) | Not listed: Global Install's dormancy holds |
| A personal `<config>/skills/nth-review/` plus the project copy | Listed once. Which copy wins was not observable without a model call: **unverified**. |
| Running session; `SKILL.md` deleted or renamed away, next turn 3 s later | **Still listed** |
| Running session; next turn 5 to 8 s later | No longer listed |
| Running session (probe skill); `SKILL.md` deleted, `/nth-probe` typed 0.5 s later | Still listed, and **still expanded as a skill** from the session's cache, although the file no longer existed |
| Running session (probe skill); `SKILL.md` created mid-session | Listed and expanded at the next turn (5 s later) |
| Running session (probe skill); `SKILL.md` edited mid-session | Still listed. Whether the new body is used was not observable without a model call: **unverified**. |

**Conclusions.**
- A fresh session discovers the installed project skill, and does not offer a folder without `SKILL.md`. This confirms the last point of Enable step 3.
- **Deleting `SKILL.md` does not unload a skill already cached in a running session.** For at least 3 seconds the session can still start it with its cached instructions. Hence the new requirement: close other sessions in the project before Update or Disable, and start a new session afterwards. A turn that had already loaded the skill keeps its instructions in any case.
- Interactive (TUI) sessions were not observed.

### Tests

- `tests/integration.test.mjs` now has 9 tests.
  - The order test is rewritten for the intent record.
  - New, each with mutations that must fail:
    - **ownership:** byte-exact; a normalized comparison fails; the byte-order digest; no-op judged by content;
    - **sessions:** deleting `SKILL.md` is not trusted; Update and Disable close other sessions.
  - The Git test also rejects `git status`, and a Git failure that skips the tracked check.
- The rehearsal (`tests/m4/rehearse.mjs` with `operator.mjs`) is a rerunnable tool, not part of `node --test`. It takes about 3 minutes.
- **Full suite: 281 tests, 276 pass, 0 fail, 5 skipped**, identical from Git Bash and PowerShell. The 5 skipped tests are platform cases, and they are **not** passes.
- VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical.
- Private project A is unchanged. The kit's Git index is unchanged (same mtime). No rehearsal directory remains.

### Remaining limits and risks

- **Empty unrecorded directories.** A crash before Enable's first state write, or after Disable deleted the state file, can leave empty `.claude/nth-dev-kit-hooks/` and `.claude/`. They hold nothing, nothing proves the kit created them, and Disable reports them for the user to remove. This happened at 2 to 3 of about 60 Enable stop points, and 1 to 2 of about 32 Disable stop points.
- **Temporary files need manual removal** after a crash between a write and its rename. Their content is not trusted, even when complete.
- **The real operator is Claude following `review.md`.** The transcription and one manual pass followed it faithfully, but every future run is still an instruction-following task: the doc and `operator.mjs` must change together.
- **Running sessions keep a cached skill.** The fix is procedural (close other sessions), not enforced.
- **Unverified:**
  - symbolic links (no privilege here);
  - Unicode-normalization collisions (not applicable to ASCII names);
  - which of a personal and a project copy wins;
  - whether an edited `SKILL.md`'s new body is used in a running session;
  - interactive sessions;
  - macOS;
  - Node.js 20.
- **An edited state file** that is still valid is trusted (unchanged from M4-T2).

### Gate G4 (integration) readiness

G4 requires the M4-T3 rehearsal with recorded tree diffs, a refresh no-op, a refresh after a changed file, the conflict cases, and an exact restoration by Disable. Its pass criteria: only owned paths change, and conflicts write nothing.
- Under project scope, "refresh" is the per-project Update.
- Every item passed on Windows, from both launch shells, with tree diffs recorded per step.
- The card's "symlink in the path" is covered on Windows by junctions. A true symbolic link is unverified.

**G4: green on Windows; macOS not run.** As with G1 to G3, that needs a macOS run of `tests/m4/rehearse.mjs`.

**Next milestone:** M5, the validation runs. Before them:
- the owner records decisions D1 to D4 from M4-T2 in the research decisions file. Superseded at the start of M5: the authoritative record stays in this file, in M4-T2 → Authoritative record;
- optionally, a macOS run of the rehearsal.

## M5-T1 fixture builders and sealed answers (2026-10-26)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1, Claude Code 2.1.310.

This section names items by id and category only, never by mechanism: this file ships with the library, and reviewers must not learn the answers from it.

### What M5-T1 delivers

- **`tests/fixtures/build.mjs`:** `node agents/claude/integrations/review/tests/fixtures/build.mjs <name> <outDir> [--from <dir>]`. The names are `syn-ledger`, `syn-ledger-inc`, `syn-ledger-inc-rewritten`, `syn-ledger-inc-dirty` and `syn-debt`.
- **`tests/fixtures/syn-ledger/tree/{base,change,inc,debt}/{root,api,admin}/`:** 48 neutral template files.
- **`tests/fixtures/{syn-ledger,syn-ledger-inc,syn-debt}/answers.json`:** the sealed answers, `nthr-fixture-answers@1`.
- **`tests/fixtures/README.md`:** build and run instructions, the answers contract, and the evaluation criteria for M5-T2 and M5-T3.
- **`tests/fixtures.test.mjs`:** 9 tests.
- **`tests/helpers/library.mjs`:**
  - holds the receipt writer, extracted from `tests/m4/rehearse.mjs`, which now imports it;
  - adds a runtime-only throwaway library.
- **`tests/helpers/tmp.mjs`:** `rawGit` gains an optional `env`.
- **`review.md`:** names the builder as the operator transcription's second user.

An `architect` analysis preceded the work. Its local handoff file was deleted once M5-T1 was verified.

### Deviations from the approved card, with reasons

- **Install:**
  - Research D4 had fixtures load the skill as a copied project-level skill. The owner's M5 instruction requires review.md's project-scoped installation instead.
  - Every fixture is therefore installed with **Enable**, through the M4 transcription, from a throwaway library that holds only `review.md` and the runtime files. That library has no `tests/`, so nothing about fixtures is ever copied beside a project.
- **Coverage additions:** the owner's coverage list (business rules, concurrency, refutation, honest incompleteness) is covered by four reported, **non-gating** items X1–X4 in `syn-debt`.
  - The gated set stays exactly P1–P6 and N1–N2 in `syn-ledger`, plus the INC target T1.
  - No G5 threshold changes.
- **`outDir`:** it must lie under the system temporary directory. This is the simplest guarantee of "not a real project".
- **Builder path:** roadmap §3's `tests/fixtures.mjs` is superseded by the card's `tests/fixtures/build.mjs`.

### Fixtures

| Fixture | Repositories and commits | Items |
|---|---|---|
| `syn-ledger` | root `.` (docs; base and change), `api` (base and change), `admin` (base) | P1 authorization, P2 db integrity, P3 indirect path (census), P4 migration (census), P5 documentation, P6 multi-repo; N1 negative control, N2 refutation trap. **All gating.** |
| `syn-ledger-inc` | plus one commit in `.` and `api`; variants committed, rewritten base, dirty | T1, indirect invalidation: **gating** |
| `syn-debt` | `syn-ledger` plus a follow-up commit in `.` and `api` | X1 business rule, X2 concurrency, X3 refutation, X4 fact outside the source: **reported, not gating** |

**Neutrality:**
- No answer, item id, mechanism text or label word is in any file, name or commit message.
- The identity is neutral, and there is no user configuration.
- The test denylist covers the label words, the item ids and the mechanism sentences.

**Sizes, decided by `new-run`:**
- `syn-ledger`'s change is **M**: 11 files, 435 lines. It requires an Opus-high lead, with 70 lead calls and 5 subagent calls.
- `syn-debt`'s follow-up is **S**: 6 files, 87 lines, with 40 lead calls and 3 subagent calls. Its three R5-routed candidates exceed the 2 refuter calls left after R3, so its R1 cannot verify everything.

**Determinism:**
- Git runs without system or user configuration, with fixed dates and a neutral identity, and adds files explicitly.
- Two builds give the same 58-file manifest and the same heads.
- `syn-ledger` heads: `.` `7dba24f6`, `api` `038e0b11`, `admin` `ce975439`. `answers.json` pins every head per fixture and variant.

**INC behavior, observed with `new-run` and `fresh`** against a synthetic closed R1:

| Variant | History | Changed files | Target obligation (T1) | An independent obligation |
|---|---|---|---|---|
| committed | `.` ancestor, `api` ancestor, `admin` equal | 5 (4 modified, 1 added) | `touched`, citing the changed dependency | `current` |
| rewritten | `api` **base-missing** | 24 (every `api` file counts as added) | `touched` (base-missing) | `touched` (base-missing) |
| dirty | all equal | 5 (4 modified, 1 untracked) | `touched`, citing the changed dependency | `current` |

`fresh` correctly reopens any obligation whose intent document changed: an exploratory record that gave the independent obligation the changed intent showed this.

**Answers integrity, sha256:**

| File | Before the smoke run | After the fixture fix below |
|---|---|---|
| `syn-ledger/answers.json` | `169ad1b0…` | `e0d29759…` |
| `syn-ledger-inc/answers.json` | `4f6ae3b8…` | `4b4af0db…` |
| `syn-debt/answers.json` | `aeb1ac8b…` | `469e8a92…` |

M5-T4 must record the final hashes again before its first run.

### Verifying the effort override (no model call, no real configuration)

The real configuration defaults Opus 5.5 to `xhigh`, so a plain headless `--model opus` would break routing. A throwaway, unauthenticated `CLAUDE_CONFIG_DIR` was given the same setting:
- without a flag, the session transcript recorded `"perTurnEffort":"xhigh"`;
- with `--effort high`, it recorded `"perTurnEffort":"high"`.

The flag overrides the configured level, and the effect is observable only in the persisted transcript, not in the stream.

### Smoke run: one genuine `/nth-review` (not scored; not counted toward G5)

**Setup:**
- The fixture `%TEMP%\ledger-1` is `syn-ledger`, built **before** the fixture fix below, with root head `7a5e0407`.
- It ran in a **new headless session** with the real configuration, never the development conversation.
- Command:

      claude -p "/nth-review task --ns experiments/ledger --slug ledger --change .:HEAD~1..HEAD --change api:HEAD~1..HEAD" --model opus --effort high --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools "Bash(node:*)" "Bash(git -C:*)" … --disallowedTools WebFetch WebSearch "Read(//<work>/**)" …

- Session `<withheld>`. Its transcript persists in the real configuration's `projects/` folder, as for any session: it is M5-T2's input.

**Path proven:**
- **Discovery:**
  - the project-installed skill was discovered (`init` listed it);
  - `/nth-review` expanded and ran;
  - the helper opened the run, size M and `opus-high`, with triggers `task-size`, `money` and `authorization`.
- **Effort:** the lead ran on `claude-opus-5-5`, and the transcript records `"perTurnEffort":"high"` on all 87 lead turns. The lead itself recorded `lead_effort: unknown`, which the skill allows; it did not ask.
- **Delegations (4):** all completed, with no recovery message.
  - R3 `Explore`, `sonnet`;
  - R5 `reviewer`, `opus` at `high` (×2);
  - R6 `reviewer`, `sonnet`.
- **Close:** `incomplete`, reason `open-obligations`. `check` exits 0. `report.md` and the packs were written.
- **Records:**
  - 15 obligations: 5 held, 4 violated, 3 open `needs-runtime`, 3 open `needs-owner-intent`;
  - 6 findings, all confirmed: two high (R5), two medium (R6), and two low, or with no severity and no verification (a doc-drift and a risk);
  - 18 census items, all classified;
  - 7 debt-out items: 3 runtime, 3 owner-decision, 1 deferred-scope.
- **Cost and size:**
  - 643.8 s (10.3 min recorded), 59 turns, **4.06 USD**: Opus 3.71, Sonnet 0.35.
  - Opus: 72,203 output tokens (17,755 thinking), 2.92 M cache-read, 226 k cache-creation.
  - Sonnet: 13,447 output tokens, 372 k cache-read, 71 k cache-creation.
  - Budget spent: 57/70 lead calls, 4/5 subagent calls.
  - 116 tool calls. Lead: 25 Read, 13 Bash, 10 Edit, 4 Agent, 3 Grep, 2 Write, 1 Glob. Subagents: 40 Read, 9 Bash, 6 Grep, 3 Glob.
- **Fixture integrity:** tracked state clean in all three repositories; heads unchanged; no file outside `.nth-review/` changed. The run added 6 record files.
- **Leakage audit** of every tool input in the stream:
  - no read, grep or glob outside the fixture;
  - no mention of the answers, the fixtures folder, the kit or the research folder;
  - no web tool, and no Git write verb;
  - 7 calls were **denied** by the permission scoping, and none ran. They are listed in the skill behavior below.
  - **Verdict: the run is valid.** The deny-rule syntax itself remains unverified; the audit is the control.

**Informal observations (the formal score is M5-T3's job, with the human checklist):**
- The confirmed findings' anchors overlap the sink or site anchors of P1, P2 (both R5-verified), P6 and P5.
- No confirmed finding sits on N1 or N2.
- The census covered some but not all of the sealed census mechanisms: P3 and P4 may score partial at most.
- Two confirmed findings were unplanned:
  - one was a **real fixture defect**: an example in `docs/api.md` contradicted its handler, because my template generator used one error text for every 422. It is fixed, and the answers were regenerated: only the root heads changed, and no planted item moved;
  - one is a valid low risk, now listed in `unplanned_allowances`.

**Skill behavior seen in the smoke run** (reported, not fixed in M5-T1):
1. The lead tried to write a helper script outside the project (`%TEMP%\nthr-lead-ledger\cp1.cjs`), against "write only the records". It was denied.
2. The lead first tried to edit `records.json` through `node -e` instead of its own Write and Edit tools. It was denied, and it then used Write and Edit.
3. Five more denials came from Bash forms the scoped rules do not match (`cd … && …`, shell loops, a `..` path); they cost turns. M5-T4 should either adapt the allow rules or treat this friction as a cost factor.
4. The lead recorded `lead_effort: unknown` instead of asking. The routing evidence must come from transcripts (M5-T2), as decision C16 expects.

**Disclosures:**
- The `architect` analysis read the real configuration's `settings.json` to learn the default effort.
- I extracted only the `perTurnEffort` fields from this run's own session transcript.
- No other file under the real configuration was read or changed.

### Tests and checks

- **`tests/fixtures.test.mjs`, 9 tests:**
  - **structure:** repositories, commits, the expected change, size M, Enable-installed runtime files byte for byte, and no development files;
  - **no answers** in any fixture file, name, commit or identity;
  - **anchors:** every item, census mechanism, population member and allowance anchor sits at its sealed place, and every `absent` text is truly absent; the mirror pair differs by one line;
  - **determinism:** identical manifests and the sealed heads;
  - **INC:** the three variants' heads, history, changed files and reopen classes;
  - **syn-debt:** sizing and budget pressure;
  - **refusals:** a non-empty directory, a work tree, outside the temporary directory, a bad `--from`, an unknown name, and missing arguments;
  - **the answers contract:** schema, ids, gating, safe anchors and the records vocabulary;
  - **template hygiene.**
- **Full suite: 290 tests, 285 pass, 0 fail, 5 skipped** (281 before, plus 9), identical from Git Bash and PowerShell. The 5 skipped tests are platform cases, and they are **not** passes.
- The M4 rehearsal is unchanged after the helper move: 75 rows, 72 pass, 0 fail, 3 unverified.
- VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical. Private project A and the kit's Git index are unchanged.
- **Kept:** `%TEMP%\ledger-1`, the only genuine run's records, for M5-T2 and M5-T3 development, as the VS1 fixture is kept.

### Remaining limitations

- **No real run of anything but the R1 Task on `syn-ledger`:** `syn-ledger-inc` (R2) and `syn-debt` (R1 and R2) have not run with a real reviewer. Their behavior is validated only against the helper's `new-run` and `fresh`.
- **No scoring or transcript metrics yet:** the criteria are defined in `tests/fixtures/README.md`; the tools are M5-T3 and M5-T2.
- **Sonnet cannot lead these fixtures:** every one carries an authorization or money trigger, so a Sonnet lead escalates by design. The G5 row "Sonnet vs Opus High lead" needs an owner reading for M5-T4.
- **The reviewer session loads the user's configuration:** its global instructions, plugins (`ponytail`, `nth-session-title`, `nth-status`, `nth-task-progress` and others), hooks, and one MCP server. Production conditions, but not a clean room.
- **Leakage controls are partly unverified:**
  - the answers ship with the library (Global Install copies `tests/`), though not today;
  - `Bash(node:*)` could read any file.

  The transcript audit is the control, automated in M5-T2.
- macOS, Node.js 20 and real symbolic links remain unverified.

**M5-T1 readiness:** the fixtures, the sealed answers, the evaluation criteria and the end-to-end path (install, discovery, invocation, records, close) are ready.

**Next task: M5-T2**, the transcript metrics tool. Its input is the session JSONL and its subagent transcripts. It reports:
- per-agent model and effort (`perTurnEffort`);
- tokens and tool calls by tool;
- the Agent calls with `subagent_type`, `model` and `effort`;
- turn-limit stops;
- permission denials;
- routing violations;
- the leakage audit, automated.

The smoke run's transcript is its first real sample.

## M5-T2 transcript metrics and M5-T3 scoring, with the first real benchmark (2026-10-27)

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1, Claude Code 2.1.310.
- **Baseline:** `master` at `bbdbfdb`, with a clean working tree before the task.
- **Git:** the index stayed unchanged throughout (mtime `2026-10-26 23:06:58`), with no Git write of any kind.
- **No new review:** no paid session ran in this task.

As in M5-T1, this section names items by id and category only. The mechanisms are in the sealed-side report.

### Deliverables

- **`tests/tools/transcript-metrics.mjs`** (M5-T2), with `tests/transcript-metrics.test.mjs` (14 tests).
- **`tests/tools/score.mjs`** (M5-T3), with `tests/score.test.mjs` (22 tests).
- **Sealed side,** next to the answers:
  - `tests/fixtures/syn-ledger/history/answers-pre-run-169ad1b0.json`;
  - `adjudications/20261026-153037-task-ledger.json`;
  - `reports/20261026-153037-task-ledger.md`, the full benchmark report, sections A–J.
- **`tests/fixtures/README.md`:** the matching rule rewritten, an "M5-T3 clarifications" subsection, and a Tools section.

### Phase 0: fixture and answers integrity

**Order of events:**
1. The answers were hashed at 15:30 UTC.
2. The review ran from 15:30 to 15:41.
3. The fixture fix was made at about 15:43, after the run closed.

**Proof of the version:**
- The pre-run answers were rebuilt from the committed ones by reversing the two post-run edits (the root head, and one allowance's note and anchors). Their sha256 equals the hash recorded before the run, `169ad1b0…`, exactly. Items, census, runs and scoring are byte-equal across the two versions.
- The reviewed tree equals the run's snapshot, and nothing outside `.nth-review/` changed.
- It differs from a current build only in one root document, which holds no item anchor.

**The score is official**, against the pre-registered answers.

### M5-T2: what the transcripts show, and how reliably

**Observed format** (Claude Code 2.1.310):
- **Repeated records:** each API message is written as one `assistant` record per content block, and every one repeats the same `message.usage`. In this run, 87 lead records are 22 messages.
- **Effort:** it sits on every assistant record (`perTurnEffort`).
- **Denials:** they are `permissionDecision: reject` (with `reasonCode`) on the tool result.
- **Agent results:** they carry `agentId`, `status`, `totalToolUseCount` and `totalTokens`. `totalTokens` is the delegate's **final message context**, not its consumption.
- **Linking:** delegate transcripts sit in `<session>/subagents/`, linked by `.meta.json` `toolUseId`.
- **Cost:** a `cost-state` record holds the client's cumulative list-price cost.

**Accuracy on the real run:**
- The deduplicated per-model token sums equal the client's own `modelUsage` exactly. Opus: 66 input, 72,203 output, 225,956 cache-creation and 2,916,487 cache-read tokens. Sonnet: 30, 13,447, 71,470 and 371,967.
- The denials (7) and the cost (4.058 USD) agree with the stream.
- The transcript span, 644.5 s, agrees with the stream's 643.8 s and the cost state's 645.4 s.

**Limitations:**
- Record edits made through a shell are not counted for B1.
- Only absolute and climbing paths are checked as "outside" (heuristic).
- Costs are the client's calculation; none is estimated.
- An empty safety list is not proof of isolation.

**The run's metrics:**
- **Routing:** lead `claude-opus-5-5` at `high` on every turn; R5 ×2 Opus at `high`; R3 and R6 Sonnet. 0 routing violations.
- **Tokens:**
  - lead: 44 input, 66,382 output, 183,506 cache-creation, 2,710,734 cache-read;
  - delegates, cumulative: 52, 19,268, 113,920, 577,720.
- **Tool calls:** lead 58 (55 after open; 57 recorded); delegates 58.
- **Budget:** 55 of 70 lead calls and 4 of 5 subagent calls. The edits after B1 only recorded verification results, which B2 allows.
- **Safety:** 7 denials. Both contested actions were attempted and **denied**, and neither executed:
  - a helper script written outside the fixture;
  - records edited through `node -e`.

  The 11 executed writes were all to the run's own records. There were no Git writes, network, web or outside reads.
- **Records against observation:**
  - `subagent_tokens` 81,710 is the reported final-turn context of three delegations; R3 was recorded with null tokens and tool uses. Consumption was 710,960.
  - `lead_effort` was recorded as `unknown` against the observed `high`.

### M5-T3: official score of run `20261026-153037-task-ledger`

| Item | Gating | Result |
|---|---|---|
| P1 | yes | true positive (confirmed, R5) |
| P2 | yes | true positive (confirmed, R5) |
| P3 | yes | partial (census: the activation site is named only in text) |
| P4 | yes | partial (census: the cited line is not the planted statement; tolerance edge) |
| P5 | yes | true positive (confirmed, R6) |
| P6 | yes | true positive (confirmed, R6) |
| N1 | yes | not a false positive; distinguished only in counterevidence, so reported, not credited |
| N2 | yes | correctly held |

- **Findings:** 4 true positives, all confirmed. 0 false negatives and 0 false positives. 2 valid unplanned findings: a **fixture defect** in the reviewed version, since fixed, and a genuine low risk.
- **Precision** 1.00. **Census recall** 6/8. **Populations** fully cited. Every one of the 77 record anchors resolves, and each matched item has all its required evidence.
- **Adjudication:** by the development session, which also wrote the answers. It is **not independent**, and the score says so.

### Independent review and fixes

A `reviewer` reproduced the score, then probed both tools. It found no blocker. Every supported finding is fixed with a regression test.

**Metrics fixes:**
- **Output safety:** absolute paths and credentials outside the known roots could reach the output. Now any absolute path is labelled and bearer tokens, keys and passwords are masked.
- **Synthetic records:** records of model `<synthetic>` counted as a routing violation. They are now counted apart.
- **Path and Git detection:**
  - missed forms are now caught: `/etc`, `/tmp`, `~/`, `$HOME`, `%VAR%`, `git.exe`, and a quoted `-C`;
  - `..` paths are resolved from the command's `cd`, which removes a false alarm in the real run;
  - `/dev/null` is ignored.
- **Runtime:** `contradictory` came from file order alone. It now comes only from disagreement with the client's durations.
- **Unlinked transcripts:** they were neither audited nor summed; now they are.
- **Robustness and smaller fixes:**
  - a quadratic regex on huge commands, now bounded;
  - crashes on non-string ids or commands;
  - prototype-named tools;
  - `new-run` detected as a substring;
  - missing record fields compared as `null === null`;
  - recoveries counted from failed messages;
  - delegations compared by position;
  - sensitive glob and grep patterns not checked;
  - a root-ordering bug: the most specific root now wins.

**Scoring fixes:**
- **Version check:** answers with no heads could be "verified", and Incremental answers could never be. Now there are explicit `unpinned` and per-variant checks.
- **Counting:**
  - a control false positive was counted twice;
  - precision could exceed 1 with `needs_validation` true positives; it now counts confirmed true positives only.
- **Location credit:**
  - whole-file ranges earned location credit; anchors over 30 lines now never match;
  - a file's title heading satisfied any rule; only the innermost heading counts now.
- **Controls:** credit was given for a control named only in counterevidence. That is now "reported, not credited", as README rule 5 says. As a result, the real run's controls changed from 2/2 credited to 1/2 credited and 2/2 not false.
- **Census and adjudication:**
  - location-only partial matches now wait for root-cause adjudication;
  - an `unknown` census item counted as covered; it is now partial;
  - a defect item with an honest open obligation is now a labelled miss;
  - adjudication values are validated, and the population adjudication is now read;
  - Git in the reviewed tree now runs with fsmonitor and hooks disabled.
- **Two of my own test errors** were corrected; they were not tool defects.

**Accepted and documented:** greedy one-to-one assignment, with no optimal matching (deterministic).

### Weaknesses found, and the recommendations

They are ranked in the sealed report. Nothing in the skill, its prompts or its routing was changed to improve this score.
1. **Cost measurement:** `subagent_tokens` measures final-turn context, not consumption (B5), so the G5 cost figures must come from M5-T2. An nth-review defect.
2. **Census guidance** leaves unchanged activation sites and DML migrations unclassified (P3, P4; recall 6/8). An nth-review defect.
3. **Unrecorded delegation:** `check` accepts a completed delegation with null tool uses and tokens (R3). A reviewer mistake that the helper allows.
4. **Effort from the transcript:** routing evidence must come from transcripts. The lead's self-report was `unknown`, as decision C16 expects.
5. **Denied shell forms** cost turns. A harness and runbook issue.
6. **Guardrail breaches:** the lead tried two writes against the guardrails; the harness denied both. A reviewer mistake. A stronger guardrail is recommended.
7. **Tool-call counting:** the B5 start point is ambiguous, 57 against 55.
8. **Fixture defect:** one fixture defect, fixed after the run. A benchmark problem.

### G5 progress

From one Opus-High run:
- **Met:** finding accuracy, false positives, agent completion and routing.
- **Not met:** coverage.
- **Not evaluable yet:** precision across repeats, cost across runs, the Sonnet lead, INC and DEBT.

**G5 is not passed.**

### Tests and preservation

- **Full suite: 326 tests, 321 pass, 0 fail, 5 skipped** (290 before, plus 36), identical from Git Bash and PowerShell. The 5 skipped tests are platform cases, and they are not passes.
- The M4 rehearsal is unchanged: 75 rows, 72 pass, 0 fail, 3 unverified.
- VS1 still passes `verify.mjs` (9/9), and its fixture is byte-identical.
- The fixture builders, the three sealed answers and the fixture tests are unchanged.
- The smoke fixture and its transcripts are untouched.
- Private project A's heads moved at 20:17 on 2026-10-26, outside this session and before this task. Its working trees are clean, and this task wrote nothing there.
- **Disclosure:** to measure the run, I read this run's own session transcript and its four delegate transcripts in the real configuration's `projects/` folder. No other configuration file was read.

### Remaining limitations

- One run only; the adjudication is not independent.
- macOS and Node.js 20 are unverified.
- The INC and DEBT scoring paths are tested on synthetic records only.

**Next task: M5-T4**, the validation matrix. Before its first run:
- the owner decides how the "Sonnet vs Opus High" row is read, since every SYN fixture escalates a Sonnet lead;
- the owner names an independent adjudicator;
- the final answers' hashes are recorded again.

## M5-T4 validation matrix: closed, G5 = FAIL (2026-10-27)

**Status: closed, G5 = FAIL** (owner decision; ledger seq 97). 13 matrix rows are valid and counted. SS2 is not completed; Sonnet vs Opus is inconclusive. M6 is not started. The full record of batches, corrections and decisions follows, in order.

**Environment:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1, Claude Code **2.1.311** (it auto-updated from 2.1.310 during this task). The kit was at `bbdbfdb` with uncommitted work. This task made no Git write; the index was later changed by a separate workstream (see batch 2).

As in M5-T1..T3, this section names items by id and category only. The mechanisms stay on the sealed side.

### Owner decisions
1. **Sonnet vs Opus High:**
   - Sonnet never leads a fixture whose triggers require Opus High.
   - The two are compared only on one eligible, untriggered Task review fixture (`syn-shelf`).
   - Escalation is measured separately: the recorded triggers, and `check` refusing a Sonnet lead on the real records.
   - The delivery roadmap's "Sonnet on SYN-LEDGER" reading is superseded.
2. **Independent adjudication:** a fresh, isolated session that is neither the fixture author nor the reviewer. It judges blind, its verdicts are frozen before the answers are used, and only then does the deterministic scorer run. Any lack of independence is recorded.
3. **Staged execution:**
   - a free preflight;
   - shell-read, write and fail-closed isolation checks;
   - one approved pilot (L1, cap $10);
   - then batches of at most 3 rows, each approved with a cap.
4. **Reading of SYN-LEDGER-INC "× 2":** per variant (committed, rewritten, dirty), so 6 Incremental rows.

### Changes made before any counted run
- **Census coverage (general):**
  - **Root cause in the smoke run:** no `migrations` search was ever run, and an unchanged scheduler-registration file was named only in another item's text.
  - **Fix:** `reference/census.md` §1 and §3.2, and the R3 plan-critique question in `reference/prompts.md`. The wording names no fixture file. G3 is green.
- **`syn-shelf`** (Sonnet-eligible):
  - Task S: 8 files, 75 changed lines, no lead-model trigger, with a reason recorded for each trigger.
  - Items E1–E4 and controls EN1–EN2; census mechanisms and a population.
  - A comparison rule (`scoring.g5`), pre-registered before any run.
  - An independent review found two blockers before registration, both fixed: the cause and rule anchors of one item, and retries.
- **Blind adjudication:** `nthr-adjudication-blind@1` in `tests/tools/score.mjs`.
  - It is keyed by record ids and frozen by sha256.
  - It maps onto items by fixed rules: the cause on an item's site, sink or propagation lines; any of the item's rules. Anything unsettled stays pending and earns nothing.
- **B5 counting:** calls are counted from the first lead call after the executed `new-run`. `transcript-metrics.mjs` also reports the count at the last records write.
- **Matrix runner** `tests/tools/matrix.mjs`:
  - **Ledger:** a hash-chained, append-only ledger in `tests/fixtures/g5-ledger.jsonl`.
  - **Pre-run record:** the answers sha256, heads, tree and skill hashes and the routing, written before each session.
  - **Leakage audit:** checked after each session.
  - **Attempts:** voided attempts are kept as history and moved out of every session's reach. Per-attempt files mean a retry never overwrites earlier evidence.
  - **Gates:** a spending cap per batch, a version gate, `drive --dry-run`, and a `costs` report.
- **Operator note (harness input):**
  - Each prompt carries one fixed sentence: the session's model and effort, and that nobody will reply to questions.
  - **Why:** `SKILL.md` tells the lead to ask once when it cannot tell its effort, and a headless session cannot answer. This was observed in the aborted L1 attempt.
  - **What it leaves out:** anything about the code.

### Isolation: what is enforced, and by what
The sessions run as the same Windows user as everything else, so **the operating system enforces none of these boundaries.** All of them are Claude Code-level.

| Boundary | Enforced by | Evidence |
|---|---|---|
| Reads through file tools | Claude Code deny rules (answers, development transcripts, history, other rows, earlier fixtures), plus the session guard | live probes and unit tests |
| Shell reads, including Git forms that reach other repositories or files | Session guard: a PreToolUse hook with a strict command grammar | live probes and about 60 unit-tested forms |
| Writes | Session guard (reviewer: `.nth-review/` only; adjudicator: `verdicts.json` only), plus Claude Code's working-directory rule | live probes (temporary targets) and unit tests (kit and configuration paths) |
| MCP, web, PowerShell, other Claude sessions | `--strict-mcp-config`, disallowed tools, the guard's tool allowlist; `SendMessage` limited to the session's own subagents | live probe (no MCP server loaded) and unit tests |
| Guard failure | exec-form hook with `onFailure: "block"`; default permission mode with nobody answering prompts and no allow rules, so only the guard's explicit approval runs a shell command or a write | live: guard exit 1, timeout, missing executable, missing script, unwritable log: **0 calls executed**, Explore and reviewer subagents included |
| Helper (`nthr.mjs`) writes | the helper's own write guard (`scripts/lib/fsguard.mjs`) | its existing tests |

- **Neutral guard copy:** the guard runs from a copy in the temporary folder, so a block message names no kit path. This was verified live.
- **Version gate:** `drive` refuses to start unless `claude --version` equals the version of the last `isolation-verified` ledger record.
- **Probe sessions:** the probes were permission tests, not reviews, and cost $1.85 in all. They sit outside the matrix and its costs.
- **Unverified:**
  - there is no OS backstop if Claude Code ever skipped the hook; the per-call audit would detect that afterwards;
  - subagent types other than Explore, reviewer and general-purpose were not tested;
  - writes aimed at the real kit, configuration or project folders were not attempted live.

### Pre-registration and the ledger
- **seq 1 `registered`:**
  - the plan, chains and expected routing;
  - answers sha256: syn-ledger `e0d29759…`, syn-ledger-inc `4b4af0db…`, syn-debt `469e8a92…`, syn-shelf `4fb29989…`;
  - kit head `bbdbfdb`.
- **seq 2–8:** three attempts (L1, L2, D1) were started under the earlier full-matrix instruction and stopped about a minute in, when the owner required a staged pilot. All three are **voided**; none is counted.
- **seq 9 `isolation-verified`:** Claude Code 2.1.311, passed.
- **seq 10–14:** L1, from pre-run through scored.
- **seq 15–29:** batch 1 (I1c, I1r, I1d), five events each.
- **seq 30–32:** `rescored` I1c, I1r and I1d (owner-approved scorer corrections). Each names the score it supersedes.
- **seq 33–47:** batch 2 (L2, I2c, I2r), five events each.
- **seq 48–54:** `rescored` all seven rows (correction B).
- **seq 55:** `diagnostic-scored` L2 (Rule 4 v2; not official).
- **seq 56–70:** batch 3 (I2d, D1, D2), five events each.
- **seq 71:** `rescored` D2 (correction C).
- **seq 72–86:** batch 4 (SO1, SS1, SO2), five events each. SO2's `audited` event says invalid.
- **seq 87:** `audit-corrected` (rule `own-tool-results-v2`, future audits only).
- **seq 88:** `voided` SO2 attempt 1 (stays invalid; a fresh attempt follows).
- **seq 89–93:** SO2 attempt 2 (valid; audit rule v2).
- **seq 94–95:** SS2, stopped at the spending cap; the run is open and not scored.
- **seq 96:** `voided` that SS2 attempt (preserved; a fresh attempt is prepared).
- **seq 97:** `evaluation-closed`: M5-T4 closed, G5 = FAIL, SS2 not completed.
- `verify-ledger`: chain intact, order correct, and the answers and frozen adjudication files unchanged.

### Row L1: the official baseline
**Run:** `20261027-004525-task-ledger`, Opus 5.5 at high effort.
- The fixture version was verified, and the audit found the run valid.
- The run status is `incomplete` (open obligations).
- **Adjudication:** independent. A fresh Opus High session judged the records and source only. Its verdicts were frozen (sha256 `14bf513c…`) before scoring.

| Item | Gating | Result |
|---|---|---|
| P1 | yes | true positive |
| P2 | yes | true positive |
| P3 | yes | covered |
| P4 | yes | covered |
| P5 | yes | true positive |
| P6 | yes | true positive |
| N1 | yes | not raised (not a false positive; not credited) |
| N2 | yes | correctly held |

- **Findings:** 5 confirmed: 4 true positives and 1 valid unplanned risk (F-5). 0 false positives. **Precision 1.00.**
- **Coverage:** census recall **8/8**, both automatic and adjudicated.
- **Populations:**
  - routes: exact;
  - ledger writers: all 4 members cited, but **pending**. The adjudicator disputed one citing obligation (OB-9, concurrency), so under the pre-registered rule the population stays pending and earns no credit. The dispute is preserved, not resolved.
- **The adjudicator's other judgements:**
  - all 5 findings valid, with a correct mechanism and no incorrect claim; one severity judged overstated;
  - 13 of 15 obligations agreed (OB-9 and OB-15 disputed);
  - 16 of 18 census items correct (two had incomplete `affects`);
  - 2 issues no finding raised, of kinds the answers allow as valid low risks.
- **Evidence and traces:**
  - 81 of 81 anchors resolve, and none exceeds the span limit;
  - required evidence: P1 4/4, P2 4/4, P5 2/2, P6 3/3;
  - every trace runs from entry point to sink (5/5).
- **Routing:** the lead was Opus 5.5 at high effort, recorded as `high` and observed as `high`. R3 and R6 ran on Sonnet, and both R5 calls on Opus at high effort. 0 violations.
- **Delegations:** 4 of 4 completed, 0 recoveries.
- **Escalation:**
  - the recorded triggers include every expected one (`task-size`, `authorization`, `money`), plus `concurrency` and `boundary-contract`;
  - the required lead model is `opus-high`;
  - the unchanged records pass `check`, while a Sonnet lead on them is refused with C15.
- **Isolation:**
  - 88 tool calls, 82 executed, every executed call approved by the guard (43 of its decisions came from subagents);
  - 4 harmless command forms blocked;
  - 0 unsafe actions executed or attempted.
- **Cost** (from the transcripts; client-computed list price):
  - review $4.01 and adjudication $1.25, **$5.25 in all** (cap $10);
  - wall clock: review 671 s, adjudication 168 s;
  - tokens: lead 3,192,390 and subagents 551,852 (input, output and cache), 15 obligations.
- **Calls:**
  - lead: 45 in all, 42 after the open, 40 at the last records write, 43 recorded (budget 70);
  - subagents: 4 calls (budget 5).
- **Retries:** none.
- **Sealed-side files:**
  - `syn-ledger/adjudications/20261027-004525-task-ledger.blind.json` and `.blind.meta.json`;
  - `syn-ledger/reports/20261027-004525-task-ledger.score.json`, `.metrics.json` and `.adjudication-metrics.json`.

### Against the pre-fix smoke baseline
One run each, on different skill and harness versions: the smoke run predates the census fix, the guard and the operator note.

| | Smoke `20261026-153037` | L1 `20261027-004525` |
|---|---|---|
| Census recall | 6/8 (P3, P4 partial) | 8/8 |
| True positives / false positives / precision | 4 / 0 / 1.00 | 4 / 0 / 1.00 |
| Adjudication | not independent | independent, blind, frozen |
| Lead effort recorded | `unknown` | `high` |
| Review cost / runtime | $4.06 / 644 s | $4.01 / 671 s (+ $1.25 adjudication) |

### Cost accounting (every matrix session)
`matrix.mjs costs` recomputes these from the transcripts:
- **Counted:** L1, $5.25 (review and adjudication).
- **Voided:**
  - the L1 attempt: $0.33;
  - the L2 and D1 attempts were killed before Claude Code recorded a cost: 790,303 and 251,576 tokens. No cost is estimated.
- **Retries and repair turns:** none so far. Every one is reported as its own session.

### Batch 1: I1c, I1r, I1d (owner-approved, cap $15)
**Setup:** the rest of L1's registered chain. Each row was built from L1's fixture and reviewed incrementally with `--base 20261027-004525-task-ledger` (Opus 5.5 at high effort).
- **Common results:** every row closed `incomplete`, the audit found it valid, it was adjudicated independently (verdicts frozen before scoring), and its score and metrics were exported to `syn-ledger-inc/reports/`.
- **Spend:** **$12.47** of the $15 cap. No retry, recovery or voided attempt.

| Row | Variant (history) | Changed files | Target T1, by the written criterion | Overreach | Census (C11) | Official |
|---|---|---|---|---|---|---|
| I1c | committed: `.` and `api` ancestor | 5 | reopened (`touched`) with a reason naming `api/src/guards.js` and the changed intent document; never current; reassessed (violated) | none | every changed file has an item | yes |
| I1r | rewritten: `api` base-missing | 24 | every `api`-anchored obligation reopened (`base-missing`); none current; the target reassessed (violated); the report states that `api`'s history was rewritten | none | complete | yes |
| I1d | dirty: uncommitted, one file untracked | 5 | reopened with a reason naming `api/src/guards.js`; never current; left `open` / `verification`, an honest class | none | complete | **no** under the original scorer; **yes** after correction 2 |

**Findings.** SYN-LEDGER-INC seals no defect items, so every finding is scored as unplanned.

| Row | Findings (confirmed) | Adjudicated valid | False positives | Precision |
|---|---|---|---|---|
| I1c | 2 (2) | 2 | 0 | 1.00 |
| I1r | 6 (5) | 6 | 0 | 1.00 |
| I1d | 1 (0, one candidate) | 1 | 0 | none confirmed |

**Adjudicators' other judgements** (none changes a score):
- **Mechanisms:** correct in all 9 findings. One I1c finding contains one incorrect claim.
- **Obligations disputed:**
  - I1c: OB-9 and OB-15;
  - I1r: OB-8, OB-9, OB-14 and OB-15;
  - I1d: OB-1, judged already violated in source where the reviewer left it open for verification.
- **Census items:** I1c 11 of 14 judged correct; I1r 27/27; I1d 5/5.

**Evidence and traces:**
- anchors resolve: 56/56, 100/100 and 24/24;
- none exceeds the span limit;
- every trace runs from entry point to sink.

**Routing, completion and escalation:**
- the lead was Opus at high effort in every row (recorded `high`), with 0 routing violations;
- delegations: I1c and I1r 3 of 3 each (R3 on Sonnet, R5 ×2 on Opus at high effort), all complete with 0 recoveries;
- I1d made no delegation and closed `incomplete` / `budget` after 29 lead calls (budget 45);
- in every row the required lead model was `opus-high`, the unchanged records passed `check`, and a Sonnet lead was refused (C15).

**Isolation:**
- every executed call was approved by the guard (83, 88 and 28);
- the guard blocked harmless forms: 2, 5 and 1 (`$` in quotes, `find`, `node -e`, `sed` after a pipe);
- 0 unsafe actions executed or attempted.

**Cost** (from the transcripts; client-computed):

| Row | Review | Adjudication | Total | Wall clock (review) | Lead calls (total / after open / last write / recorded / budget) |
|---|---|---|---|---|---|
| I1c | $3.49 | $1.01 | $4.50 | 639 s | 38 / 35 / 33 / 35 / 45 |
| I1r | $4.78 | $1.37 | $6.14 | 795 s | 46 / 41 / 38 / 41 / 80 |
| I1d | $1.16 | $0.67 | $1.82 | 195 s | 30 / 29 / 28 / 31 / 45 |

**Two scorer defects** (in the M5-T3 tool). Both surfaced on the first real Incremental runs. They were reported first; the owner then approved both corrections (see Scorer corrections below).
1. **`freshnessCheck`:** `target_never_current` is false in all three rows, because the check also counts obligations created in the new run (OB-16 and later). Those have no freshness class.
   - The written criterion (README rule 9 and T1) concerns the base's target obligation, which every row reopened correctly.
   - The proposed fix: judge only obligations present in the base, list new ones apart, and also check that the reason names `api/src/guards.js` or the changed intent document.
2. **`versionCheck`:** for the `dirty` variant, it calls the intentionally uncommitted changes "tracked changes since the run", so I1d is "not official".
   - The runner's own before-and-after tree check found no change during the run.
   - The proposed fix: for a variant that is dirty by design, compare the tree with the digest recorded before the run, not with a clean tree.

Re-scoring from the frozen adjudications would need no new session.

### Cost accounting after batch 1
`matrix.mjs costs` recomputes every session from its transcript:
- **Counted:** L1 $5.25, I1c $4.50, I1r $6.14, I1d $1.82: **$17.72**.
- **Voided:**
  - the L1 attempt: $0.33;
  - the L2 and D1 attempts were killed before a cost was recorded: 790,303 and 251,576 tokens. No estimate.

### Scorer corrections (owner-approved after batch 1)
**History:**
1. Batch 1 exposed two defects in the M5-T3 scorer. They were reported, and the scorer was left unchanged.
2. The owner approved both corrections.
3. They were applied to `tests/tools/score.mjs`, with regression tests. The runner now passes each row's frozen pre-run tree digest to the scorer.

No answers, fixtures, thresholds or frozen adjudications changed.

**Correction 1, Incremental invalidation** (`freshnessCheck`):
- Current or reopened is judged only for target obligations inherited from the base run. Obligations created in the new run are listed apart.
- A reopen reason counts only when it names a file that **actually changed in this run** and that the sealed variant marks as bearing on the target. The census item of such a file naming the obligation (C11) also counts, as does the base-missing history of that file's repository.
- A run meets the threshold when:
  - its history matches a sealed variant;
  - no inherited target obligation stays current;
  - one is reopened with such a reason;
  - every changed file has a census item.

**Correction 2, fixture integrity** (`versionCheck`):
- With the tree digest frozen in the ledger before the run, uncommitted changes are accepted when the tree still equals that snapshot. That is a variant dirty by design, and its intended changes are kept and named.
- Any change since the snapshot, tracked or untracked, is a mismatch. Without the digest, the check is as before.

**Regression tests** (`tests/score.test.mjs`):
- **Correction 1:** the batch-1 shape with new obligations; a reason naming a changed file that does not bear on the target; a target file this run did not change; the C11 census route; base-missing for the rewritten variant; an inherited obligation left current.
- **Correction 2:** a dirty build without the snapshot (the old mismatch), with it (verified), and after a tracked edit or an untracked addition (mismatch).
- **L1:** re-scored under the corrected scorer, its score is byte-identical apart from the new snapshot field. Its tree matches the frozen digest.

**Re-scoring:**
- The three rows were re-scored deterministically from their frozen adjudications (`matrix.mjs rescore`), with no new session.
- The original scores stay as they were (`reports/<run>.score.json` and the ledger `scored` events).
- The corrected ones are recorded separately: `reports/<run>.score.corrected.json`, and ledger `rescored` events seq 30–32. Each names the score it supersedes, the reason and the scorer's sha256.

| Row | Original: official / target never current | Corrected: official / never current / reopened with a correct reason / threshold | Inherited target obligations (correct reason) | New in this run |
|---|---|---|---|---|
| I1c | yes / **false** | yes / true / true / **met** | OB-1, OB-5 (guard and authorization document); OB-9 and OB-14 via the guard's census item; OB-10 carried open, no file named | OB-16, OB-17 |
| I1r | yes / **false** | yes / true / true / **met** | OB-1 (authorization document, `api` base-missing); OB-3 to OB-6 (`api` base-missing); OB-9, OB-10, OB-14 carried open | OB-17 |
| I1d | **no** (version mismatch) / **false** | **yes** / true / true / **met** | OB-1, OB-5 (guard, authorization document); pre-run snapshot unchanged, the intended uncommitted changes in `.` and `api` kept | OB-16 |

**Unchanged by the corrections:**
- every item result, finding judgement, precision and coverage figure;
- I1d still has no confirmed finding, so it has no precision, and none was invented;
- the L1 population dispute (OB-9) stays **pending**.

**Quality observation, separate from scoring:** in I1c the adjudicator judged finding F-1 valid with a correct mechanism, but quoted one claim in it as contradicted by the source. As an unplanned finding it scores `valid-unplanned`. The incorrect claim is kept here, and in the frozen adjudication, as an evidence-quality note.

### G5 progress after batch 1 (with the scorer corrections)
- **Coverage:** census recall 8/8 (L1). Population exactness is **pending**, kept from the OB-9 dispute. Every changed file has a census item in all three Incremental rows.
- **Finding accuracy and false positives:** met on L1. Precision 1.00 in every row with a confirmed finding.
- **Indirect invalidation:** **met** in all three Incremental runs under the corrected scorer (inherited target reopened with a correct reason, never current, C11 complete, no overreach). All three are official.
- **Agent completion:**
  - 11 of 11 delegations complete without recovery (L1 4, I1c 3, I1r 3);
  - I1d made none.
- **Routing:** 0 violations in 4 rows.
- **Cost:** spent ≤ budget in 4 of 4 rows.
- **Not yet run:**
  - L2 and its three Incremental rows;
  - the DEBT chain;
  - the syn-shelf Sonnet-vs-Opus comparison.

**G5 is not passed.**

### Batch 2: L2, I2c, I2r (owner-approved, cap $18)
**Setup:** the second Opus High repeat of SYN-LEDGER, then two of its Incremental rows built from L2's fixture with `--base 20261027-030324-task-ledger`.
- **Common results:** every row closed `incomplete` (open obligations), the audit found it valid, it was adjudicated independently (verdicts frozen before scoring), it is official (fixture version verified), and its score and metrics were exported.
- **Scorer:** the corrected scorer was used, and nothing in the answers, fixtures or thresholds changed.
- **Spend:** **$15.26** of the $18 cap. No retry, recovery or voided attempt.

**L2** (run `20261027-030324-task-ledger`), **as scored under the registered rules:**

| Item | Gating | Result |
|---|---|---|
| P1 | yes | true positive |
| P2 | yes | true positive |
| P3 | yes | **false positive** (rule 4; see A below) |
| P4 | yes | covered |
| P5 | yes | true positive |
| P6 | yes | true positive |
| N1 | yes | **false positive** (rule 4; see A below) |
| N2 | yes | correctly held |

- **Findings:** 5 confirmed: 4 true positives with all required evidence (4/4, 4/4, 2/2, 3/3), and F-4, scored a control false positive against both N1 and P3.
  - **Precision:** 0.80.
  - **Census recall:** 8/8 automatic, **6/8 adjudicated**: M-migration-003 pending (see B below); M-admin-reader `bad`, its census item judged incorrect because `affects` omits an obligation.
  - **Populations:** routes exact; ledger writers all 4 cited but pending (OB-14 and OB-16 disputed).
- **Adjudicator:** all 5 findings valid, F-4 included, with correct mechanisms and no incorrect claim. 15 of 18 obligations agreed; 19 of 25 census items correct (mostly incomplete `affects` lists).
- **Evidence:** 75 of 75 anchors resolve; every trace runs from entry point to sink.

**Two open scoring points from L2.** The owner decided both after this batch; see "Owner decisions A and B" below.
- **A. Rule 4 applied by line proximity.** Rule 4 (README) says: "A confirmed defect on the anchors of N1, N2, P3, P4 or X3 is a false positive automatically."
  - **F-4's claim:** an unvalidated `targetAccountId` reaches SQL, and a self-target ends as an undocumented 500. Its checks are LOGIC.3, CONTRACT.2 and LEDGER.3; the adjudicator judged it valid. It is close in kind to the sealed allowance `A-self-transfer`, but its anchors are elsewhere.
  - **Why the rule fired:**
    - its trace range `sweeps.js:10-13` includes N1's site lines (12–13), the ownership checks it makes no claim about;
    - its sink `app.js:19-21` (the error handler) is within the 3-line tolerance of P3's entrypoint anchor `app.js:23` (the timer activation).
  - **The scorer follows the rule as written.** One finding therefore costs two false positives and a control.
  - **A possible refinement:** count a control hit only when the finding also shares the control's concern (the same check family, as `sameConcern` already requires for obligations), and match on site or sink anchors only. Adopting it after seeing this result is the owner's call.
- **B. Group-path census items.** The review covered the migrations with one group-path item, `api/migrations/*.sql`, which `census.md` §1 allows and the adjudicator judged correct.
  - **The gap:** the scorer matches census items by exact path only, so M-migration-003 fell back to a disputed obligation.
  - **The finding:** this is a scorer gap against the census specification, of the same kind as the batch-1 corrections.

**I2c and I2r** (Incremental, corrected scorer):

| Row | Variant | Target T1 | Overreach (reported, not gating) | C11 | Findings (confirmed): valid / false | Precision |
|---|---|---|---|---|---|---|
| I2c | committed | inherited target obligations reopened for the guard or authorization-document change; never current; **met** | OB-16 | complete | 2 (2): 2 / 0 | 1.00 |
| I2r | rewritten (`api` base-missing) | reopened for the base-missing history and the document change; never current; **met** | none | complete | 5 (3): 5 / 0 | 1.00 |

- **Adjudicators:** every finding valid with a correct mechanism and no incorrect claim. I2c agreed 13 of 13 obligations; I2r 17 of 21 (OB-5, OB-7, OB-15 and OB-16 disputed).
- **Evidence:** 54/54 and 101/101 anchors resolve; every trace runs from entry point to sink.

**Routing, completion and escalation:**
- the lead was Opus 5.5 at high effort in every row, with 0 routing violations;
- delegations: L2 4 of 4, I2c 2 of 2, I2r 3 of 3, all complete with 0 recoveries;
- in every row the expected triggers were recorded, the unchanged records passed `check`, and a Sonnet lead was refused (C15).

**Isolation:**
- every executed call was approved by the guard (108, 81 and 88);
- harmless forms were blocked (9, 3 and 2);
- 0 unsafe actions executed or attempted.

**Cost** (from the transcripts):

| Row | Review | Adjudication | Total | Wall clock (review) | Lead calls (total / after open / last write / recorded / budget) |
|---|---|---|---|---|---|
| L2 | $4.11 | $1.11 | $5.22 | 682 s | 63 / 60 / 57 / 62 / 70 |
| I2c | $3.43 | $0.85 | $4.27 | 635 s | 38 / 35 / 33 / 36 / 51 |
| I2r | $4.39 | $1.38 | $5.77 | 707 s | 43 / 40 / 37 / 40 / 80 |

**Git index (not this task):**
- **What changed:** the kit's index was written at 2026-10-27 03:44:29 UTC, during this batch. It now holds staged changes to nine files of a separate task-progress workstream: the task-progress integration, the top-level READMEs and `managed/global-instructions.md`.
- **Why it was not this task:**
  - the matrix sessions ran only in temporary folders under the session guard;
  - their audits show no Git write;
  - the last session before that moment wrote only `verdicts.json` in its sandbox;
  - this task never ran `git add`.
- **What this task did:** left those staged changes untouched.

### Cost accounting after batch 2
- **Counted:**
  - L1 $5.25;
  - I1c $4.50, I1r $6.14, I1d $1.82;
  - L2 $5.22, I2c $4.27, I2r $5.77;
  - **total $32.98**.
- **Voided:** $0.33, plus two killed attempts with tokens only.

### G5 progress after batch 2
| Dimension | Status |
|---|---|
| Finding accuracy (P1, P2 every run; ≥ 3 of 4) | **met** in both Opus repeats (L1, L2: 4 of 4 each) |
| False positives (N1, N2 never confirmed; ≤ 1 other; precision ≥ 80%) | **not met as scored:** N1 is scored confirmed in L2 (A). Other false confirmed: 0 in each run. Precision across repeats: (5 + 4) / 10 = 0.90 |
| Coverage (census recall 100%; populations exact) | **not met as scored:** L1 8/8; L2 6/8 adjudicated (B, plus one census item judged incorrect). Populations pending in both runs |
| Indirect invalidation | **met** in 5 of 5 Incremental runs so far (I1c, I1r, I1d, I2c, I2r); I2d not run |
| Agent completion | 19 of 19 delegations complete without recovery |
| Routing | 0 violations in 7 rows |
| Cost (spent ≤ budget) | 7 of 7 rows |
| Not yet run | I2d; the DEBT chain (D1, D2); the syn-shelf Sonnet-vs-Opus comparison (SO1, SS1, SO2, SS2) |

**G5 is not passed.** (Superseded by "G5 progress after decisions A and B".)

### Owner decisions A and B (after batch 2)

**A. Rule 4: L2's official score stays as registered.** The scorer applied Rule 4 as written, and that result is kept: no completed run is re-scored under a new rule.

| L2 | Official (Rule 4 as registered) | Diagnostic: Rule 4 v2 (not official) |
|---|---|---|
| Control-rule hits | 2: N1 by F-4, P3 by F-4 | 0 |
| Distinct false-positive findings | 1 (F-4) | 0 |
| N1 / P3 | false positive / false positive | not raised / covered |
| F-4 | false positive (control) | valid unplanned |
| Precision | **0.80** | 1.00 |
| Controls never confirmed | **not met** | met |
| Census recall (adjudicated) | 7/8 (after B) | 7/8 |

- **Reconciliation:**
  - `false_positives` = 2 counts rule hits: one finding disqualified two items.
  - Precision counts findings: (4 confirmed true positives + 0 valid unplanned) / 5 confirmed = 0.80, so F-4 counts once.
  - The scorer now reports both (`control_rule_hits`, `false_positive_findings_distinct`).
- **Why F-4 is not about N1 or P3** (diagnostic reasoning, from the records and the adjudication only):
  - **What F-4 claims:** an unvalidated `targetAccountId` reaches SQL, and a self-target ends as an undocumented 500. Its obligation's checks are LOGIC.3, CONTRACT.2 and LEDGER.3. The adjudicator judged it valid, with its cause at the two `Number(req.body.targetAccountId)` lines.
  - **N1** is an ownership control (AUTHZ.2). F-4's trace range `sweeps.js:10-13` contains N1's site lines (12–13), but F-4 makes no claim that either ownership check is missing or wrong. Different concern family.
  - **P3** is the census item of the interest timer (ATOMIC.1). F-4's sink `app.js:19-21` is the error handler; it is within the 3-line tolerance of P3's *entrypoint* anchor `app.js:23` (the timer's activation call), not of its site or sink. Different concern, and not on the item's site or sink.
- **The diagnostic:**
  - it is computed by `score.mjs --rule4 v2-diagnostic` and recorded as `reports/20261027-030324-task-ledger.score.diagnostic-rule4-v2.json` with ledger `diagnostic-scored` seq 55;
  - it is labelled "never an official score".
- **Rule 4 v2:** documented in the fixtures README for future pre-registered benchmarks only. It is not applied to any completed run.

**B. Group-path census items: scorer correction, approved.**
- **The change:** `census.md` §1 allows a census item to name a group path (`*` and `?` within one segment). The scorer now matches such items with the helper's own C11 matcher, used for:
  - census coverage;
  - the C11 check of Incremental runs;
  - census-based reopen reasons.
- **Tests** (`tests/score.test.mjs`):
  - valid patterns;
  - unrelated folders, extensions and patterns that would cross a `/`;
  - an exact item winning over a group item;
  - a group item judged correct (covered) or incorrect (not credited);
  - C11 with a group item.
- **Re-scoring:**
  - all seven counted rows were re-scored from their frozen adjudications (ledger `rescored` seq 48–54, `reports/<run>.score.corrected-b.json`);
  - every earlier score stays;
  - no answer, fixture, threshold or verdict changed.

| Row | What correction B changed |
|---|---|
| L1 | M-migration-003 is now credited through the group census item instead of an obligation; coverage stays **8/8** |
| L2 | adjudicated census recall **6/8 → 7/8**: M-migration-003 is now credited through the group item `api/migrations/*.sql`, which the adjudicator judged correct. **M-admin-reader stays uncredited:** the adjudicator judged its census item incorrect (`affects` omits OB-6), and that verdict stands |
| I1c, I1r, I1d, I2c, I2r | no material change; Incremental threshold still met |

**Unchanged:** L1 and L2 population exactness stays **pending** (the ledger-writer population has disputed citing obligations in both runs). The staged Git changes from the separate workstream stay as they were.

### G5 progress after decisions A and B
| Dimension | Status (official scores) |
|---|---|
| Finding accuracy | **met** in L1 and L2 (4 of 4 each) |
| False positives | **not met:** N1 counted as confirmed in L2 (Rule 4 as registered). Other false confirmed: 0 per run. Precision across repeats: 9 / 10 = 0.90 |
| Coverage | **not met:** L1 8/8; L2 7/8 adjudicated (one census item judged incorrect). Populations pending in L1 and L2 |
| Indirect invalidation | **met** in 5 of 5 Incremental runs; I2d not run |
| Agent completion | 19 of 19 delegations complete without recovery |
| Routing | 0 violations in 7 rows |
| Cost | spent ≤ budget in 7 of 7 rows |
| Not yet run | I2d; D1, D2; SO1, SS1, SO2, SS2 |

**G5 is not passed.**

**Next batch:** I2d → D1 → D2, with a cap of $15. The owner approved it, and it ran as batch 3 below.

### Batch 3: I2d, D1, D2 (owner-approved, cap $15)
**Setup:** I2d is the last Incremental row of L2's chain (the dirty variant). D1 → D2 is the SYN-DEBT chain: a Task review, then `incremental --base 20261027-044845-task-payouts` in a copy of D1's fixture.
- **Common results:** every row closed `incomplete` (open obligations), the audit found it valid, it was adjudicated independently (verdicts frozen before scoring), it is official (fixture version verified), and its score and metrics were exported.
- **Scorer:** the corrected scorer (corrections 1, 2 and B; Rule 4 as registered).
- **Spend:** **$10.86** of the $15 cap. No retry, recovery or voided attempt.

**I2d** (run `20261027-043728-incremental-ledger-inc`, dirty variant):
- **Pre-run snapshot:** unchanged, so the intended uncommitted changes count as intended.
- **Target:** the inherited target obligations were reopened with a correct reason and none stayed current, so T1 is **met**. C11 is complete.
- **Overreach:** OB-16 (reported, not gating).
- **Findings:** 2, both judged valid; 1 confirmed. 0 false positives, precision 1.00.
- **Adjudicator:** 11 of 13 obligations agreed; 8 of 11 census items correct.
- **Evidence:** 49 of 49 anchors resolve.

**D1** (run `20261027-044845-task-payouts`, Task, size S, triggers recorded):

| Item (not gating) | Result |
|---|---|
| X1 | true positive (required evidence 3/3) |
| X2 | `partial-pending`: matched with a correct mechanism, but 2 of 3 required evidence. Under the registered rules a person judges it, so it earns nothing |
| X3 | correctly held |
| X4 | honest open |

- **Review debt (R1):** status `incomplete`, as the answers expect. Every open obligation and every unverified finding is covered by one of the 8 debt-out items. `check` is green.
- **Findings:** 2, both judged valid with correct mechanisms. Precision 1.00, 0 false positives.
- **Evidence:** 35 of 35 anchors resolve.

**D2** (run `20261027-050004-incremental-payouts-r2`):
- **Review debt (R2):** **8 of 8** debt-in items dispositioned (6 carried and repeated in debt-out, 2 discharged). `check` is green.
- **Discharged items:** both are `deferred-scope` in D1's debt-out; both `owner-fact` items were carried. So no runtime or owner-fact debt was discharged without evidence.
- **X items:** X1 and X2 score `missed` in D2, because the scorer scores each run's own records, and D2 re-raised neither (X1 is confirmed in its base D1). These items are not gating.
- **Findings:** 2 new, both judged valid; precision 1.00.
- **Evidence:** 21 of 21 anchors resolve.

**Routing, completion and escalation:**
- the lead was Opus 5.5 at high effort in every row, with 0 routing violations;
- delegations: I2d 3 of 3, D1 3 of 3, D2 1 of 1, all complete with 0 recoveries;
- in every row the expected triggers were recorded, the unchanged records passed `check`, and a Sonnet lead was refused (C15).

**Isolation:**
- every executed call was approved by the guard (89, 59 and 49);
- harmless forms were blocked (7, 2 and 1);
- 0 unsafe actions executed or attempted.

**Cost** (from the transcripts):

| Row | Review | Adjudication | Total | Wall clock (review) | Lead calls (total / after open / last write / recorded / budget) |
|---|---|---|---|---|---|
| I2d | $3.16 | $1.07 | $4.23 | 566 s | 53 / 50 / 48 / 50 / 51 |
| D1 | $3.38 | $0.86 | $4.24 | 555 s | 37 / 34 / 31 / 34 / 40 |
| D2 | $1.73 | $0.66 | $2.39 | 293 s | 42 / 39 / 37 / 39 / 44 |

**Scorer gap C.** The owner approved the correction after this batch; see "Owner decision C" below.
- **The check:** `debtCheck` looks for runtime or owner-fact debt discharged without new evidence by reading `kind` on debt-in items.
- **The gap:** `records.md` gives debt-in items no `kind` (`{ id, from_run, disposition, note }`), so the check can never fire.
- **The fix:** read the kind from the base run's debt-out.
- **This run:** checked by hand against D1's debt-out; no violation.

**Git (not this task):** during this batch, the separate workstream committed its staged changes as `04542b2` ("Improve task progress integration"), so the kit's HEAD moved from `bbdbfdb`.
- **Files in the commit:** task-progress, nth-status, the top-level READMEs and `managed/global-instructions.md`. No review file.
- **Matrix impact:** every matrix row so far installed the identical skill (`skill_sha256` `93f741bf…`), including D2, whose pre-run record names the new HEAD.
- **This task:** made no Git write. Its own changes remain uncommitted.

### Cost accounting after batch 3
- **Counted:**
  - L1 $5.25;
  - I1c $4.50, I1r $6.14, I1d $1.82;
  - L2 $5.22, I2c $4.27, I2r $5.77;
  - I2d $4.23, D1 $4.24, D2 $2.39;
  - **total $43.84**.
- **Voided:** $0.33, plus two killed attempts with tokens only.

### G5 progress after batch 3
| Dimension | Status (official scores) |
|---|---|
| Coverage | **not met:** L1 8/8; L2 7/8 adjudicated (one census item judged incorrect). Populations pending in L1 and L2 |
| Finding accuracy | **met** in L1 and L2 (4 of 4 each) |
| False positives | **not met:** N1 confirmed in L2 (Rule 4 as registered). Other false confirmed: 0 per run. Precision across repeats: 0.90 |
| Indirect invalidation | **met** in 6 of 6 Incremental runs. Overreach was reported in I2c and I2d (OB-16), which does not gate |
| Review debt | **met:** D1 `incomplete` with complete debt-out; D2's debt-in 8 of 8 dispositioned; `check` green on both |
| Agent completion | 26 of 26 delegations complete without recovery |
| Routing | 0 violations in 10 rows |
| Cost | spent ≤ budget in 10 of 10 rows; I2d used 50 of 51 lead calls |
| Sonnet vs Opus (syn-shelf) | not yet run: SO1, SS1, SO2, SS2 |

**G5 is not passed.**

**Next batch:** SO1 → SS1 → SO2 on `syn-shelf`, cap $12. The owner approved it, and it ran as batch 4 below. SS2 follows in a later batch. The dry run passes, and the Sonnet rows run without an effort flag. The comparison rule is decided only once both Sonnet runs exist.

### Owner decision C (after batch 3): debt kinds from the base run
**Correction C** (`tests/tools/score.mjs`, `debtCheck`):
- **The defect:** `records.md` gives a debt-in item no `kind` (`{ id, from_run, disposition, note }`), so the old check ("runtime or owner-fact debt discharged") read a field that never exists, and could never fire.
- **The fix:** it now resolves each inherited item's kind from the item with the same id in the base run's debt-out, read from the fixture.
- **Fails conservatively:** an item fails the check when its kind cannot be resolved exactly. That covers:
  - no unique base run;
  - another origin;
  - an id the base never handed on, or one it handed on twice;
  - a stray kind of its own that disagrees with the base.
- **Notes:** a discharged or obsolete item without a note also fails, as `records.md` requires.
- **Runtime and owner evidence:** a matrix review is static, with no channel for runtime or owner evidence. So, per the sealed SYN-DEBT disposition rule, every discharged `runtime` or `owner-fact` item is an error.

**Tests** (`tests/score.test.mjs`):
- **The regression:** an inherited `owner-fact` item and a `runtime` item, each wrongly discharged, are caught through the base debt-out. A run shaped like D2 passes.
- **Unresolvable kinds:** an unknown id, another origin, a disagreeing kind, and two base runs with one id all fail.
- **The M5-T3 unit test** had given debt-in items a `kind` the records spec does not define, which is the defect itself. It now uses the records shape and expects the conservative failure.

**Re-scoring D2** from its frozen adjudication (ledger `rescored` seq 71, `syn-debt/reports/20261027-050004-incremental-payouts-r2.score.corrected-c.json`). The original score and ledger history stay.

| D2 debt check | Original | Corrected |
|---|---|---|
| Inherited kinds | not read (no field) | 8 of 8 resolved from D1: owner-fact ×2, verification, owner-decision ×3, deferred-scope ×2 |
| Dispositions | 8 of 8 | 8 of 8: 6 carried, 2 discharged (both `deferred-scope`) |
| Runtime or owner-fact discharged | `[]` (vacuous) | `[]`: both `owner-fact` items carried |
| Result | no verdict | **passes** |

- **Scope of the correction:** every item result, finding and precision value is unchanged.
- **Ledger note:** event 71's `changes` list is empty because the runner's change comparison did not yet include the debt section. It does now, with a test; the corrected score file named by that event's sha256 holds the result.

**Separate from debt propagation: D2's X1 and X2 "missed".**
- **Why they show as missed:** the scorer scores each run's own records. An Incremental run that does not re-raise a finding confirmed in its base shows the matching items as missed, though X1 stays confirmed in D1.
- **Status:** this per-run limitation is unchanged and does not gate (X items are reported only). It is unrelated to how debt passes from D1 to D2.

**G5 review debt:** met, now also under the corrected check:
- D1 `incomplete` with complete debt-out;
- D2's debt-in 8 of 8 dispositioned, every kind resolved, no runtime or owner-fact discharge;
- `check` green on both.

**Next batch:** SO1 → SS1 → SO2 on `syn-shelf`, cap $12. The owner approved it, and it ran as batch 4 below.
- **Routing:** the original policy. SO1 and SO2 run on Opus at high effort; SS1 on Sonnet with no effort flag. The dry run passes.
- **No conclusion yet:** none about Sonnet vs Opus is drawn until SS2 has also run.

### Batch 4: SO1, SS1, SO2 on `syn-shelf` (owner-approved, cap $12)
**Setup:** the Sonnet-eligible fixture (Task S, no trigger), with the original routing.
- SO1 and SO2: lead on Opus at high effort.
- SS1: lead on Sonnet with no effort flag (observed `high`).
- Delegates followed `routing.md` in every row: R3 and R6 on Sonnet, R5 on Opus at high effort.

**Common results:**
- every row closed `incomplete` and was adjudicated independently (verdicts frozen before scoring);
- every score is official by fixture version;
- spend: **$8.51** of the $12 cap;
- no retry or recovery; SS2 was not started.

**SO2 is INVALID** (see D below). Its score is recorded but does not count until the owner decides.

| Item | Gating (comparison) | SO1 (Opus) | SS1 (Sonnet) | SO2 (Opus; invalid) |
|---|---|---|---|---|
| E1 | must find | true positive | true positive | true positive |
| E2 | must find | true positive | true positive | true positive |
| E3 | one of four | true positive | true positive | true positive |
| E4 | one of four | true positive | partial (an unverified candidate with 1 of 2 required evidence) | partial (same) |
| EN1 | control | correctly held | correctly held | correctly held |
| EN2 | control | not raised (full) | not raised (full) | not raised (full) |

| Measure | SO1 (Opus) | SS1 (Sonnet) | SO2 (Opus; invalid) |
|---|---|---|---|
| Findings: confirmed / valid / false | 4 / 4 / 0 | 3 / 4 / 0 (one candidate) | 3 / 4 / 0 (one candidate) |
| Precision | 1.00 | 1.00 | 1.00 |
| Pre-registered comparison checks | all met | all met | all met (does not count while invalid) |
| Census recall, automatic / adjudicated | 7/7 / 7/7 | **3/7 / 2/7** | 7/7 / 7/7 |
| Population (`finished` emitters) | exact (2 of 2) | **not exact** (1 of 2 cited) | exact |
| Census items judged correct | 15 / 15 | 7 / 8 | 14 / 14 |
| Obligations agreed | 8 / 8 | 6 / 8 | 7 / 8 |
| Anchors resolving | 39 / 39 | 32 / 32 | 35 / 35 |
| Trace order (entry point before sink) | 4 / 4 | 4 / 4 | 4 / 4 |
| Lead / effort | Opus 5.5 / high | Sonnet 5.5 / high | Opus 5.5 / high |
| Triggers recorded (false escalation) | none (no) | none (no) | none (no) |
| Delegations complete, without recovery | 3 / 3 | 3 / 3 | 3 / 3 |
| Routing violations | 0 | 0 | 0 |
| Guard: executed calls approved / harmless forms blocked | 59 / 2 | 63 / 3 | 61 / 3 |
| Unsafe actions: executed / denied | 0 / 0 | 0 / 0 | 2 / 0 (see D) |
| Cost: review + adjudication | $2.54 + $0.74 = **$3.28** | $1.50 + $0.63 = **$2.13** | $2.43 + $0.67 = **$3.10** |
| Wall clock (review) | 434 s | 387 s | 435 s |
| Lead calls (total / after open / last write / recorded / budget) | 27 / 24 / 22 / 25 / 40 | 30 / 29 / 27 / 29 / 40 | 32 / 31 / 29 / 32 / 40 |

- **Sonnet's census:** the lead recorded fewer census items (8, against 14–15). It missed four mechanisms, among them a second `book.finished` emitter, and one of its items was judged incorrect. Its recipe kinds are free text, not the kinds `census.md` names. The pre-registered comparison rule covers accuracy and false positives only; coverage is reported, not decided by it.
- **No Sonnet-vs-Opus conclusion is drawn.** The rule needs every Sonnet run, and SS2 has not run.

**D. SO2's audit result (open owner decision):**
- **Why it is invalid:** the audit marked SO2 invalid for two `Grep` calls by the lead outside the fixture.
- **What the calls read:** a file in the session's **own** Claude Code project folder (`projects/<its own folder>/<its own session id>/tool-results/…`). Claude Code had saved there the output of the session's own `cat` of the installed skill's reference files, inside its fixture.
- **Other checks:** the session guard approved all three accesses (two `Grep`, one `Read`), and the audit found nothing else.
- **The cause:** the audit's exemption for that folder, deliberately narrow at preflight, covers only the `Read` tool. So the `Read` passed and the `Grep` calls counted.
- **Options:**
  - extend the exemption to the read-only file tools (`Read`, `Grep`, `Glob`) on the session's own `tool-results` folder only, still never shell commands, and re-audit SO2 from its transcripts (no paid session);
  - keep SO2 invalid, and void and rerun it (about $3).

  Until then SO2 does not count.

### Cost accounting after batch 4
- **Counted sessions:** L1 $5.25; I1c $4.50, I1r $6.14, I1d $1.82; L2 $5.22, I2c $4.27, I2r $5.77; I2d $4.23, D1 $4.24, D2 $2.39; SO1 $3.28, SS1 $2.13, SO2 $3.10 (invalid). Total **$52.34**.
- **Voided:** $0.33, plus two killed attempts with tokens only.

### G5 progress after batch 4
| Dimension | Status (official scores) |
|---|---|
| Coverage | **not met:** L2 7/8 adjudicated; populations pending in L1 and L2 |
| Finding accuracy | **met** in L1 and L2 |
| False positives | **not met:** N1 confirmed in L2 (Rule 4 as registered); precision across L1 and L2: 0.90 |
| Indirect invalidation | **met** in 6 of 6 Incremental runs |
| Review debt | **met** (with correction C) |
| Agent completion | 35 of 35 delegations complete without recovery (SO2's 3 included) |
| Routing | 0 violations in 13 rows; no false escalation on `syn-shelf` |
| Cost | spent ≤ budget in 13 of 13 rows |
| Sonnet vs Opus (`syn-shelf`) | **not concluded:** SO1 and SS1 met every comparison check; SO2 is pending decision D; SS2 has not run |

**G5 is not passed.**

### Owner decision D (after batch 4): SO2 stays invalid; the audit is corrected for future runs
**SO2's first attempt stays INVALID.** It was audited under the registered rule, which exempted only a `Read` of the session's own project folder; its two `Grep` calls therefore counted as leakage.
- **Voided:** the attempt is voided (ledger seq 88) so that a fresh attempt can be built. Voiding changes nothing about its evidence:
  - its ledger events seq 82–86 (pre-run through `audited` invalid and scored) stay;
  - its transcripts stay in the Claude Code configuration, and every later session is denied them;
  - its frozen adjudication `syn-shelf/adjudications/20261027-054950-task-shelf.blind.json` stays;
  - so do its score and metrics in `syn-shelf/reports/20261027-054950-task-shelf.*`;
  - its fixture and sandbox folders moved under the matrix root (`voided/SO2-1-*`).
- **Its cost** ($2.43 review + $0.67 adjudication = $3.10) now appears under voided costs.

**Audit rule `own-tool-results-v2`** (`tests/tools/matrix.mjs`; ledger `audit-corrected` seq 87):
- **Exempt:** a `Read`, `Grep` or `Glob` whose path is **exactly** a tool-result file that:
  - was announced ("saved to: …") in that exact session's own transcripts: `projects/<its folder>/<session id>.jsonl` and that session's `subagents/` transcripts, nothing else;
  - lies directly in `<config>/projects/<the session's folder>/<the session id>/tool-results/`;
  - is a regular file, not a link;
  - has a real path that stays in that folder, which itself must not be a link.
- **Not exempt:**
  - any other file in a Claude project folder: other files of the same session (for example its subagent transcripts), unannounced files, another session's files;
  - a lookalike path elsewhere, or a path with wildcards;
  - a folder;
  - any shell command or Git access.
- **Guard:** the session guard is unchanged.
- **Applicability boundary:**
  - **Where:** the rule applies only to audits recorded after seq 87.
  - **Where not:** event seq 87 lists the 13 audits it does not apply to, SO2's (seq 84) among them.
  - **Enforcement:** `verify-ledger` now checks that every audit after a correction names the new rule, and that none before it does.
  - **Run-time recording:** each new `audited` and `adjudication-frozen` event records `audit_rule`.
- **For information only, not applied:** under v2, SO2's three accesses would all be exempt; the one verified file is the saved output of its own `cat` of the installed skill's reference files.

**Regression tests** (`tests/matrix.test.mjs`):
- **Verified:** only files the session itself announced, in its own `tool-results` folder.
- **Refused:**
  - a transcript that is not the session's own;
  - another session's files;
  - a `..` path;
  - missing files;
  - a linked `tool-results` folder (a directory junction, exercised on this machine).
- **Classification:** `Read`, `Grep` and `Glob` of a verified file are exempt. Shell access, unannounced files, subagent transcripts, another session, a `<tmp>` lookalike, a wildcard and a folder all count. Git writes always count.
- **The ledger boundary check.**
- **Unverified on this machine:** a file symbolic link inside `tool-results`, because this Windows account may not create file links (EPERM). The code refuses links through `lstat` and the real-path check; that case is skipped there, not passed.

**Next batch:** a fresh SO2 attempt, then SS2, cap $8. The owner approved it, and it ran as batch 5 below.
- **Unchanged:** the same registered fixture build, sealed answers (`4fb29989…`), review command, operator note and scoring criteria.
- **Dry run:** passes.
- **Comparison:** after both valid runs, Opus (SO1 + the new SO2) is compared with Sonnet (SS1 + SS2) on must-find recall, verified versus partial findings, census coverage, population exactness, false positives, evidence quality and transcript cost.
- **Unchanged G5 status:** G5 stays not passed. The false-positive (L2 N1) and coverage (L2 7/8, populations pending) failures stand whatever the comparison shows.

### Cost accounting after decision D
- **Counted:** $49.24 (SO2's first attempt moved to voided).
- **Voided:** $3.43: L1 attempt $0.33, SO2 attempt 1 $3.10, plus the L2 and D1 attempts with tokens only.

### Batch 5: SO2 (fresh attempt) and SS2 (owner-approved, cap $8)
**Spend:** $5.01 of the $8 cap: SO2 $3.31, SS2 $1.70. No other row ran, and M6 was not started.

**SO2, attempt 2** (run `20261027-064911-task-shelf`, Opus at high effort):
- **Validity:**
  - valid under audit rule `own-tool-results-v2`; it needed no exemption, and 0 unsafe actions were executed or attempted;
  - every one of its 64 executed calls was approved by the guard;
  - it was adjudicated independently, and the score is official.
- **Scored under the registered rules:**
  - E1 and E2: true positives.
  - E3: **partial**. The finding has the correct mechanism and full evidence but stayed an unverified candidate.
  - E4: **unsupported confirmation**, counted as false. The finding is correct (the adjudicator agrees), but it cites the documentation section by heading (`docs/shelf.md#Reading progress`), not the documented line. By the M5-T3 clarification, a heading supports only a `rule` line, while E4's doc claim is its `site`. Required evidence is 1 of 2.
  - EN1 and EN2: correct.
- **Precision** 0.67 (2 of 3 confirmed findings). Census recall 7/7 adjudicated. Population **1 of 2** (not exact).
- **The pre-registered comparison checks are not met:** 2 of the four items at full credit (3 needed), and precision below 0.80.

**SS2** (Sonnet): **did not complete.**
- **What happened:** Claude Code stopped the session at its spending cap ($1.69; it spent $1.70) after 478 s.
- **State:** the run (`20261027-065813-task-shelf`) is still `open`, so it was not audited, adjudicated or scored.
- **Why the cap was too small:** a review session gets the batch's remainder minus a fixed $3 adjudication reserve. After SO2, that left $1.69, less than SS1's review needed ($1.50 + margin). On this fixture the actual adjudication cost is about $0.65.
- **Status:** it is a failed attempt, not a review result. It stays recorded (ledger seq 94–95) and is not counted as a row.

### Sonnet vs Opus on `syn-shelf`: not concluded
The pre-registered rule needs **every** Sonnet run, and SS2 has no valid run. The owner asked that no conclusion be drawn until SS2 completes. The data so far, as scored:

| Measure | SO1 (Opus) | SO2 (Opus, attempt 2) | SS1 (Sonnet) | SS2 (Sonnet) |
|---|---|---|---|---|
| Must-find E1, E2 | 2 / 2 | 2 / 2 | 2 / 2 | no valid run |
| Items at full credit (E1–E4) | 4 | 2 | 3 | – |
| Findings: confirmed (fully verified) / unverified candidates | 4 / 0 | 3 / 1 | 3 / 1 | – |
| Partial or unsupported items | none | E3 partial, E4 unsupported | E4 partial | – |
| Controls EN1, EN2 | correct | correct | correct | – |
| False positives (incl. unsupported confirmations) / precision | 0 / 1.00 | 1 / 0.67 | 0 / 1.00 | – |
| Census recall (adjudicated) | 7/7 | 7/7 | **2/7** | – |
| Population exact | yes (2/2) | **no** (1/2) | **no** (1/2) | – |
| Anchors resolving / trace order | 39/39, 4/4 | 34/34, 4/4 | 32/32, 4/4 | – |
| Required evidence (E1–E4) | 2/2, 3/3, 2/2, 2/2 | 2/2, 3/3, 2/2, 1/2 | 2/2, 3/3, 2/2, 1/2 | – |
| Comparison checks met | yes | **no** | yes | – |
| Cost: review + adjudication | $2.54 + $0.74 | $2.64 + $0.67 | $1.50 + $0.63 | $1.70 (incomplete) |
| Lead calls per obligation | 3.00 | 4.14 | 3.63 | – |
| Tokens per obligation | 299,797 | 272,605 | 274,095 | – |

- **Opus is not uniformly better.** SO1 was the strongest run and met every check; SO2, on the same fixture, did not.
- **Sonnet's census coverage was much weaker in its one run** (2/7 against 7/7). The comparison rule does not decide on coverage, but it is reported.
- **Sonnet cost less:** $1.50 against a median $2.59 per Opus review on this fixture.

### Full G5 assessment (official scores, after every approved correction)
| G5 criterion (delivery roadmap §4) | Result | Status |
|---|---|---|
| **Coverage:** census recall 100% (or `unknown`); populations exact | L1 8/8; **L2 7/8** (one census item judged incorrect by the adjudicator). Populations **pending** in L1 and L2 (disputed citing obligations) | **not met** |
| **Finding accuracy:** P1 and P2 in every run; ≥ 3 of 4 | L1 4/4, L2 4/4 | met |
| **False positives:** N1, N2 never confirmed; ≤ 1 other false per run; precision ≥ 80% | **N1 confirmed in L2** under Rule 4 as registered (a diagnostic Rule 4 v2 clears it, but is not official). Other false: 0 per run. Precision across L1 and L2: 0.90 | **not met** |
| **Indirect invalidation** | 6 of 6 Incremental runs met | met |
| **Review debt** | D1 incomplete with complete debt-out; D2's debt-in 8/8 dispositioned, kinds resolved; `check` green | met |
| **Agent completion:** ≥ 90% without recovery; 100% within ≤ 1 | 35 of 35 delegations in the 13 valid rows complete without recovery | met |
| **Routing:** 0 violations | 0 in 13 valid rows; no false escalation on `syn-shelf`; a Sonnet lead refused (C15) on every triggered row. SS2 was not audited | met (13 rows) |
| **Cost:** spent ≤ budget in ≥ 90% of runs; medians per lead model | 13 of 13 within budget. Medians, Opus (12 rows): 261,111 tokens and 3.26 lead calls per obligation, $3.40 per review. Sonnet (1 row): 274,095 tokens, 3.63 calls, $1.50. **Budget recalibration (V-COST) not done** | spent ≤ budget met; calibration pending |
| **Sonnet vs Opus lead** | SS2 incomplete; no conclusion | **not evaluable** |

**G5 is NOT passed.** Two criteria fail, and one cannot be evaluated:
- **False positives:** the L2 control hit, under the registered Rule 4.
- **Coverage:** L2's disputed census item, and population exactness pending in L1 and L2.
- **Sonnet vs Opus:** not evaluable until SS2 completes.

### Cost accounting at the end of batch 5
- **Valid counted rows (13):** $52.55.
- **Failed attempt (SS2):** $1.70.
- **Voided:** $3.43 (L1 attempt, SO2 attempt 1, plus the L2 and D1 attempts with tokens only).
- **All matrix sessions:** $57.68. Permission probes outside the matrix: $1.85.

### What remains open (owner decisions; M5-T4 is not complete)
1. **SS2:** void the failed attempt and rerun it with enough budget. With the $3 reserve, a cap of at least $6 leaves the review $3 (SS1 used $1.50). Or lower the reserve for `syn-shelf`.
2. **False-positive criterion:** L2's official N1 hit stands under Rule 4 v1. Only a new pre-registered repeat (for example under Rule 4 v2) could change the G5 picture, never a re-score of L2.
3. **Coverage criterion:** L2's census item judged incorrect, and the population disputes in L1 and L2, are independent verdicts. They are not reversed by re-scoring. A decision is needed on how pending population exactness is resolved, for example a second independent adjudication, or a G5 repeat.
4. **Cost calibration (V-COST):** the budget table is recalibrated from these medians only after the owner decides it.

**Next roadmap task:** still **M5-T4** (G5 not passed). M6 is not started.

### Owner decisions after batch 5, and the SS2 preparation
**Decisions:**
1. The official results of L1, L2, SO1 and SO2 (attempt 2) stand, with their scoring criteria unchanged.
2. L2's Rule 4 false positive stays official; Rule 4 v2 stays diagnostic only.
3. Disputed population exactness stays pending, and no frozen adjudication is overwritten.
4. A fresh SS2 attempt is prepared, with its review and adjudication capped at $6 in total.

**The failed SS2 attempt is voided** (ledger seq 96) and preserved:
- its ledger events seq 94–95, with `error_max_budget_usd` and the run still `open`;
- its transcript in the Claude Code configuration, denied to every later session;
- its recorded cost: **$1.70**, in the voided event and the cost report;
- its fixture, moved to `voided/SS2-1-fixture`.

**Verified before execution (no paid session):**
- **Review allowance:** with `--max-budget 6`, the review session's cap is exactly **$3.00**, passed to Claude Code as `--max-budget-usd 3.00`.
  - Each drive starts its own spend at zero, so the failed attempt's $1.70 is not charged again.
  - Nothing is charged before the review.
  - The adjudicator then gets the remainder: $4.50 after a $1.50 review, $3.60 after $2.40, about $2.99 if the review overshoots to $3.01. Regression test in `tests/matrix.test.mjs`.
- **Is $3 enough?** An estimate, not a guarantee. On this fixture, reviews have cost:
  - Sonnet: SS1 $1.50, closed;
  - Sonnet: the failed SS2 attempt, at least $1.70, still open after 35 of 40 lead calls;
  - Opus: $2.43–2.64.

  Claude Code may overshoot a cap by about a cent.
- **Ledger:** `verify-ledger` is ok (96 events), and the registered answers are unchanged.
- **Version gate and isolation:** Claude Code is 2.1.311, equal to the `isolation-verified` record, and the audit rule is `own-tool-results-v2`.
- **Fixture integrity:** a fresh `syn-shelf` build has the sealed heads (`be0a9de2…`). Its tree and installed-skill digests equal the pre-run records of every earlier `syn-shelf` row: SO1, SS1, both SO2 attempts and the failed SS2.
- **Unchanged:** fixture, prompts, operator note, answers, thresholds and model routing.
- **Dry run:** `drive SS2 --max-budget 6` passes: plan registered, isolation ok, SS2 in registered order after SO2.

**Next:** SS2 alone, cap $6. Not run: the owner closed M5-T4 instead (below).

### M5-T4 closed: G5 = FAIL (owner decision, 2026-10-27)
The owner closed M5-T4 **without running SS2**. The proposed $6 was not spent. The closing record is ledger event `evaluation-closed`, seq 97; `verify-ledger` is ok at 97 events.
- **SS2:** recorded as **not completed**. Its only attempt stopped at its spending cap and is voided and preserved (seq 94–96).
- **Sonnet vs Opus:** **inconclusive**. The pre-registered rule needs every Sonnet run, so it cannot be decided. Model routing is unchanged.
- **G5 = FAIL** under the registered criteria:
  - **false positives:** N1 confirmed in L2 under Rule 4 as registered;
  - **coverage:** L2 adjudicated census recall 7/8, and population exactness pending in L1 and L2;
  - **not evaluable:** Sonnet vs Opus.
  - Met: finding accuracy, indirect invalidation (6/6), review debt, agent completion (35/35), routing (0 violations), and spent ≤ budget (13/13).
- **Not changed to reach this outcome:** any score, verdict, answer, fixture or threshold. Corrections 1, 2, B and C are owner-approved scorer fixes, recorded with the original scores kept. Rule 4 v2 is diagnostic only.
- **M6 is not started.**

**M5-T4 costs** (client-computed list price, from the transcripts):

| Category | Cost |
|---|---|
| 13 valid matrix rows (review + independent adjudication) | $52.55 |
| Failed attempt (SS2, stopped at its cap) | $1.70 |
| Voided attempts (L1 $0.33, SO2 attempt 1 $3.10; L2 and D1 killed before a cost was recorded: 790,303 and 251,576 tokens) | $3.43 |
| **All matrix sessions** | **$57.68** |
| Permission and fail-closed probes (outside the matrix) | $1.85 |

**Calibration** (observed; recommendations, not applied):
- **Adjudication sessions** cost $0.63–1.38 (median $0.85, 13 rows); on `syn-shelf`, $0.63–0.74.
- **The runner's fixed $3 reserve** starved SS2's review. A reserve of about 2 × the largest observed adjudication ($2.76), or a per-fixture reserve such as 2 × that fixture's largest ($1.48 on `syn-shelf`), would have left room for it.
- **Review sessions** cost $1.16–4.78 (Opus median $3.40 over 12 rows; Sonnet $1.50 over 1 row).
- **Budget recalibration (V-COST)** of the review budget table from these medians was not done; it needs an owner decision.

### Beta readiness (manual, opted-in Task and Incremental Review)
**Verified without a paid session and without installing into a real project:**
- **Enable, Update and Disable:** the M4-T3 rehearsal (`tests/m4/rehearse.mjs`) reran on disposable projects: 75 rows: 72 pass, 0 fail, 3 unverified, identical to M4-T3 (the unverified rows are symbolic links, Unicode-normalization collisions and macOS). It covers clean and repeated runs, interruption at every write, modified, deleted and unrecorded files, tracked targets, junctions, refused locations and a shadowing personal skill.
- **Steps 2–4** (a fresh session, `/nth-review`, the report) ran 15 times in M5-T4 in disposable fixtures installed by the same Enable transcription (`tests/m4/operator.mjs`). That is 14 matrix rows plus the failed SS2, all in headless sessions.
- **Read-only status:** `nthr.mjs status` on a finished fixture listed the runs and the outstanding debt by kind, and wrote nothing.
- **Official audits:** `OFFICIAL_AUDITS_ENABLED` is `false` in `review/scripts/nthr.mjs`.
- **Installed library (read-only hash comparison):**
  - 23 of the 25 runtime files match the checkout. `reference/census.md` and `reference/prompts.md` do not: they predate the M5-T4 census fix.
  - `review.md` matches.
  - The library receipt and the managed `reviewer` agent are present, and no personal `nth-review` skill would shadow a project copy.
  - **A Global Update is therefore needed before the first Enable.** It was not run here (no global installation in this task).

**The Beta workflow and known limitations** are documented in `agents/claude/integrations/review.md` → "Beta use", linked from `README.md` and `agents/claude/README.md`.

**Not verified:** a real project (deliberately not installed), interactive sessions, macOS and POSIX, Node.js 20, file symbolic links.

### G5 progress (after L1 only)
- **Met on one run:**
  - finding accuracy;
  - false positives (controls not confirmed, no other false confirmed);
  - census recall;
  - routing;
  - agent completion.
- **Pending:** population exactness (the OB-9 dispute).
- **Not yet run:**
  - the L2 repeat;
  - the six Incremental rows;
  - the DEBT chain;
  - the syn-shelf Sonnet-vs-Opus comparison;
  - the cost calibration across runs.

**G5 is not passed.**

### Tests
- **Full suite:** 372 tests: 367 pass, 0 fail, 5 skipped, identical in Git Bash and PowerShell (at closing). The 5 skipped are platform cases.
- **New tests:**
  - `session-guard.test.mjs`;
  - `matrix.test.mjs`: plan, ledger, isolation, fail-closed permissions, spending cap and batch order;
  - blind-adjudication tests in `score.test.mjs`;
  - `syn-shelf` in `fixtures.test.mjs`.

## First real Beta run and fixes (2026-10-27)

**The run.** The owner ran the first real Beta Task Review, in private project B (namespace `reviews/rp-beta`, run `20261027-105341-task-first-review`), on a committed range of 69 files and 57,362 lines, with an Opus lead.
- **Time:** open to close 13.9 minutes. The whole session took about 40 minutes, including Enable in the same session and about 15 minutes away.
- **Cost:** $6.79, observed by the owner. The transcript holds no cost records, so the cost per phase cannot be recovered.
- **Outcome:** 19 obligations (15 held, 1 violated, 3 open) and 35 census items. F1 (doc-drift, low) and F2 (defect, medium) were confirmed; F3 is a risk candidate. 8 debt items. Closed `incomplete`, reason `open-obligations`.

**Evidence and root causes** (from `records.json`, `report.md`, the packs and the session transcript):
- **Size.** 42 of the 69 files (55,010 lines) were experiment data under one docs directory; the lead excluded them as group census items. Without them the change is still L: source 14 files / 1,255 lines, tests 6 / 862, other docs 7 / 235. The helper already sizes a range as its net diff (`git diff --numstat <a> <b>`), so the size class was right.
- **The change read commit by commit.** During planning the lead ran `git log --stat` over the range (22.8 KB of output) instead of one net `git diff --stat`. SKILL.md said only "its range diff".
- **References read whole.** The lead read in full `records.md` (68.5 KB), `taxonomy.md` (41 KB), `protocol.md` (27.7 KB), `prompts.md` (12.6 KB), and `census.md` with `routing.md` (23.8 KB): about 174 KB. SKILL.md said "Read a section when a step names it", which did not rule out whole reads.
  - The lead context was about 220k tokens per turn, rising to about 300k.
  - Review phase: 72k output tokens, 206k cache write and 7.2M cache read over about 27 messages.
- **Enable in the same session.** Enable's context (17k output, 85k cache write, 1.46M cache read) was carried into every review turn.
- **Missing arguments.** `/nth-review` ran first with no arguments, then with a literal `<base>` placeholder. The lead improvised a question; SKILL.md said only "Stop on anything else".
- **The integration's own files.** The snapshot listed 26 untracked files: the 25 installed skill files and the review state file (the optional exclude was not added). They did not change this range's size. In a working-tree or Incremental run, though:
  - each counts as a changed file (Incremental: 2 more lead tool calls per file, up to the 80 cap);
  - `fresh` lists each as changed;
  - a base snapshot holding them is base-dirty and not reconstructible.
- **The "Wall clock" label.** The report's 13.9 minutes read as session time; the session took about 40.
- **Records written by scratch scripts.** The lead wrote `records.json` through its own Node scripts. Noted, not changed (see Deferred).
- **Delegate overlap.** R3 read 30 files, 22 of them also read by the lead; R6 read 13, 12 overlapping. This is by design (independent coverage criticism and refutation), so it is not changed.

**Owner decision (2026-10-27, approved): supersedes the helper clause of M4 owner decision 4.** Made on the owner's explicit request to inspect and fix the contamination, and approved by the owner before release: the integration's own managed runtime files are left out of ordinary untracked and Incremental scopes. This is the current decision; M4 owner decision 4 above stays as the historical record.
- The helper now leaves out, like `.nth-review/`, the integration's untracked installed files in the root repository: exactly `.claude/skills/nth-review/**` and `.claude/nth-dev-kit-hooks/review.state.json`, in exact case.
- Tracked copies, other `.claude/` files and nested repositories still count.
- The optional local exclude and D6 (the kit never edits exclude files) stand. The M4 record above is not edited.

**Changes:**
- **`scripts/lib/fsguard.mjs`:** `INTEGRATION_SKILL_DIR`, `INTEGRATION_STATE_FILE` and `isIntegrationPath`.
- **`scripts/lib/snapshot.mjs`:** the untracked population leaves those files out, so they no longer affect `untracked`, `reconstructible`, a working-tree size or an Incremental size. `untracked_key` is now `untracked-key@2`. A key from @1 compares as changed, so a run open across the change reassesses once at close. No stored snapshot is rewritten: a base that counted these files stays base-dirty.
- **`scripts/lib/fresh.mjs`:** `changed_files` leaves them out.
- **`scripts/lib/render.mjs`:** the cost row is "Open to close (minutes)", with a note that session time outside it and money cost are not measured.
- **`SKILL.md`** (body 118 of 120 lines):
  - read every reference by section, never a whole file;
  - read the change as one net diff, never `git log -p` or `git log --stat`;
  - missing or placeholder arguments: run no helper command, show `git log --oneline -15` and ask once;
  - recommend a fresh session once when the session already did other work, such as Enable;
  - the final message calls the minutes open to close.
- **`reference/protocol.md`, `reference/records.md` and `agents/claude/integrations/review.md`:** the same rules, where each owns them.

**Deferred (each needs an owner decision):**
- **An `--exclude` scope for generated or data files.** It needs a records@1 field, `check` and render support, inheritance through `fresh` and continuation, and an R3 challenge. This run gives no evidence that it changes a budget (the change stays L without the data), and it could be misused to reach S and a Sonnet lead. A size-composition field is not added without it.
- **A records-writing helper (`put`).** See release check 5 below for the exact design gap.
- **Action or flow review** (a review of one behaviour rather than a diff). It needs:
  - a selection contract: a records `scope` field, a mode or run-id change, and a `check` that validates the target;
  - a budget row for a scope that is not a diff (budget calibration, V-COST, is an owner decision);
  - a census population based on reachability.
- **Project-wide review.** That is Full Audit, which stays disabled.
- **A dependency-graph command.** The relationships already exist in the records (`affects`, `intent`, `links`, assumptions, `trace` and debt `refs`); `pack` and `fresh` use them.
- **Quick, Standard or Deep labels.** Not introduced.

**Unchanged:**
- G5 = FAIL.
- Full Audit is disabled (`OFFICIAL_AUDITS_ENABLED` is `false`).
- No benchmark artifact, answer, scoring rule or adjudication was changed.
- No paid run was made.

**Expected impact (estimated from the evidence above, not measured):**
- reading by section and one net diff should remove most of the 174 KB of whole-reference reads and the 22.8 KB commit listing from the lead's context;
- a fresh session should drop Enable's context from every review turn;
- working-tree and Incremental runs in a project without the exclude no longer grow their size or budget by the integration's own files.

**Not verified:**
- a second real run with these fixes;
- POSIX and macOS (Windows only);
- the installed library, which still holds the earlier files: no Global Update was run.

### Release checks (owner request, 2026-10-27)
**1. The untracked-key@1 → @2 transition.** No false-clean freshness or falsely verified inherited conclusion was found.
- A key difference is untracked `changed` → `reassess`, never `abandon` (`compareSnapshots`). A run opened under @1 needs `--reassessed` at close; `resume` may abandon it as `cited-untracked` when it cites an untracked root file. Both are conservative, one-time effects.
- An @1 base that counted these files stays `base-dirty`.
- Obligation classes in `fresh` come from the cited files' identities (footprint blob then, identity now), and that lookup never filters these paths: a changed cited file is `touched` or `file-changed`, never `current`.
- **One gap was found and closed.** Inside one run, an edit to an untracked integration file between the evidence and close no longer changes `untracked_key`, so close would not ask for a reassessment, and a later `fresh` would compare against the close-time blob. `footprint` and `close` now refuse a run that cites an untracked copy of these files (exit 1), so no conclusion can rest on one. Tracked copies, absent paths, look-alike paths and other repositories' copies can still be cited.

**2. Receipt-based modification detection.** Unaffected. Update and Disable compare each installed file's exact bytes with its sha256 in the state file, independent of Git and of the helper's snapshot. The M4-T3 rehearsal (`tests/m4/rehearse.mjs`) reran on disposable projects: 75 rows: 72 pass, 0 fail, 3 unverified, identical to M4-T3. Its modified, deleted, unrecorded and line-ending-only rows all pass.

**3. Excluded tooling is never claimed as reviewed coverage.**
- the `footprint`/`close` refusal above covers every cited anchor: intent, evidence, dependency assumptions, finding traces and counterevidence;
- census items are never footprinted, and these files are no longer changed files, so they never enter the census;
- every `report.md` states that no snapshot covers `.nth-review/` or the untracked copies, and that those copies are not reviewed and cannot be cited (a static note: the exclusion depends on the helper version, not on the run, so no records@1 field was added).

**4. Beta documentation.** `review.md` "Beta use" no longer says no real codebase was reviewed: it names this one owner-run review, says one run is not a quality measurement, adds its cost (the whole session, Enable included) and limits the unverified list accordingly.

**5. A records-writing helper: not implemented; the design gap is the input channel.**
- stdin or argument JSON goes back through the shell quoting that failed in this run;
- a file input is a second lead-writable file: the guardrail allows only `records.json`, and `check` refuses any other file in a run directory (`checkDirectory`), so it needs a new write contract (where the file lives, who removes it);
- field-level protection does not exist yet: `check` verifies `run.id` and `run.namespace` against the directory, and a snapshot edit surfaces only at close, but `budget` limits are never re-verified. A helper that writes sections would have to define that boundary.

  Owner question, if a helper is still wanted: accept a stdin channel or a new run-local input file, plus a `check`-enforced boundary for the helper-owned fields? Meanwhile SKILL.md now says to edit `records.json` in place with the Edit tool, one section at a time, never with a script, `node -e` or shell redirection. The Edit tool passes no shell, so no generator script is needed.

**Gaps that predate this change (not fixed):**
- a cited file under `.nth-review/`, tracked or not, is outside every snapshot, so the same in-run gap applies to it (citing it stays allowed: an existing test depends on it);
- a cited gitignored file has footprint state `untracked` but is outside `untracked_key`, with the same gap;
- `check` never re-verifies the `budget` limits that `new-run` wrote.

### Tests
- **Full suite:** 378 tests: 373 pass, 0 fail, 5 skipped, identical in Git Bash and PowerShell. The 5 skipped are platform cases (symbolic links and the executable bit on Windows).
- **New tests** (disposable repositories):
  - `snapshot.test.mjs`: the files are left out of `untracked` and `reconstructible`; other `.claude/` files, a look-alike directory and a nested repository still count, as does a repository cloned at the skill's path; a tracked copy is tracked state; an @1 key gives `reassess`, never `abandon`;
  - `new-run.test.mjs`: a working-tree Task with only these files is S with 0 files, and the Incremental budget stays 20;
  - `fresh.test.mjs`: they are not in `changed_files` and do not make the base dirty, while the same path in a nested repository is listed;
  - `footprint.test.mjs`: citing an untracked copy (one of them ignored by the optional exclude) makes `footprint` and `close` exit 1 with nothing written; a tracked copy, a look-alike path, an absent path and a nested repository's copy can be cited;
  - `close.test.mjs`: the "Open to close (minutes)" row and its note, and the coverage note.
- **Negative control:** with `isIntegrationPath` disabled, the three new helper tests fail; without its directory-entry guard, the cloned-repository test fails; without the footprint refusal, the citation test fails. Restored, they pass.
- **Independent review:** no high or medium findings. Two low ones were fixed: a repository cloned at the skill's path was left out (now counted), and SKILL.md and protocol.md now point the lead at the untracked files in the snapshot, which leave these files out.

## Beta v2 postmortem: the same range reviewed again (2026-10-27)
The owner ran a second Task Review in private project B (namespace `reviews/rp-beta-v2`, run `20261027-131215-task-comparison`) on the same range (`7270e4b..HEAD`, same HEAD `6470ec2252`), with the Beta fixes installed by a project Update in the same session. Sources: both runs' records and reports, both session transcripts and their subagent logs. No review or benchmark was run for this analysis.

| Measure | v1 | v2 |
|---|---|---|
| Session span | 40.1 min (Enable in the same session) | 47.8 min (Update in the same session) |
| Open to close | 13.9 min | 38.7 min, of which 26.5 min waited on an effort question asked after Open; 12.2 min active |
| Session cost | $6.87 (`cost-state`: Opus $6.25, Sonnet $0.62) | $5.54 (status-line cache after the final reply; no `cost-state` record) |
| Lead review tokens: output / cache write / cache read | 73.7k / 218k / 7.71M | 62.7k / 154k / 6.86M |
| Setup context carried into each review turn | ~67k (31 turns: ~2.1M cache read) | ~52k (36 turns: ~1.9M cache read) |
| Reference reads | 5 calls, ~170 KB (whole files) | 7 calls, ≤ 58 KB (sections; 2 calls mixed with other output) |
| Change listing | `git log --stat` over the range (22.4 KB) | net diffs only |
| Lead tool calls, observed (recorded) | 30 (30) | 59 (66) |
| records.json writes | 9 calls (scratch scripts, one failed `node -e`), ~200 s generation | 28 Edit calls, ~221 s generation |
| Helper `check`/`pack`/`footprint` calls | 2 | 7 |
| Source paths read / in 2+ steps | 15 / 3 | 28 / 11 |
| R3 / R6 | 19 / 17 tool uses; 86.5k / 39.1k tokens | 16 / 17 tool uses; 73.7k / 44.9k tokens |
| Census items (recipes) | 35 (9) | 36 (5) |
| Obligations held / violated / open | 15 / 1 / 3 | 15 / 3 / 1 |
| Findings | F1 doc-drift low (warnings-api-batch); F2 defect medium (wrapper-sha256); F3 risk candidate | F1 defect low (warnings-api-batch); F2 needs_validation (unsourced page declared) |
| Debt out | 8 | 4 |

**Why lead tool calls rose (30 → 59 observed, 66 recorded).**
- 19 of the 29 extra calls are records.json writes, and 5 more are extra `check` runs.
  - Every verification outcome changes a finding, its obligation, a delegation, debt and `budget.spent`, in different sections. With the Edit tool, each is a separate call, even when they are sent in parallel in one message (14 Edits at close, in 2 messages).
  - v1 did the same work in 9 calls through scratch scripts, outside the guardrail.
- The recorded 66 includes a double count of 7: the lead wrote 59 including the calls it still planned (footprint, check, edits, close), then added them again.

**The v1 wrapper-sha256 defect.** It was in scope: same range and HEAD, and v2 cited `docs/processes.md:187-211` (its wrapper sentence is line 203) and `src/results/provenance.ts:274-286`. v2 did not assess what the wrapper hash covers. v1 traced it into the unchanged caller `src/manual/groups.ts`; v2's census did not include that file, although its R3 read it. This is a reviewer-coverage difference, not a scope change.

**Independence.** Before outlining, the v2 lead printed parts of v1's records (`findings[0]`, which is F1, the whole debt, sample census items and obligations) to learn the record shapes. v2's F1 repeats v1's F1 and is not an independent detection. v1's F2 was not among what it printed.

**Classification:**
- **Confirmed efficiency improvements:**
  - reference reading −66% (sections instead of whole files);
  - no per-commit listing;
  - lead review tokens: output −15%, cache write −29%, cache read −11%;
  - lower context per Plan turn (219k → 150k average).
- **Regressions:**
  - lead tool calls (bookkeeping), leaving 4 calls of headroom as recorded;
  - the effort question asked after Open (26.5 min inside the run interval, with the run open);
  - no fresh-session advice after an Update in the same session (the rule sat inside the missing-arguments step).
- **Different reviewer decisions:**
  - F1 as defect rather than doc-drift (not independent);
  - a new needs_validation F2;
  - no v1 F3, and the wrapper defect not assessed;
  - `groups.ts` not in the census;
  - fewer recipes and less debt;
  - the effort question itself (v1 could see `/effort` in its session).
- **Measured but not attributable:** active open-to-close −12% and session cost $6.87 → $5.54. One run each, different setup phases, and v2 read v1's records.
- **Unmeasurable:** quality or recall (no ground truth, a contaminated second run), and cost per phase (no per-phase cost records).

**Fixed (prompt wording only):**
- `SKILL.md` §1 step 2 asks once, before any helper command, for missing arguments and for the effort when it cannot be told. It never opens a run and then waits.
- The fresh-session advice now applies whatever the arguments.
- `SKILL.md` §2 and `reference/routing.md` point to that step.

**Not fixed (owner decisions):**
- **Bookkeeping counts against the review budget.** Options: count records.json edits apart from `lead_tool_calls`; the deferred records helper (its input channel); or raise the budget (V-COST).
- **The manual count is unreliable.** An observed count would have to come from outside the lead.
- **A Task Review reading earlier runs' records.** Whether to forbid it (Incremental gets them through `fresh` and `pack`) is a product decision.

G5 = FAIL; Full Audit stays disabled. The installed library and the project copy do not yet hold these wording changes (no Global Update or project Update in this task).

## Records writer, Task Review independence and discovery handoff (2026-10-27)
The owner approved three changes from the Beta v2 postmortem (above).

**1. `apply`, the records writer** (`scripts/lib/patch.mjs`, a new runtime file: the integration now installs 26).
- The lead writes `<run_dir>/patch.json` (`nth-review/patch@1`: `base` and `ops` of `set`/`add`/`remove` on `/`-paths, with array items addressed by `id`). `apply --run` applies the batch in memory and writes `records.json` atomically. It then removes the patch and runs `check`, returning the new `records_sha256` and the check result.
- **Stale patches are refused:** `base` must equal the sha256 of `records.json` now. `new-run`, `apply`, `check` (also when it fails), `footprint` and `fresh` print `records_sha256`.
- **Protected fields:**
  - the lead can change only `run.runtime`, `scope.summary` and `scope.intent` (plus `scope.units` in a plan run), the census, obligations, findings, delegations, checks, `debt.out`, `debt.in` dispositions and notes, and `budget.spent` (not `wall_clock_min`);
  - a freshness class may only become `assumption-changed`;
  - a section can be appended to but never replaced or removed whole.
- **Invalid patches are refused:** a result that fails the schema writes nothing, and the patch stays for the lead to fix.
- **Closed runs:** never written. `check` and `close` refuse a closed run with a pending `patch.json` (C18 now allows `patch.json` only while the run is open).
- **Budget:** unchanged. A batch costs two lead calls (writing the patch, then `apply`, which includes the check) instead of one Edit per field plus a `check`.
- SKILL.md now says to write only `patch.json`, never `records.json` directly or through a script.

**2. Task Review independence.**
- A Task Review never opens earlier runs' records, reports or packs (SKILL.md guardrail, protocol §1). An earlier run is read only on an explicit request to compare with it, after the run's own findings are recorded, and `scope.summary` says so.
- Incremental inheritance through `fresh`, `pack`, debt-in and origin runs is unchanged.
- Every delegate prompt now forbids opening anything under `.nth-review/` except the files it is given.
- This is prompt-level, not enforced: the helper cannot see what the lead reads.

**3. Subagent discovery handoff.**
- R3 now also answers `uncensused`: the files it read that bear on a changed behaviour but have no census item.
- A delegation records `discovered`, an optional records@1 field, so older records stay valid.
- In a closed run, `check` requires every discovered path to have a census item (exact or group path) that covers it (`classified`, naming obligations), excludes it (`excluded`, or `affects: null` with a reason), or leaves it `unknown` with `frontier` or `deferred-scope` debt whose `requires` names the path.
- This addresses the v2 gap where R3 read `src/manual/groups.ts` but the census never recorded it. It still depends on the lead copying the answer's paths into `discovered`; the helper never sees the answer.

**Tests:**
- **Full suite:** 382 tests: 377 pass, 0 fail, 5 skipped (platform cases), identical in Git Bash and PowerShell.
- New `tests/patch.test.mjs` (4 tests, disposable repositories):
  - a batched patch applied by id;
  - stale, protected, invalid, duplicate, unknown-path and malformed patches refused with nothing written;
  - closed runs, and close or check refusing a pending patch;
  - each discovery disposition, the missing-debt and no-disposition errors, and a legacy delegation without the field.
- Updated: the inventory count (25 → 26), the allowed helper side effects (`patch.mjs` removes `patch.json`), the guardrail wording, the command list, and the `check` output (`records_sha256`).
- **Negative controls:** without the discovery rule, the staleness check or the protection rule, a `patch.test` test fails; restored, they pass.

**Not done:** no paid run. Neither the installed library nor private project B's copy holds these changes (no Global Update or project Update). G5 = FAIL; Full Audit stays disabled.

## G5 readiness review (2026-10-27)
A review of the three changes above against G5's actual criteria, with no paid run and no change to any score, verdict, answer, fixture or threshold.

**Why G5 is FAIL, exactly.** G5 is not a code check: it is the verdict of the pre-registered M5-T4 matrix (delivery roadmap §4), closed by the owner as **G5 = FAIL** (ledger seq 97). Its failing criteria are verdicts on those recorded runs:
- **False positives:** N1 confirmed in L2 under Rule 4 as registered (Rule 4 v2 is diagnostic only).
- **Coverage:** L2's adjudicated census recall 7/8; population exactness pending in L1 and L2.
- **Not evaluable:** Sonnet vs Opus (SS2 not completed).

No code change re-scores those runs, and none may. G5 can change only through a new pre-registered matrix repeat, an owner decision with its own budget. The discovery handoff targets the kind of miss behind a coverage gap (a file a delegate read but the census never recorded), but whether it raises census recall is measurable only by such a run.

**Full Audit stays disabled.** It requires the release criteria G1–G6 (C19) and an owner charter; G5 is FAIL and M6 (G6) has not started.

**The `apply` workflow:**
- **Atomicity:** sound. One batch is applied in memory and validated against the schema, and `records.json` is replaced through a temporary file, fsync and rename. A refused batch writes nothing.
- **Post-write check failures:** by design, a semantic `check` failure does not undo the write (an open run's records may fail midway); `apply` exits 0 with the failures in its result, and `close` refuses until they are fixed. Now stated in records.md.
- **Stale fingerprint:** sound. `base` is the sha256 of the whole file, so any byte change refuses the patch. Within one process the digest is read and the file replaced without a lock, so the protection is against sequential staleness only (below).
- **Crash between the write and the removal of `patch.json`: one defect, fixed.** The leftover patch was already refused as stale, so it was never applied twice. But the refusal told the lead to "rebuild the patch against the current records", which, followed after an interrupted apply, resends a batch already written. A batch is not idempotent: `checks`, `delegations`, evidence and trace items have no `id`, so they are appended again, and index paths shift. The message now says to read `records.json` first, never to resend a written batch, and to clear the patch with an empty `ops` on the current digest (`scripts/lib/patch.mjs`; records.md "Interrupted apply").
- **Concurrent writers: a limitation, documented, not changed.** `apply`, `fresh`, `footprint`, `close` and `resume --apply` each read, validate and replace `records.json`; none takes a lock (only `decisions.json` is locked). Two of them at once on one run, for example parallel tool calls running `apply` and `close`, may lose one's write. Now stated in records.md and review.md "Known limitations". A lock across the records writers would be a design change.

**Discovery accountability:**
- **Enforced:** every path in a delegation's `discovered` has a census disposition before close (covered, excluded with a reason, or `unknown` with `frontier` or `deferred-scope` debt naming it); `discovered` holds valid repository paths, no globs, at most 200.
- **Not detectable:** a path the lead never copies into `discovered`, or a delegation it removes (`delegations` is lead-writable through `apply`). The helper never sees the delegate's answer, and the lead's census can still cover a path with a broad group item. So the lead can omit a delegate-discovered path without detection.
- **Prompt-only:** that R3 lists its uncensused files, that the lead copies them, and that each disposition is honest.
- **Stronger verification (not built; each needs an owner decision):**
  - **The delegate's answer read by the helper from the session transcript** (Claude Code writes it; the matrix tooling already parses transcripts). `close` could require `discovered` ⊇ the answer's paths. Strongest against omission, but tied to Claude Code's private transcript format and to the local machine.
  - **A handoff file the delegate writes itself**, whose paths `check` requires in `discovered`. It removes the lead's transcription, but it needs a new run-directory write contract (C18 allows only `records.json`, `report.md`, packs and an open run's `patch.json`), and the delegate and the lead can still omit or alter it.
  - **`discovered` required (possibly empty) on R2 and R3 delegations in new runs:** a small, enforceable step that makes an omission an explicit statement rather than a silent default. It needs a version gate, since older records omit the field.

**Independence:**
- **Task Review:** the helper refuses the record channels. A Task run gets no `freshness` (`check`: "written only in incremental runs"), and debt-in only from an explicit `--base` or `--continues` (C4); the skill's Task form names neither, and `resume` uses `--continues` for the same review. The prohibition on reading earlier runs' records, reports or packs is prompt-level: what the lead or a delegate reads is not observable. Now stated in protocol.md and review.md.
- **A Task run opened with `--base`** inherits that run's debt-out, as records.md documents for every mode. Refusing `--base` for Task runs would be a product change; not made.
- **Incremental Review:** inheritance through `fresh`, `pack`, debt-in and origin runs is unchanged; its tests pass.

**Tests:**
- **Full suite:** 383 tests: 378 pass, 0 fail, 5 skipped (platform cases), identical in Git Bash and PowerShell.
- **New** in `tests/patch.test.mjs`: an apply interrupted after its write. The leftover patch is refused as stale with the new guidance, nothing is written, the batch is in once, and an empty batch clears it with the records unchanged.
- **Negative control:** with the old message, the new test fails; restored, it passes.

**Not done:** no paid run; no Global Update, and the installed library and private project B's copy are not touched. G5 = FAIL; Full Audit stays disabled.

## Beta v3 operational validation (2026-10-27)
The owner ran a third Task Review in private project B (namespace `reviews/rp-beta-v2`, run `20261027-163515-task-comparison`). It used the same range (`7270e4b..HEAD`) and the same HEAD, with the records writer, the independence rule and the discovery handoff installed (above). It ran in a fresh session. Sources: the run's records and report, the session transcript and its three subagent logs. No review or benchmark was run for this record.

**The three Beta improvements were observed working in this run.** One run shows the mechanisms operate as designed; it does not prove better review accuracy or shorter active time.

| Measure | v1 | v2 | v3 |
|---|---|---|---|
| Session | 40.1 min, with Enable in the same session | 47.8 min, with Update in the same session | 29.9 min, fresh session; 13.9 min of it waiting for the effort answer, **before** the run opened |
| Open to close | 13.9 min | 38.7 min (26.5 waiting, 12.2 active) | 13.1 min |
| Session cost | $6.87 (`cost-state`) | $5.54 (status-line cache) | $5.12 (status-line cache, right after the final reply) |
| Lead tokens while the run was open: output / cache write / cache read | 73.7k / 218k / 7.71M | 62.7k / 154k / 6.86M | 65.1k / 174k / 5.56M |
| Lead tool calls, from `new-run` to `close`: made (recorded) | 30 (30) | 59 (66) | 37 (34) |
| Calls spent only on writing `records.json` | 9 (scratch scripts) | ~31 (28 Edits, 3 `check`-only) | ~7 (5 patch writes, 2 `apply` calls on their own) |

**1. Records writer (`apply`): observed working.**
- v3 made 0 direct edits to `records.json`. It wrote 5 patches (181 ops: 53, 22, 77, 25 and 4), and every `apply` succeeded on the first try, with no stale or protected-field refusals. It needed no `check`-only call, because each `apply` ran the check.
- Three of the five `apply` calls shared a shell call with `pack`, `footprint` or `close`, which were needed anyway.
- Calls spent only on writing records fell from about 31 (v2) to about 7, and their generation time from about 221 s to about 171 s. This is a direct count, not an estimate.

**2. Discovery handoff: observed working.** R3's answer named 22 paths (additions, contradictions and the new `uncensused` list). The 8 that already had a census item were correctly left out of `discovered`; the 14 others all had a disposition:
- 8 covered by an item naming obligations, including `src/manual/groups.ts`, the file v2's census missed;
- 1 excluded with a reason;
- 5 classified with `affects: null` and a reason citing recipe C7 (the file does not read the new fields);
- 0 left unresolved, so no discovery debt was needed.

**3. Task Review independence: observed working.**
- No lead or subagent call opened an earlier run's records, reports or packs, and no search reached one.
- The project's auto-memory was empty, and the session began with `/nth-review`.
- The wrapper-hash root cause (v1's F2, missed by v2) was found again from this run's own evidence:
  - R3 named the wrapper-group chain;
  - that became F-2, which R6 rejected with a correction (the hash covers the step's shared `prompt.md`);
  - the lead checked the source and recorded F-4, as doc-drift (low; v1 called it a medium defect).

**Recorded vs actual lead tool calls.** The run recorded 34; the lead made 36 calls after `new-run` (37 counting it). The 2 not counted are the last patch write and the final `apply` + `close` call, made after the count was written. This is a structural undercount of 2: a recorded count cannot include the calls that write it. v2 overcounted by 7, counting planned calls twice. The 2 calls before Open (`git log` and the effort question) are correctly outside the budget. The count is still the lead's own report, not an observed one.

**Remaining uncertainty and measurement limits:**
- Each version is one run. The reviewer's decisions differed between runs (findings, recipes, debt), so differences in tokens, cost and time cannot be attributed to the improvements. Only the call counts for writing records are a direct effect.
- Session cost comes from different sources: v1 a `cost-state` record, v2 and v3 the status-line cache, with no `cost-state` in their transcripts. Cost per phase is not recorded for any run.
- The active times are not comparable:
  - v3's 13.1 min open to close, against v1's 13.9 and v2's 12.2 active minutes, is one sample each;
  - v1 and v2 also carried Enable or Update context into the review.
- Accuracy and recall stay unmeasured: there is no ground truth for this range, and the earlier runs saw related material. F-4 shows one independent detection, not recall.
- The discovery handoff relies on the lead copying the answer's paths into `discovered`; this run did so completely, which one run does not guarantee.

G5 = FAIL. Full Audit stays disabled (`OFFICIAL_AUDITS_ENABLED` is `false`).

## M5-T4R readiness: isolation, evidence, freeze and measurement (2026-10-28)
This section prepares the runner for the pre-registered G5 repeat (`tests/G5-REPEAT-PLAN.md`, §6 blockers B1–B4 and gaps M1–M2). It made no paid call and no Git write. It changed no historical score, verdict, adjudication, answer or ledger event; the M5-T4 ledger is byte-identical (sha256 `7aa36b16…8f18`, `verify-ledger` ok at 97 events). G5 = FAIL; Full Audit stays disabled.

**B1, historical review isolation: fixed.**
- **The defect:** `denyRootsFor` left a session's own row code out of the deny rules entirely.
  - The temporary folder still holds M5-T4's 13 fixtures (`wa-`…`wm-`, each with its `.nth-review/` records) and 13 adjudication sandboxes (`ra-`…`rm-`). The matrix configuration still holds their transcripts.
  - So a new L1 reviewer was not denied the historical L1 records or transcripts, and a new L1 adjudicator not the historical L1 sandbox.
  - The session guard was the only barrier. It is exact: the realpath of its own folder and its own session folder, so it held. M5-T4 had registered two layers.
- **The fix:** every folder that exists under the session's own code is denied by its exact path, in the temporary folder, the configuration's `projects/` and `<tmp>/claude/`, except the session's own (`denyRootsFor(…, { ownDir })`, required).
  - Distinct codes for the repeat were planned instead. They would have doubled the deny list past the Windows command-line limit.
  - With M5-T4's folders in place, the longest session command is 28,447 characters (the SO2 adjudicator); each earlier attempt of a row adds about 850.
  - A command over 32,000 characters is now refused before the session starts, at no cost.
- **Audit:** a Glob `pattern` or Grep `glob` whose fixed prefix is absolute or climbs was checked only against the sensitive-name list. It is now placed like a path, and an outside one counts as an outside access.
- **Tests:**
  - **Guard** (session-guard.test): a new L1 reviewer cannot read the historical L1 records or transcripts. That holds for Read, Grep and Glob in absolute, relative, `..`, msys and look-alike forms, through a junction inside the fixture, and through shell forms (`cat`, `grep -r`, `ls ..`, `cd ..`, `git -C`, `--no-index`). Another session's tool results are refused.
  - **Current-run evidence** stays readable: the base records copied into the fixture, and its own tool results.
  - **Prompt independence:** extra fields, claimed authority and `bypassPermissions` change no decision.
  - **Deny layer** (matrix.test): exact denial of same-code folders in all three places, while the own folder and slug stay open and other codes stay globbed. Incremental rows (I1c, D2) are denied their base row's folder and transcripts but read their own copy. The deny rules are identical whatever the prompt. The command-line refusal is covered.
  - **Audit** (transcript-metrics.test): Glob and Grep patterns.
  - **Negative control:** with the same-code denial disabled, 3 of the 4 matrix B1 tests fail. The Incremental one passes, as expected, because a base always has another code. Restored, all pass.
- **Not verified offline:** Claude Code's own matching of the exact deny rules. That is §11 probes P3 and P4.

**B2, evidence preservation: archived.**
- **The tool:** `tests/tools/evidence.mjs`, with `inventory` (read-only), `archive` and `verify`.
  - **Copying:** it copies only, hashing each source before and after its copy and the copy again.
  - **Destination:** it refuses one inside Git, the temporary folder, the configuration, the root or the kit, or one that is not new and empty. It restricts the folder to the current user and SYSTEM (icacls with inheritance removed; chmod 700 on POSIX).
  - **Manifests:** a full manifest in the archive, and a hash-only manifest for the kit: folder digests, plus kit evidence, run records, verdicts and transcripts by sha256, with no content and no absolute path.
  - **Missing evidence:** anything the ledger names but nothing holds is listed as missing.
- **The M5-T4 matrix ran under its own Claude Code configuration, `<config>`, not `~/.claude`.** Its transcripts are there.
- **Archived (run before any existing tool was edited):** 4,701 files, about 67 MB, into `nth-review-evidence/m5-t4-20261027` beside the kit checkout. The location is outside Git, and every matrix session's deny rules already cover it. `verify` is ok against both manifests.

  | Class | Files |
  |---|---|
  | kit evidence and tooling | 180 |
  | fixtures | 2,289 |
  | sandboxes | 1,964 |
  | transcripts | 131 |
  | probe transcripts | 29 |
  | guard logs | 58 |
  | Claude Code temporary files | 50 |
- **Hash-only manifest:** `tests/fixtures/g5-evidence-m5t4.json` (468 file entries, 117 folder digests), checked for absolute paths and the user name.
- **Missing:**
  - the matrix root, which is not recorded anywhere in the kit and was not found. With it go the per-row state, the streams, the metrics and the guard settings, and the records of the three voided attempts moved under it (L1 seq 4, SO2 seq 83, SS2 seq 95);
  - the `matrix.mjs` version recorded at seq 87 (`9a630363…`), already superseded during M5-T4. The archived copy is the post-closure version.

  Every transcript the ledger names was found. The archived `score.mjs` is the M5-T4 scorer (`9c92b03a…`, the `scorer_sha256` of every later scored event).
- **Retention:** `cleanupPeriodDays` is unset in that configuration (30 days). The earliest M5-T4 transcripts are from 2026-10-26, so without the archive they would be removed around 2026-11-25.
- **Criteria capture:** `tests/fixtures/g5-criteria/roadmap-section-4.md` is the delivery roadmap's §4 (lines 65–91), verbatim. `source.json` holds the source label, the file and excerpt sha256s and the capture time. A test pins the excerpt, and checks it against the source when the source is on the machine.
- **Tests** (evidence.test): inventory classes and missing items with nothing written; refused destinations; copy, not move (sources byte- and time-identical); an access-restricted folder; no absolute path in the kit manifest; tampering detected even when `manifest.json` is edited to match; the kit manifest still matching the historical evidence byte for byte; the criteria pin.

**B3, implementation freeze: gate implemented; not frozen today.**
- **`matrix.mjs implementation`** prints the manifest:
  - every material file, with its sha256 and Git state against HEAD;
  - `frozen`, true only when all files are clean;
  - the session configuration's digest: global instructions, rules, agents, skills, hook scripts, `settings.json` and plugin pins, hashed and never copied. Status caches, state files and sync markers are left out because they change by themselves.
- **Material files:** `review.md` and the skill's runtime entries (shared with the runtime library as `RUNTIME_ENTRIES`), `tests/tools/**`, the builder with its templates and answers, the fixtures README, `g5-criteria/`, the Enable transcription and helpers, and the repeat plan. Ledgers, scores, adjudications and this file are evidence, not inputs.
- **Gates:**
  - `register` refuses a second registration, an unfrozen implementation, and a missing isolation record or one taken on another version, implementation or configuration;
  - `register` records the manifest, the commit and the skill a fixture will hold (from a throwaway build);
  - `record-isolation` refuses an unfrozen implementation and records both digests;
  - `drive`, its dry run and every row refuse a changed implementation or configuration;
  - `prepare` refuses a built skill that differs;
  - each `pre-run` records `kit: { head, frozen, implementation_sha256, environment_sha256 }`;
  - `verify-ledger` checks every pre-run against the registration. The M5-T4 ledger has no manifest and is unaffected.
- **Today:** HEAD `7780c8a`. When first measured, 118 material files: 64 clean, 18 modified, 36 untracked. So `frozen` is false and `register` refuses.
  - **A parallel session is changing the runtime:** during this task another session began the "flow" work. It modified `scripts/lib/cli.mjs`, `check.mjs`, `close.mjs`, `footprint.mjs`, `pack.mjs`, `render.mjs`, `resume.mjs` and `runs.mjs`, and added an untracked `scripts/lib/flow.mjs`. The manifest now shows 119 files: 60 clean, 22 modified, 37 untracked.
  - **The list below is the snapshot before that work.** That work has since landed ("Flow Review (BETA)" below). Regenerate the list with `matrix.mjs implementation` when the owner freezes the kit.
  - **Modified (owner review and commit):**
    - `agents/claude/integrations/review.md`;
    - `SKILL.md`;
    - `reference/census.md`, `prompts.md`, `protocol.md`, `records.md` and `routing.md`;
    - `scripts/lib/check.mjs`, `cli.mjs`, `footprint.mjs`, `fresh.mjs`, `fsguard.mjs`, `render.mjs`, `schema.mjs` and `snapshot.mjs`;
    - `tests/fixtures/README.md`;
    - `tests/fixtures/build.mjs`;
    - `tests/helpers/library.mjs`.
  - **Untracked:**
    - `scripts/lib/patch.mjs`;
    - `tests/G5-REPEAT-PLAN.md`;
    - `tests/fixtures/g5-criteria/`;
    - `tests/fixtures/syn-shelf/` (answers and 25 template files);
    - `tests/tools/` (all six).
  - The evidence also needs committing: the ledger, the adjudications, reports and history, and `g5-evidence-m5t4.json`.
- **Tests** (matrix.test): Git states in a disposable repository (clean, modified, untracked, ignored, deleted, renamed away); a results-only edit or deletion leaves the implementation frozen; volatile configuration files are ignored; every refusal of `register`; the `implementationOk` messages; `verify-ledger` with matching and mismatched pre-runs and scorers; the historical ledger still verifies.

**B4, isolation probes: specified, not run.** `tests/G5-REPEAT-PLAN.md` §11 sets out:
- six probes:
  - P1, the fail-closed set as in seq 9;
  - P2, a working guard;
  - P3, same-code decoys with marker strings, for a reviewer and an adjudicator;
  - P4, the deny layer under an allow-all hook, with reads only;
  - P5, the audit's classification;
  - P6, the command length of all 14 rows;
- their pass criteria and recording;
- cost: about $2–3, cap $4, for 9 short sessions (M5-T4's set cost $1.85).

`register` refuses until a passing record on the frozen implementation exists.

**M1 and M2, measurement: implemented.**
- **M1:** an executed `nthr.mjs apply` counts as a records write for B5's last-write count.
  - **After B1:** an apply's conclusions are read from the `patch.json` written since the previous apply. A refused apply is not a write.
  - **New field:** `record_writes_after_b1_by_kind`.
  - **Old transcripts:** a transcript without an apply gives its M5-T4 values.
- **M2:** `score.mjs` adds `cost observed (transcript)` and `checks.cost_observed` (observed lead calls after the open, and delegations, against the budget, with `within_budget` null when unobservable), next to the unchanged recorded line. `matrix.mjs summary` adds `cost_observed` to every row.
- **Pre-registration:** both are measurement rules pinned through the implementation digest. Which count gates the cost criterion is decision OD-4.

**Independent review** (a reviewer agent, read-only). Four defects were found, all fixed with tests:
- **A deleted or renamed-away material file left `frozen` true**, because the manifest listed only existing files. It is now an entry `git: deleted` with no sha256, and the implementation is not frozen. Materiality is one pattern list (`isMaterial`) shared by the walk and the deleted check.
- **The implementation was checked only before a row**, not between its session (up to 75 minutes) and its audit, adjudication and score. `drive` now checks again before the audit and before the score. A closed row stops and resumes at its next step once the implementation is restored. `verify-ledger` also requires every `scored` event to name the registered `score.mjs`; `rescored` events name their own.
- **The adjudicator's repair turn skipped the command-line check.** It now has one; an over-long repair is not started.
- **The patch pairing kept only the last write before an apply**, so an Edit fragment hid a conclusion set by the Write before it. Edits are now replayed on the last Write.

Also changed:
- **`verify` anchoring:** `verify` now uses the committed kit manifest by default and says whether it was anchored. It reports archive files that are not in the manifest, and manifest paths that leave the archive.
- **Slug case:** the evidence tool matches slugs case-insensitively. No such folder was missed here: the only lower-case ones are development scratchpads.

**Tests:**
- **Before the parallel runtime work** (2026-10-28, from 00:16): the full review suite was 403 tests: 398 pass, 0 fail, 5 skipped (platform cases), identical in Git Bash and PowerShell.
- **While that work was in progress**, the full suite briefly failed 50 to 52 tests. The causes were intermediate states, not defects:
  - `cli.mjs` already imported `scripts/lib/flow.mjs` before `review.md`'s inventory listed it, so Enable did not install it in fixtures (`ERR_MODULE_NOT_FOUND`: 10 builder and 38 scorer tests);
  - the inventory count read 27 against 26;
  - `records.md` did not yet document `mode: flow`;
  - two flow report assertions failed while the flow code was mid-edit.
- **After the flow work landed:** the full suite is 414 tests: 409 pass, 0 fail, 5 skipped, identical in Git Bash and PowerShell.
  - The 5 skipped tests are the Windows platform cases: two executable-bit tests and three symbolic-link tests that need a privilege.
  - Every M5-T4R test passes.
  - A disposable fixture installs all 27 runtime files, `flow.mjs` among them, and `nthr.mjs resolve` runs in it.
- **Byte-identity:** the 90 kit evidence files (ledger, answers, adjudications, reports, history) and the 91 historical run-record files in the temporary folder are byte-identical to the baseline taken before this task. The archive verifies, anchored.

**Not done:** no probe, paid session, Global Update, commit or staging. The installed library, private project B and private project A were not touched. G5 = FAIL; Full Audit stays disabled (`OFFICIAL_AUDITS_ENABLED` is `false`).

## Flow Review (BETA): implementation and validation (2026-10-28)
**What it is.** A new run mode, `flow`, reviews what the current source does from 1–8 explicit entry points (a function, route handler, web action, job, event consumer, or several entries of one workflow), with no Git range. It concludes only on the paths it records.
- **Invocation:** `/nth-review flow --ns reviews/<topic> --slug <name> --entry <selector> [--entry …]`.
- **Selectors:** `<path>#<Symbol>` (an identifier, or `Container.member`), `<path>:<line>` or `<path>:<from>-<to>`.
- **Validation before opening:** the helper's `resolve --entry …` checks selectors and opens nothing.
- Pre-implementation analysis was by the architect; implementation followed its handoff, with the corrections below.

**Contracts (records@1, optional fields; older records stay valid, older helpers cannot read a flow record):**
- `scope.entries` (helper-owned): each resolved entry with its file identity at Open.
- `census.edges` (lead-owned): the recorded execution paths, each with `from`, `to`, `kind`, `evidence`, status (`classified`, `excluded` or `unknown`), `reason` and `affects`. Kinds: route, call, data, event, job, dynamic, external, guard, error.
- `budget.max_depth` and `budget.max_edges` (helper-owned limits).
- `apply` already refused the helper's fields; it needed no change.

**Entry resolution** (`scripts/lib/flow.mjs`, a new runtime file; the integration now installs 27):
- It reads only the working tree, never Git history.
- A symbol matches definitions only, by a per-language pattern table (JS/TS, Python, Go, Rust, Ruby, PHP, Kotlin, Java/C#); lines over 2,000 characters are never tested. No match, or more than one, is refused with the candidate lines, never guessed.
- Refused files: missing, secret, linked, filtered, outside every repository, `.nth-review/`, this integration's untracked files, and whole-file selectors; so are duplicates.
- Any problem refuses `new-run` with nothing written.

**Bounding (deterministic, enforced by `check`):**
- **Budget:** lead 60 + 10 per extra entry (cap 90); subagents 5; obligations 20 + 5 per extra entry (cap 40). The lead is always `opus-high`.
- **Limits:** depth 4; edges 40 + 20 per extra entry + 20 per extra entry repository (cap 120). `check` recomputes all of these from the entries.
- **Edges expand forward only:** `from` is an entry or an earlier classified edge with a target, so the graph is acyclic by construction. A path back into reviewed code is an excluded edge.
- Past `max_depth`, an edge only records the frontier (`unknown`). More than `max_edges` edges is an error.
- An unknown edge, or a reached edge limit, blocks `all-enumerated` and "Verified". A closed run hands every unknown edge on as frontier or deferred-scope debt naming its evidence anchor; the anchor must appear as a whole token.
- Obligation evidence, dependency anchors and finding traces must lie inside the boundary: the entry files and the edges' evidence and target files.
- A complete run cites every entry.
- Paths a delegate discovered may be disposed of by an edge.

**Freshness:**
- The snapshot and close recheck work as for a Task Review, plus three flow-only refusals that `--reassessed` cannot lift:
  - a cited untracked, absent or unverified file in a repository whose untracked state changed (shared `citedAtRisk`, also used by `resume`);
  - an entry that no longer resolves exactly as at Open (this catches git-ignored entry files);
  - (`footprint` and `close`) a cited git-ignored non-entry file. This one was found by the independent review.
- **Resume** carries the entry selectors and shows what they resolve to now.

**Compatibility:**
- A flow run and a non-flow run never build on each other: a flow run is no Incremental baseline, and it continues only an abandoned flow run.
- Task, Incremental and audit behaviour is unchanged; Full Audit stays disabled.
- **Report:** titled "Flow Review report", with a boundary sentence (not a project audit), the entries, a table of the reviewed paths with their dispositions, and the limits reached.
- **Packs** carry the edges that bear on an item, so delegates start from the recorded discovery.

**Corrections to the first design** (from the architect's analysis):
- `--base` is refused, not merely discouraged.
- `complete` stays allowed with unknown edges, but they block all-enumerated and Verified and must be handed on as debt.
- The boundary excludes census items, since a glob could widen it.
- The close freshness gap was closed as described above.

**Tests** (synthetic, disposable repositories):
- New `tests/flow.test.mjs` (10 tests) covers:
  - a single API entry;
  - a web action into an API in another repository;
  - event consumers;
  - a job with an injected dependency (unknown);
  - entry-count limits, depth and edge limits;
  - forward-only edges, repeated paths and repeated delegate discoveries;
  - ambiguous, missing and unsafe entries;
  - an irrelevant large repository;
  - tracked, untracked and ignored source changes during the review, with resume;
  - incompatible and tampered records;
  - the review fixes.
- Each run also checks that nothing outside `.nth-review/` changed, and that Git's HEAD and index did not.
- **Negative controls:** disabling any of 12 safeguards makes a flow test fail; every file was restored byte-identical. The safeguards are the boundary, depth, forward-only, unknown-edge debt, budget recompute, edge blockers, edge limit, close at-risk refusal, close re-resolution, flow parity, ambiguity refusal and ignored-file refusal.
- **Full suite:** 414 tests: 409 pass, 0 fail, 5 skipped (platform cases), identical in Git Bash and PowerShell.
- **Lifecycle rehearsal** (`tests/m4/rehearse.mjs`, 27 files): 75 rows, 72 pass, 0 fail, 3 unverified, as before.
- **Not verified:**
  - POSIX and macOS (Windows only);
  - a real project or a live review session (no paid runs);
  - symbol tables beyond the synthetic cases.

**Independent review** (reviewer): one material finding, fixed (a cited git-ignored non-entry file could change unseen); two minor ones, fixed (long-line regex cost; substring match of debt to an unknown path). Design point kept: a flow run may close `complete` with unknown paths, which are reported as not reviewed and handed on as debt.

**Known limits:**
- Symbols are found by pattern, not by a parser.
- Runtime-only relationships stay unknown.
- A line selector re-resolved on resume may name other code (the plan shows it before `--apply`).
- Incomplete discovery from an unrelated repository still blocks all-enumerated.
- Older helpers reject a namespace holding a flow run.

The installed library and project copies do not hold these changes: no Global Update or project Update was run. G5 = FAIL. Full Audit stays disabled (`OFFICIAL_AUDITS_ENABLED` is `false`).

## Flow Review (BETA) hardening (2026-10-28)
A focused review of five correctness concerns, with no redesign. The limits are unchanged.

**1. Cycles and shared dependencies: three defects fixed.**
- **Wrong guidance:** the documents said a path back into reviewed code is an `excluded` edge. That discarded a real relationship.
- **Repeated exploration:** nothing stopped expansion from an edge into an already-reached node, so a cycle or a shared service could be explored again, bounded only by the depth and edge limits.
- **Duplicates:** the duplicate check compared exact anchor strings, so an overlapping range of the same code passed as new.
- **Fix:**
  - a node is a code location: the same file, with overlapping lines or no lines;
  - an edge into an already-reached node (an entry, or an earlier edge's target) stays a `classified` relationship, but nothing expands from it, so each node is explored once, from the first path to it;
  - `check` refuses expanding from a revisit, and refuses `excluded` for an already-reached node (excluded means out of scope);
  - repeats are compared by node.
- **Docs:** `reference/records.md`, `reference/protocol.md` and `agents/claude/integrations/review.md` corrected.

**2. Complete vs Verified: separated, plus one defect fixed.**
- **Already separate:**
  - `complete`/`incomplete` is process status (close);
  - "Verified" is per obligation and computed in the report (all-enumerated, complete discovery, a proven source recheck, verified evidence, no coverage blocker);
  - `check` refuses all-enumerated while a blocker bears on the obligation;
  - `status` reports the unreviewed path as open frontier debt.
- **Defect:** an unknown edge blocked only the obligations it named itself. An unreviewed path below an edge that obligation OB-1 covers, but naming another obligation, left OB-1's all-enumerated claim, and so Verified, intact.
- **Fix:** an unknown edge also bears on every obligation covering an edge on its path from the entry (`coverageBlockers` in `render.mjs`, shared by `check`).
- **Tests:** a fully covered flow run is Verified; a complete run with an unknown path below a covered edge is refused all-enumerated, closes `complete`, reports "not verified", lists the unknown path, and `status` lists its frontier debt.

**3. Depth and frontier: already correct; now shown on a real six-stage path.**
- **Path:** route → handler → service → repository → adapter → driver.
- **Convention:** an entry's edges are depth 1. With `max_depth` 4, the driver edge is depth 5 and can only be `unknown`; depth 6 is refused, and nothing grows from the frontier.
- **At the limit:** all-enumerated is refused, close requires frontier debt naming the edge's evidence anchor, and the report shows "depth limit reached". The limits were not raised.

**4. Entry selector freshness: one defect fixed.**
- **Already correct:** close re-resolves every selector and refuses any change of lines or file identity; a renamed or deleted entry file is refused with "does not exist (renamed or deleted?)".
- **Defect:** `resume` re-resolved a line selector on the edited file, so the continuation could point at different code; only the plan output showed it.
- **Fix:** resume (and an interrupted apply) refuses a line selector whose file identity changed since Open. The refusal names the escape: close `incomplete` with `snapshot-changed`, then open a new run with checked selectors. A `#Symbol` selector follows its definition: resume continues on the moved lines.

**5. Budget: already enforced; now tested for flow runs.**
- Recorded spending over the lead or subagent budget never closes `complete`, nor `incomplete` with another reason than `budget`.
- Obligations are capped at `obligations_max` + 20%.
- The limits are recomputed from the entries (a hand edit is refused).
- Edge and depth limits are enforced as above.
- Spending is what the lead records: an observed count still needs the transcript (see the Beta v3 record).

**Tests** (synthetic, disposable repositories):
- `tests/flow.test.mjs` now has 15 tests:
  - 5 new: A → B → A and two callers of one service; complete vs Verified; the six-stage path; selector freshness (edit, rename, resume); budget enforcement;
  - 2 rewritten for the corrected cycle semantics.
- **Negative controls:** disabling any of the 4 new safeguards fails its test (revisit expansion, excluded revisit, frontier below a covered path, stale line selector on resume); every file was restored byte-identical.
- **Full suite:** 419 tests: 414 pass, 0 fail, 5 skipped (platform cases), identical in Git Bash and PowerShell. POSIX and macOS not run.

**Remaining Beta limits:**
- Node identity is by file and line overlap, so two functions on one line, or a target given only as a file or heading, count as one node.
- Symbols are found by pattern, not a parser.
- Runtime-only relationships stay `unknown`.
- Spending is self-recorded.
- A flow run may close `complete` with unknown paths, but never claims them as covered.

G5 = FAIL. Full Audit stays disabled. No Global Update or project Update.

## Cloudflare security-audit-skill re-check (2026-10-28)
**Upstream:** the revision nth-review adapted is `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14). `THIRD-PARTY-NOTICES.md`, the M3-T7 record above, `tests/notices.test.mjs` and the earlier design research all agree on it.
- **Current upstream:** `main` is still that commit (fetched 2026-10-28: no later commit, no tag), and every recorded blob and the `LICENSE` SHA-256 match. **So there is no upstream change to adopt.**
- The fetched content was treated as untrusted data: read only, never run.

**Re-check against today's nth-review**, which now has Flow Review, edges and the discovery handoff (architect analysis). Every upstream capability is either already implemented or still rightly rejected, except one real gap.

**Already implemented:**
- authentication and authorization (AUTHN, AUTHZ and the session and integration modules);
- cross-tenant isolation (AUTHZ.4, OBJSTORE.1, PRIVACY.4);
- injection (INJECT, the file-processing and headless-render modules, LLM.3);
- resource exhaustion and spend (RESOURCE, LLM.4, LOGIC.6);
- concurrency and state (ATOMIC, ASYNC, LEDGER; never `held` on source alone);
- supply chain (SUPPLY, CONTAINER-EDGE);
- AI and LLM attack classes (LLM.1–5);
- trust boundaries (census entries and gates; Flow `guard`, `external` and `dynamic` edges);
- counterevidence-first refuters with verdict-free packs, the second R5, and never strengthening an outcome;
- coverage accounting (stronger than upstream);
- severity anchors, and reports from records;
- safety (nothing is executed; no network; no secrets).

**Still rejected:**
- the full workflow, profiles, ledger validators and cross-product coverage units;
- broad "obvious" and "wildcard" sweeps, and variant sweeps (they widen scope under fixed budgets);
- likelihood and confidence fields (the verdict model carries certainty);
- the sandbox and promotion procedure (nothing is executed).

**The gap:** nothing kept a defense-in-depth or hardening gap from becoming a confirmed security defect.
- SKILL §3.4 mapped authorization to `security` unconditionally.
- No rule asked who acts, which control fails, and what is crossed beyond the actor's own permissions.
- The LLM module did not say that a model instruction is no control, or that steerable model input matters only where code then grants authority, data or a sink.
- RESOURCE did not ask who pays.

**Adopted (restated in nth-review's own words; no five-word run shared with any of the 16 upstream Markdown files):**
- **`scripts/lib/pack.mjs`:** a **Boundary test** block in finding packs, before the excerpts and never cut.
  - **Relevance** is decided by the helper, per finding: `impact_dimension` security or privacy, or obligation checks in AUTHN, AUTHZ, INJECT, LLM, WEB-SESSION or INTEGRATION, or RESOURCE.2.
  - **Extra lines:** model path (LLM), cost (RESOURCE.2 or LLM.4), scope (AUTHZ.2, AUTHZ.4 or OBJSTORE.1).
  - Obligation packs and all other findings never get it, so security guidance loads only for security-relevant findings. Questions only, no verdict, so refutation stays independent.
- **`reference/prompts.md`, R5/R6:** apply the boundary test when the pack has one; a failing claim is `risk`, or `corrected` to the impact it does show.
- **`reference/taxonomy.md`, Severity:** a `security` or `privacy` impact needs a crossing; a gap with no crossing is a `risk`, or a defect rated by the impact it does show.
- **`SKILL.md` §3.4:** authorization *crossing principals* maps to `security`.
- **`THIRD-PARTY-NOTICES.md`:**
  - a new "Methodology restated" bullet;
  - three more upstream files in "Files read", with blobs;
  - the recheck noted. No new adapted-wording row.
- No schema, runtime-file (still 27), budget, mode or delegate change. Task, Incremental and Flow behaviour is unchanged for every other finding.

**Tests** (synthetic):
- **`tests/pack.test.mjs`, new test:**
  - irrelevant findings (financial correctness, LOGIC, data-integrity with RESOURCE.1) and obligation packs carry no boundary test;
  - security under AUTHZ.2 gets the scope line only;
  - availability under LLM.4 and LLM.2 gets the model and cost lines (relevant by checks alone);
  - a whole `LLM` check gets the model line; RESOURCE.2 gets the cost line;
  - privacy with no obligation gets the base block only;
  - the block comes before the excerpts, is deterministic and holds no verdict word;
  - with every line and a pack over the cap, the block stays whole within 6 KB.
- **`tests/content.test.mjs`:** the refuter, taxonomy and SKILL wording.
- **Negative controls:** removing the relevance gate, the block, or the scope keying makes the pack test fail; restored byte-identical.
- **Full suite:** 421 tests: 416 pass, 0 fail, 5 skipped (platform cases), identical in Git Bash and PowerShell.

**Not verified:**
- whether refuters apply the test well (no paid run);
- POSIX and macOS.

**Measurement note:** the pack, prompt and taxonomy changes alter what a scored run sees, so runs before and after this change are not directly comparable. G5 = FAIL. Full Audit stays disabled. No Global Update or project Update.

## Beta readiness for regular manual use (2026-10-28)
An end-to-end check of Task, Incremental and Flow Review. No paid run or live model review; the real-run evidence is read-only analysis of existing runs and transcripts in private project B.

**Installation:**
- **Library (2026-10-28, before this section's fix):** the installed library matched the checkout. A dry Global Update listed 311 files, all unchanged, and the 27 runtime files were byte-identical, with receipt digests equal.
- **Private project B's copy:** 27 files, all matching its own state file. It predates the Boundary test: 6 files differ from the library (`SKILL.md`, `THIRD-PARTY-NOTICES.md`, `reference/prompts.md`, `reference/records.md`, `reference/taxonomy.md`, `scripts/lib/pack.mjs`).
- **After this section's fixes:** `scripts/lib/flow.mjs`, `scripts/lib/patch.mjs` and `reference/records.md` changed, so the library needs a Global Update and each enabled project an Update. Neither was run.
- **Lifecycle rehearsal** (`tests/m4/rehearse.mjs`, disposable projects): 75 rows, 72 pass, 0 fail, 3 unverified, as before.

**Real runs, checked with the current helper (read-only `check` and an in-memory re-render):**
- All five real runs pass the current `check`:
  - Task v1;
  - Task v2;
  - Task v3;
  - Flow `rp-standard-accept/20261028-014720-flow-beta-01`;
  - Flow `rp-batch-settlement/20261028-032956-flow-beta-02`.
- Their stored reports re-render byte-identical from their records, so record and report compatibility holds on real data.
- **Flow beta-01** (Standard API accept, 3 entries, closed `incomplete`, open-obligations):
  - 22 edges, maximum depth 3: 19 classified, 2 excluded with reasons (outside the boundary agreed with the owner), 1 unknown with its next step;
  - 16 obligations; 3 confirmed defects, 1 by R5 and 2 by R6, each with a trace and counterevidence;
  - 3 obligations Verified (all-enumerated, no blocker); the unknown edge and the unknown census item name other obligations;
  - R3 found 15 paths, all dispositioned;
  - the effort and entry approval were asked before Open; `resolve` was used, and so were patches; no other run was read.
  - One `apply` was refused, because it replaced the whole `scope.intent` list, which only takes added entries. The refusal message pointed at `scope.change`, which cost the lead a call. The message now names the fix (`scripts/lib/patch.mjs`; test in `tests/patch.test.mjs`).
  - It ran in the session that had also run Task v2 on the same repository, so it is not an independent session.
- **Flow beta-02** (Batch settlement, 1 entry, `#checkBatch`, closed `complete`):
  - 23 edges, depths 1–5: 22 classified, and 1 unknown at depth 5 recorded as the depth-limit frontier, with debt;
  - 9 obligations; 4 confirmed defects (2 by R5, 2 by R6);
  - **0 Verified**: none was all-enumerated, and the report states "depth limit reached";
  - R3 found 11 paths, all dispositioned;
  - a fresh session; the question was asked before Open; `resolve` was used; no direct edit of `records.json`; no other run read; recorded lead calls 29 = observed 29;
  - session cost $4.64 (`cost-state`, whole session, including choosing the boundary); 12.3 minutes open to close.

  This is the real-run demonstration that `complete` does not imply Verified.

**Defect found in real use, and fixed: symbol selectors cut off multi-line signatures.**
- **Evidence:**
  - In beta-01, `src/api/accept.ts#settleAttempt` resolved to lines 49–56, its signature only, and the lead fell back to a line selector after four `resolve` calls.
  - In the beta-02 preparation, `#fetchAndProcess` resolved to 699–704.
- **Cause:** the block finder took the signature's closing `)` line as the block's end.
- **Fix** (`scripts/lib/flow.mjs`):
  - a signature whose parentheses stay open ends on the line that closes them (at most 60 lines; unbalanced parentheses keep the old behaviour);
  - a JS/TS method whose parameters span lines now counts as a definition, but only when the line closing them opens a body, so a multi-line call is never taken for a definition.
- **On the real source (read-only `resolve`):** `settleAttempt` gives 49–130, the range the lead found by hand; `fetchAndProcess` gives 699–735. `checkBatch`, `processPage`, `reconcileProcess` and `processResults` also resolve to whole bodies.
- **Tests:** a new test in `tests/flow.test.mjs` covers TypeScript, a class method, Python, an unbalanced string, and a call that is not a definition. Disabling either part of the fix fails it.

**New end-to-end tests (`tests/lifecycle.test.mjs`, CLI only, no record written directly):**
- **Task, then Incremental:**
  - a Task Review: plan, census, R3 with `discovered`, a candidate, a verdict-free pack, an R5 confirmation, debt, footprint; `complete` refused while an obligation is open; closed `incomplete`;
  - the report shows the finding, the open obligation, and budget beside recorded spending, with the note that time outside the run and money are not measured;
  - the source changes; an Incremental Review inherits the debt explicitly;
  - `fresh` classes each obligation: `file-changed` (a change outside the 3-line margin), `touched` (the fixed code), `current` (an unchanged file);
  - a conclusion copied forward unchanged is refused at close; re-cited with what was re-read, it passes;
  - the fixed defect's obligation is held on new evidence; the inherited debt is carried;
  - a source edit during the run is refused at close;
  - carried debt keeps the run from closing `complete`;
  - the report shows each class and what the run did with it; `status` lists the debt handed on.
  - Before and after each phase, the project's files, HEAD and index are unchanged: the helper wrote nothing outside `.nth-review/` and ran no Git write.
- **Security boundary,** on four synthetic cases with real source:
  - A: a signed-in user sets anyone's role;
  - B: a missing defense-in-depth step behind an owner-scoped lookup;
  - C: unbounded model spend on the operator's account by a signed-in user;
  - D: a speculative cross-owner leak.

  What the test establishes:
  - every pack gets the Boundary test, with the cost and model lines for C and the scope line for D;
  - the honest outcomes are accepted: A confirmed by R5; B as a `risk`, or `rejected` with counterevidence naming the effective control; C confirmed by R5, corrected to operator spend; D `needs_validation` with the fact to establish;
  - overstated records are refused: a security claim confirmed by the Sonnet refuter; a risk with a severity; `needs_validation` with a severity or no plan; a rejection without counterevidence.
  - **Unverified without a live run:** whether a refuter actually reaches these outcomes, and whether a lead labels a defense-in-depth gap `security`. The records cannot tell a crossing from its absence.

**Suites:** 424 tests: 419 pass, 0 fail, 5 skipped (platform cases), identical in Git Bash and PowerShell. POSIX and macOS were not run.

**Readiness:** usable regularly as a manual, opted-in Beta, once the library and each project are updated. G5 = FAIL (a quality gate, not an operational one). Full Audit stays disabled. No Global Update or project Update was run.

**Known limits:**
- Model judgment is unmeasured (one or two real runs per mode).
- Lead tool calls are self-recorded; beta-02 matched the observed count, but earlier runs did not.
- The copied-conclusion rule fires only at close, not on `apply`.
- Symbols are found by pattern, not a parser.
- Runtime-only links stay unknown.
- A git-ignored non-entry file cannot be cited in a Flow run.

## v1.0 release candidate 1.0.0-rc.1 (2026-10-28)

A productization pass toward a v1.0 Stable release: readiness audit, review-quality analysis, a new pre-registered quality gate (RQ-1), reliability hardening, product experience, platform validation and a release contract. The contract, the readiness classification and the verdict are in [RELEASE.md](RELEASE.md). **Verdict: NOT YET STABLE.** G5 = FAIL (unchanged). Full Audit stays disabled. No paid run, Git write, Global Update or project Update was made; private project B and private project A were read only.

**Environment:**
- **Windows:** Windows 11 Pro 10.0.26200, Node v22.22.3, Git 2.54.0.windows.1, from Git Bash and PowerShell.
- **Linux:** WSL 2 Ubuntu 24.04, Git 2.43.0, official Node.js binaries v20.20.2 and v22.23.4, checksum-verified against nodejs.org and placed in a temporary folder (no system install). The suite ran on a copy of the kit in the Linux file system.

### RQ-1: the release quality gate, defined before evaluation
- [tests/RELEASE-GATE.md](tests/RELEASE-GATE.md) (`nthr-release-gate@1`) was written before any evaluation, before the evidence analysis below was read, and frozen: sha256 `cd9e067c99fae3611fc78ffbef9052093cacc735368418d02388a9d1aa3595ae` at 2026-10-28T10:18:44Z. Its thresholds have not changed since.
- **Part A (offline):** A1–A11, software checks.
- **Part B (review judgment):**
  - **Carried from G5:** B1 precision and false positives (Rule 4 v1, per row), B2 recall, B4 freshness, B5 coverage truthfulness, B6 refutation quality, B9 debt and completion, B10 cost.
  - **Added:** severity and evidence quality (B3), overclaims (B5), refutation soundness (B6), repeatability (B8), a curated security-boundary fixture (B7), the Sonnet lead rule (B11), and the owner's triage of real runs (B12).
- **Matrix:** G5-REPEAT-PLAN's 14-row matrix, with OD-1 to OD-12 fixed to that plan's recommendations, taking the stricter reading. `RELEASE-GATE.md` is a material file of the implementation manifest.
- **Evaluator:** `tests/tools/release-gate.mjs`, with `offline` and `evaluate` (`tests/release-gate.test.mjs`, 6 tests). It writes nothing. A missing row or input is BLOCKED, never met.

### Review-quality evidence (frozen M5-T4, read only)
A read-only analysis of the 13 valid rows (official scores, blind adjudications, metrics, run records and transcripts; the sealed answers' mechanisms were not read). The headline facts are in RELEASE.md §3.

**Waste and cost** (measured from the transcripts):
- lead calls: 523, of which 487 after open, against 494 recorded;
- records writes: 25% of lead calls;
- reference reads: 13% of lead calls, about 19% of lead cache reads (estimated);
- delegations: 7% of lead calls;
- guard blocks: 43;
- R3 re-reads of files the lead had read: 52;
- time waiting on subagents: 20% of wall clock;
- lead-recorded token fields: `lead_tokens_observed` null in 13 of 13 rows; R3 `tool_uses` and `tokens` null in 11 of 11; recorded `subagent_tokens` 5–19 times below the transcripts.

**Variance:** three Opus attempts on `syn-shelf` (SO1, SO2 attempt 1, SO2) gave three different outcomes.

**RQ-1 diagnostic on the historical rows** (labelled, not RQ-1 evidence): B1 FAIL (L2 control hit; SO2 precision 0.667), B2 FAIL (SO2), B3 FAIL, B4 PASS, B5 FAIL (pending populations; L2 7/8 and overclaims OB-9, OB-14), B8 FAIL, B9 PASS; B6, B10 and B11 BLOCKED (SS2), B7 and B12 BLOCKED. The new gate is not weaker than G5 on the evidence G5 judged. No score, verdict, adjudication, answer, fixture or ledger event was changed or re-scored.

### Reliability audit and fixes
Two independent read-only audits (the records lifecycle; source identity and freshness) reported 16 defects with reproduction scripts on disposable projects.
- **Records audit (8):** all eight reproduced in this session against the unchanged code before any fix; one was a documentation error only (records.md said a run *within* budget fails with reason `budget`).
- **Source-identity audit (8):** its scripts were run after the fixes and show the corrected behaviour. The defects themselves are shown by the negative controls below, with each fix undone. One (a Flow `#Symbol` selector re-pointed on resume) is not fixed.

**Fixed** (one regression test each in `tests/rc-hardening.test.mjs`, 13 tests with the two from the review below):
- **Verdict follows the refuter (high):** `check.mjs` `verdictRules`. An incomplete verification leaves a candidate. `rejected` needs the refuter outcome `rejected` from a completed R5/R6. `needs_validation` never follows a rejection. The R5 rule binds every refuter-decided defect.
- **Held while its defect is unsettled (medium):** `check` refuses a held obligation whose own defect is a candidate or `needs_validation`.
- **Lead model lowered (medium):** `routingRules` requires `opus-high` for Incremental runs, and keeps `task-size` for any task whose helper-owned budget is not the S row.
- **Changed cited untracked file accepted (high):** `close.mjs`. The at-risk refusal now applies in every mode (it was Flow-only), matching `resume`'s `cited-untracked`. A `snapshot-changed` close records at-risk files `unverified` / `source-changed`, so a later `fresh` never calls them `current`.
- **False at-risk (medium):** `footprint.mjs` `citedAtRisk` counts only a cited file that could have changed (its repository's untracked state differs, or it is unhashable where hashing was partial or the tracked state is unproven). This removes a false abandon and a Flow close that could never succeed.
- **Stale report in an abandoned run (medium):** `resume --apply` removes an interrupted close's `report.md` before its commit point, and `check` refuses one in an abandoned run.
- **Refused close changed files (low):** leftover temporaries are removed only after every refusal, the check included (`isLeftoverError`).
- **Patch by position (low):** `patch.mjs`: an id-bearing array is addressed by id only.
- **Lost assumption-changed marks (medium):** `resume --apply` hands on an unreassessed `assumption-changed` mark as `verification` debt.
- **Absent evidence current (low):** `fresh.mjs`: evidence absent at the origin and now is `touched`.
- **Embedded gitlink (medium):** `snapshot.mjs`: every repository's index is scanned for gitlinks, with or without `.gitmodules`.
- **Untracked lines uncounted (medium):** `runs.mjs`: a working-tree change with untracked files has `size.verified: false`, so it is never S.
- **Flow entry message (low):** the refusal for a changed entry names the explicit close, since `resume` does not re-resolve entries.

**Independent review** (a reviewer agent, after the fixes). Two findings, both fixed with a regression test:
- **High, reproduced:** the narrowed at-risk set missed a cited untracked file the Open snapshot never hashed (over 1 MiB, or past the byte or file budget). Its edit changes no snapshot state, so `resume` continued and `close --reassessed` recorded the edited file as reviewed. The fix: in a repository whose untracked hashing was partial, such a file is at risk (`R-1`).
- **Medium:** an unapplied `patch.json` blocked `resume` from abandoning its run, with a misleading "apply it before close" error. `resume --apply` now removes it with the other leftovers; it is never applied (`R-2`). `close` still refuses a pending patch.

Design points kept and documented:
- with a cited file at risk, the only `incomplete` close is `snapshot-changed`, which is the truthful reason;
- any untracked change in the same repository puts cited untracked files at risk;
- for an audit namespace, `status`'s `next` names `nthr status` itself; audits are disabled.

**Negative controls:** in a scratch copy of the kit, each of the 17 fix sites was undone in turn. Each made its regression test fail, and the copy was restored identical. The untracked-size fix has its test in `new-run.test.mjs` (T7).

**Not fixed, documented** (RELEASE.md §4):
- a Flow `#Symbol` selector can follow a same-name definition on resume (Beta);
- a run without a recorded lead model is not checked against C15. A rule was tried and reverted: it was not a demonstrated contract violation and would have rewritten many fixtures;
- `GIT_DIFF_OPTS` is not scrubbed (conservative);
- no lock between helper commands on one run.

**Existing tests updated** to the corrected behaviour (no assertion weakened):
- `resume.test.mjs` (C5): its record of a rejected finding with an incomplete verification is now invalid; it uses a doc-drift candidate;
- `fixtures.test.mjs`: the test's own first review keeps `task-size`;
- `flow.test.mjs`: the message wording; a debt item addressed by id (`~1`), as records.md documents;
- `new-run.test.mjs`: a working tree with an untracked file is `unverified`, with `opus-high`.

### Product experience
Pre-implementation analysis by the architect; its handoff was followed.
- **`preview`:** the options of `new-run`; writes nothing; the same refusals; returns the size, budget, lead model, triggers and debt, plus the `start` command.
- **Help:** `nthr <command> --help` describes one command.
- **Report:**
  - an unnumbered **Summary** (what the status means, Verified counts, findings, debt, unknowns, and the next-step command);
  - a **Helper** row;
  - a **Source** column in the Cost table (recorded by the lead, counted, computed by close).
- **`status`:** `next` per namespace.
- **Versions:** `VERSION` is `1.0.0-rc.1`, moved with `PROTOCOL` to `schema.mjs`. Records stay `records@1`.
- **SKILL.md:** two lines change, for the new close rule (body 118 of 120 lines).
- **Tests:** `tests/rc-experience.test.mjs` (4); `cli.test.mjs` (+1); report-order and cost-row assertions updated.

### Platform validation
**Linux run before the fixes** (a copy of the kit at that point): 10 failures on both Node versions.
- **The harness itself:** `node` not on PATH, and the kit copied under `/tmp`, the OS temporary folder those tests treat specially.
- **Test portability:**
  - `commitAll` relied on a global Git identity (a submodule clone has none);
  - the partial-clone test assumed Git 2.44 or later, where the helper correctly refuses the clone outright on 2.43;
  - an assertion in `session-guard.test.mjs` was vacuous on Windows: the echo uses `/`, so comparing with a `\` path always passed.
- **The benchmark runner's Windows-only path forms:** fixed by making `matrix.mjs` refuse `register`, `record-isolation` and `drive` off Windows (`platformProblem`), and by marking the two Windows-form tests as such.

**The documented test command** `node --test <dir>/` fails on Node.js 22 (`MODULE_NOT_FOUND`). `tests/run.mjs` lists the files itself and runs on Node 20 and later on both platforms.

### Final results
All on the final code, through `tests/run.mjs`:

| Run | Tests | Pass | Fail | Skipped (platform reasons) |
|---|---|---|---|---|
| Windows, Git Bash (Node 22.22.3) | 449 | 444 | 0 | 5: executable bit ×2, symbolic links ×3 |
| Windows, PowerShell (Node 22.22.3) | 449 | 444 | 0 | 5: the same |
| Linux, Node 20.20.2 | 449 | 442 | 0 | 7: Windows path forms; case-insensitive FS ×2; roadmap source absent; git-lfs absent; matrix Windows-only ×2 |
| Linux, Node 22.23.4 | 449 | 442 | 0 | 7: the same |

The suite grew from 424 tests (419 pass, 5 skipped) by 25: 13 hardening, 4 product-experience, 6 release-gate, the matrix platform test and the per-command help test.

**Lifecycle rehearsal** (`tests/m4/rehearse.mjs`, Windows): 75 rows, 72 pass, 0 fail, 3 unverified (Unicode-normalization collisions; directory and file symbolic links), as in M4-T3.

**RQ-1 Part A** (`release-gate.mjs offline`, with the four TAP files and the rehearsal output): **A1–A11 PASS**.
- A4: `verify-ledger` ok at 97 events, ledger sha256 as recorded, 90 of 90 manifest evidence files byte-identical.
- A6: 27 runtime files, LF only.

**RQ-1 Part B** (`release-gate.mjs evaluate`, no registered row): **B1–B12 BLOCKED**. The gate is **not passed**: NOT YET STABLE.

**Gate text:** `RELEASE-GATE.md` is still sha256 `cd9e067c…95ae`, byte-identical to its freeze.

**Sealed evidence:**
- every file under `tests/fixtures/` is byte-identical to the baseline taken at the start of this session (168 files);
- the M5-T4 ledger's sha256 is unchanged (`7aa36b16…8f18`), and `verify-ledger` is ok at 97 events.

**Not verified:** macOS; Node 20 on Windows; the lifecycle rehearsal on Linux; any live review session with this candidate (no paid run); RQ-1 Part B.

## Release qualification preparation for 1.0.0-rc.1 (2026-10-29)
Free, offline work before any paid evaluation. No paid call, Git write, Global Update or project Update was made. The real runs were read, never written. G5 = FAIL; Full Audit stays disabled. The verdict is still **NOT YET STABLE**.

### The gate evaluator, checked against the frozen gate text
`tests/tools/release-gate.mjs` was compared with `tests/RELEASE-GATE.md`, which is unchanged (sha256 `cd9e067c…95ae`). Four places implemented the text inexactly. Each is now fixed, with a test in `tests/release-gate.test.mjs` (8 tests):
- **A5:** the text requires each of the four fixtures to build twice with its sealed heads and tree, and §5 says the tool checks A5 directly. The tool instead inferred A5 from two named tests, and only `syn-ledger` and `syn-shelf` were rebuilt twice. The 2026-10-28 "A5 PASS" therefore overstated the evidence. The tool now builds all six fixtures twice (the four, each `syn-ledger-inc` variant).
- **B1:** it counted Rule 4 hits on P3 or P4 as "negative controls", and counted hits rather than distinct findings. It now uses N1, N2, EN1 and EN2 as the controls, and counts other false findings as distinct findings, as the text says.
- **B9:** "`check` green on every row" was not evaluated. Each row's records are now checked with the helper's own `check`.
- **B11:** the text requires the Sonnet rows to meet every B1–B3 threshold. Only `scoring.g5` was checked, which does not include B3. Both are now required.

**Part A re-evaluated** on the final code of this pass, with new TAP files and the 2026-10-28 rehearsal output: **A1–A11 PASS**.
- A1, Windows (Git Bash and PowerShell): 451 tests, 446 pass, 0 fail, 5 skipped.
- A2, Linux (Node 20.20.2 and 22.23.4): 451 tests, 444 pass, 0 fail, 7 skipped.
- The fixtures folder is still byte-identical to the baseline (168 files).
- A5 is now a direct check: six builds twice, the sealed heads, identical trees, in about 20 s.

**The historical diagnostic, rerun** (not RQ-1 evidence): the same picture. B1, B2, B3, B5 and B8 FAIL; B4 PASS; B6, B9, B10 and B11 BLOCKED (SS2 missing); B7 and B12 BLOCKED.

### Stable scope: the remaining Flow defect
A Flow `#Symbol` selector re-pointed on resume reproduces on rc.1 (a function `handle` became a same-name class method). It cannot reach Task or Incremental Review:
- entries are resolved only in flow mode (`runs.mjs`, `close.mjs` and `resume.mjs` all gate on it);
- `new-run` refuses `--entry` outside flow;
- a flow run never builds on, or is built on by, another mode.

It stays a documented Flow Beta limit.

### Real runs: compatibility and triage
- **Compatibility:** all five real runs in the owner's project pass the rc.1 helper's stricter `check` (read-only), so the new rules reject none of them.
- **Triage sheet:** prepared outside the kit, because it holds the project's findings. It lists 16 findings, 15 `decide` commands (every fingerprint verified against the records) and two groups of related findings.
- **Owner decisions:** none recorded. B12 eligibility and its counting unit are open (RELEASE.md, D3).

### B7 fixture
[tests/SECURITY-FIXTURE-SPEC.md](tests/SECURITY-FIXTURE-SPEC.md) states the independence rules, the content constraints, the sealed-answers shape, the sealing and the handoff. It names no case.
- **Rows:** the gate text gives no B7 row count. Settling one changes rows, so it needs `nthr-release-gate@2`.
- **Tooling** (not built): an external fixture source, matrix rows and deny rules, B7 computed from scores, and an operator-run integrity check.
- **Scorer:** `predicateHolds` compares any field a predicate names, so an `impact_dimension` predicate works. A unit test must pin that before use.

### Freeze readiness
- **Commit safety:** all 258 candidate files (the skill, its tests and tools, the M5-T4 evidence, `review.md`, the two READMEs) hash to the same blob with and without `.gitattributes` filters, so they commit byte-identically. No stray temporary files.
- **Implementation manifest** (`matrix.mjs implementation`): 121 material files (57 clean, 25 modified, 39 untracked); `frozen: false` until the owner commits. The 93 evidence files are not material, but must be committed with it (blocker B2 of the repeat plan).
- **Environment:**
  - Claude Code auto-updated to **2.1.312**; the repeat plan's pin is now "the version the probes record" (G5-REPEAT-PLAN §5, §11);
  - the matrix configuration does not disable auto-update;
  - its Opus default effort is now `xhigh`. The matrix passes `--effort high` to every Opus session and Sonnet's default is `high`, so the routing is unaffected, but the configuration digest changed.
- **Open owner decisions D1–D5:** RELEASE.md §10.

## Release gate @2 and its tooling (2026-10-29)
The owner took decisions D1–D5 (RELEASE.md §10), and this pass implements them. It is free, offline work: no paid call, Git write, Global Update or project Update was made. The real runs were read, never written. G5 = FAIL; Full Audit stays disabled. The verdict is still **NOT YET STABLE**.

### The gate
[tests/RELEASE-GATE-2.md](tests/RELEASE-GATE-2.md) (`nthr-release-gate@2`) was frozen at 2026-10-29T00:43:19Z, before any Part B row under any gate version. Its sha256 is `b92fb9daa0a8fde54579c2dbfe267e50a987d15898ba13b67473ba74bba99f51`, pinned in `tests/tools/gate-version.mjs` with @1's. @1 (`tests/RELEASE-GATE.md`, `cd9e067c…95ae`) is unchanged and stays as history. What @2 changes:
- **Rows:** the 14 core rows, plus SB1 and SB2 (Opus, high effort, on the curated security fixture), which count for B7 only.
- **B7 (D2):** computed from the recorded curated package, the repeat ledger and the security rows' official scores. A test-double package, a moved or changed package, or missing evidence is BLOCKED.
- **B11 (D1):** each Sonnet row must also meet B5's coverage thresholds on syn-shelf, and `scoring.g5`. Its remedy is unchanged.
- **B12 (D3):** at least 3 independent completed Task or Incremental runs. The unit is each confirmed finding of each counted run; a fingerprint's latest decision in its namespace applies; at most 20% false positives. Undecided findings, too few independent runs or no confirmed finding is BLOCKED.
- **Execution (D5):** auto-update off in the matrix configuration, exact versions recorded at registration and re-checked, and model pins.
- B1–B6 and B8–B10 are unchanged.

### Tooling
- **`tests/tools/release-gate.mjs`:** evaluates @2. B7 (`judgeB7`) and B12 (`judgeB12`) are computed only from evidence: a typed `b7` or `b12` value in the row manifest is ignored and reported. Each result names the gate and whether the gate file still has its pinned sha256.
- **`tests/tools/matrix.mjs`:**
  - rows SB1 and SB2, gated as their own chain;
  - `record-curated-package` (digests only, never the path; refuses a package inside the kit, a Git work tree or the temporary folder, and any recording after the security rows registered or started);
  - `register-supplement`;
  - deny rules and audit flags for the package folder;
  - security-row evidence under the matrix root's `curated/`, never in the kit;
  - `register` refuses unless the configuration sets `env.DISABLE_AUTOUPDATER` to `"1"`, and records the Claude Code, Node.js and Git versions, the OS and the model pins. The Claude Code version is re-checked before each row, audit and score, and transcript versions and resolved models are checked against the pins;
  - `verify-ledger` checks the security rows' order and digests.
- **`tests/fixtures/build.mjs`:** a new `buildCuratedFixture` builds a fixture from Git bundles. It verifies each bundle, fetches the recorded head, checks it out and installs the skill; nothing from the package runs, and no remote, FETCH_HEAD, reflog entry or package path stays in the fixture. The existing builders are unchanged. With the Tools section of `tests/fixtures/README.md` (now naming the security rows, the new commands and the gate texts as material), it is one of the two fixtures files that changed (166 of 168 are byte-identical to the baseline), and A5 still builds every sealed fixture with its sealed heads and trees.
- **`tests/tools/score.mjs`:** each scored item carries its `gate_dimension`.

### Tests
- New `tests/rq2-runner.test.mjs` (6 tests): package recording and its refusals, deny rules and audit flags, the bundle builder's determinism and leftovers, supplement registration and gating, ledger verification, version and model pins.
- `tests/release-gate.test.mjs` (13 tests, was 8): the gate pins, B11 coverage, B7 PASS, BLOCKED and FAIL worlds, typed values ignored, B12 on synthetic records and on real records with `nthr decide`.
- `tests/matrix.test.mjs` (33 tests): the 16-row plan, the auto-update refusal, recorded versions.
- `tests/score.test.mjs` (39 tests): one new test.
- **Negative controls:** 23 deliberate breaks of the new rules, each applied to a scratch copy of the kit; every one made a test fail. The copy was restored and compared byte-identical.

### Real runs and B12
Evaluated read-only on the owner's records, with a draft run manifest kept outside the kit (no `decisions.json` was created): **BLOCKED**, "3 listed, 3 completed Task/Incremental, 2 independent". Task v2 is contaminated (its lead read Task v1's records before outlining, D3). The triage sheet, also outside the kit, now lists the 5 confirmed findings that count (v1: 2, v3: 3) with verified `decide` commands.

### Independent review of the evaluator and runner
A read-only review against the frozen @2 text found places where the tooling was more lenient than the text. Each is fixed, with an assertion in the existing tests:
- **B12:** one run listed several times, or under two spellings of its root, was counted each time, so one run could make three. It is now BLOCKED ("listed more than once").
- **B11:** `b11_routing_removed` made B11 PASS even with no Sonnet row. It now applies only after both Sonnet rows were scored and one failed, as the remedy says.
- **B7:**
  - only the row's last attempt counts: a scored attempt that was later voided is no longer used;
  - the records file must be the one the adjudication froze (`records_sha256`);
  - metrics without routing data are missing evidence, not "0 routing violations". B6 had the same gap and is fixed the same way.
- **Official scores:** every criterion now refuses a row whose score is not official, so a Rule 4 v2 diagnostic or an unverified score never counts.
- **Package location:** a package was taken to be outside Git whenever `git rev-parse` failed (for example on dubious ownership). Now only Git's "not a git repository" answer counts.
- **Smaller fail-open cases:** a `--change` naming an inherited object key (`constructor`) was accepted. `register` and the per-row version check accepted a missing Claude Code.

**Negative controls:** each of the 12 fixes was reverted in a scratch copy, and every one made a test fail. The copy was restored and compared byte-identical.

**Not changed:** the core rows' score files are not bound to the ledger by digest. The @2 text asks for that only for the security rows.

### Part A on the final code
**A1–A11 PASS** (`release-gate.mjs offline`, gate @2, gate file sha256 as pinned):
- A1, Windows (Git Bash and PowerShell): 463 tests, 458 pass, 0 fail, 5 skipped, in each.
- A2, Linux (Node 20.20.2 and 22.23.4, WSL Ubuntu 24.04): 463 tests, 456 pass, 0 fail, 7 skipped, on each.
- A3, the lifecycle rehearsal (Windows, rerun because runtime scripts changed since 2026-10-28): 75 rows, 72 pass, 0 fail, 3 unverified (Unicode normalization, two symbolic-link rows), as before.
- A4: the sealed G5 evidence is byte-identical (93 of 93 files, checked against the hashes taken before this pass).

### Freeze readiness
- **Commit safety:** all 185 changed or new files under `agents/claude/integrations/` (42 modified, 143 untracked, including the M5-T4 evidence) hash to the same blob with and without `.gitattributes` filters.
- **Implementation manifest:** 123 material files (57 clean, 25 modified, 41 untracked; the two new ones are `tests/tools/gate-version.mjs` and `tests/RELEASE-GATE-2.md`); `frozen: false` until the owner commits.
- **Still the owner's before `register`:** set `env.DISABLE_AUTOUPDATER` to `"1"` in the matrix configuration (it is not set; Claude Code 2.1.312 is installed), commit, and approve the isolation probes.

## Release gate @3: the auto-update requirement removed (2026-10-29)
Owner decision, the same day: the benchmark is a temporary development and release benchmark, so it runs under the existing Claude Code configuration (`<config>`), unchanged. Gate @2 made `register` refuse unless that configuration's `settings.json` set `env.DISABLE_AUTOUPDATER` to `"1"`. That is the owner's everyday configuration, so the requirement is removed. No paid call, settings change, Git write, Global Update or project Update was made. G5 = FAIL; Full Audit stays disabled. The verdict is still **NOT YET STABLE**.

### The gate
[tests/RELEASE-GATE-3.md](tests/RELEASE-GATE-3.md) (`nthr-release-gate@3`) was frozen at 2026-10-29T02:07:28Z (sha256 `031e85e5dfd78c77d40acc6a6d0169368232f73c308de91a404dd729d1412e89`), before any registration or Part B row.
- **Changed from @2:** the title, the status and freeze-rule lines, and the §4 environment block. `register` reads no auto-update setting, and a Claude Code update during the matrix stops it at the next row, audit or score.
- **Unchanged:** every row, criterion and threshold. @2 (`b92fb9da…9f51`) and @1 (`cd9e067c…95ae`) stay in the kit, frozen. `tests/tools/gate-version.mjs` pins all three, and a test fails if any changes.

### Tooling
- **`tests/tools/matrix.mjs`:**
  - `autoUpdateProblem` is removed, with its checks in `register` and `register-supplement`. The release gate texts, @3 included, are material files.
  - Unchanged:
    - the recorded versions (Claude Code, Node.js, Git, the OS, the model pins);
    - `register`'s refusal when Claude Code cannot be found;
    - the version checks before each row, audit and score;
    - the transcript version and model-pin checks.
  - **Kept:** the runner still sets `DISABLE_AUTOUPDATER=1` on the Claude Code processes it starts (`claude --version` and the sessions). That predates D5: the runner already did it before any D5 change, so it was not added to satisfy the removed requirement. It changes no settings file.
- **`tests/tools/release-gate.mjs`:** evaluates @3; no rule changed.

### Tests
- `tests/matrix.test.mjs`: `register` succeeds on a configuration whose `settings.json` sets no auto-update variable, and the registration names @3.
- `tests/rq2-runner.test.mjs`: the supplement registers without an auto-update setting, and is refused on a missing or different Claude Code version.
- `tests/release-gate.test.mjs`: @1 and @2 are pinned as history and @3 as the gate; every result names @3.
- **Not exercised:** the per-step version checks inside `drive` call `claude --version` and run only around paid sessions. They are unchanged, and `versionProblem`'s unit tests cover their rule.

### Validation
**Part A, A1–A11: PASS** (`release-gate.mjs offline`, gate @3, gate file sha256 as pinned):
- A1, Windows (Git Bash and PowerShell): 463 tests, 458 pass, 0 fail, 5 skipped, in each.
- A2, Linux (Node 20.20.2 and 22.23.4, WSL Ubuntu 24.04): 463 tests, 456 pass, 0 fail, 7 skipped, on each.
- A3: the 2026-10-29 rehearsal output (75 rows, 72 pass, 0 fail, 3 unverified), reused because no runtime file changed since.

**Other checks:**
- **Part B** (`evaluate`, empty manifest): every criterion BLOCKED, gate @3.
- **B12** on the owner's records: still BLOCKED, "3 completed, 2 independent".
- **Sealed G5 evidence:** 93 of 93 files unchanged.
- **Candidate:** 188 changed or new files (44 modified, 144 untracked), all under nth-review. Each hashes to the same blob with and without `.gitattributes` filters, and none contains CR.
- **Implementation manifest:** 124 material files; `frozen: false` until the owner commits.

## Isolation: other Claude Code configurations denied (2026-10-29)
The matrix sessions' deny rules, the second isolation layer after the session guard, covered development transcripts, history and file history only inside the matrix configuration (`CLAUDE_CONFIG_DIR`, here `<config>`). Another configuration, such as `~/.claude`, which holds 16 project folders for this machine's development work including the kit's own, was not denied. The session guard was already refusing every file read outside a row's own folders, so this was a gap in the backup layer, not a demonstrated leak. No paid call, settings change, Git write, Global Update or project Update was made, and no real configuration was read beyond folder names.

### The fix (`tests/tools/matrix.mjs`)
- **`otherConfigurations()`** lists the home folder's `.claude*` entries, matching names case-insensitively:
  - every folder except the matrix configuration itself is denied whole, which covers its transcripts, memory, tool results, history and settings;
  - every file there (`.claude.json` and its backups, the state files) is denied.
- **In the matrix configuration:** every project's `memory/` folder and the state file `.claude.json` are now denied too.
- **Unchanged:**
  - the session guard;
  - the rules for the kit, rows, earlier fixtures and the matrix root;
  - the session's own fixture, its review scratch (`.nth-review/`), its own project folder and its own Claude Code temporary folder, which stay readable.
- Gate @3 is unchanged: its isolation text names no deny-rule list.

### Tests
- **`tests/matrix.test.mjs`:** a new test with two subtests, one with the matrix configuration at `<config>` and one at `~/.claude`. Each runs in synthetic home, configuration and temporary folders.
  - **Denied** (all readable under the previous rules): another configuration's transcript, memory, tool result, history and settings, for every other `.claude*` folder; `~/.claude.json` and its backup; the matrix configuration's `.claude.json`; another project's memory there.
  - **Still readable:** the session's own fixture and scratch, its own project folder's tool results and its own temporary folder. The matrix configuration is never denied whole.
- The synthetic test environment now also sets the home folder (`HOME`, `USERPROFILE`), so these tests read no real configuration.
- **Negative controls:** 8 deliberate breaks, each applied in a scratch copy of the kit; every one made a test fail, and the copy was restored identical. The breaks:
  - other configurations not denied;
  - project memory not denied;
  - each state-file rule removed (two breaks);
  - the matrix configuration denied whole too;
  - only an exact `.claude` name matched;
  - a case-sensitive name match;
  - state files dropped.

### Command length, measured on the owner's machine
Every row and role was measured, reading folder names only:
- **This fix:** 2 other configuration folders and 1 state file here. It adds at most 467 characters to a session's command line.
- **A separate defect, open, from gate @2's security rows:** SB2's adjudicator command line is about 52,500 characters without this fix, over the 32,000 limit. Its code `rp-` matches 125 unrelated `rp-*` entries in the temporary folder, left by another project, each denied by exact path. The runner refuses that session safely, but only after SB2's paid review has run. It is recorded as a B7 blocker in RELEASE.md §10 and is not fixed here. Every other row and role fits.

### Validation
**Part A, A1–A11: PASS** (gate @3, gate file as pinned):
- A1, Windows (Git Bash and PowerShell): 466 tests, 461 pass, 0 fail, 5 skipped, in each.
- A2, Linux (Node 20.20.2 and 22.23.4): 466 tests, 459 pass, 0 fail, 7 skipped, on each.
- A3: the 2026-10-29 rehearsal output, reused because no runtime file changed.

**Other checks:**
- Sealed G5 evidence: 93 of 93 files unchanged.
- Gates @1, @2 and @3: unchanged.

**Limits:**
- Only configurations in the home folder named `.claude*` are found. A configuration elsewhere is covered by the session guard alone.
- In the matrix configuration, transcripts of projects outside the kit's parent folder are also covered by the session guard alone: one pattern for them would also deny the session's own project folder.

## Security rows' folder names and the command-line preflight (2026-10-29)
**The defect:** on the owner's machine, SB2's adjudicator command line was about 52,500 characters, over the runner's 32,000 limit.
- **Cause:** its folder code `rp-` matched 125 unrelated `rp-*` entries in the temporary folder, left by another project. A session's own row code is denied folder by folder, by exact path, so each entry added three rules.
- **When it failed:** the runner refused the session safely, but only when the adjudication started, after SB2's paid review.

No paid call, Git write, Global Update or project Update was made. No other project's folder was touched, and only folder names were read.

### The fix (`tests/tools/matrix.mjs`)
- **Names (`folderPrefix`):** a security row's folders carry a fixed mark and its matrix's token, for example `rp-nthsec-<token>-…`. The token is the first 8 hex digits of the sha256 of the `registered-supplement` ledger line, so each matrix registration has its own. Core rows keep M5-T4's one-letter codes, so earlier matrices' folders stay under the same rules.
- **Deny rules:**
  - **Unchanged** for every session but the security rows' own: the two-letter rule (`rp-*`) still covers the new names.
  - **A security row's own session** denies its earlier folders by the marked prefix (`rp-nthsec-`, any token: earlier attempts and earlier matrices), each by exact path, as before.
- **Preflight** (`commandLineBounds`, `commandLinePreflight`):
  - `drive` bounds every reviewer and adjudicator command of the batch before the first paid session, and refuses the batch if one is over the limit. It bounds each row's commands again before that row's review.
  - `drive --dry-run` reports the bounds as its `command_lines` gate.
  - A bound is never below the real command. It takes:
    - the deny lists as they stand, exempting no own folder;
    - the attempts the drive itself will void (an interrupted row is voided before it runs again; any other void stops the drive);
    - the helper's longest run id, 92 characters, where a run is not known yet;
    - the drive's whole spending cap in the budget flag;
    - the runner's settings-file name.
  - The existing check before each session stays.

### Coverage
- **Every session but the security rows' own:** the deny list is unchanged.
- **A security row's own session:** still denied:
  - every folder of every other row;
  - its own earlier folders;
  - the kit, the development transcripts and history, the other Claude Code configurations, the matrix root and the curated package.

  What it no longer denies: other projects' folders that merely share its two letters, such as the 125 `rp-*` entries. They were denied only because of the name collision, and they are not nth-review data. Every other session still denies them by the two-letter rule. For this session they are refused by the session guard (the first layer), which allows only the session's own folders.

### Measurements on the owner's machine (folder names only, no session)
- **Before:** SB2 adjudicator 52,554 characters.
- **After:** bounded at 30,225.
- **Longest bound of all 32 sessions:** 31,509 (the SO2 adjudicator; its real command is about 31,244). All are under the limit.
- **Old failure detected:** with the old naming and lookup put back in a scratch copy, the new preflight refuses SB2's adjudication before any session: 54,330 characters, longer there only because the copy's path is longer.

### Tests (`tests/matrix.test.mjs`, 3 new)
- **Names:** core rows unchanged; security rows marked; the token differs between matrices; refused before the security rows are registered.
- **Deny lists with 300 look-alike `rp-*` folders:** SB2's adjudication rules are identical to those without them.
  - **Denied:** its earlier folders (another token) and every other row's folders, the security rows' included.
  - **Readable:** its own sandbox, scratch and project folder.
  - **Every other session:** denies the security rows' folders and the look-alikes.
- **Preflight:**
  - 32 bounds; none over the limit in a normal folder.
  - The bound is at least the real command for a row's review and adjudication.
  - An interrupted attempt the drive will void adds exactly its rules.
  - 300 look-alikes of each security code change no security-row bound.
  - 300 look-alikes of a core row's code (`ra-*`) make the preflight refuse that row's adjudication before any session.
- **Negative controls:** 8 breaks applied in a scratch copy; every one made a test fail, and the copy was restored identical.
  - the old naming;
  - the old own-folder lookup;
  - a preflight that never refuses;
  - voids ignored;
  - the adjudication left out of the bound;
  - a too-short run-folder, settings-name or budget placeholder (three breaks).

### Validation
**Part A, A1–A11: PASS** (gate @3):
- A1, Windows (Git Bash and PowerShell): 469 tests, 464 pass, 0 fail, 5 skipped, in each.
- A2, Linux (Node 20.20.2 and 22.23.4): 469 tests, 462 pass, 0 fail, 7 skipped, on each.
- A3: the 2026-10-29 rehearsal output, reused because no runtime file changed.

Sealed G5 evidence (93 of 93 files) and gates @1, @2 and @3 are unchanged.

### Limits
- **Core rows keep their one-letter codes.** Another project's look-alikes of a core code still lengthen that row's own command. The preflight now refuses such a batch before anything is paid, and archiving those folders, which is the owner's decision, clears it.
- **Headroom:** about 490 characters for the SO2 adjudicator. The kit's own path counts: a kit copy at a longer path went over. Each earlier attempt of a row adds about 850.
- **Repair turn:** an adjudicator's repair turn is not bounded, because its prompt lists the adjudication's problems. It is still checked before it starts and skipped without a paid call.
- **Folders created later:** folders another program creates after the preflight are caught by the per-row and per-session checks. For an adjudication, that check comes after its review.
- **Evidence archive:** `tests/tools/evidence.mjs` recognizes M5-T4's folder names only. The security rows' adjudications and scores go under the matrix root's `curated/`.

## Repository move (2026-10-29)
nth-review moved from nth-dev-kit to its own repository, with the runtime byte-identical. The move and its validation are recorded in [MIGRATION-VALIDATION.md](MIGRATION-VALIDATION.md), separately from this historical log; paths above that start with `agents/claude/integrations/review/` are this repository's root.
