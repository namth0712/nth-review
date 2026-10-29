#!/usr/bin/env node
// Runs every nth-review test file, on any platform and any Node.js >= 20.
// Node 20 takes no glob, and Node 21+ no directory (`node --test <dir>/`
// fails there with MODULE_NOT_FOUND), so the files are listed here and
// passed explicitly. Extra arguments go to `node --test` (for example
// `--test-name-pattern=<re>`). Usage: node tests/run.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(dir, name));
const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exitCode = run.status ?? 1;
