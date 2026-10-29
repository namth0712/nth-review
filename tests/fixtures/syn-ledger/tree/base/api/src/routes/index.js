import express from 'express';
import { getAccount } from './accounts.js';

export const routes = express.Router();

routes.get('/accounts/:accountId', getAccount);
