# nth-review release quality gate RQ-1 (`nthr-release-gate@1`)

**Status: DEFINED, not registered, not evaluated.** This document fixes, before any evaluation, the acceptance criteria a release candidate of nth-review must meet to be called **v1.0 Stable**. It is versioned: any change to a criterion, threshold, row or rule after it is first evaluated is a new version (`nthr-release-gate@2`), never an edit of this one.

- **What it gates:** the v1.0 Stable label of Task Review and Incremental Review (the release contract, `../RELEASE.md`). Flow Review has no sealed fixture, so RQ-1 cannot qualify it; Flow Review stays Beta in v1.0 (§6). Full Audit is out of scope and stays disabled.
- **What it never does:** change the historical G5 verdict. M5-T4 closed **G5 = FAIL** (ledger `tests/fixtures/g5-ledger.jsonl`, seq 97, sha256 `7aa36b1666e031808199087d1456526384d47de459c98b862b4edb1bde8f1f18`). No M5-T4 row counts toward RQ-1: those rows ran an earlier implementation. They may be re-analysed with RQ-1's tools only as labelled diagnostics, never as RQ-1 evidence.
- **Freeze rule:** the thresholds below were written before any RQ-1 evaluation. They may be tightened at registration by the owner, never relaxed. After the first counted row, nothing in §2–§5 changes until the gate closes.
- **Paid runs:** the model-judgment part (§3) needs paid sessions. None runs without the owner's explicit approval of each batch and its cost cap (G5-REPEAT-PLAN §8). Until then, every §3 criterion is **BLOCKED**, and the gate cannot pass.

## 1. Structure and verdict

RQ-1 has two parts. **Both** must pass.

| Part | Evaluated by | Cost |
|---|---|---|
| **A. Offline release checks** (§2): software correctness, determinism, evidence integrity, platform | `node tests/tools/release-gate.mjs offline` plus the commands named per check | no model call |
| **B. Review-judgment quality** (§3): precision, recall, severity and evidence, freshness, coverage truthfulness, refutation, security boundary, repeatability | a new pre-registered matrix (G5-REPEAT-PLAN §4–§11, as fixed in §4 below), scored blind, evaluated by `release-gate.mjs evaluate` | paid; owner approval per batch |

**Verdict values**, per criterion and for the gate:
- **PASS:** evaluated, and the evidence meets the threshold.
- **FAIL:** evaluated, and it does not.
- **BLOCKED:** cannot be evaluated without something the release candidate cannot supply itself (a paid run, an independent curator, an unavailable operating system). A BLOCKED criterion is never treated as passed.
- **UNVERIFIED:** could be evaluated, but was not.

The gate is PASS only when every criterion is PASS. Anything else is "NOT YET STABLE", with each non-passing criterion named.

## 2. Part A: offline release checks

| Id | Check | Threshold |
|---|---|---|
| A1 | Full test suite on Windows, from Git Bash and from PowerShell | 0 failures; every skip names a platform reason |
| A2 | Full test suite on Linux, Node.js 20 and the current LTS (22) | 0 failures; every skip names a platform reason |
| A3 | Lifecycle rehearsal `tests/m4/rehearse.mjs` (Windows) | 0 fail; unverified rows only for symbolic links, Unicode normalization and macOS |
| A4 | Sealed G5 evidence | `verify-ledger` ok at 97 events; ledger sha256 as in the header; every file under `tests/fixtures/` that the M5-T4 manifest names byte-identical |
| A5 | Fixture determinism | each of the 4 fixtures builds to its sealed heads and tree digest twice in a row |
| A6 | Runtime inventory | the files `review.md` lists, `RUNTIME_ENTRIES` and the skill directory's runtime files are the same set; every runtime file is LF-only |
| A7 | Safety switches | `OFFICIAL_AUDITS_ENABLED` is `false`; `new-run --mode audit-plan` exits 2; `SKILL.md` keeps `disable-model-invocation: true` |
| A8 | Source freshness (deterministic) | the freshness, footprint, close and resume tests pass on both platforms (part of A1, A2), including: a cited file changed, deleted, renamed or made untracked between evidence and close is refused or reassessed, never accepted |
| A9 | Coverage truthfulness (deterministic) | part of A1, A2: `check` refuses `all-enumerated` while a coverage blocker bears on an obligation; `report.md` marks an obligation "Verified" only when all-enumerated, discovery complete, the close recheck proven, its evidence verified and no blocker bears on it |
| A10 | Security boundary (deterministic) | part of A1, A2: a security-relevant finding's pack carries the Boundary test; `check` refuses a security finding confirmed by a Sonnet refuter, a `risk` with a severity, `needs_validation` with a severity or without a plan, and a rejection without counterevidence |
| A11 | Benchmark tooling fails closed off its verified platform | `matrix.mjs` refuses to start a paid session on an operating system where its isolation has not been verified live |

A1–A11 are software checks. **Passing them says nothing about whether the model finds real defects.** That is Part B.

## 3. Part B: review-judgment quality

Every criterion is computed from the frozen blind adjudication (`nthr-adjudication-blind@1`), the records and the deterministic scorer `tests/tools/score.mjs` at the registered implementation. **Every criterion must hold in every gating row; nothing is pooled except where a row says "pooled".** "Gating rows" are named per criterion.

| Id | Dimension | Gating rows | Threshold |
|---|---|---|---|
| B1 | **Precision / false positives** | L1, L2, SO1, SO2 | negative controls (N1, N2; EN1, EN2) never `confirmed`, under Rule 4 **v1** (any confirmed defect on a control's anchors); ≤ 1 other false confirmed finding per row; precision ≥ 0.80 **per row**. Pooled precision and the Rule 4 v2 diagnostic are reported, never gating |
| B2 | **Recall / known-defect detection** | L1, L2; SO1, SO2 | syn-ledger: P1 and P2 at full credit in every row, and ≥ 3 of P1, P2, P5, P6 at full credit per row. syn-shelf: E1 and E2 at full credit, and ≥ 3 of E1–E4 at full credit, per row. The adjudicator's `unraised` defects are reported per row |
| B3 | **Severity and evidence quality** | L1, L2, SO1, SO2 | among confirmed findings: `unsupported_confirmations` = 0, `mislocated` = 0, `wrong_mechanism` = 0; no confirmed finding the adjudicator judged `valid` carries an `incorrect_claims` entry; adjudicated severity: **0 `understated`** and **≤ 1 `overstated`** per row |
| B4 | **Source freshness** | I1c, I1r, I1d, I2c, I2r, I2d | every row meets rule 9 as corrected (target reopened with a correct reason, never left `current`, C11 complete); overreach is reported |
| B5 | **Coverage truthfulness** | L1, L2 | adjudicated census recall 8/8 (classified or `unknown`) per row; populations `routes` and `ledger_writers` **exact** per row (`pending` = not met); **0 overclaims**: no obligation `held` with `all-enumerated` coverage that the adjudicator judges `disagree` or for which it lists `missing_members` |
| B6 | **Independent refutation quality** | all 14 rows | `incorrect_rejections` = 0 (no planted defect rejected by a refuter); every `rejected` finding's counterevidence is judged `counterevidence_sound: true` (`false` fails, `null` is reported); delegations ≥ 90% complete without recovery and 100% within ≤ 1; routing: 0 violations (only Opus or Sonnet; every Opus call at high; R5 for every critical, high, security, financial or data-integrity finding) |
| B7 | **Security boundary handling** | a sealed security-boundary fixture: at least one authorization-crossing defect and at least one defense-in-depth gap with no crossing, authored and sealed by a curator who does not develop nth-review | the crossing is confirmed with impact `security` in every row; the defense-in-depth gap is never confirmed as a `security` defect (a `risk`, a `rejected` with sound counterevidence, or a lower-impact defect is correct). **No such fixture exists today: BLOCKED** |
| B8 | **Repeatability and variance** | the repeated pairs (L1, L2), (SO1, SO2), (I1x, I2x) per variant | B1–B5 hold in **each** member of a pair (already required above), and the two members agree on every must-find item (both full credit). Reported: per-pair differences in precision, census recall, findings, lead calls and cost |
| B9 | **Debt and completion** | D1, D2; all 14 rows | as G5: D1 `incomplete` with complete debt-out; D2 dispositions 100% of debt-in, kinds resolved, no runtime or owner-fact debt discharged without new evidence; `check` green on every row |
| B10 | **Cost discipline** | all 14 rows | **observed** lead calls after the executed `new-run` and observed subagent calls (from the transcripts) within budget in ≥ 13 of 14 rows; the lead's recorded `budget.spent` is reported beside them with any mismatch |
| B11 | **Sonnet lead** | SS1, SS2 | both rows valid and scored; each meets every B1–B3 threshold under `scoring.g5`. If either fails, the Sonnet lead allowance is **removed** before release (all leads Opus at high effort) and B11 counts as met only once that routing change is made and A1–A2 pass on it |
| B12 | **Real-project triage** | ≥ 3 real-project runs (Task or Incremental) by the owner, in projects the fixtures do not resemble | every confirmed finding has an owner decision recorded with `nthr decide`; owner-judged `false-positive` decisions ≤ 20% of confirmed findings, pooled. Reported: findings per run, `accept` share, and owner notes. Not a recall measure |

**What Part B still cannot show,** and the release contract states as limits: recall on real projects (no ground truth), behaviour on languages or architectures the fixtures do not cover, and any statistical claim (n = 2 per arm).

## 4. Execution (fixed now; registration needs the owner)

RQ-1's Part B uses the matrix of `G5-REPEAT-PLAN.md` §4 (14 rows, 4 chains, the same sealed answers), its validity classes (§5.9), its registration and freeze (§5), its isolation probes (§11) and its cost plan and stop rules (§8), with every open decision fixed to the plan's recommendation, taking the stricter reading wherever one is offered:

| Decision | Fixed for RQ-1 |
|---|---|
| OD-1 Rule 4 | v1 official; v2 diagnostic on every row |
| OD-2 Population | unchanged mapping; `pending` = not met |
| OD-3 Precision | per row |
| OD-4 Cost | observed counts gate; recorded reported |
| OD-5 Gating rows | as named in §3 (adds SO1 and SO2 to B1–B3, the plan's optional stricter rule) |
| OD-6 Sonnet | §3 B11 |
| OD-7 Validity | G5-REPEAT-PLAN §5.9 |
| OD-8 Futility stop | yes |
| OD-9 Spend | $90 ceiling in all; per-row drive caps per §4 of the plan; a provider-side limit if on API billing |
| OD-11 M5-T4 decisions 1–4 | re-adopted |
| OD-12 Sample | 14 rows; no extension after registration |

**Additional pre-registration requirements:** a new ledger (`tests/fixtures/g5-ledger-repeat.jsonl`), a clean commit containing this document (it is a material file of the implementation manifest), and a passing isolation record on that commit. B7 and B12 have no matrix rows: B7 needs a curator and a new fixture; B12 needs the owner's real runs and decisions.

## 5. Evaluation tool

`node tests/tools/release-gate.mjs offline` runs or checks A4–A7 and A11 directly and reports A1–A3 and A8–A10 from the results files it is given (or as UNVERIFIED without them). `node tests/tools/release-gate.mjs evaluate --scores <dir>` computes B1–B6, B8–B10 from frozen score, adjudication and metrics files; missing rows are BLOCKED. It writes nothing in the kit and prints one JSON object. Its rules are unit-tested on synthetic inputs (`tests/release-gate.test.mjs`).

## 6. Scope decisions this gate implies

- **Flow Review stays Beta in v1.0:** there is no sealed flow fixture, so no Part B criterion covers it. Qualifying it needs a sealed flow fixture (curated as B7) and its own rows in a later gate version.
- **Full Audit stays disabled:** it needs G6 (blind, curated) and an owner charter (delivery roadmap §5).
- **macOS:** no macOS machine is available. A2 covers POSIX on Linux only; macOS is a documented, unsupported-by-verification platform in v1.0.
