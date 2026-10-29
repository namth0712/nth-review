# nth-review v1.0: release contract and readiness

> **Redacted for publication (2026-10-29):** private project names and workstation paths are replaced by placeholders ("private project A", "private project B", `<work>`, `<config>`). No result, number or verdict changed. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#private-evidence-and-the-public-repository).

**Candidate:** helper `1.0.0-rc.2` (2026-10-29), which bundles the reviewer agent; §11 records what changed from `1.0.0-rc.1` and what that candidate's evidence still covers. Protocol `v0.1`, records `nth-review/records@1`. §1–§10 are the `1.0.0-rc.1` record (2026-10-28).
**Verdict: NOT YET STABLE.** The software checks pass on Windows and Linux. The review-quality gate has not run: it needs paid sessions that only the owner can approve. The historical G5 gate stays **FAIL**.

This file is the v1.0 release contract (§8), the readiness audit behind it (§2), and the gate results and verdict for this candidate (§9, §10). The evidence is in [VALIDATION.md](VALIDATION.md), section "v1.0 release candidate"; the gate is [tests/RELEASE-GATE-3.md](tests/RELEASE-GATE-3.md) (`nthr-release-gate@3`; @2, [tests/RELEASE-GATE-2.md](tests/RELEASE-GATE-2.md), and @1, [tests/RELEASE-GATE.md](tests/RELEASE-GATE.md), stay frozen as history); the user workflow and the lifecycle are [INSTALL.md](INSTALL.md). It is a development file: it is never installed into a project. **Repository move (2026-10-29):** nth-review left nth-dev-kit for this standalone repository, with the runtime byte-identical and the same candidate identity; see [MIGRATION-VALIDATION.md](MIGRATION-VALIDATION.md), which also maps the old paths the frozen gates and the historical logs name.

## 1. Product and supported capabilities

nth-review is a manually invoked, personal-use Claude Code skill. The user types `/nth-review`; a Claude Code lead follows [SKILL.md](SKILL.md) and its references; a zero-dependency Node.js helper (`scripts/nthr.mjs` and 15 modules) does everything that must be deterministic:
- **Source identity:** a snapshot at Open (tracked, untracked and flagged state per repository, with coverage limits), the footprint of every cited file at close, and freshness against a base run.
- **Bounds:** change sizing, budgets, the required lead model, and limits on obligations, paths and depth.
- **Records:** one `records.json` per run, written only through `apply` (a stale or protected edit is refused), validated by `check`, and closed by `close`, which writes `report.md`.
- **Delegation support:** bounded, verdict-free evidence packs for the refuters.
- **Continuity:** `resume`, review debt, `status`, and owner decisions (`decide`).

It delegates only to `Explore` (R3 plan-critique) and `reviewer` (R5/R6 refuters). It never edits the project, runs code or uses the network, and writes only under `.nth-review/`. Enable, Update and Disable install it per project with byte-exact provenance ([INSTALL.md](INSTALL.md)).

| Capability | v1.0 status |
|---|---|
| Task Review (committed range or working tree) | **in v1.0 scope**; Stable once the gate passes |
| Incremental Review (since a base run, with debt) | **in v1.0 scope**; Stable once the gate passes |
| Flow Review (explicit entry points) | **Beta** in v1.0: no sealed fixture measures it |
| `preview`, `status`, `decide`, `resume` | in v1.0 scope |
| Full Audit, `charter`, official audits | **unsupported**: disabled (`OFFICIAL_AUDITS_ENABLED = false`) |
| Sonnet lead (Task S, no trigger) | allowed by routing, **unvalidated**: gate B11 decides it |

**Explicitly unsupported:** Full Audit; Flow Review as Stable; macOS (unverified); a tracked copy of the installed skill; two helper commands on one run at once; xhigh or max effort; any model other than Opus or Sonnet; reviewing `.nth-review/` or the integration's own untracked files; symbolic links or junctions in the review paths; a partial clone on Git older than 2.44; recall claims on real projects.

## 2. Readiness audit

Each requirement is classified on its evidence. **Software correctness and review-judgment quality are separate:** passing tests say nothing about whether the model finds real defects.

**Software correctness**

| Requirement | Class | Evidence |
|---|---|---|
| Helper suite on Windows (Git Bash, PowerShell) | Verified | §9 A1 |
| Helper suite on Linux, Node.js 20 and 22 | Verified (new) | §9 A2; WSL Ubuntu 24.04, Git 2.43 |
| Helper suite on macOS | Unverified | no macOS machine |
| Node.js 20 on Windows | Unverified | Node 20 verified on Linux only |
| Enable / Update / Disable | Verified on Windows; unverified elsewhere | §9 A3, M4-T3 rehearsal |
| Snapshot, footprint, freshness, resume | Verified after fixes | the reliability audit found 9 demonstrated defects here, all fixed with regression tests (§4); the earlier "verified" was wrong |
| Records writer, check, close, report consistency | Verified after fixes | 7 demonstrated defects fixed (§4) |
| Cross-repository boundaries | Verified after fixes | multi-repository tests; the embedded-gitlink gap fixed |
| Budget enforcement | Partially verified | `check` enforces the **recorded** counts; the counts are the lead's own report; only transcripts observe them |
| Model routing | Partially verified | `check` enforces the recorded models and roles; a run that records no lead model is not checked; the helper cannot see which model actually ran |
| Sealed G5 evidence unchanged | Verified | §9 A4 |
| Safety switches (audits disabled, explicit invocation) | Verified | §9 A7 |
| Benchmark isolation | Verified on Windows only | the runner now refuses to start sessions elsewhere (A11) |

**Review-judgment quality**

| Requirement | Class | Evidence |
|---|---|---|
| G5 synthetic gate (M5-T4) | **Failed** (historical, immutable) | ledger seq 97 |
| RQ-1 Part B (precision, recall, severity and evidence, freshness, coverage truthfulness, refutation, repeatability, debt, cost) | Unverified: **BLOCKED** on paid runs | §9 |
| Security-boundary judgment | **BLOCKED**: no curated fixture | RQ-1 B7 |
| Sonnet lead | Unverified | SS2 never completed |
| Repeatability | Failed historically | SO1 and SO2 (both Opus, same fixture): 4 vs 2 items at full credit, precision 1.00 vs 0.667 |
| Precision on real projects | Unverified | no owner triage recorded (RQ-1 B12) |
| Recall on real projects | Unsupported by design | no ground truth |
| Flow Review quality | Unsupported by design in v1.0 | no sealed flow fixture |

## 3. Review quality evidence

From the frozen M5-T4 evidence (13 valid rows; read-only analysis; sealed answers' mechanisms not read):
- **Findings:** all 44 adjudicated `valid` with a correct mechanism; none `false` or `unsupported`.
- **False positives:**
  - L2 F-4 hit a negative control under Rule 4 v1 by line overlap, although the adjudicator judged it valid (the Rule 4 v2 diagnostic clears it);
  - SO2 confirmed a finding on heading-only document evidence (an unsupported confirmation): precision 0.667.
- **Missed at full credit:** SO2 E3 (left a candidate) and E4; SS1 E4. E4 was short of evidence in 3 of 4 shelf attempts.
- **Coverage claims:**
  - 20 of 196 census items were judged incorrect, all for an incomplete `affects` list;
  - the `ledger_writers` population stayed pending in L1 and L2;
  - 8 `all-enumerated` obligations had members the adjudicator found missing.
- **Under-concluding:** 22 of the 23 disputed obligations were left `open` where the source already settled them.
- **Refutation:** no wrong refuter role or model; no refuter outcome the adjudicator contradicted on validity; 6 candidates never verified.
- **Severity:** one overstated (L1), one understated (D1).
- **Waste, measured** (from the transcripts):
  - 25% of lead calls wrote records by hand (fixed since by `apply`: 31 → 7 calls in Beta v3);
  - about 19% of lead cache reads were whole reference files (estimated; fixed since by reading by section: −66%);
  - R3 re-read 52 files the lead had read, which is independent critique by design.

**RQ-1 diagnostic on the historical rows** (labelled; not RQ-1 evidence, since those rows ran an earlier implementation):
- B1, B2, B3, B5 and B8 **FAIL**;
- B4 and B9 pass;
- the rest are BLOCKED.

The new gate is therefore not weaker than G5 on the evidence G5 already judged. No historical score, verdict, adjudication or ledger event was changed or re-scored.

## 4. Reliability improvements in this candidate

Two independent audits demonstrated these defects, and an independent review of the fixes found two more (the last two rows). Each fix has a regression test in `tests/rc-hardening.test.mjs`, and each test fails with its fix undone (17 negative controls).

| Defect | Severity | Fix |
|---|---|---|
| A critical security defect "rejected" by the Sonnet refuter, by no refuter, or against an R5 "confirmed" answer still closed `complete` with its obligation "Verified" | high | the verdict follows the refuter's outcome; R5 binds every refuter-decided defect; an incomplete verification leaves a candidate |
| A cited untracked file edited after the evidence closed with `--reassessed`, was reported Verified, and the next run called it `current` (also through a `snapshot-changed` close in a multi-repository project) | high | the at-risk refusal applies in every mode (it was Flow-only); a `snapshot-changed` close records such files `unverified` |
| One large untracked file elsewhere, or an unrelated unproven tracked state, made `resume` abandon an unchanged run, and a Flow run could never close | medium | the at-risk set counts only files that could have changed |
| A held obligation was "Verified" while its own defect was still a candidate or `needs_validation` | medium | `check` refuses it |
| The lead could lower the required lead model of an Incremental or larger Task run | medium | `check` derives the requirement from the helper-owned budget |
| A report saying `complete` survived in an abandoned run after an interrupted close | medium | `resume --apply` removes it; `check` refuses one |
| `resume --apply` dropped the lead's `assumption-changed` marks | medium | they are handed on as debt |
| A gitlink committed without `.gitmodules` was never reported as uncovered | medium | every index is scanned for gitlinks |
| Twelve new 1,000-line untracked files were sized S with a Sonnet lead | medium | untracked files make the size uncertain (never S) |
| Evidence on a file absent at the origin stayed `current` | low | it is `touched` |
| A refused close still deleted leftover temporary files | low | removal happens after every refusal |
| A patch removing a missing id removed another item by position | low | ids only, in id-bearing arrays |
| The close message for a changed Flow entry advised a `resume` that cannot help | low | it names the explicit close |
| Five test-suite portability defects found on Linux (Git identity, Git version, Windows-only path forms, a vacuous assertion) and the Node 20 test command | low | fixed; `tests/run.mjs` runs on Node 20+ |
| Review: a cited untracked file too large to hash (over 1 MiB) could be edited and still close as reviewed | high | such a file is at risk when its repository hashed partly |
| Review: an unapplied `patch.json` blocked `resume` from abandoning its run | medium | `resume --apply` removes it; it is never applied |

**Not fixed, documented:**
- a Flow `#Symbol` selector can follow a same-name definition elsewhere on resume (Beta; reproduced on rc.1, and the resume plan shows the new lines before `--apply`). It cannot reach a Task or Incremental run: entries are resolved only in flow mode (`runs.mjs`, `close.mjs` and `resume.mjs` gate on it), `new-run` refuses `--entry` outside flow, and a flow run never builds on, or is built on by, another mode. So it does not block the v1.0 Stable scope;
- a run that records no lead model is not checked against routing;
- `GIT_DIFF_OPTS` is not scrubbed (it can only widen hunks, which is conservative);
- no lock between helper commands on one run.

## 5. Product experience

- **`preview`:** shows, before anything is opened, what `new-run` would do (size, budget, required lead model, triggers, debt) and the exact `claude` start command. It writes nothing.
- **Report Summary:** what `complete` means (never a verdict on the code), how many obligations are Verified, findings by verdict and severity, debt, unknowns, and the **next step** as an exact command.
- **Provenance:** a `Helper` row (version, protocol, records schema).
- **Cost table:** names the source of each number (recorded by the lead, counted, computed).
- **`status`:** gives each namespace's `next` step.
- **Help:** `nthr <command> --help` describes one command.
- SKILL.md changed only where the helper's rules changed (a cited file that may have changed is a `resume`).

## 6. Performance and cost

Observed, never estimated as a guarantee:
- **Task Review:** one review session cost $1.16–4.78 on synthetic fixtures (Opus median $3.40) and $4.64–6.87 on the owner's real runs, at list price.
- **Run length:** 12–14 minutes active from open to close.

Counters:
- **Lead-recorded:** `budget.spent` in the records.
- **Observed:** only in the session transcripts (`tests/tools/transcript-metrics.mjs`), and RQ-1 gates on the observed ones (B10).

This candidate removes no review work. The largest measured wastes were already fixed by `apply` and section reads, and the remaining one (R3 re-reading the lead's files) is independent critique by design. The budgets still cap tool calls, not money. V-COST budget recalibration needs the owner and the RQ-1 medians.

## 7. Platform support

| Platform | Status |
|---|---|
| Windows 11, Git 2.54, Node.js 22 (Git Bash and PowerShell) | **supported, verified**: suite, rehearsal, benchmark isolation |
| Linux (Ubuntu 24.04 on WSL 2), Git 2.43, Node.js 20.20.2 and 22.23.4 | **supported, verified**: the helper suite, symbolic-link refusals included. Not run: the lifecycle rehearsal and the benchmark runner (which refuses) |
| macOS | **unverified**: no machine; not supported until A2 passes there |
| Node.js 20 on Windows | unverified (Node 20 verified on Linux) |
| Git older than 2.44 | supported, except partial clones (refused outright) |

## 8. Release contract (v1.0)

1. **Supported:** Task and Incremental Review; `preview`, `status`, `decide`, `resume`; Enable, Update and Disable. Flow Review ships as Beta, outside the Stable claim.
2. **Unsupported:** as in §1. Full Audit stays disabled unless separately authorized by the owner and qualified by G6.
3. **Quality acceptance:** RQ-1 version 3 (`nthr-release-gate@3`) **PASS**: every Part A and Part B criterion PASS, with the thresholds as frozen (sha256 `031e85e5dfd78c77d40acc6a6d0169368232f73c308de91a404dd729d1412e89`, 2026-10-29T02:07:28Z; pinned in `tests/tools/gate-version.mjs`). @3 superseded @2 (sha256 `b92fb9da…9f51`), which superseded @1 (sha256 `cd9e067c…95ae`, 2026-10-28), before any registration or Part B row; both stay frozen as history. A threshold change is a new gate version, decided before any counted row.
4. **Mandatory regression checks** for every release candidate: RQ-1 A1–A11, which include the full suite on Windows and Linux and the lifecycle rehearsal. Any change to a runtime file after registration voids the candidate's Part B rows (the implementation manifest gate).

   **One exception, which the gate itself defines (B11):** if a Sonnet row fails, the Sonnet lead allowance is removed after the last row, and B11 counts as met once A1–A2 pass on that change. That routing change is the only one that does not void the Opus rows.
5. **Operational safety:**
   - read-only project;
   - only `.nth-review/` written, through the helper's guarded paths;
   - Git read-only, with no external diff, textconv, filters, hooks or fetch;
   - no network;
   - no secrets opened;
   - explicit invocation only;
   - official audits disabled;
   - paid evaluations only with owner approval and a cost cap.
6. **Installation compatibility:**
   - records stay `records@1`, so runs from earlier helpers stay readable;
   - `check` is stricter in this candidate, so an older closed run may fail a re-check, but its report and records are never rewritten;
   - Enable and Update install the 27 runtime files from the installed package only, verified against its manifest;
   - installing or updating the package (by the user, or by nth-dev-kit's Global Install/Update) never touches projects;
   - projects enabled from nth-dev-kit's library before the move keep working unchanged (INSTALL.md, Legacy installations).
7. **Release-candidate freeze:**
   1. commit this repository, so that `matrix.mjs implementation` reports `frozen: true`;
   2. run the isolation probes (paid, approved) and record them;
   3. `register` a new ledger (`g5-ledger-repeat.jsonl`);
   4. run the rows batch by batch, each with the owner's approval and cap;
   5. evaluate with `release-gate.mjs evaluate`.

   After the first counted row, no runtime, prompt, gate or tooling file changes; a fix means a new candidate and a new registration.
8. **Upgrade:** update the package (`claude plugin update nth-review@nth-review`), then Update in each enabled project, in a fresh session.
   **Rollback:** install the previous release's package (its tag), then Update; or Disable. Review records are never touched.
9. **Support policy:** personal use, best effort, no service level. A defect is recorded in VALIDATION.md, fixed with a regression test, and shipped in a new candidate.
10. **Hard blockers vs documented limitations:**
    - **Blockers:** any RQ-1 criterion not PASS.
    - **Acceptable when documented:**
      - macOS unverified;
      - Flow Review Beta;
      - lead-recorded counters;
      - no lock between helper commands;
      - pattern-based symbol resolution;
      - a run without a recorded lead model not checked against routing.

## 9. Release gate results for 1.0.0-rc.1

**Part A** (`release-gate.mjs offline` under gate @3, with this candidate's saved test output): see VALIDATION.md, "Release gate @3: the auto-update requirement removed", for the exact counts.

| Check | Result |
|---|---|
| A1 Windows suite (Git Bash, PowerShell) | PASS: 463 tests, 458 pass, 0 fail, 5 platform skips, in each (2026-10-29) |
| A2 Linux suite (Node 20, 22) | PASS: 463 tests, 456 pass, 0 fail, 7 platform skips, on each (2026-10-29) |
| A3 lifecycle rehearsal (Windows) | PASS: 75 rows, 72 pass, 0 fail, 3 unverified (Unicode normalization, two symbolic-link rows) |
| A4 sealed G5 evidence | PASS: 97 events, ledger sha256 unchanged, 90 of 90 evidence files byte-identical |
| A5 fixture determinism | PASS: all six fixture builds (the four fixtures, each `syn-ledger-inc` variant) built twice, with the sealed heads and byte-identical trees. Re-evaluated 2026-10-29: the first evaluation inferred A5 from two named tests, which built only two fixtures twice |
| A6 runtime inventory | PASS: 27 files, LF only |
| A7 safety switches | PASS |
| A8 source freshness | PASS |
| A9 coverage truthfulness | PASS |
| A10 security boundary (deterministic) | PASS |
| A11 benchmark tooling fails closed off Windows | PASS |

**Part B (gate @3):** every criterion **BLOCKED**. No row exists: registration needs a commit, and the rows need paid sessions with owner approval.
- **B7** also needs a curated security-boundary fixture. The tooling for it is implemented (SB1 and SB2).
- **B12** needs a third independent real run; evaluated on the owner's records today, it reads "3 completed, 2 independent".

## 10. Verdict and next actions

**NOT YET STABLE.** Part A passes. Part B, the only evidence about review quality, has not run. The last measured quality evidence (G5) failed on precision, coverage, repeatability and Sonnet.

**Remaining blockers** (gate @3):
1. **RQ-1 Part B core rows (B1–B6, B8–B11):** the owner must:
   - commit and freeze the candidate;
   - approve the isolation probes (about $2–3, cap $4);
   - approve the 14-row core matrix batch by batch (about $57–62 expected, $90 ceiling; G5-REPEAT-PLAN §8).
2. **B7** needs a package from an independent curator ([tests/SECURITY-FIXTURE-SPEC.md](tests/SECURITY-FIXTURE-SPEC.md)). Then the owner must:
   - record the package and register its rows (`record-curated-package`, `register-supplement`);
   - approve SB1 and SB2 under their own cap (about $5–6 each; capped like an L row at $11.50).

   The tooling exists; the fixture does not, and no nth-review developer may make it.

   **Fixed 2026-10-29:** SB2's adjudicator command line was about 52,500 characters, over the runner's 32,000 limit: its code `rp-` matched 125 unrelated `rp-*` entries in the temporary folder. The security rows' folders now carry a mark and their matrix's token (`rp-nthsec-<token>-…`), and on the owner's machine SB2's adjudicator is bounded at 30,225 characters. `drive` and `drive --dry-run` bound every session's command line before the first paid session, and each row's again before its review (VALIDATION.md, "Security rows' folder names and the command-line preflight").
3. **B12** needs at least one more independent real Task or Incremental run, and the owner's decision on every confirmed finding of the counted runs. On today's records it reads "3 completed, 2 independent" (Task v2 is contaminated).

### Owner decisions D1–D5 (taken 2026-10-29) and what implements them
| # | Decision | Implemented in this candidate | Still the owner's |
|---|---|---|---|
| D1 | Keep Sonnet as a supported lead, validated on coverage and evidence quality too | B11@2: each Sonnet row must also meet B1, B2, B3 and B5-style coverage on syn-shelf (census recall, populations exact, no overclaim) and `scoring.g5`. On M5-T4's evidence SS1 would fail it (2/7 census recall) | running SS1 and SS2; if either fails, B11's remedy removes the allowance after the last row (§8.4) |
| D2 | Externally curated security fixture, fixed rows, sealed answers, evaluator checks; B7 BLOCKED until valid independent evidence exists | rows SB1 and SB2 (Opus, high effort); `record-curated-package` and `register-supplement`; a builder from Git bundles that runs nothing from the package; deny rules and audit flags for the package; evidence outside the kit; `judgeB7`, which refuses test doubles | finding a curator; the anchor check; the SB batch cap |
| D3 | One confirmed finding per run is the unit; Task v2 is contaminated; completed and independent runs are counted apart; no threshold change | B12@2 needs 3 independent runs, counted per finding per run, and is computed from the records and `decisions.json` (`judgeB12`). A triage sheet and a draft run manifest are prepared outside the kit | confirming v1 and v3 as independent; one more independent run; every decision |
| D4 | One revised gate, @2, with all the changes; @1 and its history kept; @2 frozen before any paid run | [tests/RELEASE-GATE-2.md](tests/RELEASE-GATE-2.md), frozen 2026-10-29T00:43:19Z (sha256 `b92fb9da…9f51`). It is superseded by @3 (D5 corrected), which changes nothing else; @1 and @2 stay frozen, and a test fails if any version changes | registering under @3 |
| D5 | Reproducible environment: exact versions recorded, version consistency enforced, probes before paid runs. **Corrected 2026-10-29:** the benchmark uses the existing configuration (`<config>`) unchanged, and auto-update is not required to be disabled | [tests/RELEASE-GATE-3.md](tests/RELEASE-GATE-3.md) (`nthr-release-gate@3`, frozen 2026-10-29T02:07:28Z, sha256 `031e85e5…2e89`). `register` reads no auto-update setting. It refuses when the Claude Code version cannot be read, and records the Claude Code, Node.js and Git versions, the OS and the model pins. The version is re-checked before each row, audit and score, and transcript versions and resolved models are checked against the pins. A Claude Code update during the matrix stops it at the next check, so versions never mix. The probes are still required | none beyond the probes; an update during the matrix means reinstalling the registered version to continue |

**Recommended next action:**
1. Record triage decisions for the counted runs (free), using the sheet prepared outside the kit, and confirm the run manifest.
2. Make one more independent real Task or Incremental run on another change. It is ordinary use, not a benchmark row.
3. Review and commit this candidate together with the M5-T4 evidence. Every candidate file commits byte-identically under `.gitattributes`.
4. Approve and run the isolation probes, and record them.
5. `register` under @3, then approve the core batches.
6. When a curator delivers: store the package, run the anchor check, record the package, `register-supplement`, and approve the SB batch.

## 11. Candidate 1.0.0-rc.2

**Date:** 2026-10-29. **Verdict: NOT YET STABLE**, unchanged. G5 stays **FAIL** (historical), and Part B of gate @3 stays **BLOCKED**.

**What changed from `1.0.0-rc.1`:**
- **The reviewer agent is bundled.** The plugin ships the read-only agent `nth-review:reviewer` (`plugin-agents/reviewer.md`, sha256 `912eddae1f78fe808613dde430d87ba736efd247aa236a7665a51cb7af7f0aaf`). Its instructions, model (Sonnet by default), tools (Read, Grep, Glob, Bash, PowerShell) and 12-turn limit are those of the `reviewer` agent rc.1 was developed and measured with. Only its description differs: it restricts the agent to nth-review's delegations.
- **Delegation:** R4, R5 and R6 call `nth-review:reviewer`. Records still name it `reviewer`, so `nth-review/records@1` and `check` are unchanged, and rc.1 runs still validate. A fresh installation needs no agent of its own.
- **Preflight:** a review stops before opening a run when `nth-review:reviewer` is unavailable (the plugin is disabled).
- **Runtime files changed:** `SKILL.md`, `reference/prompts.md`, `reference/routing.md`, `reference/records.md`, and `scripts/lib/schema.mjs` (`VERSION`). The `library` digest is now `01814ebfc36f92f1d43578a6ebb65736d3d2cd3f78d941f789ffab388681f5cb`. The rc.1 digest `b6f87897…` identifies the rc.1 files only.

**Part A, re-run on rc.2** (`release-gate.mjs offline`, 2026-10-29): **PASS**, A1–A11, and the gate file is the pinned @3.
- **A1:** Windows 11, Node.js 22.22.3. Git Bash: 473 pass, 0 fail, 5 skipped. PowerShell: 473 pass, 0 fail, 5 skipped.
- **A2:** Linux (Ubuntu 24.04 under WSL), Node.js 20.20.2 and 22.23.4: 471 pass, 0 fail, 7 skipped each.
- **A3:** rehearsal, 84 rows: 81 pass, 0 fail, 3 unverified (symbolic-link rows need privileges).
- **A4:** the ledger verifies (97 events), and 90/90 manifest evidence files are byte-identical.
- **A5–A11:** PASS. A6 counts 27 runtime files, and `runtime-manifest.json` is current.
- **Plugin probe** (Claude Code 2.1.312): 27/27. What it covers:
  - a fresh configuration with no agent named `reviewer`, and `nth-review:reviewer` in both projects once the plugin is enabled;
  - the project copy's helper reporting `1.0.0-rc.2`;
  - update, rollback, disable and uninstall;
  - enabling the plugin for one project only (`--scope local`), with the other project offered neither the command nor the agent;
  - coexistence with a general user-level `reviewer` and with a project's own `reviewer`, whose files never change.
  
  Inventory sessions stopped at "Not logged in". Delegating sessions talked only to a local stand-in for the Messages API (127.0.0.1, a dummy key). In those sessions the Agent tool launched the bundled agent for `nth-review:reviewer`, with its instructions, Sonnet and its read-only tools. A bare `reviewer` was refused as not found when nth-review was the only source. Otherwise it launched the user's or the project's own agent, never the bundled one. Every session cost 0. The same 27 rows pass when another kit's own general `reviewer` file is supplied as that user agent (`--general-agent`).
- **A copy without the private evidence** (the public repository): the suites pass with 469 (Windows Git Bash) and 468 (Linux) passes, 0 fail. A4 reports UNVERIFIED, not PASS.
- **macOS:** not tested.

**What the earlier evidence covers.** The G5 record, the M5-T4 evidence and the real Beta runs were all produced with the developer's own `reviewer` agent and the rc.1 runtime (or earlier). They stay exactly as recorded. They carry over to rc.2 only by equivalence: the bundled agent has the same instructions, model, tools and turn limit, and only its call name and description differ. Whether that equivalence is enough is the owner's judgement.

**Additional qualification rc.2 needs:**
1. **Part B on rc.2:** gate @3's Part B must run on this candidate. The benchmark configuration (`<config>`) must have the nth-review plugin at `1.0.0-rc.2` installed and enabled, so that every matrix session can delegate to `nth-review:reviewer`.
2. **A real model's delegation:** the probe shows that Claude Code resolves and launches `nth-review:reviewer` from a scripted delegation, but no real model has yet chosen that name while following the skill, and no real refutation has run. The first owner-approved real run must show R5 or R6 delegations with `subagent_type` `nth-review:reviewer` completing. The transcript metrics match them to records named `reviewer`. Records alone cannot show which name was called; the transcript can.
3. **If they do not complete:** the refutations end as `candidate` with `verification.incomplete`, the existing fail-closed path, and rc.2 does not proceed.
