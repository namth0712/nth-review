#!/usr/bin/env node
// nth-review deterministic helper. Usage: node nthr.mjs <command> [options]
// Output is one JSON line on stdout; see lib/cli.mjs for the exit codes.
import { run } from './lib/cli.mjs';

// Decision C19: official audits (audits/<id>) stay refused until the release
// criteria pass. Only a release changes this line.
export const OFFICIAL_AUDITS_ENABLED = false;

process.exitCode = run(process.argv.slice(2), { officialAuditsEnabled: OFFICIAL_AUDITS_ENABLED });
