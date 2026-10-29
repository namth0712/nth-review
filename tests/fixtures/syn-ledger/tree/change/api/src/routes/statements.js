import { withTransaction } from '../db.js';
import { requireAccountOwner } from '../guards.js';
import { LIMITS } from '../shared/limits.js';

const ENTRY_COLUMNS = ['id', 'amount_cents', 'kind', 'reference', 'created_at'];
const ORDER = 'created_at DESC, id DESC';

function pageSize(value) {
  const requested = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(requested) || requested <= 0) return LIMITS.statementPageSize;
  return Math.min(requested, LIMITS.statementPageSize);
}

export async function getStatement(req, res, next) {
  try {
    const accountId = Number(req.params.accountId);
    const limit = pageSize(req.query.limit);
    const entries = await withTransaction(async (conn) => {
      await requireAccountOwner(conn, req.session, accountId);
      const [rows] = await conn.query(
        `SELECT ${ENTRY_COLUMNS.join(', ')} FROM ledger_entries WHERE account_id = ? ORDER BY ${ORDER} LIMIT ?`,
        [accountId, limit],
      );
      return rows;
    });
    res.json({ accountId, entries });
  } catch (error) {
    next(error);
  }
}
