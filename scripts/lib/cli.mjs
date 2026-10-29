// nth-review command-line core: argument parsing, the JSON output contract
// and exit codes. Commands are registered in COMMANDS; nthr.mjs only calls
// run(). Kept import-safe (no side effects) so tests can call run() in process.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkRun, parseRunArg } from './check.mjs';
import { createCharter } from './charter.mjs';
import { closeRun } from './close.mjs';
import { decide, status } from './decisions.mjs';
import { footprintRun } from './footprint.mjs';
import { freshRun } from './fresh.mjs';
import { packRun } from './pack.mjs';
import { discoverRepos } from './discover.mjs';
import { entryAnchor, resolveEntries } from './flow.mjs';
import { applyPatch, recordsDigestOf } from './patch.mjs';
import { resumeRun } from './resume.mjs';
import { newRun, prepareRun } from './runs.mjs';
import { PROTOCOL, SCHEMA_ID, VERSION } from './schema.mjs';

export { PROTOCOL, VERSION };
export const SCHEMA = SCHEMA_ID;
export const MIN_NODE_MAJOR = 20;

// 0 ok · 1 validation failure · 2 usage or guard refusal · 3 unexpected error.
export const EXIT = Object.freeze({ OK: 0, INVALID: 1, USAGE: 2, UNEXPECTED: 3 });

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export class ValidationError extends Error {
  // `extra`: fields added to the failure output, such as records_sha256.
  constructor(errors, extra = {}) {
    super(`${errors.length} validation error(s)`);
    this.name = 'ValidationError';
    this.errors = errors;
    this.extra = extra;
  }
}

// Options every command accepts.
const GLOBAL_OPTIONS = {
  root: { type: 'string', summary: 'Project root (default: current directory)' },
  help: { type: 'boolean', summary: 'Show usage' },
};

const OPTION_NAME = /^[a-z][a-z0-9-]*$/;

// Parses the tokens after the command name against a spec of
// { name: { type: 'string' | 'boolean', multiple?: boolean } }.
// Accepts `--name value` and `--name=value`; `--` ends option parsing.
export function parseOptions(tokens, spec) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string') throw new UsageError('arguments must be strings');
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      if (token.startsWith('-') && token !== '-') {
        throw new UsageError(`unknown option ${token}`);
      }
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const def = OPTION_NAME.test(name) && Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!def) throw new UsageError(`unknown option --${name}`);
    let value;
    if (def.type === 'boolean') {
      if (eq === -1) value = true;
      else {
        const raw = token.slice(eq + 1);
        if (raw !== 'true' && raw !== 'false') {
          throw new UsageError(`--${name} takes no value (or true/false)`);
        }
        value = raw === 'true';
      }
    } else if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${name} needs a value`);
      }
      value = next;
      i += 1;
    }
    if (def.multiple) {
      (options[name] ??= []).push(value);
    } else if (Object.hasOwn(options, name)) {
      throw new UsageError(`--${name} given more than once`);
    } else {
      options[name] = value;
    }
  }
  return { options, positionals };
}

export function checkNodeVersion(version) {
  const major = Number.parseInt(String(version).replace(/^v/, ''), 10);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new UsageError(
      `nth-review requires Node.js >= ${MIN_NODE_MAJOR} (found ${version})`,
    );
  }
}

// The project root: an existing directory, returned as its real path.
export function resolveRoot(rootOption, cwd) {
  if (rootOption === '') throw new UsageError('--root must not be empty');
  const resolved = path.resolve(cwd, rootOption ?? '.');
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new UsageError(`--root does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) throw new UsageError(`--root is not a directory: ${resolved}`);
  return realpathSync.native(resolved);
}

const EXIT_CODES = Object.freeze({ 0: 'ok', 1: 'validation failure', 2: 'usage or guard refusal', 3: 'unexpected error' });

const helpCommand = {
  summary: 'List commands, options and exit codes',
  options: {},
  run: ({ commands }) => ({
    usage: 'node nthr.mjs <command> [options]',
    commands: Object.entries(commands).map(([name, command]) => ({
      name,
      summary: command.summary,
      options: Object.keys({ ...GLOBAL_OPTIONS, ...command.options }).map((o) => `--${o}`),
    })),
    exitCodes: EXIT_CODES,
  }),
};

// `nthr <command> --help`: that command's options only, with their meaning.
export function commandHelp(name, command) {
  return {
    usage: `node nthr.mjs ${name} [options]`,
    command: name,
    summary: command.summary,
    options: Object.entries({ ...command.options, ...GLOBAL_OPTIONS }).map(([option, def]) => ({
      name: `--${option}`, type: def.type, repeatable: def.multiple === true, summary: def.summary,
    })),
    exitCodes: EXIT_CODES,
  };
}

const versionCommand = {
  summary: 'Show the helper, protocol and schema versions',
  options: {},
  run: ({ root, nodeVersion }) => ({
    version: VERSION,
    protocol: PROTOCOL,
    schema: SCHEMA,
    node: nodeVersion,
    platform: process.platform,
    root,
  }),
};

const newRunCommand = {
  summary: 'Open a run: snapshot, budget, required lead model, inherited debt, records.json skeleton',
  options: {
    ns: { type: 'string', summary: 'Namespace: experiments|reviews|audits/<id>' },
    mode: { type: 'string', summary: 'task | incremental | flow | audit-plan | audit-unit' },
    slug: { type: 'string', summary: 'Run slug (a-z, 0-9, -)' },
    base: { type: 'string', summary: 'Base run id in the same namespace' },
    continues: { type: 'string', summary: 'Run id this run continues, in the same namespace' },
    change: { type: 'string', multiple: true, summary: '<repo> (working tree) or <repo>:<a>..<b>; repeatable' },
    unit: { type: 'string', summary: 'Audit unit id (audit-unit only)' },
    entry: { type: 'string', multiple: true, summary: 'Flow entry: <path>#<Symbol>, <path>:<line> or <path>:<from>-<to>; repeatable (flow only)' },
  },
  run: ({ options, root, officialAuditsEnabled, now }) => {
    const result = newRun(root, options, { officialAuditsEnabled, now });
    const { ns, id } = parseRunArg(result.run_dir);
    return { ...result, records_sha256: recordsDigestOf(root, ns, id) };
  },
};

// How to start the session a run's required lead model allows (routing.md).
export const START_COMMANDS = Object.freeze({
  'opus-high': Object.freeze(['claude --model opus --effort high']),
  sonnet: Object.freeze(['claude --model opus --effort high', 'claude --model sonnet']),
});

// What new-run would do, before anything is opened: the same preparation and
// refusals, with read-only Git, and nothing written.
const previewCommand = {
  summary: 'Show what new-run would open (size, budget, required lead model, triggers, debt) without writing anything',
  options: newRunCommand.options,
  run: ({ options, root, officialAuditsEnabled, now }) => {
    const { run_dir: _dir, run_id: _id, ...rest } = prepareRun(root, options, { officialAuditsEnabled, now }).result;
    return {
      writes: 'nothing',
      ...rest,
      start: START_COMMANDS[rest.required_lead_model],
      note: 'new-run sizes the source again when it opens and assigns the run id; a trigger the lead finds at Plan raises sonnet to opus-high (C15). The budget caps tool calls, not money: review.md lists observed costs.',
    };
  },
};

const resolveCommand = {
  summary: 'Resolve flow entry selectors against the current source (read-only; opens nothing)',
  options: { entry: { type: 'string', multiple: true, summary: '<path>#<Symbol>, <path>:<line> or <path>:<from>-<to>; repeatable' } },
  run: ({ options, root }) => {
    const { repos } = discoverRepos(root);
    const { entries, problems } = resolveEntries(root, options.entry ?? [], repos.map((r) => r.path));
    return {
      resolved: problems.length === 0,
      entries: entries.map((e) => ({ id: e.id, selector: e.selector, anchor: entryAnchor(e), repo: e.repo, state: e.identity.state })),
      problems,
    };
  },
};

const checkCommand = {
  summary: 'Validate one run (read-only); exit 1 with the errors when it fails',
  options: { run: { type: 'string', summary: '.nth-review/<ns>/runs/<run-id>' } },
  run: ({ options, root, officialAuditsEnabled }) => {
    const result = checkRun(root, options.run, { officialAuditsEnabled });
    const { ns, id } = parseRunArg(options.run);
    const records_sha256 = recordsDigestOf(root, ns, id);
    if (result.errors.length) throw new ValidationError(result.errors, { records_sha256 });
    return { valid: true, run_dir: result.run_dir, status: result.status, warnings: result.warnings, records_sha256 };
  },
};

const footprintCommand = {
  summary: 'Record the identity of every cited file in an open run (read-only Git)',
  options: { run: { type: 'string', summary: '.nth-review/<ns>/runs/<run-id>' } },
  run: ({ options, root }) => {
    const { ns, id, rel } = parseRunArg(options.run);
    const { errors, ...result } = footprintRun(root, ns, id);
    if (errors.length) throw new ValidationError(errors);
    return { run_dir: `.nth-review/${rel}`, ...result, records_sha256: recordsDigestOf(root, ns, id) };
  },
};

const freshCommand = {
  summary: 'Record the freshness of an open incremental run against its base (read-only Git)',
  options: { run: { type: 'string', summary: '.nth-review/<ns>/runs/<run-id>' } },
  run: ({ options, root }) => {
    const { ns, id, rel } = parseRunArg(options.run);
    const { errors, ...result } = freshRun(root, ns, id);
    if (errors.length) throw new ValidationError(errors);
    return { run_dir: `.nth-review/${rel}`, ...result, records_sha256: recordsDigestOf(root, ns, id) };
  },
};

const resumeCommand = {
  summary: 'Continue, or (with --apply) abandon and continue, the open run of a namespace after the source moved',
  options: {
    ns: { type: 'string', summary: 'Namespace: experiments|reviews|audits/<id>' },
    apply: { type: 'boolean', summary: 'Abandon the run and open its continuation (otherwise only the plan)' },
  },
  run: ({ options, root, officialAuditsEnabled, now }) => {
    const { errors, ...result } = resumeRun(root, options.ns, { apply: options.apply === true, now, officialAuditsEnabled });
    if (errors.length) throw new ValidationError(errors);
    return result;
  },
};

const decideCommand = {
  summary: 'Record an owner decision about a finding fingerprint in decisions.json (append-only; never acted on)',
  options: {
    ns: { type: 'string', summary: 'Namespace: experiments|reviews|audits/<id>' },
    fingerprint: { type: 'string', summary: 'Finding fingerprint, as recorded in a run of the namespace' },
    decision: { type: 'string', summary: 'fix | accept | false-positive | known-item' },
    note: { type: 'string', summary: 'Why' },
    by: { type: 'string', summary: 'Who decides' },
  },
  run: ({ options, root, officialAuditsEnabled, now }) => {
    const { errors, ...result } = decide(root, options, { now, officialAuditsEnabled });
    if (errors.length) throw new ValidationError(errors);
    return result;
  },
};

const statusCommand = {
  summary: 'Show runs, outstanding debt, findings and decisions of one or every namespace (read-only)',
  options: { ns: { type: 'string', summary: 'Namespace (default: every namespace)' } },
  run: ({ options, root }) => status(root, options.ns),
};

const charterCommand = {
  summary: 'Create an official audit namespace charter (gated: refused while official audits are disabled)',
  options: {
    ns: { type: 'string', summary: 'audits/<id>' },
    owner: { type: 'string', summary: 'Who authorizes the audit' },
    scope: { type: 'string', summary: 'What the audit covers' },
    exclusions: { type: 'string', summary: 'What the owner excludes (explicit; "none" when nothing is excluded)' },
    official: { type: 'boolean', summary: 'Explicit authorization of an official audit (required)' },
    profile: { type: 'string', summary: 'quick | standard | deep (default standard)' },
    'budget-sessions': { type: 'string', summary: 'Session budget, 1-9999' },
  },
  run: ({ options, root, officialAuditsEnabled, now }) => createCharter(root, {
    ns: options.ns,
    owner: options.owner,
    scope: options.scope,
    exclusions: options.exclusions,
    official: options.official === true,
    profile: options.profile ?? 'standard',
    budgetSessions: options['budget-sessions'] ?? null,
  }, { now, officialAuditsEnabled }),
};

const packCommand = {
  summary: 'Write a bounded evidence pack (packs/<id>.md) for a finding or obligation of an open run',
  options: {
    run: { type: 'string', summary: '.nth-review/<ns>/runs/<run-id>' },
    for: { type: 'string', summary: 'Finding or obligation id' },
    anchor: { type: 'string', multiple: true, summary: 'Extra anchor to excerpt; repeatable' },
  },
  run: ({ options, root }) => {
    const { ns, id } = parseRunArg(options.run);
    if (typeof options.for !== 'string') throw new UsageError('--for <finding or obligation id> is required');
    const { errors, ...result } = packRun(root, ns, id, options.for, options.anchor ?? []);
    if (errors.length) throw new ValidationError(errors);
    return result;
  },
};

const applyCommand = {
  summary: 'Apply an open run\'s patch.json to records.json in one write, then check; stale or protected edits are refused',
  options: { run: { type: 'string', summary: '.nth-review/<ns>/runs/<run-id>' } },
  run: ({ options, root, officialAuditsEnabled }) => {
    const { ns, id } = parseRunArg(options.run);
    const { errors, ...result } = applyPatch(root, ns, id, { officialAuditsEnabled });
    if (errors.length) throw new ValidationError(errors, { records_sha256: result.records_sha256 });
    return result;
  },
};

const closeCommand = {
  summary: 'Close an open run: source recheck, footprint, check, report.md, then records.json',
  options: {
    run: { type: 'string', summary: '.nth-review/<ns>/runs/<run-id>' },
    status: { type: 'string', summary: 'complete | incomplete' },
    reason: { type: 'string', summary: 'Incomplete reason (records.md)' },
    reassessed: { type: 'boolean', summary: 'Scope and census were reassessed after untracked or coverage changes' },
  },
  run: ({ options, root, officialAuditsEnabled, now }) => {
    const { ns, id } = parseRunArg(options.run);
    const { errors, ...result } = closeRun(root, ns, id, {
      status: options.status, reason: options.reason ?? null, reassessed: options.reassessed === true, now, officialAuditsEnabled,
    });
    if (errors.length) throw new ValidationError(errors);
    return result;
  },
};

export const COMMANDS = Object.freeze({
  help: helpCommand,
  version: versionCommand,
  'new-run': newRunCommand,
  preview: previewCommand,
  resolve: resolveCommand,
  check: checkCommand,
  footprint: footprintCommand,
  apply: applyCommand,
  fresh: freshCommand,
  pack: packCommand,
  close: closeCommand,
  resume: resumeCommand,
  decide: decideCommand,
  status: statusCommand,
  charter: charterCommand,
});

// Runs one invocation and returns its exit code. Output is exactly one JSON
// line on stdout: { ok, command, result } or { ok: false, command, errors }.
export function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const nodeVersion = io.nodeVersion ?? process.version;
  const commands = io.commands ?? COMMANDS;
  let commandName = null;
  const emit = (payload, code) => {
    stdout.write(`${JSON.stringify(payload)}\n`);
    return code;
  };
  try {
    checkNodeVersion(nodeVersion);
    const [first, ...rest] = argv;
    if (first === undefined) throw new UsageError('no command given; try --help');
    if (first === '--help' || first === '-h') commandName = 'help';
    else if (first === '--version') commandName = 'version';
    else if (first.startsWith('-')) throw new UsageError('the command must come first; try --help');
    else commandName = first;
    if (!Object.hasOwn(commands, commandName)) {
      const unknown = commandName;
      commandName = null;
      throw new UsageError(`unknown command ${unknown}`);
    }
    const command = commands[commandName];
    const { options, positionals } = parseOptions(rest, { ...GLOBAL_OPTIONS, ...command.options });
    if (options.help && commandName !== 'help') {
      return emit({ ok: true, command: 'help', result: commandHelp(commandName, command) }, EXIT.OK);
    }
    if (positionals.length && !command.positionals) {
      throw new UsageError(`unexpected argument ${positionals[0]}`);
    }
    const root = resolveRoot(options.root, cwd);
    const result = command.run({
      options, positionals, root, cwd, nodeVersion, commands,
      // Decision C19: the switch lives in nthr.mjs and is passed in here.
      officialAuditsEnabled: io.officialAuditsEnabled === true,
      now: io.now ?? new Date(),
    });
    return emit({ ok: true, command: commandName, result }, EXIT.OK);
  } catch (error) {
    if (error instanceof ValidationError) {
      return emit({ ok: false, command: commandName, errors: error.errors, ...error.extra }, EXIT.INVALID);
    }
    if (error instanceof UsageError || error?.refusal === true) {
      return emit({ ok: false, command: commandName, errors: error.problems ?? [error.message] }, EXIT.USAGE);
    }
    stderr.write(`${error?.stack ?? error}\n`);
    return emit(
      { ok: false, command: commandName, errors: [`unexpected error: ${error?.message ?? error}`] },
      EXIT.UNEXPECTED,
    );
  }
}
