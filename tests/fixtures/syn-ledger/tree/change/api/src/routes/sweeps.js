import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db.js';
import { requireAccountOwner } from '../guards.js';
import { HttpError } from '../http.js';
import { postEntry } from '../ledger.js';

export async function createSweep(req, res, next) {
  try {
    const sourceId = Number(req.params.accountId);
    const targetId = Number(req.body.targetAccountId);
    const sweep = await withTransaction(async (conn) => {
      const source = await requireAccountOwner(conn, req.session, sourceId);
      await requireAccountOwner(conn, req.session, targetId);
      if (source.status !== 'active') throw new HttpError(409, 'account is frozen');
      const amountCents = source.balance_cents;
      if (amountCents <= 0) throw new HttpError(422, 'nothing to sweep');
      const reference = `sweep:${randomUUID()}`;
      await postEntry(conn, { accountId: sourceId, amountCents: -amountCents, kind: 'sweep', reference });
      await postEntry(conn, { accountId: targetId, amountCents, kind: 'sweep', reference });
      return { sourceId, targetId, amountCents };
    });
    res.status(201).json(sweep);
  } catch (error) {
    next(error);
  }
}
