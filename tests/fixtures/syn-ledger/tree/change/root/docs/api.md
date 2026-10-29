# API reference

Every request carries `Authorization: Bearer <token>`. Amounts are integers in cents. Errors have the body `{ "error": "<message>" }`.

## Account

`GET /accounts/:accountId`

Returns the account and its current balance.

Response `200`:

```json
{
  "id": 1042,
  "status": "active",
  "balanceCents": 125000
}
```

Errors:

| Status | When |
|---|---|
| 401 | No valid session. |
| 404 | No such account for this customer. |

Example:

```sh
curl -X GET "https://ledger.example/accounts/1042" \
  -H "Authorization: Bearer $TOKEN"
```

An error response, for example `404`:

```json
{
  "error": "not found"
}
```

## Transfer

`POST /accounts/:accountId/transfers`

Moves `amountCents` from the account in the path to `targetAccountId`.

Request body:

```json
{
  "targetAccountId": 1043,
  "amountCents": 2500
}
```

Response `201`:

```json
{
  "sourceId": 1042,
  "targetId": 1043,
  "amountCents": 2500
}
```

Errors:

| Status | When |
|---|---|
| 400 | The amount is not a positive integer, or exceeds the transfer limit. |
| 401 | No valid session. |
| 404 | No such account for this customer. |
| 409 | The source account is frozen. |
| 422 | The source balance is lower than the amount. |

Example:

```sh
curl -X POST "https://ledger.example/accounts/1042/transfers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "targetAccountId": 1043, "amountCents": 2500 }'
```

An error response, for example `422`:

```json
{
  "error": "insufficient funds"
}
```

## Sweep

`POST /accounts/:accountId/sweeps`

Moves the whole balance of the account in the path to `targetAccountId`.

Request body:

```json
{
  "targetAccountId": 1043
}
```

Response `201`:

```json
{
  "sourceId": 1042,
  "targetId": 1043,
  "amountCents": 125000
}
```

Errors:

| Status | When |
|---|---|
| 401 | No valid session. |
| 404 | No such account for this customer. |
| 409 | The source account is frozen. |
| 422 | The source balance is zero or less. |

Example:

```sh
curl -X POST "https://ledger.example/accounts/1042/sweeps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "targetAccountId": 1043 }'
```

An error response, for example `422`:

```json
{
  "error": "nothing to sweep"
}
```

## Withdrawal

`POST /accounts/:accountId/withdrawals`

Pays `amountCents` out of the account.

Request body:

```json
{
  "amountCents": 4000
}
```

Response `201`:

```json
{
  "entryId": 88231,
  "amountCents": 4000
}
```

Errors:

| Status | When |
|---|---|
| 400 | The amount is not a positive integer, or exceeds the transfer limit. |
| 401 | No valid session. |
| 404 | No such account for this customer. |
| 409 | The account is frozen. |
| 422 | The balance is lower than the amount. |

Example:

```sh
curl -X POST "https://ledger.example/accounts/1042/withdrawals" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "amountCents": 4000 }'
```

An error response, for example `422`:

```json
{
  "error": "insufficient funds"
}
```

## Statement

`GET /accounts/:accountId/statements?limit=50`

Lists the latest entries, newest first. `limit` defaults to and is capped at the statement page size.

Response `200`:

```json
{
  "accountId": 1042,
  "entries": [
    {
      "id": 88231,
      "amount_cents": -4000,
      "kind": "withdrawal",
      "reference": "withdrawal:6f1c2d0e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
      "created_at": "2026-03-02T09:15:00.000Z"
    },
    {
      "id": 88190,
      "amount_cents": 2500,
      "kind": "transfer",
      "reference": "transfer:2b7e9c41-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
      "created_at": "2026-03-01T17:40:00.000Z"
    }
  ]
}
```

Errors:

| Status | When |
|---|---|
| 401 | No valid session. |
| 404 | No such account for this customer. |

Example:

```sh
curl -X GET "https://ledger.example/accounts/1042/statements?limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

An error response, for example `404`:

```json
{
  "error": "not found"
}
```

## Entry kinds

| Kind | Posted by |
|---|---|
| `deposit` | Deposits (before this API) |
| `withdrawal` | `POST /accounts/:accountId/withdrawals` |
| `transfer` | `POST /accounts/:accountId/transfers`, one entry per account |
| `sweep` | `POST /accounts/:accountId/sweeps`, one entry per account |
| `interest` | The daily interest job |

## Limits

| Limit | Value | Where |
|---|---|---|
| Largest amount in a request | `LIMITS.maxTransferCents` | `api/src/shared/limits.js` |
| Statement page size | `LIMITS.statementPageSize` | `api/src/shared/limits.js` |
