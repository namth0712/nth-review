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
