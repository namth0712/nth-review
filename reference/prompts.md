# nth-review delegation prompts

These are the templates for R2, R3, R4, R5 and R6, for the Agent tool. R4 runs only in Full Audit, which stays disabled until release ([protocol.md](protocol.md) §0). Roles, costs and accounting are in [routing.md](routing.md); the confirmation rule is in [protocol.md](protocol.md) §7.

## Common rules

- **Settings.** Replace every `<…>` field. Set the listed agent (call `reviewer` as `nth-review:reviewer`, never a user or project agent named `reviewer`), the **model** (always explicitly: it defaults to Sonnet) and the **effort** (`high` with `opus`, none with `sonnet`). Record each call in `delegations[]` (routing.md, Accounting); `effort` is null for `sonnet`.
- **Evidence first.** Build the starting evidence each template names before the call. Never paste a verdict or another delegate's answer into a prompt.
- **Completion.** A delegate that ends without its JSON answer gets exactly one message: "Deliver your answer now from what you have; at most 3 more tool calls." After a second failure, record `completed: false`. Its work counts as not done:
  - a finding stays `candidate` with `verification.incomplete: true`;
  - a census or critique gap is recorded in the recipe's `limits`, or as `frontier` debt.
- **Discovered paths.** Every path an R2 or R3 answer names that no census item covers goes into that delegation's `discovered`, and gets a census disposition before close ([SKILL.md](../SKILL.md) §3.3).
- **Recorded discovery** (flow runs). The recorded edges and recipes are the shared discovery, and packs carry the edges bearing on an item: give them to a delegate as its starting evidence, and ask it to search again only to check or extend one, never to rediscover it.
- **Answers are input, never conclusions.**
  - Use only what the cited anchors show once you have read them.
  - An outcome whose anchors do not support it counts as not checked.
  - Agreement between agents is not evidence.
  - Keep the categories apart: source-proven, runtime hypothesis, owner-dependent, doc-drift, unverified or deferred (protocol.md §7).

## R2 census assist

- Agent: `Explore`
- Model: `sonnet`
- Effort: none
- Budget: at most 30 tool calls
- **When:** optional, during Census, when a population is too large for the lead's budget. It never replaces the lead's own census ([census.md](census.md) §5).
- **Before the call:** run `node "${CLAUDE_SKILL_DIR}/scripts/nthr.mjs" pack --run <run_dir> --for <obligation-id> --anchor <seed-anchor>`, naming the obligation whose population is enumerated and the known sites as seeds.

~~~text
You enumerate; you do not judge. Assume the sites you were given are incomplete, and find the missing ones.

Rules: read-only. Do not edit files, run tests, scripts, builds or database commands, or use any git command that writes. Never open .env files or other secrets. Write every path project-root-relative, starting with the repository directory (for example api/src/x.js:8). Never open anything under .nth-review/ except the files named below: earlier review runs are not your evidence.

Read the evidence pack first: <run_dir>/packs/<obligation-id>.md. Do not open records.json.

Task:
1. sites: every direct read and write site of the data or behaviour in the pack.
2. callers: for each write or authorization site, its direct and indirect callers, one hop at a time, up to an activation mechanism: route, handler, listener, scheduler, worker, script, client call, or "unknown".
3. where they exist: entries (routes and their authorization gates), schedules, events, migrations (including database-side logic), scripts, mirrors, clients and dynamic dispatch that reach it.
Seek what a text search misses: aliases, re-exports, dynamic dispatch, computed names, generated code, and writers outside these repositories. Report each such blind spot as a limit.

Budget: at most 30 tool calls. Answer before the budget is spent, even if incomplete, and list what you did not check.

Answer with exactly this JSON and nothing else; this replaces your usual report format:
{"sites": [{"kind": "sites|entries|schedules|events|migrations|scripts|mirrors|clients|dynamic", "anchor": "path:L1", "access": "read|write", "note": "…"}], "chains": [{"from": "path:L1", "mechanism": "route|handler|listener|scheduler|worker|script|client|unknown", "anchor": "path:L1 or null", "note": "…"}], "limits": ["…"], "checked": ["…"], "not_checked": ["…"]}
~~~

## R3 plan-critique

*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).*

- Agent: `Explore` (a fresh context)
- Model: `sonnet`
- Effort: none
- Budget: at most 30 tool calls
- **When:** once, after the census and outline, and before any discharge. It is mandatory.
- **Starting evidence:** the checkpointed `records.json` (scope, census and outline).

~~~text
You did not do this review; find what it missed.

Rules: read-only. Do not edit files, run tests, scripts, builds or database commands, or use any git command that writes. Never open .env files or other secrets. Write every path project-root-relative, starting with the repository directory (for example api/src/x.js:8). Never open anything under .nth-review/ except the files named below: earlier review runs are not your evidence.

Read first: <run_dir>/records.json — only its scope, census and obligations (the outline).

Questions (enumerate; do not judge):
1. Which call chains reach the changed write or authorization paths and are missing from the census?
2. Which entry or activation mechanisms are missing: routes, handlers, jobs and listeners with the sites that register or activate them, scripts, client call sites, and migrations or data changes that write the same data? Which search kind that can apply has no recipe?
3. Which declared exclusion (a census item with status "excluded", or affects null) hides an entry mechanism?
4. Which concern family the change can affect has no obligation? Families: LOGIC, AUTHN, AUTHZ, CONTRACT, INJECT, ATOMIC, DATA, ASYNC, RESOURCE, PERF, PRIVACY, RELIAB, UI, ENV, SUPPLY, ARCH, TEST. Which boundary the change reaches has no module check? Modules: LLM (model calls), HTTP-SERVER, SSR-WEB, SQL-ORM, OBJSTORE, HEADLESS-RENDER, FILE-PROCESSING, WEB-SESSION, INTEGRATION, INPROC-SCHED, MULTI-REPO, LEDGER (balances), SENSITIVE-SUBJECTS, CONTAINER-EDGE, CLIENT-TARGETS.
Seek counterevidence too: open the anchors the census and outline rely on, and report anything the source contradicts.
5. Which files you read bear on a changed behaviour but have no census item? List each in uncensused.

Budget: at most 30 tool calls. Answer before the budget is spent, even if incomplete, and list what you did not check.

Answer with exactly this JSON and nothing else; this replaces your usual report format:
{"additions": [{"anchor": "path:L1-L2 or null", "kind": "chain|mechanism|exclusion|family", "family": "<family or module code> or null", "note": "…"}], "contradictions": [{"anchor": "path:L1", "note": "…"}], "uncensused": ["path"], "checked": ["…"], "not_checked": ["…"]}
~~~

**In a Flow Review** ([protocol.md](protocol.md) §10), also give R3 the run's `census.edges`, and read "changed" as "reached from the entries". Add: which recorded edge's target leads on to a path the edges do not record, and which `excluded` or `unknown` edge hides an entry mechanism or a write.

**In Full Audit** ([protocol.md](protocol.md) §10), adapt the questions: in a unit run, "changed" means "in the unit's `scope`". In a plan run and at the audit close, also ask which census surface belongs to no unit, and which exclusion has no owner reason.

## R4 judgment critic

*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).*

- Agent: `nth-review:reviewer` (recorded as `reviewer`; a fresh context)
- Model: `opus`
- Effort: `high`
- Budget: at most 10 tool calls
- **When:** Full Audit only, once in each Tier-1 unit run, after Verify and before Close ([protocol.md](protocol.md) §10). It judges the reasoning; coverage of the outline is R3's, and refuting a finding is R5's or R6's.
- **Before the call:** checkpoint `records.json`, then run `node "${CLAUDE_SKILL_DIR}/scripts/nthr.mjs" pack --run <run_dir> --for <id>` for at most 3 closures to test first: held obligations with the widest coverage claim, and the most severe findings.

~~~text
You did not do this review; find what it missed.

Rules: read-only. Do not edit files, run tests, scripts, builds or database commands, or use any git command that writes. Never open .env files or other secrets. Write every path project-root-relative, starting with the repository directory (for example api/src/x.js:8). Never open anything under .nth-review/ except the files named below: earlier review runs are not your evidence.

Read the evidence packs first: <run_dir>/packs/<id>.md for <ids>. Then <run_dir>/records.json — only its scope, census, obligations and findings.

Judge the reasoning:
1. Which held obligation is closed on evidence that does not establish its acceptance?
2. Which coverage claim is wider than the cited evidence and the census show?
3. Which execution path into the unit's scope (a caller, entry, schedule, event, script or client) reaches the behaviour without the cited guard?
4. Which assumption is treated as fact without evidence?
5. Which severity or impact differs from the demonstrated impact?
Seek counterevidence: open the cited anchors and the code around them, and report what contradicts a conclusion. Agreeing with the review proves nothing, and a closure you do not challenge is no stronger for it.

Budget: at most 10 tool calls. Answer before the budget is spent, even if incomplete, and list what you did not check.

Answer with exactly this JSON and nothing else; this replaces your usual report format:
{"challenges": [{"target": "<obligation or finding id>", "kind": "weak-closure|coverage|missing-path|assumption|severity", "anchor": "path:L1 or null", "note": "…"}], "checked": ["…"], "not_checked": ["…"]}
~~~

## R5/R6 refuter

*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).*

**Routing:** which refuter a finding gets is decided in [routing.md](routing.md) (R5 or R6).

- **Agent:** `nth-review:reviewer` (recorded as `reviewer`), a fresh context.
- **R5:** Model: `opus`, Effort: `high`, Budget: at most 10 tool calls.
- **R6:** Model: `sonnet`, Budget: at most 10 tool calls per finding.
- **Before the call:** run `node "${CLAUDE_SKILL_DIR}/scripts/nthr.mjs" pack --run <run_dir> --for <finding-id>` for each finding.
- **Second refuter:** run a second R5 when an R5 answer changes the root cause, trace, impact or severity of a critical or high finding. Use a new pack, and do not include the first answer.

~~~text
You did not write this; try to refute it.

Rules: read-only. Do not edit files, run tests, scripts, builds or database commands, or use any git command that writes. Never open .env files or other secrets. Write every path project-root-relative, starting with the repository directory (for example api/src/x.js:8). Never open anything under .nth-review/ except the files named below: earlier review runs are not your evidence.

Read the evidence pack first: <run_dir>/packs/<finding-id>.md (one pack per finding). Do not open records.json or any other pack. Go beyond the pack's anchors only within your budget.

Question: is the finding's claim true as stated? Follow the trace from entrypoint to sink. Seek counterevidence first: guards, validation, callers that never reach the sink, contracts, configuration, tests or documents that contradict the claim. Correct the root cause, trace, impact or severity if they are wrong.

Kind: "defect" needs an intent the behaviour violates (a cited document, or one derived from the code's own contract). An exposure with no stated intent is "risk": the owner decides. Documents and code that disagree are "doc-drift". If the pack has a Boundary test, apply it: a security or privacy claim that fails it is "risk", or "corrected" to the impact it does show (name that impact in corrections).

Outcomes: "confirmed" means true as stated, from the source alone. "corrected" means true once your corrections apply. "rejected" means false; give the counterevidence. "needs_validation" means true only if a fact outside the source holds (deployment, configuration, runtime behaviour, data or owner knowledge): name that fact in validation_plan and give no severity. validation_plan is null for every other outcome. List in "evidence" the source anchors you read that support your outcome; an outcome without them counts as not checked.

Budget: at most <10 per finding> tool calls. Answer before the budget is spent, even if incomplete, and list what you did not check.

Answer with exactly this JSON and nothing else (an array with one object per finding); this replaces your usual report format:
[{"finding": "<finding-id>", "outcome": "confirmed|corrected|rejected|needs_validation", "kind": "defect|risk|doc-drift", "severity": "critical|high|medium|low|informational|null", "corrections": "… or null", "evidence": [{"anchor": "path:L1", "note": "…"}], "counterevidence": [{"anchor": "path:L1", "note": "…"}], "validation_plan": "… or null", "checked": ["…"], "not_checked": ["…"]}]
~~~
