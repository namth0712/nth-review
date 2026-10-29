import { randomUUID } from 'node:crypto';
import { parseAmount } from '../amounts.js';
import { withTransaction } from '../db.js';
import { requireAccountOwner } from '../guards.js';
import { HttpError, notFound } from '../http.js';
import { postEntry } from '../ledger.js';

export async function createTransfer(req, res, next) {
  try {
    const sourceId = Number(req.params.accountId);
    const targetId = Number(req.body.targetAccountId);
    const amountCents = parseAmount(req.body.amountCents);
    const transfer = await withTransaction(async (conn) => {
      const source = await requireAccountOwner(conn, req.session, sourceId);
      const [rows] = await conn.query('SELECT id, status FROM accounts WHERE id = ? FOR UPDATE', [targetId]);
      if (!rows[0]) throw notFound();
      if (source.status !== 'active') throw new HttpError(409, 'account is frozen');
      if (source.balance_cents < amountCents) throw new HttpError(422, 'insufficient funds');
      const reference = `transfer:${randomUUID()}`;
      await postEntry(conn, { accountId: sourceId, amountCents: -amountCents, kind: 'transfer', reference });
      await postEntry(conn, { accountId: targetId, amountCents, kind: 'transfer', reference });
      return { sourceId, targetId, amountCents };
    });
    res.status(201).json(transfer);
  } catch (error) {
    next(error);
  }
}
