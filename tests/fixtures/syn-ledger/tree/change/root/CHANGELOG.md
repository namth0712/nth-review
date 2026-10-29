# Changelog

## 1.5.0

- Transfers between a customer's accounts (`POST /accounts/:accountId/transfers`).
- Sweeps of a whole balance (`POST /accounts/:accountId/sweeps`).
- Withdrawals (`POST /accounts/:accountId/withdrawals`).
- Statements (`GET /accounts/:accountId/statements`).
- The largest amount in a request is now 10,000.00.

## 1.4.0

- Account balances (`GET /accounts/:accountId`).
- Daily interest.
