# Developing nth-review

This document owns how to work on this repository: its layout, its checks, the files that must never change, what stays private, and how a release is made. Commands run from the repository root, on Node.js 20 or later.

## Layout

| Path | What it is |
|---|---|
| `SKILL.md`, `THIRD-PARTY-NOTICES.md`, `reference/`, `scripts/` | **The runtime:** the 27 files Enable copies into a project. Frozen for a release candidate |
| `plugin-skills/project/SKILL.md` | The plugin's only skill, `/nth-review:project` |
| `plugin-agents/reviewer.md` | The plugin's only agent, `nth-review:reviewer`, the read-only refuter reviews delegate to. Pinned by sha256 in `tests/package.test.mjs` |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | The plugin and its marketplace (this repository is its own marketplace) |
| `runtime-manifest.json` | sha256 of `INSTALL.md` and of each runtime file, generated |
| `INSTALL.md`, `README.md`, `docs/`, `CHANGELOG.md`, `LICENSE` | Public documentation |
| `tests/` | The test suite, the lifecycle rehearsal, synthetic fixtures with their sealed answers, the benchmark runner and the release-gate evaluator |
| `RELEASE.md`, `VALIDATION.md`, `MIGRATION-VALIDATION.md` | Historical records (see [History and records](#history-and-records)) |

## Checks

| Check | Command | Notes |
|---|---|---|
| Test suite | `node tests/run.mjs` | Every platform. It lists the test files itself (Node.js 20 takes no glob; `node --test <dir>/` fails on Node.js 21+). Writes only under the system temporary folder |
| Lifecycle rehearsal | `node tests/m4/rehearse.mjs` | Runs `tests/m4/operator.mjs`, the literal transcription of INSTALL.md's Enable, Update and Disable, through every scenario, including a crash before every write, in throwaway projects and configurations. Prints one row per scenario. Designed and verified on Windows |
| Plugin probe | `node tests/tools/plugin-probe.mjs` | See [Plugin probe](#plugin-probe) |
| Release gate, Part A | `node tests/tools/release-gate.mjs offline --tap <label>=<tap file> … --rehearsal <rehearsal output>` | A1–A11 of the frozen gate, from saved suite output (`node tests/run.mjs > tap.txt`) |
| Runtime manifest | `node tests/tools/runtime-manifest.mjs --check` (or `--write`) | Regenerate after changing `INSTALL.md` or a runtime file; the tests fail while it is stale |
| Public artifact | `node tests/tools/public-check.mjs` | See [Private evidence and the public repository](#private-evidence-and-the-public-repository) |

None of these calls a model or costs anything. The benchmark runner (`tests/tools/matrix.mjs`) starts paid sessions only when its owner registers and drives a matrix, and it refuses to run anywhere but Windows.

### Plugin probe

`node tests/tools/plugin-probe.mjs [--keep] [--json <file>] [--general-agent <file>]` drives the real `claude plugin` commands against a disposable copy of this repository, in a throwaway `CLAUDE_CONFIG_DIR` whose path contains a space. It runs:
- install, then check the plugin is disabled with the one manual skill and the declared agent;
- enable the plugin, then project Enable in one project with a second project left untouched, and check that the project copy's helper runs;
- add a user agent named `reviewer`, and check it coexists with `nth-review:reviewer`;
- an independent package update and a rollback, each followed by project Update;
- project Disable, then disable and uninstall the plugin;
- in a second configuration that already has a general user-level agent named `reviewer` (another kit installs its own that way), with a project that defines its own `reviewer`: enable the plugin for one project only (`--scope local`), check what each project offers and which agent each name resolves to, run Enable, Update and Disable, then update, disable and uninstall the plugin, and check that the other agents' files never change. `--general-agent <file>` uses that file as the general agent, for example another kit's own `reviewer`; the probe only reads it.

It also asks a headless session for its skill and agent inventory at each stage: no `nth-review:reviewer` (and no `reviewer`) while the plugin is disabled, and `nth-review:reviewer` in every project once it is enabled. `claude plugin details` does not count an agent declared by path, so the probe records that count without checking it. That session uses an **unauthenticated** configuration, a clean environment and an unreachable API address, so it stops at "Not logged in" before any model call. The probe fails if any session reports a cost.

**Agent resolution.** A file and an inventory entry do not show that a delegation works, so the probe also starts delegating sessions against a local stand-in for the Messages API: an HTTP server on 127.0.0.1, reached with a dummy key, that answers every request itself. Its scripted lead asks the Agent tool for one subagent type, and the subagent's own request shows which agent Claude Code resolved: its instructions, model and tools. Observed with Claude Code 2.1.312:
- `nth-review:reviewer` launches the bundled agent, with or without another `reviewer`;
- a bare `reviewer` is refused as not found when only nth-review is installed, and otherwise launches the user's or the project's own agent, never the bundled one;
- where the plugin is not enabled, `nth-review:reviewer` is refused as not found.

No request leaves the machine, and the probe fails unless every such session reports a cost of 0. This shows resolution, not how a real model reviews.

Needs `claude` on the `PATH` as an executable (the native installer); an npm `claude.cmd` shim on Windows cannot be spawned without a shell.

## Never change

- **The 27 runtime files and the bundled agent** within a release candidate. A change to either is a new candidate (the next `rc`) with a new `runtime-manifest.json`; a change to the agent also updates its pinned sha256 in `tests/package.test.mjs`.
- **The frozen release gates:** `tests/RELEASE-GATE.md` (@1), `tests/RELEASE-GATE-2.md` (@2) and `tests/RELEASE-GATE-3.md` (@3). Their sha256 values are pinned in `tests/tools/gate-version.mjs`, and a test fails if a file changes. A change is a new gate version.
- **The sealed G5 evidence:** `tests/fixtures/g5-ledger.jsonl`, `tests/fixtures/g5-evidence-m5t4.json`, `tests/fixtures/g5-criteria/`, the sealed `answers.json` files, and every fixture's `adjudications/`, `reports/` and `history/`.

## Private evidence and the public repository

Part of the sealed G5 evidence records the environment it was produced in: session identifiers, and configuration paths that include the owner's account name. It can never be edited, so it is kept out of the public repository instead. The originals stay byte-identical in the owner's private working copy.

**Not published** (listed in `.gitignore`):
- `tests/fixtures/g5-ledger.jsonl`, `tests/fixtures/g5-evidence-m5t4.json` and `tests/fixtures/g5-criteria/`;
- every fixture's `adjudications/`, `reports/` and `history/` folders, including any a future benchmark run writes;
- `tests/tools/private.json` (the owner's private terms for the privacy scan);
- `private/`, the exact originals of the historical documents redacted for publication.

**Published:** everything else, including the synthetic fixtures (`tests/fixtures/*/tree/`) and their sealed `answers.json` files. These are synthetic and must stay byte-identical.

**In a copy without the private evidence:**
- release-gate check A4 reports **UNVERIFIED** ("the sealed G5 evidence is not present in this copy"), not PASS;
- the tests that compare the sealed evidence byte for byte skip, saying why;
- a copy that holds part of the evidence fails, rather than skipping.

**`node tests/tools/public-check.mjs`** lists the files that would be published (every file outside the private paths above) and checks:
- that `.gitignore` names exactly the private paths above;
- that the top-level entries are the expected ones, so a local folder is never published by accident;
- every published file for account paths, e-mail addresses outside example domains, session identifiers (synthetic ones such as `11111111-1111-4111-8111-111111111111` are allowed) and credentials;
- every published file for the private terms in `tests/tools/private.json`, when that file is present (it says so when it is not);
- that `LICENSE` is present and `runtime-manifest.json` is current.

Run it before every publish, in the working copy you publish from.

**Redaction:** on 2026-10-29, `VALIDATION.md`, `RELEASE.md`, `MIGRATION-VALIDATION.md` and `tests/G5-REPEAT-PLAN.md` were redacted for publication, and a note at the top of each says so. Private project names became "private project A" and "private project B", workstation paths became `<work>` and `<config>`, and one session identifier was withheld. The exact originals are in `private/originals/`, with their sha256 values in `private/originals/SHA256SUMS`. No result, number or verdict changed.

## Platforms

| Platform | Status |
|---|---|
| Windows 11, Claude Code native installer, Node.js 22 | Suite, rehearsal and plugin probe pass |
| Linux (Ubuntu 24.04 under WSL), Node.js 20 and 22 | Suite passes |
| macOS | **Unverified:** no Mac was available. The runtime is plain Node.js with read-only Git, and the suite's POSIX paths run on Linux |

Platform notes:
- **Git 2.31 or later** is required (`git rev-parse --path-format`). It is not met by Ubuntu 20.04 (2.25) or Debian 11 (2.30). On macOS, install the Xcode Command Line Tools or Git from Homebrew.
- **Paths:** the runtime builds paths with Node's `path` module and compares them through real paths. It treats Windows and macOS file systems as case-insensitive, refuses symbolic links and junctions in its write paths, and accepts paths with spaces.
- **Line endings:** `.gitattributes` sets `* -text`, so Git never converts a byte, even with `core.autocrlf=true`. Manifest digests are taken over LF content, and Enable writes LF bytes.
- **Shells:** every documented command is a plain `node …` or `claude …` invocation, the same in bash, zsh, PowerShell and Command Prompt. No Git Bash is needed.
- **Windows-only tooling:** the benchmark runner (`tests/tools/matrix.mjs`) and the lifecycle rehearsal's junction rows. Symbolic-link rows need privileges the test machine lacks, so they are recorded as unverified.

## Releasing

1. A runtime or agent change makes a new candidate: bump `VERSION` in `scripts/lib/schema.mjs` and `version` in `.claude-plugin/plugin.json` together (a test requires them equal). Then run `node tests/tools/runtime-manifest.mjs --write`.
2. Run the checks above on Windows and Linux. Record the results; the format is in VALIDATION.md and RELEASE.md.
3. Add a `CHANGELOG.md` entry.
4. Tag the release `v<version>`. Users pin it with `/plugin marketplace add namth0712/nth-review#v<version>`.
5. A package change without a version change is not seen by `claude plugin update`. Bump the version for every published change, or tell users to reinstall.

Stable needs the release gate to pass, Part B included ([RELEASE.md](../RELEASE.md)).

## History and records

These documents are historical. They record what was decided and measured, are not instructions, and stay where they are because the frozen gates and tests link them:
- [RELEASE.md](../RELEASE.md): the v1.0 release contract, the readiness audit and the current verdict (**NOT YET STABLE**).
- [VALIDATION.md](../VALIDATION.md): the full validation log, from the first prototype to the release candidate.
- [MIGRATION-VALIDATION.md](../MIGRATION-VALIDATION.md): the move from the nth-dev-kit project into this repository.
- [tests/RELEASE-GATE.md](../tests/RELEASE-GATE.md), [-2](../tests/RELEASE-GATE-2.md), [-3](../tests/RELEASE-GATE-3.md): the frozen release gates.
- [tests/G5-REPEAT-PLAN.md](../tests/G5-REPEAT-PLAN.md), [tests/SECURITY-FIXTURE-SPEC.md](../tests/SECURITY-FIXTURE-SPEC.md), [tests/fixtures/README.md](../tests/fixtures/README.md): the benchmark plan, the security-fixture specification and the fixtures.

Older documents name paths of the time: `agents/claude/integrations/review/<path>` is now `<path>` here, and `review.md` is now `INSTALL.md` ([MIGRATION-VALIDATION.md](../MIGRATION-VALIDATION.md)). `tests/tools/kit-check.mjs` checks the nth-dev-kit project's pointer to this package. It is used only when that project changes, and nothing here depends on it.
