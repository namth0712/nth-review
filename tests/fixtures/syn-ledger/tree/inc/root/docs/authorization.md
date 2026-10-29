# Authorization

## Sessions

Every route requires a session. `requireSession` in `api/src/session.js` resolves the bearer token to a customer, `session.customerId`.

## Account references

A request can name accounts in its path, its query or its body. Every account a request names must belong to the session's customer, or list that customer as a joint holder in `account_holders`.

Handlers check this with `requireAccountOwner(conn, session, accountId)` from `api/src/guards.js`. It locks the account row and accepts the account's own customer or one of its joint holders. Any other account gets a 404 response, as if it did not exist.
