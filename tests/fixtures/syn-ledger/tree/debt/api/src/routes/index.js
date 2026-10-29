import express from 'express';
import { getAccount } from './accounts.js';
import { getEntry } from './entries.js';
import { requireOwnedEntry } from './params.js';
import { createPayout } from './payouts.js';
import { getStatement } from './statements.js';
import { createSweep } from './sweeps.js';
import { createTransfer } from './transfers.js';
import { createWithdrawal } from './withdrawals.js';

export const routes = express.Router();

routes.param('entryId', requireOwnedEntry);

routes.get('/accounts/:accountId', getAccount);
routes.get('/accounts/:accountId/statements', getStatement);
routes.get('/accounts/:accountId/entries/:entryId', getEntry);
routes.post('/accounts/:accountId/transfers', createTransfer);
routes.post('/accounts/:accountId/sweeps', createSweep);
routes.post('/accounts/:accountId/withdrawals', createWithdrawal);
routes.post('/accounts/:accountId/payouts', createPayout);
