# VS1 runbook

VS1 is the smallest end-to-end demo of nth-review: one Task Review of a two-repository change, closed with a report (delivery roadmap §3).

These files are library-only test tooling. Enable never copies them, and nothing is installed globally. Run the review itself in an **isolated session on Opus at high effort**, never in a development session and never at xhigh or max (owner decision, 2026-10-26).

## 1. Build the fixture

From the nth-dev-kit root:

    node agents/claude/integrations/review/tests/vs1/fixture.mjs [<new or empty directory>]

The fixture is built outside every repository (a temporary directory by default). It contains:
- `api/`: a repository whose last commit adds two resource routes;
- `web/`: a repository whose last commit adds the client pages that call them;
- `.claude/skills/nth-review/`: a project-level copy of the skill's runtime files (`SKILL.md`, `reference/`, `scripts/`). It loads only in sessions started in the fixture.

The fixture holds no hint of the expected answer. That stays in `fixture.mjs` and `verify.mjs`.

## 2. Run the review in an isolated session

1. Open a new terminal and `cd` into the printed fixture directory.
2. Start Claude Code on Opus with effort **high**, for example `claude --model opus`. Choose high effort in `/model`; never xhigh or max.
3. Type the command the builder printed:

       /nth-review task --ns experiments/vs1 --slug vs1 --change api:HEAD~1..HEAD --change web:HEAD~1..HEAD

4. Answer the skill's questions (for example, the effort, if it asks). Let it run to `close`.

For a headless run from Git Bash, set `MSYS_NO_PATHCONV=1` first. Otherwise Git Bash rewrites `/nth-review` into a Windows path (M0 finding).

## 3. Verify

    node agents/claude/integrations/review/tests/vs1/verify.mjs <fixture directory>

It prints each criterion and exits 0 only when all pass:

| Criterion | Meaning |
|---|---|
| `closed-run` | A closed run in `experiments/vs1`, with `records.json` and `report.md` |
| `check-passes` | `check` exits 0 on it |
| `lead-opus-high` | `required_lead_model` is `opus-high`, the recorded lead is Opus at effort `high`, and the `authorization` trigger is set |
| `plan-critique` | A completed R3 (`Explore`, `sonnet`) plan-critique |
| `planted-confirmed` | The planted defect is a confirmed defect, verified by R5 (`opus`) as confirmed or corrected |
| `evidence-first` | That finding's evidence pack exists |
| `control-not-confirmed` | The correct handler has no confirmed finding |
| `delegations-complete` | Every delegation completed, with at most one recovery message |
| `second-close-refused` | A second `close` is refused and changes nothing |

**Not a criterion, by owner decision:** `status` (M2-T6). Sonnet-lead comparisons belong to M5.

Record the result in `agents/claude/integrations/review/VALIDATION.md`, with the session's model, effort and cost. Then delete the fixture directory.
