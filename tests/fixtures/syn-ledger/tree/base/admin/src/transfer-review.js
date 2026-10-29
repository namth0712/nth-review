import { LIMITS } from './shared/limits.js';

// Lists the transfers that need a second look: the large ones.
export async function transfersToReview(pool) {
  const [rows] = await pool.query(
    "SELECT account_id, amount_cents, reference, created_at FROM ledger_entries WHERE kind = 'transfer' AND amount_cents > ?",
    [Math.floor(LIMITS.maxTransferCents / 2)],
  );
  return rows;
}
