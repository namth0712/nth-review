---
name: nth-review
description: Manually invoked Task or Incremental Review of a code change, or Flow Review (BETA) of explicit entry points on the current source, with obligation coverage, plan-critique and budgeted independent refutation, recorded under .nth-review/. Read-only for the project.
disable-model-invocation: true
argument-hint: "task --ns <experiments|reviews>/<id> --slug <slug> --change <repo>[:<a>..<b>] [--change …] | incremental --ns <ns> --slug <slug> --base <run-id> | flow --ns <ns> --slug <slug> --entry <path>#<Symbol>|<path>:<from>-<to> [--entry …]"
---

# nth-review: Task, Incremental and Flow Review

Arguments: `$ARGUMENTS`. Only `task`, `incremental` and `flow` (BETA, §7) run in this version. `audit plan|unit <id>|close` is Full Audit ([protocol.md](reference/protocol.md) §10), which stays disabled until release: stop and say so. Stop on anything else. For missing or placeholder arguments, follow §1 step 2 instead.

Helper: `node "${CLAUDE_SKILL_DIR}/scripts/nthr.mjs" <command> …`, run from the project root. It prints one JSON line. Exit codes: **0** ok; **1** invalid records: fix them and rerun; **3** unexpected: stop and report it; **2** a refusal: read the message and never work around it, except the `new-run` refusals in §1 and the close refusals in §3.6.

## Guardrails (always)
- The project is read-only. Never edit, create, move or delete project files; never stage, commit, push, stash, switch branches or rewrite history; never install packages.
- Never run tests, builds, services, project scripts, migrations or database clients. No network.
- Never open `.env*` files or other secrets, and never print credentials.
- Git only to read, and always with `--no-ext-diff --no-textconv`: `git log`, `git show`, `git diff`.
- You write only `.nth-review/<ns>/runs/<run-id>/patch.json` (UTF-8 without BOM), then run `apply --run <run_dir>`: it applies the patch to `records.json` in one write, removes it, and runs `check`. The schema and the patch format are in [records.md](reference/records.md) (`apply`).
  - Batch related updates into one patch, against the `records_sha256` the helper printed last. Never edit `records.json` directly, and never use a script, `node -e` or shell redirection. A stale patch is refused with the current digest: rebuild it against that.
  - You fill `run.runtime`, `scope.summary` and `intent`, the census, obligations, findings, `debt.out` and `debt.in` dispositions, delegations, checks and `budget.spent`; `apply` refuses the helper's fields. Of `freshness`, you may only set a class to `assumption-changed`, with its reason. Packs, the footprint, `report.md` and every status change come from the helper.
- In a Task Review, never open other runs' records, reports or packs under `.nth-review/`: a finding repeated from them is not independent, and records.md gives the record shapes. Read an earlier run only when the user explicitly asks for a comparison with it, after your own findings are recorded, and say so in `scope.summary`. Incremental Review inherits its base as §4 says.
- Every path and anchor is project-root-relative, starting with the repository directory: `api/src/x.js:8`, `docs/a.md#Heading`.
- Delegate only to `Explore` and `nth-review:reviewer` (the agent the nth-review plugin bundles; recorded as `reviewer`), read-only, with the prompts in [prompts.md](reference/prompts.md) and the routing in [routing.md](reference/routing.md). Never use `general-purpose`, `Plan`, `architect`, any other agent named `reviewer`, or any agent that edits.
- Models: the lead and every delegate run on Opus at high effort, or on Sonnet. Never xhigh or max.
- The method and its rules are in [protocol.md](reference/protocol.md). Read every reference by section: search for the heading a step names and read only that section, never a whole file.

## 1. Preflight and Open
1. `node --version` must report v20 or later; otherwise stop, because Node.js 20 or later is required. The Agent tool must offer `nth-review:reviewer`; otherwise stop: it comes with the nth-review plugin, which must be enabled (`claude plugin enable nth-review@nth-review`).
2. Before any helper command, ask once, in one question, for what is missing: arguments that are missing or still hold a placeholder (`<base>`, `<slug>`; show `git log --oneline -15`), and the configured effort if you cannot tell it (§2). Never open a run and then wait for an answer.
   - If this session already did other work (such as Enable or Update), whatever the arguments, recommend once that the user start the review in a fresh session: that context is carried into every turn.
3. Run `new-run --ns <ns> --mode task --slug <slug> --change <spec>…` with the user's arguments. For `incremental`, do the §2 check first (it always needs Opus at high effort), then run `new-run --ns <ns> --mode incremental --slug <slug> --base <run-id>`, without `--change`: it is sized since the base. For `flow`, resolve the entries first (§7).
   - If it refuses because a run is "still open", or was abandoned and "no run continues it", continue that run as [protocol.md](reference/protocol.md) §11 says. The run the user asked for opens in a later invocation.
   - On any other refusal, stop and report it.
4. Note `run_dir`, `budget`, `required_lead_model`, `triggers` and the `snapshot` flags. If `discovery_complete` is false, no obligation may be `all-enumerated`.

## 2. Lead model (before Plan)
- `opus-high` needs Opus at high effort. `sonnet` allows Sonnet, or Opus at high effort.
- Record `run.runtime.lead_model` as your model id.
- Record `lead_effort` as the effort the user configured (asked in §1 step 2 if you could not tell). `unknown` is allowed; `xhigh` or `max` means stop.
- On a mismatch, stop before Plan and tell the user which model and effort to start a new session with. You never change models yourself, and nothing switches them automatically.

## 3. Task Review
*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).*

Checkpoint three times: after step 2 (R3 reads it), after step 5, and before close. A checkpoint is an `apply`; fix what its `check` result reports.

1. **Plan.**
   - Read each `--change` as one net diff: `git diff --stat <a> <b>` (a working tree: `git diff --stat HEAD`, plus the untracked files in the snapshot), then the diffs of the files in scope. Never read it commit by commit (`git log -p`, `git log --stat`).
   - Find the owning docs by heading search. Record only those sections, as `scope.intent` entries `{id: "I1", anchor: "api/docs/a.md#Heading", note}`.
   - Add every trigger that applies to `run.runtime.triggers`: `authorization`, `money`, `schema-migration`, `concurrency`, `boundary-contract`, `ai-dispatch`, `task-size`. With any trigger, set `run.runtime.required_lead_model` to `opus-high`; if you are not Opus at high effort, write the records and stop (routing.md, Escalation).
   - Screen all 17 concern families in [taxonomy.md](reference/taxonomy.md), and list the not-applicable codes in `scope.summary`. Outline obligations for each family the change can affect, at most `budget.obligations_max`. An applicable family left out for the cap or budget becomes `deferred-scope` debt; one excluded by the task boundary is an obligation `out-of-scope` with `coverage: excluded`. Each obligation has:
     - an `id` (`OB-1`, …);
     - `checks` as taxonomy check ids (`AUTHZ.2`, `LLM.2`), or a module applied as a whole (`LEDGER`);
     - a claim, an acceptance and a coverage target;
     - `intent` ids;
     - `status: open`, `open_reason: frontier` and `source_trace: not-traced`.
2. **Census.**
   - Add one `census.items` entry per changed file, with its mechanism and either `affects` (obligation ids) or `affects: null` with a reason.
   - For changed write and authorization paths, trace callers up to their entry mechanism (route, handler, job, script, client call), following [census.md](reference/census.md), and add module checks for each module boundary found. Record each search as a recipe with a sequential id (`C1`, `C2`, …), its kind and its `limits`.
3. **Plan-critique (mandatory).** Run one R3 delegation (prompts.md, R3) over the census and outline, before any discharge.
   - Add accepted additions as obligations, up to 20% more than the outline. Any beyond that become `deferred-scope` debt.
   - Record the delegation with `discovered`: every path its answer names (`additions`, `contradictions`, `uncensused`) that no census item covers. Before close, give each a census item that covers it (naming obligations), excludes it with a reason, or marks it `unknown` with `frontier` debt whose `requires` names the path; `check` enforces this. Do the same for an R2 answer.
4. **Discharge.** Check each obligation's acceptance against the code.
   - Cite evidence anchors (`path:L1-L2`). Record the helpers and contracts it relies on as `dependency` assumptions.
   - Set `status`, `coverage` and `source_trace`. `open_reason` is null unless `open`. Concurrency and performance claims stay `open` / `needs-runtime`.
   - A violation becomes a finding: `verdict: candidate`; its `obligation`; a `fingerprint` (`[A-Za-z0-9._:/@+-]`, e.g. `api/invoices/ownership`); `kind: defect`; `impact_dimension` (authorization crossing principals → `security`, per taxonomy.md Severity; money → `financial`; data loss → `data-integrity`); a `trace` (`entrypoint`, `propagation`, `sink`); `decision: pending`. Its obligation stays `open` / `verification` until the finding is verified.
5. **Verify** each candidate defect, evidence first.
   1. Run `pack --run <run_dir> --for <finding-id>`.
   2. Delegate to one refuter, following the routing in prompts.md:
      - **R5** (`opus`, effort `high`, one finding per call): critical or high severity, or `impact_dimension` `security`, `financial` or `data-integrity`;
      - **R6** (`sonnet`, up to two findings per call): everything else. If an R6 answer raises either the severity or the impact into R5's range, rerun with R5.
      - If an R5 answer changes the root cause, trace, impact or severity of a critical or high finding, run a second R5 with a new pack and record its answer (protocol.md §7).
   3. Set `verification: {role, model, outcome, corrections, incomplete}`, then:
      - `confirmed` or `corrected`, with source anchors supporting it → verdict `confirmed`, with a severity; the obligation becomes `violated`. Without such anchors the answer confirms nothing: keep `candidate` with `verification.incomplete: true` (protocol.md §7);
      - `rejected` → verdict `rejected`, with counterevidence; the obligation becomes `held`, with evidence;
      - `needs_validation` → verdict `needs_validation`, with a `validation_plan` and no severity; the obligation becomes `violated`.
      - A refuter `kind` of `risk` → `kind: risk`, `severity: null`, `verification.role: none` (the delegation stays recorded); of `doc-drift` → `kind: doc-drift`.
      - A claim that holds only if a fact outside the source holds (deployment, configuration, runtime behaviour, data or owner knowledge) is never `confirmed`: record `needs_validation`, with a `validation_plan` naming that fact, even when the refuter answered `confirmed`. Never strengthen a refuter's outcome.
   4. A delegate that stops without an answer gets exactly one recovery message. If it fails again, the finding stays `candidate` with `verification.incomplete: true` (still with its role and model).
   5. Record every delegation, with `tool_uses` and `tokens` from its task notification. If that notification has not arrived, record both as null, never 0.
6. **Close.**
   - **Debt.** Decide every `debt.in` item: `discharged` or `obsolete` with a note, or `carried`, repeated in `debt.out` with the same id. Add `debt.out` items `{id: "<run-id>/D<n>", kind, refs, requires, priority}` for open obligations and unverified candidates. `refs` names existing obligation or finding ids, or is `[]`.
   - Record `budget.spent`. Run `footprint --run <run_dir>`, which catches anchors outside every repository or on this skill's own untracked files, then `check` until it passes.
   - **Complete** (`close --run <run_dir> --status complete`) only when all of these hold: nothing is open, no candidate remains, no inherited debt is carried, and spending is within budget. Otherwise use `--status incomplete --reason <budget|open-obligations|unverified-findings|escalation|owner-stopped>`.
   - **Close refusals:**
     - If close reports untracked or unverifiable changes, reassess scope and census for the repositories it names, checkpoint, and rerun close with `--reassessed`.
     - If it reports cited files that may have changed, that is a `resume` (protocol §11), never `--reassessed`.
     - If it reports a tracked change, stop and tell the user. Close with `--status incomplete --reason snapshot-changed` only if they ask.
   - Never touch the run after close.

## 4. Incremental Review
The §3 steps and checkpoints, in the order of [protocol.md](reference/protocol.md) §10, with these differences:
1. **Open.** Run `fresh --run <run_dir>`, and `status --ns <ns>` once (read-only; never run `decide`). Read the changes since the base: `freshness.changed_files` and their diffs. Debt-in is mandatory scope.
2. **Reassess first.** Re-record every inherited obligation whose class is `touched`, `file-changed` or `assumption-changed` under its id, from its `origin` run (the base when unset): its claim, acceptance, checks, coverage target, intent (copy those `scope.intent` entries) and dependency assumptions, reset to `open` / `frontier`, `not-traced`, with no evidence. Reassess `touched` and `assumption-changed` fully; for `file-changed`, read the hunks, then cite the evidence again, with notes saying what you re-read, or reopen. Never copy a conclusion: `check` refuses a dropped one, and a held or accepted one whose evidence is its origin's unchanged.
3. **`current` obligations stay concluded in their origin run.** Re-record one only when a changed file's census item bears on it, and then reassess it fully.
4. **Findings** of a reassessed obligation (in its origin run): if the cause persists, record the finding again as a `candidate` with the same fingerprint and verify it (§3.5); if it is gone, the obligation is `held` on new evidence.
5. **Census** every file in `freshness.changed_files` (§3.2). New obligations use ids the effective baseline does not use (`check` refuses another claim under an inherited id). Run R3 (§3.3) when new write or authorization paths appear.
6. **Final message:** also the freshness classes, and which obligations were reassessed.

## 5. Budget (stop rules)
Count every tool call you make after `new-run`: reads, searches, edits, helper commands and delegations.
- **B1:** at 70% of `budget.lead_tool_calls`, stop discharging. Remaining obligations become `open` / `budget`.
- **B2:** keep 30% of tool calls for verification and close.
- **B3:** the outline grows by at most 20% after plan-critique. Anything beyond is `deferred-scope` debt.
- **B4:** `budget.subagent_calls` is a hard cap. A candidate that cannot be verified stays `candidate`.
- **B5:** record spent tool calls, subagent calls and subagent tokens (the sum of those reported). Never set `wall_clock_min`: close computes it. `spent.subagent_calls` must be at least the number of recorded delegations.

## 6. Final message
1. **Outcome first:** status and reason, and the `report.md` path.
2. **Gaps:** open obligations, unverified findings, unverified evidence, debt handed on, and snapshot limitations.
3. **Findings** by severity, with their verdicts.
4. **Cost** against budget. The minutes are open to close; session time and money are not measured.

## 7. Flow Review (BETA)
What the current source does from explicit entry points, with no commit range ([protocol.md](reference/protocol.md) §10, Flow Review). It concludes only on the paths it records: never present it as a project audit.
1. **Entries before Open.** Turn the user's selectors, or a described workflow, into selectors (`<path>#<Symbol>`, `<path>:<line>`, `<path>:<from>-<to>`; at most 8) and run `resolve --entry <selector>…`. Ask once (with §1 step 2) when one is ambiguous, missing or proposed only by you; never open on a guess.
2. **Open:** `new-run --ns <ns> --mode flow --slug <slug> --entry <selector>…` (always `opus-high`, §2). Then the §3 steps, where a "changed file" reads "a file reached from the entries".
3. **Interleave discovery and review:** record each entry's first hops as `census.edges` (`from`, `to`, `kind`, `evidence`), outline obligations for them, discharge, and add an edge (from an earlier classified edge) only where an acceptance needs it.
4. **Every path gets a disposition:** `classified` naming the obligations covering it, `excluded` with a source-based reason, or `unknown` with the next validation step and `frontier` debt whose `requires` names its evidence anchor. A runtime-only link is `unknown`. Stop expanding at the limits `check` enforces (`max_depth`, `max_edges`).
5. **Cite only inside the boundary:** the entry files and the edges' evidence and target files. Delegates start from the recorded edges (packs carry them).
6. **Close** as §3.6. A refusal over a changed cited file is a `resume`; over a changed entry, close `incomplete` / `snapshot-changed` and open a new flow run; never `--reassessed`. Final message: also the entries and the paths left unknown.
