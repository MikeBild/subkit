---
name: subkit-connector-patterns
description: Add or modify a connector template, driver, or auth flow in subkit. Use when the task mentions a connector, an external system (HubSpot, Stripe, GitHub, etc.), a driver protocol (HTTP/GraphQL/Postgres/S3/FTP/SFTP/SMB/MSSQL/Redis), or OAuth2 flows.
---

# subkit Connector Patterns

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

Everything connector-related lives under `apps/engine/src/connectors/`. Nine typed
drivers (`drivers/http.ts`, `graphql.ts`, `postgres.ts`, `s3.ts`, `ftp.ts`, `sftp.ts`,
`smb.ts`, `mssql.ts`, `redis.ts`) fan out from a single `service.ts`. Templates are
declarative JSON (`templates.json`, currently 90 entries) with optional
connector-bound skills (`template-skills.json`).

Two conversation tools bootstrap a connector from a URL or a spec:

- `match_connector_template_by_url` — extract domain + path, return the best-fit template slug so the authoring loop can pick a template instead of hand-rolling one.
- `import_connector_from_spec` — parse `curl | openapi | graphql | graphql_introspection | postman | har` input, return a connector draft enriched from the best-match template (falls back to the `http` driver when no template matches).

Both are exposed on the HTTP API, the MCP surface, and through the sk CLI.

## Canonical references

- `docs/05-connectors.md` — Connector model, drivers, templates, auth, tunnels, schema versions.
- `docs/07-security-governance.md` — Credentials, OAuth2, crypto, credential vault.
- `docs/04-authoring.md` — Documentation ingestion and the connector template catalog context.

## Add a connector template

1. Read 2–3 existing templates in `apps/engine/src/connectors/templates.json` close to
   the new target (same auth type, same protocol). Mirror their shape.
2. Add the entry to `templates.json`. Required fields are defined in
   `connectors/types.ts` (read first).
3. If the connector ships documentation (OpenAPI / GraphQL schema URL): add an
   ingestion entry so `docs-ingestion/` picks it up at Connector creation time.
4. If the template has opinionated defaults or helpful skills: add them to
   `template-skills.json`, scoped to `connector`.
5. Add a unit test in `apps/engine/src/connectors/tests/` asserting the template
   validates, resolves to a driver, and produces the expected baseline Connector shape.
6. Regenerate OpenAPI types if you touched the public Connector surface
   (`bun run typecheck` will flag drift).

## Add a new driver protocol (rare)

This is architectural. Confirm with the user first — the 9 drivers cover HTTP, GraphQL,
Postgres, S3, FTP, SFTP, SMB, MSSQL, and Redis and the system assumes these.

1. New file under `drivers/` implementing the driver interface exported from `index.ts`.
2. Update `connectors/types.ts` with the new driver discriminator.
3. Update `service.ts` dispatch.
4. Wire into `execution/` step dispatch (`request`, `call` kinds).
5. Add to `sandboxes/` if it accepts user-supplied code.
6. Full test coverage: unit for the driver, integration for the HTTP surface.
7. Document it: add `docs/05-connectors.md` sections, example template.

## OAuth2 flows

- Token acquisition, refresh, and rotation all live in `apps/engine/src/oauth2/`.
- Credentials are stored **encrypted** via `apps/engine/src/credentials/` + `crypto/` (AES-256-GCM).
- Every refresh / rotation writes an `audit_log` entry. Do not bypass.

## Things not to do

- **No secrets in `templates.json`.** Templates declare the *shape* of credentials; real
  credentials live in the encrypted store.
- **No hand-rolled HTTP clients.** Use the shared HTTP driver; you get retries,
  redirects, docs ingestion, sandbox hooks, and observability for free.
- **No direct filesystem or network from `sandboxes/`-run code.** Sandboxed code has
  no I/O.
- **Don't skip the Environment tag.** Every Connector carries `environment` (`dev | prod`).
  Composite identity is `(connector_id, environment)`.
