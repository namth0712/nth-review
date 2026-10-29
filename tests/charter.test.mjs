// `charter` (M2-T7; decisions N3, C19): official audit namespaces are gated.
// OFFICIAL_AUDITS_ENABLED stays false in nthr.mjs, so a charter is refused by
// default; success is tested only through the injected test gate (`official`
// in the in-process CLI). A charter is never replaced, only starts a new
// audits/ namespace, and is never created by new-run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../scripts/lib/cli.mjs';
import { FsGuardError, writeAtomic } from '../scripts/lib/fsguard.mjs';
import { readCharter } from '../scripts/lib/runs.mjs';
import { makeRepo } from './helpers/repo.mjs';
import { at, nthr, readRecords } from './helpers/runs.mjs';
import { NTHR, makeTempDir, runNthr } from './helpers/tmp.mjs';

const project = (t) => fs.realpathSync.native(makeRepo(path.join(makeTempDir(t), 'p'), { 'src/a.js': 'a\n' }));
const ARGS = ['--ns', 'audits/core', '--owner', 'Owner Name', '--scope', 'payments and ledger', '--exclusions', 'vendored code', '--official', '--profile', 'deep', '--budget-sessions', '12'];
const charter = (root, args, { official = true, second = 1 } = {}) => nthr(['charter', ...args], { cwd: root, now: at(second), official });
const charterFile = (root, ns = 'audits/core') => path.join(root, '.nth-review', ...ns.split('/'), 'charter.json');

test('refused by default: the release switch is off in nthr.mjs, in process and through the real entry point', (t) => {
  const root = project(t);
  assert.match(fs.readFileSync(NTHR, 'utf8'), /^export const OFFICIAL_AUDITS_ENABLED = false;$/m, 'the switch stays off');
  const inProcess = charter(root, ARGS, { official: false });
  assert.equal(inProcess.code, EXIT.USAGE);
  assert.match(inProcess.json.errors[0], /official audits are disabled: OFFICIAL_AUDITS_ENABLED is false/);
  const spawned = runNthr(['charter', ...ARGS], { cwd: root });
  assert.equal(spawned.code, EXIT.USAGE, spawned.stdout + spawned.stderr);
  assert.match(spawned.json.errors[0], /official audits are disabled/);
  assert.equal(fs.existsSync(path.join(root, '.nth-review', 'audits')), false, 'nothing created');
});

test('only an audits/ namespace, only with explicit authorization and complete arguments', (t) => {
  const root = project(t);
  const refused = (args, pattern) => {
    const r = charter(root, args);
    assert.equal(r.code, EXIT.USAGE, JSON.stringify(r.json));
    assert.match(r.json.errors[0], pattern);
    assert.equal(fs.existsSync(path.join(root, '.nth-review')), false, 'nothing written');
  };
  const without = (flag, withValue = true) => {
    const i = ARGS.indexOf(flag);
    return [...ARGS.slice(0, i), ...ARGS.slice(i + (withValue ? 2 : 1))];
  };
  refused(['--ns', 'reviews/core', ...ARGS.slice(2)], /only for an audits\/<id> namespace, not reviews\/core/);
  refused(['--ns', 'experiments/core', ...ARGS.slice(2)], /only for an audits\/<id> namespace/);
  refused(['--ns', 'audits/Bad!', ...ARGS.slice(2)], /namespace/i);
  refused(without('--official', false), /charter needs --official: the owner's explicit authorization/);
  refused(without('--owner'), /--owner is required/);
  refused(without('--scope'), /--scope is required/);
  refused(without('--exclusions'), /--exclusions is required: what the owner excludes from the audit, or "none"/);
  refused([...without('--profile'), '--profile', 'huge'], /--profile must be one of quick, standard, deep/);
  refused([...without('--budget-sessions'), '--budget-sessions', '0'], /--budget-sessions must be a whole number from 1 to 9999/);
});

test('with the injected gate: created once; new-run and check accept the namespace; never replaced', (t) => {
  const root = project(t);
  const created = charter(root, ARGS, { second: 1 });
  assert.equal(created.code, EXIT.OK, JSON.stringify(created.json));
  const stored = JSON.parse(fs.readFileSync(charterFile(root), 'utf8'));
  assert.deepEqual(stored, {
    schema: 'nth-review/charter@1', official: true, namespace: 'audits/core', owner: 'Owner Name',
    scope: 'payments and ledger', exclusions: 'vendored code', profile: 'deep', budget_sessions: 12, created: '2026-10-26T09:00:01Z',
  });
  assert.equal(readCharter(root, 'audits/core').valid, true);

  const opened = nthr(['new-run', '--ns', 'audits/core', '--mode', 'audit-plan', '--slug', 'plan'], { cwd: root, now: at(2), official: true });
  assert.equal(opened.code, EXIT.OK, JSON.stringify(opened.json));
  assert.equal(readRecords(root, opened.json.result.run_dir).run.profile, 'deep', 'the charter profile applies');
  assert.equal(nthr(['check', '--run', opened.json.result.run_dir], { cwd: root, official: true }).code, EXIT.OK);

  const bytes = fs.readFileSync(charterFile(root));
  const again = charter(root, ARGS, { second: 3 });
  assert.equal(again.code, EXIT.USAGE);
  assert.match(again.json.errors[0], /audits\/core is already chartered; a charter is never replaced/);
  assert.ok(fs.readFileSync(charterFile(root)).equals(bytes));

  // Even a racing writer cannot replace it: the exclusive write refuses an existing target.
  assert.throws(() => writeAtomic(root, 'audits/core/charter.json', '{}', { exclusive: true }), (e) => e instanceof FsGuardError && e.code === 'EXISTS');
  assert.ok(fs.readFileSync(charterFile(root)).equals(bytes));
  assert.deepEqual(fs.readdirSync(path.dirname(charterFile(root))).filter((n) => n.endsWith('.tmp')), []);
});

test('review fix: once the charter is linked into place, a stuck temporary name is not a failure', (t) => {
  const root = project(t);
  const realRm = fs.rmSync;
  let busy = true;
  t.mock.method(fs, 'rmSync', (target, ...rest) => {
    if (busy && String(target).endsWith('.tmp')) {
      busy = false;
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    }
    return realRm(target, ...rest);
  });
  const created = charter(root, ARGS);
  assert.equal(created.code, EXIT.OK, JSON.stringify(created.json));
  assert.equal(JSON.parse(fs.readFileSync(charterFile(root), 'utf8')).owner, 'Owner Name');
});

test('a namespace that already holds files is not chartered after the fact', (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, '.nth-review', 'audits', 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nth-review', 'audits', 'core', 'notes.txt'), 'x\n');
  const r = charter(root, ARGS);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.json.errors[0], /audits\/core already holds other files; a charter starts a new audit namespace/);
  assert.equal(fs.existsSync(charterFile(root)), false);
});

test('new-run never creates a charter, gate open or closed', (t) => {
  const root = project(t);
  for (const official of [false, true]) {
    const r = nthr(['new-run', '--ns', 'audits/core', '--mode', 'audit-plan', '--slug', 'plan'], { cwd: root, now: at(1), official });
    assert.equal(r.code, EXIT.USAGE, JSON.stringify(r.json));
    assert.match(r.json.errors[0], official ? /has no charter\.json; an official audit needs the owner's explicit charter command/ : /official audits are disabled/);
    assert.equal(fs.existsSync(path.join(root, '.nth-review', 'audits', 'core')), false);
  }
  assert.equal(nthr(['new-run', '--ns', 'experiments/e', '--mode', 'task', '--slug', 'e', '--change', '.'], { cwd: root, now: at(2) }).code, EXIT.OK);
  const charters = fs.readdirSync(path.join(root, '.nth-review'), { recursive: true }).filter((p) => String(p).endsWith('charter.json'));
  assert.deepEqual(charters, []);
});
