import { pool } from '../db.js';

export async function getEntry(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT id, account_id, amount_cents, kind, reference, created_at FROM ledger_entries WHERE id = ?',
      [Number(req.params.entryId)],
    );
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
}
