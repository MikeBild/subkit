// Composite startup payload for the `sk` CLI.
//
// The CLI used to issue ~22 separate RBAC probes against the engine on
// every session start to figure out which slash commands the persona
// could see. This single endpoint replaces that fan-out: it returns
// whoami + the precomputed allow-set for the well-known UX-gating
// permissions + a small tenant snapshot + the most recent sessions.
//
// Read-only; emits no audit (it's a discovery call). Returns 401 via
// `requireAuth` for unauthenticated callers; once authenticated, the
// route returns 200 — RBAC is for individual permission decisions,
// not for "may I bootstrap". Errors against the recent_sessions
// query and per-permission RBAC probes are logged at warn so they
// surface in /v1/diagnostics/errors instead of being silently
// swallowed.
//
// RBAC carve-out (R3-S1): this route, like `whoami`, intentionally
// has no `permission:` parameter on the route definition. The
// engine's general rule is "every route declares an explicit
// permission"; the documented exception is the *self-introspection*
// family — `whoami`, `bootstrap`, `health`, `metrics` — where
// gating on a permission-the-caller-doesn't-have-yet would create a
// chicken-and-egg problem (you can't discover that you have any
// permissions if discovery itself requires one). The
// `audit-invariants` script's `route_layering` check is satisfied
// because the route imports from `rbac/index.ts` (the subsystem
// barrel), not from a subsystem internal. If a future tightening
// adds a `self:read` permission, that gate would land here without
// affecting clients (every authenticated principal would receive
// it by default).

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { conversations, roles, systemAccounts, tenants, users } from "../../../db/schema/index.ts";
import { resolveEngineUrl } from "../../../llm/index.ts";
import { logger } from "../../../logging/index.ts";
import { can, UX_GATING_PERMISSIONS, type UxGatingPermission } from "../../../rbac/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const SkBootstrapWhoamiSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "system_account"]),
  tenant_id: z.string(),
  tenant_slug: z.string().nullable(),
  email: z.string().nullable(),
  role_name: z.string().nullable(),
  provider: z.string(),
  base_url: z.string().nullable(),
  scopes: z.array(z.string()).nullable(),
});

const SkBootstrapTenantSchema = z.object({
  id: z.string(),
  slug: z.string().nullable(),
  display_name: z.string().nullable(),
});

const SkBootstrapSessionRefSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  updated_at: z.string(),
  // R4-S3 review fix: each row carries its tenant_id so a forensic
  // reader cross-correlating session ids out of context (logs, bug
  // reports) can immediately tell which tenant a session belonged to.
  // Always equal to the parent `tenant.id`; the redundancy is
  // deliberate and load-bearing for incident-response tooling.
  tenant_id: z.string(),
});

// Closed object of feature flags the bootstrap response is allowed to
// surface to the CLI. New flags MUST be added as a keyed property
// here AND mirrored in `apps/sk/src/lib/bootstrap.ts` consumer types
// so a typo on either side fails to compile. R2-S8 review fix —
// was previously `record(string, boolean)` which silently absorbed
// typos.
//
// `.partial().strict()` together mean: every flag key is optional in
// the response (a flag may be omitted when its decision isn't
// computed for the persona), but NO unknown keys are allowed (a typo
// in a future flag name fails the response Zod validation rather
// than silently disabling client-side gating).
//
// R5-S2 review fix: drop the `_unused` placeholder. zod accepts an
// empty `.object({}).strict()` just fine; the previous concern was
// a phantom. The empty strict object means the engine ships
// `flags: {}` over the wire (zero placeholder fields), unknown keys
// fail Zod response validation, and the typed enum lives in the
// generated openapi types as an empty `flags: {}` shape — when the
// first real flag lands, add it as a property here AND in the CLI
// consumer types in `apps/sk/src/lib/bootstrap.ts` (drift catcher
// established by R4-W1).
const SkBootstrapFlagsSchema = z.object({}).strict();

// `as const` round-trip: zod's `z.enum(...)` requires a tuple of
// string literals, so spread + cast preserves the literal narrowing
// from `UX_GATING_PERMISSIONS`. R4-W2 originally used a wider
// `[string, ...string[]]` cast — R9-S3 narrows it to the typed
// permission tuple so the enum's parsed type is `UxGatingPermission`,
// not `string`.
const UxGatingPermissionEnum = z.enum(
  UX_GATING_PERMISSIONS as unknown as readonly [UxGatingPermission, ...UxGatingPermission[]],
);

// R9-S4: response-side `permissions_checked` is invariant across
// every request. Allocate the closed array once at module load
// rather than rebuilding it on every call. Pairs with the R7-W1
// sort-determinism comment.
//
// `Object.freeze` would give a `readonly` array which the Hono
// response handler refuses to assign (mutable expected). The closed
// array is kept private via the `// no-export` convention; nothing
// in this module mutates it.
const PERMISSIONS_CHECKED_RESPONSE: UxGatingPermission[] = [...UX_GATING_PERMISSIONS];

const SkBootstrapResponseSchema = z
  .object({
    whoami: SkBootstrapWhoamiSchema,
    permissions: z
      .array(UxGatingPermissionEnum)
      .describe("Allowed UX-gating permissions for the principal."),
    permissions_checked: z
      .array(UxGatingPermissionEnum)
      .describe("Stable list of permissions probed; reflects the engine's known UX gating set."),
    tenant: SkBootstrapTenantSchema,
    recent_sessions: z.array(SkBootstrapSessionRefSchema),
    flags: SkBootstrapFlagsSchema.describe(
      "Persona-visible feature flags. Keys are drawn from a typed enum.",
    ),
    server_time: z.string().describe("Server-side ISO timestamp; lets the CLI sync clocks."),
  })
  .openapi("SkBootstrap");

/**
 * Defensive guard exposed for unit testing (R9-C1). Returns the
 * input rows iff EVERY row's `tenant_id` matches `expectedTenantId`;
 * otherwise returns `[]` and the caller must log the rejection. The
 * `recent_sessions` SQL filter already constrains `tenant_id`, so
 * this guard is unreachable today — its job is to defend against a
 * future refactor that drops the filter. The integration test can't
 * exercise the heterogeneous-rows path because the DB never produces
 * one; this helper lets a unit test stub the rows and pin the
 * "reject the batch" contract.
 */
export function enforceTenantMatch<T extends { tenant_id: string }>(
  rows: readonly T[],
  expectedTenantId: string,
):
  | { rejected: false; rows: readonly T[] }
  | { rejected: true; foreign_tenant_ids: readonly string[] } {
  // R10-S1: narrowed discriminator. The rejected variant intentionally
  // does NOT carry a `rows` field — TypeScript fails the build at any
  // call site that tries to read `result.rows` without first checking
  // `!result.rejected`. The runtime tests in
  // `sk-bootstrap-tenant-guard.test.ts` continue to pin the runtime
  // shape; this is purely a typecheck-time tightening.
  const allMatch = rows.every((r) => r.tenant_id === expectedTenantId);
  if (allMatch) return { rejected: false, rows };
  const foreign = [
    ...new Set(rows.filter((r) => r.tenant_id !== expectedTenantId).map((r) => r.tenant_id)),
  ];
  return { rejected: true, foreign_tenant_ids: foreign };
}

const route = createRoute({
  method: "get",
  path: "/v1/sk/bootstrap",
  tags: ["identity"],
  summary: "Composite startup payload for the sk CLI (whoami + permissions + recent sessions)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SkBootstrapResponseSchema } },
    },
    // R10-W2 review fix: declare the error envelopes the route can
    // actually emit. The global `errorMiddleware` already stamps the
    // shape at runtime, but generated OpenAPI clients couldn't see
    // it before. 401 from `requireAuth`, 500 from
    // `unknown_principal_kind` / `tenant_row_mismatch`.
    401: {
      description: "Unauthenticated — no bearer or invalid bearer.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal — engine bug or schema regression.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerSkBootstrapRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    // R6-W2 review fix: narrow `principal.kind` once at the top
    // rather than casting at the response-build site. The auth layer
    // produces `"user" | "system_account"` today, but a future
    // expansion (machine identity? tenant agent?) would silently 500
    // the route via the response Zod's enum check. Fail loud here
    // instead — the operator gets a structured 500 with a code, not
    // a Zod schema error.
    if (principal.kind !== "user" && principal.kind !== "system_account") {
      logger.warn({
        module: "http",
        action: "sk_bootstrap_unknown_principal_kind",
        msg: "principal.kind not recognised; refusing to bootstrap",
        tenant_id: principal.tenant_id,
        principal_kind: String(principal.kind),
      });
      // R9-W4: route through the structured envelope so the operator
      // gets a `code` + `hint` + `details` instead of a generic
      // `internal_error`.
      throw HttpError.withEnvelope(500, "unknown_principal_kind", "principal.kind not recognised", {
        hint: "this is an engine bug — file an issue with the trace_id",
        details: { principal_kind: String(principal.kind) },
      });
    }
    const principalKind: "user" | "system_account" = principal.kind;

    let email: string | null = principal.email ?? null;
    let roleName: string | null = null;
    if (principalKind === "user") {
      const [row] = await db
        .select({
          email: users.email,
          role_legacy: users.role,
          role_name: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.role_id))
        .where(and(eq(users.tenant_id, principal.tenant_id), eq(users.id, principal.id)))
        .limit(1);
      if (row) {
        email = row.email ?? email;
        roleName = row.role_name ?? row.role_legacy ?? null;
      }
    } else {
      // R7-W4: hoisted to the static import at the top of the file.
      // The previous dynamic import was unnecessary, slightly slower
      // per-call, and broke cold-start tree-shaking analysis.
      const [row] = await db
        .select({ role_name: roles.name })
        .from(systemAccounts)
        .leftJoin(roles, eq(roles.id, systemAccounts.role_id))
        .where(
          and(
            eq(systemAccounts.tenant_id, principal.tenant_id),
            eq(systemAccounts.id, principal.id),
          ),
        )
        .limit(1);
      roleName = row?.role_name ?? null;
    }

    const [tenantRow] = await db
      .select({ id: tenants.id, slug: tenants.slug, display_name: tenants.display_name })
      .from(tenants)
      .where(eq(tenants.id, principal.tenant_id))
      .limit(1);

    // R8-S5: pair the recent_sessions row-level guard with a
    // tenant-row guard. If `tenantRow.id !== principal.tenant_id`
    // the WHERE clause was bypassed somehow — refuse the request
    // rather than silently coercing into the wrong tenant.
    if (tenantRow && tenantRow.id !== principal.tenant_id) {
      logger.warn({
        module: "http",
        action: "sk_bootstrap_tenant_row_mismatch",
        msg: "tenants WHERE filter returned a row for a different tenant_id; refusing request",
        tenant_id: principal.tenant_id,
        row_tenant_id: tenantRow.id,
      });
      throw HttpError.withEnvelope(
        500,
        "tenant_row_mismatch",
        "tenants query returned a foreign tenant",
        {
          hint: "this is an engine bug — file an issue with the trace_id",
        },
      );
    }

    // Probe all UX-gating permissions in parallel. `can()` is the
    // authoritative check; failures here resolve to "not allowed"
    // rather than 500'ing the bootstrap call.
    // R7-W1: keep insertion order deterministic across cache writes
    // by collecting decisions in a Map keyed on the canonical
    // `UX_GATING_PERMISSIONS` order, then sorting before responding.
    // `Promise.all` order of resolution is non-deterministic — the
    // previous `.push(perm)` racing pattern emitted permissions in
    // resolution order, which meant two consecutive cache writes
    // for the same principal could differ on disk. Benign for the
    // Set-based consumer but inflates cache-diff noise unnecessarily.
    const allowedPermissions: UxGatingPermission[] = [];
    await Promise.all(
      UX_GATING_PERMISSIONS.map(async (perm) => {
        try {
          const decision = await can(db, {
            tenant_id: principal.tenant_id,
            principal,
            permission: perm,
          });
          if (decision.allow) allowedPermissions.push(perm);
        } catch (err) {
          // The engine still enforces RBAC on the actual call, so the
          // operator at worst sees a slash command they can't invoke.
          // Log so a real failure (db outage, malformed policy row)
          // shows up in /v1/diagnostics/errors instead of being
          // silently elided into "permission denied".
          logger.warn({
            module: "rbac",
            action: "sk_bootstrap_can_failed",
            msg: "rbac probe failed during sk-bootstrap; treating as deny",
            tenant_id: principal.tenant_id,
            permission: perm,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    // R7-W1: stable lexicographic order across writes.
    allowedPermissions.sort();

    // Last 10 conversation rows the principal owns, newest first.
    // Gated on `conversation:read` (W5 review fix): even though we
    // filter by `owner_id = principal.id`, surfacing ids + titles
    // for a principal that has been explicitly denied that
    // permission would amount to a display-only leak. Skip the
    // query entirely for those principals.
    // R6-S1 review fix: flatten the previous empty-if-then-else
    // shape into a positive guard. Two contracts encoded here:
    //   - R5: must hold `conversation:read` (display-only leak gate)
    //   - R2-S7: must be a `user` principal (system_accounts and
    //     portal-tokens never own conversations today)
    let recent: Array<{ tenant_id: string; id: string; title: string | null; updated_at: Date }> =
      [];
    const canReadConversations = allowedPermissions.includes("conversation:read");
    if (canReadConversations && principalKind === "user") {
      try {
        // R7-W5 review fix: select `conversations.tenant_id` from the
        // DB and assert at response-build time that every row matches
        // `principal.tenant_id`. By query construction these are
        // equal — but if a future refactor drops the `tenant_id`
        // filter (the regression the existing comment warns about),
        // this assertion catches it before a row leaks.
        const rows = await db
          .select({
            tenant_id: conversations.tenant_id,
            id: conversations.id,
            title: conversations.title,
            updated_at: conversations.updated_at,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenant_id, principal.tenant_id),
              eq(conversations.owner_id, principal.id),
            ),
          )
          .orderBy(desc(conversations.updated_at))
          .limit(10);
        // R9-C1 (CRITICAL fix): defensive guard via `enforceTenantMatch`
        // (testable unit). The previous loop+break+post-check was
        // structurally broken — heterogeneous `rows` would put every
        // row back including the foreign one. The helper accepts the
        // whole batch iff every row matches.
        const guard = enforceTenantMatch(rows, principal.tenant_id);
        if (guard.rejected) {
          logger.warn({
            module: "http",
            action: "sk_bootstrap_tenant_mismatch",
            msg: "recent_sessions rows carried foreign tenant_id; rejecting batch",
            tenant_id: principal.tenant_id,
            foreign_tenant_ids: guard.foreign_tenant_ids,
          });
          recent = [];
        } else {
          recent = [...guard.rows];
        }
      } catch (err) {
        // conversations table is per-tenant; if a tenant has none yet
        // the query is fine, but if the schema isn't migrated or a
        // genuine DB outage hits we still don't want bootstrap to
        // fail. Log so a tenant-isolation regression doesn't go silent.
        logger.warn({
          module: "http",
          action: "sk_bootstrap_recent_sessions_failed",
          msg: "recent_sessions query failed; returning empty list",
          tenant_id: principal.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
        recent = [];
      }
    }

    return c.json(
      {
        whoami: {
          id: principal.id,
          kind: principalKind,
          tenant_id: principal.tenant_id,
          tenant_slug: tenantRow?.slug ?? null,
          email,
          role_name: roleName,
          provider: principal.provider,
          base_url: resolveEngineUrl(c.req.raw) ?? null,
          // R4-W4: filter to strings, not just `Array.isArray`. If
          // legacy data ships a non-string entry (schema migration
          // miss), the bare cast would 500 the bootstrap call when
          // the response Zod validator runs.
          scopes: Array.isArray(principal.scopes)
            ? principal.scopes.filter((s): s is string => typeof s === "string")
            : null,
        },
        permissions: allowedPermissions,
        permissions_checked: PERMISSIONS_CHECKED_RESPONSE,
        tenant: {
          id: tenantRow?.id ?? principal.tenant_id,
          slug: tenantRow?.slug ?? null,
          display_name: tenantRow?.display_name ?? null,
        },
        recent_sessions: recent.map((r) => ({
          // R7-W5: use the row's `tenant_id` directly. The defensive
          // assertion above guarantees it equals `principal.tenant_id`
          // (or the batch was rejected entirely), so this propagates
          // the DB invariant rather than a CLI-side cast.
          tenant_id: r.tenant_id,
          id: r.id,
          title: r.title,
          updated_at: r.updated_at.toISOString(),
        })),
        flags: {},
        server_time: new Date().toISOString(),
      },
      200,
    );
  });
}
