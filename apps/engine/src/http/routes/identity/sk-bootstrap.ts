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

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { conversations, roles, tenants, users } from "../../../db/schema/index.ts";
import { resolveEngineUrl } from "../../../llm/index.ts";
import { logger } from "../../../logging/index.ts";
import { can, UX_GATING_PERMISSIONS } from "../../../rbac/index.ts";
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
});

const SkBootstrapResponseSchema = z
  .object({
    whoami: SkBootstrapWhoamiSchema,
    permissions: z.array(z.string()).describe("Allowed UX-gating permissions for the principal."),
    permissions_checked: z
      .array(z.string())
      .describe("Stable list of permissions probed; reflects the engine's known UX gating set."),
    tenant: SkBootstrapTenantSchema,
    recent_sessions: z.array(SkBootstrapSessionRefSchema),
    flags: z.record(z.string(), z.boolean()).describe("Persona-visible feature flags."),
    server_time: z.string().describe("Server-side ISO timestamp; lets the CLI sync clocks."),
  })
  .openapi("SkBootstrap");

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
  },
});

export function registerSkBootstrapRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    let email: string | null = principal.email ?? null;
    let roleName: string | null = null;
    if (principal.kind === "user") {
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
      const { systemAccounts } = await import("../../../db/schema/index.ts");
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

    // Probe all UX-gating permissions in parallel. `can()` is the
    // authoritative check; failures here resolve to "not allowed"
    // rather than 500'ing the bootstrap call.
    const allowedPermissions: string[] = [];
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

    // Last 10 conversation rows the principal owns, newest first.
    // Gated on `conversation:read` (W5 review fix): even though we
    // filter by `owner_id = principal.id`, surfacing ids + titles
    // for a principal that has been explicitly denied that
    // permission would amount to a display-only leak. Skip the
    // query entirely for those principals.
    let recent: Array<{ id: string; title: string | null; updated_at: Date }> = [];
    const canReadConversations = allowedPermissions.includes("conversation:read");
    if (!canReadConversations) {
      // Skip the query; recent stays []. Documented behavior.
    } else
      try {
        recent = await db
          .select({
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
      } catch (err) {
        // conversations table is per-tenant; if a tenant has none yet
        // the query is fine, but if the schema isn't migrated or a
        // genuine DB outage hits we still don't want bootstrap to
        // fail. Log so a tenant-isolation regression (e.g. someone
        // dropping the tenant_id filter above) doesn't go silent.
        logger.warn({
          module: "http",
          action: "sk_bootstrap_recent_sessions_failed",
          msg: "recent_sessions query failed; returning empty list",
          tenant_id: principal.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
        recent = [];
      }

    return c.json(
      {
        whoami: {
          id: principal.id,
          kind: principal.kind as "user" | "system_account",
          tenant_id: principal.tenant_id,
          tenant_slug: tenantRow?.slug ?? null,
          email,
          role_name: roleName,
          provider: principal.provider,
          base_url: resolveEngineUrl(c.req.raw) ?? null,
          scopes: Array.isArray(principal.scopes) ? principal.scopes : null,
        },
        permissions: allowedPermissions,
        permissions_checked: [...UX_GATING_PERMISSIONS],
        tenant: {
          id: tenantRow?.id ?? principal.tenant_id,
          slug: tenantRow?.slug ?? null,
          display_name: tenantRow?.display_name ?? null,
        },
        recent_sessions: recent.map((r) => ({
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
