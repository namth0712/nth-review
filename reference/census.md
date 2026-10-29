# nth-review census

The census establishes **what exists** before any obligation is judged:
- every file in scope;
- every entry point;
- every path that reaches the behaviour under review.

Fields are in [records.md](records.md#census), the lifecycle in [protocol.md](protocol.md), and concern families in [taxonomy.md](taxonomy.md).

**A search that returns no further hits shows only what that search can see. It never proves that nothing else exists.**

## 1. Coverage units

| Unit | Population | Recorded as |
|---|---|---|
| **Changed file** | every file of every `--change`; in Incremental runs, every `freshness.changed_files` entry | one `census.items` entry each, or a group path (`*` and `?` within one segment) |
| **Entry point** | each mechanism that can start the behaviour (§2) | the `mechanism` of the item that holds it, and an item of its own for the file that registers or activates it (a route table; a scheduler, listener or plugin registration; a loader), even when that file is unchanged |
| **Site** | each place the behaviour's data or state is read or written | evidence anchors of the obligations; a writer of the data outside the changed files (a migration, including data changes; a script; a job) also gets an item |
| **Chain** | the call path from a site up to its entry point, or to `unknown` | one recipe per search, and the chain in the obligation's evidence |
| **Copy** | each mirrored type, schema or contract, and its checker | an item, plus an assumption on the checker |

Each item records `id`, `path` (a file, `.`, or a group path), `mechanism`, `status`, `reason` and `affects`. A file named only in another item's `mechanism` or `reason` is not covered: give it its own item, or record `frontier` debt.

**Item `status`:**
- **`classified`:** its mechanism is known. `affects` names the obligations it bears on; `affects: null` needs a reason saying why it cannot affect any obligation.
- **`unknown`:** it exists, but what activates it or what it changes cannot be established within budget. A reason is required. Name the obligations it could bear on: with `affects` null or empty it bears on every obligation, and `check` then refuses `all-enumerated` for every concluded one.
- **`excluded`:** deliberately outside the review (the task boundary, generated or vendored code, an owner instruction). A reason is required. R3 challenges every exclusion. An excluded item that names an obligation takes away its `all-enumerated` claim; one naming no obligation affects none.

Classify a file only after opening it at the relevant lines, never by its name. In Incremental runs, `check` requires an item for every changed file (C11).

## 2. Search kinds

Each search is one `census.recipes` entry:
- **`id`:** sequential (`C1`, `C2`, …);
- **`pattern`:** the literal search, prefixed with its kind, for example `callers: getInvoice|findInvoice`;
- **`scope`:** the paths searched;
- **`hits`:** the number of hits;
- **`limits`:** what this search cannot see.

| Kind | Finds | Typical blind spots, recorded in `limits` |
|---|---|---|
| `sites` | direct reads and writes of the data or behaviour: symbols, tables, columns, keys, query text | names built at runtime; ORM-derived names; queries assembled from strings |
| `callers` | direct and indirect callers, one hop at a time, up to an activation mechanism | callbacks passed as values; dependency-injection containers; reflection; framework hooks |
| `entries` | HTTP and API routes, RPC methods, handlers and the authorization gates in front of them (middleware, decorators, policies) | sub-routers mounted under a prefix; routes generated or registered at runtime; gates applied by a proxy |
| `schedules` | timers, cron definitions, queues, sweeps, executors and background workers | schedules configured on hosts, in a database or in another repository |
| `events` | event producers and consumers, matched by event name or topic on both sides | names built at runtime; brokers or subscriptions configured outside the repository |
| `migrations` | schema changes and data changes (DML) touching the data, constraints, and database-side logic (triggers, procedures, scheduled events) | the applied schema differing from the files; manual changes |
| `scripts` | production scripts, command-line tools, deploy, maintenance and import entry points | host cron; operator runbooks; one-off scripts outside the repository |
| `mirrors` | copies of types, schemas or contracts across repositories, and the checker that keeps them equal | hand-written bindings; which versions are deployed together |
| `clients` | client call sites of the endpoints: wrappers, generated clients, other services | base paths and prefixes added by proxies or gateways |
| `dynamic` | unresolved paths: dispatch by string or table, plugins, reflection, model-proposed actions | each unresolved hop ends in `unknown` |

## 3. Procedure

1. **Seed:**
   - Classify every changed file (§1).
   - Mark each changed write or authorization path, and each changed entry point.
2. **Enumerate from each marked path.**
   - Start with `sites`, then follow `callers` until every chain ends at a mechanism (`entries`, `schedules`, `events`, `scripts`, `clients`) or at `unknown`.
   - When the change reads or writes stored data, run `migrations` over its tables or keys: schema changes, and data changes (DML, seeds, backfills) that write the same data. When it touches a shared type, schema or contract, run `mirrors`.
   - For each indirect mechanism a chain ends at (a schedule, listener, plugin, loaded module), search for the site that registers or activates it, and classify that site.
   - Run only the kinds that can apply, and record every search you run.
3. **Modules.** When a search finds a module's boundary (model calls, balances, object storage, …; [taxonomy.md](taxonomy.md#specialized-modules)), add its checks to the obligations it bears on, or add an obligation, before R3. Cite the boundary as evidence.
4. **Boundaries.** Stop a chain at a documented boundary contract. Cite the contract as a `dependency` assumption, so a later change to it reopens the obligation (C11).
5. **R2 (optional).** Use it for a population too large for the lead's budget (§5).
6. **R3 (mandatory).** After the census and the outline, before any discharge (§5).

## 4. Recording what is not covered

| Gap | Records | Consequence |
|---|---|---|
| A search limit that could hide a member (a writer, entry point or consumer) | `limits` of that recipe, then `frontier` debt, or `owner-fact` debt if only the owner knows | the population is not `all-enumerated` |
| A chain ending in `unknown` | an `unknown` item, or the obligation's evidence notes it, plus `frontier` debt | the obligation cannot be `all-enumerated` |
| An excluded file or area | an `excluded` item with its reason | shown in the report; R3 challenges it |
| Unverified source (secret, filtered, flagged, unreadable or linked files; incomplete discovery) | written by the helper into the snapshot and footprint | evidence on such files is never "Verified"; with incomplete discovery nothing is `all-enumerated` (`check`) |
| A fact outside the repositories (an applied schema, host cron, gateway rewrites) | an `environment` assumption with `observed: unknown`, plus `owner-fact` debt | it appears under the report's untested properties |

## 5. Assist and challenge

**R2, census assist** (optional; [prompts.md](prompts.md) R2):
- It enumerates sites and chains for one obligation's population, starting from a pack with seed anchors.
- Its results are **leads**. Open each one before citing it.
- Record each R2 delegation as one recipe: `pattern` is `r2: <obligation-id>`, `hits` counts the sites and chains it returned, and `limits` holds its `limits` and `not_checked`. What stays unresolved becomes frontier debt.
- R2 never classifies items or decides coverage.

**R3, plan-critique** (mandatory; [prompts.md](prompts.md) R3). In a fresh context, it asks:
- which chains and entry mechanisms are missing;
- which exclusion hides an entry point;
- which concern family or module has no obligation;
- what the source contradicts.

Accepted additions become items and obligations before discharge, within B3. A rejected addition keeps its reason in the recipe's `limits`. R3's `not_checked` is recorded as a limit. Every path an R2 or R3 answer names that no item covers goes into the delegation's `discovered` and needs a census disposition before close ([protocol.md](protocol.md) §5, Discovery handoff).

## 6. When `all-enumerated` is justified

Claim `coverage: all-enumerated` only when **all** of these hold:
1. **Complete discovery:** `snapshot.discovery_complete` is true. `check` refuses the claim otherwise.
2. **A closed population source:**
   - either an explicit registry (a route table, a migration directory, an enum, a scheduler registry);
   - or a set of searches whose recorded `limits` name nothing that could add a member.
3. **Every member is accounted for:** every member is cited or named by an item, and every chain ends at a mechanism, with none at `unknown`. `check` refuses the claim while an `unknown` item names the obligation or names none, or an `excluded` item names it (C13).
4. **No hidden members:** dynamic dispatch, computed names and writers outside the repositories are ruled out with evidence, not by absence.
5. **R3 found no missing member,** or its additions were included.

Otherwise use:
- `named-subset`, listing the members covered in `coverage_method`;
- `sample`, stating the method;
- `excluded`, with the reason.

Only `held` plus `all-enumerated`, on verified evidence after an equal close recheck, is reported as "Verified" (C13).

## 7. Bounded stopping

- **Discovery budget:** discovery, census included, never uses the 30% reserve for verification and close (B2).
- **Out of budget:** when the census cannot finish before discharge must start, what is left becomes `unknown` items and `frontier` or `budget` debt, and the affected obligations keep a partial `coverage`.
- **A chain stops** at an activation mechanism, at a boundary contract, or at `unknown`. Never stop at "no more hits".
- **At most 50 recipes** per run (records@1). Spend them on the paths that bear on obligations.
- **Unknowns:** one search per unresolved hop. Then record `unknown`, rather than repeating variants of a failed search.
