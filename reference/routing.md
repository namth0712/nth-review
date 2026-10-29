# nth-review routing: models and agents

**Development vs runtime.**
- Opus at xhigh effort is only for developing nth-review itself.
- Every review run, in every mode, uses **Opus at high effort** or **Sonnet**, for the lead and every delegate. Never xhigh or max.
- Field rules and `check` enforcement: [records.md](records.md#check-rules). Method: [protocol.md](protocol.md). Prompts: [prompts.md](prompts.md).

## Roles

| Role | Agent | Model | Effort | Budget | When | State |
|---|---|---|---|---|---|---|
| R1 lead | the session that ran `/nth-review` | see Lead model | as configured | the run's budget | always | operational |
| R2 census assist | `Explore` | `sonnet` | none | ≤ 30 tool calls | optional, during Census, for large trees | template ready |
| R3 plan-critique | `Explore` | `sonnet` | none | ≤ 30 tool calls | mandatory, once, after census and outline, before discharge | operational |
| R4 judgment critic | `reviewer` | `opus` | `high` | ≤ 10 tool calls | Full Audit Tier-1 units only, after Verify and before Close | written; disabled with Full Audit (C19) |
| R5 refuter (high) | `reviewer` | `opus` | `high` | 1 finding, ≤ 10 tool calls | critical or high severity, or a security, financial or data-integrity impact | operational |
| R6 refuter (batch) | `reviewer` | `sonnet` | none | ≤ 2 findings, ≤ 10 tool calls each | every other defect | operational |
| R7 noisy read-only check | `verifier` | `sonnet` | none | one named command | not used: review runs execute no project commands | defined only |
| Deterministic work | `nthr.mjs`, run by the lead | no model | — | — | snapshot, pack, footprint, fresh, check, close, resume, decide, status | operational |

`reviewer` in this table and in records is the read-only agent the nth-review plugin bundles: call it as `nth-review:reviewer`. It exists only while the plugin is enabled. An agent the user or the project names `reviewer` is never used.

`check` rejects a delegation whose agent or model differs from this table, or an `opus` delegation whose effort is not `high` (C16).

**Never used:**
- `architect` (it writes implementation handoffs, and never a `.nth-dev-kit/HANDOFF.md` for a review);
- `Plan`;
- `general-purpose`, which has write tools;
- any agent that edits files.

Delegates never write records. A review never routes into a coding workflow: no handoff, fix, test run or commit.

## Lead model

| Situation | `required_lead_model` | Lead |
|---|---|---|
| Task S with no trigger | `sonnet` | Sonnet, or Opus at high effort |
| Task S with any trigger; Task M, L or an unverified size | `opus-high` | Opus at high effort |
| Flow (BETA) | `opus-high` | Opus at high effort: the budget comes from the entries, and a small entry can reach money, authorization or persistence code. |
| Incremental | `opus-high` | Opus at high effort, checked before `new-run`, so a mismatched session never opens a run. The Sonnet case for a quiet Incremental run is not implemented. |
| `audit-plan`, `audit-unit` | `opus-high` | Opus at high effort (official audits are disabled) |

- `new-run` prints `required_lead_model`. When the lead adds a trigger at Plan, it sets the field to `opus-high` itself (C15). The triggers are listed in [protocol.md](protocol.md) §4.
- **The lead records:**
  - `runtime.lead_model`: its model id;
  - `runtime.lead_effort`: the effort the user configured. The model cannot read it, so ask once, before `new-run` opens the run ([SKILL.md](../SKILL.md) §1); `unknown` is allowed, and `xhigh` or `max` means stop.
- **On a mismatch at Open,** stop before Plan and tell the user which model and effort to start a new session with.

## Escalation

A Sonnet lead that meets a trigger mid-run:
1. records the trigger, sets `required_lead_model` to `opus-high`, and writes `records.json`. `check` then reports the lead-model mismatch, which is expected.
2. stops, and tells the user that the review needs Opus at high effort.

**Continuing it.** The run stays open, and no other run can open in the namespace. Nothing switches models automatically, and the skill never changes its own model:
1. The user starts a new session on Opus at high effort and runs the skill again.
2. `new-run` refuses ("still open"), and `resume --ns <ns>` answers `continue` when the snapshot holds.
3. The new lead records itself and picks the run up ([protocol.md](protocol.md) §11).

A Sonnet lead cannot close the run as `incomplete` with reason `escalation`, because `check` still refuses the lead model.

## Delegation rules

- **Always pass `model`.** `nth-review:reviewer` defaults to Sonnet, and `Explore` has no stated default. Pass `effort: high` with `opus`, and nothing with `sonnet`.
- **Evidence first.** Build the delegate's pack with `pack --run <dir> --for <id>` before the call. A delegate starts from it and never sees another delegate's conclusion.
- **Parallelism.** Only independent refutations run in parallel. R3 runs alone, before discharge.
- **Budgets.** Delegate calls count against `budget.subagent_calls`, a hard cap (B4). The tool-call budget in each prompt is the delegate's own.
- **Recovery** (C17): one recovery message at most; the wording and the completion rule are in [prompts.md](prompts.md).
- **Accounting:** each call is one `delegations[]` entry (fields in [records.md](records.md)).
  - Usage comes from the task notification. Record null, never 0, when it has not arrived.
  - The harness counts the delegate's final hand-back as one tool use.
- **Agreement is not evidence.** A delegate's answer counts only through the source anchors it cites. The confirmation rule is in [protocol.md](protocol.md) §7.

## Cost per role (unmeasured estimates)

| Role | Tokens |
|---|---|
| R2, R3 (Sonnet `Explore`) | 30–60k each |
| R6 (Sonnet, per call) | 25–45k |
| R5 (Opus High, per call) | 40–80k |
| R1 lead | Task S 80–150k; audit unit 150–300k |

VS1 measured 35k (R3), 23k (R5) and 26k (R6). Calibration belongs to M5.

## When a new agent becomes necessary

`nth-review:reviewer` is the only agent nth-review ships: the `reviewer` agent nth-review was developed with, with the same model, tools, 12-turn limit and instructions. Another read-only checker agent is added only if validation shows either:
- ≥ 20% of `reviewer` delegations stop without an answer despite budgets and packs; or
- R5 refutations of `high` findings need more than 12 turns in more than 10% of cases.

Changing the bundled agent, its turn limit included, makes a new release candidate.
