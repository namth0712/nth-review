# G5 repeat (M5-T4R): proposed pre-registration

> **Redacted for publication (2026-10-29):** private project names and workstation paths are replaced by placeholders ("private project A", "private project B", `<work>`, `<config>`). No result, number or verdict changed. See [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md#private-evidence-and-the-public-repository).

**Status: PROPOSAL. Not registered, not approved, nothing run.** This document prepares a new, pre-registered repeat of the M5-T4 matrix for gate G5. It changes no historical result: the M5-T4 verdict (G5 = FAIL, ledger seq 97) is final and stays as recorded.

**Used by RQ-1 (2026-10-28; version 3 since 2026-10-29):** the v1.0 release quality gate ([RELEASE-GATE-3.md](RELEASE-GATE-3.md), `nthr-release-gate@3`, which superseded [RELEASE-GATE-2.md](RELEASE-GATE-2.md) @2 and [RELEASE-GATE.md](RELEASE-GATE.md) @1 before any registration or Part B row) runs this plan's 14-row matrix as its core rows, plus two security rows (SB1, SB2) on an independently curated fixture under a supplementary registration with their own cost cap. It also uses this plan's validity classes, registration, probes and stop rules. It fixes OD-1 to OD-12 to this plan's recommendations, taking the stricter reading where one is offered, and adds criteria (severity and evidence, coverage overclaims, refutation soundness, repeatability, a security-boundary fixture, real-project triage). Neither changes the M5-T4 verdict.

**Readiness (2026-10-28):** the runner changes for B1–B3, M1 and M2 are implemented and tested, and the M5-T4 evidence is archived. B4 is specified in §11, not run. The status of each blocker is in §6. What still needs the owner: the commits (B2, B3), the probe batch (B4) and the decisions OD-1 to OD-12.

- **Scope:** the plan, the rules to register, the readiness blockers, the costs and the owner decisions. It authorizes no paid session; every paid step needs its own owner approval (§8).
- **Sources:**
  - `agents/claude/integrations/review/VALIDATION.md`, "M5-T4 validation matrix" through "G5 readiness review";
  - `tests/fixtures/README.md` (evaluation criteria, corrections, Rule 4 v2, blind adjudication, runner);
  - `tests/tools/matrix.mjs`, `score.mjs`, `transcript-metrics.mjs`, `session-guard.mjs`;
  - the G5 gate text, delivery roadmap §4: `.nth-review/research/nth-review-delivery-roadmap.md` in a worktree of private project A. It lives outside the kit, which holds only the M5-T4 record of it.
- **What the author read:** this plan was prepared in a development session. That session read the fixtures README, the sealed answers' `scoring` sections and item ids, and the scored results. It did not read item mechanisms or anchors. It must not act as adjudicator.
- **Labels:**
  - **[H]** historical fact;
  - **[R]** M5-T4 rule carried over unchanged;
  - **[C]** a clarification of ambiguous registered text;
  - **[N]** a new rule.

  [C] and [N] items take effect only once registered. **OD-n** are owner decisions (§10).

## 1. The historical verdict (immutable)

**Anchors [H]:**
- **Ledger:** `tests/fixtures/g5-ledger.jsonl`, 97 events, sha256 `7aa36b1666e031808199087d1456526384d47de459c98b862b4edb1bde8f1f18`. Its last event, seq 97, is `evaluation-closed` (2026-10-27T08:17:27.690Z).
- **Sealed answers:** sha256 `e0d29759…` (syn-ledger), `4b4af0db…` (syn-ledger-inc), `469e8a92…` (syn-debt) and `4fb29989…` (syn-shelf), unchanged today.
- **Skill:** all 18 pre-run records name skill `93f741bf…`.

| G5 dimension | Roadmap §4 threshold (verbatim) | M5-T4 official result | Status |
|---|---|---|---|
| Coverage completeness | census recall 100% over sealed mechanisms, or `unknown`; population counts exact | L1 8/8; L2 7/8 adjudicated (one census item judged incorrect: `affects` omits an obligation). `routes` exact in both runs. `ledger_writers` pending in L1 (OB-9 disputed) and L2 (OB-14, OB-16 disputed) | **not met** |
| Finding accuracy | P1 and P2 confirmed or `needs_validation` with the correct mechanism in **every** run; ≥ 3 of 4 of P1, P2, P5, P6 per run | L1 4/4, L2 4/4 | met |
| False positives | N1 and N2 never `confirmed`; ≤ 1 other false confirmed per run; precision ≥ 80% | L2: finding F-4 hit N1 and P3 under Rule 4 v1, by line overlap only. Its control-rule hits: 2; distinct false findings: 1; precision 0.80. Other false confirmed: 0 per run | **not met** (N1 confirmed) |
| Indirect invalidation | target reopened with the correct reason in every INC run; never `current`; C11 complete | 6/6 (with corrections 1, 2 and B) | met |
| Review debt | R1 `incomplete` with debt-out; R2's debt-in 100% dispositioned; `check` green | D1 and D2 (with correction C) | met |
| Agent completion | ≥ 90% complete without recovery; 100% within ≤ 1 | 35/35 delegations | met |
| Routing compliance | 0 violations | 0 in 13 valid rows | met |
| Cost | spent ≤ budget in ≥ 90% of runs; medians reported; budget table recalibrated | 13/13 within budget; recalibration (V-COST) not done | met; calibration pending |
| Sonnet vs Opus High lead | Sonnet keeps the low-risk rows only if it meets every accuracy and false-positive threshold; otherwise they move to Opus High | SS2 stopped at a $1.69 Claude Code cap after 478 s, run still open. Voided (seq 96); M5-T4 closed without it | **not evaluable** |

**Owner decisions in force during M5-T4 [H]:**
1. Sonnet leads only `syn-shelf` (scoring rule `scoring.g5`); the roadmap's "Sonnet on SYN-LEDGER" is superseded.
2. Adjudication is blind, independent and frozen before scoring.
3. Execution is staged: a free preflight, isolation checks, a pilot L1, then batches of at most 3 rows.
4. SYN-LEDGER-INC "× 2" means per variant, so 6 Incremental rows.

Also in force:
- **A:** Rule 4 as registered; v2 is diagnostic only.
- **B:** group-path census matching.
- **C:** debt kinds come from the base run.
- **D:** SO2's first attempt stays invalid; audit rule `own-tool-results-v2` applies to later audits.

**Not changed by this plan:** any score, verdict, adjudication, answer, fixture, threshold or ledger event. The L2 N1 hit stays official, and the pending populations stay pending.

## 2. Why the repeat is the full matrix

**The implementation under test is not M5-T4's.** Since then:
- the Beta fixes:
  - references are read by section;
  - the change is read as one net diff;
  - the lead asks once, before any helper command;
  - the integration's own files are left out of snapshots;
- the `apply` records writer;
- the Task Review independence rules;
- the R3 discovery handoff, with `discovered` checked at close.

**Every G5 dimension is affected:**
- every row writes its records through `apply`;
- every Task row runs under the new independence rules;
- coverage depends on the census and discovery changes;
- Incremental rows depend on the snapshot and `fresh` changes.

The roadmap's test discipline (§6) requires "a G5 rerun of the affected dimension" after a reference, prompt or helper change. Here that is all of them.

**Combining historical "met" rows with new rows would score two implementations as one.** So no M5-T4 row counts toward the repeat, and the repeat re-runs all 14 rows. The historical rows are comparison data only.

## 3. Scoring rules: carried over, clarified, new

| Rule | Label | Proposal | Effect |
|---|---|---|---|
| Evaluation criteria 1–13, M5-T3 clarifications | [R] | as in `tests/fixtures/README.md` at the registration commit | none |
| Corrections 1, 2, B, C | [R] | part of the scorer from the first row (they implement written criteria) | none |
| Blind adjudication and its fixed mapping | [R] | unchanged (README "M5-T4: blind independent adjudication") | none |
| Audit rule | [R] | `own-tool-results-v2` from the first audit | none |
| **Rule 4** (controls) | [R] by default | **OD-1.** Recommended: **v1 stays official.** v2 is computed for every row as a labelled diagnostic and never becomes a score. If the owner registers v2 as official instead, that is **[N] and a relaxation**: v2 can only remove control hits. Every row must then also report v1, and the verdict must name the rule it rests on | v1: strictest, no tooling change. v2: needs an official `--rule4 v2` scorer mode (tooling, §6) |
| **Population exactness** | [R] by default | **OD-2.** Recommended: unchanged. Exact only when every member is cited **and** every citing obligation is agreed; `pending` counts as not met. A refinement that judges membership apart from disputes about obligations' conclusions may run only as a labelled diagnostic | a refinement would be [N] and a relaxation |
| **Precision scope** | [C] | **OD-3.** Recommended: ≥ 0.80 **per run**, the stricter reading of "per run" in the same cell; pooled precision is reported. A `pending` unmatched finding counts in the denominator only (`score.mjs` already does this) | stricter than pooled |
| **Which rows gate which dimension** | [C] | **OD-5.** Recommended, the M5-T4 scope: coverage, accuracy, false positives and precision gate on L1 and L2; Incremental rows gate indirect invalidation; D1 and D2 gate review debt; completion, routing and cost gate on all 14 rows; SS1 and SS2 gate the Sonnet rule. Every other row's precision and coverage are reported | unchanged from M5-T4. Extending gating to more rows would be [N] and stricter |
| **Cost: what "spent" is** | [C] | **OD-4.** Recommended: the **observed** lead calls after the executed `new-run`, and the observed subagent calls, from the transcripts. The lead's recorded `budget.spent`, which the Beta v2 run double-counted, is reported with any mismatch. ≥ 90% of 14 means at least 13 rows within budget. V-COST recalibration follows G5; it is not a pass condition, as in M5-T4 | more objective; no tooling change (`summary` already has `after_open`) |
| **Sonnet dimension semantics** | [C] | **OD-6** (§5.7) | |
| Validity and rerun classes | [N] | §5.8 | replaces M5-T4's ad hoc voids |
| Scorer-defect protocol | [N] | §5.8 | |
| Futility stop | [N] | **OD-8** (§8) | saves money; the verdict is unaffected |

## 4. Execution matrix

The same 14 rows and 4 chains as M5-T4, on the same sealed answers. Routing follows `reference/routing.md`: R3 and R6 on Sonnet, R5 on Opus at high effort. The adjudicator is a fresh Opus 5.5 high-effort session for every row.

| Row | Fixture build | Mode (base) | Lead | Pre-registered routing (`EXPECTED`) | Gates | Review allowance | Drive cap |
|---|---|---|---|---|---|---|---|
| L1 | `syn-ledger` | task | Opus 5.5, high | `opus-high`; triggers ⊇ task-size, authorization, money | coverage, accuracy, false positives | $8.50 | $11.50 |
| L2 | `syn-ledger` | task | Opus 5.5, high | same | same | $8.50 | $11.50 |
| I1c | `syn-ledger-inc --from` L1 | incremental (`--base` L1) | Opus 5.5, high | `opus-high` | indirect invalidation | $10.00 | $13.00 |
| I1r | `syn-ledger-inc-rewritten --from` L1 | incremental (L1) | Opus 5.5, high | `opus-high` | same | $10.00 | $13.00 |
| I1d | `syn-ledger-inc-dirty --from` L1 | incremental (L1) | Opus 5.5, high | `opus-high` | same | $10.00 | $13.00 |
| I2c | `syn-ledger-inc --from` L2 | incremental (L2) | Opus 5.5, high | `opus-high` | same | $10.00 | $13.00 |
| I2r | `syn-ledger-inc-rewritten --from` L2 | incremental (L2) | Opus 5.5, high | `opus-high` | same | $10.00 | $13.00 |
| I2d | `syn-ledger-inc-dirty --from` L2 | incremental (L2) | Opus 5.5, high | `opus-high` | same | $10.00 | $13.00 |
| D1 | `syn-debt` | task | Opus 5.5, high | `opus-high`; ⊇ money | review debt (R1) | $7.00 | $10.00 |
| D2 | D1's fixture, no new commit | incremental (D1) | Opus 5.5, high | `opus-high` | review debt (R2) | $7.00 | $10.00 |
| SO1 | `syn-shelf` | task | Opus 5.5, high (reference arm) | `sonnet` required; triggers exactly none | reported (Opus reference) | $5.50 | $8.50 |
| SS1 | `syn-shelf` | task | Sonnet 5.5, no effort flag (observed high) | same | Sonnet rule | $5.50 | $8.50 |
| SO2 | `syn-shelf` | task | Opus 5.5, high | same | reported | $5.50 | $8.50 |
| SS2 | `syn-shelf` | task | Sonnet 5.5, no effort flag | same | Sonnet rule | $5.50 | $8.50 |

Completion, routing and cost gate on every row.

- **Review allowance [N]:** twice the most expensive M5-T4 review on the fixture: L $4.11, Incremental $4.78, debt $3.38 and shelf $2.64. The shelf figure covers Sonnet too, whose failed attempt passed $1.70.
- **Drive cap:** the allowance plus the runner's fixed $3 adjudication reserve.
- **One drive per row:** each row runs as its own `drive <row> --max-budget <drive cap>`. The review session's Claude Code cap is then exactly its allowance, and the adjudicator gets what remains, at least $3 (the largest M5-T4 adjudication cost $1.38). This needs no runner change and avoids SS2's starvation: under one batch cap, a late review got the remainder minus $3.
- **Chains:** L1 → I1c, I1r, I1d; L2 → I2c, I2r, I2d; D1 → D2; SO1 → SS1 → SO2 → SS2. `drive` already refuses a row ahead of an unscored row of its chain, or whose base has not closed.
- **Concurrency:** 1, the runner's default. One session runs at a time.
- **Batches** [R], at most 3 rows each, each approved separately:
  - 0: free preflight;
  - P: isolation probes;
  - 1: pilot L1;
  - A: I1c, I1r, I1d;
  - B1: L2, I2c, I2r;
  - B2: I2d;
  - C: D1, D2;
  - S1: SO1, SS1, SO2;
  - S2: SS2.
- **Order and randomization [N]:**
  - The pilot L1 runs first.
  - Then the blocks A, B = (B1, B2), C and S = (S1, S2) run in a seeded order. Take the first 8 hex digits of the sha256 of the `registered` ledger line, as an integer s. The order is the (s mod 24)-th permutation of [A, B, C, S] in lexicographic order.
  - The seed exists only after registration, so nobody chooses the order.
  - Within chains, the order is the registered one (alternating Opus and Sonnet on `syn-shelf`, Opus first). Randomizing it would need a runner change; the fixed alternation is recorded as a limitation.

## 5. What the registration pins

The registration is (a) a clean kit commit that contains this document, the tooling and the answers, and (b) a `registered` event in a **new** ledger, `tests/fixtures/g5-ledger-repeat.jsonl`. The name keeps the `g5-ledger` leakage label, so a session naming it is caught. The historical ledger is never appended to.

1. **Models and configurations:**
   - **Pinned:**
     - the Claude Code version the isolation probes (§11) record on the frozen commit. M5-T4's record is 2.1.311; on 2026-10-29 the installed version is **2.1.312** (it auto-updated). Under gate @3, auto-update is not required to be disabled (the owner's correction of D5): `register` records Claude Code, Node.js, Git, the OS and the model pins, and every row, audit and score re-checks the version, so an update during the matrix stops it at the next check (RELEASE-GATE-3.md §4);
     - lead `--model opus --effort high`, which must resolve to `claude-opus-5-5`;
     - Sonnet `--model sonnet` with no effort flag, which must resolve to `claude-sonnet-5-5`;
     - the adjudicator at Opus 5.5 high;
     - the fixed operator note, the session guard, the default permission mode with no allow rules, `--strict-mcp-config` and the disallowed tools [R].
   - **Recorded:** Node, Git and the OS.
   - **Mismatch:** a resolved model id that differs from the pin stops the matrix (§8).
2. **Implementation:**
   - **Pinned by the runner:** `register` records the implementation manifest (`matrix.mjs implementation`): the commit, every material file's sha256, the session configuration's digest, and the skill a fixture will hold. The material files are the skill's runtime entries and `review.md`, `tests/tools/**`, the builder with its templates and answers, the fixtures README, `g5-criteria/`, the Enable transcription and helpers, and this document.
   - **When `register` refuses:** an implementation that is not frozen, and a missing isolation record or one taken on another implementation, configuration or version.
   - **Checked:** `drive` and every row refuse a changed implementation or configuration. `prepare` refuses a built skill that differs from the registered one. `verify-ledger` checks every pre-run against the registration.
3. **Populations and samples:**
   - **Fixtures:** the 4 deterministic builds with the unchanged answers.
   - **Gating items:** P1–P6 and N1–N2 with 8 census mechanisms and the populations `routes` and `ledger_writers` (syn-ledger); target T1 in 3 variants (syn-ledger-inc); E1–E4 and EN1–EN2 (syn-shelf).
   - **Reported only:** X1–X4 (syn-debt).
   - **Sample:** n = 2 Opus repeats on syn-ledger, 6 Incremental rows, 1 debt chain, and 2 Opus plus 2 Sonnet rows on syn-shelf. No row may be added or removed after registration.
4. **Run order:** §4.
5. **Thresholds:** §7, verbatim from roadmap §4 with the [C] readings of §3.
6. **False-positive adjudication [R]:**
   - The blind adjudicator judges each finding `valid`, `false`, `unsupported`, `duplicate-of` or `cannot-tell`, without the answers, and its file is frozen by sha256 before scoring.
   - A control a finding touches stays a false positive whatever the adjudicator says, under Rule 4 as decided in OD-1.
   - An unmatched `false` or `unsupported` finding is a false positive; `cannot-tell` stays pending and earns nothing.
   - A rejected adjudication file gets one repair turn in the same session, before the freeze.
7. **Census completeness [R]:**
   - Recall is over the sealed mechanisms, credited only through a census item judged `correct` (exact or group path) or an obligation judged `agree`.
   - A population is exact per OD-2.
   - `discovered` is not a scoring input: coverage is measured against the sealed mechanisms whatever the lead records.
8. **SS2 comparison [R] rule, [C] semantics (OD-6):**
   - **The rule:** `scoring.g5` as registered. Each Sonnet row must meet all of:
     - full credit on E1 and E2;
     - ≥ 3 of E1–E4 at full credit;
     - EN1 and EN2 never confirmed;
     - ≤ 1 other false confirmed;
     - precision ≥ 0.80.
   - **The decision:** Sonnet keeps the Task S no-trigger row only if both SS1 and SS2 meet every check; otherwise the row moves to Opus High.
   - **Reported, not gating:** the Opus rows, with the measures M5-T4 reported (must-find, full-credit items, partial or unsupported items, census recall, population, evidence, cost per obligation).
   - **No statistical test:** n = 2 per arm supports none.
   - **Semantics (recommended):** the dimension is *met* when both Sonnet rows are valid and scored and the decision is recorded. If the decision is "move", the verdict reads **PASS with a routing follow-up**. That `runs.mjs` and `routing.md` change needs G1–G3 green before any release claim.
   - **Optional, stricter [N]:** if the row moves, require the Opus rows to meet the same checks too. M5-T4's SO2 did not.
9. **Invalid and incomplete runs [N]:** each class is decided from facts recorded before adjudication, or by the mechanical version check, never from a score.

   | Class | Examples | Action |
   |---|---|---|
   | V1 harness failure | API or transport error, Claude Code crash, a session cap below the row's registered allowance, a version gate tripped mid-row, a pre-run record that differs from the registration, a failed or rejected adjudicator session | void and rerun; at most 2 per row and 3 in the matrix. An adjudicator failure reruns the adjudication only, never the review |
   | V2 audit invalid | an executed outside read, write or Git write; web or network use; a tool input naming the sealed side or the kit; a fixture change outside `.nth-review/`; a call without a guard decision | void and rerun once. If an isolation defect caused it, stop the matrix, fix it, re-verify isolation (paid, approved), then rerun |
   | V3 reviewer outcome | not closed for a reason inside the session (including reaching its allowance), closed `incomplete`, `check` failures, budget overrun, routing errors, a lost records write, any score | **never rerun**; scored as it is. An unscorable row fails every dimension it gates |
   | V4 integrity at scoring | the score is not official (heads, tree or anchors) | V1 if the runner's before/after tree check shows the session did not cause it, otherwise V2 |

   - **Preserved:** every void keeps its ledger events, folders, transcripts and cost (voided costs), and is denied to later sessions [R].
   - **Exhausted reruns:** a row that uses up its reruns has no valid attempt, so G5 cannot PASS. The matrix stops for an owner decision.
   - **Scorer defects [N]:**
     - A correction is allowed only when the scorer departs from the **written** registered rule.
     - An independent reviewer must check it, and it applies to every row.
     - The original scores stay, and each re-score is a `rescored` event.
     - Written rules, thresholds and answers are frozen until the matrix closes. A rule change can only go into a further registration.
10. **Evidence and reproducibility:**
    - **Per row:**
      - the pre-run record;
      - the stream and transcripts, with the subagents;
      - `records.json`, `report.md` and the packs;
      - the audit;
      - `verdicts.json` with its `.meta.json`;
      - the score and metrics (exported to `<fixture>/reports/` and `<fixture>/adjudications/`);
      - the Rule 4 v2 diagnostic (OD-1).
    - **Checks:**
      - `verify-ledger` on both ledgers, at registration and at close;
      - the historical ledger's sha256 unchanged.
    - **Reproducible:**
      - fixture builds;
      - scores, recomputed from frozen adjudications;
      - costs, recomputed from transcripts.
    - **Not reproducible:** model outputs (no sampling seed). The repeat measures one draw per row.

## 6. Implementation readiness

**Is the discovery handoff sufficient to run the repeat fairly?** Yes, for fairness of the measurement:
- census recall is scored against the sealed mechanisms, not against `discovered`;
- a lead that omits a discovered path can only lose coverage, never gain it.

It is not sufficient to attribute a coverage miss: whether R3 reported the file and whether the lead dropped it are visible only in the transcripts. That is H1.

**Risk from unverified lead-to-helper reporting:** no bias toward a false PASS. The risks are:
- a miss that cannot be explained without reading the transcripts;
- a close refused for a discovered path without a disposition, which costs lead calls. That is an implementation outcome (V3), counted against the review.

**Is the single-writer restriction sufficient for the controlled experiment?** Yes, with conditions:
- one session runs at a time (concurrency 1);
- each fixture has one lead;
- delegates are told never to touch `.nth-review/` beyond their packs;
- a lost write caused by the lead's own parallel calls is a property of the implementation and counts against it (V3); it never voids a row.

Not verified: whether Claude Code executes two shell calls from one message concurrently. The transcripts time every call, so an overlap can be detected afterwards (H2). No lock is needed for validity.

**Blockers.** Each must be resolved before registration. Status as of 2026-10-28; VALIDATION.md "M5-T4R readiness" has the details.

| # | Blocker | Evidence | Resolution | Status |
|---|---|---|---|---|
| B1 | **Historical review folders are reachable under the same row codes** | 13 historical fixture folders (`w<a…m>-*`) with full `.nth-review/` records, 13 sandboxes (`r<a…m>-*`) and their transcripts. `denyRootsFor` left a session's **own** row code out of the deny rules, so a new L1 reviewer was not denied the historical L1 folder or its transcripts, and a new L1 adjudicator not the historical L1 sandbox. The session guard (exact to the session's own folder) was then the only barrier | **Exact enumeration, not new codes.** Every existing folder under the session's own code is denied by its exact path, except the session's own. New codes would have doubled the deny list past the Windows command-line limit. A command that would not fit is refused before the session starts. The audit also places Glob and Grep patterns | **Implemented and tested** (adversarial guard and deny-rule tests; negative control). The live check is B4 |
| B2 | **The historical evidence is not under version control** | `g5-ledger.jsonl`, `tests/tools/`, the `adjudications/` and `reports/` folders and `syn-shelf/` are untracked. Run records exist only in the temporary folder, and transcripts only in the matrix's configuration (`<config>`), which removes transcripts after `cleanupPeriodDays` (unset: 30 days) | **Done:** `evidence.mjs archive` copied 4,701 files (≈ 67 MB) into a user-only archive outside Git and verified them. The committable hash-only manifest is `tests/fixtures/g5-evidence-m5t4.json`, and roadmap §4 is captured in `tests/fixtures/g5-criteria/`. **Missing:** the matrix root (not supplied, not found) and the records of the three voided attempts moved under it | Archive **done**. Owner: commit the evidence and the manifest; supply the matrix root if it still exists, and archive it with `--root`; decide `cleanupPeriodDays` |
| B3 | **The implementation under test is not frozen** | HEAD `7780c8a`. When first measured, 18 of the 118 material files were modified and 36 untracked. Since then the Flow Review work has landed (8 runtime files changed, `flow.mjs` added; 27 runtime files), and the full suite is green (414: 409 pass, 0 fail, 5 platform skips) | **Implemented:** the implementation manifest, which also catches deleted files. `register` refuses an implementation that is not frozen; every row is gated on the registered manifest before its session, its audit and its score | Gate **implemented**. Owner: regenerate the list with `matrix.mjs implementation`, review and commit, then register at a clean HEAD |
| B4 | **A new ledger needs its own isolation record** | `drive` and now `register` need an `isolation-verified` record taken on the installed version, the frozen implementation and the configuration | Probes specified in §11 | **Not run** (paid; approval per §8) |
| B5 | **Open rule decisions** | M5-T4 needed decisions A–D mid-matrix | Decide OD-1 to OD-12 before registering | open |
| B6 | **Only if OD-1 makes Rule 4 v2 official** | `score.mjs` computes v2 only as `v2-diagnostic` | Tooling: an official v2 mode recorded in each score, with tests | not needed unless OD-1 chooses v2 |

**Measurement gaps.** They gate no G5 threshold; they should be fixed before registration, or registered as `unavailable`:
- **M1:** `transcript-metrics.mjs` detects records writes only as Write or Edit of `records.json`. Under `apply`, the lead writes `patch.json` and runs the helper, so two things are lost:
  - `lead_tool_calls_after_open_to_last_record_write` becomes null;
  - `record_edits_after_b1` reads 0, so no discharge after the B1 stop is seen (criterion 12).

  The fix: count an executed `apply` (with its `patch.json` ops) as a records write. **Implemented**, with a split by kind; a transcript without an apply keeps its M5-T4 values.
- **M2:** `score.mjs` prints the cost line from the lead's recorded `budget.spent`. Under OD-4 the observed counts decide; the summary already holds them. **Implemented:** `cost observed (transcript)` and `cost_observed` sit next to the unchanged recorded line.
- **Pre-registration:** both are measurement rules. The registration pins them through the implementation digest (the tools and this README), and OD-4 decides which count gates.

**Optional hardening:**
- **H1:** a transcript diagnostic that compares each R3 answer's `uncensused` list with the delegation's `discovered`, to attribute coverage misses.
- **H2:** an audit report of overlapping records-writing helper calls, and of any such call from a subagent.
- **H3:** a `drive` gate that refuses a skill or tooling hash different from the registration. **Implemented** as part of B3.
- **H4:** a held-out fixture authored after the freeze, to test for overfitting. That belongs to G6's design, not G5's.

## 7. Acceptance checklist

**G5 = PASS only when every box is ticked.** Anything else is FAIL, or "not evaluable", which also blocks a PASS.

**Validity:**
- [ ] The registration commit precedes the `registered` event, which precedes the first `pre-run`. `verify-ledger` is ok on both ledgers, and the historical ledger's sha256 is unchanged.
- [ ] Every row ran on the pinned Claude Code version with a matching `isolation-verified` record, at the pinned models (resolved ids checked in the transcripts).
- [ ] All 14 registered rows have one valid, audited attempt, adjudicated independently (frozen before scoring) and scored officially. No other row exists, and every void has a §5.9 class.
- [ ] Every pre-run `skill_sha256` and answers sha256 equals the registered one.

**Thresholds:**
- [ ] **Coverage (L1, L2):** adjudicated census recall 8/8 (classified or `unknown`) in each run; `routes` and `ledger_writers` exact in each run, under OD-2.
- [ ] **Finding accuracy (L1, L2):** P1 and P2 at full credit in each run; ≥ 3 of P1, P2, P5, P6 at full credit in each run.
- [ ] **False positives (L1, L2):** N1 and N2 never confirmed under the OD-1 rule; ≤ 1 other false confirmed in each run; precision ≥ 0.80 in each run (OD-3).
- [ ] **Indirect invalidation (6 rows):** each meets rule 9 as corrected: the inherited target reopened with a correct reason, none left current, and C11 complete.
- [ ] **Review debt:**
  - D1 is `incomplete`, and its debt-out covers every open obligation and unverified candidate;
  - D2 dispositions 100% of its debt-in, every kind resolves, and no `runtime` or `owner-fact` debt is discharged;
  - `check` is green on both.
- [ ] **Agent completion (14 rows):** ≥ 90% of delegations complete without recovery, and 100% within ≤ 1 recovery. Otherwise the roadmap's new-agent rule applies, and G5 repeats.
- [ ] **Routing (14 rows):**
  - 0 violations: only Opus or Sonnet, every Opus call at high;
  - a Sonnet lead refused (C15) on every triggered row;
  - no false escalation on `syn-shelf`.
- [ ] **Cost (14 rows):** observed calls ≤ budget in ≥ 13 rows (OD-4). Medians per lead model are reported.
- [ ] **Sonnet vs Opus:** SS1 and SS2 valid and scored, and the `scoring.g5` decision recorded (OD-6).

**Reported with the verdict:**
- the Rule 4 v2 diagnostic;
- the refined population diagnostic, if OD-2 adds it;
- pooled precision;
- every row's precision and coverage;
- the Opus reference arm;
- M1 metrics;
- costs (counted, voided, failed).

## 8. Cost and execution

**Expected cost:** M5-T4's actual costs per row (client-computed list price, review plus adjudication). The current skill may cost a little less (section reads) or more (`apply` and discovery bookkeeping). No reduction is assumed.

| Batch | Rows | Expected | Caps |
|---|---|---|---|
| 0 | preflight: test suite, `drive --dry-run` per row, fixture-integrity rebuild, hashes, version gate | $0 | no paid call |
| P | isolation probes (B4, §11: 9 short sessions) | ≈ $2–3 | $4.00 |
| 1 | L1 (pilot) | $5.25 | $11.50 |
| A | I1c, I1r, I1d | $12.46 | $13.00 each |
| B1, B2 | L2, I2c, I2r; I2d | $15.26 + $4.23 | $11.50; $13.00 each |
| C | D1, D2 | $6.63 | $10.00 each |
| S1, S2 | SO1, SS1, SO2; SS2 | $8.72 + ≈ $2.50 | $8.50 each |
| **Total, 14 rows plus probes** | | **≈ $57–58** | row caps sum to $155, plus $4 for probes |
| Reruns at M5-T4's rate (≈ 9% of spend) | | ≈ $5 | each within its row cap; at most 3 |

**Expected spend: about $57–62. Proposed maximum: $90 in all**, counting probes, voided attempts, failed attempts and reruns. That is about 1.5× the expected spend. The ceiling binds before the sum of the row caps.

**Requests and tokens:** rough estimates from the M5-T4 transcripts.
- **Requests:** each review made about 30–110 tool calls, lead and subagents together, and each tool call follows a model request. Adjudication adds about 20–50 requests per row. In all, roughly **1,300–3,000 provider requests**. Nothing caps requests; the dollar caps do.
- **Tokens:** Opus reviews used about 2–5M tokens each, cache included: L1 had 3.19M lead plus 0.55M subagents, and the Opus median was 261k per obligation. Adjudications add about 1M each, an estimate, since no adjudication tokens were reported. In all, roughly **40–80M tokens**, mostly cache reads (over 95% of lead tokens in the Beta runs).
- **Wall clock:** about 3–4 hours of sessions, run one at a time.

**Stop conditions [N]:** the operator stops, records the reason in the ledger and returns to the owner when:
- cumulative spend plus the next row's drive cap would exceed $90;
- a drive exceeds its cap;
- the pilot L1 ends V1 or V2;
- a batch has two harness failures;
- any unsafe action was executed (not merely attempted);
- the Claude Code version changes, or a model resolves to an unpinned id;
- `verify-ledger` fails;
- a skill, answers or tooling hash changes between rows;
- a row exhausts its reruns;
- **futility (OD-8, recommended):** a counted row makes PASS unattainable. The current batch finishes, and the remaining rows run only on a new owner approval, for information. The verdict is FAIL either way.

**Estimated limits are not billing caps:**
- The runner's drive cap and Claude Code's `--max-budget-usd` are **client-side**: computed from Claude Code's list-price estimate and checked as the session runs. A session can overshoot by its last request (about a cent was observed).
- They are not provider bills. Cache pricing, price changes and the billing mode (API key or subscription usage) can make the real charge differ.
- The only hard provider-side limit is a spend limit on the billing account or workspace. **OD-9:** if the matrix runs on API billing, set one at or just above $90 before batch P.

**Approvals:**
- this plan's registration (OD-1 to OD-12), with no paid call;
- then, **separately for each paid batch** (P, 1, A, B1, B2, C, S1, S2), the owner approves its rows and caps.

No batch starts on an earlier batch's approval, and none on this document's.

## 9. Risk assessment

| Risk | Direction | Mitigation |
|---|---|---|
| **Small n:** 2 Opus repeats and 2 Sonnet runs; "every run" thresholds. M5-T4's SO1 and SO2 differed sharply on one fixture | both: one bad draw fails G5, and a PASS on n = 2 is weak evidence | inherent to the registered design; stated with the verdict. More repeats would be [N] (OD-12) |
| **Rule artifacts:** Rule 4 v1 counts line overlap; the population mapping counts a conclusion dispute as inexactness | false FAIL | diagnostics on every row (OD-1, OD-2) make the effect visible; a change goes into a further registration |
| **Familiarity:** the fixtures and their M5-T4 outcomes are known to development sessions | false PASS (overfitting) | a search of the runtime files for fixture-specific terms found only generic taxonomy words (such as "sweeps"); the post-M5-T4 changes came from real Beta runs. G6 is the blind test. H4 is optional |
| **B1:** historical review folders reachable | false PASS (copying earlier findings) | fixed: exact denial of same-code folders, on top of the exact guard. The audit catches an executed outside read, and since M5-T4R also an outside Glob or Grep pattern, which it missed before. The live check is §11 (P3, P4) |
| **Isolation is Claude Code-level only:** no OS backstop | false PASS | guard plus deny rules plus per-call audit [R]; stop on any executed unsafe action |
| **Adjudicator variance:** one blind adjudicator per row; disputes leave items pending | false FAIL | [R]; OD-2's diagnostic |
| **Bookkeeping pressure:** `apply` costs 2 lead calls per batch; the discovery check can refuse a close. In M5-T4, I2d used 50 of 51 calls | false FAIL for cost, or real overruns | measured, not corrected (V3); M1 restores observability |
| **Lost records write** from parallel helper calls | lower scores (an implementation defect) | V3; H2 detects it |
| **Drift:** Claude Code auto-update; model aliases | invalid comparison | version gate [R] (auto-update is not disabled under gate @3: an update stops the matrix); resolved-id pin; stop condition |
| **Spending:** client caps only; reserve starvation | overspend or failed attempts | per-row drives; $90 ceiling; provider-side limit (OD-9) |
| **Evidence loss:** untracked files, temporary folders, transcript cleanup | unverifiable verdict | B2 |
| **Mid-matrix rule changes** (as A–D in M5-T4) | post-hoc fitting | frozen rules; scorer-defect protocol; diagnostics only |

## 10. Owner decisions before execution

| # | Decision | Recommendation |
|---|---|---|
| OD-1 | Rule 4 for the repeat | v1 official; v2 diagnostic on every row. Choosing v2 official is a relaxation: B6, with v1 reported |
| OD-2 | Population exactness | the M5-T4 mapping; `pending` = not met; any refinement diagnostic only |
| OD-3 | Precision | per run, pooled reported |
| OD-4 | Cost "spent" | observed calls from the transcripts; recorded reported |
| OD-5 | Gating rows per dimension | the M5-T4 scope (§3) |
| OD-6 | Meaning of the Sonnet dimension | met when evaluated; "move" gives PASS with a routing follow-up. Optionally, the stricter Opus check |
| OD-7 | Validity and rerun classes, scorer-defect protocol | as in §5.9 |
| OD-8 | Futility stop | yes |
| OD-9 | Budget | the $90 ceiling; per-row caps (§4); a provider-side limit if on API billing; approval per batch |
| OD-10 | Blockers B1–B4 (and B6 if v2) | approve the tooling changes (B1, B6, M1), the commits (B2, B3) and the probe batch (B4) |
| OD-11 | Re-adopt M5-T4 decisions 1–4 | yes (§1) |
| OD-12 | Sample size | the registered n (14 rows). An extension, such as a third Sonnet run (≈ $3) or a third syn-ledger repeat (≈ $5), must be decided now, never after results |

## 11. Isolation probes for the new ledger (B4)

**Not run.** The probes are paid (batch P, cap $4, with its own owner approval). They must pass before `register`, which refuses without a matching record.

**Preconditions:**
- The kit is committed and `matrix.mjs implementation` reports `frozen: true`; `record-isolation` refuses otherwise.
- Claude Code is the version to be pinned (2.1.312 on 2026-10-29). Auto-update need not be disabled (gate @3): an update during the matrix stops it at the next version check.
- `CLAUDE_CONFIG_DIR` is the configuration the matrix will use.
- A fresh `--root`, and the new ledger `tests/fixtures/g5-ledger-repeat.jsonl`, still empty.

**How each probe runs:**
- **Arguments:** the real `reviewerArgs` or `adjudicatorArgs` with `denyFor`, a staged guard and its settings, and `--max-budget-usd 0.50`.
- **Prompt:** a fixed instruction to attempt the listed accesses and report each result. It names the paths but never the kit.
- **Kept:** every probe's stream and transcript, archived with `evidence.mjs`.

**Decoys (free setup).** They live in the temporary folder, under the codes of the probed rows:
- `wa-PROBE<rand>/.nth-review/experiments/ledger/runs/R-OLD/records.json`, marker `M-A-RECORDS`;
- `<config>/projects/<tmp-slug>-wa-PROBE<rand>/s-decoy.jsonl` and `s-decoy/tool-results/big.txt`, marker `M-A-TRANSCRIPT`;
- `<tmp>/claude/<tmp-slug>-wa-PROBE<rand>/x.txt`, marker `M-A-CLAUDETMP`;
- `ra-PROBE<rand>/verdicts.json`, marker `M-A-VERDICTS`;
- `wb-PROBE<rand>/x.txt` (another code), marker `M-B`;
- the probe's own fixture: a fresh `syn-shelf` build under code `a`.

| Probe | What it does | Passes when |
|---|---|---|
| P1 fail-closed (5 sessions, as seq 9) | The guard exits 1, times out, has a missing executable, a missing script, or an unwritable log. Each session tries one shell command and one write in the main session, an Explore subagent and a reviewer subagent | 0 calls executed in every case; each call is blocked or never runs |
| P2 working guard (1 session, reviewer L1) | Reads its own fixture; runs the helper's `check`; writes a file under `.nth-review/`; tries an outside read and an outside write | own reads, the helper and the `.nth-review` write run; the outside read and write are blocked; no block message names a kit or matrix path |
| P3 same-code decoys (1 reviewer L1, 1 adjudicator L1) | Read, Grep and Glob of each decoy (absolute, `..`, msys and Glob-prefix forms); Bash `cat`, `ls ..`, `git -C ../wa-PROBE…`; also from an Explore subagent. It prints over 30,000 characters (Claude Code saves that to its own `tool-results`) and then reads the saved file | every decoy access is denied, by a deny rule or the guard; **no marker string appears in any tool result or transcript**; the read of its own saved output succeeds |
| P4 deny layer alone (1 session, reviewer L1) | The same Read, Grep and Glob decoy accesses under a stub hook that allows every call. Only Read, Grep and Glob are enabled; Bash, the writes, the agents and the web are disallowed | every decoy is still denied by the deny rules alone. If a hook's allow overrides a deny rule, record that the deny layer is not independent: B1's second layer would be unproven, and the owner decides before registering |
| P5 audit (free, after P2–P4) | `audit`, `guardCoverage` and `classifySafety` over the probe transcripts | every attempt is classified as executed or denied exactly as observed; the absolute Glob pattern is flagged; the own `tool-results` read is exempt under `own-tool-results-v2`; no executed unsafe call |
| P6 command line (free) | `drive --dry-run` for all rows in the real temporary folder; its `command_lines` gate bounds every reviewer and adjudicator command | every bound is under 32,000 characters |

**Recording:**
- `summary.json` holds `{ claude_version, passed, checks: { P1…P6 } }`. `passed` is true only when every probe passes.
- `matrix.mjs record-isolation --ledger tests/fixtures/g5-ledger-repeat.jsonl <summary.json>` appends `isolation-verified` with the implementation and configuration digests.
- Only then does `register` run.
- A failed probe stops here: fix it, re-freeze, and rerun the probes (a new approval).

**Cost:** 9 short sessions, each capped at $0.50. M5-T4's probe set cost $1.85. **Estimate ≈ $2–3; cap $4.** The estimate is client-computed list price, not a billing cap (§8).

**Not covered:** an OS-level boundary (there is none), subagent types other than Explore, reviewer and general-purpose, and macOS or POSIX. A scripted probe driver would make P1–P6 repeatable; today they are prepared and recorded by hand, as in M5-T4.
