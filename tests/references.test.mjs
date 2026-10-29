// Static consistency of the runtime references (M3-T2 protocol.md and
// routing.md, M3-T3 prompts.md, M3-T4 census.md and taxonomy.md) with what is
// implemented: the records schema vocabularies and fields, the check id
// format, the CLI, the budgets and lead models new-run sets, the routing check
// enforces, the official-audit switch, and the delegation contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROLES, checkRun } from '../scripts/lib/check.mjs';
import { COMMANDS } from '../scripts/lib/cli.mjs';
import { TASK_SIZES, initialBudget } from '../scripts/lib/runs.mjs';
import { VOCAB } from '../scripts/lib/schema.mjs';
import { EXIT } from '../scripts/lib/cli.mjs';
import { makeRepo } from './helpers/repo.mjs';
import { validRecords } from './helpers/records.mjs';
import { at, nthr, readRecords, writeRecords, writeRun } from './helpers/runs.mjs';
import { REVIEW_DIR, makeTempDir } from './helpers/tmp.mjs';

const read = (rel) => fs.readFileSync(path.join(REVIEW_DIR, ...rel.split('/')), 'utf8');
const protocol = read('reference/protocol.md');
const routing = read('reference/routing.md');
const prompts = read('reference/prompts.md');
const records = read('reference/records.md');
const census = read('reference/census.md');
const taxonomy = read('reference/taxonomy.md');
const skill = read('SKILL.md');
const FAMILIES = ['LOGIC', 'AUTHN', 'AUTHZ', 'CONTRACT', 'INJECT', 'ATOMIC', 'DATA', 'ASYNC', 'RESOURCE', 'PERF', 'PRIVACY', 'RELIAB', 'UI', 'ENV', 'SUPPLY', 'ARCH', 'TEST'];
const section = (text, title) => {
  const start = text.indexOf(`\n## ${title}`);
  assert.ok(start >= 0, `## ${title}`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
};

test('sizes, line endings and links: protocol.md ≤ 350 lines, routing.md ≤ 120, prompts.md ≤ 150, census.md ≤ 150, taxonomy.md ≤ 450', () => {
  assert.ok(protocol.split('\n').length <= 350);
  assert.ok(routing.split('\n').length <= 120);
  assert.ok(prompts.split('\n').length <= 150);
  assert.ok(census.split('\n').length <= 150);
  assert.ok(taxonomy.split('\n').length <= 450);
  const headings = (text) => new Set([...text.matchAll(/^#+ (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')));
  for (const [name, text] of [['protocol.md', protocol], ['routing.md', routing], ['prompts.md', prompts], ['census.md', census], ['taxonomy.md', taxonomy]]) {
    assert.ok(!text.includes('\r'), `${name}: LF only`);
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const [file, anchor] = target.split('#');
      const full = path.join(REVIEW_DIR, 'reference', ...file.split('/'));
      assert.ok(fs.existsSync(full), `${name} links to missing ${target}`);
      if (anchor) assert.ok(headings(fs.readFileSync(full, 'utf8')).has(anchor), `${name} links to missing heading ${target}`);
    }
  }
  for (const target of ['reference/protocol.md', 'reference/routing.md', 'reference/taxonomy.md', 'reference/census.md']) {
    assert.ok(skill.includes(`](${target})`), `SKILL.md loads ${target}`);
  }
});

test('every helper command a reference names exists, with its options; no retired command names', () => {
  const commands = new Set(Object.keys(COMMANDS));
  for (const [name, text] of [['protocol.md', protocol], ['routing.md', routing], ['prompts.md', prompts]]) {
    for (const [, raw] of text.matchAll(/`([^`\n]+)`/g)) {
      const snippet = raw.replace(/^node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/nthr\.mjs" /, '');
      const [word, ...rest] = snippet.split(/\s+/);
      if (['report', 'enable', 'install'].includes(word) && rest.length === 0) assert.fail(`${name}: \`${word}\` is not a helper command`);
      if (!commands.has(word)) continue;
      for (const token of rest.filter((t) => t.startsWith('--'))) {
        assert.ok(Object.hasOwn(COMMANDS[word].options, token.slice(2)) || token === '--root', `${name}: ${word} has no ${token}`);
      }
    }
  }
  for (const word of ['new-run', 'check', 'pack', 'footprint', 'fresh', 'close', 'resume', 'decide', 'status', 'charter']) {
    assert.ok(protocol.includes(`\`${word}`), `protocol.md covers ${word}`);
  }
});

test('protocol.md uses exactly the records vocabularies for statuses, verdicts, kinds, debt, freshness and history', () => {
  for (const key of ['obligationStatus', 'openReason', 'findingKind', 'verdict', 'debtKind', 'freshClass', 'historyOutcome', 'trigger', 'coverage', 'sourceTrace', 'observed']) {
    for (const value of VOCAB[key]) assert.ok(protocol.includes(`\`${value}\``), `protocol.md names ${key} ${value}`);
  }
  // Families and severity anchors live once, in taxonomy.md; the protocol links there.
  assert.deepEqual([...section(taxonomy, 'Severity').matchAll(/^\| ([a-z]+) \|/gm)].map((m) => m[1]), VOCAB.severity);
  assert.ok(protocol.includes('[taxonomy.md](taxonomy.md#severity)'));
  for (const family of FAMILIES) {
    assert.ok(!new RegExp(`^\\| ${family} \\|`, 'm').test(protocol), `protocol.md keeps no second family table (${family})`);
    assert.ok(section(prompts, 'R3 plan-critique').includes(family), `R3 asks about ${family}`);
  }
});

// The schema's check id format, held equal to schema.mjs below.
const CHECK_ID = /^[A-Z][A-Z0-9-]{0,31}(\.[1-9]\d{0,2})?$/;
const familySection = (family) => {
  const start = taxonomy.indexOf(`\n### ${family} — `);
  assert.ok(start >= 0, `taxonomy.md has ### ${family}`);
  const next = taxonomy.slice(start + 1).search(/\n##+ /);
  return taxonomy.slice(start, next === -1 ? undefined : start + 1 + next);
};
const modules = () => {
  const rows = section(taxonomy, 'Specialized modules').split('\n').filter((l) => /^\| \*\*[A-Z]/.test(l));
  return rows.map((row) => {
    const name = /^\| \*\*([A-Z][A-Z-]*)\*\* \|/.exec(row)[1];
    const numbers = [...row.matchAll(new RegExp(`\\*\\*(?:${name})?\\.(\\d+)\\*\\*`, 'g'))].map((m) => Number(m[1]));
    return { name, row, numbers };
  });
};
const definedChecks = () => new Set([
  ...FAMILIES.flatMap((f) => [...familySection(f).matchAll(/^- \*\*([A-Z]+\.\d+)\*\*/gm)].map((m) => m[1])),
  ...modules().flatMap((m) => [m.name, ...m.numbers.map((n) => `${m.name}.${n}`)]),
]);

test('taxonomy.md: 17 addressable families, each with its objective, checks, failure mechanisms, evidence and counterevidence, severity, runtime validation and indirect paths', () => {
  assert.ok(read('scripts/lib/schema.mjs').includes(`const CHECK_ID = ${CHECK_ID};`), 'the test uses the schema check id format');
  assert.deepEqual([...section(taxonomy, 'Families').matchAll(/^### ([A-Z]+) — /gm)].map((m) => m[1]), FAMILIES);
  let total = 0;
  for (const family of FAMILIES) {
    const text = familySection(family);
    for (const field of ['**Objective:**', '**Fails by:**', '**Evidence:**', '**Counterevidence:**', '**Severity:**', '**Runtime:**', '**Indirect paths:**']) {
      assert.ok(text.includes(field), `${family}: ${field}`);
    }
    const ids = [...text.matchAll(/^- \*\*([A-Z]+\.\d+)\*\*/gm)].map((m) => m[1]);
    assert.deepEqual(ids, ids.map((_, i) => `${family}.${i + 1}`), `${family}: checks numbered 1..n`);
    assert.ok(ids.length >= 1 && ids.length <= 7, `${family}: ${ids.length} checks`);
    for (const id of ids) assert.match(id, CHECK_ID);
    total += ids.length;
  }
  assert.equal(total, 101, 'the 101 family checks of the research taxonomy');
  // Rules that keep confirmation honest.
  assert.match(taxonomy, /\*\*Missing documentation is never proof of a defect\.\*\*/);
  assert.match(familySection('ARCH'), /\*\*Missing documentation is recorded here, never as a business-logic defect:\*\* a `risk`, or an obligation `open` \/ `needs-owner-intent`/);
  assert.match(taxonomy, /`doc-drift` is only for documents that contradict the code\./);
  // The refuter follows routing.md, never a family-specific rule.
  assert.ok(!/always the R5/.test(taxonomy), 'no refuter rule outside routing.md');
  assert.match(taxonomy, /Only source-supported, independently verified findings become `confirmed`/);
  assert.match(familySection('PERF'), /\*\*capped at low\*\*/);
  assert.match(familySection('ARCH'), /\*\*capped at medium\*\* unless the issue demonstrably caused or hid a defect/);
  for (const family of ['ATOMIC', 'PERF']) assert.match(familySection(family), /claims are never `held` on source alone/);
  for (const dimension of VOCAB.impactDimension) assert.ok(section(taxonomy, 'Severity').includes(`\`${dimension}\``), `impact dimension ${dimension}`);
});

test('taxonomy.md: screening outcomes map to records vocabularies; all families are screened, not all reviewed', () => {
  const screening = section(taxonomy, 'Screening and outcomes');
  assert.match(screening, /\*\*screen all 17 families\*\*/);
  const row = (label) => screening.split('\n').find((l) => l.startsWith(`| **${label}** |`)) ?? assert.fail(label);
  const expect = {
    'Not applicable': [['no obligation'], ['`scope.summary`']],
    'Out of scope': [[`\`${'out-of-scope'}\``, '`coverage: excluded`', '`coverage_method`', '`deferred-scope`']],
    'Checked, no confirmed finding': [['`held`', '`coverage`']],
    'Open or unverified': [['`open`', '`candidate`', '`needs_validation`']],
  };
  for (const [label, groups] of Object.entries(expect)) for (const parts of groups) for (const part of parts) assert.ok(row(label).includes(part), `${label}: ${part}`);
  for (const [value, key] of [['out-of-scope', 'obligationStatus'], ['held', 'obligationStatus'], ['open', 'obligationStatus'], ['excluded', 'coverage'], ['deferred-scope', 'debtKind'], ['candidate', 'verdict'], ['needs_validation', 'verdict'], ['needs-owner-intent', 'openReason'], ['needs-runtime', 'openReason']]) {
    assert.ok(VOCAB[key].includes(value), `${value} is a ${key}`);
    assert.ok(taxonomy.includes(`\`${value}\``) || taxonomy.includes(`\`${key}: ${value}\``), `taxonomy.md names ${value}`);
  }
  assert.match(skill, /Screen all 17 concern families in \[taxonomy\.md\]\(reference\/taxonomy\.md\), and list the not-applicable codes in `scope\.summary`/);
  // The skill states the same split as the taxonomy: cap or budget → debt; task boundary → out-of-scope.
  assert.match(skill, /An applicable family left out for the cap or budget becomes `deferred-scope` debt; one excluded by the task boundary is an obligation `out-of-scope` with `coverage: excluded`\./);
});

test('the screening outcomes are recordable: check accepts a run that records each of them, with family and module checks', (t) => {
  const root = makeTempDir(t);
  const id = '20261025-131201-task-screen';
  const doc = validRecords();
  Object.assign(doc.run, { id, mode: 'task', slug: 'screen', base: null });
  doc.scope.summary = 'Task review of the transfer change. Not applicable: SUPPLY, TEST, UI.';
  doc.scope.units = [];
  doc.freshness = null;
  doc.debt = { in: [], out: [{ id: `${id}/D1`, kind: 'deferred-scope', refs: [], requires: 'PERF left out for the obligation cap', priority: 'low' }] };
  doc.obligations[1].links = [];
  const obligation = (fields) => ({
    claim: 'c', scope: 's', acceptance: 'a', coverage: 'named-subset', coverage_method: 'm', open_reason: null,
    source_trace: 'not-traced', evidence: [], intent: [], assumptions: [], links: [], ...fields,
  });
  doc.obligations.push(
    obligation({ id: 'OB-03', checks: ['PRIVACY.6'], status: 'out-of-scope', coverage: 'excluded', coverage_method: 'excluded by the task boundary: provider disclosure is reviewed separately' }),
    obligation({ id: 'OB-04', checks: ['LLM.2', 'HTTP-SERVER.1', 'SENSITIVE-SUBJECTS.3'], status: 'held', source_trace: 'consistent', evidence: [{ anchor: 'api/src/transfer.js:3-12', note: 'dispatch re-checks the requester' }] }),
    obligation({ id: 'OB-05', checks: ['ARCH.3'], status: 'open', open_reason: 'needs-owner-intent' }),
  );
  doc.census.items.push({ id: 'CI-4', path: 'api/src/ai/*.js', mechanism: 'model-proposed actions', status: 'unknown', reason: 'dispatch table built at runtime', affects: ['OB-04'] });
  const dir = writeRun(root, doc);
  assert.deepEqual(checkRun(root, dir).errors, []);
});

test('taxonomy.md: modules are technology-neutral, selected by census facts, at most 5 checks each, and LLM covers the AI concerns', () => {
  const list = modules();
  const names = list.map((m) => m.name);
  for (const name of ['LLM', 'HTTP-SERVER', 'SSR-WEB', 'SQL-ORM', 'OBJSTORE', 'HEADLESS-RENDER', 'FILE-PROCESSING', 'WEB-SESSION', 'INTEGRATION', 'INPROC-SCHED', 'MULTI-REPO', 'LEDGER', 'SENSITIVE-SUBJECTS', 'CONTAINER-EDGE', 'CLIENT-TARGETS']) {
    assert.ok(names.includes(name), `module ${name}`);
  }
  for (const { name, numbers, row } of list) {
    assert.match(name, CHECK_ID);
    assert.ok(!FAMILIES.includes(name), `${name} is not also a family`);
    const addsTo = row.split(' | ')[2].split(', ');
    assert.ok(addsTo.every((f) => FAMILIES.includes(f)) || addsTo.join() === 'per platform', `${name} adds to families only: ${addsTo}`);
    assert.ok(section(prompts, 'R3 plan-critique').includes(name), `R3 asks about module ${name}`);
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1), `${name}: checks numbered 1..n`);
    assert.ok(numbers.length <= 5, `${name}: ${numbers.length} checks`);
  }
  assert.match(section(taxonomy, 'Specialized modules'), /selected when the census finds the \*\*boundary\*\* it describes, not because a dependency name appears/);
  // Modules have an operational step: the census adds them, the skill says so, R3 can name a missing one.
  assert.match(section(census, '3. Procedure'), /\*\*Modules\.\*\* When a search finds a module's boundary .* add its checks to the obligations it bears on, or add an obligation, before R3\./);
  assert.match(skill, /and add module checks for each module boundary found/);
  assert.match(section(prompts, 'R3 plan-critique'), /"family": "<family or module code> or null"/);
  // Technology and framework names never name a module or a check.
  assert.ok(!/\b(Express|Next\.js|NextJS|MySQL|Postgres|Drizzle|Prisma|React|Puppeteer|Chromium|MinIO|OpenAI|Anthropic|Claude|server actions|App Router|getServerSideProps)\b/.test(taxonomy + census), 'technology-neutral');
  const llm = list.find((m) => m.name === 'LLM').row;
  for (const concern of [/provenance \(indirect injection/, /re-authorized for the requester at dispatch/, /output reaching renderers or sinks is treated as untrusted/, /spend budgets and loop bounds/, /provider errors/]) assert.match(llm, concern);
});

test('every check id the skill and references cite exists in taxonomy.md', () => {
  const defined = definedChecks();
  for (const [name, text] of [['SKILL.md', skill], ['protocol.md', protocol], ['records.md', records], ['prompts.md', prompts], ['census.md', census], ['routing.md', routing]]) {
    for (const [, id] of text.matchAll(/`([A-Z][A-Z0-9-]*\.[1-9]\d{0,2})`/g)) assert.ok(defined.has(id), `${name} cites ${id}`);
  }
  for (const [, id] of taxonomy.matchAll(/\b([A-Z][A-Z-]+\.[1-9]\d?)\b/g)) assert.ok(defined.has(id), `taxonomy.md cites ${id}`);
  for (const name of ['LEDGER']) assert.ok(defined.has(name) && skill.includes(`\`${name}\``) && records.includes(`\`${name}\``), `${name} is a module the examples use`);
});

test('census.md: fields and statuses are the records@1 ones; kinds match the R2 template; all-enumerated needs complete discovery; absence proves nothing', () => {
  const source = read('scripts/lib/schema.mjs');
  const fields = (key) => {
    const start = source.indexOf(`${key}: S.array(S.object({`);
    assert.ok(start >= 0, key);
    const names = [];
    for (const line of source.slice(start).split('\n').slice(1)) {
      if (/^\s*\}\)/.test(line)) break;
      const field = /^\s+([a-z_]+):/.exec(line);
      if (field) names.push(field[1]);
    }
    return names;
  };
  assert.deepEqual(fields('recipes'), ['id', 'pattern', 'scope', 'hits', 'limits']);
  assert.deepEqual(fields('items'), ['id', 'path', 'mechanism', 'status', 'reason', 'affects']);
  for (const field of [...fields('recipes'), ...fields('items')]) assert.ok(census.includes(`\`${field}\``), `census.md names ${field}`);
  for (const status of VOCAB.censusStatus) assert.ok(census.includes(`**\`${status}\`:**`), `census.md defines ${status}`);
  assert.ok(census.includes('[records.md](records.md#census)'));
  // The search kinds: census.md owns them, the R2 template answers with the same set.
  const kinds = [...section(census, '2. Search kinds').matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(kinds, ['sites', 'callers', 'entries', 'schedules', 'events', 'migrations', 'scripts', 'mirrors', 'clients', 'dynamic']);
  const r2 = /"kind": "([a-z|]+)"/.exec(section(prompts, 'R2 census assist'))[1].split('|');
  assert.deepEqual(r2, kinds.filter((k) => k !== 'callers'), 'R2 reports callers as chains and every other kind as sites');
  assert.ok(!/registries/.test(protocol + prompts + census), 'no retired search kind');
  for (const population of [/HTTP and API routes/, /authorization gates/, /direct and indirect callers/, /background workers/, /event producers and consumers/, /database-side logic \(triggers, procedures, scheduled events\)/, /production scripts/, /across repositories/, /unresolved paths: dispatch by string/]) {
    assert.match(section(census, '2. Search kinds'), population);
  }
  const claim = section(census, '6. When `all-enumerated` is justified');
  assert.match(claim, /`snapshot\.discovery_complete` is true\. `check` refuses the claim otherwise\./);
  assert.match(claim, /ruled out with evidence, not by absence/);
  // Every condition, not only the one check enforces.
  assert.deepEqual([...claim.matchAll(/^\d\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]), [
    'Complete discovery:', 'A closed population source:', 'Every member is accounted for:', 'No hidden members:', 'R3 found no missing member,',
  ]);
  assert.match(claim, /every chain ends at a mechanism, with none at `unknown`/);
  assert.match(section(census, '5. Assist and challenge'), /Record each R2 delegation as one recipe: `pattern` is `r2: <obligation-id>`/);
  assert.match(census, /\*\*A search that returns no further hits shows only what that search can see\. It never proves that nothing else exists\.\*\*/);
  assert.match(section(census, '7. Bounded stopping'), /Never stop at "no more hits"/);
  assert.match(section(census, '7. Bounded stopping'), /never uses the 30% reserve/);
  assert.match(source, /recipes: S\.array\([\s\S]*?\{ max: 50 \}\)/);
  assert.match(census, /\*\*At most 50 recipes\*\* per run/);
  assert.match(skill, /following \[census\.md\]\(reference\/census\.md\)/);
});

test('the budget table and lead models are the ones new-run sets', () => {
  const [S, M] = TASK_SIZES;
  const fmt = (n) => n.toLocaleString('en-US');
  const small = initialBudget('task', { files: 1, lines: 1 });
  assert.equal(small.required_lead_model, 'sonnet');
  assert.match(protocol, new RegExp(`^\\| Task S \\(≤ ${fmt(S.lines)} lines, ≤ ${S.files} files\\) \\| ${S.lead_tool_calls} \\| ${S.subagent_calls} \\| ${S.obligations_max} \\| Sonnet`, 'm'));
  for (const sized of [{ files: 20, lines: 600 }, { files: 100, lines: 9000 }, { files: 1, lines: 1, verified: false }]) {
    const b = initialBudget('task', sized);
    assert.deepEqual([b.budget.lead_tool_calls, b.budget.subagent_calls, b.budget.obligations_max, b.required_lead_model], [M.lead_tool_calls, M.subagent_calls, M.obligations_max, 'opus-high']);
  }
  assert.match(protocol, new RegExp(`^\\| Task M \\(≤ ${fmt(M.lines)} lines, ≤ ${M.files} files\\), L, or unverified size \\| ${M.lead_tool_calls} \\| ${M.subagent_calls} \\| ${M.obligations_max} \\| Opus High`, 'm'));
  const inc = initialBudget('incremental', { files: 3, lines: 9, debtIn: 2, baseObligations: 4 });
  assert.deepEqual([inc.budget.lead_tool_calls, inc.budget.subagent_calls, inc.budget.obligations_max, inc.required_lead_model], [20 + 2 * 3 + 3 * 2, 3, 4 + 15, 'opus-high']);
  assert.equal(initialBudget('incremental', { files: null, lines: null }).budget.lead_tool_calls, 80);
  assert.match(protocol, /^\| Incremental \| 20 \+ 2 per changed file \+ 3 per debt-in item, at most 80 \(80 when the size is unknown\) \| 3 \| effective-baseline obligations \+ 15 \| Opus High \|$/m);
  const plan = initialBudget('audit-plan', {}).budget;
  const unit = initialBudget('audit-unit', {}).budget;
  assert.match(protocol, new RegExp(`^\\| Audit plan \\| ${plan.lead_tool_calls} \\| ${plan.subagent_calls} \\| ${plan.obligations_max} \\| Opus High \\|$`, 'm'));
  assert.match(protocol, new RegExp(`^\\| Audit unit \\| ${unit.lead_tool_calls} \\| ${unit.subagent_calls} \\| ${unit.obligations_max} \\| Opus High \\|$`, 'm'));
  assert.match(routing, /^\| Task S with no trigger \| `sonnet` \|/m);
  assert.match(routing, /^\| Incremental \| `opus-high` \|/m);
});

test('routing.md, prompts.md and check agree on every role: agent, model and effort', () => {
  for (const [role, { agent, model }] of Object.entries(ROLES)) {
    const row = routing.split('\n').find((l) => l.startsWith(`| ${role} `));
    assert.ok(row, `routing.md has ${role}`);
    assert.ok(row.includes(`| \`${agent}\` | \`${model}\` | ${model === 'opus' ? '`high`' : 'none'} |`), `${role}: ${row}`);
  }
  for (const [title, role] of [['R2 census assist', 'R2'], ['R3 plan-critique', 'R3']]) {
    const s = section(prompts, title);
    assert.match(s, new RegExp(`- Agent: \`${ROLES[role].agent}\``));
    assert.match(s, new RegExp(`- Model: \`${ROLES[role].model}\``));
    assert.match(s, /- Effort: none/);
    assert.match(s, /- Budget: at most 30 tool calls/);
  }
  // `reviewer`, as routing.md, records and check name it, is called as the bundled `nth-review:reviewer`.
  assert.match(routing, /`reviewer` in this table and in records is the read-only agent the nth-review plugin bundles: call it as `nth-review:reviewer`\./);
  const refuter = section(prompts, 'R5/R6 refuter');
  assert.match(refuter, /- \*\*Agent:\*\* `nth-review:reviewer` \(recorded as `reviewer`\), a fresh context\./);
  assert.match(refuter, /\*\*R5:\*\* Model: `opus`, Effort: `high`, Budget: at most 10 tool calls/);
  assert.match(refuter, /\*\*R6:\*\* Model: `sonnet`, Budget: at most 10 tool calls per finding/);
  // R4: written, but disabled with Full Audit.
  const r4 = section(prompts, 'R4 judgment critic');
  assert.equal(ROLES.R4.agent, 'reviewer');
  assert.match(r4, /- Agent: `nth-review:reviewer` \(recorded as `reviewer`; a fresh context\)/);
  assert.match(r4, new RegExp(`- Model: \`${ROLES.R4.model}\``));
  assert.match(r4, /- Effort: `high`/);
  assert.match(r4, /- Budget: at most 10 tool calls/);
  assert.match(routing, /^\| R4 judgment critic \| `reviewer` \| `opus` \| `high` \| ≤ 10 tool calls \| Full Audit Tier-1 units only, after Verify and before Close \| written; disabled with Full Audit \(C19\) \|$/m, 'R4 is not presented as available');
});

test('every template: role sentence, rules, evidence first, counterevidence, budget, checked and not_checked JSON, completion rule', () => {
  const common = section(prompts, 'Common rules');
  assert.match(common, /exactly one message: "Deliver your answer now from what you have; at most 3 more tool calls\."/);
  assert.match(common, /After a second failure, record `completed: false`/);
  assert.match(common, /Agreement between agents is not evidence\./);
  assert.match(common, /\*\*model\*\* \(always explicitly/);
  for (const [title, start, evidence] of [
    ['R2 census assist', /You enumerate; you do not judge\./, /Read the evidence pack first: <run_dir>\/packs\/<obligation-id>\.md/],
    ['R3 plan-critique', /You did not do this review; find what it missed\./, /Read first: <run_dir>\/records\.json/],
    ['R4 judgment critic', /You did not do this review; find what it missed\./, /Read the evidence packs first: <run_dir>\/packs\/<id>\.md/],
    ['R5/R6 refuter', /You did not write this; try to refute it\./, /Read the evidence pack first: <run_dir>\/packs\/<finding-id>\.md/],
  ]) {
    const s = section(prompts, title);
    assert.match(s, start, `${title}: role sentence`);
    assert.match(s, /Rules: read-only\./, `${title}: rules`);
    assert.match(s, evidence, `${title}: evidence first`);
    assert.match(s, /Seek (counterevidence|what a text search misses)/, `${title}: seeks counterevidence`);
    assert.match(s, /Budget: at most .* tool calls\. Answer before the budget is spent/, `${title}: budget`);
    assert.match(s, /"checked": \[.*\], "not_checked": \[/, `${title}: checked and not_checked`);
    assert.match(s, /this replaces your usual report format/, `${title}: strict JSON`);
  }
  const refuter = section(prompts, 'R5/R6 refuter');
  assert.match(refuter, /"kind": "defect\|risk\|doc-drift"/, 'the refuter keeps defect, risk and doc-drift apart');
  assert.match(refuter, /"evidence": \[\{"anchor"/, 'an outcome cites supporting anchors');
  assert.match(refuter, /an outcome without them counts as not checked/);
});

test('the protocol states the confirmation rule and the five categories once, and never presents disabled work as available', () => {
  assert.match(protocol, /\*\*Agreement between agents is not evidence\.\*\*/);
  for (const category of ['Source-proven defect', 'Runtime hypothesis', 'Owner-dependent business decision', 'Documentation drift', 'Unverified or deferred scope']) {
    assert.equal(protocol.split(`**${category}**`).length - 1, 1, category);
  }
  assert.match(fs.readFileSync(path.join(REVIEW_DIR, 'scripts', 'nthr.mjs'), 'utf8'), /^export const OFFICIAL_AUDITS_ENABLED = false;$/m);
  assert.match(protocol, /^\| Full Audit \(`audit-plan`, `audit-unit`\) \| \*\*Disabled\.\*\*/m);
  assert.match(protocol, /^\| Incremental Review, `\/nth-review incremental --base <run>` \| operational \(§10\)\./m);
  assert.match(skill, /Only `task`, `incremental` and `flow` \(BETA, §7\) run in this version\. `audit plan\|unit <id>\|close` is Full Audit \(\[protocol\.md\]\(reference\/protocol\.md\) §10\), which stays disabled until release: stop and say so\. Stop on anything else\./);
  assert.match(protocol, /^\| Suppressing an `accept`ed finding in later runs \(C3\) \| not implemented\./m, 'C3 is still marked not implemented');
  assert.match(protocol, /^\| R4 judgment critic \| written \(prompts\.md, R4\); it runs only in Full Audit Tier-1 units, so it is disabled with Full Audit \|$/m);
  assert.match(protocol, /^\| Full Audit \(`audit-plan`, `audit-unit`\) \| \*\*Disabled\.\*\* .* tested on synthetic fixtures only\. \|$/m);
  for (const [name, text] of [['protocol.md', protocol], ['routing.md', routing], ['prompts.md', prompts]]) {
    for (const line of text.split('\n').filter((l) => /\b(xhigh|max)\b/i.test(l))) assert.match(line, /\b(never|only for developing|means stop)\b/i, `${name}: ${line}`);
  }
});

test('every rule tag check cites is stated in records.md, and the protocol links there instead of repeating the rule list', () => {
  const tags = new Set([...read('scripts/lib/check.mjs').matchAll(/\(((?:C|N)\d+)(?:, (?:N\d+|as amended))?\)/g)].map((m) => m[1]));
  assert.ok(tags.size >= 10, [...tags].join(' '));
  for (const tag of tags) assert.match(records, new RegExp(`\\b${tag}\\b`), `records.md states ${tag}`);
  assert.ok(protocol.includes('[records.md](records.md#check-rules)') && routing.includes('records.md#check-rules'));
  for (const text of [protocol, routing, prompts]) assert.ok(!/^## `check` rules/m.test(text), 'no second copy of the check rules');
});

test('review fixes: R3 reads checkpointed records, triggers set the required model, refuter kinds map to records, the second refuter is the lead rule', () => {
  assert.match(skill, /Checkpoint three times: after step 2 \(R3 reads it\), after step 5, and before close\./);
  assert.match(skill, /You fill `run\.runtime`, `scope\.summary` and `intent`, the census, obligations, findings, `debt\.out` and `debt\.in` dispositions, delegations, checks and `budget\.spent`; `apply` refuses the helper's fields\./);
  assert.match(skill, /Record the delegation with `discovered`/);
  assert.match(skill, /With any trigger, set `run\.runtime\.required_lead_model` to `opus-high`/);
  assert.match(skill, /A refuter `kind` of `risk` → `kind: risk`, `severity: null`, `verification\.role: none`/);
  assert.match(skill, /run a second R5 with a new pack and record its answer/);
  assert.match(protocol, /This is the lead's rule; `check` does not enforce it\./);
  assert.ok(!/`check` enforces it/.test(prompts), 'prompts.md claims no check rule');
  assert.match(protocol, /`census\.recipes` with sequential ids \(`C1`, `C2`, …\)/);
});

test('M3-T5 Incremental in the skill: lead check before new-run, fresh, reassess every non-current obligation, current stays in the base, census of changed files', () => {
  const incremental = section(skill, '4. Incremental Review');
  assert.match(skill, /^argument-hint: "task --ns .* \| incremental --ns <ns> --slug <slug> --base <run-id> \| flow --ns <ns> --slug <slug> --entry .*"$/m);
  assert.match(skill, /For `incremental`, do the §2 check first \(it always needs Opus at high effort\), then run `new-run --ns <ns> --mode incremental --slug <slug> --base <run-id>`, without `--change`/);
  assert.match(incremental, /Run `fresh --run <run_dir>`, and `status --ns <ns>` once \(read-only; never run `decide`\)/);
  assert.match(incremental, /Debt-in is mandatory scope\./);
  // Every freshness class has its rule, and a base conclusion is never copied.
  for (const cls of VOCAB.freshClass) assert.ok(incremental.includes(`\`${cls}\``), `the skill handles ${cls}`);
  assert.match(incremental, /reset to `open` \/ `frontier`, `not-traced`, with no evidence/);
  assert.match(incremental, /cite the evidence again, with notes saying what you re-read, or reopen\. Never copy a conclusion: `check` refuses a dropped one, and a held or accepted one whose evidence is its origin's unchanged\./);
  assert.match(incremental, /Re-record every inherited obligation whose class is `touched`, `file-changed` or `assumption-changed` under its id, from its `origin` run \(the base when unset\)/);
  assert.match(incremental, /\*\*`current` obligations stay concluded in their origin run\.\*\* Re-record one only when a changed file's census item bears on it/);
  assert.match(incremental, /record the finding again as a `candidate` with the same fingerprint and verify it \(§3\.5\)/);
  assert.match(incremental, /\*\*Census\*\* every file in `freshness\.changed_files`/);
  assert.match(incremental, /Run R3 \(§3\.3\) when new write or authorization paths appear\./);
  assert.match(skill, /Of `freshness`, you may only set a class to `assumption-changed`, with its reason\./);
  // The protocol holds the order; its ten steps are the research order.
  const order = [...section(protocol, '10. Modes').matchAll(/^(\d+)\. (\w+)/gm)].map((m) => m[2]);
  assert.deepEqual(order.slice(0, 10), ['Open', 'Run', 'Debt', 'Reassess', 'Census', 'Outline', 'Plan', 'Discharge', 'Verify', 'Close']);
  assert.ok(!/Chain limitation/.test(protocol), 'the chain gap is closed, not documented as a limitation');
  assert.match(records, /an obligation recorded under an inherited id, whatever its class, keeps that version's `claim`/);
  assert.match(incremental, /New obligations use ids the effective baseline does not use \(`check` refuses another claim under an inherited id\)\./);
  assert.match(section(protocol, '10. Modes'), /A `current` obligation stays concluded in its origin run, and the report names that run\. Later Incremental runs still find it there, through the effective baseline\./);
  assert.match(protocol, /\*\*Effective baseline:\*\* the latest recorded version of every obligation along the base ancestry/);
  assert.match(records, /\*\*Effective baseline\.\*\* The latest recorded version of every obligation inherited through the base ancestry/);
  assert.match(records, /every entry whose class is not `current` is re-recorded under its id, and a `held` or `accepted` one does not carry its origin version's `evidence` unchanged, in any order/);
  assert.match(records, /`freshness\.obligations` names each of its obligations exactly once, with no other id, and with its resolved origin/);
});

test('M3-T5 continuing a run: resume first, ask before abandoning, apply an interrupted one, re-check the lead; nothing switches models automatically', () => {
  const runs = read('scripts/lib/runs.mjs');
  const resume = read('scripts/lib/resume.mjs');
  // The refusals the skill reacts to are the helper's own words.
  for (const phrase of ['is still open in', 'no run continues it']) assert.ok(runs.includes(phrase), phrase);
  assert.match(skill, /If it refuses because a run is "still open", or was abandoned and "no run continues it", continue that run as \[protocol\.md\]\(reference\/protocol\.md\) §11 says\./);
  const cont = section(protocol, '11. Continuing a run');
  assert.match(cont, /Run `resume --ns <ns>`, without `--apply`\. It writes nothing\. With `continue`, `run` and `run_dir` name the run to work in\. With `abandon`, they name the run to be abandoned, which is history/);
  assert.match(cont, /Tell the user which run this is \(its id, mode and scope\) and ask once before working in it/);
  assert.match(cont, /work in the continuation, the `run_dir` that `--apply` prints/);
  assert.match(skill, /never work around it, except the `new-run` refusals in §1 and the close refusals in §3\.6\./);
  assert.match(cont, /Check your model against its `required_lead_model` first\. On a mismatch, stop/);
  assert.match(cont, /In an Incremental run, run `fresh` again\./);
  assert.match(cont, /and ask once, because abandoning cannot be undone\. Only on their go-ahead, run `resume --ns <ns> --apply`\./);
  assert.match(cont, /\*\*`abandon` with cause `interrupted`\*\* .* run `resume --ns <ns> --apply` without asking\./);
  for (const value of ["action: 'continue'", "action: 'abandon'", "cause: 'interrupted'"]) assert.ok(resume.includes(value), `resume answers ${value}`);
  for (const cause of ['tracked-changed', 'cited-untracked']) assert.ok(resume.includes(`'${cause}'`), `resume cause ${cause}`);
  assert.match(cont, /An audit mode follows §10, which means stop while official audits are disabled\./);
  // Escalation continues only through a new session the user starts.
  assert.match(routing, /1\. The user starts a new session on Opus at high effort and runs the skill again\./);
  assert.match(routing, /A Sonnet lead cannot close the run as `incomplete` with reason `escalation`/);
  for (const [name, text] of [['SKILL.md', skill], ['protocol.md', protocol], ['routing.md', routing]]) {
    for (const line of text.split('\n').filter((l) => /automatic/i.test(l))) assert.match(line, /\b(nothing|never|not|no)\b/i, `${name} claims automatic behaviour: ${line}`);
  }
  assert.match(skill, /You never change models yourself, and nothing switches them automatically\./);
});

test('taxonomy.md: the RT1–RT12 runtime catalog is kept as guidance, explicitly deferred, and cites current check ids', () => {
  const catalog = section(taxonomy, 'Runtime validation catalog (deferred)');
  assert.deepEqual([...catalog.matchAll(/^\| (RT\d+) \|/gm)].map((m) => m[1]), Array.from({ length: 12 }, (_, i) => `RT${i + 1}`));
  assert.match(catalog, /\*\*nth-review runs none of them:\*\* the experiment harness is deferred from v1/);
  assert.match(catalog, /A `needs_validation` finding names the RT id in its `validation_plan`; `runtime` debt names it in `requires`\./);
  assert.match(catalog, /RT12 is not an experiment: record an `environment` assumption with `observed: unknown`, and `owner-fact` debt\./);
  assert.match(catalog, /the owner's authorization and an \*\*isolated environment\*\*/);
  const defined = definedChecks();
  for (const row of catalog.split('\n').filter((l) => /^\| RT\d+ \|/.test(l))) {
    for (const id of row.split(' | ')[2].split(', ')) assert.ok(defined.has(id) || FAMILIES.includes(id), `${row.slice(0, 7)} cites ${id}`);
  }
  assert.match(taxonomy, /The experiments that would settle it are listed, and deferred, in the runtime validation catalog below\./);
});

test('routing.md tells the truth about escalation: a Sonnet lead cannot close a triggered run, and an Opus lead continues it', (t) => {
  const root = fs.realpathSync.native(makeRepo(path.join(makeTempDir(t), 'p'), { 'src/a.js': 'a\n' }));
  const opened = nthr(['new-run', '--ns', 'experiments/esc', '--mode', 'task', '--slug', 'e', '--change', '.'], { cwd: root, now: at(1) });
  assert.equal(opened.json.result.required_lead_model, 'sonnet');
  const runDir = opened.json.result.run_dir;
  const doc = readRecords(root, runDir);
  doc.run.runtime = { ...doc.run.runtime, lead_model: 'claude-sonnet-5-5', lead_effort: 'unknown', triggers: ['authorization'], required_lead_model: 'opus-high' };
  writeRecords(root, runDir, doc);
  const closed = nthr(['close', '--run', runDir, '--status', 'incomplete', '--reason', 'escalation'], { cwd: root, now: at(2) });
  assert.equal(closed.code, EXIT.INVALID, JSON.stringify(closed.json));
  assert.ok(closed.json.errors.some((e) => /does not meet the required opus-high/.test(e)));
  // The user's new session: new-run refuses (still open), resume answers continue, and the new lead records itself.
  const again = nthr(['new-run', '--ns', 'experiments/esc', '--mode', 'task', '--slug', 'e2', '--change', '.'], { cwd: root, now: at(3) });
  assert.equal(again.code, EXIT.USAGE);
  assert.match(again.json.errors[0], /is still open in experiments\/esc/);
  const resumed = nthr(['resume', '--ns', 'experiments/esc'], { cwd: root, now: at(3) }).json.result;
  assert.equal(resumed.action, 'continue');
  assert.equal(resumed.run, runDir.split('/').pop());
  const picked = readRecords(root, runDir);
  picked.run.runtime = { ...picked.run.runtime, lead_model: 'claude-opus-5-5', lead_effort: 'high' };
  writeRecords(root, runDir, picked);
  const checked = nthr(['check', '--run', runDir], { cwd: root });
  assert.ok(!checked.json.errors?.some((e) => /required opus-high/.test(e)), JSON.stringify(checked.json));
  assert.equal(readRecords(root, runDir).run.runtime.triggers[0], 'authorization', 'the escalation trigger stays recorded');
});

test('M3-T6 Full Audit: the procedure, the ledger rules, R4 kept apart from R3 and R5/R6, and reports that never claim the whole audit', () => {
  const audit = protocol.slice(protocol.indexOf('**Full Audit** (`audits/<id>`, chartered).'), protocol.indexOf('## 11. Continuing a run'));
  // Authorization and the chain.
  assert.match(audit, /\*\*Disabled\*\* until the release criteria pass \(C19\)/);
  assert.match(audit, /only the owner's `charter` \(`--owner`, `--scope`, `--exclusions`, `--official`\); a partial or hand-made charter is refused\. The lead never runs `charter`\./);
  assert.match(audit, /\*\*One linear chain\*\* \(C20\): the plan is the root, and every later audit run names the chain head as `--base`/);
  // Plan: owner scope and exclusions, census without exhaustive claims, the ledger, nothing reviewed.
  assert.match(audit, /Show the owner the charter's scope and exclusions, and record them in `scope\.summary`/);
  assert.match(audit, /Discovery never proves that nothing else exists: unknown items stay `unknown`\./);
  assert.match(audit, /It never drops a unit, rewrites `runs`, or concludes a unit\./);
  assert.match(audit, /The plan reviews no unit\./);
  // Unit: gating, the ledger owned by close, R4 outcomes.
  assert.match(audit, /The helper refuses a unit that is not `planned` or `incomplete`, or whose dependencies are not all `complete`\./);
  assert.match(audit, /Never edit the ledger\. `close` records the unit/);
  assert.match(audit, /A Tier-1 unit closes `complete` only after a completed R4 \(`check`\)\. Each challenge is input, never a verdict:/);
  assert.match(audit, /a severity challenge: run a new R5 on that finding \(§7\); never change the severity on R4's word\./);
  assert.match(audit, /R4 never confirms, rejects or upgrades anything\. A closure it does not challenge is no stronger for it\./);
  // Close and reports.
  assert.match(audit, /If a file its last run cited changed, or cannot be verified, the unit becomes `incomplete`, with the reason\./);
  assert.match(audit, /No report calls the whole audit "Verified"\. Out-of-scope units are listed as not reviewed\./);
  assert.match(audit, /It never puts an existing unit out of scope \(the owner's exclusions are fixed in the charter; defer it instead\), and never lowers a unit's priority, so a Tier-1 unit cannot shed R4\./);
  assert.match(audit, /the audit close records no obligation of its own\./);
  // Tiers: a reviewable basis, checked for presence and form only, never inferred from names.
  assert.match(audit, /\*\*Tier basis:\*\* every active unit \(any status but `out_of_scope`\) gets a tier and its `basis`/);
  assert.match(audit, /A file name or a dependency name alone is no basis\. When nothing documents the unit's criticality, the note says so\./);
  assert.match(audit, /It never judges whether the tier is right, and never infers risk from names/);
  assert.match(audit, /It also refuses an unclassified unit \(no tier or no basis\): classify it in a re-plan first\./);
  assert.match(audit, /Its report lists, per unit, what that unit's last run left unresolved/);
  assert.match(audit, /every audit report says it is not an official audit\./);
  assert.match(protocol, /A unit run's `complete` is blocked only by carried debt from an earlier run of the \*\*same\*\* unit, and a plan run's by none\. The audit close keeps the strict rule\./);
  // R4 stays separate: its own template and questions, never a finding verification role.
  const r4 = section(prompts, 'R4 judgment critic');
  assert.match(r4, /It judges the reasoning; coverage of the outline is R3's, and refuting a finding is R5's or R6's\./);
  assert.match(r4, /"kind": "weak-closure\|coverage\|missing-path\|assumption\|severity"/);
  assert.match(r4, /Agreeing with the review proves nothing, and a closure you do not challenge is no stronger for it\./);
  assert.ok(!VOCAB.verificationRole.includes('R4'), 'R4 never verifies a finding');
  assert.match(section(prompts, 'R3 plan-critique'), /\*\*In Full Audit\*\* .* which census surface belongs to no unit, and which exclusion has no owner reason\./);
  // Records name the rules check and close implement.
  for (const rule of [
    /`close` is reserved: it names the audit close \(`--unit close`\) and is never a ledger unit\./,
    /the audit chain would fork or get a second root\. The base must be the chain head/,
    /a Tier-1 unit run closes `complete` only with a completed R4 delegation;/,
    /the audit close changes no unit, except a `complete` one downgraded to `incomplete` with a reason, and records no obligation of its own\./,
    /It never puts an existing unit `out_of_scope` \(the charter's exclusions are fixed; a new unit may start out of scope\), and never lowers a unit's priority/,
    /`--continues` names only the abandoned run this run carries on \(same mode, base and unit, as `resume` opens it\)/,
    /the namespace is `audits\/…` while official audits are disabled, or without a complete owner charter: an official audit answers nothing then, not even `continue`;/,
    /at least one unit `complete`, every `complete` unit classified, and is not empty when its ledger is not\./,
    /`check` requires a tier and a basis for every active unit \(any status but `out_of_scope`\) of a plan run that closes `complete`; it checks presence and form, never whether the tier is right, nor whether a basis anchor exists\./,
    /Basis anchors are not cited: they classify a unit, they are not review evidence\./,
    /a re-plan that raises a `complete` unit to Tier 1 reopens it \(`planned`\);/,
    /no obligation of a plan or of the audit close is ever shown as Verified;/,
    /`--exclusions` is explicit: what the owner excludes, or "none"\./,
    /They admit only a complete charter \(every field valid\) that names this namespace/,
    /"Verified" is never said of the whole audit, and no obligation of a plan or of the audit close/,
  ]) assert.match(records, rule);
  // Disabled: the switch, the skill entry.
  assert.match(fs.readFileSync(path.join(REVIEW_DIR, 'scripts', 'nthr.mjs'), 'utf8'), /^export const OFFICIAL_AUDITS_ENABLED = false;$/m);
  assert.match(skill, /which stays disabled until release: stop and say so/);
  assert.ok(!/^argument-hint: .*audit/m.test(skill), 'the frontmatter does not offer a disabled mode');
});
