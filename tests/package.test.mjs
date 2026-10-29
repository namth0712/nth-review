// The package (INSTALL.md, Package): a Claude Code plugin, disabled by
// default, whose only components are the manual skill /nth-review:project and
// the read-only agent nth-review:reviewer, at the helper's version,
// MIT-licensed to its author, with a current runtime manifest; and Enable
// reads only such an installed package. Each check is a pure function: the
// real files pass it, and a deliberate mutation fails it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { VERSION } from '../scripts/lib/schema.mjs';
import { makePackageCache } from './helpers/library.mjs';
import { REVIEW_DIR, makeTempDir } from './helpers/tmp.mjs';
import { Stop, loadPackage } from './m4/operator.mjs';
import { MANIFEST, buildManifest, lfDigest, manifestText, packageFiles } from './tools/runtime-manifest.mjs';

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, ...rel.split('/')), 'utf8'));
const readText = (rel) => fs.readFileSync(path.join(REVIEW_DIR, ...rel.split('/')), 'utf8');
// Root folders Claude Code loads as plugin components by default: none may exist.
const COMPONENTS = ['skills', 'commands', 'agents', 'hooks', 'monitors', 'bin', 'output-styles', 'themes', 'workflows', '.mcp.json', '.lsp.json', 'settings.json'];
const AUTHOR = { name: 'namth0712', url: 'https://github.com/namth0712' };
const REPO = 'https://github.com/namth0712/nth-review';
const COMPONENT_KEYS = ['commands', 'hooks', 'mcpServers', 'lspServers', 'monitors', 'outputStyles'];
// The bundled agent nth-review:reviewer, pinned: a change to it is a new release candidate (routing.md).
const AGENTS = ['./plugin-agents/reviewer.md'];
const AGENT_SHA256 = '912eddae1f78fe808613dde430d87ba736efd247aa236a7665a51cb7af7f0aaf';
const AGENT_FIELDS = ['name: reviewer', 'model: sonnet', 'tools: Read, Grep, Glob, Bash, PowerShell', 'maxTurns: 12'];

function packageProblems({ plugin, marketplace, rootEntries, attributes, pluginSkills, pluginAgents, license }) {
  const problems = [];
  if (plugin.name !== 'nth-review') problems.push('plugin name');
  if (plugin.version !== VERSION) problems.push(`plugin version ${plugin.version}, helper ${VERSION}`);
  if (plugin.defaultEnabled !== false) problems.push('the plugin is enabled by default');
  if (JSON.stringify(plugin.skills) !== JSON.stringify(['./plugin-skills/'])) problems.push('plugin skills must be exactly ["./plugin-skills/"]: the root SKILL.md must never load as a plugin skill');
  for (const key of COMPONENT_KEYS) if (plugin[key] !== undefined) problems.push(`plugin.json declares ${key}`);
  for (const entry of COMPONENTS.filter((c) => rootEntries.includes(c))) problems.push(`a plugin component at the root: ${entry}`);
  // The only plugin skill: /nth-review:project, manual only, pointing at the installed INSTALL.md.
  const names = Object.keys(pluginSkills);
  if (JSON.stringify(names) !== JSON.stringify(['project/SKILL.md'])) problems.push(`plugin-skills holds ${names.join(', ') || 'nothing'}, not exactly project/SKILL.md`);
  const skill = pluginSkills['project/SKILL.md'] ?? '';
  if (!/^---\nname: project\n/.test(skill)) problems.push('the plugin skill is not named project');
  if (!/^disable-model-invocation: true$/m.test(skill)) problems.push('the plugin skill can be invoked by the model');
  if (/^allowed-tools:/m.test(skill)) problems.push('the plugin skill pre-approves tools');
  if (!skill.includes('${CLAUDE_PLUGIN_ROOT}/INSTALL.md')) problems.push('the plugin skill does not follow the installed INSTALL.md');
  if (!/Never start a review\./.test(skill)) problems.push('the plugin skill may start a review');
  // The only plugin agent: nth-review:reviewer, read-only, restricted by its description to nth-review's delegations.
  if (JSON.stringify(plugin.agents) !== JSON.stringify(AGENTS)) problems.push(`plugin agents must be exactly ${JSON.stringify(AGENTS)}`);
  if (JSON.stringify(Object.keys(pluginAgents)) !== JSON.stringify(['reviewer.md'])) problems.push(`plugin-agents holds ${Object.keys(pluginAgents).join(', ') || 'nothing'}, not exactly reviewer.md`);
  const agent = pluginAgents['reviewer.md'] ?? '';
  const front = /^---\n([\s\S]*?)\n---\n/.exec(agent)?.[1] ?? '';
  for (const field of AGENT_FIELDS) if (!front.split('\n').includes(field)) problems.push(`the agent lacks "${field}"`);
  if (/^(hooks|mcpServers|permissionMode|skills|memory|isolation|background|initialPrompt):/m.test(front)) problems.push('the agent declares hooks, servers, permissions, skills, memory or isolation');
  if (!/^description: .*nth-review.*never for any other request/m.test(front)) problems.push('the agent description does not restrict it to nth-review');
  for (const rule of ['- Do not edit files.', '- Do not spawn other agents.', '- Never run `git add`']) if (!agent.includes(rule)) problems.push(`the agent lacks the rule "${rule}"`);
  if (lfDigest(Buffer.from(agent)) !== AGENT_SHA256) problems.push('the agent changed: a new release candidate, then update AGENT_SHA256 and CHANGELOG.md');
  // Attribution and license.
  if (JSON.stringify(plugin.author) !== JSON.stringify(AUTHOR) || plugin.license !== 'MIT' || plugin.homepage !== REPO || plugin.repository !== REPO) problems.push('plugin.json author, license, homepage or repository');
  if (!/^MIT License\n\nCopyright \(c\) 2026 namth0712\n\nPermission is hereby granted, free of charge,/.test(license) || !/THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/.test(license)) problems.push('LICENSE is not the MIT text for namth0712');
  if (marketplace.name !== 'nth-review' || JSON.stringify(marketplace.owner) !== JSON.stringify(AUTHOR)) problems.push('marketplace name or owner');
  const entries = marketplace.plugins ?? [];
  if (entries.length !== 1 || entries[0].name !== 'nth-review' || entries[0].source !== './') problems.push('marketplace entry');
  if (entries[0]?.version !== undefined || entries[0]?.defaultEnabled === true || [...COMPONENT_KEYS, 'skills', 'agents'].some((k) => entries[0]?.[k] !== undefined)) problems.push('the marketplace entry overrides the plugin');
  if (JSON.stringify(entries[0]?.author) !== JSON.stringify(AUTHOR) || entries[0]?.license !== 'MIT') problems.push('marketplace entry author or license');
  if (!/^\* -text$/m.test(attributes)) problems.push('.gitattributes must keep every byte (* -text)');
  return problems;
}

function pluginSkillFiles(dir = path.join(REVIEW_DIR, 'plugin-skills'), prefix = '') {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(out, pluginSkillFiles(path.join(dir, e.name), `${prefix}${e.name}/`));
    else out[`${prefix}${e.name}`] = fs.readFileSync(path.join(dir, e.name), 'utf8');
  }
  return out;
}

test('package: disabled by default, one manual plugin skill and one read-only agent, at the helper version, MIT-licensed to namth0712; mutations fail', () => {
  const real = {
    plugin: readJson('.claude-plugin/plugin.json'),
    marketplace: readJson('.claude-plugin/marketplace.json'),
    rootEntries: fs.readdirSync(REVIEW_DIR),
    attributes: readText('.gitattributes'),
    pluginSkills: pluginSkillFiles(),
    pluginAgents: pluginSkillFiles(path.join(REVIEW_DIR, 'plugin-agents')),
    license: readText('LICENSE'),
  };
  assert.deepEqual(packageProblems(real), []);
  const variant = (edit) => { const v = structuredClone(real); edit(v); return packageProblems(v); };
  const skillsRule = 'plugin skills must be exactly ["./plugin-skills/"]: the root SKILL.md must never load as a plugin skill';
  assert.deepEqual(variant((v) => { v.plugin.defaultEnabled = true; }), ['the plugin is enabled by default']);
  assert.deepEqual(variant((v) => { delete v.plugin.skills; }), [skillsRule]);
  assert.deepEqual(variant((v) => { v.plugin.skills = ['./']; }), [skillsRule]);
  assert.deepEqual(variant((v) => { v.plugin.skills = []; }), [skillsRule]);
  assert.deepEqual(variant((v) => { v.plugin.version = '1.0.0'; }), [`plugin version 1.0.0, helper ${VERSION}`]);
  assert.deepEqual(variant((v) => { v.rootEntries.push('hooks'); }), ['a plugin component at the root: hooks']);
  assert.deepEqual(variant((v) => { v.plugin.hooks = './h.json'; }), ['plugin.json declares hooks']);
  assert.deepEqual(variant((v) => { v.marketplace.plugins[0].defaultEnabled = true; }), ['the marketplace entry overrides the plugin']);
  assert.deepEqual(variant((v) => { v.marketplace.plugins[0].skills = ['./']; }), ['the marketplace entry overrides the plugin']);
  assert.deepEqual(variant((v) => { v.pluginSkills['review/SKILL.md'] = 'x'; }), ['plugin-skills holds project/SKILL.md, review/SKILL.md, not exactly project/SKILL.md']);
  assert.deepEqual(variant((v) => { v.pluginSkills['project/SKILL.md'] = v.pluginSkills['project/SKILL.md'].replace('disable-model-invocation: true', 'disable-model-invocation: false'); }), ['the plugin skill can be invoked by the model']);
  assert.deepEqual(variant((v) => { v.pluginSkills['project/SKILL.md'] = v.pluginSkills['project/SKILL.md'].replace('argument-hint:', 'allowed-tools: Bash\nargument-hint:'); }), ['the plugin skill pre-approves tools']);
  assert.deepEqual(variant((v) => { v.plugin.license = 'Apache-2.0'; }), ['plugin.json author, license, homepage or repository']);
  assert.deepEqual(variant((v) => { v.license = v.license.replace('namth0712', 'someone'); }), ['LICENSE is not the MIT text for namth0712']);
  assert.deepEqual(variant((v) => { v.marketplace.owner = { name: 'someone-else' }; }), ['marketplace name or owner']);
  // The bundled agent.
  const agentsRule = `plugin agents must be exactly ${JSON.stringify(AGENTS)}`;
  const changed = 'the agent changed: a new release candidate, then update AGENT_SHA256 and CHANGELOG.md';
  assert.deepEqual(variant((v) => { delete v.plugin.agents; }), [agentsRule]);
  assert.deepEqual(variant((v) => { v.plugin.agents = ['./plugin-agents/reviewer.md', './plugin-agents/other.md']; }), [agentsRule]);
  assert.deepEqual(variant((v) => { v.pluginAgents['other.md'] = 'x'; }), ['plugin-agents holds reviewer.md, other.md, not exactly reviewer.md']);
  assert.deepEqual(variant((v) => { v.marketplace.plugins[0].agents = []; }), ['the marketplace entry overrides the plugin']);
  const agentEdit = (a, b) => variant((v) => { v.pluginAgents['reviewer.md'] = v.pluginAgents['reviewer.md'].replace(a, b); });
  assert.deepEqual(agentEdit('tools: Read, Grep, Glob, Bash, PowerShell', 'tools: Read, Grep, Glob, Bash, PowerShell, Edit'), ['the agent lacks "tools: Read, Grep, Glob, Bash, PowerShell"', changed]);
  assert.deepEqual(agentEdit('maxTurns: 12', 'maxTurns: 30'), ['the agent lacks "maxTurns: 12"', changed]);
  assert.deepEqual(agentEdit('maxTurns: 12\n', 'maxTurns: 12\nhooks: ./h.json\n'), ['the agent declares hooks, servers, permissions, skills, memory or isolation', changed]);
  assert.deepEqual(agentEdit('never for any other request', 'or for any request'), ['the agent description does not restrict it to nth-review', changed]);
  assert.deepEqual(agentEdit('- Do not edit files.\n', ''), ['the agent lacks the rule "- Do not edit files."', changed]);
  assert.deepEqual(agentEdit('Minimize file reads.', 'Read every file.'), [changed]);
});

test('package: runtime-manifest.json is current, and lists exactly INSTALL.md and the 27 runtime files', () => {
  assert.equal(fs.readFileSync(path.join(REVIEW_DIR, MANIFEST), 'utf8'), manifestText(), 'stale: node tests/tools/runtime-manifest.mjs --write');
  const manifest = buildManifest();
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(Object.keys(manifest.files), packageFiles());
  assert.equal(Object.keys(manifest.files).length, 28);
});

test('package: Enable reads an installed package only from the plugin cache, verified against its manifest', (t) => {
  const config = makeTempDir(t, 'nthr-pkg-');
  const dir = makePackageCache(config);
  const lib = loadPackage(config);
  assert.equal(lib.sorted.length, 27);
  assert.equal(lib.version, VERSION);
  assert.equal(fs.realpathSync(lib.root), fs.realpathSync(dir));
  // The registry pointing at this repository (a source checkout) is refused.
  const registry = path.join(config, 'plugins', 'installed_plugins.json');
  const doc = JSON.parse(fs.readFileSync(registry, 'utf8'));
  doc.plugins['nth-review@nth-review'][0].installPath = REVIEW_DIR;
  fs.writeFileSync(registry, JSON.stringify(doc));
  assert.throws(() => loadPackage(config), (e) => e instanceof Stop && e.items.some((i) => /not inside <config>\/plugins\/cache/.test(i)));
  assert.throws(() => loadPackage(makeTempDir(t, 'nthr-none-')), (e) => e instanceof Stop && /not installed/.test(e.items[0]));
});
