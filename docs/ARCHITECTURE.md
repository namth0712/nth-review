# nth-review architecture

This document owns how nth-review's parts fit together and where each one runs. The procedures are in [INSTALL.md](../INSTALL.md), and the review method is in [SKILL.md](../SKILL.md) and [reference/](../reference/).

## Components

| Component | Where it lives | What it does |
|---|---|---|
| Package | `<config>/plugins/cache/nth-review/nth-review/<version>/`, copied by Claude Code's plugin manager | Holds the runtime files, `INSTALL.md`, `runtime-manifest.json` and the plugin skill. Installing it changes no project |
| Plugin skill `/nth-review:project` | `plugin-skills/project/SKILL.md` in the package; offered only while the plugin is enabled | Manual only (`disable-model-invocation: true`). Points Claude at `INSTALL.md` to Enable, Update or Disable the current project. Never reviews |
| Review skill `/nth-review` | the 27 runtime files, copied into `<P>/.claude/skills/nth-review/` by Enable | Manual only. Runs a review in that project |
| Helper `nthr.mjs` | `scripts/nthr.mjs` and `scripts/lib/*.mjs` in the copy; plain Node.js, no dependencies | Everything deterministic: snapshots, packs, records, `check`, `close`, freshness, reports, `status`, `decide` |
| State file | `<P>/.claude/nth-dev-kit-hooks/review.state.json` | Records which installed files nth-review owns, by sha256 ([INSTALL.md, Runtime files and ownership](../INSTALL.md#runtime-files-and-ownership)) |
| Review records | `<P>/.nth-review/` | One folder per run: `records.json`, packs and `report.md`; plus decisions and debt per namespace |

The folder name `nth-dev-kit-hooks` is historical, from nth-review's time inside the nth-dev-kit project. It is kept so existing projects stay readable, and it holds provenance only.

## Why the review skill is copied into each project

The plugin's own skill list deliberately excludes the review skill (`"skills": ["./plugin-skills/"]` in `.claude-plugin/plugin.json`). Copying the runtime into the project instead gives:
- **activation per project:** a project is enabled only by its own Enable, and enabling one never enables another;
- **byte-exact ownership:** every copied file is recorded by hash, so Update and Disable never touch a file you changed;
- **a stable review environment:** a review session reads its skill from the project itself, which is also what the benchmark sessions' isolation relies on.

## A review, end to end

1. You type `/nth-review task …` (or `incremental`, or `flow`) in a session in `<P>`.
2. The lead (the session's model) follows `SKILL.md`. It calls the helper for every deterministic step: open the run, take a snapshot, build packs, record the census, obligations and findings through patches, check and close.
3. It delegates plan critique to the built-in `Explore`, and refutation to `nth-review:reviewer`, the read-only agent the plugin bundles (records name it `reviewer`), both read-only ([reference/routing.md](../reference/routing.md)). That agent exists only while the plugin is enabled, so the skill's preflight stops a review without it. Claude Code names plugin agents `<plugin>:<agent>` and resolves `nth-review:reviewer` only to the bundled file; a bare `reviewer` never resolves to it. An agent named `reviewer` that the user, the project or another kit defines is therefore a separate agent, which nth-review never calls and never changes (tested: [DEVELOPMENT.md](DEVELOPMENT.md#plugin-probe)).
4. `close` writes `report.md` and the final status. `status` and `decide` work on the records afterwards.

## Trust boundaries

- **No automatic execution:** both skills are manual only. The package's one agent, `nth-review:reviewer`, is read-only, and its description restricts it to nth-review's delegations. The package has no hooks, commands, monitors or MCP servers, and installing or enabling the plugin starts nothing.
- **Writes:** a review writes only under `<P>/.nth-review/`, through the helper's guarded paths, which refuse symbolic links and junctions (`scripts/lib/fsguard.mjs`). The lifecycle writes only the paths in [INSTALL.md](../INSTALL.md#runtime-files-and-ownership).
- **Git is read-only:** the helper never stages, commits or rewrites history.
- **Official Full Audit** is disabled in the helper (`OFFICIAL_AUDITS_ENABLED = false`).

## Identity and versions

- `version` in `.claude-plugin/plugin.json` equals the helper's `VERSION` (`scripts/lib/schema.mjs`). The record format is `nth-review/records@1`.
- `runtime-manifest.json` lists the sha256 of `INSTALL.md` and of each runtime file. Enable verifies the installed package against it.
- The state file's `library` digest identifies the exact runtime content of a project's copy. For `1.0.0-rc.2` it is `01814ebfc36f92f1d43578a6ebb65736d3d2cd3f78d941f789ffab388681f5cb`. The `1.0.0-rc.1` runtime's was `b6f87897821f5cf8b1d265f935a9ceea3ddf427854e50a270de74ea5b257a32d`, which does not identify the rc.2 files.
- The bundled agent `plugin-agents/reviewer.md` is not part of a project's copy. It is identified by the plugin version and its own sha256, `912eddae1f78fe808613dde430d87ba736efd247aa236a7665a51cb7af7f0aaf`, pinned in `tests/package.test.mjs`.

## Platforms

The runtime uses only Node.js built-ins and read-only Git, and builds every path with Node's `path` module, so the same files run on macOS, Linux and Windows. It never reads `HOME`, the temporary folder or `CLAUDE_CONFIG_DIR`; the lifecycle resolves `<config>` itself. Platform notes and the verification status are in [DEVELOPMENT.md](DEVELOPMENT.md#platforms).
