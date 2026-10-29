import { notFound } from './http.js';

// Locks the account row and checks that it belongs to the session's customer.
export async function requireAccountOwner(conn, session, accountId) {
  const [rows] = await conn.query(
    'SELECT id, customer_id, status, balance_cents FROM accounts WHERE id = ? FOR UPDATE',
    [accountId],
  );
  const account = rows[0];
  if (!account || account.customer_id !== session.customerId) throw notFound();
  return account;
}
