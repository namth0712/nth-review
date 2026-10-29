---
name: project
description: Enable, update or disable nth-review in the current project. It never runs a review.
disable-model-invocation: true
argument-hint: enable | update | disable
---

# nth-review: project Enable, Update or Disable

The operation is the first word of: `$ARGUMENTS`

- `enable`, `update` or `disable`: run that operation for the current project, as below.
- Anything else, or nothing: list the three operations with one line each and stop. Never guess which one is meant.

1. Read `${CLAUDE_PLUGIN_ROOT}/INSTALL.md`. Follow its sections "Runtime files and ownership", "Validation" and "Writing a file", and the section of the chosen operation ("Enable", "Update" or "Disable"), exactly and in order.
2. `<P>` is this session's working directory, and `<config>` is `CLAUDE_CONFIG_DIR` when it is set, otherwise Claude Code's default configuration folder. State both before changing anything, as Enable step 1 says.
3. The package files always come from the install path that Enable step 4 resolves from `<config>/plugins/installed_plugins.json`. Never copy from a source checkout, and never from this skill's own folder.
4. Work the same way on every operating system:
   - compute sha256 hashes, write temporary files, rename and check for links with Node.js (`node -e` with `crypto`, `fs.writeFileSync`, `fs.renameSync`, `fs.lstatSync`);
   - do not depend on `sha256sum`, `shasum`, Git Bash or PowerShell-only commands;
   - the only Git commands are `git rev-parse` and `git ls-files`. Never run `git status`.
5. Never start a review. Never stage, commit or otherwise change Git. Never write outside the paths INSTALL.md names for the operation, and never change Claude Code's settings or plugins.
6. Report what INSTALL.md asks the operation to report. After Enable, also say: start a new session in this project, then type `/nth-review task …` to review a change. `${CLAUDE_PLUGIN_ROOT}/docs/USAGE.md` describes the commands.
