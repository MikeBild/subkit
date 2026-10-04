import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { getConfig } from "../../../config/loader.ts";
import { conversations, roles, systemAccounts, tenants, users } from "../../../db/schema/index.ts";
import { resolveEngineUrl } from "../../../llm/index.ts";
import { logger } from "../../../logging/index.ts";
import { can, UX_GATING_PERMISSIONS, type UxGatingPermission } from "../../../rbac/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const SkBootstrapWhoamiSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["user", "system_account"]),
  tenant_id: z.string().uuid(),
  tenant_slug: z.string().nullable(),
  email: z.string().nullable(),
  role_name: z.string().nullable(),
  provider: z.string(),
  base_url: z.string().nullable(),
  scopes: z.array(z.string()).nullable(),
});

const SkBootstrapTenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().nullable(),
  display_name: z.string().nullable(),
});

const SkBootstrapSessionRefSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  updated_at: z.string(),
  tenant_id: z.string().uuid(),
});

const SkBootstrapFlagsSchema = z.object({}).strict();

const UxGatingPermissionEnum = z.enum(
  UX_GATING_PERMISSIONS as unknown as readonly [UxGatingPermission, ...UxGatingPermission[]],
);

const PERMISSIONS_CHECKED_RESPONSE: UxGatingPermission[] = [...UX_GATING_PERMISSIONS];

const SkBootstrapPrefsSchema = z
  .object({
    permissionMode: z
      .enum(["ask", "auto", "plan", "yolo"])
      .describe("Default REPL permission mode."),
    theme: z.enum(["auto", "light", "dark", "high-contrast"]).describe("REPL color theme."),
    personality: z.enum(["concise", "balanced", "verbose"]).describe("Assistant response style."),
    titleFormat: z
      .enum(["session-id", "tenant-session", "model-tenant-session"])
      .describe("Window-title format used by the sk REPL."),
    statuslineFormat: z.enum(["minimal", "compact", "detailed"]).describe("Status-line layout."),
    pushNotifyEnabled: z.boolean().describe("Push-notify on long-running execution completion."),
    pushNotifyThresholdSec: z
      .number()
      .int()
      .positive()
      .describe("Threshold in seconds before notify() fires."),
    quietHoursStart: z
      .string()
      .describe("Quiet-hours window start (HH:MM, local TZ). Empty disables."),
    quietHoursEnd: z.string().describe("Quiet-hours window end (HH:MM, local TZ). Empty disables."),
    portalTokenTtlMin: z
      .number()
      .int()
      .positive()
      .describe("TTL in minutes for portal tokens minted by /session."),
  })
  .describe("REPL + UI preferences resolved for this principal.");

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
    prefs: SkBootstrapPrefsSchema,
    server_time: z.string().describe("Server-side ISO timestamp; lets the CLI sync clocks."),
  })
  .openapi("SkBootstrap");

export function enforceTenantMatch<T extends { tenant_id: string }>(
  rows: readonly T[],
  expectedTenantId: string,
):
  | { rejected: false; rows: readonly T[] }
  | { rejected: true; foreign_tenant_ids: readonly string[] } {
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

    if (principal.kind !== "user" && principal.kind !== "system_account") {
      logger.warn({
        module: "http",
        action: "sk_bootstrap_unknown_principal_kind",
        msg: "principal.kind not recognised; refusing to bootstrap",
        tenant_id: principal.tenant_id,
        principal_kind: String(principal.kind),
      });
      throw new HttpError(500, "unknown_principal_kind", "principal.kind not recognised", {
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
          role_name: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.role_id))
        .where(and(eq(users.tenant_id, principal.tenant_id), eq(users.id, principal.id)))
        .limit(1);
      if (row) {
        email = row.email ?? email;
        roleName = row.role_name;
      }
    } else {
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

    if (tenantRow && tenantRow.id !== principal.tenant_id) {
      logger.warn({
        module: "http",
        action: "sk_bootstrap_tenant_row_mismatch",
        msg: "tenants WHERE filter returned a row for a different tenant_id; refusing request",
        tenant_id: principal.tenant_id,
        row_tenant_id: tenantRow.id,
      });
      throw new HttpError(500, "tenant_row_mismatch", "tenants query returned a foreign tenant", {
        hint: "this is an engine bug — file an issue with the trace_id",
      });
    }

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
    allowedPermissions.sort();

    let recent: Array<{ tenant_id: string; id: string; title: string | null; updated_at: Date }> =
      [];
    const canReadConversations = allowedPermissions.includes("conversation:read");
    if (canReadConversations && principalKind === "user") {
      try {
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
          tenant_id: r.tenant_id,
          id: r.id,
          title: r.title,
          updated_at: r.updated_at.toISOString(),
        })),
        flags: {},
        prefs: resolvePrefs(principal.tenant_id),
        server_time: new Date().toISOString(),
      },
      200,
    );
  });
}

function resolvePrefs(tenantId: string): {
  permissionMode: "ask" | "auto" | "plan" | "yolo";
  theme: "auto" | "light" | "dark" | "high-contrast";
  personality: "concise" | "balanced" | "verbose";
  titleFormat: "session-id" | "tenant-session" | "model-tenant-session";
  statuslineFormat: "minimal" | "compact" | "detailed";
  pushNotifyEnabled: boolean;
  pushNotifyThresholdSec: number;
  quietHoursStart: string;
  quietHoursEnd: string;
  portalTokenTtlMin: number;
} {
  const cfg = getConfig();
  const overlay = cfg.tenants?.[tenantId];
  return {
    permissionMode: overlay?.repl?.permissionMode ?? cfg.repl.permissionMode,
    theme: overlay?.ui?.theme ?? cfg.ui.theme,
    personality: overlay?.ui?.personality ?? cfg.ui.personality,
    titleFormat: overlay?.ui?.title?.format ?? cfg.ui.title.format,
    statuslineFormat: overlay?.ui?.statusline?.format ?? cfg.ui.statusline.format,
    pushNotifyEnabled: overlay?.notifications?.push?.enabled ?? cfg.notifications.push.enabled,
    pushNotifyThresholdSec:
      overlay?.notifications?.push?.thresholdSec ?? cfg.notifications.push.thresholdSec,
    quietHoursStart:
      overlay?.notifications?.push?.quietHoursStart ?? cfg.notifications.push.quietHoursStart,
    quietHoursEnd:
      overlay?.notifications?.push?.quietHoursEnd ?? cfg.notifications.push.quietHoursEnd,
    portalTokenTtlMin: overlay?.repl?.portalTokenTtlMin ?? cfg.repl.portalTokenTtlMin,
  };
}
