import { pool } from '../db.js';
import { notFound } from '../http.js';

// Resolves :entryId for every route that has it.
export async function requireOwnedEntry(req, res, next, value) {
  try {
    const [rows] = await pool.query(
      'SELECT e.id FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND e.account_id = ? AND a.customer_id = ?',
      [Number(value), Number(req.params.accountId), req.session.customerId],
    );
    if (rows.length === 0) throw notFound();
    next();
  } catch (error) {
    next(error);
  }
}
