# Ledger

## Entries

Every change to an account balance is a ledger entry. `postEntry` in `api/src/ledger.js` inserts the entry and applies it to `accounts.balance_cents` in the same transaction. Nothing else writes `balance_cents`.

Application code never updates or deletes ledger entries. A migration may backfill a column it adds.

## Account status

An account is `active` or `frozen`. A frozen account still receives money; no money leaves it.

## Refusals

A handler refuses a request by throwing an `HttpError` (`api/src/http.js`) inside `withTransaction` (`api/src/db.js`). The transaction then rolls back, so a refused request leaves no entry and no balance change. A handler never returns an error response from inside a transaction callback.

## Amounts

An amount given in a request is a positive integer number of cents, at most `LIMITS.maxTransferCents` (`api/src/shared/limits.js`). `parseAmount` in `api/src/amounts.js` checks it.

## Transfers

A customer moves money between two of their own accounts. Transfers between customers are not offered. A transfer posts two entries with the same reference: the amount leaves the source and arrives in the target.

## Sweeps

A sweep moves the whole balance of an account, whatever its size, to another account of the same customer.

## Withdrawals

A withdrawal pays money out of an account. It never takes the balance below zero.

## Statements

A statement lists an account's latest entries, newest first, at most `LIMITS.statementPageSize` at a time.

## Corrections

An operator corrects a wrong entry with `reverseEntry` in `api/src/ledger.js`. It posts the opposite amount, with the original entry's id as its reference. Entries themselves are never edited.

## Payouts

A payout sends money from an account to the customer's bank. It follows the account rules above. A client that retries a payout sends the same `idempotencyKey`, and the retry must not pay twice.

## Entry lookups

`GET /accounts/:accountId/entries/:entryId` returns one entry of an account the session's customer owns.
