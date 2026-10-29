# Third-party notices

This file covers material in nth-review (the directory that holds this file) that is adapted from another project. It is required by that project's license.

nth-review is not affiliated with, sponsored by or endorsed by Cloudflare, Inc. Cloudflare is named here only to attribute the adapted material.

**Scope.** The sections listed in "Adapted wording" derive from MIT-licensed upstream text. The upstream copyright and permission notice is reproduced below because the MIT license requires it to accompany copies or substantial portions of that text. This file grants no license of its own: not to nth-review's own contributions (including its changes to the adapted text), not to the rest of nth-review, and not to nth-dev-kit.

## cloudflare/security-audit-skill

| | |
|---|---|
| Repository | https://github.com/cloudflare/security-audit-skill |
| Commit | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14, "Clarify guidance and full audit modes") |
| License | MIT: the repository's `LICENSE`, blob `6dbc9ecb3a5b9080e95b962869e8c7ab16cfdc20`, SHA-256 `e598e694aa506650c7192d5ea3be0e50aca0d356ea00551c53429f0b01eb6391` |
| Files read | `skills/security-audit/VALIDATION-AND-REPORTING.md` (blob `5e200d7387e665e53e0e4190fa4a5814c334c507`), `skills/security-audit/HUNTING.md` (blob `377d4dcfbe88a049379448cd7892717185401597`), `skills/security-audit/SKILL.md` (blob `92178dad304d3f63e37582a297026a7874e12c62`), `skills/security-audit/RECONNAISSANCE.md` (blob `1a170a93ab76b93dc5ac268a5b690beb423a8aa9`); for the methodology below also `skills/security-audit/AI-AND-LLM.md` (blob `02ba9039eca4cec811fefc77bce0d7349b379aae`), `skills/security-audit/RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` (blob `6cbbd1e2cfa482068c8279c2f7da9db43d3f54b8`), `skills/security-audit/DATA-ISOLATION-AND-LIFECYCLE.md` (blob `0cba1fa463b62c9b0caba710a201e29c1eecd0ec`) |
| Word comparison | All 16 Markdown files at the commit (`README.md` and the 15 in `skills/security-audit/`), against nth-review's `SKILL.md` and `reference/*.md`: every run of five or more words they share is in a section listed below. |
| Verified | 2026-10-26. The commit, its file tree and these files were fetched from GitHub; every file's Git blob hash matched the commit tree. Rechecked 2026-10-28: upstream `main` is still this commit (no later commit, no tag); the blobs and the `LICENSE` SHA-256 match; the five-word comparison was rerun over the changed Markdown and the boundary-test text in `scripts/lib/pack.mjs`, with no shared run. |

Upstream changes are not synced. A refresh is a deliberate, reviewed edit of the adapted sections and of this file.

### Adapted wording

These sections adapt upstream text, and each is marked in place with a pointer to this file. Everything else in each section (routing, budgets, the JSON answer, and how answers map to records) is nth-review's own.

| nth-review section | Upstream source, at the commit above | What was adapted |
|---|---|---|
| `reference/prompts.md`, R5/R6 refuter | `VALIDATION-AND-REPORTING.md`, "Candidate-verifier prompt" | The role sentence ("You did not write this; try to refute it."). Following the trace from entrypoint to sink. Seeking the strongest controls on the path first. Correcting root cause, trace, impact and severity to what the evidence shows. The `confirmed`, `rejected` and `needs_validation` outcomes, with `needs_validation` for a decisive fact outside the source. |
| `reference/prompts.md`, R3 plan-critique | `HUNTING.md`, "Coverage-critic waves" | The critic's checks for unmapped entry points, unchecked parallel paths and unjustified exclusions. The role sentence follows the verifier prompt's pattern. |
| `reference/prompts.md`, R4 judgment critic | `HUNTING.md`, "Coverage-critic waves" | The check for units closed without supporting paths or checks, recast as obligations closed on evidence that does not establish their acceptance. The role sentence is shared with R3. Its other questions are nth-review's own. |
| `reference/taxonomy.md`, Severity | `SKILL.md`, "Separate priority from certainty" | The severity anchors (critical to informational), generalized beyond security to data integrity, money, privacy, availability, correctness and maintainability. Severity only for confirmed results, never above the demonstrated impact, and none for `needs_validation`. |
| `reference/taxonomy.md`, Specialized modules | `RECONNAISSANCE.md`, "Architecture summary and companion selection" | Selecting a module because the census found the boundary it describes, not because a dependency name appears. |
| `SKILL.md`, 3. Task Review | `VALIDATION-AND-REPORTING.md`, "Phase 5: Verify the final records with fresh eyes" | The second refuter: an answer that changes the root cause, trace, impact or severity goes to a new, independent verifier. |
| `reference/protocol.md`, 7. Findings | `VALIDATION-AND-REPORTING.md`, "Phase 5: Verify the final records with fresh eyes" | The same second-refuter rule. |

One shorter overlap is not marked. The phrase "account linking and identity collision" (`reference/taxonomy.md`, AUTHN.6) is also a heading in `WEB-PROTOCOL-AND-AUTH.md` ("MFA, passkey, and account-transition attack classes"). It is a five-word technical term, not adapted text.

### Methodology restated in nth-review's own words

These upstream ideas shaped nth-review, restated independently; no upstream wording is reproduced. They are listed for transparency:
- **Candidate gate** (`HUNTING.md`, "Candidate gate"; `SKILL.md`): a decisive fact outside the source makes a claim `needs_validation`, never confirmed; a result is never strengthened; one fingerprint per root cause. Used in `SKILL.md` §3 and `reference/protocol.md` §7.
- **The verdict model:** `candidate`, then `confirmed`, `rejected` or `needs_validation`.
- **Independent verification:** a verifier never sees another verifier's conclusion (`VALIDATION-AND-REPORTING.md`). Used in `reference/prompts.md` and `reference/routing.md`.
- **Budget reservation:** reserving critique and verification before discovery, about 30% (`SKILL.md`, budget gate). This is B2 in `reference/protocol.md` §3.
- **The coverage critic as a separate fresh-context role**, and making no complete-coverage claim from a silent cap or an absent result (`HUNTING.md`). Used in `reference/census.md` and `reference/protocol.md` §5.
- **Prior-run continuity:** earlier unresolved work becomes current work (`SKILL.md`, `RECONNAISSANCE.md`). nth-review applies it as mandatory debt-in.
- **Ledger states for audit units:** planned, deferred, out of scope (`HUNTING.md`, `RECONNAISSANCE.md`).
- **Reports state plainly** when a pass is partial or incomplete (`VALIDATION-AND-REPORTING.md`).
- **Boundary and result for security claims** (`SKILL.md`, "Require a boundary and result", and its anti-patterns; the validation rules of `AI-AND-LLM.md`, `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` and `DATA-ISOLATION-AND-LIFECYCLE.md`): a security, privacy or spend claim needs an actor, a failing control and something crossed beyond the actor's own permissions; a model instruction is no control; a missing limit alone crosses nothing. Used in `reference/taxonomy.md` (Severity), the R5/R6 Kind rule in `reference/prompts.md`, and the boundary test the helper adds to relevant finding packs (`scripts/lib/pack.mjs`).

### Written for nth-review

The following were designed and written for nth-review. Some apply the ideas listed above, such as the budget reserve in B2 and the audit unit states. The word comparison above found no upstream wording in them beyond the sections listed. They include:
- the helper and its rules (`scripts/`);
- the records schema (`records@1`);
- obligations and acceptance criteria;
- the census and its search kinds;
- snapshots, footprints, freshness and the effective baseline;
- review debt and owner decisions;
- the charter, the Full Audit ledger checks and the linear audit chain;
- model routing (agents, models, effort), budget sizes and stop rules;
- the R2 census-assist template;
- the taxonomy's families, checks and module checks (other than the two sections listed above);
- the tests.

## MIT License (cloudflare/security-audit-skill)

Reproduced verbatim from the upstream `LICENSE` at the commit above:

```text
MIT License

Copyright (c) 2025-2026 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
