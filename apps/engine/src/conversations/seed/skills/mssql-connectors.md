---
slug: mssql-connectors
scope: global
title: MSSQL Connectors
description: Driver specifics for Microsoft SQL Server / Azure SQL — DSN, parametrised queries, schema introspection.
gates_tools: []
version: 1
---

# MSSQL Connectors

The `mssql` driver runs T-SQL against SQL Server, Azure SQL, or any
Tabular-Data-Stream-compatible endpoint. Step shape mirrors `postgres`:
one parameterised statement per step, returns the row array as the
envelope's `data`.

## DSN

`mssql://` and `sqlserver://` are both accepted. Encryption defaults to
**on**; flip with `?encrypt=false` (only for self-hosted dev). Self-signed
certificates require `?trustServerCertificate=true`.

```
sqlserver://${cred.warehouse.user}:${cred.warehouse.password}@${connector.warehouse.config.host}:1433/${connector.warehouse.config.database}?encrypt=true
```

## Step shape

Use `?@param_name` placeholders (mssql named-param convention) — the
driver maps them to `request.input(name, value)`:

```json
{
  "id": "find_user",
  "kind": "request",
  "method": "SELECT",
  "connector_id": "<warehouse_connector_id>",
  "sql": {
    "query": "SELECT id, email FROM dbo.users WHERE email = @email",
    "params": { "email": "${input.email}" }
  }
}
```

## Schema introspection

`discover_connector_endpoints({ connector_id: "<sql_server>" })` runs the
`mssql-introspect` strategy: queries `INFORMATION_SCHEMA.COLUMNS`,
primary-key constraints, and the SQL Server `sys.foreign_keys` catalog,
emitting a Markdown corpus the LLM can use to compose joins without
guessing column names. Cached in `knowledge_sources` for 24h.

## Common pitfalls

- **`sql.query` interpolation.** Same SQL injection risk as Postgres —
  always use named params, never string-concatenate input.
- **Encrypt off in production.** `?encrypt=false` is for local dev only;
  Azure SQL refuses unencrypted connections.
- **Bracketed identifiers.** Schema/table names with spaces or reserved
  words need `[brackets]`. The introspection corpus shows the canonical
  `schema.table` form.

## See also

- `postgres-connectors.md` — same shape, Postgres-specific notes.
- `rbac-and-scopes.md` — least-privilege role for workflow credentials.
