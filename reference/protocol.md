# nth-review protocol (runtime reference)

This is the review method, condensed from Protocol v0.1 and contracts C1–C21. It states each rule once. Read it, and every reference, by section: search for the heading and read only that section, never a whole file.
- **Fields and every rule `check` enforces:** [records.md](records.md#check-rules).
- **The procedures the lead follows:** [SKILL.md](../SKILL.md) §3 (Task) and §4 (Incremental).
- **Models and delegates:** [routing.md](routing.md).
- **Delegation prompts:** [prompts.md](prompts.md).

## 0. What is operational

| Capability | State |
|---|---|
| Task Review, `/nth-review task` | operational |
| Incremental Review, `/nth-review incremental --base <run>` | operational (§10). Its lead is always Opus at high effort; the Sonnet case for a quiet run is not implemented. |
| Flow Review (BETA), `/nth-review flow --entry <selector>` | operational in Beta (§10): review from explicit entry points on the current source, over a bounded, recorded path graph. Always Opus at high effort. |
| `resume` (continue, or abandon and continue) | operational. The skill picks up an open, escalated or interrupted run (§11), and asks the user before abandoning one. |
| `decide` and `status` | operational. Nothing acts on a decision. |
| Full Audit (`audit-plan`, `audit-unit`) | **Disabled.** `OFFICIAL_AUDITS_ENABLED` is false, so `charter` and every `audits/` run are refused, and the skill stops on an audit request. The procedure (§10) and the helper's audit rules are written, and tested on synthetic fixtures only. |
| R4 judgment critic | written (prompts.md, R4); it runs only in Full Audit Tier-1 units, so it is disabled with Full Audit |
| Suppressing an `accept`ed finding in later runs (C3) | not implemented. Only `status` reads `decisions.json`. |

Never present a capability marked "not yet" or "disabled" as available.

## 1. Principles

- **Obligations are the unit of coverage.** Each conclusion is an obligation with a claim, an acceptance criterion, a coverage target and cited evidence. Reading code without an obligation is not coverage.
- **Business intent comes first, then implementation behaviour.**
  - Intent comes from the owning documents, cited as `scope.intent` anchors, or from the owner.
  - Behaviour comes from code anchors.
  - A **defect** is behaviour that violates a documented or derived intent.
  - An exposure with no stated intent is a **risk**: the owner decides.
  - Documents and code that disagree are **doc-drift**.
  - Never invent intent to turn a risk into a defect.
- **The project is read-only.** Git is only read, with no filters, hooks or fetches. Secret files are never opened, and no tests or services are run.
- **Records are the truth.** The lead writes only a `patch.json`, which `apply` validates and applies to `records.json` in one write; it can change only the lead's fields ([records.md](records.md#apply)). Packs, the footprint, freshness, `report.md` and status changes come from the helper.
- **Independent findings.** A Task Review never reads earlier runs' records, reports or packs: a finding repeated from them is not an independent detection. Only an explicit request to compare with a named run allows reading it, after the run's own findings are recorded, and `scope.summary` says so. Incremental Review inherits its base and origin runs by design (§8, §10).
  - **What the helper enforces:** the record channels. A Task run has no `freshness`, and no debt-in unless it is opened with `--base` or `--continues`, which carries that run's debt-out (records.md, `new-run`); the skill's Task form names neither, and `resume` uses `--continues` for the same review. What the lead or a delegate reads is not observable, so not reading earlier runs is discipline, not a check.
- **Every concern family counts,** not only security or style (§4).

## 1a. Namespaces

`.nth-review/<kind>/<id>/`, where the kind is `experiments`, `reviews` or `audits` (N1, from the path):

| Kind | Holds |
|---|---|
| `experiments/` | every mode |
| `reviews/` | `task` and `incremental` |
| `audits/` | the audit modes, only with a `charter.json` written by `charter` (N3) |

- `base` and `continues` name a run in the same namespace (N2).
- The legacy top-level `runs/` is never a base (N5).
- Run ids are `YYYYMMDD-HHMMSS-<mode>-<slug>`, in UTC (N7).
- At most one `open` run per namespace (C5).

## 2. Run lifecycle

| Step | Who | Helper |
|---|---|---|
| 1. **Open** | helper: snapshot, budget, required lead model, inherited debt | `new-run` |
| 2. **Plan** | lead: intent extract, triggers, obligation outline | checkpoint |
| 3. **Census** | lead, optionally with an R2 assist | checkpoint |
| 4. **Plan-critique** | R3, mandatory, before discharge | checkpoint |
| 5. **Discharge** | lead: each obligation against its acceptance; candidate findings | checkpoint |
| 6. **Verify** | R5 and R6 refuters, evidence first | `pack`, checkpoint |
| 7. **Close** | lead: debt-out and cost; then the helper's recheck, footprint, check, report | `footprint`, `check`, `close` |

- **Checkpoint:** write `patch.json`, run `apply --run <dir>` (it writes `records.json` and runs `check`), and fix what the check reports. The skill sets where they go.
- **Close** is the only way to `complete` or `incomplete`; `resume --apply` is the only way to `abandoned`. A closed run never changes (C1).
- **One run per session.** Larger work is a chain of runs that continue each other.

## 3. Budgets and stop rules

Set by `new-run` from the mode and the change size (C14):

| Run | Lead tool calls | Subagent calls | Obligations | Lead model |
|---|---|---|---|---|
| Task S (≤ 400 lines, ≤ 15 files) | 40 | 3 | 15 | Sonnet, or Opus High if any trigger |
| Task M (≤ 1,500 lines, ≤ 40 files), L, or unverified size | 70 | 5 | 30 | Opus High |
| Incremental | 20 + 2 per changed file + 3 per debt-in item, at most 80 (80 when the size is unknown) | 3 | effective-baseline obligations + 15 | Opus High |
| Audit plan | 50 | 2 | 0 | Opus High |
| Audit unit | 60 | 4 | 25 | Opus High |

An uncertain size is never small. A filtered file, or a flagged (assume-unchanged or skip-worktree) file in the working tree, makes the size unverified.

A range is sized as its net diff (`git diff --numstat <a> <b>`), never as the sum of its commits. `.nth-review/` and this integration's untracked installed files in the root repository (`.claude/skills/nth-review/`, `.claude/nth-dev-kit-hooks/review.state.json`) are never counted; a tracked copy is.

**Stop rules:**
- **B1.** At 70% of lead tool calls, stop discharging. The remaining obligations become `open` / `budget`.
- **B2.** 30% is the reserve for verification and close, never for discovery.
- **B3.** After plan-critique the outline grows by at most 20%, and anything beyond that is `deferred-scope` debt. This is the lead's discipline; `check` caps only the total.
- **B4.** Subagent calls are a hard cap. A candidate that cannot be verified stays `candidate`.
- **B5.** Record what was spent:
  - every tool call after `new-run`;
  - subagent calls and their tokens (null when not reported, never 0).

  `close` computes the open-to-close minutes (`wall_clock_min`) itself. Session time and money are not measured.

Over budget, the run closes `incomplete` with reason `budget`.

## 4. Planning: intent, concern families, obligations

**Reading the change.** Read each change as one net diff: `git diff --stat <a> <b>` first (a working tree: against `HEAD`, plus the untracked files in the snapshot), then the diffs of the files in scope. Never read it commit by commit (`git log -p`, `git log --stat`).

**Intent extract.** Find the owning document sections by heading search, read only those, and record them once as `scope.intent`.

**Concern families.** Screen all 17 families of [taxonomy.md](taxonomy.md) against the changed behaviour, and record each as one of its four screening outcomes (`deferred-scope` debt for a family left out for the cap or budget).
- Outline obligations for each family the change can affect; add module checks when the census finds a module's boundary.
- Obligation `checks` are taxonomy check ids (`AUTHZ.2`, `LLM.2`), or a module applied as a whole (`LEDGER`).

**Lead-model triggers:** `authorization`, `money`, `schema-migration`, `concurrency`, `boundary-contract`, `ai-dispatch`, `task-size`. Any trigger requires Opus High (C15; [routing.md](routing.md)).

**Obligation status:**
- **`held`:** the acceptance is met by cited evidence.
- **`violated`:** a finding shows it.
- **`open`:** with a reason: `needs-runtime`, `needs-owner-intent`, `needs-owner-fact`, `budget`, `frontier` or `verification`.
- **`accepted`:** cites the document that accepts the limitation.
- **`out-of-scope`:** an explicit exclusion.
- **Concurrency and performance claims** are never `held` on source alone. They are `open` / `needs-runtime` with `source_trace: consistent` when the trace is clean.
- **`coverage`** says how much of the population was examined: `all-enumerated`, `named-subset`, `sample` or `excluded`. It is reported apart from correctness, and only `held` + `all-enumerated` is "Verified" (C13).

## 5. Census and independent coverage criticism

**Census:**
- **Classify every changed file** as a census item. Each one affects obligations, or has `affects: null` with a reason. In Incremental runs, `check` requires this for every changed file (C11).
- **Searches** go in `census.recipes` with sequential ids (`C1`, `C2`, …), each with its pattern (prefixed by its kind), scope, hits and **limits**. The kinds, the procedure, and when `all-enumerated` is justified are in [census.md](census.md).
- **Helpers and contracts:** cite the helpers and boundary contracts an obligation relies on as `dependency` assumptions, so that later freshness reopens the obligation when they change (C11).

**Plan-critique (R3) is mandatory**, once, with a fresh context, after the census and outline and before any discharge. Its enumerative questions and how its answer is recorded are in [census.md](census.md) §5.

Accepted additions go in before discharge, within B3. Judgment critique (R4) belongs to Full Audit Tier-1 units (§10).

**Discovery handoff.** A path an R2 or R3 answer names (its additions, contradictions, sites or `uncensused` files) that no census item covers is recorded in that delegation's `discovered`. Before close, the lead gives each one a census disposition: covered (an item naming obligations), excluded (with a reason), or unresolved (`unknown`, with `frontier` or `deferred-scope` debt whose `requires` names it). `check` refuses a closed run that leaves one without a disposition. A file a delegate read is never coverage until the lead records it. `check` sees only the paths the lead records, never the delegate's answer: a path left out of `discovered`, or a delegation removed, is not detected.

## 6. Discharge and evidence

- **Read by symbol or anchor range.** Read a whole file only when the population needs it, and never re-read a cited range.
- **Evidence:** `path:L1-L2` anchors, or `path#Heading` for documents, relative to the project root and starting with the repository directory (C8).
- **`source_trace`:** `consistent`, `inconsistent` or `not-traced`. This separates "the trace is clean but runtime is pending" from "not examined".
- **Assumptions:**
  - a `dependency` cites a file;
  - an `environment` assumption states a fact outside the repositories, with `observed` set to `yes`, `no` or `unknown`. Unknown facts appear in the report under untested properties.

## 7. Findings

*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).*

| Category | How it is recorded |
|---|---|
| **Source-proven defect** | `defect`, `confirmed`, with a severity. The trace (entrypoint → propagation → sink) is read in source, and verification follows [routing.md](routing.md). |
| **Runtime hypothesis** | `needs_validation` with a `validation_plan` and no severity; or an obligation `open` / `needs-runtime`; or `runtime` debt |
| **Owner-dependent business decision** | `risk` (no stated intent, no refuter, no severity), or `open` / `needs-owner-intent`, or `owner-decision` debt. A missing fact is `needs-owner-fact` / `owner-fact`. |
| **Documentation drift** | `doc-drift`. Mechanical evidence (exact lines on both sides) may skip the refuter. |
| **Unverified or deferred scope** | a `candidate` (including one whose verification is incomplete); an `open` obligation (`frontier`, `budget`, `verification`); partial `coverage`; or `deferred-scope`, `frontier` or `budget` debt |

**Confirmation rule.** A finding becomes `confirmed` only when all of these hold:
1. its trace is source evidence the lead has read;
2. the refuter its routing requires answered `confirmed` or `corrected`, with anchors that support the outcome, and its verification is not incomplete;
3. its truth does not depend on a fact outside the source. Deployment, configuration, runtime behaviour, data or owner knowledge make it `needs_validation`.

**Agreement between agents is not evidence.** Never strengthen a refuter's outcome. A `rejected` finding keeps its counterevidence, so the same claim is not raised again.

**Second refuter.** Required when an R5 answer changes the root cause, trace, impact or severity of a `critical` or `high` finding. It gets a fresh pack and never sees the first answer. The finding records the second answer as its `verification`, and both calls are recorded as delegations. This is the lead's rule; `check` does not enforce it.

**Severity** is only for a confirmed defect or doc-drift, and never exceeds the demonstrated impact. The anchors for `critical`, `high`, `medium`, `low` and `informational` are in [taxonomy.md](taxonomy.md#severity).

`impact_dimension` records the primary impact. A finding's `decision` is the value at close; later decisions go to `decisions.json` (§9).

## 8. Review debt, freshness and continuation

**Debt kinds:** `runtime`, `owner-decision`, `owner-fact`, `deferred-scope`, `frontier`, `verification`, `budget`. Each has `refs`, `requires` and `priority`.

**Debt continuity** (C4):
- Debt-in is exactly the immediate parent's debt-out.
- Each item is `discharged` (with a note), `obsolete` (with a note), or `carried`, reappearing in debt-out under the same id.
- Debt never disappears.
- A run that carries inherited debt is never `complete`. A complete run may still hand on new debt of its own.
- **Full Audit** (C20): the chain is linear, so every audit run inherits the debt of every earlier unit. A unit run's `complete` is blocked only by carried debt from an earlier run of the **same** unit, and a plan run's by none. The audit close keeps the strict rule.

**Snapshot:**
- Taken at Open.
- It covers tracked state, including assume-unchanged and skip-worktree files by their own content, plus untracked names and content within limits.
- `close` rechecks it: a tracked change is refused unless closed `incomplete` / `snapshot-changed`; an untracked or uncertain change needs `--reassessed`, which covers scope and census only. A cited file that may have changed unseen (untracked, absent or unverified where the untracked state differs or could not be hashed) is a `resume`, never `--reassessed`, in every mode.

**Freshness** (Incremental: `fresh`). It compares the base run with the tree now, and each inherited obligation with its origin:
- **Effective baseline:** the latest recorded version of every obligation along the base ancestry (through Incremental runs, up to a Task run). The nearest run that records an id is its origin; an unchanged obligation is never copied forward, and is never lost. Broken ancestry (missing, invalid, another namespace, open, abandoned, a loop, too long) is refused ([records.md](records.md#fresh)).
- **History outcome per repository:** `equal`, `ancestor`, `diverged`, `base-missing`, `base-dirty`.
- **Every changed file** is listed.
- **Each inherited obligation** is classified against its origin run's footprint and history; one still `open` in its origin is `touched`:

  | Class | Means | Reassessment |
  |---|---|---|
  | `touched` | a change within 3 lines of a cited range, a rename or delete, or any uncertainty | full |
  | `file-changed` | the file changed elsewhere | quick: read the hunks, confirm or reopen |
  | `assumption-changed` | the lead marks it from facts outside Git | full |
  | `current` | unchanged | none |

- The helper only prioritizes: it never marks an obligation held. `close` refuses a stale or hand-edited freshness.

**Continuation** (`resume --ns <ns>`):
- **continue:** the snapshot holds.
- **reassess:** untracked or uncertain changes; then close with `--reassessed`.
- **abandon:** the tracked state changed, or a cited untracked file changed. This is a plan only; `--apply` performs it.
- **What `--apply` carries** (C5, as amended):
  - every unresolved obligation;
  - unverified claims;
  - every unverified finding;
  - all debt.

  Accepted limitations and out-of-scope exclusions stay as history. The continuation inherits the abandoned run's whole debt-out.

## 9. Owner decisions and accepted limitations

- **`decide`** (only on the user's explicit request) appends a decision to `decisions.json`:
  - `fix`, `accept`, `false-positive` or `known-item`;
  - keyed by finding fingerprint, with `note`, `by`, `supersedes` and provenance.

  Closed runs are never written. **No command acts on a decision, and a decision never authorizes changing code.**
- **`status`** shows runs, outstanding debt, findings and their latest decisions. It is read-only.
- **An `accepted` obligation** (a documented limitation) is not the same as an owner **`accept` decision** on a finding fingerprint (C3).

## 10. Modes

**Task Review** (a commit range or a working tree, per repository): operational. Follow [SKILL.md](../SKILL.md) §3, which runs the §2 lifecycle with three checkpoints.

**Incremental Review** (`--base <run>` in the same namespace): operational. Follow [SKILL.md](../SKILL.md) §4. The order:
1. Open: the lead model is checked first (always `opus-high`); the budget is sized since the base, and its obligation cap is the effective baseline's size plus 15.
2. Run `fresh`. Read `status` once; decisions are never changed.
3. Debt-in is mandatory scope.
4. Reassess `touched`, `file-changed` and `assumption-changed` obligations: each is re-recorded under its id, from its origin's version, reset, and concluded again on evidence recorded in this run.
5. Census every changed file. A `current` obligation that a changed file's item bears on is re-recorded and reassessed too.
6. Outline new obligations, with ids the effective baseline does not use.
7. Plan-critique, if new write or authorization paths appear.
8. Discharge.
9. Verify. A finding of a reassessed obligation (kept in its origin run) whose cause persists is recorded again, with the same fingerprint, as a `candidate`, and verified again.
10. Close.

**What carries over:**
- A `current` obligation stays concluded in its origin run, and the report names that run. Later Incremental runs still find it there, through the effective baseline. Every other conclusion is reassessed, never carried forward. `check` refuses freshness that skips an inherited obligation or names a wrong origin, a non-current obligation that the run drops, a `held` or `accepted` one whose evidence is its origin's unchanged, in any order, and another claim recorded under an inherited id ([records.md](records.md#check-rules)). Re-recorded evidence notes say what this run re-read.
- Owner decisions stay in `decisions.json`, keyed by fingerprint; keeping a finding's fingerprint keeps its decisions attached. Nothing acts on them yet (C3).
- An Incremental run with no changed file, in which every inherited obligation is `current`, may close `complete` without recording any of them again.
- `check` cannot prove that a reassessment happened, or that an indirectly affected obligation was found. Those are the lead's discipline, challenged by R3 when it runs.

**Flow Review** (BETA; `--mode flow --entry <selector>…`, `reviews/` or `experiments/`): reviews what the current source does from 1–8 entry points (a function, a route handler, a web action, a job, an event consumer, or several entries of one workflow). It needs no commit range, and concludes on nothing beyond the paths it records. Follow [SKILL.md](../SKILL.md) §5.
- **Entries:** selectors and their resolution are in [records.md](records.md#flow-entries). A described workflow is never a boundary: propose selectors, run `resolve`, and have the user confirm them, or choose among candidates, before `new-run`.
- **The loop** (interleaved, not graph-first):
  1. Open; the budget comes from the entries (always `opus-high`).
  2. Record each entry's first hop as `census.edges` (`from: E<n>`, a `kind`, an `evidence` anchor at the call, registration, publish or query, and a target anchor).
  3. Outline obligations for what those first hops can affect (§4).
  4. Discharge them on the evidence read so far.
  5. Expand only where an obligation's acceptance needs it: a new edge from an earlier classified edge.
  6. Give every path a disposition: covered (`classified`, naming obligations), `excluded` with a source-based reason (an unrelated branch: out of scope, never merely "already visited"), or `unknown` with the next validation step (dynamic dispatch, injection, a queue or schedule bound elsewhere, another repository's contract).
  7. Plan-critique (R3) over the entries, edges and outline: "changed" reads "reached from the entries". Record the paths it names that no item or edge covers in `discovered`, and dispose of each (SKILL §3.3).
  8. Verify and close as in a Task Review.
- **Edge kinds:** `route` (an entry to its handler), `call`, `data` (a persistence read or write), `event` and `job` (a publish, queue or schedule to its consumer), `dynamic` (a callback, injection or computed target), `external` (another service or repository), `guard` (validation, authentication, authorization) and `error` (an error, retry or rollback path).
- **Cycles and shared code:** an edge into a node already reached (an entry, or an earlier edge's target: the same file and overlapping lines) is a real relationship, recorded as `classified` like any other (A -> B -> A, two callers of one service). It is a revisit: nothing expands from it, so each node is explored once, from the first path to it.
- **Only what the source shows is an edge.** A runtime-only relationship is `unknown`, never `classified`. Reading a file does not make it a dependency, and an edge is recorded only when an obligation needs it.
- **Bounds (enforced by `check`):**
  - depth 4 from an entry: past it, one `unknown` edge records the frontier;
  - `max_edges` edges in all: at the limit, stop expanding;
  - the lead and subagent budgets as for every run (§3).

  An unknown edge, or the reached edge limit, blocks `all-enumerated` and "Verified"; each unknown edge is handed on as `frontier` or `deferred-scope` debt naming its evidence anchor. A run may close `complete` with unknown edges, which are then reported as not reviewed, or `incomplete` with a reason.
- **Boundary:** obligation evidence, dependency anchors and finding traces stay inside the entry files and the edges' evidence and target files. Record the path first; never cite past it.
- **Reuse:** the recorded edges and recipes are the shared discovery. Packs carry the edges bearing on an item, and delegates start from them instead of searching again.
- **Freshness:** as for a Task Review (the snapshot at Open, the recheck at close, and a cited file that may have changed unseen is a `resume`), and stricter at close: every entry must resolve exactly as at Open; a changed entry is an explicit `incomplete` / `snapshot-changed` close and a new flow run, because `resume` does not re-resolve entries. A git-ignored file can be an entry, but never other cited evidence: `footprint` and `close` refuse it.
- **Compatibility:** a flow run is no baseline. An Incremental run cannot build on it, and a flow run builds on no base; it continues only an abandoned flow run (resume). Task and Incremental runs are unchanged.

**Full Audit** (`audits/<id>`, chartered). **Disabled** until the release criteria pass (C19): `charter` and every `audits/` run are refused, so the skill stops on an audit request. The procedure below is written, and the helper's rules are tested on synthetic fixtures only.
- **Authorization:** only the owner's `charter` (`--owner`, `--scope`, `--exclusions`, `--official`); a partial or hand-made charter is refused. The lead never runs `charter`.
- **One linear chain** (C20): the plan is the root, and every later audit run names the chain head as `--base`. The helper refuses a fork and a second root. One run at a time (C5).

**Plan** (`new-run --mode audit-plan`; a re-plan names the head):
1. Show the owner the charter's scope and exclusions, and record them in `scope.summary`. Plan nothing outside the scope; each exclusion becomes an `out_of_scope` unit, or an `excluded` census item, with the owner's reason.
2. Census the whole scope ([census.md](census.md)) and reconcile the owning documents with the surfaces found. Discovery never proves that nothing else exists: unknown items stay `unknown`.
3. The ledger, `scope.units`: each unit has an `id`, `title`, `scope` (its boundary: paths, entries, data), `tier` (priority: 1 for authorization, money, data integrity and other critical surfaces), `basis`, `depends_on`, and a status `planned`, `deferred` or `out_of_scope` (with a reason).
   - **Tier basis:** every active unit (any status but `out_of_scope`) gets a tier and its `basis`: anchors to what shows its priority (an owning document section, or the code that handles authorization, money or stored data), each with a note on what it shows. A file name or a dependency name alone is no basis. When nothing documents the unit's criticality, the note says so. In doubt, choose the higher tier: a re-plan can raise a tier, never lower it.
   - The helper checks only that each active unit has a tier and a basis of anchors with notes, when the plan closes `complete`. It never judges whether the tier is right, and never infers risk from names; R3 may challenge a tier its basis does not support. Basis anchors are not checked to exist and are not tracked for change. A plan closed `incomplete` may leave a unit unclassified rather than guess; that unit cannot run until a re-plan classifies it.
   - A re-plan may defer, reopen or add units, raise a priority, and change dependencies.
   - It never drops a unit, rewrites `runs`, or concludes a unit. It never puts an existing unit out of scope (the owner's exclusions are fixed in the charter; defer it instead), and never lowers a unit's priority, so a Tier-1 unit cannot shed R4.
4. R3 over the census and the ledger (prompts.md, R3 in Full Audit).
5. Close `complete` only with complete discovery and no `unknown` census item. The plan reviews no unit.

**Unit** (`new-run --mode audit-unit --base <head> --unit <id>`). The helper refuses a unit that is not `planned` or `incomplete`, or whose dependencies are not all `complete`. It also refuses an unclassified unit (no tier or no basis): classify it in a re-plan first. A re-plan that raises a reviewed unit to Tier 1 reopens it, so it is reviewed again with R4.
- Follow [SKILL.md](../SKILL.md) §3 inside the unit's `scope`. The budget is 60 tool calls, 4 subagent calls and 25 obligations.
- Never edit the ledger. `close` records the unit (`complete`, or `incomplete` with the run's reason), and adds the run to its `runs`.
- **R4, in Tier-1 units:** once, after Verify and before Close (prompts.md, R4). Record the delegation (`R4`, `reviewer`, `opus`, `high`). A Tier-1 unit closes `complete` only after a completed R4 (`check`). Each challenge is input, never a verdict:
  - a weak closure: reopen the obligation (`open` / `verification`), or cite better evidence;
  - an unsupported coverage claim: lower `coverage`;
  - a missing path: add an obligation within B3, or record `frontier` debt;
  - an unproven assumption: record it with `observed: unknown`, or as `owner-fact` debt;
  - a severity challenge: run a new R5 on that finding (§7); never change the severity on R4's word.

  R4 never confirms, rejects or upgrades anything. A closure it does not challenge is no stronger for it.
- **Debt:** another unit's debt is carried on; only the unit's own earlier debt blocks its `complete` (§8).
- An interrupted unit continues through `resume` (§11). The continuation keeps the unit and the base.

**Audit close** (`new-run --mode audit-unit --base <head> --unit close`, a reserved unit):
- A final R3 over the ledger and the census. A surface found now becomes a unit through a re-plan: the audit close records no obligation of its own.
- `close` rechecks every `complete` unit. If a file its last run cited changed, or cannot be verified, the unit becomes `incomplete`, with the reason.
- It closes `complete` only when every unit is `complete` or `out_of_scope`, at least one unit is `complete`, every `complete` unit is classified (a tier and a basis), discovery is complete, no census item is `unknown`, and no debt is carried. Otherwise it closes `incomplete`: run the open units, then close again.
- Its report lists, per unit, what that unit's last run left unresolved: open and violated obligations, confirmed defects by severity, unverified findings, risks and debt.

**Reports:**
- A plan report reviews no unit, and a unit report concludes its unit only.
- The audit close says "Whole audit: complete at this snapshot" only when every unit is complete or out of scope. It names the run that concluded each unit.
- No report calls the whole audit "Verified". Out-of-scope units are listed as not reviewed.
- Outside `audits/` (an `experiments/` namespace admits the audit modes without a charter or the gate, for synthetic validation), every audit report says it is not an official audit.
- Audit runs accept `--continues` only for the abandoned run they carry on (`resume`), so debt-in always comes from the chain head.

## 11. Continuing a run

`new-run` refuses while a run is open in the namespace, and while an abandoned run has no continuation. Then:
1. Run `resume --ns <ns>`, without `--apply`. It writes nothing. With `continue`, `run` and `run_dir` name the run to work in. With `abandon`, they name the run to be abandoned, which is history: never edit it, except to fix records `resume` refuses; `continuation` describes the run `--apply` will open.
   - Exit 1 means the records would fail `check` once abandoned, for example a changed file of an Incremental run with no census item (C11), or a concluded obligation claiming `all-enumerated` against an unknown census item (C13). Fix them, then run it again.
2. **`continue`** (the snapshot holds):
   - Tell the user which run this is (its id, mode and scope) and ask once before working in it: it may belong to another session, or to a change other than the one they asked for. An audit mode follows §10, which means stop while official audits are disabled. Otherwise work in it, in its own mode.
   - Check your model against its `required_lead_model` first. On a mismatch, stop and tell the user which model and effort to start a new session with. Otherwise record your own `lead_model` and `lead_effort`, replacing the previous lead's.
   - Keep counting `budget.spent` from what is recorded.
   - In an Incremental run, run `fresh` again.
   - Pick up at the first step not done: no obligations → Plan; no R3 delegation where one is required → Census and plan-critique; obligations still `frontier` → Discharge; candidates → Verify; otherwise Close.
   - If `reassess` names repositories, reassess scope and census there, and close with `--reassessed`.
3. **`abandon` with cause `tracked-changed` or `cited-untracked`** (the tracked source changed, or a cited untracked file changed): show the user the plan (the debt it carries and the continuation it opens) and ask once, because abandoning cannot be undone. Only on their go-ahead, run `resume --ns <ns> --apply`. Then work in the continuation, the `run_dir` that `--apply` prints, from Plan: its debt-in is the abandoned run's whole debt-out, and is mandatory scope (C4, C5). The abandoned records stay as history.
4. **`abandon` with cause `interrupted`** (an abandoned run that no run continues): run `resume --ns <ns> --apply` without asking. It only opens the missing continuation; then go on as in step 3.
5. The run the user asked for is not opened in the same invocation. After the continued run closes, tell the user to run it again.

An escalated run continues this way: the user starts a new session on Opus at high effort and runs the skill again ([routing.md](routing.md), Escalation). Nothing switches models automatically.
