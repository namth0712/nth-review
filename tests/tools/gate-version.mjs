// The release gate this tooling implements, shared by the evaluator
// (release-gate.mjs) and the runner (matrix.mjs). The gate text is frozen:
// its sha256 is pinned here, and a test fails if the file changes. The earlier
// versions stay in the kit, frozen too, as history.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GATE = 'nthr-release-gate@3';
export const GATE_FILE = path.join(TESTS, 'RELEASE-GATE-3.md');
// Frozen 2026-10-29T02:07:28Z (UTC), before any registration or Part B row under any version.
export const GATE_SHA256 = '031e85e5dfd78c77d40acc6a6d0169368232f73c308de91a404dd729d1412e89';
export const PREVIOUS_GATES = Object.freeze([
  { gate: 'nthr-release-gate@1', file: path.join(TESTS, 'RELEASE-GATE.md'), sha256: 'cd9e067c99fae3611fc78ffbef9052093cacc735368418d02388a9d1aa3595ae' },
  { gate: 'nthr-release-gate@2', file: path.join(TESTS, 'RELEASE-GATE-2.md'), sha256: 'b92fb9daa0a8fde54579c2dbfe267e50a987d15898ba13b67473ba74bba99f51' },
]);
// The models a registered row may resolve to (RELEASE-GATE-3.md §4).
export const MODEL_PINS = Object.freeze({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' });
