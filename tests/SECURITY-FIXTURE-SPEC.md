# RQ-1 B7: curated security-boundary fixture, requirements and handoff

**Status: no fixture exists, and none may be written by an nth-review developer; the tooling to run one is implemented (§4).** The fixture for criterion B7 of the release quality gate ([RELEASE-GATE-3.md](RELEASE-GATE-3.md), `nthr-release-gate@3`) has to be authored and sealed by an independent curator. This file says what the curator delivers, and what the owner and the evaluation operator do with it. It deliberately names no case, code or mechanism: whoever writes or reads this file stays blind to the fixture.

**The criterion (frozen text, not restated as a rule here):** the crossing is confirmed with impact `security` in every row; the defense-in-depth gap is never confirmed as a `security` defect (a `risk`, a `rejected` with sound counterevidence, or a lower-impact defect is correct).

## 1. Independence

| Requirement | Why |
|---|---|
| **The curator is not the owner, and has never developed, prompted or reviewed nth-review's skill, references, helper or fixtures.** A person is required. An AI session, even an isolated one, is not an independent curator under this gate: it shares the reviewer's model family, and the owner directs it. Using one needs a new gate version that says so (owner decision) | B7 tests judgment the developers could otherwise tune to |
| The curator may read only the public contract: [fixtures/README.md](fixtures/README.md) sections "Sealed answers" and "Evaluation criteria", records.md's finding and obligation fields, and taxonomy.md's Severity section, which defines a crossing. Nothing else in the kit | they need the vocabulary, not the method |
| No nth-review developer or development session sees the fixture's code, its commit history or its answers before every B7 row is scored | a developer who has seen the case could tune prompts to it |
| The curator never runs nth-review on the fixture | a curator who has seen a review could adjust the case to it |
| The owner keeps the delivered package outside the kit and outside every Git work tree, in a folder restricted to the current user (as `tests/tools/evidence.mjs` does for the M5-T4 archive) | review and adjudicator sessions must then be denied that folder, as they are the kit's answers. Once the package is recorded, the matrix denies it to every session (§4) |

## 2. What the fixture must contain

- **One reviewable Task change:** a base commit and a change commit in one to three Git repositories, reviewed as a committed range (`--change <repo>:<base>..<change>`). No untracked files, so the size is exact.
- **Size and routing:**
  - at most 1,500 changed lines and 40 changed files (size S or M);
  - the change must touch authorization, so the `authorization` trigger applies and the lead is Opus at high effort;
  - Sonnet never leads a B7 row.
- **Self-contained:** readable source and documents only. Nothing needs to be built, run or installed, and there is no network access, no secrets and no file named like one (`.env*`, keys); nth-review never opens those.
- **Owning intent:** at least one document in the fixture states the authorization rules the change must keep (who may act on what), so a review can cite a rule.
- **Item C, at least one:** an authorization crossing introduced or exposed by the change. A principal can act on, read or change another principal's resource beyond its permissions, reachable from an entry point in the source, with a rule the crossing breaks.
- **Item G, at least one:** a defense-in-depth gap with **no** crossing. A secondary check is missing or weak, but a primary control in the source still stops every principal from crossing. The source alone must show the primary control.
- **Recommended, reported only:** a look-alike safe path near each item (a negative control) and decoy wording. B7 gates only C and G.
- **Determinism:** delivered as **Git bundles only**, one per repository (`git bundle create repos/<repo>.bundle --all`, `root.bundle` for the root). A build script would be code the evaluation runs, so it is not accepted. The bundles fix the commit ids. The curator records each repository's head in `answers.json` `heads`, and every bundle must contain the history that head needs, not a thin range.

## 3. Sealed answers

`answers.json` in the `nthr-fixture-answers@1` format ([fixtures/README.md](fixtures/README.md), "Sealed answers"):
- `heads` per repository; `runs[0]` with the change spec, the expected size and `opus-high`;
- for each C item: `expect: "defect"`, `gating: true`, `gate_dimension: "security-boundary"`, anchors (entrypoint, propagation, site, sink, rule) with `contains`, `required_evidence`, `mechanism_facts`, `wrong_mechanism_claims`, and `outcomes.full` = a finding of kind `defect`, verdict `confirmed`, `impact_dimension` `security`;
- for each G item: `expect: "no-defect"`, `gating: true`, `gate_dimension: "security-boundary"`, its anchors with the primary control as a `refutation` anchor, and `outcomes.disqualifying` = a finding of kind `defect`, verdict `confirmed`, `impact_dimension` `security`;
- `scoring.line_tolerance: 3`.

The scorer's outcome predicates compare any records field the predicate names (`predicateHolds` in `tools/score.mjs`). `tests/score.test.mjs` pins an `impact_dimension` predicate, and each scored item carries its `gate_dimension`, which B7 uses to find the C and G items.

**Sealing:**
1. The curator sends the owner the sha256 of the bundle (or build script and tree) and of `answers.json` **before** sending any file.
2. The hashes are recorded in the repeat ledger before the first B7 row.
3. The curator keeps an untouched copy until the gate closes. After it closes, the package may be published for audit.

## 4. Running B7 (gate `nthr-release-gate@3`, implemented 2026-10-29)

The owner fixed the B7 design (decisions D2 and D4), and the tooling is in the release candidate:

| Need | How it is met |
|---|---|
| **Rows** | Two Opus rows at high effort, SB1 and SB2, both gating: [RELEASE-GATE-3.md](RELEASE-GATE-3.md) §3 and §4 |
| **Package layout** | `answers.json`, one `attestation.<ext>`, and `repos/<repo>.bundle` (`root.bundle` for the root) |
| **Recording** | `node tests/tools/matrix.mjs record-curated-package --root <matrix root> --ledger <repeat ledger> --curated <package> --change <repo>:<a>..<b> [--change …]`. It refuses a package inside the kit, a Git work tree or the temporary folder; a missing attestation; heads the bundles do not hold; and any recording after the security rows registered or started. It records digests only, never the path |
| **Registration** | `matrix.mjs register-supplement`, after the main registration, on the same frozen implementation, skill, Claude Code version and configuration |
| **Build** | `buildCuratedFixture` (`fixtures/build.mjs`) verifies each bundle, fetches its recorded head into a fresh repository, checks it out, and installs the skill. Nothing from the package runs, and no remote, FETCH_HEAD, reflog entry or path to the package stays in the fixture |
| **Isolation** | once a package is recorded, every session is denied its folder; the audit flags a tool input naming it; a moved, changed or missing package stops the matrix |
| **Evidence** | the security rows' adjudications and scores go under the matrix root's `curated/`, never into the kit |
| **Evaluation** | `tools/release-gate.mjs` computes B7 from the ledger, the package, and each row's last attempt: its official score and the records its adjudication froze (`judgeB7`). A test-double package, a voided or unscored attempt, or missing evidence is BLOCKED, and a typed `b7` value is ignored |

**Still to be done by the operator, not by the tooling:** check the curated package's anchors against a build (the curator's own check, or the operator's). Keep that output, and never show the anchors to a developer.

**Until a curator delivers a package and both rows are scored, B7 is BLOCKED and RQ-1 cannot pass.** The tests use synthetic packages marked as test doubles; none is, or can stand in for, the curated fixture.

## 5. Handoff checklist

**The owner sends the curator:**
- this file;
- the README sections named in §1;
- records.md "`findings`" and "`obligations`";
- taxonomy.md "Severity".

**The curator returns:**
1. the sha256 of `answers.json` and of each bundle (first, on their own);
2. the package, in the §4 layout: `repos/<repo>.bundle`, `answers.json` and `attestation.<ext>` (a signed statement of §1 independence);
3. a one-page note: the language, the repositories, the `--change` specs, and how C and G differ. It is kept with the package and never sent to developers.

**The owner, then the operator:**
1. Store the package as §1 says, and compare the files' sha256 with the ones the curator sent.
2. Run the anchor check (§4).
3. `record-curated-package` with the note's `--change` specs.
4. `register-supplement`.
5. Run SB1 and SB2 only with the owner's approval of their batch and cost cap, like every paid row. A B7 row is an Opus Task review plus a blind adjudication: M5-T4's comparable L rows cost $5.22–5.26 each, and G5-REPEAT-PLAN §4 caps such a row at $11.50.
