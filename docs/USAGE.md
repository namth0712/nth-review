# Using nth-review

This document owns how to run a review and read its results. Installing nth-review and enabling it in a project are in [INSTALL.md](../INSTALL.md).

## Status

**Release candidate `1.0.0-rc.2`, not Stable.**
- **Task Review and Incremental Review** are release-candidate functionality: they are what v1.0 Stable would cover, and they have not yet passed its quality gate.
- **Flow Review** is **Beta**.
- **Official Full Audit** is disabled.

The historical synthetic gate (G5) did not pass, and the v1.0 release gate (RQ-1 version 3, [tests/RELEASE-GATE-3.md](../tests/RELEASE-GATE-3.md)) is frozen but has not run: it needs paid benchmark sessions, an independently curated security fixture and the owner's triage of real runs. The release contract and the verdict are in [RELEASE.md](../RELEASE.md). Use nth-review for explicitly opted-in, manual reviews, and treat every result as needing your own judgement.

## What each mode does

- **Task Review** reviews one change, a commit range or the working tree, against the project's documented intent. It builds a census of the change, sets obligations (what the change must keep true), discharges each one with evidence, sends every candidate defect to an independent refuter, and records the result.
- **Incremental Review** reviews what changed since an earlier review. It inherits that review's open debt and re-checks only what the new change touches.
- **Flow Review (Beta)** reviews what the current source does from explicit entry points, with no commit range: one endpoint, an action across services, a job, or a multi-step workflow.

Every run is recorded under the project's `.nth-review/`. The method is in [SKILL.md](../SKILL.md) and its [references](../reference/).

## Prerequisite: the reviewer agent

You need to install nothing. The skill delegates plan critique to Claude Code's built-in `Explore`, and refutation to `nth-review:reviewer`, the agent the plugin bundles (`plugin-agents/reviewer.md`):
- **What it is:** a read-only reviewer. It runs on Sonnet unless a delegation asks for Opus, may use Read, Grep, Glob, Bash and PowerShell for read-only inspection, has a 12-turn limit, and never edits, writes with Git or starts other agents. Records name it `reviewer`.
- **When it exists:** only while the nth-review plugin is enabled. If it is missing, the review stops at its preflight, before it opens a run: enable the plugin (`claude plugin enable nth-review@nth-review`) and start a new session.
- **Your own agents:** an agent of your own or of the project named `reviewer` is never used, and it does not conflict with `nth-review:reviewer`.
- **Where it is offered:** wherever the plugin is enabled, like `/nth-review:project`: in every project (the default user scope), or only in the projects where you enabled it with `claude plugin enable nth-review@nth-review --scope local`. Claude Code has no setting that keeps Claude from choosing an available agent on its own; inside a project where it is offered, its description, which restricts it to nth-review's delegations, is the only guard. A permission rule that denies `Agent(nth-review:reviewer)` would also stop the refutation step.
- **How it is called:** by its full name, `nth-review:reviewer`. Claude Code resolves that name only to the bundled agent, and a bare `reviewer` never resolves to it: another kit's or your own `reviewer` keeps working as before, and nth-review never calls it.

## Run a review

`<P>` is the project root, where nth-review is enabled ([INSTALL.md, the four steps](../INSTALL.md#the-four-steps)).

1. **Preview, then start a fresh session** in `<P>` at a model the review allows. The preview shows the change size, the budget, the required lead model and the exact `start` command, and writes nothing. It takes the same options as the command below:

       node .claude/skills/nth-review/scripts/nthr.mjs preview --ns reviews/<topic> --mode task --slug <name> --change .:<base>..HEAD

   Prefer `claude --model opus --effort high`.
   - The routing policy also allows Sonnet for a small change with no lead-model trigger, but the Sonnet comparison was not concluded.
   - Never use xhigh or max effort.
2. **Type the command:**
   - committed changes: `/nth-review task --ns reviews/<topic> --slug <name> --change .:<base>..HEAD`;
   - uncommitted changes in the working tree: `--change .`;
   - a repository nested in `<P>`: add `--change <repo>:<base>..HEAD`.

   Later, to review what changed since: `/nth-review incremental --ns reviews/<topic> --slug <name>-2 --base <run id of the earlier review>`. `<topic>` and `<name>` use lowercase letters, digits and hyphens.

   **Flow Review (BETA):** an entry is `<path>#<Symbol>` (a function, class, method as `Class.method`, or exported binding), or `<path>:<line>` / `<path>:<from>-<to>` for anything else, such as a route registration. Paths start with the repository directory. At most 8 entries. Examples:
   - one API endpoint: `/nth-review flow --ns reviews/orders --slug create-order --entry api/src/routes.js:12-18`;
   - one web action through the API: `/nth-review flow --ns reviews/checkout --slug submit --entry web/src/checkout.js#submitCheckout --entry api/src/orders.js#createOrder`;
   - a job or event flow: `/nth-review flow --ns reviews/billing --slug nightly --entry api/src/jobs/nightly.js#nightlyReconcile --entry api/src/consumers/email.js#onOrderCreated`;
   - a multi-entry business workflow: `/nth-review flow --ns reviews/refunds --slug refund --entry api/src/refunds.js#requestRefund --entry api/src/refunds.js#approveRefund --entry api/src/jobs/payouts.js#payRefunds`.

   The skill checks each entry with `resolve` and asks before opening when one is ambiguous or missing. Its report names every path it reviewed, excluded or left unknown; it is never a project audit.
3. **Read the report:** `.nth-review/reviews/<topic>/runs/<run id>/report.md`. The final message names the path and the status. The run table names the helper version (`Helper`). The sections are:
   - **Summary:** what the status means, the counts, and the **next step** (the exact follow-up command);
   - **1 Gaps:** open obligations, unverified findings and evidence, review debt, unknown census items, untested properties;
   - **2 Coverage;**
   - **3 Correctness**, where each held obligation is marked Verified or not verified;
   - **4 Findings**, each with its verdict and evidence anchors;
   - **5 Delegations;**
   - **6 Cost.**

   **`complete` is not "Verified".** `complete` means the run finished its method within its scope. Only an obligation marked Verified in section 3 is Verified, and a `candidate` or `needs_validation` finding is a lead, not a verified defect. An `incomplete` status is normal: it means something remained open, and the gaps say what.
4. **Status and decisions:** run from `<P>`, `node .claude/skills/nth-review/scripts/nthr.mjs status --ns reviews/<topic>` lists the runs, the outstanding debt and each namespace's `next` step. It is read-only. `nthr <command> --help` describes one command, including `decide`, which records your verdict on a finding.

The commands above are the same on macOS, Linux and Windows (PowerShell, Command Prompt or Git Bash): `node` accepts forward slashes in paths on every platform.

## Known limitations

From the M5-T4 synthetic benchmark; details in [VALIDATION.md](../VALIDATION.md):
- **False positives:** in one of two SYN-LEDGER runs, a valid finding was counted against a negative control, under the registered scoring rule.
- **Coverage:** in one of two runs, one census item was judged incorrect. Whether a population of affected sites was found exactly stayed unproven in both runs.
- **Variance:** two Opus runs on the same small fixture differed. One met every check; the other left a finding unverified and cited a document by section heading rather than line.
- **Sonnet:** its one valid run found the must-find defects but covered 2 of 7 census mechanisms. Sonnet vs Opus is **not concluded**.
- **What a finding is:** a `candidate` or `needs_validation` finding is a lead, not a verified defect. Only `held` with `all-enumerated` coverage, on verified evidence, counts as "Verified". Every result needs your judgement.
- **Cost:** on small synthetic fixtures, one review session cost about $1.20 to $4.80 at list price and took 3 to 13 minutes. Larger changes cost more: one real-project run (69 files, size L) cost about $6.79, with the run open for 13.9 minutes. The budgets cap tool calls, not money.
- **Platforms:** the helper's test suite passes on Windows (Git Bash and PowerShell) and on Linux (Ubuntu 24.04 under WSL, Node.js 20 and 22). **macOS is unverified.** The lifecycle rehearsal ran on Windows. Interactive sessions and real codebases rest on five owner runs; all other validation ran headless sessions on synthetic fixtures.
- **Working-tree reviews:** a new untracked file's lines are not counted, so a working-tree change with untracked files is never sized S (it gets the M budget and Opus). If a cited untracked file changes during a review, `close` refuses even with `--reassessed`: the run is resumed. Avoid editing untracked files in the reviewed repository while a review is open.
- **Flow Review (BETA):** validated on synthetic fixtures only, with no real-project run.
  - Symbol selectors match definitions by a per-language pattern table, not a parser. A missed or doubled match is refused, never guessed; use a line selector then.
  - Paths are only what the source shows: dynamic dispatch, injection and queues bound elsewhere stay `unknown`. Each code location is explored once; a cycle or shared dependency is recorded as a revisit and not expanded again.
  - A line selector follows lines, not code: if its file changes, close and resume refuse it. Prefer `#Symbol` selectors.
  - Exploration stops at depth 4 and at the edge limit, so a large flow closes with unknown paths and debt.
  - A git-ignored file is outside the snapshot: it can be an entry (close re-resolves it), but `footprint` and `close` refuse it as other evidence.
  - A flow run is not an Incremental baseline.
  - Older helpers cannot read a namespace that holds a flow run: update the skill before opening one.
- **Concurrency:** one review may be open per namespace at a time, and its helper commands run one at a time: nothing locks `records.json`, so two writers at once on one run may lose a write.
- **Independence is the lead's discipline:** a Task Review is told never to read earlier runs' records, reports or packs, but the helper cannot see what the lead reads. It refuses only the record channels (no freshness; debt-in only from an explicit `--base` or `--continues`).
- **Discovery handoff rests on the lead:** `check` requires a census disposition for every path the lead copies from R2 or R3 into `discovered`, but it never sees the delegate's answer, so a path left out is not detected.
- **Git 2.31 or later** is required: the helper uses `git rev-parse --path-format`.
