// VS1 fixture builder. Library-only test tooling; Enable never copies it.
//
// Builds a disposable two-repository project for the VS1 demo:
//   <target>/                      a plain directory, outside every repository
//     .claude/skills/nth-review/   project-level copy of the skill's runtime files (D4)
//     api/                         repository: an HTTP API; its last commit adds two resource routes
//     web/                         repository: the client; its last commit calls those routes
//
// The review session must not see the expected answer. It lives only here
// (PLANTED, CONTROL) and in verify.mjs, never inside the fixture.
//
// Usage: node tests/vs1/fixture.mjs [<new or empty directory>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitAll, makeRepo, write } from '../helpers/repo.mjs';
import { REVIEW_DIR } from '../helpers/tmp.mjs';

// What Enable copies: the skill's runtime files, never tests/ or VALIDATION.md.
export const RUNTIME_FILES = Object.freeze(['SKILL.md', 'reference', 'scripts']);
export const SKILL_PATH = '.claude/skills/nth-review';
export const VS1 = Object.freeze({
  ns: 'experiments/vs1',
  slug: 'vs1',
  changes: ['api:HEAD~1..HEAD', 'web:HEAD~1..HEAD'],
});
// The expected answer (kept out of the fixture).
export const PLANTED = Object.freeze({ path: 'api/src/routes/invoices.js', symbol: 'getInvoice' });
export const CONTROL = Object.freeze({ path: 'api/src/routes/orders.js', symbol: 'getOrder' });

export const VS1_COMMAND = `/nth-review task --ns ${VS1.ns} --slug ${VS1.slug} ${VS1.changes.map((c) => `--change ${c}`).join(' ')}`;

const API_BASE = {
  'README.md': '# Billing API\n\nA small HTTP API for accounts, orders and invoices.\n',
  'docs/authorization.md': [
    '# Authorization',
    '',
    '## Sessions',
    '',
    'Every route except `/health` requires a session (`requireSession` in `src/session.js`).',
    '',
    '## Resource ownership',
    '',
    'Orders and invoices belong to exactly one account. A handler that reads or changes one of them',
    'loads it and compares its `accountId` with `session.accountId` before using it. When they',
    'differ, the handler answers 404, exactly as if the record did not exist.',
    '',
  ].join('\n'),
  'src/http.js': [
    'export function notFound() {',
    "  const error = new Error('not found');",
    '  error.status = 404;',
    '  return error;',
    '}',
    '',
  ].join('\n'),
  'src/session.js': [
    'const sessions = new Map();',
    '',
    'export function startSession(token, accountId) {',
    '  sessions.set(token, { accountId });',
    '}',
    '',
    'export function requireSession(req) {',
    "  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');",
    '  const session = sessions.get(token);',
    '  if (!session) {',
    "    const error = new Error('unauthenticated');",
    '    error.status = 401;',
    '    throw error;',
    '  }',
    '  return session;',
    '}',
    '',
  ].join('\n'),
  'src/store.js': [
    'const orders = new Map();',
    'const invoices = new Map();',
    '',
    'export const findOrder = (id) => orders.get(id) ?? null;',
    'export const findInvoice = (id) => invoices.get(id) ?? null;',
    'export const saveOrder = (order) => orders.set(order.id, order);',
    'export const saveInvoice = (invoice) => invoices.set(invoice.id, invoice);',
    '',
  ].join('\n'),
  'src/routes/index.js': [
    'export const routes = [',
    "  { method: 'GET', pattern: /^\\/health$/, handler: () => ({ status: 200, body: { ok: true } }) },",
    '];',
    '',
  ].join('\n'),
  'src/server.js': [
    "import { routes } from './routes/index.js';",
    '',
    'export function handle(req) {',
    "  const url = new URL(req.url, 'http://localhost');",
    '  for (const route of routes) {',
    '    const match = route.pattern.exec(url.pathname);',
    '    if (match && route.method === req.method) return route.handler(req, match.groups ?? {});',
    '  }',
    "  return { status: 404, body: { error: 'not found' } };",
    '}',
    '',
  ].join('\n'),
};

const API_CHANGE = {
  'src/routes/orders.js': [
    "import { notFound } from '../http.js';",
    "import { requireSession } from '../session.js';",
    "import { findOrder } from '../store.js';",
    '',
    'export function getOrder(req, params) {',
    '  const session = requireSession(req);',
    '  const order = findOrder(params.id);',
    '  if (!order || order.accountId !== session.accountId) throw notFound();',
    '  return { status: 200, body: order };',
    '}',
    '',
  ].join('\n'),
  'src/routes/invoices.js': [
    "import { notFound } from '../http.js';",
    "import { requireSession } from '../session.js';",
    "import { findInvoice } from '../store.js';",
    '',
    'export function getInvoice(req, params) {',
    '  requireSession(req);',
    '  const invoice = findInvoice(params.id);',
    '  if (!invoice) throw notFound();',
    '  return { status: 200, body: invoice };',
    '}',
    '',
  ].join('\n'),
  'src/routes/index.js': [
    "import { getInvoice } from './invoices.js';",
    "import { getOrder } from './orders.js';",
    '',
    'export const routes = [',
    "  { method: 'GET', pattern: /^\\/health$/, handler: () => ({ status: 200, body: { ok: true } }) },",
    "  { method: 'GET', pattern: /^\\/orders\\/(?<id>[\\w-]+)$/, handler: getOrder },",
    "  { method: 'GET', pattern: /^\\/invoices\\/(?<id>[\\w-]+)$/, handler: getInvoice },",
    '];',
    '',
  ].join('\n'),
};

const WEB_BASE = {
  'README.md': '# Billing web\n\nThe browser client of the billing API.\n',
  'src/api.js': [
    'export async function getJson(path, token) {',
    "  const response = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` } });",
    '  if (!response.ok) throw new Error(`request failed: ${response.status}`);',
    '  return response.json();',
    '}',
    '',
  ].join('\n'),
};

const WEB_CHANGE = {
  'src/pages/order.js': [
    "import { getJson } from '../api.js';",
    '',
    'export async function showOrder(id, token) {',
    '  const order = await getJson(`/orders/${encodeURIComponent(id)}`, token);',
    '  return `Order ${order.id}: ${order.total}`;',
    '}',
    '',
  ].join('\n'),
  'src/pages/invoice.js': [
    "import { getJson } from '../api.js';",
    '',
    'export async function showInvoice(id, token) {',
    '  const invoice = await getJson(`/invoices/${encodeURIComponent(id)}`, token);',
    '  return `Invoice ${invoice.id}: ${invoice.amount}`;',
    '}',
    '',
  ].join('\n'),
};

function insideWorkTree(dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: probe, encoding: 'utf8', windowsHide: true });
  return result.status === 0 && result.stdout.trim() === 'true';
}

// Builds the fixture in `target` (absent or empty, outside every repository)
// and returns its real path.
export function buildVs1Fixture(target) {
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`${target} is not empty`);
  if (insideWorkTree(path.resolve(target))) throw new Error(`${target} is inside a git working tree; build the fixture outside every repository`);
  fs.mkdirSync(target, { recursive: true });
  const root = fs.realpathSync.native(target);

  for (const [name, base, change, message] of [
    ['api', API_BASE, API_CHANGE, 'Add order and invoice routes'],
    ['web', WEB_BASE, WEB_CHANGE, 'Add order and invoice pages'],
  ]) {
    const repo = makeRepo(path.join(root, name), base);
    for (const [rel, content] of Object.entries(change)) write(repo, rel, content);
    commitAll(repo, message);
  }
  const skillDir = path.join(root, ...SKILL_PATH.split('/'));
  for (const entry of RUNTIME_FILES) {
    fs.cpSync(path.join(REVIEW_DIR, entry), path.join(skillDir, entry), { recursive: true });
  }
  return root;
}

// The 1-based line range of `export function <symbol>` up to its closing brace.
export function symbolLines(file, symbol) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`export function ${symbol}(`));
  if (start === -1) throw new Error(`${symbol} not found in ${file}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return [start + 1, end + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nthr-vs1-'));
  const root = buildVs1Fixture(target);
  process.stdout.write(`${JSON.stringify({
    fixture: root,
    next: [
      `In a new terminal, outside this development session: cd "${root}"`,
      'Start an isolated Claude Code session on Opus with effort high (choose it in /model; never xhigh or max), for example: claude --model opus',
      `Run: ${VS1_COMMAND}`,
      `Afterwards: node "${path.join(REVIEW_DIR, 'tests', 'vs1', 'verify.mjs')}" "${root}"`,
    ],
  }, null, 2)}\n`);
}
