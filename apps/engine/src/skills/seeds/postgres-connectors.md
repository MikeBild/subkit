---
slug: postgres-connectors
scope: global
title: Postgres Connectors
description: Driver specifics for Postgres — DSN, parametrised queries, and why workflow-level transactions don't exist.
activates_when: [{"kind":"connector_driver","driver":"postgres"}]
side_effects: write
idempotency: naturally
maturity: stable
tags: [driver, sql, postgres]
version: 4
---

# Postgres Connectors

The `postgres` driver runs SQL against a Postgres-compatible database. Each
step opens a pooled connection, runs one parameterised statement, returns
the row array as the envelope's `data`, and releases the connection. This
doc is about what that means for authors.

## DSN and connector config

A Postgres connector has a DSN template in its config. The engine resolves
placeholders at run-time:

```
postgres://${cred.warehouse.user}:${cred.warehouse.password}@${connector.warehouse.config.host}:${connector.warehouse.config.port}/${connector.warehouse.config.database}?sslmode=require
```

The `base_url` field is reused for the DSN by convention. In practice you
reference the connector once per step, set `"protocol": "sql"` and pass SQL
via the `sql` block on the request step:

```json
{
  "id": "count_users",
  "kind": "request",
  "protocol": "sql",
  "method": "SELECT",
  "connector_id": "<warehouse_connector_id>",
  "sql": {
    "query": "SELECT count(*) AS n FROM users"
  }
}
```

`method` declares the SQL verb the step is executing (`SELECT`, `INSERT`,
`UPDATE`, `DELETE`, `CALL`). The shared `RequestStep.method` field accepts
verbs from every driver; the workflow Zod schema's `superRefine` rejects
an HTTP verb on a step with a `sql:` block, so the only valid choices for
postgres steps are the SQL verbs. The driver itself decides return shape
from the query, not the method.

## Asserting affected rows: `expected_row_count`

Postgres steps assert affected-row counts via the dedicated
`expected_row_count` field (HTTP / S3 steps use `expected_statuses`; the
Zod schema rejects mixing them). Four shapes:

- `expected_row_count: 1`              — exact match
- `expected_row_count: [1, 10]`        — inclusive range tuple
- `expected_row_count: { min: 1 }`     — at least 1 row affected
- `expected_row_count: { max: 0 }`     — at most 0 rows (a no-op safety net)

A step-level `expected_row_count` always runs the statement inside a
transaction (no `sql.transaction` needed), so a mismatch rolls the write back
before it commits.

```json
{
  "id": "delete_one",
  "kind": "request",
  "protocol": "sql",
  "method": "DELETE",
  "connector_id": "<warehouse_connector_id>",
  "sql": {
    "query": "DELETE FROM users WHERE id = $1",
    "params": ["${input.user_id}"]
  },
  "expected_row_count": 1
}
```

Inside `sql.also`, every transactional statement carries its own
`expected_row_count`. The example below uses the tuple form on the head
statement and the object form on the follow-up to show all the shapes:

```json
{
  "id": "transfer_strict",
  "kind": "request",
  "protocol": "sql",
  "method": "UPDATE",
  "connector_id": "<ledger_db_connector_id>",
  "sql": {
    "query": "UPDATE accounts SET balance = balance - $2 WHERE id = $1 AND balance >= $2",
    "params": ["${input.from_id}", "${input.amount}"],
    "also": [
      {
        "query": "UPDATE accounts SET balance = balance + $2 WHERE id = $1",
        "params": ["${input.to_id}", "${input.amount}"],
        "expected_row_count": { "min": 1, "max": 1 }
      }
    ]
  },
  "expected_row_count": [1, 1]
}
```

Any per-statement violation rolls back the whole transaction.

## Parametrised queries — always

**Never** string-concatenate user input into SQL. Use `$1`, `$2`, ... and pass
values via `sql.params`:

```json
{
  "id": "find_user",
  "kind": "request",
  "protocol": "sql",
  "method": "SELECT",
  "connector_id": "<warehouse_connector_id>",
  "sql": {
    "query": "SELECT id, email, plan FROM users WHERE tenant_id = $1 AND email = $2",
    "params": ["${input.tenant_id}", "${input.email}"]
  }
}
```

Placeholders inside `sql.params` resolve **before** the SQL hits the driver,
but the values ride as bound parameters — so SQL injection is structurally
impossible as long as you keep variable substitution out of `sql.query`.

## Examples per verb

### SELECT (returns rows in `data`)

```json
{
  "id": "list_open_tickets",
  "kind": "request",
  "protocol": "sql",
  "method": "SELECT",
  "connector_id": "<support_db_connector_id>",
  "sql": {
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
  "protocol": "sql",
  "method": "INSERT",
  "connector_id": "<shop_db_connector_id>",
  "sql": {
    "query": "INSERT INTO orders (customer_id, total, status) VALUES ($1, $2, 'pending') RETURNING id, created_at",
    "params": ["${input.customer_id}", "${input.total}"]
  }
}
```

With `RETURNING`, `data` is an array of returned rows. Without it, `data` is
an empty array and `request_meta.row_count` carries the affected-row count
the driver reported (use it when you need the cardinality of an
INSERT/UPDATE/DELETE that didn't `RETURNING`).

### UPDATE

```json
{
  "id": "mark_paid",
  "kind": "request",
  "protocol": "sql",
  "method": "UPDATE",
  "connector_id": "<shop_db_connector_id>",
  "sql": {
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
  "protocol": "sql",
  "method": "DELETE",
  "connector_id": "<cache_db_connector_id>",
  "sql": {
    "query": "DELETE FROM sessions WHERE expires_at < now() - interval '7 days'"
  }
}
```

### CALL (stored procedure)

```json
{
  "id": "rebalance",
  "kind": "request",
  "protocol": "sql",
  "method": "CALL",
  "connector_id": "<billing_db_connector_id>",
  "sql": {
    "query": "CALL rebalance_tenant($1)",
    "params": ["${input.tenant_id}"]
  }
}
```

## Transactions

A single `request` step CAN now wrap multiple statements in a transaction by
setting `sql.also`: the driver opens one connection, issues `BEGIN`, runs
every statement in declaration order, then `COMMIT`s. On the first failed
statement it issues `ROLLBACK` and the step fails atomically. Workflow-level
transactions across multiple steps remain unsupported.

```json
{
  "id": "transfer_atomically",
  "kind": "request",
  "protocol": "sql",
  "method": "UPDATE",
  "connector_id": "<ledger_db_connector_id>",
  "sql": {
    "query": "UPDATE accounts SET balance = balance - $2 WHERE id = $1 AND balance >= $2",
    "params": ["${input.from_id}", "${input.amount}"],
    "also": [
      {
        "query": "UPDATE accounts SET balance = balance + $2 WHERE id = $1",
        "params": ["${input.to_id}", "${input.amount}"]
      }
    ]
  }
}
```

For very large SELECTs, set `sql.cursor` to stream rows through a server-side
cursor instead of buffering the full result set in memory. **Caveat**: when
the cursor path runs, `request_meta.row_count` reports the number of rows
*fetched* (`rows.length`), not the number affected by the underlying
statement; `expected_row_count` on a cursor step is therefore an assertion
on fetch count, not affected count. For DML where you need the affected
count, omit `sql.cursor`.

```json
{
  "id": "stream_audits",
  "kind": "request",
  "protocol": "sql",
  "method": "SELECT",
  "connector_id": "<warehouse_connector_id>",
  "sql": {
    "query": "SELECT id, payload FROM audit_log WHERE created_at >= $1",
    "params": ["${input.since}"],
    "cursor": { "fetch_size": 1000 }
  }
}
```

If you need **multi-step atomicity**, the same options still apply:

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
  "protocol": "sql",
  "method": "CALL",
  "connector_id": "<ledger_db_connector_id>",
  "sql": {
    "query": "WITH d AS (UPDATE accounts SET balance = balance - $3 WHERE id = $1 AND balance >= $3 RETURNING id), c AS (UPDATE accounts SET balance = balance + $3 WHERE id = $2 AND (SELECT count(*) FROM d) = 1 RETURNING id) SELECT (SELECT count(*) FROM d) AS debited, (SELECT count(*) FROM c) AS credited",
    "params": ["${input.from_id}", "${input.to_id}", "${input.amount}"]
  }
}
```

## Common pitfalls

- **Interpolating input into the query string.** `"query": "SELECT * FROM t WHERE id = ${input.id}"` is a SQL injection. Use `$1` and `sql.params`.
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

## Schema introspection

Before authoring the first SQL step, run discovery against the connector
to capture the table list, column types, primary keys, and foreign keys
as a Markdown corpus the LLM can read inline:

```
discover_connector_endpoints({ connector_id: "<warehouse>" })
```

The `postgres-introspect` strategy resolves the connector's DSN, opens a
short-lived pool, queries `information_schema.columns` plus the FK
catalog, and emits the schema as Markdown under `text_corpus`. The
result is cached in `knowledge_sources` for 24h, so subsequent author
cycles cost zero round-trips. Refresh manually with `force_refresh`
after a migration.

## See also

- `subkit-concepts.md` — envelope fields for SQL rows.
- `rbac-and-scopes.md` — who can author workflows that write to production DBs.
- `error-recovery.md` — handling Postgres errors (23505 unique violation, etc.).
