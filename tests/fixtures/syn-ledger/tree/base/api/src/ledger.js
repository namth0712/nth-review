// Inserts one ledger entry and applies it to the account balance.
export async function postEntry(conn, { accountId, amountCents, kind, reference = null }) {
  const [result] = await conn.query(
    'INSERT INTO ledger_entries (account_id, amount_cents, kind, reference) VALUES (?, ?, ?, ?)',
    [accountId, amountCents, kind, reference],
  );
  await conn.query('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', [amountCents, accountId]);
  return result.insertId;
}
