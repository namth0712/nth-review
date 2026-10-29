# Changelog

All notable changes to nth-review. Versions follow the plugin's `version` (`.claude-plugin/plugin.json`), which equals the helper's `VERSION`.

## 1.0.0-rc.2 (2026-10-29)

Second release candidate. **Not Stable**, as for rc.1. The runtime changed, so this is a new candidate ([RELEASE.md §11](RELEASE.md#11-candidate-100-rc2)).

- **Bundled agent:** the plugin now ships the read-only agent `nth-review:reviewer` (`plugin-agents/reviewer.md`, sha256 `912eddae1f78fe808613dde430d87ba736efd247aa236a7665a51cb7af7f0aaf`). It has the same model (Sonnet by default), tools, 12-turn limit and instructions as the `reviewer` agent nth-review was developed with; only its description changed, to restrict it to nth-review's delegations.
- **No external agent needed:** a fresh installation no longer needs an agent named `reviewer`. Refutation (R5, R6, and R4 in Full Audit) delegates to `nth-review:reviewer`; an agent of your own named `reviewer` is never used.
- **Preflight:** a review stops before opening a run when `nth-review:reviewer` is unavailable, which happens when the plugin is disabled.
- **Records:** `nth-review/records@1` is unchanged. A delegation to the bundled agent is still recorded as `agent: "reviewer"`, and rc.1 runs still validate.
- **Runtime:** `SKILL.md`, `reference/prompts.md`, `reference/routing.md` and `reference/records.md` name the bundled agent, and `scripts/lib/schema.mjs` carries the new version. The `library` digest is now `01814ebfc36f92f1d43578a6ebb65736d3d2cd3f78d941f789ffab388681f5cb`; rc.1's `b6f87897…` does not identify these files. Projects enabled with rc.1 keep their copy until `/nth-review:project update`.

## 1.0.0-rc.1 (2026-10-29)

First release candidate for v1.0, published as a standalone Claude Code plugin. **Not Stable:** Task Review and Incremental Review are release-candidate functionality, Flow Review is Beta, and official Full Audit is disabled ([docs/USAGE.md](docs/USAGE.md#status)).

- **Packaging:**
  - a Claude Code plugin and its own marketplace (`namth0712/nth-review`), installed disabled;
  - one manual plugin skill, `/nth-review:project enable | update | disable`, which enables nth-review in one project at a time;
  - the review skill `/nth-review` runs only when typed.
- **License:** MIT. Adapted upstream text keeps its own MIT notice (THIRD-PARTY-NOTICES.md).
- **Runtime:** the 27 runtime files of the release candidate, unchanged. Their `library` digest is `b6f87897821f5cf8b1d265f935a9ceea3ddf427854e50a270de74ea5b257a32d`, so projects enabled before this packaging stay valid.
- **Documentation:** a new layout. README, INSTALL (the lifecycle), docs/USAGE, docs/ARCHITECTURE, docs/DEVELOPMENT.
- **Privacy:**
  - sealed benchmark evidence that records the build environment is kept out of the public repository;
  - historical documents are redacted for publication, with the originals preserved privately ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#private-evidence-and-the-public-repository)).
- **History:**
  - before this release, nth-review was developed inside the nth-dev-kit project;
  - its earlier development, validation and the move are recorded in [VALIDATION.md](VALIDATION.md) and [MIGRATION-VALIDATION.md](MIGRATION-VALIDATION.md).
