// A structurally valid records@1 document exercising every record type, and
// a small path-based mutator for negative tests.

export const RUN = '20261025-131201-incremental-demo';
export const BASE = '20261024-090000-task-demo';
export const SHA = 'a'.repeat(64);
export const OID = '1'.repeat(40);
export const OID2 = '2'.repeat(40);

export function validRecords({ status = 'open' } = {}) {
  const closed = status !== 'open';
  return {
    schema: 'nth-review/records@1',
    run: {
      id: RUN,
      namespace: 'experiments/demo',
      mode: 'incremental',
      slug: 'demo',
      unit: null,
      base: BASE,
      continues: null,
      status,
      incomplete_reason: status === 'incomplete' ? 'budget' : status === 'abandoned' ? 'snapshot-changed' : null,
      opened: '2026-10-25T13:12:01Z',
      closed: closed ? '2026-10-25T14:00:00.250Z' : null,
      profile: 'standard',
      runtime: { required_lead_model: 'opus-high', lead_model: 'claude-opus-5-5', lead_effort: 'high', triggers: ['authorization'] },
    },
    scope: {
      summary: 'Incremental review of the transfer change.',
      change: [{ repo: 'api', range: 'abc123..def456', working_tree: true }],
      units: [{ id: 'U-01', title: 'Ledger', tier: 1, status: 'planned', depends_on: [], runs: [], reason: null }],
      intent: [{ id: 'I1', anchor: 'docs/ledger.md#Transfers', note: 'transfer rules' }],
    },
    budget: {
      lead_tool_calls: 40,
      subagent_calls: 3,
      obligations_max: 15,
      reserve_pct: 30,
      spent: { lead_tool_calls: 12, subagent_calls: 1, subagent_tokens: 30000, lead_tokens_observed: null, wall_clock_min: 9.5 },
    },
    snapshot: {
      reconstructible: false,
      tracked_key: SHA,
      untracked_key: SHA,
      tracked_complete: true,
      discovery_complete: true,
      untracked_complete: false,
      limitations: [{ code: 'symlink-skipped', path: 'linked' }],
      repos: [
        {
          path: '.', head: null, branch: null, unborn: true, is_worktree: false, is_submodule: false,
          porcelain_sha256: SHA, staged_sha256: SHA, unstaged_sha256: SHA,
          unverified: { filter: 0, secret: 0, unreadable: 0, sha256: SHA },
          untracked: {
            count: 0, list_sha256: SHA, sample: [], content_sha256: SHA, hashed: 0,
            skipped: { secret: 0, size: 0, budget: 0, repository: 0, link: 0, unreadable: 0 },
          },
        },
        {
          path: 'api', head: OID, branch: 'main', unborn: false, is_worktree: true, is_submodule: false,
          porcelain_sha256: SHA, staged_sha256: SHA, unstaged_sha256: SHA,
          unverified: { filter: 0, secret: 0, unreadable: 0, sha256: SHA },
          untracked: {
            count: 2, list_sha256: SHA, sample: ['api/.env', 'api/new file.txt'], content_sha256: SHA, hashed: 1,
            skipped: { secret: 1, size: 0, budget: 0, repository: 0, link: 0, unreadable: 0 },
          },
        },
      ],
    },
    checks: [{ command: 'node scripts/check-contract.mjs', cwd: 'api', result: 'no drift', proves: 'field names match', not_proven: 'field types' }],
    census: {
      recipes: [{ id: 'C2', pattern: 'callers of transfer()', scope: 'api/src', hits: 2, limits: 'computed names are invisible' }],
      items: [
        { id: 'CI-1', path: 'api/src/transfer.js', mechanism: 'route POST /transfer', status: 'classified', reason: null, affects: ['OB-01'] },
        { id: 'CI-2', path: 'api/src/*.test.js', mechanism: 'tests', status: 'excluded', reason: 'not runtime code', affects: null },
        { id: 'CI-3', path: 'api/src/new.js', mechanism: 'route POST /transfer/v2', status: 'classified', reason: null, affects: ['OB-01'] },
      ],
    },
    obligations: [
      {
        id: 'OB-01',
        checks: ['AUTHZ.2', 'LEDGER'],
        claim: 'The transfer target belongs to the caller.',
        scope: 'POST /transfer',
        acceptance: 'Ownership of both accounts is enforced before the write.',
        coverage: 'all-enumerated',
        coverage_method: 'route table',
        status: 'violated',
        open_reason: null,
        source_trace: 'consistent',
        evidence: [{ anchor: 'api/src/transfer.js:3-12', note: 'only the source account is checked' }],
        intent: ['I1'],
        assumptions: [
          { kind: 'dependency', anchor: 'api/src/guards/owner.js:1-20', fact: null, observed: null, note: 'shared ownership guard' },
          { kind: 'environment', anchor: null, fact: 'one API process', observed: 'unknown', note: 'process count' },
        ],
        links: ['F-01'],
      },
      {
        id: 'OB-02',
        checks: ['ATOMIC.3'],
        claim: 'Concurrent transfers cannot overdraw.',
        scope: 'POST /transfer',
        acceptance: 'A deterministic concurrency test shows serialisation.',
        coverage: 'named-subset',
        coverage_method: 'the transfer path only',
        status: 'open',
        open_reason: 'needs-runtime',
        source_trace: 'consistent',
        evidence: [{ anchor: 'api/src/transfer.js:8', note: 'balance check' }],
        intent: [],
        assumptions: [],
        links: [`${RUN}/D1`],
      },
    ],
    findings: [
      {
        id: 'F-01',
        fingerprint: 'ledger/transfer-target-unchecked',
        kind: 'defect',
        verdict: 'confirmed',
        severity: 'high',
        impact_dimension: 'financial',
        obligation: 'OB-01',
        summary: 'Value can be moved into any existing account.',
        trace: [
          { role: 'entrypoint', anchor: 'api/src/routes.js:14', note: 'POST /transfer' },
          { role: 'sink', anchor: 'api/src/transfer.js:10', note: 'credit' },
        ],
        counterevidence: [{ anchor: null, note: 'no other guard on this path' }],
        validation_plan: null,
        verification: { role: 'R5', model: 'opus', outcome: 'confirmed', corrections: null, incomplete: false },
        decision: 'pending',
      },
    ],
    debt: {
      in: [{ id: `${BASE}/D1`, from_run: BASE, disposition: closed ? 'carried' : null, note: null }],
      out: [
        { id: `${RUN}/D1`, kind: 'runtime', refs: ['OB-02'], requires: 'a concurrency test in an isolated database', priority: 'medium' },
        { id: `${BASE}/D1`, kind: 'owner-fact', refs: ['OB-02'], requires: 'the process count in production', priority: 'low' },
      ],
    },
    delegations: [
      { role: 'R5', agent: 'reviewer', model: 'opus', effort: 'high', budget_calls: 10, tool_uses: 3, tokens: 19576, completed: true, recovery_messages: 0 },
    ],
    // Exactly the cited paths (check requires it once the run is closed).
    footprint: {
      'api/src/guards/owner.js': { blob: null, state: 'unverified', reason: 'filter' },
      'api/src/routes.js': { blob: null, state: 'absent', reason: null },
      'api/src/transfer.js': { blob: OID, state: 'clean', reason: null },
      'docs/ledger.md': { blob: OID2, state: 'dirty', reason: null },
    },
    freshness: {
      base_run: BASE,
      repos: [{ path: 'api', outcome: 'ancestor' }],
      changed_files: [
        { path: 'api/src/transfer.js', change: 'modified', from: null },
        { path: 'api/src/new.js', change: 'renamed', from: 'api/src/old.js' },
      ],
      obligations: [{ id: 'OB-01', class: 'touched', reason: 'hunk 5-7 intersects 3-12' }, { id: 'OB-02', class: 'touched', reason: 'open in the base; never concluded' }],
    },
  };
}

// Sets (or, with `remove`, deletes) the value at a path like
// ['obligations', 0, 'status'] and returns the document.
export function mutate(doc, keys, value, { remove = false } = {}) {
  let target = doc;
  for (const key of keys.slice(0, -1)) target = target[key];
  const last = keys[keys.length - 1];
  if (remove) delete target[last];
  else target[last] = value;
  return doc;
}

// The validator's path notation for `keys`.
export const where = (keys) =>
  keys.reduce((acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${acc}.${key}` : `${acc}[${JSON.stringify(key)}]`), '$');
