# nth-review

Manual, evidence-based code review for [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). In a project where you enable it, you type `/nth-review` and it reviews a change against the project's documented intent. Each run builds a census of the change, sets obligations (what the change must keep true), backs every conclusion with evidence, and sends each candidate defect to an independent refuter. It records the whole run under the project's `.nth-review/`.

- **Task Review:** one change, a commit range or the working tree.
- **Incremental Review:** what changed since an earlier review.
- **Flow Review (Beta):** what the current source does from explicit entry points.

**Status: release candidate `1.0.0-rc.2`, not Stable.** Task and Incremental Review await their release gate, Flow Review is Beta, and official Full Audit is disabled. Every result needs your own judgement; see [docs/USAGE.md](docs/USAGE.md#status).

## Quick start

Requirements: Claude Code, Node.js 20 or later and Git 2.31 or later. Nothing else: the read-only agent the review delegates to comes with the plugin ([details](docs/USAGE.md#prerequisite-the-reviewer-agent)).

1. **Install the plugin.** In Claude Code:

       /plugin marketplace add namth0712/nth-review
       /plugin install nth-review@nth-review

   Or from a terminal: `claude plugin marketplace add namth0712/nth-review`, then `claude plugin install nth-review@nth-review`. It installs **disabled**, and nothing runs. The terminal commands have been tested with a local checkout as the source; the GitHub source and the `/plugin` forms are not yet tested ([INSTALL.md](INSTALL.md#package-install-update-uninstall)).
2. **Enable the plugin:** `claude plugin enable nth-review@nth-review` in a terminal, or enable it in the `/plugin` menu. This offers one manual command, `/nth-review:project`, and the read-only agent `nth-review:reviewer` that reviews delegate refutation to, and nothing else. Keep the plugin enabled while you review. To offer them in chosen projects only, run `claude plugin enable nth-review@nth-review --scope local` in each of those projects instead.
3. **Enable nth-review in a project.** In a Claude Code session started in that project's root: `/nth-review:project enable`. This copies the review skill into that project only.
4. **Review.** Start a new session in the project, then type, for example:

       /nth-review task --ns reviews/login --slug first --change .:main..HEAD

To update: `claude plugin update nth-review@nth-review`, then `/nth-review:project update` in each enabled project. To remove: `/nth-review:project disable` in each enabled project, then `claude plugin uninstall nth-review@nth-review`. Your `.nth-review/` records are always kept.

## Documentation

| Read | For |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | Running a review, the commands, reading the report, known limitations |
| [INSTALL.md](INSTALL.md) | Install, enable, update, disable and uninstall, in detail, and the files nth-review owns |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the plugin, the skill, the helper and the records fit together |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Tests, platforms, releases, and the historical records |
| [CHANGELOG.md](CHANGELOG.md) | Changes by version |

## Safety

- **Nothing runs on its own.** Both skills are manual only, and there are no hooks or background processes. The bundled agent `nth-review:reviewer` is read-only, and its description restricts it to nth-review's own delegations.
- **What a review writes:** only the project's `.nth-review/`. It never edits your code, and it uses Git read-only.
- **What Enable, Update and Disable write:** only `.claude/skills/nth-review/` and one state file. They never overwrite a file you changed.

## License

MIT, see [LICENSE](LICENSE). Text adapted from another project keeps its own MIT notice: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
