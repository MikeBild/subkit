---
name: subkit-api-and-openapi
description: Add or modify HTTP routes, MCP tools, or public request/response types in subkit. Zod-first discipline — the OpenAPI surface is generated, not hand-written. Use whenever you touch apps/engine/src/http/routes/, apps/engine/src/api/, or apps/engine/src/mcp/.
---

# subkit API And OpenAPI Discipline

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

subkit uses `@hono/zod-openapi`. **Zod schemas are the source of truth.** The
`/openapi.json` surface and generated clients come from the same schemas — never
edit the OpenAPI output by hand.

## Canonical references

- `docs/03-input-surfaces.md` — REST API surface, MCP server, SSE streaming, OpenAPI generation.
- `docs/07-security-governance.md` — RBAC on every route, tenant scoping.

## Adding an HTTP route

1. Define request and response Zod schemas in `apps/engine/src/api/` (or alongside the
   route if truly route-local and not shared). Name them consistently with existing
   schemas.
2. Register the route in `apps/engine/src/http/routes/<area>/` using
   `@hono/zod-openapi`'s `createRoute` + `OpenAPIHono.openapi()`. Match the existing
   naming and error-shape conventions.
3. **Gate the route with RBAC.** Use the permission / policy helpers in
   `apps/engine/src/rbac/`. A route without an explicit permission is a bug.
4. **Carry `tenant_id` and actor context.** Routes are tenant-scoped; read the tenant
   from the auth context, not from the request body.
5. **Emit an audit entry** if the route mutates state (`audit/` helpers). Include
   request-source (one of `api | cli | scheduler | mcp | webhook | tool-chain | ui`).
6. **Structured logger only.** `logging/` context, not `console.*`.
7. Add an integration test under `apps/engine/src/http/` (real Postgres via
   testcontainers). Cover at minimum: happy path, RBAC denial, validation error.
8. Run `bun run test:integration` and `bun run typecheck`. OpenAPI drift surfaces as a
   type error.

## Adding an MCP tool

1. Define the tool schema in `apps/engine/src/mcp/`. Same Zod-first rule.
2. Wire it into the server registry.
3. Apply the same RBAC + audit + tenant-scope rules as REST routes.
4. MCP progress notifications live on the same streaming primitives as SSE — see
   `docs/03-input-surfaces.md`.

## Things not to do

- **Do not hand-edit `/openapi.json`** or any generated client. Edit the Zod schema,
  let generation run.
- **Do not add `z.any()` or untyped pass-through** at the boundary. If the shape is
  genuinely polymorphic, use `z.discriminatedUnion`.
- **Do not skip RBAC** even on "read-only" routes. Everything is tenant-scoped; a
  missing tenant check is a bug.
- **Do not bypass the audit log** for state-mutating endpoints.
- **Do not return raw error messages** containing secrets. Use the shared error shape
  in `apps/engine/src/http/` (it redacts via `crypto/redaction`).

## Remediation hints on error envelopes

The error envelope (`HttpErrorBody` in `apps/engine/src/http/errors.ts`, mirrored by
`ErrorSchema` in `apps/engine/src/api/common-schemas.ts`) carries an optional `hint`
field that the sk CLI renders verbatim under the error line. Convention:

- Every throw site whose failure has a **non-obvious next step** should set a hint via
  `HttpError.withEnvelope(status, code, message, { hint })` — name the exact command or
  endpoint that resolves it (e.g. `GET /v1/workflows/{id}/input-schema`,
  `sk patch-candidates list`).
- Hints are operator-facing prose, one sentence, no secrets, no internal file paths.
- 4xx responses built with bare `c.json({...}, status)` (non-throwing handlers) include
  the same optional `hint` key so the shape stays uniform.
