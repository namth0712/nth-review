# Operations

## Daily interest

Interest is credited once a day to every active account with a positive balance. The job records one `interest` entry per account and day. The unique key on `(account_id, kind, reference)` turns a repeated run into a no-op.

## Shared limits

`admin/src/shared/limits.js` is a copy of `api/src/shared/limits.js` and must stay identical to it. `admin/scripts/check-mirror.js` compares the two files.

## Payout requests

The `payout_requests` table belongs to the payments platform. Its schema and migrations live in the platform's own repository, not in these repositories.
