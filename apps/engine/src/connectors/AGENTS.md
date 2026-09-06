# connectors — directory contract

Connectors are subkit's representation of external systems (Stripe, Slack,
Postgres clusters, S3 buckets). Every workflow step that talks to "the
outside" goes through a connector. This directory owns the data model,
template registry, and driver dispatch; credentials and docs live in
sibling subsystems but are surfaced together via the `ConnectorSystem`
facade.

## ConnectorSystem facade — single entry point

`system.ts` exposes `loadConnectorSystem(tenant_id, connector_id, environment, exec?)`.
The returned `ConnectorSystem` carries:

- `id` / `tenantId` / `environment` — identity scope.
- `driver` — the resolved protocol driver name (HTTP, GraphQL, Postgres, S3, …).
- `templateVersion` — template-version pin for drift correlation; the
  self-healing drift detector keys per-endpoint shape records on this.
- `connector` — the underlying `ConnectorView` row.
- `getCredentials()` — lazy decrypt of the credential row for this
  environment. Returns `null` when none configured (e.g. probe path).
- `getDocumentation()` — lazy list of ingested document summaries
  (OpenAPI / GraphQL schema / markdown).
- `getAuthorityMetadata()` — metadata-only credential/connection identity and
  permission revisions. It never decrypts a token or initiates OAuth refresh;
  execution-authority preparation uses this instead of `getCredentials()`.

**Rule:** every consumer that needs more than one of (driver, creds, docs)
goes through this facade. Direct calls into `getCredentialForConnector` /
`listDocs` / `getConnectorForEnvironment` are fine in single-purpose code
paths (e.g. an OAuth refresh worker only needs creds), but the
conversation tools and execution steps that orchestrate all three should
use the facade so the tenant + environment fall-back invariants are
enforced in one place.

The facade covers the read side (driver, creds, docs). Write-side
enrichment intentionally stays out of it — template merging is a
write-time concern handled by `template-enrichment.ts` at
connector-creation time. The facade type is named `ConnectorSystem`
(not `System`) so subkit's domain vocabulary stays consistent
(Connector / Workflow / Skill / Execution).

## Templates vs connectors

- `templates.json` — read-only catalogue, validated at boot, ships in the
  binary. Each entry is a recipe (driver, auth modes, base URL, default
  endpoints) that a connector instance can be created from.
- `template-skills.json` — sibling catalogue of LLM prompt fragments. Every
  template's `default_skill` must resolve here; boot-time validation in
  `templates.ts` `loadBuiltinTemplates()` enforces this.
- `connectors` table — runtime instances, multi-tenant, encrypted creds.

When a tenant's `connector_templates` row shadows a built-in template (same
slug), the override wins. Existing connectors keep their pinned
`template_snapshot`; only newly created instances see updates.

## Drivers

`drivers/` holds the protocol-specific implementations. Each driver
exports a small surface (build the request plan, execute, parse the
response). The HTTP driver also exports `applyAuthMaterial` which the
GraphQL driver re-uses; that's the single shared auth helper in the
codebase.

Driver errors should throw `ConnectorOperationError` (re-exported from
`@shared/connector-operation-error.ts`) with a stable `code` so
observability + self-healing can react without parsing free-form messages.

## Discovery

`discovery/` runs at conversation time when the agent needs to enumerate
endpoints for a connector that wasn't pre-templated. The strategy
inventory is documented in `discovery/types.ts`.
