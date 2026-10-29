# Ledger API

`npm start` serves the API on `PORT` (default 8080) against `DATABASE_URL`.

Migrations in `migrations/` run in file-name order.

## Endpoints

| Method | Path | Handler |
|---|---|---|
| GET | `/accounts/:accountId` | `src/routes/accounts.js` `getAccount` |
| GET | `/accounts/:accountId/statements` | `src/routes/statements.js` `getStatement` |
| POST | `/accounts/:accountId/transfers` | `src/routes/transfers.js` `createTransfer` |
| POST | `/accounts/:accountId/sweeps` | `src/routes/sweeps.js` `createSweep` |
| POST | `/accounts/:accountId/withdrawals` | `src/routes/withdrawals.js` `createWithdrawal` |

The full reference is `docs/api.md` in the root repository.
