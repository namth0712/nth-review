# nth-review: install and lifecycle

This document owns how nth-review is installed, activated and removed, and how it proves which files it owns. How to run a review is in [docs/USAGE.md](docs/USAGE.md); how the pieces fit together is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

nth-review is a manually invoked code-review skill for Claude Code. Installing it activates nothing. It reviews only in projects where it was enabled, and only when the user types `/nth-review`.

## The four steps

| Step | Command | What it changes |
|---|---|---|
| 1. Install the plugin | `/plugin marketplace add namth0712/nth-review`, then `/plugin install nth-review@nth-review` | `<config>/plugins/` only. The plugin is installed **disabled**; no project changes, and no skill is offered |
| 2. Enable the plugin | `claude plugin enable nth-review@nth-review`, or enable it in the `/plugin` menu; or, for one project only, `claude plugin enable nth-review@nth-review --scope local` in that project | Offers the manual skill `/nth-review:project` and the read-only agent `nth-review:reviewer` that reviews delegate refutation to: in every project, or with `--scope local` in that project only. It never reviews |
| 3. Enable nth-review for a project | in a session started in that project: `/nth-review:project enable` | That project only: `.claude/skills/nth-review/` and its state file ([Enable](#enable)) |
| 4. Invoke a review | in a new session in that project, with the plugin still enabled: `/nth-review task …` | `.nth-review/` in that project only ([docs/USAGE.md](docs/USAGE.md)) |

Steps 3 and 4 are per project. Enabling one project never enables another. Update and Disable work the same way as step 3: `/nth-review:project update`, `/nth-review:project disable`. The plugin skill only points Claude at the procedures below; asking Claude to follow [Enable](#enable), [Update](#update) or [Disable](#disable) in this document does the same.

## Package: install, update, uninstall

The package is this repository, published as a Claude Code plugin and as its own marketplace (`.claude-plugin/marketplace.json`). It ships two components: the manual skill `/nth-review:project`, from `plugin-skills/`, and the read-only agent `nth-review:reviewer`, from `plugin-agents/reviewer.md`, which the review skill delegates refutation to. Its `.claude-plugin/plugin.json` sets `"skills": ["./plugin-skills/"]`, so the review skill's own `SKILL.md` at the repository root is never loaded as a plugin skill, `"agents": ["./plugin-agents/reviewer.md"]` and `"defaultEnabled": false`. The repository has no hooks, commands, monitors or servers.

`<config>` is `CLAUDE_CONFIG_DIR` when set, otherwise Claude Code's default configuration folder (`~/.claude` on macOS and Linux, `%USERPROFILE%\.claude` on Windows). Every step below changes that configuration only.

- **Install**, once per configuration. In a Claude Code session:

      /plugin marketplace add namth0712/nth-review
      /plugin install nth-review@nth-review

  The same from a terminal, on macOS, Linux or Windows:

      claude plugin marketplace add namth0712/nth-review
      claude plugin install nth-review@nth-review

  To pin a release, add it to the source: `namth0712/nth-review#v1.0.0-rc.2`. A local checkout also works as the source (`claude plugin marketplace add <path-to-checkout>`). The plugin manager copies the package to `<config>/plugins/cache/nth-review/nth-review/<version>/` and records it in `<config>/plugins/installed_plugins.json`. It reports the plugin as disabled.
- **Enable the plugin:** `claude plugin enable nth-review@nth-review`, or enable it in the `/plugin` menu. This offers `/nth-review:project` and the agent `nth-review:reviewer`, and nothing else. User scope, the default, offers them in every project. To offer them in chosen projects only, enable the plugin in each of those projects instead: `claude plugin enable nth-review@nth-review --scope local`, run in the project (and `claude plugin disable nth-review@nth-review --scope local` there to stop). Claude Code records that in the project's own `.claude/settings.local.json`, which nth-review does not manage; other projects see neither the command nor the agent. Both scopes were tested.
- **Update:** `claude plugin marketplace update nth-review`, then `claude plugin update nth-review@nth-review`. Then run **Update** below (`/nth-review:project update`) in each project that has nth-review enabled; until then a project keeps the copy it has.
- **Uninstall:** run **Disable** below (`/nth-review:project disable`) in every enabled project first. Disable itself needs no package, but the plugin skill that starts it does. Then `claude plugin uninstall nth-review@nth-review` and, if nothing else uses it, `claude plugin marketplace remove nth-review`. Projects that were never enabled are untouched.
- **Version:** `version` in `.claude-plugin/plugin.json` equals the helper's version (`node "<P>/.claude/skills/nth-review/scripts/nthr.mjs" version`). The package carries `runtime-manifest.json`: the sha256 of the LF content of `INSTALL.md` and of each runtime file. Enable verifies it, and the [state file](#runtime-files-and-ownership)'s `library` digest is computed from it.
- These commands run only when the user runs them. **Tested:** the terminal forms above, with a local checkout as the marketplace source, offline (no login, no model call), on Claude Code 2.1.312 in a throwaway configuration ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#plugin-probe)). **Not yet tested:** the GitHub source `namth0712/nth-review` and the in-session `/plugin` forms, which perform the same operations.

## States

| State | What exists | Who changes it |
|---|---|---|
| Installed (dormant) | The package under `<config>/plugins/cache/nth-review/nth-review/<version>/`, recorded in `<config>/plugins/installed_plugins.json`; the plugin disabled; no project state | The user's plugin install, update and uninstall |
| Plugin enabled | The same, with the plugin enabled (in every project, or with `--scope local` in chosen projects): `/nth-review:project` and the agent `nth-review:reviewer` are offered there; still no project state | The user's plugin enable and disable |
| Enabled in project `<P>` | `<P>/.claude/nth-dev-kit-hooks/review.state.json`, plus the skill copy it records | Enable, Update, Disable, each only when asked in `<P>` |

The state file's presence is what "enabled" means in `<P>`. Without it, no lifecycle operation writes into `<P>/.claude/skills/nth-review/`. The folder name `nth-dev-kit-hooks` is historical: it dates from nth-review's time inside the nth-dev-kit project, and it is kept so existing projects stay readable. It holds provenance only, never hooks.

A project that is enabled while the plugin is disabled keeps its copy but cannot review: the skill stops at its preflight, because `nth-review:reviewer` comes only with the enabled plugin.

## Behavior

- **Explicit invocation only.** The skill's frontmatter sets `disable-model-invocation: true`. Claude never starts a review on its own; the user types `/nth-review`. The plugin's agent `nth-review:reviewer` is offered wherever the plugin is enabled. Claude Code has no setting that keeps Claude from choosing an available agent on its own: its description, which restricts it to nth-review's delegations, is the only guard inside a project where it is offered. To keep it out of other projects, enable the plugin with `--scope local` in the projects that use nth-review. A permission rule denying `Agent(nth-review:reviewer)` would block it too, and with it the refutation step.
- **What a review writes:** only `<P>/.nth-review/`, through the helper's guarded paths. Symbolic links and junctions are refused. It never edits project source, never stages, commits, pushes or rewrites history, and runs Git read-only.
- **No other effects:**
  - no hooks, settings, permission rules, MCP servers or plugins, and no agents in the project (the only agent is the plugin's `nth-review:reviewer`);
  - no change to coding agents, skills or workflows;
  - nothing runs in the background or on a schedule.

  Its `node` commands can therefore ask for approval.
- **Models:** reviews run on Opus at high effort or on Sonnet, never xhigh. Nothing switches models automatically.
- **Official audits stay disabled:** `OFFICIAL_AUDITS_ENABLED` is `false` in `scripts/nthr.mjs`, and the skill stops on an audit request.

## Prerequisites

- Claude Code with project skills (`<P>/.claude/skills/`) and the `claude plugin` commands.
- Node.js 20 or later; the skill checks `node --version`.
- Git 2.31 or later, used read-only. On macOS, install the Xcode Command Line Tools or Git from Homebrew; the `/usr/bin/git` placeholder alone does not run.
- The nth-review plugin enabled while reviewing: it provides the read-only agent `nth-review:reviewer`, which the skill delegates refutation to; `Explore` is built into Claude Code. No other agent is needed, and an agent of your own named `reviewer` is not used ([docs/USAGE.md](docs/USAGE.md#prerequisite-the-reviewer-agent)).
- The installed package, with a valid manifest ([Package](#package-install-update-uninstall)).

`<P>` is the project root: the directory where the user starts Claude sessions for that project. In a folder that holds several repositories, it is that parent folder. Enable there; do not rely on a copy in a sub-repository being found from the parent.

## Runtime files and ownership

Enable writes only these, all under `<P>/.claude/`:

| Item | Owner proof |
|---|---|
| `<P>/.claude/skills/nth-review/`: the skill's 27 runtime files, as LF bytes:<br>`SKILL.md`, `THIRD-PARTY-NOTICES.md`;<br>`reference/protocol.md`, `routing.md`, `prompts.md`, `records.md`, `census.md`, `taxonomy.md`;<br>`scripts/nthr.mjs`;<br>`scripts/lib/check.mjs`, `charter.mjs`, `cli.mjs`, `close.mjs`, `decisions.mjs`, `discover.mjs`, `flow.mjs`, `footprint.mjs`, `fresh.mjs`, `fsguard.mjs`, `git.mjs`, `pack.mjs`, `patch.mjs`, `render.mjs`, `resume.mjs`, `runs.mjs`, `schema.mjs`, `snapshot.mjs` | sha256 of each file's bytes, recorded in the state file |
| `<P>/.claude/nth-dev-kit-hooks/review.state.json`: provenance | — |

The development files (`tests/`, `VALIDATION.md`, `RELEASE.md` and the repository's other documents) stay in the package and are never installed.

```json
{
  "schemaVersion": 1,
  "library": "<sha256 over the 27 manifest entries>",
  "skill": {
    "path": "skills/nth-review",
    "files": { "<relative path>": "<sha256 of the file's bytes>" },
    "pending": { "<relative path>": "<sha256 of the bytes being written>" }
  },
  "createdDirs": ["<directory under <P> that Enable created>"]
}
```

- **`files`** records the sha256 of each installed file's exact bytes, as verified after it was written. Enable and Update write the library's LF bytes; the manifest digest is taken over LF content, so a written file's hash equals its manifest digest.
- **`pending`** exists only while an Enable or Update is unfinished. Before either changes any skill file, it writes the state file with a `pending` entry for each path it will write: the sha256 of the bytes it will write there. The same write moves each present file's verified hash into `files`, so a file left at an earlier `pending` hash stays provable. Its last write removes `pending`. A state file with `pending` therefore marks an unfinished operation, and each file it names may be at its `files` hash, at its `pending` hash, or absent.
- **`library`** identifies the package content the copy came from, or, while `pending` exists, the one it is being brought to. It is the sha256 of the 27 lines `<relative path> <manifest digest>`, sorted by path in byte order (as `LC_ALL=C sort` does; a locale's order gives a different digest) and joined with LF, with no final newline, taken from the manifest the copy is written from. The field keeps its name from nth-review's time inside the nth-dev-kit project, when the copy came from that project's library; the same runtime files give the same digest either way. `node "<P>/.claude/skills/nth-review/scripts/nthr.mjs" version` reports the helper, protocol and records versions. These change only when bumped, so the digests are the precise identity.
- **`createdDirs`** lists the directories Enable had to create: `.claude`, `.claude/nth-dev-kit-hooks`, `.claude/skills`, a parent before its child. Disable removes only these, and only when empty.
- The file has no timestamp, so an operation that changes nothing writes nothing. Whether the state changed is judged by its parsed content, never by its JSON formatting.

**Ownership.** The integration's own record lives in `<P>/.claude/`, and it proves ownership file by file. "Kit-owned" below means owned by this integration; the term dates from nth-review's time inside the nth-dev-kit project.
- **Byte-exact.** A file is kit-owned only while it is present and the sha256 of its exact bytes equals its `files` entry or its `pending` entry. Nothing in the project is normalized before hashing.
- **Anything else is modified, and preserved.** That includes a line-ending-only change, an added or removed final newline, and a file present without a record. Such a file is reported as a conflict and never overwritten, deleted or re-recorded. The package manifest's canonical digests check the package's own integrity, never project ownership.
- Everything else under `<P>/.claude/` is user-owned, and Enable, Update and Disable never read or write it: settings, other skills, agents, `CLAUDE.md`, and other kit or project files.
- `<P>/.nth-review/` holds review records and owner decisions. It is never an integration file, and no lifecycle operation reads, moves or deletes it.
- **Lost state:** if the state file is lost while the skill folder remains, nothing proves the folder is the integration's. Enable reports it as a conflict and never adopts it. The user removes the folder by hand, then enables again.

**Shadowing.** A personal skill takes precedence over a same-named project skill in Claude Code. If `<config>/skills/nth-review/` exists, Enable and Update report that it shadows the project copy, and never touch it.

**Git.** Nothing here stages, commits, or changes Git's index, refs or history. The only Git commands are `rev-parse` and `ls-files`, which never write. Never run `git status` here: it can rewrite the index to refresh its cache (observed in M4-T3).
- **Optional local exclude (manual).** The installed files are untracked in the project. The review helper leaves them out, as it leaves out `.nth-review/`: untracked files at `.claude/skills/nth-review/` and `.claude/nth-dev-kit-hooks/review.state.json` in the root repository never enter a snapshot, a size or freshness (owner decision 2026-10-27, superseding the helper clause of M4 owner decision 4). The lines below then only keep them out of the owner's own `git status`. The owner may add exactly these lines to the repository's local exclude (`git rev-parse --git-path info/exclude`, normally `.git/info/exclude`). They name only this integration's paths:

  ```
  /.nth-review/
  /.claude/skills/nth-review/
  /.claude/nth-dev-kit-hooks/review.state.json
  ```

  nth-review never edits `.gitignore` or `info/exclude` (decision D6). It never suggests broader patterns such as `/.claude/`, which would hide user-owned and other integrations' files; Enable only mentions the option.
  - Tracked copies, and every other file in `.claude/`, still count as project state.
  - The untracked copies are never reviewed: `footprint` and `close` refuse a run that cites them, and the report says so.
  - Earlier runs keep their snapshots. A base snapshot taken while the helper still counted these files stays base-dirty if they were present, and a run open across the change is asked to reassess once at close.
- **Tracked copies are not supported in v1.** A target that Git already tracks is a conflict. Its ownership is uncertain (a team may have committed its own copy), so it is refused rather than guessed. Nothing changes the index or the working tree to resolve it.

## Validation

Enable, Update and Disable all start with these checks. A failed check is a conflict: stop, write nothing, and report it.

1. **The state file,** if present:
   - invalid JSON, or an unknown `schemaVersion`;
   - a skill path other than exactly `skills/nth-review`;
   - a key in `files` or `pending` outside the runtime paths above. The allowed keys are `SKILL.md`, `THIRD-PARTY-NOTICES.md`, `reference/<name>.md`, `scripts/nthr.mjs` and `scripts/lib/<name>.mjs`, where a name is lowercase letters, digits and hyphens;
   - a duplicate key, or two keys that differ only in case;
   - a hash that is not 64 lowercase hexadecimal digits;
   - a `createdDirs` entry outside the three directories above;
   - a missing `files` object or `createdDirs` list, or a `library` value that is not 64 lowercase hexadecimal digits.
2. **Paths:**
   - a symbolic link, junction or other reparse point on any component of any target path, from `<P>` down to each file (`.claude`, `skills`, `nth-review`, `reference`, `scripts`, `lib`, `nth-dev-kit-hooks`, and every file);
   - a target whose real path is not inside the real path of `<P>`;
   - an entry whose name differs from its expected target only in letter case or Unicode normalization. File systems differ, case-sensitive or not, whatever the operating system, so this is never guessed either way;
   - a `<P>` that is the user's home directory or a config directory, or lies inside or contains `<config>`, the installed package, or a source checkout of nth-review.
3. **Git:**
   - if `<P>` is inside a Git work tree (`git rev-parse --show-toplevel`), no file under `.claude/skills/nth-review/`, and not `.claude/nth-dev-kit-hooks/review.state.json`, may be tracked there (`git ls-files -- <path>` lists nothing). Tracked files elsewhere in `.claude/`, such as a team's `settings.json` or other skills, are user-owned and never block it;
   - if `<P>` is in no work tree, as for a parent folder of several repositories, nothing there can be tracked, and the check passes. Only Git's own "not a git repository" answer means that. Any other failure of `rev-parse` or `ls-files`, such as a repository Git refuses as dubious ownership, is a conflict: the tracked check could not run.
4. **Leftovers:** a temporary file (`.<name>.nth-tmp`, see [Writing a file](#writing-a-file)) anywhere under the skill folder, including `reference/`, `scripts/` and `scripts/lib/`, or in the state folder. The user removes it, then reruns.

## Writing a file

Every file Enable or Update writes (the 27 runtime files and the state file) is written the same way:
1. Write to `.<name>.nth-tmp` in the target's directory.
2. Verify the sha256 of its bytes.
3. Rename it onto the target name.

A crash mid-write therefore leaves at most a temporary file, never a truncated `SKILL.md` or helper. A temporary name never ends in `SKILL.md`, so it can never load as a skill.

## Enable

Run only when the user explicitly asks (`/nth-review:project enable`, or by asking for this section), in the project they intend, and not while a review run is open in it. Do not commit or otherwise mutate Git. In Enable, Update and Disable, **the library** is the installed package (step 4).

1. Resolve `<P>` and `<config>` (`CLAUDE_CONFIG_DIR` when set, otherwise the runtime default). State both, and why, before changing anything.
2. Require Node.js 20 or later and Git. Otherwise stop and report.
3. Confirm on the running version, probing uncertain points only in a throwaway project:
   - a project skill loads from `<P>/.claude/skills/nth-review/SKILL.md` and runs when typed as `/nth-review`;
   - `disable-model-invocation: true` keeps it out of the model's own choices;
   - `${CLAUDE_SKILL_DIR}` expands to the skill's folder;
   - a folder without `SKILL.md` is not offered as a skill.

   M0-T1 ([VALIDATION.md](VALIDATION.md)) verified the first three for a config-home skill, VS1 ran the skill from a project's `.claude/skills/`, and M4-T3 observed the fourth on Claude Code 2.1.310. If a point fails, stop and report; do not switch to another loading mechanism.
4. Require the installed package. `<config>/plugins/installed_plugins.json` must name exactly one install path for `nth-review@nth-review`, inside the real path of `<config>/plugins/cache/`. Verify its manifest, `runtime-manifest.json`, for package `nth-review`: every entry at a safe path, present, and at its digest, with no duplicate key, and an entry for this document. Take the runtime files that the package's own copy of this document lists (the 27 runtime files above, for this version) from that folder; each must have a manifest entry. Other files there are never installed. A missing or unregistered package, a package outside the cache, a missing file, a missing entry, a digest mismatch or an invalid manifest stops Enable with the guidance to install or repair the nth-review plugin. Never fall back to a source checkout.
5. Run [Validation](#validation).
6. Preflight every runtime file before writing any:
   - absent → to write;
   - kit-owned and already the library's bytes → keep;
   - kit-owned at an older version → to replace;
   - anything else → conflict (see Ownership).

   For each recorded file the library no longer ships: kit-owned → to delete; absent → its record is dropped; anything else → conflict. If any file is to be replaced or deleted, `SKILL.md` is also to write: it is deleted first and written last. Also a conflict: any unrecorded file in `skills/nth-review/`, and an existing `skills/nth-review/` folder with no state file (see Lost state). On any conflict, stop and write nothing.
7. Report a personal `<config>/skills/nth-review/` that would shadow the project copy, and leave it alone. Report a legacy nth-dev-kit library copy (see [Legacy installations](#legacy-nth-dev-kit-installations)), and leave it alone.
8. Create `.claude/` and `.claude/nth-dev-kit-hooks/` if missing. Then **write the state file first**, as an intent record:
   - in `files`, each present kit-owned file's hash as the preflight just verified it, other entries unchanged;
   - a `pending` entry for every file to write or replace;
   - in `createdDirs`, every directory Enable creates or will create;
   - the new `library` digest.

   An interrupted Enable is then already on record: every file is at its `files` hash, at its `pending` hash, or absent. A rerun of Enable finishes it, and Disable undoes it.
9. Create the remaining directories. If `SKILL.md` is present and to write, delete it now. Write the planned files as LF bytes, as in [Writing a file](#writing-a-file), and delete the planned ones, with **`SKILL.md` last**, so the skill is offered only once every file it needs is in place.
10. Verify every runtime file's bytes against the library digest. Then write the state file again, last: each runtime file's verified hash in `files`, the records of deleted or absent dropped files removed, and no `pending`.
11. Run `node "<P>/.claude/skills/nth-review/scripts/nthr.mjs" version`. Report:
    - that the skill is offered to new sessions; a session already running sees it only after a delay of a few seconds, so start a new session to use it;
    - that it runs only when typed as `/nth-review`;
    - the optional local exclude (see Git).

Rerunning Enable is safe and changes nothing when everything is current. It is also the repair path: it rewrites a missing file and replaces a kit-owned file at an older version.

## Update

Run only when the user explicitly asks (`/nth-review:project update`, or by asking for this section), in that project, after the package was updated and its manifest verified. Do not run it while a review run is open there. **Close every other Claude Code session in the project first**, or make sure none types `/nth-review` until Update has finished: a running session keeps its cached copy of the skill for a few seconds after `SKILL.md` is deleted and can still start it (see [Interruption and recovery](#interruption-and-recovery)). Start a new session afterwards. A package update never runs this.

1. No state file: the integration is not enabled in `<P>`. Stop without reading or writing `skills/nth-review/`.
2. Require Node.js 20 or later and Git, and the installed package and its files, as in Enable steps 2 and 4. Run [Validation](#validation). On conflict, change nothing and report it.
3. If the updated library no longer ships the skill, leave the installed copy and its state unchanged, and report that Disable can remove them.
4. Preflight every file before writing any. For each file the updated library ships:
   - kit-owned and already the library's bytes → no write;
   - kit-owned at an older version → to replace;
   - recorded but absent → to write if it has a `pending` entry (an unfinished Enable or Update had not written it yet). Otherwise it is a conflict: someone deleted it. Report that Enable repairs it;
   - not recorded and absent → to write (new in the library);
   - anything else → conflict (see Ownership).

   For each recorded file the library no longer ships: kit-owned → to delete; absent → its record is dropped; anything else → conflict. If any file is to be written or deleted, `SKILL.md` is also to write: it is deleted first and written last. An unrecorded file in `skills/nth-review/` is left in place and reported. A personal skill or a legacy library copy is reported, as in Enable step 7. On any conflict write nothing at all, and report it. The files form one module, and a partial update could leave a mixed version that runs.
5. Write order, only if a file is to be written or deleted, or a record changes:
   - write the state file first, as an intent record: in `files`, each present kit-owned file's verified hash; a `pending` entry for every file to write; and the new `library` digest;
   - if any file is to be written or deleted, delete `SKILL.md` first, if present, so the skill stops loading while files change;
   - create any missing skill directory;
   - write and delete the other planned files, as in [Writing a file](#writing-a-file);
   - write `SKILL.md` last, as the library's LF bytes;
   - then write the state file again, last: each file's verified hash in `files`, no `pending`, and dropped records removed.

   On an I/O failure, stop and report exactly what was written. A rerun revalidates from the actual files.
6. Verify each file against its record, and report refreshed, unchanged and conflicting files separately.

A second run with no library change writes nothing.

## Disable

Run only when the user explicitly asks (`/nth-review:project disable`, or by asking for this section), in that project, and not while a review run is open there. Close every other Claude Code session in the project first, as for Update. Disable needs no installed package.

1. Run [Validation](#validation). With no state file, nothing is owned: report any `skills/nth-review/` folder as user-owned, and an empty `.claude/nth-dev-kit-hooks/` or an empty `.claude/` as a possible leftover of an interrupted Enable or Disable that the user may remove, and stop.
2. Delete `SKILL.md` first, if it is kit-owned, so the skill stops loading.
3. Delete each other recorded file that is kit-owned (its bytes hash to its `files` or `pending` entry, so this also removes what an unfinished Enable or Update wrote).
   - A missing file is already resolved.
   - A modified file (see Ownership) stays, keeps its record, and is reported as a conflict.
   - An unrecorded file is left in place and reported.

   Then remove the skill's directories (`reference/`, `scripts/lib/`, `scripts/`, `skills/nth-review/`) only if empty, and `.claude/skills/` only if it is in `createdDirs` and empty.
4. If no file conflict remains, delete the state file. Then remove `.claude/nth-dev-kit-hooks/` and `.claude/`, each only if it is in `createdDirs` and empty. Otherwise rewrite the state file with only the conflicting files' `files` and `pending` entries, and its `library` and `createdDirs`, so a rerun reports the same conflict and changes nothing.
5. Report `<P>/.nth-review/` as preserved: it holds the review records and owner decisions, and Disable never reads, moves or deletes it.

## Interruption and recovery

Every rerun first revalidates the actual files, so an interrupted operation is finished by running it again.
- **Enable and Update** write their intent record (the state file with `pending`) before changing any skill file, and remove `pending` last. At every point in between, each file is at its `files` hash, at its `pending` hash, or absent, so all of it stays provably the integration's without normalizing anything. A rerun of the same operation finishes it, and Disable undoes it, including after an interrupted Update.
- **`SKILL.md`** is deleted before any installed file changes and written last. While it is absent, a **new** session does not offer the skill (observed in M4-T3 on Claude Code 2.1.310). A **running** session does not drop it at once: in headless sessions it kept offering the skill, and still started it from its cache, for at least 3 seconds after `SKILL.md` was deleted, and dropped it within 5 to 8 seconds. Interactive sessions were not observed. A turn that had already loaded the skill keeps its instructions. That is why Update and Disable require other sessions in the project to be closed and no review run to be open, and why a new session is started afterwards.
- **Before the intent record:** if Enable stopped after creating `.claude/` or `.claude/nth-dev-kit-hooks/` but before the state file existed, those directories have no record. A rerun records nothing for them, so Disable leaves them; the user removes them if they are empty and unwanted.
- **Disable:** a missing recorded file is already resolved. If the interruption came between deleting the state file and removing the last directories, at most `.claude/nth-dev-kit-hooks/` and `.claude/` remain, empty.
- **A temporary file** left by a crash is a conflict (Validation 4). The user removes it and reruns the same operation. If the crash hit a state-file write, the previous state file is still intact.

## Legacy nth-dev-kit installations

Until 2026-10-29 nth-review lived inside nth-dev-kit. Its Global Install stored the files in `<config>/nth-dev-kit/agents/claude/integrations/review/`, with a library receipt, and Enable copied the skill from there.
- **A project enabled that way needs no migration.** Its state file has the same format, and its `library` digest equals the package's whenever the runtime files are the same. Update and Disable here work on it as on any enabled project. Nothing migrates it automatically.
- **To move it to the package:** install the package, then run **Update** in that project. If the runtime files are the same, Update changes nothing.
- **The legacy library copy** is never read, changed or deleted by any operation here. Enable and Update report it; nth-dev-kit's own Global Update manages or removes it.
- **Its review records** in `.nth-review/` are read as they are: the run identities, records, reports, baselines, Flow entries and census edges, fingerprints, debt and decisions keep their formats.

## Verification

- Each installed file matches its recorded hash in the state file, and the state file lists exactly the 27 runtime files.
- `node "<P>/.claude/skills/nth-review/scripts/nthr.mjs" version` exits 0 and prints its versions.
- After install, an official audit is still refused: `node "<P>/.claude/skills/nth-review/scripts/nthr.mjs" new-run --ns audits/x --mode audit-plan --slug p` exits 2.
- In a new session, `/nth-review` is listed in the project's skill inventory, and Claude does not start a review unless it is typed.
- `tests/m4/operator.mjs` is a literal transcription of [Enable](#enable), [Update](#update) and [Disable](#disable), rehearsed by `tests/m4/rehearse.mjs`; when this document changes, change it to match. How to run the tests and the rehearsal is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
