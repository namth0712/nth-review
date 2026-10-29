import { withTransaction } from '../db.js';
import { requireAccountOwner } from '../guards.js';

export async function getAccount(req, res, next) {
  try {
    const accountId = Number(req.params.accountId);
    const account = await withTransaction((conn) => requireAccountOwner(conn, req.session, accountId));
    res.json({ id: account.id, status: account.status, balanceCents: account.balance_cents });
  } catch (error) {
    next(error);
  }
}
