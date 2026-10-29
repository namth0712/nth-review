import { notFound } from './http.js';

// Locks the account row and checks that the session's customer owns it or is one of its joint holders.
export async function requireAccountOwner(conn, session, accountId) {
  const [rows] = await conn.query(
    'SELECT id, customer_id, status, balance_cents FROM accounts WHERE id = ? FOR UPDATE',
    [accountId],
  );
  const account = rows[0];
  if (!account) throw notFound();
  if (account.customer_id === session.customerId) return account;
  const [holders] = await conn.query(
    'SELECT 1 FROM account_holders WHERE account_id = ? AND customer_id = ?',
    [accountId, session.customerId],
  );
  if (holders.length === 0) throw notFound();
  return account;
}
