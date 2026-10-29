# nth-review release quality gate RQ-1, version 2 (`nthr-release-gate@2`)

**Status: FROZEN (2026-10-29), not registered, Part B not evaluated.** This version supersedes [RELEASE-GATE.md](RELEASE-GATE.md) (`nthr-release-gate@1`). @1 stays in the kit, unchanged and frozen (sha256 `cd9e067c…95ae`), as history. Its Part A evaluations (2026-10-28 and 2026-10-29) are recorded in [../VALIDATION.md](../VALIDATION.md). No Part B row has run under either version.

- **Why a new version:** after @1's Part A was evaluated, the owner decided D1–D5 (2026-10-29). They add rows and change B7, B11 and B12, and @1's freeze rule says such a change is a new version. Every change below is a tightening, or a specification @1 left open; none relaxes a threshold.
- **What it gates:** the v1.0 Stable label of Task and Incremental Review (release contract `../RELEASE.md`). Flow Review stays Beta; Full Audit stays disabled.
- **What it never does:** change the historical G5 verdict (G5 = FAIL, ledger `tests/fixtures/g5-ledger.jsonl`, seq 97). No M5-T4 row counts toward RQ-1.
- **Freeze rule:** this file's sha256 is pinned in `tools/gate-version.mjs`, and a test fails if the file changes. A change after freezing is a new version (`@3`), never an edit. After the first counted Part B row, nothing in this gate or its tooling changes until the gate closes.
- **Paid runs:** every row needs the owner's approval of its batch and cost cap. Until then every Part B criterion is **BLOCKED**, and the gate cannot pass.

## 1. Structure and verdict

As @1 §1: Part A (offline release checks) and Part B (review-judgment quality) must both pass.
- **Verdicts:** PASS, FAIL, BLOCKED or UNVERIFIED. BLOCKED means the criterion cannot be evaluated without something the candidate cannot supply itself: a paid run, an independent curator, the owner's decisions or another platform. It never counts as passed.
- **The gate** is PASS only when every criterion is PASS. Anything else is **NOT YET STABLE**, naming each criterion that did not pass.

## 2. Part A: offline release checks

A1–A11 exactly as @1 §2, evaluated by `node tests/tools/release-gate.mjs offline`:
- A4–A7 and A11 are checked directly; A5 builds every kit fixture twice;
- A1–A3 and A8–A10 are read from the saved test and rehearsal output.

The new tooling's tests (curated packages, supplement, pins, evaluator) are part of A1 and A2.

## 3. Part B: review-judgment quality

Computed from the frozen blind adjudications, the records and the scorer at the registered implementation. Nothing is pooled unless a row says so.

**The matrix:**
- **14 core rows:** L1, L2, I1c, I1r, I1d, I2c, I2r, I2d, D1, D2, SO1, SS1, SO2, SS2, as G5-REPEAT-PLAN §4;
- **2 security rows:** SB1 and SB2, both Opus at high effort, Task reviews of the independently curated security fixture (§4).

B1–B6 and B8–B10 apply to the core rows exactly as in @1, whose thresholds are restated below unchanged. The security rows are gated by B7 only.

| Id | Dimension | Gating rows | Threshold |
|---|---|---|---|
| B1 | Precision / false positives | L1, L2, SO1, SO2 | **unchanged from @1:** negative controls (N1, N2, EN1, EN2) never confirmed under Rule 4 v1; ≤ 1 other false confirmed **distinct finding** per row (a Rule 4 hit on a non-control item, P3 or P4, is such a finding); precision ≥ 0.80 per row |
| B2 | Recall | L1, L2, SO1, SO2 | **unchanged:** P1 and P2 (E1 and E2) at full credit, and ≥ 3 of P1, P2, P5, P6 (E1–E4) at full credit, per row |
| B3 | Severity and evidence quality | L1, L2, SO1, SO2 | **unchanged:** among confirmed findings, 0 unsupported confirmations, 0 mislocated and 0 wrong-mechanism findings; no confirmed finding judged `valid` carries an incorrect claim; adjudicated severity 0 `understated` and ≤ 1 `overstated` per row |
| B4 | Source freshness | I1c, I1r, I1d, I2c, I2r, I2d | **unchanged:** rule 9 as corrected, in every row |
| B5 | Coverage truthfulness | L1, L2 | **unchanged:** adjudicated census recall over every sealed mechanism (classified or `unknown`) per row; every population exact (`pending` is not); 0 overclaims (a `held` / `all-enumerated` obligation that the adjudicator disagrees with, or for which it lists missing members) |
| B6 | Independent refutation quality | the 14 core rows | **unchanged:** 0 incorrect rejections; no rejected finding whose counterevidence is judged unsound; delegations ≥ 90% complete without recovery and 100% within ≤ 1; 0 routing violations |
| B7 | **Security boundary handling** | SB1, SB2 | **§4.** In each security row: every C item (`gate_dimension: security-boundary`, `expect: defect`) at full credit, and its finding confirmed as a `defect` with `impact_dimension: security`; no G item (`gate_dimension: security-boundary`, `expect: no-defect`) disqualified or a false positive; the row's records pass `check`; 0 routing violations; its official score's sha256 equals the ledger's. **BLOCKED** until a non-test-double curated package, recorded and registered as §4 says, and both security rows are scored |
| B8 | Repeatability | (L1, L2), (SO1, SO2), (I1x, I2x) per variant | **unchanged:** B1–B5 hold in each member, and the two members agree on every must-find item |
| B9 | Debt and completion | D1, D2; the 14 core rows | **unchanged:** the debt chain as G5, and `check` green on every core row (each row's records checked by the registered helper) |
| B10 | Cost discipline | the 14 core rows | **unchanged:** observed lead and subagent calls within budget in ≥ 13 of 14 rows; the lead's recorded counts reported beside them |
| B11 | **Sonnet lead** | SS1, SS2 | **Tightened (D1):** each Sonnet row meets every B1, B2 and B3 threshold on syn-shelf's items; **and** B5's coverage thresholds on syn-shelf (adjudicated census recall over every sealed syn-shelf mechanism, every population exact, 0 overclaims); **and** syn-shelf's `scoring.g5`. If either row fails, the Sonnet lead allowance is removed after the last row (RELEASE.md §8.4), and B11 counts as met once that routing change passes A1–A2 |
| B12 | **Real-project triage** | the owner's real runs (§5) | **Specified (D3):** at least **3 independent** real-project Task or Incremental runs, closed. Unit: **each confirmed finding of each counted run**, judged by the latest owner decision (`nthr decide`) for its fingerprint in that run's namespace. Every counted finding decided; owner-judged `false-positive` ≤ **20%** of the counted findings, pooled. Contaminated runs are reported and not counted. **BLOCKED** while fewer than 3 independent runs are listed, any input is missing or invalid, any counted finding is undecided, or the counted runs hold no confirmed finding |

## 4. Execution

**Core rows (14):** G5-REPEAT-PLAN §4–§11, with its open decisions fixed as @1 §4 fixed them. Its fixed values:
- Rule 4 v1 official;
- the population mapping unchanged;
- precision per row;
- cost from observed counts;
- G5-REPEAT-PLAN §5.9 validity classes;
- a futility stop;
- a $90 ceiling for the core matrix, with per-row drive caps;
- M5-T4 decisions 1–4 re-adopted;
- no extension of the sample after registration.

**Security rows (2), the curated package:**
- **Authorship:** an independent curator, as [SECURITY-FIXTURE-SPEC.md](SECURITY-FIXTURE-SPEC.md) requires. No nth-review developer writes it, reads it before scoring, or certifies it.
- **Contents:** `answers.json` (`nthr-fixture-answers@1`), one `attestation.<ext>` (the curator's independence statement) and `repos/<repo>.bundle` Git bundles (`root.bundle` for the root). Nothing in it is ever run: each bundle is verified, its recorded head fetched and checked out.
- **Location:** outside the kit, every Git work tree and the temporary folder. The ledger records only the digest of its location.
- **Recording:** `matrix.mjs record-curated-package --curated <dir> --change <repo>:<a>..<b>…` records the package, answers and attestation sha256, the heads and the change specs, before any security row. It is refused once a security row has registered or started.
- **The curator's hashes:** the curator sends the package and answers sha256 to the owner before the files. The owner compares them with the recorded event, because the tool cannot verify a signature.
- **Registration:** `matrix.mjs register-supplement` registers SB1 and SB2 after the main registration, on the same frozen implementation, skill, Claude Code version and configuration, naming the recorded package. Security rows are drivable only after it.
- **Isolation:** once a package is recorded, every session (core and security) is denied its folder, and the audit flags any tool input that names it. A change to the package, or its absence, stops the matrix.
- **Evidence:** the security rows' frozen adjudications and scores go under the matrix root (`curated/`), never into the kit, until the gate closes.
- **Cost:** a security row is an Opus Task review plus a blind adjudication. M5-T4's comparable rows cost $5.22–5.26, and G5-REPEAT-PLAN caps such a row at $11.50. The two rows need their own owner-approved cap, outside the core $90 ceiling.

**Environment (D5), checked by the tooling:**
- `register` refuses unless the matrix configuration's `settings.json` sets `env.DISABLE_AUTOUPDATER` to `"1"` (the runner also sets it on every session it starts).
- The registration records the versions: Claude Code, Node.js, Git, OS and the model pins `claude-opus-5-5` (Opus) and `claude-sonnet-5-5` (Sonnet). Before every row, audit and score, the installed Claude Code must equal the registered version.
- Each row's audit checks every transcript record's Claude Code version, the lead's resolved model (its row's pin) and every delegate's (within the pins). A mismatch invalidates the row and stops the matrix.
- The adjudicator must resolve to the Opus pin.
- Isolation probes (G5-REPEAT-PLAN §11) must pass on the frozen implementation, at the installed version, before `register`.
- **Owner precondition, not enforceable by the tooling:** other Claude Code configurations or installers on the machine must not update the shared binary during the matrix. If one does, the version gate stops the matrix.

## 5. B12 input: the owner's real-run manifest

A JSON file kept outside the kit (it names private projects), `nthr-b12-runs@1`:

```
{ "schema": "nthr-b12-runs@1",
  "runs": [ { "project_root": "<absolute path>", "ns": "reviews/<topic>", "run_id": "<run id>",
              "independence": "independent" | "contaminated", "reason": "<why; required when contaminated>" } ] }
```

- **Independence:** declared by the owner. A run is contaminated when its lead or delegates saw another listed run's records, reports or packs before concluding.
- **Eligibility:** Task or Incremental mode, closed (`complete` or `incomplete`). Flow and open runs are listed in the result and never counted.
- **The evaluator** reads each run's `records.json` and its namespace's `decisions.json` read-only, and reports listed, eligible (completed), independent and counted runs, the counted findings, the decided ones and the false positives.

## 6. Evaluation tool

`node tests/tools/release-gate.mjs` evaluates this version and says so in every result (`gate`, and whether this file's sha256 matches the pin).
- **`offline`:** Part A, as in §2.
- **`evaluate --rows <manifest.json>`:** Part B. The manifest lists:
  - each row's score, blind adjudication, records and metrics files (B9 runs the helper's `check` on each records file);
  - `ledger` (the repeat ledger);
  - `curated` and `curated_evidence` (the package folder and the matrix root's `curated/`), for B7;
  - `b12_runs` (§5).

  A manual `b7` or `b12` value in the manifest is ignored.
- Missing evidence is BLOCKED, never met. Its rules are unit-tested on synthetic inputs (`tests/release-gate.test.mjs`); synthetic packages there are marked test doubles and can never satisfy B7.
