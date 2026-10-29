# Authorization

## Sessions

Every route requires a session. `requireSession` in `api/src/session.js` resolves the bearer token to a customer, `session.customerId`.

## Account references

A request can name accounts in its path, its query or its body. Every account a request names must belong to the session's customer.

Handlers check this with `requireAccountOwner(conn, session, accountId)` from `api/src/guards.js`. It locks the account row and compares its `customer_id` with the session's customer. When the account belongs to another customer, the handler responds with 404, as if the account did not exist.
