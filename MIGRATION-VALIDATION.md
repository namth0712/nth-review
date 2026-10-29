# Repository move: migration validation (2026-10-29)

> **Redacted for publication (2026-10-29):** private project names and workstation paths are replaced by placeholders ("private project A", "private project B", `<work>`, `<config>`). No result, number or verdict changed. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#private-evidence-and-the-public-repository).

nth-review left nth-dev-kit (`agents/claude/integrations/review/` and the runbook `agents/claude/integrations/review.md`) for this standalone repository. This file records the move and the checks that validated it. It is separate from the historical evidence in [VALIDATION.md](VALIDATION.md), which is unchanged.
- **Unchanged by the move:** the review engine, the records format and the release state. G5 stays FAIL (historical), official Full Audit stays disabled, gate @3 stays frozen, and nothing is registered.
- **No paid model call,** no real Global Update or Project Update, and no change to an active Claude Code configuration or installed plugin. No Git command changed a repository: the Git checks ran in disposable copies.

## 1. What moved

| From (nth-dev-kit) | To (this repository) | How |
|---|---|---|
| `agents/claude/integrations/review/**` (260 files) | the same relative paths at the root | byte-identical: each of the 260 files hashed before and after the copy |
| `agents/claude/integrations/review.md` | `INSTALL.md` | rewritten for the package model (below) |

**New files:**
- `README.md` and `MIGRATION-VALIDATION.md`;
- `.gitattributes` (`* -text`, so Git never converts a byte);
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, the package;
- `runtime-manifest.json`, the LF sha256 of `INSTALL.md` and of the 27 runtime files;
- `tests/package.test.mjs`, `tests/tools/runtime-manifest.mjs`, `tests/tools/plugin-probe.mjs` and `tests/tools/kit-check.mjs`.

**Byte-identical** (sha256 before and after the copy):
- the 27 runtime files, so the skill and its `library` digest are unchanged;
- the sealed G5 evidence (ledger, answers, adjudications, reports, history, criteria, manifest);
- the frozen gates @1, @2 and @3;
- `VALIDATION.md` (only a pointer line is appended, at its end);
- every historical document.

**Changed for the new layout:**
- the tests and tools that named the old paths:
  - `tests/helpers/library.mjs`, `tests/m4/operator.mjs` and `tests/m4/rehearse.mjs`;
  - `tests/fixtures/build.mjs`;
  - `tests/tools/matrix.mjs`, `evidence.mjs`, `release-gate.mjs` and `transcript-metrics.mjs`;
  - `tests/integration.test.mjs`, `content.test.mjs`, `evidence.test.mjs` and `matrix.test.mjs`;
- `RELEASE.md`: its links, installation compatibility, freeze, upgrade and rollback.

## 2. The package and the lifecycle

- **The package is this repository as a Claude Code plugin with no components.** `plugin.json` sets `"skills": []` and `"defaultEnabled": false`.
  - A `SKILL.md` at a plugin's root is otherwise loaded as a plugin skill. A probe showed this, so `"skills": []` is required.
  - The repository has no commands, agents, hooks, monitors or servers.
  - Installing it with `claude plugin install` adds nothing to any session and changes no project.
- **Project activation is the existing project-copy Enable, Update and Disable** ([INSTALL.md](INSTALL.md)), unchanged except where the files come from. Enable step 4 now reads the package the plugin manager installed:
  - `<config>/plugins/installed_plugins.json` must name exactly one install path, inside `<config>/plugins/cache/`;
  - `runtime-manifest.json` there is verified;
  - Enable never falls back to a source checkout.
- **Why not activation through the native plugin:**
  - Claude Code's per-project plugin enable writes `.claude/settings.local.json`, a user-owned file the engine would count.
  - The skill would run from the configuration's cache, outside a project. A benchmark session's guard allows only its row folder, and the registered `skill_sha256` is the fixture's `.claude/skills/nth-review`.
  - The project copy keeps the engine, the records and the benchmark tooling unchanged.
- **Legacy projects** enabled from nth-dev-kit's library keep working. Their state has the same format, and their `library` digest equals the package's for the same runtime files. Nothing migrates them automatically.

## 3. Path compatibility for frozen and historical documents

The frozen gates and the historical logs keep the paths of their time. Read them with this mapping:

| Written as | Now |
|---|---|
| `agents/claude/integrations/review/<path>`, or commands run "from the kit root" with that prefix | `<path>` in this repository, run from its root |
| `review.md`: the lifecycle document (gate @1 A6, M4 sections, VALIDATION.md) | `INSTALL.md` |
| "the kit" as the repository holding nth-review's source, tests and answers (gates @2 and @3: "outside the kit", "never into the kit") | this repository |
| `<kit>/agents/claude/integrations/review/…` labels in `tests/fixtures/g5-evidence-m5t4.json` | the same path in this repository; `productPathOfLabel` in `tests/tools/evidence.mjs` maps them, and A4 checks through it |
| the receipted library `<config>/nth-dev-kit/` as Enable's source | the installed package `<config>/plugins/cache/nth-review/nth-review/<version>/` |

**What the evaluator now does differently:**
- **Gate @1 A6** says "the files `review.md` lists". The evaluator reads `INSTALL.md`, and also requires `runtime-manifest.json` to list exactly the runtime files and `INSTALL.md`, at their digests. That is stricter, not looser.
- **The isolation deny rules** still cover:
  - the folder that holds the development checkouts: `<work>`, three levels above this repository, as it was two levels above the nth-dev-kit checkout;
  - the plugin cache and marketplace copy of this package, which hold `tests/` and the sealed answers. This is new.

  They never deny a filesystem root, or a folder that holds the temporary or the home folder, on any layout.
- **The sealed manifest** and the historical ledger are untouched. A4 maps their old labels instead of rewriting them.

## 4. Release identity

- **The candidate stays `1.0.0-rc.1`:** every runtime file is byte-identical, so the helper version, the skill digest and the `library` digest are the same.
- **The implementation manifest is new.** Its paths moved, and it gains `INSTALL.md`, `runtime-manifest.json` and `.claude-plugin/`. Nothing was registered under any gate, so a future registration simply starts from this repository's first commit.
- **Part A must be re-run on this repository:** A1–A3 because the tooling changed, and A4–A7 and A11 because the paths changed. Results are in §5.
- **What stays valid:**
  - G5 = FAIL (ledger seq 97);
  - the M5-T4 evidence, fixtures and sealed answers;
  - the five real-project runs (their records are read as they are);
  - the M0, VS1 and M4-T3 observations of the skill's loading, since the skill files are the same.
- **The next runtime change** makes a new candidate, `1.0.0-rc.2`.
- **Not Stable:** the move does not make nth-review Stable. Part B, the review-quality evidence, has still not run.

## 5. Validation results

All on 2026-10-29, Windows 11 Pro 10.0.26200 and WSL Ubuntu 24.04. Before the move, the suite in nth-dev-kit was 469 tests. It is now 472: the nth-dev-kit wiring test moved to `tests/tools/kit-check.mjs` (−1), `tests/package.test.mjs` adds 3, and a guard test for the development parent adds 1.

| Check | Result |
|---|---|
| Full suite, Windows, Git Bash and PowerShell (Node.js 22.22.3) | 472 tests, 467 pass, 0 fail, 5 platform skips, in each |
| Full suite, Linux (Node.js 20.20.2 and 22.23.4) | 472 tests, 465 pass, 0 fail, 7 platform skips, on each |
| Release gate @3, Part A (`release-gate.mjs offline`, gate file as pinned) | **A1–A11 PASS**. A4: 97 events, ledger as recorded, 90/90 manifest evidence files byte-identical through the label mapping. A5: every fixture rebuilt twice with its sealed heads and identical trees, installed from the package. A6: 27 runtime files, `INSTALL.md` states 27, `runtime-manifest.json` current |
| Lifecycle rehearsal (`tests/m4/rehearse.mjs`, Windows) | 84 rows: 81 pass, 0 fail, 3 unverified (Unicode normalization and two symbolic-link rows, as before) |
| Package probe (`tests/tools/plugin-probe.mjs`): the real Claude Code 2.1.312, offline, no login, a throwaway configuration with a space in its path | 14/14, listed below |
| Byte integrity | All 260 module files copied identical. The 93 sealed evidence files, gates @1 (`cd9e067c…`), @2 (`b92fb9da…`) and @3 (`031e85e5…`), and the 27 runtime files are unchanged against the pre-move hashes. Of the module's other files, 17 changed, all tests, tools or docs |
| Git round trip, in a disposable copy | `git init`, add and commit all 271 files, then a clone with `core.autocrlf=true`: 0 files differ, the work tree is clean, and `matrix.mjs implementation` reports `frozen: true` with 130 material files |
| nth-dev-kit (`kit-check.mjs --kit … --self-test`) | PASS, with 8/8 deliberate breaks caught. nth-status, session-title and task-progress: 0 changed lines |

**Package probe rows:**
- **P1 to P3:** `validate` passes. `install` leaves the package installed at user scope and disabled. `details` lists no skill, agent, hook, MCP server or LSP server.
- **P4 and P5:** installing changes no project, and installing again changes nothing.
- **P6 and P7:** Enable reads the package the plugin manager installed (27 runtime files, inside its cache) and enables project A. Project B stays byte-identical, and the plugin stays disabled.
- **P8 and P9:** an independent package update (a new version with a changed runtime file), then Update in A, installs the change. Update again changes nothing.
- **P10:** a rollback to the earlier release, then Update, restores the earlier file.
- **P11 and P12:** Disable restores project A exactly and keeps `.nth-review/`. Uninstall leaves both projects unchanged.
- **P13:** `enabledPlugins` is never `true`, and no project settings file is written.
- **P14:** the machine's own Claude Code configuration files are unchanged (their modification times).

**Required checks, and the evidence for each:**

| Required | Evidence |
|---|---|
| 1. Standalone installation | probe P1–P3, P12; nothing from nth-dev-kit is read |
| 2. nth-dev-kit automatic installation | The Package step's commands: probe P2, P5, P8. Its decision rules: the pointer and prompts, checked by kit-check. A real Global Install or Global Update was not run (§7) |
| 3. Inactive immediately after install | probe P2–P4, P13; rehearsal row 15 |
| 4. Explicit enable in one project | probe P7; rehearsal rows 1 and 15 |
| 5. Another project stays inactive | probe P4, P7; rehearsal row 15 |
| 6. Manual review invocation only | `disable-model-invocation: true` (content test, A7). The runtime is byte-identical to the one M0-T1 and M4-T3 observed; a session was not re-run |
| 7. Repeated install and update | probe P5, P9; rehearsal rows 1 and 2 |
| 8. Independent version updates | probe P8, P10 |
| 9. Project enable, disable and update | rehearsal rows 1–13; probe P7–P11 |
| 10. Safe uninstall and rollback | probe P10–P12; Disable needs no package (INSTALL.md) |
| 11. Existing review records | The runtime and records format are unchanged, and the record, resume, freshness and Flow tests pass. Rehearsal row 16: a project enabled from nth-dev-kit's library is read as is. `.nth-review/` is preserved in every row |
| 12. Freshness and evidence integrity | A4, A8, A9; sealed evidence 93/93 |
| 13. Full runtime regression suite | the suite rows above |
| 14. Frozen benchmark evidence | A4, A5; the three gate hashes |
| 15. No unrelated configuration or Git mutation | probe P14. Rehearsal snapshots include `.git`. No Git command wrote to nth-dev-kit, and this repository is not initialized |
| 16. A custom `CLAUDE_CONFIG_DIR` | the probe's configuration folder has a space in its path; rehearsal row 17 |

## 6. nth-dev-kit after the move

- **Removed:** `agents/claude/integrations/review/`, after this repository passed the checks above.
- **Replaced:** `agents/claude/integrations/review.md` is now the external-package pointer:
  - the pin: version `1.0.0-rc.1`, and runtime digest `b6f87897821f5cf8b1d265f935a9ceea3ddf427854e50a270de74ea5b257a32d` (the `library` digest of the 27 runtime files);
  - the **Package step**, which installs the package inactive only when it is absent and not opted out, updates it only when the kit installed it and still manages it, and never enables it, never touches an independently managed installation, never inspects projects and never runs a review.
- **Updated:**
  - `prompts/claude/global/install.md` and `update.md`: they run the Package step;
  - `docs/lifecycle.md`: the generic external-package rule, and step 6 of Global Install and Global Update;
  - `README.md` and `agents/claude/README.md`.
- **Unchanged:** nth-status, session-title, task-progress, the project prompts, `INSTALL.md`, `docs/ownership.md` and the Codex adapter.
- **Checked by `node tests/tools/kit-check.mjs --kit <nth-dev-kit> --self-test`:**
  - no engine file and no copy of a runtime file in the kit;
  - `nth-review` named only in the pointer, the two Global prompts and the two READMEs;
  - the pin equals this repository's version and runtime digest;
  - the never-enable rules are present;
  - eight deliberate breaks are each caught.

## 7. Not verified

- **macOS.**
- **A real Global Install or Global Update** running the Package step: the step is a runbook Claude follows, and running it would change the active configuration. Its commands were verified one by one in a throwaway configuration (§5).
- **The skill invoked in a real session** from a project enabled through the package. That needs a session. The skill files are byte-identical to those M4-T3 observed, so the observation carries over, but it was not repeated.
- **A Git-hosted marketplace** (`<owner>/<repo>#tag`). Only the local-directory source was exercised, because no remote exists yet.
- **`installed_plugins.json`** is an undocumented Claude Code file. Enable reads only its `installPath`, and a change to its format would stop Enable safely. Re-probe after Claude Code updates.
