import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  EXIT,
  UsageError,
  ValidationError,
  checkNodeVersion,
  parseOptions,
  run,
} from '../scripts/lib/cli.mjs';
import { makeTempDir, runNthr } from './helpers/tmp.mjs';

// Captures what run() writes, without spawning a process.
function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    json: () => JSON.parse(out.join('')),
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

test('--help exits 0 with one JSON line listing the commands', () => {
  const r = runNthr(['--help']);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.command, 'help');
  const names = r.json.result.commands.map((c) => c.name);
  assert.deepEqual(names.sort(), ['apply', 'charter', 'check', 'close', 'decide', 'footprint', 'fresh', 'help', 'new-run', 'pack', 'preview', 'resolve', 'resume', 'status', 'version']);
});

test('help and -h are the same as --help', () => {
  assert.equal(runNthr(['help']).json.command, 'help');
  assert.equal(runNthr(['-h']).json.command, 'help');
  assert.equal(runNthr(['version', '--help']).json.command, 'help');
});

test('<command> --help describes that command only: its options, whether they repeat, and the global ones', () => {
  const r = runNthr(['new-run', '--help']);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.json.command, 'help');
  assert.equal(r.json.result.command, 'new-run');
  const byName = Object.fromEntries(r.json.result.options.map((o) => [o.name, o]));
  assert.equal(byName['--entry'].repeatable, true);
  assert.equal(byName['--ns'].repeatable, false);
  for (const name of ['--ns', '--change', '--root', '--help']) assert.ok(byName[name], name);
  assert.ok(!byName['--fingerprint'], 'no option of another command is listed');
  assert.ok(!('commands' in r.json.result), 'not the global listing');
});

test('no command is a usage error (exit 2)', () => {
  const r = runNthr([]);
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.json.ok, false);
  assert.match(r.json.errors[0], /no command/);
});

test('unknown command is a usage error (exit 2)', () => {
  const r = runNthr(['frobnicate']);
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.command, null);
  assert.match(r.json.errors[0], /unknown command frobnicate/);
});

test('unknown option, unexpected argument and option before command are usage errors', () => {
  assert.equal(runNthr(['version', '--bogus']).code, EXIT.USAGE);
  assert.equal(runNthr(['version', 'extra']).code, EXIT.USAGE);
  assert.equal(runNthr(['version', '-x']).code, EXIT.USAGE);
  const before = runNthr(['--root', '.', 'version']);
  assert.equal(before.code, EXIT.USAGE);
  assert.match(before.json.errors[0], /command must come first/);
});

test('--root with spaces and non-ASCII characters, in both option forms', (t) => {
  const base = makeTempDir(t);
  const dir = path.join(base, 'dự án review');
  mkdirSync(dir);
  const expected = realpathSync.native(dir);
  const spaced = runNthr(['version', '--root', dir]);
  assert.equal(spaced.code, EXIT.OK, spaced.stdout + spaced.stderr);
  assert.equal(spaced.json.result.root, expected);
  const equals = runNthr(['version', `--root=${dir}`]);
  assert.equal(equals.code, EXIT.OK);
  assert.equal(equals.json.result.root, expected);
});

test('--root defaults to the current directory', (t) => {
  const dir = makeTempDir(t);
  const r = runNthr(['version'], { cwd: dir });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.json.result.root, realpathSync.native(dir));
});

test('--root refusals: repeated, missing value, empty, nonexistent, a file', (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, 'file.txt');
  writeFileSync(file, 'x');
  assert.equal(runNthr(['version', '--root', dir, '--root', dir]).code, EXIT.USAGE);
  assert.equal(runNthr(['version', '--root']).code, EXIT.USAGE);
  assert.equal(runNthr(['version', '--root=']).code, EXIT.USAGE);
  assert.equal(runNthr(['version', '--root', path.join(dir, 'missing')]).code, EXIT.USAGE);
  assert.equal(runNthr(['version', '--root', file]).code, EXIT.USAGE);
});

test('version reports helper, protocol, schema and node', () => {
  const r = runNthr(['version']);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.json.result.protocol, 'v0.1');
  assert.equal(r.json.result.schema, 'nth-review/records@1');
  assert.equal(r.json.result.node, process.version);
});

test('a ValidationError maps to exit 1 with all errors', () => {
  const c = capture();
  const commands = {
    probe: { summary: '', options: {}, run: () => { throw new ValidationError(['a', 'b']); } },
  };
  const code = run(['probe'], { ...c.io, commands });
  assert.equal(code, EXIT.INVALID);
  assert.deepEqual(c.json(), { ok: false, command: 'probe', errors: ['a', 'b'] });
});

test('a guard refusal maps to exit 2', () => {
  const c = capture();
  const refusal = Object.assign(new Error('refused by guard'), { refusal: true });
  const commands = { probe: { summary: '', options: {}, run: () => { throw refusal; } } };
  assert.equal(run(['probe'], { ...c.io, commands }), EXIT.USAGE);
  assert.deepEqual(c.json().errors, ['refused by guard']);
});

test('an unexpected error maps to exit 3, JSON on stdout, stack on stderr', () => {
  const c = capture();
  const commands = { probe: { summary: '', options: {}, run: () => { throw new TypeError('boom'); } } };
  assert.equal(run(['probe'], { ...c.io, commands }), EXIT.UNEXPECTED);
  assert.equal(c.json().ok, false);
  assert.match(c.json().errors[0], /unexpected error: boom/);
  assert.match(c.stderrText(), /TypeError: boom/);
  assert.equal(c.stdoutText().split('\n').filter(Boolean).length, 1);
});

test('Node older than 20 is refused with exit 2', () => {
  const c = capture();
  assert.equal(run(['version'], { ...c.io, nodeVersion: 'v18.19.0' }), EXIT.USAGE);
  assert.match(c.json().errors[0], /requires Node\.js >= 20/);
  assert.throws(() => checkNodeVersion('nonsense'), UsageError);
  assert.doesNotThrow(() => checkNodeVersion('v20.0.0'));
});

test('parseOptions: both value forms, multiple, boolean, -- terminator', () => {
  const spec = {
    ns: { type: 'string' },
    change: { type: 'string', multiple: true },
    apply: { type: 'boolean' },
  };
  const a = parseOptions(['--ns', 'experiments/x', '--change=api:a..b', '--change', 'web:c..d', '--apply'], spec);
  assert.deepEqual(a.options, { ns: 'experiments/x', change: ['api:a..b', 'web:c..d'], apply: true });
  const b = parseOptions(['--ns=experiments/x', '--apply=false', '--', '--not-an-option'], spec);
  assert.deepEqual(b.options, { ns: 'experiments/x', apply: false });
  assert.deepEqual(b.positionals, ['--not-an-option']);
  assert.throws(() => parseOptions(['--ns', '--apply'], spec), /needs a value/);
  assert.throws(() => parseOptions(['--apply=yes'], spec), /takes no value/);
  assert.throws(() => parseOptions(['--NS', 'x'], spec), /unknown option/);
  assert.throws(() => parseOptions(['--__proto__', 'x'], spec), /unknown option/);
  assert.throws(() => parseOptions(['--constructor', 'x'], spec), /unknown option/);
  assert.throws(() => parseOptions(['--tostring', 'x'], spec), /unknown option/);
  assert.throws(() => parseOptions([42], spec), /must be strings/);
});
