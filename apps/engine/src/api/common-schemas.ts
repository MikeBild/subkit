// Cross-surface Zod schemas. Import from here — not from
// `http/routes/identity/schemas.ts` — whenever the schema applies to more
// than one subsystem (errors, pagination, the {id} URL param).
//
// These are the shared spine every REST route and MCP capability reads
// from so the API envelope stays identical across surfaces.

import { z } from "@hono/zod-openapi";

/**
 * Uniform error envelope stamped by `http/middleware/error.ts`. Every REST
 * surface returns this shape on any 4xx/5xx. The CLI + MCP error adapters
 * parse the same fields.
 */
export const ErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    /** Operator-friendly remediation hint — mirrors `HttpErrorBody.hint`
     *  (apps/engine/src/http/errors.ts); the sk CLI renders it verbatim. */
    hint: z.string().optional(),
    /** Seconds the client should wait before retrying. Set on 429/503. */
    retry_after: z.number().optional(),
    trace_id: z.string().optional(),
    details: z.record(z.string(), z.any()).optional(),
  })
  .openapi("Error");

/**
 * Standard `?limit=&offset=` query for list endpoints. The 200 ceiling is
 * enforced by `max(200)`; endpoints that intentionally expose a higher
 * ceiling (e.g. audit-log at 500) declare their own.
 */
export const PaginationQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

/**
 * Canonical namespace constraint for an external MCP server, shared by the
 * HTTP route body, the registry, and the config decl so all three validate
 * IDENTICALLY. Mirrors the DB CHECK on `mcp_servers.namespace` EXACTLY:
 * a URL-safe slug (alphanumeric, `_`/`-` allowed inside, length-bounded),
 * plus a ban on any `__` run. A bad slug is then a 422-able boundary error
 * everywhere, never a raw 23514 SQL error or a silent seed-time clobber.
 *
 * Single source of truth — importing this prevents the three call sites
 * from drifting apart (the failure mode the duplicated regex invited).
 */
export const MCP_NAMESPACE_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$/;

export const mcpNamespaceSchema = z
  .string()
  .regex(MCP_NAMESPACE_REGEX, "namespace must be a URL-safe slug (alphanumeric, _ or - inside)")
  .refine((s) => !s.includes("__"), "namespace must not contain '__'");

/**
 * The `{id}` URL path parameter — a UUID, with the OpenAPI `param`
 * annotation so the generated schema carries `in: path, name: id`.
 */
export const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: "id", in: "path" } }),
});

/**
 * Builder for `{ items, next_cursor? }` list-response schemas. `next_cursor`
 * is optional so existing offset-paginated routes can adopt the envelope
 * without adding a cursor backend; cursor-enabled routes (audit-log, and
 * over time the others) fill it when there are more rows.
 *
 *   const ListResponse = paginatedResponse(ConnectorSchema, "ConnectorList");
 *
 * The `name` argument drives the OpenAPI `components.schemas` key so the
 * generated client types are stable.
 */
export function paginatedResponse<Z extends z.ZodTypeAny>(
  item: Z,
  name: string,
): z.ZodObject<{
  items: z.ZodArray<Z>;
  next_cursor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}> {
  return z
    .object({
      items: z.array(item),
      // `null` means "no more pages"; omitted means the endpoint does not
      // expose a cursor (offset-paginated callers). Accepting both keeps
      // the shared envelope compatible with every existing list route.
      next_cursor: z.string().nullable().optional(),
    })
    .openapi(name);
}
