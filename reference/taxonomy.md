# nth-review taxonomy

These are the concern families, their checks, the specialized modules, and severity.
- Technology-neutral; examples appear only where they make a rule clearer.
- Check ids are `FAMILY.n` for families and `MODULE.n` for modules; an obligation's `checks` use them ([records.md](records.md)).
- How findings are confirmed: [protocol.md](protocol.md) §7. Where populations come from: [census.md](census.md).

## Screening and outcomes

At Plan, **screen all 17 families** against the behaviour under review, and review in depth only those the change can affect. A Task review normally instantiates a few families, not all of them.

| Outcome | Meaning | Recorded as |
|---|---|---|
| **Not applicable** | nothing under review falls under the family's objective | no obligation. List the codes in `scope.summary` ("Not applicable: PERF, UI"); R3 may challenge them. |
| **Out of scope** | applicable, but excluded by the task boundary or an owner instruction | an obligation `out-of-scope` with `coverage: excluded` and the reason in `coverage_method`. If left out for the cap or the budget, it is `deferred-scope` debt instead. |
| **Checked, no confirmed finding** | discharged against cited evidence | an obligation `held`; its `coverage` says how much was examined |
| **Open or unverified** | not settled | an obligation `open` with its reason; findings `candidate` or `needs_validation` |

**Rules:**
- A check enters a review only through family applicability or a module the census finds. Where two checks overlap, **the owner table below decides**; the other check cites the owner instead of raising its own finding.
- **Missing documentation is never proof of a defect.** Without a documented or derived intent, an exposure is a `risk` for the owner, or an obligation `open` / `needs-owner-intent`. The gap in the documentation itself is recorded the same way, under ARCH.3. `doc-drift` is only for documents that contradict the code.
- Only source-supported, independently verified findings become `confirmed` ([protocol.md](protocol.md) §7).
- A claim that needs execution stays `open` / `needs-runtime`, or becomes `needs_validation`. The experiments that would settle it are listed, and deferred, in the runtime validation catalog below.

## Severity

*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).*

Severity applies only to a `confirmed` defect or doc-drift. A `risk` and a `needs_validation` finding have none. Severity never exceeds the demonstrated impact. Record one primary `impact_dimension`: `security`, `privacy`, `data-integrity`, `financial`, `availability`, `correctness`, `operability` or `maintainability`. A `security` or `privacy` impact needs a crossing: an actor, the control that should stop them, and another principal, tenant, shared resource or operator-paid spend affected, shown by the trace. A gap with no crossing is a `risk`, or a defect rated by the impact it does show.

| Level | Anchor |
|---|---|
| critical | data access or control by an unauthenticated or unrelated actor, across users or tenants; irreversible corruption or loss of many users' data; money or balances created or destroyed at scale; one cheap action takes the whole service down |
| high | an explicit control or invariant fully defeated, affecting other users or shared data: cross-tenant read or write; wrong balances; silent loss of a feature's data; persistent outage of a feature; sensitive data of a protected group disclosed |
| medium | a real violation with limited blast radius or uncommon preconditions: one record corrupted but recoverable; degradation noticeable at realistic load; documents contradicting code on an important workflow; tests that hide a defect class |
| low | a minor correctness or UX defect; non-sensitive internals disclosed; inefficiency with no user-visible effect at current scale |
| informational | hardening notes, maintainability observations |

Priority is the owner's decision. The review proposes; it never schedules or fixes.

## Families

### LOGIC — Business rules and invariants
**Objective:** every documented rule and state invariant holds on every path that can change the state it governs.
- **LOGIC.1** Placement and all writers: each rule is enforced where the architecture puts it, on every writer (user and admin paths, automation, AI executors, workers, scripts, imports, integrations).
- **LOGIC.2** State machines: only allowed transitions; no skipping, replay or going backwards; terminal states stay terminal.
- **LOGIC.3** Quantities: units, precision (money in exact types), rounding direction, zero, negative and maximum values, overflow.
- **LOGIC.4** Time: business time zone, day and month boundaries, expiry, scheduling windows, clock source.
- **LOGIC.5** Defaults: behaviour when an option, flag or configuration is absent (fail closed or fail open).
- **LOGIC.6** Business-flow abuse: legitimate flows used at scale or out of order without per-principal limits.
- **LOGIC.7** Derived consistency: counters, balances and copies agree with their source, and a reconciliation path exists.

**Fails by:** a writer that skips the rule; an illegal transition; wrong rounding or units; an off-by-one boundary; a fail-open default; a counter drifting from its source.
**Evidence:** a trace over every writer (census `callers`) to the enforcement point, against an intent anchor. **Counterevidence:** a guard, constraint or reconciliation on the path; a document stating the behaviour is intended.
**Severity:** follows the rule's business impact; money, balances and shared state rank higher.
**Runtime:** clock and boundary edges; transitions racing each other (the mechanism belongs to ATOMIC.3).
**Indirect paths:** shared helpers computing derived values; background recomputation; admin tools and imports writing the same state.

### AUTHN — Identity, credentials and sessions
**Objective:** every entry point establishes the right principal, and credentials are issued, stored, used, rotated and revoked safely.
- **AUTHN.1** Principal establishment: the public allow-list is exact; development fallbacks are unreachable in production; each entry type maps to its intended principal.
- **AUTHN.2** Credential storage and verification: password hashing parameters, token algorithm pinning, secret source, constant-time comparison, secrets hashed at rest.
- **AUTHN.3** Randomness: the entropy of tokens and codes relative to the attempt limits.
- **AUTHN.4** Session lifecycle: expiry, refresh rotation and reuse detection, revocation on logout, password or role change, and deletion.
- **AUTHN.5** Guessing and enumeration: throttling keyed on a trustworthy identity; uniform responses.
- **AUTHN.6** Recovery, linking and step-up: account linking and identity collision, recovery flows, step-up freshness.
- **AUTHN.7** Service credentials: API keys and shared secrets (scope, rotation, transport, exposure in logs).

**Fails by:** an endpoint missing from the gate; a debug fallback reachable in production; weak or unpinned tokens; sessions surviving revocation; unthrottled guessing.
**Evidence:** the gate and principal derivation per entry type (census `entries`). **Counterevidence:** an upstream gate that every route passes through; server-side revocation checks.
**Severity:** account takeover or an unauthenticated principal is critical.
**Runtime:** deployed secrets, proxy hop counts and identity-provider settings are owner-observed facts.
**Indirect paths:** shared authentication middleware; token helpers; proxy headers that decide the client identity.

### AUTHZ — Authorization and isolation
**Objective:** every action and every object or property reference is authorized for the acting principal, on every entry point, including derived and background paths.
- **AUTHZ.1** Function level: each operation has the right gates (authentication, mode, feature, permission) on every entry point.
- **AUTHZ.2** Object references: each independently selected reference (identifiers, nested and array fields, opaque and storage keys) is checked against the principal's relationship to the object.
- **AUTHZ.3** Property level: writable fields are allow-listed (mass assignment); readable fields are minimized per role.
- **AUTHZ.4** Tenant and owner scoping: every read, list, count, search, export and aggregate binds the owner scope, on background, admin and AI paths too.
- **AUTHZ.5** Privilege transitions: role changes, impersonation, delegation and share links; revocation takes effect.
- **AUTHZ.6** Cached or derived authority: permission caches and claim-carrying tokens stay consistent and are invalidated on change.

**Fails by:** a session check without an ownership check (IDOR); a list query missing its owner filter; mass assignment of a role or owner field; stale cached permissions.
**Evidence:** one enforcement point per reference, traced from entry to data access; the sibling handlers' pattern as a comparison. **Counterevidence:** scoping enforced in a shared query layer, a database policy or a gateway, cited.
**Severity:** cross-tenant read or write is high or critical, so it goes to R5 ([routing.md](routing.md)).
**Runtime:** grants held in a database and the process count are owner-observed facts.
**Indirect paths:** repository and query helpers; background jobs acting for a user; exports; AI tools acting for the requester.

### CONTRACT — API contracts and input handling
**Objective:** producers and consumers agree on every interface, and untrusted input is validated where it crosses a trust boundary.
- **CONTRACT.1** Interface agreement: mount, method and base path; request and response shapes; error variants; mirrored copies.
- **CONTRACT.2** Validation at the boundary: type, range, length, format, enum and canonical form; unknown fields; validation before any effect.
- **CONTRACT.3** Files and imports: type checked by content, size and count limits, names, storage keys, import formats treated as untrusted.
- **CONTRACT.4** Error contract: errors are stable and phrased, internals are not leaked, retryable errors are distinguishable.
- **CONTRACT.5** Compatibility: deployed clients (open sessions, integrations, other apps) and the deployment order keep working.

**Fails by:** a client calling a path or shape the server does not serve; validation after a side effect; a breaking change to a field deployed clients still send.
**Evidence:** client call sites against the server's route and schema (census `clients`, `mirrors`), plus any contract checker the project already has. **Counterevidence:** a gateway rewrite, a version negotiation or a tolerant reader, cited. If they exist only outside the repositories, the finding is `needs_validation`.
**Severity:** usually medium; higher when invalid input reaches stored state.
**Runtime:** deployed client versions and gateway configuration are owner-observed facts.
**Indirect paths:** shared request wrappers; generated clients; mirrored type definitions.

### INJECT — Interpreter and sink safety
**Objective:** data an attacker can influence never reaches an interpreter or sensitive sink without the neutralization that sink requires, including data stored earlier and used later.
- **INJECT.1** Query languages: raw fragments, identifiers or sort keys built from input.
- **INJECT.2** Processes and dynamic code: shell and process spawning, dynamic evaluation, dynamic import, template compilation.
- **INJECT.3** Markup and rich content: raw HTML sinks, renderers that emit HTML, sanitizer configuration, inline uploaded HTML or SVG.
- **INJECT.4** Outbound requests: URLs influenced by input in server fetches and headless navigation, redirects and DNS rebinding.
- **INJECT.5** Paths and storage keys: traversal through names, archive entries and keys.
- **INJECT.6** Redirects, headers and cookies: open redirects, header injection.
- **INJECT.7** Secondary interpreters: spreadsheet formulas in exports, log injection, regular expressions built from input. Prompts belong to the LLM module.

**Fails by:** influenced data reaching a sink unescaped; a sanitizer configured to allow the dangerous construct; second-order data trusted because it came from the database.
**Evidence:** a source-to-sink trace naming the missing or wrong neutralization. **Counterevidence:** parameterization, escaping, an allow-list or a validated type on the path.
**Severity:** by what the sink grants; remote code execution or a cross-user script is critical or high.
**Runtime:** sanitizer or renderer behaviour that cannot be read from source is `needs_validation`, with a local fixture plan.
**Indirect paths:** stored values rendered later; shared formatting and export helpers; third-party renderers.

### ATOMIC — Transactions and concurrency
**Objective:** each multi-step write is atomic, and concurrent requests cannot produce a state the rules forbid.
- **ATOMIC.1** Transaction boundaries: every write of one unit is covered; a refusal after a write rolls back.
- **ATOMIC.2** Effects outside the transaction: storage, events, external calls and caches happen after commit, or are compensated.
- **ATOMIC.3** Concurrency: check-then-act and lost updates; the arbiter (row lock, unique constraint, compare-and-set); the assumed isolation level.
- **ATOMIC.4** Lock order and duration: deadlock-prone orderings; locks held across slow I/O.
- **ATOMIC.5** Idempotency of retried requests: double submit, client retry, replay.

**Fails by:** a partial write on error; an event published before commit; two requests passing the same check; locks taken in opposite orders.
**Evidence:** the transaction scope and arbiter, cited on every write of the unit. **Counterevidence:** a unique constraint or lock that serializes the race; an idempotency key.
**Severity:** corrupted shared state or balances is high.
**Runtime:** **concurrency claims are never `held` on source alone.** They stay `open` / `needs-runtime` until a deterministic test exists.
**Indirect paths:** helpers that open their own transactions; event hooks after commit; retries in clients and queues.

### DATA — Schema, constraints and migrations
**Objective:** the schema enforces what it should, and every migration moves deployed data safely from one version to the next.
- **DATA.1** Constraints encode invariants: not-null, unique and foreign-key constraints, or the documented application-level equivalent.
- **DATA.2** Types and precision: money, time zones, character sets and collations (which affect uniqueness), size limits.
- **DATA.3** Migration safety: order; non-transactional schema changes leaving a half-applied state; backfills; locking on large tables; rollback or forward fix.
- **DATA.4** Drift: models, migrations, mirrored copies and the applied schema agree.
- **DATA.5** Referential lifecycle in code: cascades and cleanup done by the application are complete, with no orphans.

**Fails by:** an invariant enforced only in one writer; a migration that cannot complete on real data; a model that no longer matches its migration; orphaned rows.
**Evidence:** model and migration anchors (census `migrations`), including any database-side logic. **Counterevidence:** a constraint or cleanup path that covers the case.
**Severity:** silent loss or corruption of stored data is high.
**Runtime:** the applied schema and data volumes are owner-observed facts, or need a rehearsal on a copy.
**Indirect paths:** database-side triggers or procedures; mirrored schemas in other repositories; data-fix scripts.

### ASYNC — Background work, events and schedules
**Objective:** asynchronous work is delivered with the documented semantics, is safe to retry or replay, and recovers from crashes without corrupting state.
- **ASYNC.1** Delivery semantics: at-most-once, at-least-once or exactly-effective, and whether accepted loss is documented.
- **ASYNC.2** Idempotency: replay, retry and duplicates are safe; deduplication keys are scoped correctly.
- **ASYNC.3** Claims, leases and crash windows: lease expiry, epochs, heartbeats; the gap between an effect and recording it.
- **ASYNC.4** Ordering and stale state: out-of-order processing; acting on an outdated snapshot.
- **ASYNC.5** Scheduling: overlapping runs, single-instance assumptions, shutdown behaviour.
- **ASYNC.6** Poison items and backoff: quarantine, retry ceilings, head-of-line blocking.
- **ASYNC.7** Visibility: stuck or failed work is visible to an operator.

**Fails by:** a duplicate effect on retry; work lost in a crash window; a job overlapping itself; a poison message blocking a queue.
**Evidence:** the producer, consumer and schedule anchors (census `events`, `schedules`) and the idempotency mechanism. **Counterevidence:** deduplication keys, leases or a documented loss acceptance.
**Severity:** silent loss or double effects on money or shared state is high.
**Runtime:** crash, replay and restart behaviour needs a runtime test; until then it is `open` / `needs-runtime`.
**Indirect paths:** events emitted by shared services; schedules configured outside the code; retries in the broker.

### RESOURCE — Bounds and cleanup
**Objective:** every consumption of a finite resource is bounded at the right scope, and every acquired resource is released on every path.
- **RESOURCE.1** Per-request bounds: body, file, count, depth and decompression limits, checked again after each expansion.
- **RESOURCE.2** Per-principal and global quotas, including spend the operator pays for (AI calls).
- **RESOURCE.3** Queues and concurrency: admission limits, deadlines, fairness.
- **RESOURCE.4** Cancellation: work stops when the client goes away, and deadlines propagate.
- **RESOURCE.5** Cleanup on all paths: handles, temporary files, timers, listeners, browsers; unbounded in-memory structures.
- **RESOURCE.6** Superlinear work: regular-expression backtracking, nested parsing, fan-out.

**Fails by:** an unbounded loop or payload; a handle leaked on an error path; one user exhausting a shared quota.
**Evidence:** an input-to-cost path with the missing bound. **Counterevidence:** a limit enforced upstream (gateway, framework default), cited.
**Severity:** a cheap request that exhausts a shared resource is high; local leaks are lower.
**Runtime:** leak growth, latency and memory claims need a bounded runtime measurement.
**Indirect paths:** shared parsers and clients; background loops; third-party SDK defaults.

### PERF — Efficiency and capacity
**Objective:** realistic workloads meet the declared performance needs without avoidable work.
- **PERF.1** Query efficiency: predicates covered by indexes, no unbounded scans or sorts, pagination, no N+1 loops.
- **PERF.2** Contention: hot locks or rows that cut throughput; long transactions (correctness belongs to ATOMIC).
- **PERF.3** Shared capacity: connection pools against the concurrency of requests and background work sharing them.
- **PERF.4** Hot-path CPU and memory: heavy processing on the request path, blocking I/O, buffering where streaming is possible.
- **PERF.5** Cache correctness: keys, invalidation, staleness bounds, per-user scope.
- **PERF.6** Client performance: bundle size, request waterfalls, repeated rendering, oversized payloads.
- **PERF.7** Budgets and observability: declared targets exist, and timing data exists to check them.

**Fails by:** a query per item in a loop; an unindexed predicate on a large table; a cache shared across users.
**Evidence:** the query or loop, with predicate and cardinality reasoning; "missing index" needs both. **Counterevidence:** an index, a batch loader or a bounded population.
**Severity:** without declared targets, findings are relative and **capped at low** unless users notice the effect. A cache serving another user's data is an AUTHZ.4 defect.
**Runtime:** **performance claims are never `held` on source alone.** Plans and timings need representative data; until then they are `open` / `needs-runtime`.
**Indirect paths:** ORM relation loading; shared pools; middleware on every request.

### PRIVACY — Data lifecycle and sensitive information
**Objective:** each category of sensitive data is collected minimally, exposed only to intended readers in every copy, kept no longer than decided, and deleted everywhere when deletion is promised.
- **PRIVACY.1** Inventory: the categories of sensitive data and the stores holding them (databases, objects, logs, traces, providers, exports, backups).
- **PRIVACY.2** Minimal exposure: responses, logs, error reports, traces, analytics, data sent to providers.
- **PRIVACY.3** Retention: each store has a decided period and a working cleanup.
- **PRIVACY.4** Deletion propagation: deleting an account or object reaches every copy and derived datum; backups by policy.
- **PRIVACY.5** Exports, imports and backups: scope, access, encryption, re-authorization on restore.
- **PRIVACY.6** Disclosure to third parties: what is sent to AI providers and integrations, recorded as fact. The legal basis is the owner's decision.

**Fails by:** a secret or personal field in a log; a deleted account surviving in a derived store; an export without scoping.
**Evidence:** the copy path from the source to each store. **Counterevidence:** redaction, a retention job or a deletion hook, cited.
**Severity:** disclosure of a protected group's data, or of credentials, is high.
**Runtime:** backup contents, provider retention and legal duties are owner-observed.
**Indirect paths:** logging and tracing helpers; caches; search indexes; webhooks to other products.

### RELIAB — Failure handling and recovery
**Objective:** exceptional conditions are detected and handled truthfully, external failures degrade predictably, and the system restarts and restores without losing integrity.
- **RELIAB.1** Exceptional conditions: no swallowed errors; truthful outcomes; security decisions fail closed.
- **RELIAB.2** Dependency failure: timeouts, retries with backoff, partial results, behaviour while a provider is down.
- **RELIAB.3** Startup and shutdown: configuration validation, graceful shutdown of in-flight work, recovery after restart.
- **RELIAB.4** Degraded modes: maintenance, disabled features, read-only states.
- **RELIAB.5** Backup and restore: backups exist, a restore has been rehearsed, recovery objectives are decided.

**Fails by:** a caught error reported as success; an unbounded wait on a dead dependency; a fail-open security check on error.
**Evidence:** the error path from the failure to what the caller and user see. **Counterevidence:** a handler, a timeout or a circuit breaker, cited.
**Severity:** silent data loss or a failed-open control is high.
**Runtime:** crash, restart and restore behaviour need runtime or owner-run evidence.
**Indirect paths:** shared error middleware; SDK default timeouts; process managers.

### UI — Client correctness and accessibility
**Objective:** the client shows state consistent with the server, handles every outcome a user can meet, enforces nothing alone, and is usable with assistive technology.
- **UI.1** Server-state consistency: invalidation after mutations, rollback of optimistic updates, state shared across tabs.
- **UI.2** Outcome states: loading, empty, error, forbidden, expired session and offline are all handled; no silent failure.
- **UI.3** Client validation mirrors server rules, and never replaces them.
- **UI.4** Navigation and URL contract: deep links, guards per page and mode.
- **UI.5** Accessibility: semantics, keyboard, focus, labels, contrast, motion.
- **UI.6** Interface text: strings go through the localization system; raw codes are never shown.

**Fails by:** stale data after a mutation; an error shown as an empty list; a rule enforced only in the browser; a control unusable by keyboard.
**Evidence:** the mutation call site and its cache handling; each outcome branch. **Counterevidence:** a shared hook or boundary that handles the state.
**Severity:** a defect that misleads users about their data is medium; a client-only security rule is an AUTHZ defect.
**Runtime:** browser behaviour and accessibility need a browser check.
**Indirect paths:** shared data-fetching hooks; layout-level guards; component libraries.

### ENV — Environment, deployment and operations
**Objective:** the assumptions the code makes about its environment hold or are recorded as unknown, and the deployed configuration protects, observes and preserves the system.
- **ENV.1** Environment assumptions: process count, configuration held in a database, versions and feature gates; each observable or recorded `unknown`.
- **ENV.2** Configuration and secrets: sources, per-environment separation, unsafe defaults blocked at startup, no secrets in the repository, artifacts or logs.
- **ENV.3** Edge and proxy: TLS, security headers, body limits, trusted proxy hops, exposure of internal services, CORS.
- **ENV.4** Hosts and containers: pinned images, users, volumes, ports, restart policies.
- **ENV.5** Object storage: access policy, public access, signed URL scope and expiry, lifecycle rules.
- **ENV.6** Observability: error capture, correlation, alerting on stuck work, audit trails for privileged actions.
- **ENV.7** Release and rollback: migration order against deployment, versions deployed together, the rollback path.

**Fails by:** an unsafe default that starts in production; a secret committed to the repository; an internal service exposed; no alert on failed work.
**Evidence:** the configuration in the repository. **Counterevidence:** a startup check that refuses the unsafe value, or a dated owner observation. **Repository configuration is not deployed configuration:** a deployed fact is an `environment` assumption, `observed: unknown` until the owner records it.
**Severity:** a committed credential or an exposed internal service is high.
**Runtime:** deployed configuration is owner-observed, with a date.
**Indirect paths:** configuration loaders; deploy scripts; the database tables that hold configuration.

### SUPPLY — Dependencies, build and release
**Objective:** third-party code and build inputs are known, current enough, obtained with integrity, and released through a path that cannot be silently substituted.
- **SUPPLY.1** Vulnerable or unmaintained components, with the reachability of the vulnerable function assessed before severity.
- **SUPPLY.2** Integrity and reproducibility: lockfile hashes, clean installs, pinned images.
- **SUPPLY.3** Install-time execution: install hooks, local patches of dependencies.
- **SUPPLY.4** Build inputs and generated code: origin and regeneration of generated files and mirrors.
- **SUPPLY.5** Release path: who builds, where artifacts come from, which credentials are involved.

**Fails by:** an unpinned dependency; an install hook running untrusted code; a generated file that no longer matches its source.
**Evidence:** lockfiles and build scripts. **Counterevidence:** pinning, integrity hashes, a reviewed release path.
**Severity:** depends on reachability; an unreachable vulnerable function is informational.
**Runtime:** an advisory lookup is a network action and needs owner authorization. Without it, the finding is `needs_validation`.
**Indirect paths:** transitive dependencies; build plugins; base images.

### ARCH — Architecture conformance and maintainability
**Objective:** the code follows its documented architecture, implements each concern once, and its documentation tells the truth.
- **ARCH.1** Boundaries and layering: the documented rules hold.
- **ARCH.2** One implementation per concern: no parallel versions; mirrors kept in sync; exceptions recorded.
- **ARCH.3** Documentation truth: implemented behaviour matches the owning documents, and documents describe only what is implemented. **Missing documentation is recorded here, never as a business-logic defect:** a `risk`, or an obligation `open` / `needs-owner-intent`.
- **ARCH.4** Hotspots: churn, size and defect history; dead or unreachable code.
- **ARCH.5** Coupling: dependency direction and integration boundaries between products and modules.

**Fails by:** logic placed in the wrong layer; a second implementation drifting from the first; a document describing behaviour the code does not have.
**Evidence:** the documented rule and the violating anchor; for doc-drift, exact lines on both sides. **Counterevidence:** a recorded exception or decision.
**Severity:** **capped at medium** unless the issue demonstrably caused or hid a defect.
**Runtime:** none needed.
**Indirect paths:** shared utilities; mirrored code; documentation indexes.

### TEST — Quality of test evidence
**Objective:** tests relied on as evidence actually establish the claim, run reliably, and do not damage shared state.
- **TEST.1** Assertion relevance: the test asserts the claimed property, not merely that code runs.
- **TEST.2** Determinism: time, randomness, ordering, shared data.
- **TEST.3** Isolation: no mutation of shared environments; cleanup survives interruption.
- **TEST.4** Sad paths: denials, rollback, concurrency and boundary values are covered.
- **TEST.5** Runnable and current: run instructions exist; tests are not stale.

**Fails by:** a test that would pass with the defect present; flaky timing; a test that writes to a shared database.
**Evidence:** the test source and the claim it is cited for. **Counterevidence:** another cited test or assertion that does establish the claim. **Reviews never run tests.**
**Severity:** a test that hides a defect class is medium.
**Runtime:** running tests is outside the review; it is a separate, owner-authorized action.
**Indirect paths:** shared fixtures; test helpers; seeded data.

## Runtime validation catalog (deferred)

These experiments settle claims that source alone cannot. **nth-review runs none of them:** the experiment harness is deferred from v1, and a review never runs tests, services, migrations or database clients. The catalog says what would settle a claim, so that a finding or debt can name it.
- A `needs_validation` finding names the RT id in its `validation_plan`; `runtime` debt names it in `requires`.
- RT12 is not an experiment: record an `environment` assumption with `observed: unknown`, and `owner-fact` debt.
- Any experiment needs the owner's authorization and an **isolated environment**:
  - its own database, never one shared with another checkout or worktree (separate ports prove nothing);
  - its own object storage, or a stub;
  - a mocked AI provider: no real keys, no spend;
  - no network beyond loopback;
  - dummy principals and fixtures only;
  - a controllable clock where timing matters;
  - CPU, memory and wall-clock limits;
  - a cleanup that survives being killed.

| Id | Experiment | Settles | Notes |
|---|---|---|---|
| RT1 | Deterministic concurrency: double submit, parallel transitions, check-then-act interleavings | ATOMIC.3, ATOMIC.5, LOGIC.2, LEDGER | barrier or hook scheduling, not volume |
| RT2 | Fault injection between writes, after commit, and in storage or provider calls | ATOMIC.1, ATOMIC.2, RELIAB.1 | throw at named points; check the rollback and the truth of what is reported |
| RT3 | Lock-order and deadlock reproduction | ATOMIC.4, PERF.2 | two sessions, scripted statement order |
| RT4 | Query plans on representative volume | PERF.1, PERF.2 | synthetic data at production-like cardinality; never production data |
| RT5 | Query counts per request (N+1) | PERF.1 | query logging in the isolated environment |
| RT6 | Memory and handle growth over N iterations; queue latency and admission | RESOURCE.3, RESOURCE.5, PERF.4 | small, bounded growth points; no stress testing |
| RT7 | Crash or kill during work, then restart | ASYNC.3, RELIAB.3 | recovery of leases and epochs; event-loss windows |
| RT8 | Browser checks: security-policy and CORS behaviour, token handling across tabs, outcome states, an accessibility scan with a manual keyboard pass | UI, WEB-SESSION, ENV.3 | a local build against the isolated backend |
| RT9 | AI with a scripted mock model: malicious tool calls, injected content, provider errors and timeouts, budget exhaustion | LLM, RESOURCE.2, RELIAB.2 | the mock returns adversarial proposals; check authorization at dispatch |
| RT10 | Migration rehearsal on a copy: forward, partial failure, rollback or forward fix | DATA.3, CONTRACT.5 | a copy of the schema plus synthetic data |
| RT11 | Restore drill | RELIAB.5, PRIVACY.5 | owner-run |
| RT12 | Owner-observed deployment facts: process count, configuration held in a database, edge headers, schedules, versions deployed together | ENV, AUTHZ.6 | a dated record, not an experiment |

## Owner of overlapping concerns

| Concern | Owner | Not |
|---|---|---|
| Who may see or change a field | AUTHZ.3 | PRIVACY |
| Where copies of data go and how long they live | PRIVACY | AUTHZ |
| The mechanism of concurrent transitions | ATOMIC.3 | LOGIC.2, which owns which transitions are legal |
| Rate limits protecting spend or capacity / credentials / business flows | RESOURCE.2 / AUTHN.5 / LOGIC.6 | |
| Index or plan efficiency | PERF.1 | DATA, which owns constraints |
| Lock correctness | ATOMIC.4 | PERF.2, which owns throughput |
| Errors leaking internals | CONTRACT.4 | RELIAB.1, which owns truthful handling |
| Deployed headers, CORS, TLS | ENV.3 | INJECT, which owns sinks; WEB-SESSION.3 owns credentialed CORS set in code |
| Idempotency of retried requests / of background replay | ATOMIC.5 / ASYNC.2 | |
| Mirrored copies: interface shapes / schemas / generated origin / duplicated logic | CONTRACT.1 / DATA.4 / SUPPLY.4 / ARCH.2 | MULTI-REPO.1, which adds the mirror check |
| Unsafe defaults: business options / authentication fallbacks / configuration at startup | LOGIC.5 / AUTHN.1 / ENV.2 | |
| A cache serving another principal's data | AUTHZ.4 | PERF.5, which owns keys and staleness; AUTHZ.6, which owns cached permissions |
| Missing documentation, or documents contradicting code | ARCH.3 | every family cites it |

## Specialized modules

*Adapted in part from Cloudflare's security-audit-skill (MIT); see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).*

A module is selected when the census finds the **boundary** it describes, not because a dependency name appears ([census.md](census.md) §3). Its checks join the obligations of the families it adds to, or a new obligation. A module whose boundary is found but which is left out is recorded like a family (Out of scope, or `deferred-scope` debt). Checks are `MODULE.n`.

| Module | Census fact | Adds to | Checks |
|---|---|---|---|
| **LLM** | model calls with user content, or model-proposed actions | AUTHZ, INJECT, RESOURCE, PRIVACY, RELIAB | **LLM.1** prompt parts keep their provenance (indirect injection through stored content); **LLM.2** proposed actions are re-authorized for the requester at dispatch, and the approved object is the executed object; **LLM.3** model output reaching renderers or sinks is treated as untrusted; **LLM.4** per-user and global spend budgets and loop bounds; **LLM.5** provider errors, timeouts, retries and configuration held in a database |
| **HTTP-SERVER** | a server framework with middleware | CONTRACT, ENV, RELIAB | **HTTP-SERVER.1** middleware order relative to authentication and parsers; **.2** trusted proxy hops; **.3** body limits; **.4** asynchronous errors reaching the error handler; **.5** route shadowing and mount order |
| **SSR-WEB** | server-rendered or full-stack web framework | AUTHZ, PRIVACY, ENV, INJECT | **SSR-WEB.1** server functions callable from the client, and route handlers, are public endpoints that need authorization; **.2** paths that the framework's path-matching middleware does not cover; **.3** server-only values leaking into client bundles; **.4** caching of per-user data; **.5** built-in proxy, rewrite or media-optimization features used as fetch proxies |
| **SQL-ORM** | a relational database through an ORM or query builder | INJECT, ATOMIC, DATA, PERF | **SQL-ORM.1** raw-fragment escape hatches; **.2** the driver's commit and rollback semantics; **.3** isolation level and locking reads; **.4** non-transactional schema changes; **.5** pool configuration |
| **OBJSTORE** | object storage with signed URLs | AUTHZ, PRIVACY, INJECT, ENV | **OBJSTORE.1** key namespace per owner; **.2** signed-URL operation, scope and expiry; **.3** content type and disposition on download; **.4** orphan cleanup; **.5** deletion propagation |
| **HEADLESS-RENDER** | a headless browser rendering untrusted content | INJECT, RESOURCE, ENV | **HEADLESS-RENDER.1** network interception and file or URL blocking; **.2** script execution policy; **.3** sandbox flags; **.4** time, request and memory limits; **.5** profile cleanup |
| **FILE-PROCESSING** | parsing uploaded documents, images or archives | CONTRACT, INJECT, RESOURCE | **FILE-PROCESSING.1** type detection by content; **.2** decompression and pixel bombs; **.3** archive entry names; **.4** parser currency; **.5** per-file time and memory limits |
| **WEB-SESSION** | credentials held by the browser (cookies or storage) | AUTHN, AUTHZ, INJECT | **WEB-SESSION.1** CSRF for ambient credentials; **.2** cookie scope and flags; **.3** CORS with credentials; **.4** token storage against script injection; **.5** refresh races across tabs |
| **INTEGRATION** | API clients, single sign-on exchanges, outbound integrations | AUTHN, AUTHZ, CONTRACT | **INTEGRATION.1** key scope per resource; **.2** replay and freshness of exchanges; **.3** upstream responses treated as untrusted; **.4** versioning for external clients; **.5** revocation |
| **INPROC-SCHED** | timers, sweeps or workers inside a long-running process | ASYNC, RESOURCE, ENV | **INPROC-SCHED.1** single-instance assumptions; **.2** overlap protection; **.3** shutdown behaviour; **.4** pools shared with requests; **.5** failure visibility |
| **MULTI-REPO** | code or contracts mirrored across repositories | CONTRACT, DATA, ARCH, ENV | **MULTI-REPO.1** mirror equality and coverage; **.2** contract checks; **.3** versions deployed together; **.4** hand-written bindings outside the mirror check |
| **LEDGER** | balances, points, money or stock | LOGIC, ATOMIC, DATA | **LEDGER.1** every balance change is a recorded entry; **.2** idempotent sources; **.3** precision; **.4** reconciliation; **.5** the audit trail |
| **SENSITIVE-SUBJECTS** | data about minors or other protected groups | PRIVACY, AUTHZ | **SENSITIVE-SUBJECTS.1** who controls the data; **.2** what members of the group can see of each other; **.3** content sent to AI providers; **.4** retention of their work. Which law applies is the owner's decision. |
| **CONTAINER-EDGE** | container or reverse-proxy configuration in the repository | ENV, SUPPLY | **CONTAINER-EDGE.1** image pinning; **.2** non-root users; **.3** secrets in images or environment; **.4** exposed services; **.5** proxy headers and limits |
| **CLIENT-TARGETS** | browser-extension, desktop or mobile targets | per platform | Review against the platform's own security model; there are no numbered checks in this version. |

A shorthand `.n` in this table means the module's own id, as in `HTTP-SERVER.2`. A run may also cite a module by its bare name (`LEDGER`) when it applies the module as a whole.
