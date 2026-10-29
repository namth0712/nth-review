// Static guards on the skill's content (M3-T1, M3-T8): frontmatter, size,
// links, helper commands, delegation templates, routing, guardrails, and
// independence from the rest of the kit. The M3-T8 contract checks at the end
// are pure functions: the real content passes them, and a deliberate mutation
// of the invariant each one guards makes it fail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROLES, checkRun } from '../scripts/lib/check.mjs';
import { COMMANDS } from '../scripts/lib/cli.mjs';
import { VOCAB, validateDecisions, validateStructure } from '../scripts/lib/schema.mjs';
import { BASE, validRecords } from './helpers/records.mjs';
import { writeRun } from './helpers/runs.mjs';
import { REVIEW_DIR, makeTempDir, rawGit } from './helpers/tmp.mjs';

import { packageFiles } from './tools/runtime-manifest.mjs';
const read = (rel) => fs.readFileSync(path.join(REVIEW_DIR, ...rel.split('/')), 'utf8');
const skill = read('SKILL.md');
const prompts = read('reference/prompts.md');

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'SKILL.md starts with a frontmatter block');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    assert.ok(kv, `frontmatter line is a plain key: ${line}`);
    fields[kv[1]] = kv[2];
  }
  return { fields, body: text.slice(match[0].length) };
}

test('frontmatter: exactly name, description, disable-model-invocation: true, argument-hint', () => {
  const { fields } = frontmatter(skill);
  assert.deepEqual(Object.keys(fields).sort(), ['argument-hint', 'description', 'disable-model-invocation', 'name']);
  assert.equal(fields.name, 'nth-review');
  assert.equal(fields['disable-model-invocation'], 'true', 'invocation is explicit only');
  assert.ok(fields.description.length > 40 && fields.description.length <= 1024);
  assert.match(fields['argument-hint'], /^"task --ns /);
  assert.ok(!/managed-by/.test(skill), 'no metadata.managed-by (decision R3)');
  assert.ok(!skill.includes('\r') && !prompts.includes('\r'), 'LF only');
});

test('size: SKILL.md body at most 120 lines; prompts.md at most 150', () => {
  assert.ok(frontmatter(skill).body.split('\n').length <= 120);
  assert.ok(prompts.split('\n').length <= 150);
});

test('every relative link in the runtime Markdown resolves', () => {
  for (const rel of ['SKILL.md', 'reference/prompts.md', 'reference/records.md']) {
    for (const [, target] of read(rel).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|#|mailto:)/.test(target)) continue;
      const file = path.join(REVIEW_DIR, ...path.posix.dirname(rel).split('/'), ...target.split('#')[0].split('/'));
      assert.ok(fs.existsSync(file), `${rel} links to missing ${target}`);
    }
  }
});

test('every helper command and option the skill names exists in the CLI', () => {
  const globals = ['root', 'help'];
  const anyOption = new Set([...globals, ...Object.values(COMMANDS).flatMap((c) => Object.keys(c.options))]);
  const helper = /^node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/nthr\.mjs" /;
  let seen = 0;
  for (const text of [skill, prompts]) {
    for (const [, raw] of text.matchAll(/`([^`\n]+)`/g)) {
      const snippet = raw.replace(helper, '');
      if (/^--[a-z]/.test(snippet)) {
        // A standalone option, such as `--reassessed`: it must exist somewhere
        // (the git guardrail's own flags are git's, not the helper's).
        for (const token of snippet.split(/\s+/).filter((t) => t.startsWith('--'))) {
          if (['--no-ext-diff', '--no-textconv'].includes(token)) continue;
          assert.ok(anyOption.has(token.slice(2)), `no helper command has ${token}`);
        }
        continue;
      }
      const [command, ...rest] = snippet.split(/\s+/);
      if (!Object.hasOwn(COMMANDS, command) || !rest.some((t) => t.startsWith('--'))) continue;
      for (const token of rest.filter((t) => t.startsWith('--'))) {
        const option = token.slice(2).split('=')[0];
        assert.ok(Object.hasOwn(COMMANDS[command].options, option) || globals.includes(option), `${command} has no --${option}`);
      }
      seen += 1;
    }
  }
  assert.ok(seen >= 5, `the skill names its helper commands (${seen})`);
  for (const option of ['reassessed', 'status', 'reason']) assert.ok(Object.hasOwn(COMMANDS.close.options, option));
  for (const command of ['new-run', 'apply', 'pack', 'close']) assert.ok(skill.includes(`\`${command} --`), `the workflow uses ${command}`);
});

test('the refuter applies the boundary test; taxonomy Severity requires a crossing for security and privacy', () => {
  assert.match(prompts, /If the pack has a Boundary test, apply it: a security or privacy claim that fails it is "risk", or "corrected" to the impact it does show/);
  assert.match(read('reference/taxonomy.md'), /A `security` or `privacy` impact needs a crossing: an actor, the control that should stop them, and another principal, tenant, shared resource or operator-paid spend affected, shown by the trace\./);
  assert.match(skill, /authorization crossing principals → `security`, per taxonomy\.md Severity/);
});

test('templates: role sentence, read-only rules, budget, answer-before-budget, JSON with checked/not_checked, explicit model', () => {
  const section = (title) => {
    const start = prompts.indexOf(`## ${title}`);
    assert.ok(start >= 0, `prompts.md has ## ${title}`);
    const next = prompts.indexOf('\n## ', start + 1);
    return prompts.slice(start, next === -1 ? undefined : next);
  };
  const r3 = section('R3 plan-critique');
  const refuter = section('R5/R6 refuter');
  for (const [name, text] of [['R3', r3], ['refuter', refuter]]) {
    assert.match(text, /Budget: at most \d+ tool calls/, `${name}: budget line`);
    assert.match(text, /Answer before the budget is spent/, `${name}: answer before budget`);
    assert.match(text, /"checked": \[.*\], "not_checked": \[/, `${name}: JSON schema with checked and not_checked`);
    assert.match(text, /Rules: read-only\./, `${name}: read-only rules`);
    assert.match(text, /Never open \.env files or other secrets/, `${name}: secrets`);
    assert.match(text, /project-root-relative, starting with the repository directory/, `${name}: path base`);
    assert.match(text, /this replaces your usual report format/, `${name}: JSON overrides the agent's own format`);
  }
  assert.match(r3, /You did not do this review; find what it missed\./);
  assert.match(refuter, /You did not write this; try to refute it\./);
  assert.match(refuter, /Read the evidence pack first: <run_dir>\/packs\/<finding-id>\.md/, 'evidence first');
  assert.match(refuter, /Do not open records\.json or any other pack\./, 'no earlier conclusion');
  assert.match(refuter, /`node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/nthr\.mjs" pack --run <run_dir> --for <finding-id>`/);
  // The documented routing is the routing `check` enforces.
  assert.match(r3, new RegExp(`Agent: \`${ROLES.R3.agent}\``));
  assert.match(r3, new RegExp(`Model: \`${ROLES.R3.model}\``));
  // The R5/R6 selection lives once, in routing.md (checked against ROLES in references.test.mjs).
  assert.match(refuter, /\*\*Routing:\*\* which refuter a finding gets is decided in \[routing\.md\]\(routing\.md\)/);
  assert.match(refuter, /\*\*R5:\*\* Model: `opus`, Effort: `high`, Budget: at most 10 tool calls/);
  assert.match(refuter, /\*\*R6:\*\* Model: `sonnet`, Budget: at most 10 tool calls per finding/);
});

test('routing and models: only Opus at high effort or Sonnet; xhigh and max appear only as prohibitions', () => {
  for (const [name, text] of [['SKILL.md', skill], ['prompts.md', prompts]]) {
    for (const line of text.split('\n').filter((l) => /\b(xhigh|max)\b/i.test(l) && !/max_|obligations_max/.test(l))) {
      assert.match(line, /\b(never|stop)\b/i, `${name}: ${line}`);
    }
    for (const [, model] of text.matchAll(/[Mm]odel:? `([a-z-]+)`/g)) assert.ok(['opus', 'sonnet'].includes(model), `${name}: model ${model}`);
  }
  assert.match(skill, /Never xhigh or max\./);
  assert.match(skill, /`opus-high` needs Opus at high effort/);
  assert.match(skill, /stop before Plan/);
});

test('guardrails: read-only project, no git writes, no tests or services, no secrets, helper-only writes', () => {
  for (const rule of [
    /The project is read-only\./,
    /never stage, commit, push, stash, switch branches or rewrite history/,
    /Never run tests, builds, services, project scripts, migrations or database clients\. No network\./,
    /Never open `\.env\*` files or other secrets/,
    /Git only to read, and always with `--no-ext-diff --no-textconv`: `git log`, `git show`, `git diff`\./,
    /project-root-relative, starting with the repository directory/,
    /You write only `\.nth-review\/<ns>\/runs\/<run-id>\/patch\.json`/,
    /Never edit `records\.json` directly, and never use a script, `node -e` or shell redirection\./,
    /In a Task Review, never open other runs' records, reports or packs under `\.nth-review\/`/,
    /Delegate only to `Explore` and `nth-review:reviewer`/,
    /Plan-critique \(mandatory\)/,
    /exactly one recovery message/,
    /Never touch the run after close\./,
    /`node --version` must report v20 or later/,
    /Never set `wall_clock_min`: close computes it\./,
  ]) assert.match(skill, rule);
  assert.ok(!/wall-clock minutes/.test(skill), 'the lead never estimates the wall clock');
});

test('VS1 fixes: facts outside the source make needs_validation; unreported usage is null, never 0', () => {
  // F-2 in VS1 was confirmed although it held only without an unseen /api gateway rewrite (decision C14).
  assert.match(prompts, /"needs_validation" means true only if a fact outside the source holds \(deployment, configuration, runtime behaviour, data or owner knowledge\)/);
  assert.match(prompts, /"confirmed" means true as stated, from the source alone\./);
  assert.match(prompts, /validation_plan is null for every other outcome\./);
  assert.match(skill, /A claim that holds only if a fact outside the source holds .* is never `confirmed`: record `needs_validation`/);
  assert.match(skill, /Never strengthen a refuter's outcome\./);
  // The R5 usage in VS1 arrived after close and was recorded as 0.
  assert.match(skill, /`tool_uses` and `tokens` from its task notification\. If that notification has not arrived, record both as null, never 0\./);
  assert.ok(!/or 0 if none were reported/.test(skill));
});

// Independence from nth-dev-kit (its own repository since 2026-10-29): the
// runtime imports nothing outside the skill folder, and names nth-dev-kit only
// for the state folder `nth-dev-kit-hooks` (a historical name), a project's
// `.nth-dev-kit/HANDOFF.md` and the notice. The kit side (no copy of the
// engine there) is checked by tests/tools/kit-check.mjs.
function independenceProblems(files) {
  const problems = [];
  for (const [rel, text] of files) {
    for (const m of text.matchAll(/nth-dev-kit(?!-hooks)/g)) {
      const around = text.slice(Math.max(0, m.index - 1), m.index + 24);
      if (rel === 'THIRD-PARTY-NOTICES.md' || around.startsWith('.nth-dev-kit/HANDOFF.md')) continue;
      problems.push(`${rel}: names nth-dev-kit`);
    }
    if (rel.endsWith('.mjs')) {
      for (const [, spec] of text.matchAll(/\bfrom '([^']+)'|\bimport\('([^']+)'\)/g)) {
        if (!spec || spec.startsWith('node:')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        if (target.startsWith('..') || !files.has(target)) problems.push(`${rel}: imports ${spec}, outside the skill`);
      }
    }
  }
  return problems;
}

test('independence: the runtime needs nothing from nth-dev-kit, and imports nothing outside the skill folder; mutations fail', () => {
  const files = new Map(packageFiles(REVIEW_DIR).filter((rel) => rel !== 'INSTALL.md').map((rel) => [rel, read(rel)]));
  assert.equal(files.size, 27);
  assert.deepEqual(independenceProblems(files), []);
  const variant = (rel, from, to) => new Map([...files, [rel, files.get(rel).replace(from, to)]]);
  assert.deepEqual(independenceProblems(variant('SKILL.md', /\n$/, '\nRead <config>/nth-dev-kit/README.md first.\n')), ['SKILL.md: names nth-dev-kit']);
  assert.deepEqual(independenceProblems(variant('scripts/nthr.mjs', /^/, "import x from '../../INSTALL.mjs';\n")), ["scripts/nthr.mjs: imports ../../INSTALL.mjs, outside the skill"]);
});

// ---------------------------------------------------------------- M3-T8 contract checks

const RUNTIME = ['SKILL.md', 'reference/protocol.md', 'reference/routing.md', 'reference/prompts.md', 'reference/records.md',
  'reference/census.md', 'reference/taxonomy.md', 'THIRD-PARTY-NOTICES.md'];
const runtime = () => new Map(RUNTIME.map((rel) => [rel, read(rel)]));

// Explicit invocation only: exactly the four keys, and model invocation disabled.
function frontmatterProblems(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return ['no frontmatter'];
  const fields = {};
  const problems = [];
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2];
    else problems.push(`not a plain key: ${line}`);
  }
  const keys = Object.keys(fields).sort().join(', ');
  if (keys !== 'argument-hint, description, disable-model-invocation, name') problems.push(`keys: ${keys}`);
  if (fields['disable-model-invocation'] !== 'true') problems.push('model invocation is not disabled');
  return problems;
}

// Progressive loading: every runtime document is reachable from SKILL.md by relative links.
function unreachable(files) {
  const seen = new Set(['SKILL.md']);
  const queue = ['SKILL.md'];
  while (queue.length) {
    const rel = queue.shift();
    for (const [, target] of (files.get(rel) ?? '').matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|#|mailto:)/.test(target)) continue;
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target.split('#')[0]));
      if (files.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return [...files.keys()].filter((rel) => !seen.has(rel));
}

// Records ids match the schema: every inline list of values (`a` · `b` · …) is
// a subset of one schema vocabulary, so no document names a value the schema lacks.
function enumDrift(text) {
  const vocabularies = Object.values(VOCAB);
  const drift = [];
  for (const [list] of text.matchAll(/`[A-Za-z][\w-]*`(?: · `[A-Za-z][\w-]*`)+/g)) {
    const values = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (!vocabularies.some((v) => values.every((x) => v.includes(x)))) drift.push(list);
  }
  return drift;
}

// Every delegation template states its agent, model, effort and budget outside the
// delegate text, and its budget and strict JSON answer inside it.
function templateProblems(prompts) {
  const problems = [];
  for (const part of prompts.split(/\n(?=## )/).filter((p) => p.includes('~~~text'))) {
    const title = /^## (.+)$/m.exec(part)[1];
    const header = part.slice(0, part.indexOf('~~~text'));
    const text = part.slice(part.indexOf('~~~text'), part.lastIndexOf('~~~'));
    if (!/Model:? `(opus|sonnet)`/.test(header)) problems.push(`${title}: no model line`);
    if (!/Effort: (none|`high`)/.test(header)) problems.push(`${title}: no effort line`);
    if (!/Budget: at most \d+/.test(header)) problems.push(`${title}: no budget line`);
    if (!/Budget: at most .* tool calls\. Answer before the budget is spent/.test(text)) problems.push(`${title}: no budget in the delegate text`);
    if (!/Answer with exactly this JSON and nothing else/.test(text) || !/"checked": \[/.test(text)) problems.push(`${title}: no strict JSON answer`);
  }
  return problems;
}

// The helper writes project state only through fsguard (paths inside .nth-review),
// runs no program but git, and opens no network connection.
const WRITE_CALL = /\bfs\.(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|copyFileSync|cpSync|linkSync|symlinkSync|rmdirSync|truncateSync|chmodSync|utimesSync|writeSync)\(|\bfs\.openSync\([^)]*'(w|wx|a|ax|r\+)'/g;
function effectSites(sources) {
  const sites = [];
  for (const [file, text] of sources) {
    if (file === 'scripts/lib/fsguard.mjs') continue;
    for (const m of text.matchAll(WRITE_CALL)) sites.push(`${file} ${m[1] ?? `openSync ${m[2]}`}`);
    if (file !== 'scripts/lib/git.mjs' && /node:child_process/.test(text)) sites.push(`${file} child_process`);
    if (/node:(http|https|net|dgram|tls)'|\bfetch\(/.test(text)) sites.push(`${file} network`);
  }
  return sites.sort();
}
const scriptSources = () => {
  const dir = path.join(REVIEW_DIR, 'scripts');
  const files = ['nthr.mjs', ...fs.readdirSync(path.join(dir, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`)];
  return new Map(files.map((f) => [`scripts/${f}`, fs.readFileSync(path.join(dir, ...f.split('/')), 'utf8')]));
};
// The reviewed exceptions, each confined to a path resolved inside .nth-review:
// close removes its own leftover temporary files; decide holds its lock file;
// new-run removes the run directory it just created when its write fails.
const ALLOWED_EFFECTS = [
  'scripts/lib/close.mjs rmSync',
  'scripts/lib/decisions.mjs openSync wx', 'scripts/lib/decisions.mjs rmSync', 'scripts/lib/decisions.mjs rmSync', 'scripts/lib/decisions.mjs writeSync',
  'scripts/lib/patch.mjs rmSync',
  'scripts/lib/runs.mjs rmSync',
].sort();

test('M3-T8 skill invocation: explicit only, small body, references loaded progressively; mutations fail', () => {
  assert.deepEqual(frontmatterProblems(skill), []);
  for (const [label, mutant] of [
    ['invocation enabled', skill.replace('disable-model-invocation: true', 'disable-model-invocation: false')],
    ['misspelled key', skill.replace('disable-model-invocation:', 'disable-model-invokation:')],
    ['extra key', skill.replace('argument-hint:', 'model: opus\nargument-hint:')],
    ['missing key', skill.replace(/^argument-hint:.*\n/m, '')],
  ]) assert.notDeepEqual(frontmatterProblems(mutant), [], label);
  const files = runtime();
  assert.deepEqual(unreachable(files), [], 'every runtime document is reachable from SKILL.md');
  // Mutation: no document links census.md any more.
  const unlinked = new Map([...files].map(([rel, text]) => [rel, text.replace(/\]\((reference\/)?census\.md(#[^)]*)?\)/g, '](#)')]));
  assert.deepEqual(unreachable(unlinked), ['reference/census.md'], 'an unlinked reference is caught');
  // The body points to the references instead of copying them: the family and severity tables live in taxonomy.md.
  assert.ok(!/^\| (LOGIC|AUTHZ|critical|high) \|/m.test(skill), 'no reference table copied into SKILL.md');
});

test('M3-T8 reference ids: every value list in the references is a schema vocabulary subset; a stale or invented value fails', () => {
  for (const rel of ['SKILL.md', 'reference/protocol.md', 'reference/records.md', 'reference/routing.md', 'reference/census.md', 'reference/taxonomy.md']) {
    assert.deepEqual(enumDrift(read(rel)), [], rel);
  }
  assert.deepEqual(enumDrift('| `status` | `held` · `violated` · `waived` |'), ['`held` · `violated` · `waived`'], 'an invented value');
  assert.deepEqual(enumDrift('- `role`: `R5` · `R6` · `R9`.'), ['`R5` · `R6` · `R9`']);
});

test('M3-T8 templates: every delegation template has its model, effort, budget and strict JSON lines; removing one fails', () => {
  assert.deepEqual(templateProblems(prompts), []);
  assert.equal(prompts.split(/\n(?=## )/).filter((p) => p.includes('~~~text')).length, 4, 'R2, R3, R4 and R5/R6');
  const noBudget = prompts.replace('- Budget: at most 30 tool calls\n- **When:** optional', '- **When:** optional');
  assert.ok(templateProblems(noBudget).some((p) => /R2 census assist: no budget line/.test(p)));
  const noModel = prompts.replace(/(## R4 judgment critic[\s\S]*?)- Model: `opus`\n/, '$1');
  assert.notEqual(noModel, prompts, 'the mutation applies');
  assert.ok(templateProblems(noModel).some((p) => /R4 judgment critic: no model line/.test(p)));
});

test('M3-T8 no application-code changes: the helper writes only through fsguard, runs only git, and uses no network', () => {
  const sources = scriptSources();
  assert.deepEqual(effectSites(sources), ALLOWED_EFFECTS);
  for (const file of ['scripts/lib/close.mjs', 'scripts/lib/decisions.mjs', 'scripts/lib/patch.mjs', 'scripts/lib/runs.mjs']) {
    assert.match(sources.get(file), /resolveReviewPath\(|mkdirExclusive\(/, `${file} resolves its paths inside .nth-review`);
  }
  // Mutations: a direct write, a spawned program, a network call.
  for (const [label, line, expected] of [
    ['a direct write', "fs.writeFileSync(path.join(root, 'src/app.js'), 'x');", 'scripts/lib/render.mjs writeFileSync'],
    ['a spawned program', "import { execSync } from 'node:child_process';", 'scripts/lib/render.mjs child_process'],
    ['a network call', "await fetch('https://example.com');", 'scripts/lib/render.mjs network'],
  ]) {
    const mutated = new Map(sources);
    mutated.set('scripts/lib/render.mjs', `${sources.get('scripts/lib/render.mjs')}\n${line}\n`);
    assert.ok(effectSites(mutated).includes(expected), label);
  }
});

test('M3-T8 refutation: the R5 rule stated in routing.md and SKILL.md is the rule check enforces; a confirmed defect is never unrefuted', (t) => {
  // The documented rule: the severities and impacts named where R5 is required.
  const named = (text) => ({
    severities: VOCAB.severity.filter((v) => new RegExp(`\\b${v}\\b`).test(text)),
    impacts: VOCAB.impactDimension.filter((v) => new RegExp(`(^|[^-\\w])${v}([^-\\w]|$)`).test(text)),
  });
  const routingCell = read('reference/routing.md').split('\n').find((l) => l.startsWith('| R5 refuter')).split(' | ')[5];
  const skillLine = skill.split('\n').find((l) => /\*\*R5\*\* \(`opus`/.test(l)).split('):')[1];
  const documented = named(routingCell);
  assert.deepEqual(named(skillLine), documented, 'SKILL.md and routing.md state the same rule');
  assert.ok(documented.severities.length && documented.impacts.length);

  // The enforced rule: a confirmed defect verified by R6, for every severity and impact.
  const root = makeTempDir(t);
  const base = validRecords({ status: 'complete' });
  Object.assign(base.run, { id: BASE, mode: 'task', slug: 'demo', base: null, opened: '2026-10-24T09:00:00Z', closed: '2026-10-24T10:00:00Z' });
  base.debt = { in: [], out: [{ id: `${BASE}/D1`, kind: 'owner-fact', refs: ['OB-02'], requires: 'x', priority: 'low' }] };
  base.freshness = null;
  writeRun(root, base);
  const errorsFor = (edit) => {
    const doc = validRecords({ status: 'incomplete' });
    edit(doc);
    return checkRun(root, writeRun(root, doc)).errors;
  };
  const byR6 = (severity, impact) => (d) => {
    Object.assign(d.findings[0], { severity, impact_dimension: impact, verification: { role: 'R6', model: 'sonnet', outcome: 'confirmed', corrections: null, incomplete: false } });
    d.delegations = [{ ...d.delegations[0], role: 'R6', model: 'sonnet', effort: null }];
  };
  for (const severity of VOCAB.severity) {
    for (const impact of VOCAB.impactDimension) {
      const enforced = errorsFor(byR6(severity, impact)).some((e) => /needs the R5 Opus refuter/.test(e));
      const stated = documented.severities.includes(severity) || documented.impacts.includes(impact);
      assert.equal(enforced, stated, `${severity} / ${impact}`);
    }
  }
  // Independent refutation stays mandatory: a confirmed defect without a completed refuter is refused;
  // only a mechanical doc-drift (exact lines on both sides) may skip it, as protocol.md §7 says.
  const unrefuted = /a confirmed defect needs a completed R5 or R6 verification/;
  assert.ok(errorsFor((d) => { d.findings[0].verification = { role: 'none', model: null, outcome: null, corrections: null, incomplete: false }; }).some((e) => unrefuted.test(e)));
  assert.ok(errorsFor((d) => { d.findings[0].verification.incomplete = true; }).some((e) => unrefuted.test(e)));
  const drift = (anchor) => (d) => {
    Object.assign(d.findings[0], { kind: 'doc-drift', impact_dimension: 'maintainability', severity: 'low', trace: [{ role: 'sink', anchor, note: 'doc' }],
      verification: { role: 'none', model: null, outcome: null, corrections: null, incomplete: false } });
  };
  assert.ok(!errorsFor(drift('api/src/transfer.js:10')).some((e) => /doc-drift needs a verification/.test(e)), 'exact lines');
  assert.ok(errorsFor(drift('docs/ledger.md#Transfers')).some((e) => /doc-drift needs a verification/.test(e)), 'a heading is not mechanical');
  assert.match(read('reference/protocol.md'), /Mechanical evidence \(exact lines on both sides\) may skip the refuter\./);
});

test('M3-T8 lifecycle: owner decisions and review debt are separate records, and no run-writing module reads decisions', () => {
  const doc = validRecords();
  doc.debt.out[0].decision = 'accept';
  assert.ok(validateStructure(doc).some((e) => /\$\.debt\.out\[0\]/.test(e)), 'debt carries no owner decision');
  const decisions = {
    schema: 'nth-review/decisions@1', namespace: 'experiments/demo',
    decisions: [{ seq: 1, fingerprint: 'a/b', decision: 'accept', note: 'n', by: 'Owner', date: '2026-10-26T09:00:00Z', supersedes: null, seen_in: [{ run: BASE, finding: 'F-01' }], disposition: 'carried' }],
  };
  assert.ok(validateDecisions(decisions).some((e) => /\$\.decisions\[0\]/.test(e)), 'a decision carries no debt disposition');
  delete decisions.decisions[0].disposition;
  assert.deepEqual(validateDecisions(decisions), []);
  for (const [file, text] of scriptSources()) {
    if (['scripts/lib/decisions.mjs', 'scripts/lib/cli.mjs'].includes(file)) continue;
    assert.ok(!/from '\.\/decisions\.mjs'/.test(text), `${file} does not read owner decisions (nothing acts on them yet, C3)`);
  }
});
