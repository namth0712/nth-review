import { randomUUID } from 'node:crypto';
import { parseAmount } from '../amounts.js';
import { withTransaction } from '../db.js';
import { requireAccountOwner } from '../guards.js';
import { HttpError } from '../http.js';
import { postEntry } from '../ledger.js';

export async function createWithdrawal(req, res, next) {
  try {
    const accountId = Number(req.params.accountId);
    const amountCents = parseAmount(req.body.amountCents);
    const outcome = await withTransaction(async (conn) => {
      const account = await requireAccountOwner(conn, req.session, accountId);
      if (account.status !== 'active') throw new HttpError(409, 'account is frozen');
      const entryId = await postEntry(conn, {
        accountId,
        amountCents: -amountCents,
        kind: 'withdrawal',
        reference: `withdrawal:${randomUUID()}`,
      });
      const [rows] = await conn.query('SELECT balance_cents FROM accounts WHERE id = ?', [accountId]);
      if (rows[0].balance_cents < 0) {
        return { status: 422, body: { error: 'insufficient funds' } };
      }
      return { status: 201, body: { entryId, amountCents } };
    });
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    next(error);
  }
}
