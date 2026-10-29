import { withTransaction } from '../db.js';
import { postEntry } from '../ledger.js';

const DAILY_RATE = 0.0001;

export async function creditInterest(pool, now) {
  const day = now.toISOString().slice(0, 10);
  const [accounts] = await pool.query(
    "SELECT id, balance_cents FROM accounts WHERE status = 'active' AND balance_cents > 0",
  );
  for (const account of accounts) {
    const amountCents = Math.floor(account.balance_cents * DAILY_RATE);
    if (amountCents === 0) continue;
    try {
      await withTransaction((conn) =>
        postEntry(conn, { accountId: account.id, amountCents, kind: 'interest', reference: `interest:${day}` }),
      );
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
}
