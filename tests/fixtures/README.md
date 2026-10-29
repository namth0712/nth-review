# M5 synthetic fixtures (M5-T1, extended in M5-T4)

Deterministic projects for validating what nth-review actually does, with sealed answers. These files are library-only test tooling: Enable never installs them.

**Never give a reviewer anything from this folder**: not the answers, not this file, not the templates. The fixture a reviewer sees contains only neutral code, documents and commit history.

## Build

From the nth-dev-kit root:

    node agents/claude/integrations/review/tests/fixtures/build.mjs <name> <outDir> [--from <dir>]

| Name | What it builds |
|---|---|
| `syn-ledger` | Three repositories: the root `.` (documents), `api` (an Express-style ledger API, never run) and `admin` (back-office tools). Each has a base commit; `.` and `api` also have a change commit, which is the reviewed change. |
| `syn-ledger-inc` | `syn-ledger` plus one more commit in `.` and `api`. |
| `syn-ledger-inc-rewritten` | The same, after `api`'s change commit is rewritten and the old commit pruned, so the first review's base is unreachable. |
| `syn-ledger-inc-dirty` | The same, with the new files left uncommitted (one of them untracked). |
| `syn-debt` | `syn-ledger` plus a smaller follow-up commit in `.` and `api`, sized so that one Task review cannot verify everything. |
| `syn-shelf` (M5-T4) | One repository `.`: a single-user reading-list command-line tool with a base and a change commit. The change is Task S (8 files, 75 lines) and meets no lead-model trigger, so a Sonnet lead is eligible. Templates live in `syn-shelf/tree/<layer>/root/`. |

- **`--from <dir>`** (the `-inc` names): copy a built `syn-ledger` fixture, including its `.nth-review/` records, and extend it. Its heads must equal a fresh `syn-ledger` build, and its tracked state must be clean. This is how an Incremental review gets a first review to start from.
- **Refusals (exit 2):**
  - `outDir` is not absent or empty;
  - `outDir` is outside the system temporary directory;
  - `outDir` is inside a Git work tree, or overlaps the kit;
  - an unknown name, or a bad `--from`.
- **Output:** JSON with the fixture path, the heads, the command to type and the next steps. It never contains answers.
- **Determinism:** templates live in `syn-ledger/tree/<layer>/<repo>/`. Git runs without system or user configuration, with a fixed identity, fixed dates and neutral messages, so rebuilds have the same commit ids and the same bytes outside `.git/`.
- **Install:** every fixture is installed with review.md's project-scoped **Enable** (`tests/m4/operator.mjs`), from a throwaway runtime-only library that holds no `tests/`. The root repository's `.git/info/exclude` holds the nested repositories and exactly the three paths of review.md's optional local exclude.

## Run a review (never in a development session)

1. Build the fixture into a neutrally named directory, for example `%TEMP%\ledger-<n>`.
2. Start a **new** Claude Code session in that directory, at the routing the run requires: Opus at **high** effort for these fixtures, which carry authorization and money triggers. Never xhigh or max.
   - The real configuration may default Opus to xhigh. Pass `--effort high`: M5-T1 verified that it overrides a configured effort level, and the session transcript records it as `perTurnEffort`.
3. Type the command the builder printed.
   - **Headless:** run `claude -p "<command>" --model opus --effort high --output-format stream-json --verbose`, with tools scoped to the fixture. From Git Bash, set `MSYS_NO_PATHCONV=1`.
4. After the run, audit for leakage. Any of the following invalidates the run:
   - a read outside the fixture;
   - any mention of `answers`, `tests/fixtures`, `nth-dev-kit` or the research folder;
   - a web tool;
   - a Git write.

The run plans:
- **`syn-ledger`:** R1, a Task review of the change.
- **`syn-ledger-inc`:** R1 on `syn-ledger`, then this fixture built `--from` it, then R2: `incremental --base <R1>`.
- **`syn-debt`:** R1, a Task review that should end `incomplete` with debt-out; then R2: `incremental --base <R1>`, with no new commit.
- **`syn-shelf`:** R1, a Task review, led by Opus at high effort or by Sonnet with no effort flag (observed to run at high).

The G5 matrix (M5-T4) does not use these manual steps. It runs every row through `tests/tools/matrix.mjs` (see Tools), which builds the fixture and records the answers' hashes first. It then runs the session inside the session guard, audits it, has it adjudicated blind and freezes that, and only then scores it.

## Sealed answers (`<fixture>/answers.json`, `nthr-fixture-answers@1`)

- **Top level:**
  - `heads` per repository (per variant for `-inc`);
  - `runs[]` (mode, changes, expected size and lead model);
  - `items[]`;
  - `census`;
  - `unplanned_allowances[]`;
  - `scoring`.
  - For `-inc`: `base`, `variants` (history per repository and changed files), `target`, `dependents`, `independent`.
  - For `syn-debt`: `budget_pressure` and `debt` (expected kinds, disposition rules).
- **Item fields:**
  - **Identity:** `id`; `gating`; `gate_dimension`; `category`; `expect` (`defect`, `doc-drift`, `census-only`, `no-defect`, `needs-runtime` or `outside-fact`); `checks` (taxonomy ids).
  - **Mechanism:** `mechanism`, one sentence; `mechanism_facts[]`, the adjudication checklist; `wrong_mechanism_claims[]`.
  - **Evidence:**
    - `anchors[]`: `{ role, path, lines, contains }`. The role is `entrypoint`, `propagation`, `site`, `sink`, `rule` or `refutation`. `contains` is text on those lines.
    - `required_evidence[]`: `{ id, anchor_ref, why }`, or `{ id, anchor_refs: [...], why }` when any one of several anchors satisfies it (for example, alternative rule lines).
    - `absent[]`: text that must not exist under a path.
  - **Outcomes:** `outcomes{ full, partial, honest, disqualifying }`. Each is a list of predicates over records@1 fields: `finding` (kind, verdict), `obligation` (status, open_reason), `census` (status), `debt` (kind), or `not_raised`.
  - **Refutation:** `refutation.counterevidence_anchor_refs`.
- **Items:**

  | Fixture | Items | Gating |
  |---|---|---|
  | `syn-ledger` | P1–P6, N1–N2 (delivery roadmap §4, unchanged) | gating |
  | `syn-ledger-inc` | target T1 | gating: indirect invalidation |
  | `syn-debt` | X1–X4 (business rule, concurrency, refutation, a fact outside the source) | reported, not gating |
  | `syn-shelf` | E1–E4 (two must-find defects, a further defect, a doc-drift), EN1–EN2 (controls) | gating for the Sonnet-vs-Opus comparison (owner decision, M5-T4) |

  The X items extend the approved design to the owner's M5 coverage list. They never change a G5 threshold unless the owner decides so.

  `syn-shelf` also carries:
  - `runs[0].triggers_absent`, a reason for each lead-model trigger;
  - `scoring.g5`, the comparison rule, pre-registered before any run: must-find items, at least 3 of 4, controls never confirmed, at most 1 other false confirmed, precision ≥ 0.80, and the routing decision those decide.
- **Integrity:** the answers' sha256 is recorded before any reviewer run: in `VALIDATION.md` up to M5-T3, and from M5-T4 in the hash-chained ledger `g5-ledger.jsonl` (the `registered` record, then each row's `pre-run` record). `tests/fixtures.test.mjs` checks every anchor against a fresh build, so a template edit that moves a planted line fails the tests.

## Evaluation criteria

These are the rules M5-T3 (scoring) and M5-T2 (transcript metrics) implement. Line matching uses a tolerance of `scoring.line_tolerance` (3) lines, as `fresh` does.

1. **Matching.** A finding matches an item only when one of its **trace** anchors overlaps a `site` or `sink` anchor of the item. An obligation counts toward an item when its evidence overlaps those anchors and it checks the same concern. Counterevidence never creates a match: it counts only toward refutation credit (rule 5). A text match alone never matches. See also the M5-T3 clarifications below.
2. **True positive (full credit).** All of the following:
   - the record matches;
   - every `required_evidence` anchor is cited by the finding or its obligation;
   - every `mechanism_facts` entry is asserted in the summary or trace notes, and no `wrong_mechanism_claims` entry is. A human adjudicates this from the quoted record text, with the checklist;
   - the record satisfies a `full` predicate.

   **Keyword-only matches earn nothing.** A finding with the right words but no overlapping anchor, or without the required evidence, gets no credit. If it is confirmed, it counts as a false positive. A finding in the right file with the wrong mechanism counts as **mislocated**. Gates count full credit only; partial credit is reported.
3. **Missed.** No record satisfies `full` or `partial`. A `rejected` verdict on a defect item is a miss and a **wrong rejection**.
4. **False positives and precision.**
   - A false positive is a confirmed finding that matches no item at full credit, is outside `unplanned_allowances`, and is adjudicated false.
   - A confirmed defect on the anchors of N1, N2, P3, P4 or X3 is a false positive automatically.
   - Precision = (true positives + valid unplanned findings) / confirmed findings.
5. **Correct rejection.** A `rejected` verdict whose counterevidence overlaps the item's refutation anchors. "Not raised" is reported, not credited, except where `not_raised` is a `full` predicate (N2, X3).
6. **Evidence quality.**
   - Every anchor resolves: the file exists and the range lies inside it.
   - The coverage ratio of `required_evidence` is reported.
   - Trace roles are in order, entrypoint before sink.
   - A `source_trace: consistent` claim must agree with the item's trace.
   - Unresolvable anchors in delegate answers come from transcripts (M5-T2).
7. **Coverage.**
   - Recall over `census.mechanisms`: classified or `unknown`, through a census item, obligation evidence or an assumption.
   - The `population` counts must be exact.
   - An `all-enumerated` claim whose population misses a member is an **overclaim**.
8. **Honest incompleteness.**
   - An item that cannot be settled from the source (X2, X4) earns full credit only in its honest class: `open` with `needs-runtime` or `needs-owner-fact`, or `needs_validation` with a plan naming the missing fact.
   - Its `disqualifying` classes (`held`; for X4 also `confirmed`) count as errors.
   - A run must not claim `complete` while such items are open.
9. **Indirect invalidation (`syn-ledger-inc`).**
   - The target obligation is reopened, with a reason naming `api/src/guards.js` or the changed intent document, and is never left current.
   - Reopening an obligation that cites only `independent` paths is **overreach**: it is reported.
   - Every changed file has a census item (C11).
10. **Debt (`syn-debt`).**
    - R1 ends `incomplete` with debt-out covering every open obligation and every unverified candidate.
    - R2 dispositions every debt-in item and passes `check`.
    - Runtime or owner-fact debt discharged without new evidence is an error.
11. **Cost.**
    - Budget versus `spent`, from the records.
    - Tool calls and tokens by agent, from the transcripts (M5-T2).
    - Tokens and tool calls per obligation, per lead model.
    - Wall clock from opened to closed.
12. **Recovery and stopping.**
    - Delegations complete, with at most one recovery message.
    - No discharge after the B1 stop at 70%.
    - The final status and its reason agree with the open items.
13. **Routing (M5-T2).** No model other than Opus or Sonnet. The lead and every Opus delegation run at high effort.

### M5-T3 clarifications

Implementing the scorer on the first real run, and its independent review, showed where the rules above were ambiguous. These clarifications change no answers and no threshold.
- **Counterevidence:** a finding that cites a control's lines as counterevidence makes no defect claim about it.
  - Rule 5's credit needs a `rejected` candidate whose counterevidence overlaps the item's `refutation.counterevidence_anchor_refs`.
  - A control named only in another finding's counterevidence is reported, not credited.
- **Span limit:** a trace or evidence anchor wider than 30 lines never matches or supports anything, and is reported.
- **Headings:** a heading anchor supports a `rule` line only when it is the innermost heading above that line.
- **Same concern:**
  - An obligation counts for or against an item only when one of its checks is the item's, or in the same family. A held obligation about something else is not a miss.
  - For a control, `correctly-held` needs a held obligation with one of the control's exact checks.
- **Partial matches:** a finding that reaches only a `partial` outcome is `partial-pending` until a person judges that it has the item's root cause.
- **Census-only items:** a classified census item for the site anchor is `covered`; an `unknown` one, or coverage through other anchors or text, is `partial`.
- **Precision** = (confirmed true positives + valid unplanned confirmed findings) / confirmed findings. True positives verdicted `needs_validation` are reported separately and never raise precision above 1.
- **Honest outcomes:** a defect item with no finding, but with an open obligation in its honest class, is a miss labelled `missed-honest-open`.
- **Assignment:** one finding per item, assigned greedily and deterministically. Other overlapping findings are adjudicated as a duplicate, a different root cause, valid or false. An optimal matching is not attempted.
- **Version:**
  - A score is official only when the answers' heads (per variant for an Incremental fixture) equal the run's snapshot heads.
  - The tree must also be unchanged since the run, and every answers anchor still present.
  - Unpinned answers are never verified.
- **Adjudication file** (`nthr-adjudication@1`):
  - It must name the run, the fixture and the exact sha256 of the answers.
  - Census statuses are `covered`, `partial`, `missed` or `false-positive`. Finding verdicts are `valid-unplanned`, `false-positive`, `duplicate-of <id>` or `pending`.
  - A score that rests on a non-independent adjudication says so.

### M5-T4 scorer corrections (owner-approved after the first Incremental runs)

These correct places where the scorer departed from the written criteria. They change no answer, fixture, threshold or adjudication. Re-scored runs keep every earlier score; each correction is recorded beside them (`<run>.score.corrected.json` for corrections 1 and 2, `<run>.score.corrected-b.json` for B) with a `rescored` ledger event.
- **Rule 9 (indirect invalidation):**
  - "Current" and "reopened" are judged only for target obligations inherited from the base run, the ones `fresh` classified. Obligations created in the new run are listed apart.
  - The reopen reason must name a file that actually changed in this run and that the sealed variant marks `affects: target`. The census item of such a file naming the obligation (C11) also counts, as does the base-missing history of its repository.
  - A run meets the rule when no inherited target obligation is current, one is reopened with such a reason, and every changed file has a census item.
- **Version:**
  - With the tree digest frozen before the run (`--pre-run-tree`), uncommitted changes are accepted when the tree still equals that snapshot: a variant dirty by design.
  - Any change since the snapshot, tracked or untracked, is a mismatch.

- **Census paths (correction B, owner-approved after batch 2):**
  - A census item may name a group path (`*` and `?` within one segment, `census.md` §1).
  - The scorer matches it with the helper's own C11 matcher (`globMatches` in `scripts/lib/check.mjs`), for census coverage, for C11 and for census-based reopen reasons. An exact item wins over a group item.
  - A group item judged incorrect by the adjudicator earns no coverage, like any other.
- **Rule 10, debt (correction C, owner-approved after batch 3):**
  - A debt-in item has no `kind` of its own (`records.md`). Its kind is the one of the item with the same id in the base run's debt-out, read from the fixture.
  - An item whose kind cannot be resolved exactly fails the check: no unique base, another origin, a missing or repeated id, or a disagreeing kind.
  - A discharged or obsolete item needs a note.
  - A matrix review is static, so a discharged `runtime` or `owner-fact` item is always an error there.
- **Counting false positives** (reconciled in M5-T4):
  - `false_positives` counts rule hits: each control or census-only item a finding disqualifies, plus each unmatched false finding and unsupported confirmation. One finding can therefore count more than once.
  - `control_rule_hits` lists the item hits; `false_positive_findings_distinct` lists the findings.
  - Precision counts findings, so it counts each false finding once.

### Rule 4 v2: proposed for future pre-registered benchmarks only

Rule 4 as registered (v1) makes a confirmed defect a false positive when its trace overlaps a control's anchors (no-defect items: their site lines; census-only items: any of their anchors), whatever the finding is about. In M5-T4, L2's finding F-4 (input validation) hit N1 (ownership) and P3 (timer census) by line proximity alone.
- **Rule 4 v2:** a confirmed defect counts against a control or census-only item only when:
  - its trace overlaps one of the item's `site` or `sink` lines;
  - **and** it shares the item's concern: one of its obligation's checks is in the family of one of the item's checks, the test `sameConcern` already applies to obligations.
- **Status:** v2 is **not** the rule of any completed run. It may be pre-registered for a future benchmark.
- **Diagnostic only:** `score.mjs --rule4 v2-diagnostic`, or `matrix.mjs rescore --diagnostic rule4-v2`, computes it as a separately labelled diagnostic, marked "never an official score".

### M5-T4: blind independent adjudication

The owner requires adjudication by a fresh, isolated session that is neither the fixture author nor the reviewer. It judges without the answers, its verdicts are frozen, and only then does the deterministic scorer run.
- **Adjudicator:**
  - a fresh headless session on Opus at high effort, in a copy of the reviewed fixture without the skill;
  - it gets the generic prompt `tests/tools/adjudicator-prompt.md`, which names no item, label or answer;
  - it has read-only Git and no helper, subagents or edits, and writes only `verdicts.json`.
- **File** (`nthr-adjudication-blind@1`), keyed by the run's own record ids:
  - per finding: `verdict` (`valid`, `false`, `unsupported`, `duplicate-of F-<n>`, `cannot-tell`), `mechanism_correct`, verbatim `incorrect_claims`, the adjudicator's own `cause_anchors` and `rule_anchor`, `counterevidence_sound` and `severity`;
  - per obligation: `conclusion` (`agree`, `disagree`, `cannot-tell`) and `missing_members`;
  - per census item: `classification` (`correct`, `incorrect`, `cannot-tell`);
  - `unraised` and `not_checked`.
- **Freeze:**
  - before any scoring, the operator hashes the file into the ledger (`adjudication-frozen`);
  - the file and its `.meta.json` are copied to `<fixture>/adjudications/<run id>.blind.json`;
  - `score.mjs --adjudication-meta` checks both hashes: the file's, and the records' at freezing time;
  - a mismatch makes the score "not independent".
  - Unknown ids or values reject the whole file. A file the scorer would reject gets one repair turn in the same session before the freeze.
- **Mapping, fixed before any run:**
  - **Assigned finding:** it earns the item's mechanism facts only when all of these hold:
    - it is judged `valid`, with a correct mechanism and no incorrect claim;
    - its cause lies on one of the item's `site`, `sink` or `propagation` lines;
    - when the item has rules, its rule anchor supports one of them.
  - **Unmatched finding:** `valid` maps to `valid-unplanned`, `false` and `unsupported` to `false-positive`, `cannot-tell` to `pending`.
  - **Census coverage:** credited only when the covering census item is judged `correct`, or the covering obligation `agree`.
  - **Population:** exact only when every member is cited and every citing obligation is agreed.
  - **Otherwise:** the item stays pending and earns nothing. The mapping approximates the prose `mechanism_facts` checklist by anchors, and says so.
- **Controls:** a control a finding touches stays a false positive whatever the adjudicator says; a contrary judgement is shown as `adjudicator_judged_valid`.

## Tools

From the nth-dev-kit root, after the reviewer session has finished:

    node agents/claude/integrations/review/tests/tools/transcript-metrics.mjs --session <session.jsonl> [--stream <stream.jsonl>] [--records <run>/records.json] [--fixture <dir>]
    node agents/claude/integrations/review/tests/tools/score.mjs --answers <answers.json> --run <run dir> --fixture <dir> [--adjudication <file>] [--metrics <metrics.json>] [--format markdown]

- `transcript-metrics.mjs` (M5-T2):
  - It reads the session transcript and its `subagents/` folder as untrusted data.
  - Every value is labelled observed, inferred, unavailable or contradictory.
  - Its output holds no absolute path and no credential.
- `score.mjs` (M5-T3) applies the criteria above. From M5-T4 it also accepts a blind adjudication (`--adjudication <file>.blind.json --adjudication-meta <file>.blind.meta.json`) and the frozen pre-run tree digest (`--pre-run-tree <sha256>`), and it applies a fixture's `scoring.g5` comparison rule.
- **Lead tool calls (B5 counting):** calls are counted from the first lead call after the executed `new-run`; the open call itself is not counted. `transcript-metrics.mjs` also reports the count at the last records write, and compares the lead's own figure with both.
  - **Records writes (M5-T4R):** a records write is an executed Write or Edit of `records.json` or, from M5-T4R, an executed `nthr.mjs apply`. A refused apply exits non-zero and is not a write.
  - **After B1:** an apply's conclusions are read from the `patch.json` written since the previous apply: the last Write, with every later Edit replayed on it. `record_writes_after_b1_by_kind` splits the count into file-tool writes and applies. A transcript without an apply gives the same values as before.
- **Observed cost (M5-T4R):**
  - `score.mjs` reports `cost observed (transcript)`: the lead calls after the open and the delegations, both observed, against the run's budget.
  - It sits next to the unchanged recorded line (`budget.spent`, the lead's own count).
  - `matrix.mjs summary` gives every row `cost_observed`, and `within_budget` is null when nothing was observed.
- Session transcripts stay outside the repository.
- Adjudications live in `<fixture>/adjudications/<run id>.json` (M5-T3) or `<run id>.blind.json` (M5-T4), reports in `<fixture>/reports/`. The exact answers version a run was scored against stays in `<fixture>/history/` when the current answers have changed since.

### The G5 matrix runner (M5-T4)

    node agents/claude/integrations/review/tests/tools/matrix.mjs <command> --root <dir outside the kit> [rows...]

- **Commands:**
  - `plan`;
  - `register` (once, before any run);
  - `record-isolation <summary.json>`;
  - `drive <rows> --max-budget <usd> [--dry-run]`;
  - `void <row> <reason>`;
  - `escalation`, `verify-ledger`, `summary`, `costs`, `export <rows>`;
  - `rescore --reason <why> [--label <name>] <rows>` re-scores from the frozen adjudication after an approved scorer correction. It writes `<run>.score.<label>.json`, keeps every earlier score, and records a `rescored` ledger event with the changes;
  - `rescore --diagnostic rule4-v2 --reason <why> <rows>` writes a labelled diagnostic (`diagnostic-scored` event) that never becomes the row's score;
  - `record-curated-package --ledger <file> --curated <package> --change <repo>:<a>..<b> [--change …]` and `register-supplement`: the security rows' fixture and registration (gate @3, [SECURITY-FIXTURE-SPEC.md](../SECURITY-FIXTURE-SPEC.md) §4).
- **Rows:** 14 core rows, in four registered chains:
  - L1 → I1c, I1r, I1d;
  - L2 → I2c, I2r, I2d;
  - D1 → D2;
  - SO1, SS1, SO2, SS2.

  Gate @2 adds SB1 → SB2, two Opus security rows on the externally curated fixture, built from its Git bundles by `buildCuratedFixture` (`build.mjs`). They run only after `register-supplement`, and their evidence goes under the matrix root's `curated/`.

  `drive` refuses:
  - a row ahead of an unscored earlier row of its chain;
  - a row whose base has not closed;
  - any run when the plan is not registered with the current answers;
  - any run when the installed Claude Code version is not the one whose isolation was verified.
- **Ledger** `g5-ledger.jsonl`: append-only and hash-chained, holding no absolute path.
  - Events: `registered`, `isolation-verified`, then per row `pre-run`, `closed`, `audited`, `adjudication-frozen`, `scored`, or `voided`.
  - A voided attempt stays as history and never counts. Its folders move out of every session's reach, and the row is rebuilt in a new fixture.
- **Session isolation:**
  - **Session guard:** `tests/tools/session-guard.mjs`, a PreToolUse hook passed per session with `--settings`. It runs as a neutral copy from the temporary folder, in exec form with `onFailure: "block"`. It allows:
    - file tools inside the row's own folder, and reads of its own Claude Code project folder;
    - writes to `.nth-review/` (reviewer) or `verdicts.json` (adjudicator);
    - a strict shell grammar: the helper, read-only Git, simple reads inside the folder.
  - **Permissions:** the default mode, nobody answering prompts, and no allow rule, so only the guard's explicit approval runs a shell command or a write.
  - **Read deny rules:** the kit, the development transcripts and history, every project's memory and the state file (`.claude.json`) in the matrix configuration, every other Claude Code configuration in the home folder (each `.claude*` folder, whole) and the state files there, other rows, earlier fixtures and the matrix root.
  - **No MCP:** `--strict-mcp-config`.
  - **The OS enforces none of this.**
- **Own-output rule** (`own-tool-results-v2`, from ledger seq 87; earlier audits used v1, which exempted only a `Read` of the session's own project folder):
  - A `Read`, `Grep` or `Glob` of exactly one tool-result file is not leakage when that file was announced in that session's own transcripts and lies, as a regular non-link file, directly in `<config>/projects/<session folder>/<session id>/tool-results/`.
  - Nothing else in a Claude project folder is exempt, and shell commands and Git never are.
- **Audit:** a row is invalid on:
  - an executed outside read, Git write, web or network use, or a write outside `.nth-review/`;
  - a tool input naming the sealed side or the kit;
  - a fixture change outside `.nth-review/`;
  - an executed tool call without a guard decision.

  Denied unsafe attempts are listed apart from executed ones and do not invalidate a row.
- **Costs:**
  - **Spending cap:** `--max-budget` caps a drive. A review session gets what is left minus a $3 reserve for its adjudication, and each session also runs under Claude Code's `--max-budget-usd`.
  - **Cost report:** `costs` recomputes every session's client-computed cost from its transcript: counted, voided, retried and repair. A session killed before a cost was recorded shows only its tokens; no cost is estimated.

### M5-T4R readiness (the G5 repeat)

The runner's changes for a new, pre-registered repeat (`tests/G5-REPEAT-PLAN.md`). None applies to the M5-T4 ledger, which stays as recorded.
- **Same-code isolation (B1):**
  - The row codes are reused, and the temporary folder and configuration still hold M5-T4's fixtures, sandboxes and transcripts under them.
  - A session's own row code is no longer left out of the deny rules. Every folder that exists under it is denied by its exact path, in the temporary folder, the configuration's `projects/` and `<tmp>/claude/`, except the session's own (`denyRootsFor(…, { ownDir })`; `ownDir` is required).
  - The guard was already exact: the realpath of its own folder and its own session folder. Adversarial tests now prove both layers.
- **Command-line limit:**
  - A session whose command line would pass 32,000 characters is refused before it starts, so it costs nothing and never runs with fewer rules. An adjudicator repair turn that would pass it is not started.
  - **Preflight** (`commandLineBounds`, `commandLinePreflight`): `drive` bounds every reviewer and adjudicator command of the batch before the first paid session, and refuses the whole batch if one is over the limit. It bounds each row's two commands again before that row's review, so an adjudication that cannot start is caught before its review is paid for. `drive --dry-run` reports the bounds as its `command_lines` gate. A bound is never below the real command:
    - the deny lists as they stand, exempting no own folder;
    - plus the attempts the drive itself will void;
    - the helper's longest run id (92 characters) where a run is not known yet;
    - the drive's whole cap in the budget flag.
  - **Security rows' folders** carry a mark and their matrix's token (`wo-nthsec-<token>-…`; `folderPrefix`). Every other session still denies them by the two-letter rule. Their own session denies its earlier folders by the marked prefix only, so another project's folders that share the two letters (once 125 `rp-*` entries) add nothing to its command.
  - On 2026-10-29, on the owner's machine, the longest bound is 31,509 characters (the SO2 adjudicator). Each earlier attempt of a row adds about 850.
  - Archiving earlier matrices' folders out of the temporary folder shortens it.
- **Audit:** a Glob `pattern` or Grep `glob` whose fixed prefix is absolute or climbs is placed like a path, and is an outside access when it lies outside the fixture.
- **Implementation freeze (B3):**
  - `matrix.mjs implementation` prints the manifest:
    - every material file with its sha256 and Git state (clean, modified, untracked, ignored), and the HEAD;
    - `frozen` only when every file equals HEAD;
    - the session configuration's digest (`<config>` global instructions, rules, agents, skills, hook scripts, `settings.json` and plugin pins, hashed only; status caches, state files and sync markers left out).
  - **Material files:**
    - `review.md` and the skill's runtime entries;
    - `tests/tools/**`;
    - the builder, its templates and answers;
    - this README;
    - `g5-criteria/`;
    - the Enable transcription and the builder's helpers;
    - `tests/G5-REPEAT-PLAN.md`;
    - the release gate texts, `tests/RELEASE-GATE.md`, `tests/RELEASE-GATE-2.md` and `tests/RELEASE-GATE-3.md`.

    Ledgers, scores, adjudications and VALIDATION.md are evidence, not inputs.
  - **`register` refuses** a second registration, an implementation that is not frozen, and a missing isolation record or one for another version, implementation or configuration. It refuses when the installed Claude Code version cannot be read (no auto-update setting is required, gate @3). It records the manifest, the commit, the skill a fixture will hold (from a throwaway build), the gate, and the Claude Code, Node.js and Git versions, the OS and the model pins. The Claude Code version is re-checked before each row, audit and score.
  - **`record-isolation`** refuses an implementation that is not frozen, and records the digests.
  - **Each row:** `drive`, its dry run and every row refuse an implementation or configuration that differs from the registered one. So does the check before each row's audit and before its score. `prepare` refuses a built skill that differs.
  - **Deleted files:** a material file deleted or renamed away from HEAD is listed as `deleted`, and the implementation is not frozen.
  - **Each pre-run** records `kit: { head, frozen, implementation_sha256, environment_sha256 }`. `verify-ledger` checks every pre-run against the registration, and every `scored` event against the registered `score.mjs`.
- **Evidence (B2):** `tests/tools/evidence.mjs inventory | archive --to <dir> | verify --archive <dir>`.
  - **What it collects:** the kit evidence, the row fixtures and sandboxes, the guard logs, the session transcripts (`--config`, the configuration the matrix ran under) and the matrix root (`--root`).
  - **How it copies:** it copies only. Each source is hashed before and after its copy, and the copy is hashed again.
  - **Where it may write:** the archive must be a new folder outside Git, the temporary folder, the configuration, the root and the kit. The tool restricts it to the current user and SYSTEM.
  - **Manifests:** `<archive>/manifest.json` holds every file. The hash-only `g5-evidence-m5t4.json` holds folder digests, kit evidence, records and transcripts by sha256, with no content and no absolute path.
  - **Verify:** `verify` checks against that committed manifest by default and reports whether it was anchored. Without it, an archive whose `manifest.json` was edited too cannot be told apart. It also reports files the manifest does not list, and paths that leave the archive.
  - **Missing evidence:** what the ledger names but nothing holds is listed as missing.
- **Criteria capture:** `g5-criteria/roadmap-section-4.md` is the delivery roadmap's §4 (lines 65–91), verbatim. `source.json` gives its source and both sha256s. A test pins the excerpt, and checks it against the source when the source is on the machine.
