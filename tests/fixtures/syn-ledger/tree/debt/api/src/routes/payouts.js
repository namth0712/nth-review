import { randomUUID } from 'node:crypto';
import { parseAmount } from '../amounts.js';
import { withTransaction } from '../db.js';
import { HttpError, notFound } from '../http.js';
import { postEntry } from '../ledger.js';

export async function createPayout(req, res, next) {
  try {
    const accountId = Number(req.params.accountId);
    const amountCents = parseAmount(req.body.amountCents);
    const idempotencyKey = String(req.body.idempotencyKey ?? '');
    if (idempotencyKey.length < 8 || idempotencyKey.length > 64) throw new HttpError(400, 'invalid idempotency key');
    const payout = await withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT customer_id, balance_cents FROM accounts WHERE id = ?', [accountId]);
      const account = rows[0];
      if (!account || account.customer_id !== req.session.customerId) throw notFound();
      if (account.balance_cents < amountCents) throw new HttpError(422, 'insufficient funds');
      try {
        await conn.query(
          'INSERT INTO payout_requests (idempotency_key, account_id, amount_cents) VALUES (?, ?, ?)',
          [idempotencyKey, accountId, amountCents],
        );
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'duplicate payout');
        throw error;
      }
      const entryId = await postEntry(conn, {
        accountId,
        amountCents: -amountCents,
        kind: 'payout',
        reference: `payout:${randomUUID()}`,
      });
      return { entryId, amountCents };
    });
    res.status(201).json(payout);
  } catch (error) {
    next(error);
  }
}
