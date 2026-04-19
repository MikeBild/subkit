---
slug: postgres-connectors
scope: global
title: Postgres Connectors
description: Driver specifics for Postgres — DSN, parametrised queries, and why workflow-level transactions don't exist.
gates_tools: []
version: 1
---

# Postgres Connectors

The `postgres` driver runs SQL against a Postgres-compatible database. Each
step opens a pooled connection, runs one statement, returns the envelope, and
releases the connection. This doc is about what that means for authors.

## DSN and connector config

A Postgres connector has a DSN template in its config. The engine resolves
placeholders at run-time:

```
postgres://${cred.warehouse.user}:${cred.warehouse.password}@${connector.warehouse.config.host}:${connector.warehouse.config.port}/${connector.warehouse.config.database}?sslmode=require
```

The `base_url` field is reused for the DSN by convention. In practice you
reference the connector once per step and never touch the DSN yourself:

```json
{
  "id": "count_users",
  "kind": "request",
  "config": {
    "connector": "warehouse",
    "method": "SELECT",
    "query": "SELECT count(*) AS n FROM users"
  }
}
```

`method` uses uppercase SQL verbs: `SELECT`, `INSERT`, `UPDATE`, `DELETE`,
`CALL`. The driver uses this to decide whether to return rows or an affected
count.

## Parametrised queries — always

**Never** string-concatenate user input into SQL. Use `$1`, `$2`, ... and pass
values via `params`:

```json
{
  "id": "find_user",
  "kind": "request",
  "config": {
    "connector": "warehouse",
    "method": "SELECT",
    "query": "SELECT id, email, plan FROM users WHERE tenant_id = $1 AND email = $2",
    "params": ["${input.tenant_id}", "${input.email}"]
  }
}
```

Placeholders resolve **before** the SQL hits the driver, but the values ride as
parameters — so SQL injection is structurally impossible as long as you use
`params`. If you build a query string by interpolating `${input.*}` directly
into the `query` field, you've defeated the safety net.

## Examples per verb

### SELECT (returns rows in `data`)

```json
{
  "id": "list_open_tickets",
  "kind": "request",
  "config": {
    "connector": "support_db",
    "method": "SELECT",
    "query": "SELECT id, subject, priority FROM tickets WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
    "params": ["open", 100]
  }
}
```

Envelope: `data` is an array of row objects. `status_code` is 200 on success.

### INSERT with RETURNING

```json
{
  "id": "create_order",
  "kind": "request",
  "config": {
    "connector": "shop_db",
    "method": "INSERT",
    "query": "INSERT INTO orders (customer_id, total, status) VALUES ($1, $2, 'pending') RETURNING id, created_at",
    "params": ["${input.customer_id}", "${input.total}"]
  }
}
```

With `RETURNING`, `data` is an array of the returned rows. Without it, `data`
is `{ "rows_affected": 1 }`.

### UPDATE

```json
{
  "id": "mark_paid",
  "kind": "request",
  "config": {
    "connector": "shop_db",
    "method": "UPDATE",
    "query": "UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1",
    "params": ["${scope.create_order.data[0].id}"]
  }
}
```

### DELETE

```json
{
  "id": "purge_expired",
  "kind": "request",
  "config": {
    "connector": "cache_db",
    "method": "DELETE",
    "query": "DELETE FROM sessions WHERE expires_at < now() - interval '7 days'"
  }
}
```

### CALL (stored procedure)

```json
{
  "id": "rebalance",
  "kind": "request",
  "config": {
    "connector": "billing_db",
    "method": "CALL",
    "query": "CALL rebalance_tenant($1)",
    "params": ["${input.tenant_id}"]
  }
}
```

## Transactions

Workflow-level transactions **are not supported**. Each step runs in its own
connection, and there is no wrapping BEGIN/COMMIT across steps. If you need
atomicity:

1. **Push logic into the database.** Write a stored procedure or a
   `WITH ... RETURNING` CTE that does the whole unit of work in a single
   statement. Then call it from one step.
2. **Use idempotency keys.** Design INSERTs with a unique key derived from
   input so re-runs don't duplicate rows.
3. **Compensate.** If step B fails after step A succeeded, add a subsequent
   step that undoes A (e.g. `DELETE FROM orders WHERE id = $scope.a.data[0].id`).

Example: atomic debit+credit using a CTE in one step:

```json
{
  "id": "transfer",
  "kind": "request",
  "config": {
    "connector": "ledger_db",
    "method": "CALL",
    "query": "WITH d AS (UPDATE accounts SET balance = balance - $3 WHERE id = $1 AND balance >= $3 RETURNING id), c AS (UPDATE accounts SET balance = balance + $3 WHERE id = $2 AND (SELECT count(*) FROM d) = 1 RETURNING id) SELECT (SELECT count(*) FROM d) AS debited, (SELECT count(*) FROM c) AS credited",
    "params": ["${input.from_id}", "${input.to_id}", "${input.amount}"]
  }
}
```

## Common pitfalls

- **Interpolating input into the query string.** `"query": "SELECT * FROM t WHERE id = ${input.id}"` is a SQL injection. Use `$1` and `params`.
- **Missing RBAC on production schemas.** The connector credential should be a
  role with only the privileges the workflow needs. Giving a workflow
  `GRANT ALL ON ALL TABLES` is a common mistake — scope down to the specific
  tables the workflow touches.
- **Assuming `SELECT` returns a single object.** `data` is always an array,
  even for `LIMIT 1`. Use `$scope.find_user.data[0]` or guard with
  `$count($scope.find_user.data) > 0`.
- **Cross-step "transactions".** Two separate UPDATE steps are not atomic.
  If the second fails, the first has already committed.
- **Running DDL in a workflow.** `CREATE TABLE`, `ALTER TABLE`, etc. should
  live in migrations, not workflows. The engine will execute them, but drift
  detection won't know they happened and the audit trail is weaker.
- **Long-held transactions via `CALL`.** A stored procedure that takes 5
  minutes will block the pool connection. Keep calls short; push long work to
  background jobs and poll.

## See also

- `subkit-concepts.md` — envelope fields for SQL rows.
- `rbac-and-scopes.md` — who can author workflows that write to production DBs.
- `error-recovery.md` — handling Postgres errors (23505 unique violation, etc.).
