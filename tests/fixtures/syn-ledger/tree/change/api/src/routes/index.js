import express from 'express';
import { getAccount } from './accounts.js';
import { getStatement } from './statements.js';
import { createSweep } from './sweeps.js';
import { createTransfer } from './transfers.js';
import { createWithdrawal } from './withdrawals.js';

export const routes = express.Router();

routes.get('/accounts/:accountId', getAccount);
routes.get('/accounts/:accountId/statements', getStatement);
routes.post('/accounts/:accountId/transfers', createTransfer);
routes.post('/accounts/:accountId/sweeps', createSweep);
routes.post('/accounts/:accountId/withdrawals', createWithdrawal);
