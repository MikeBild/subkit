import { z } from "@hono/zod-openapi";
import { getConfig } from "../../config/loader.ts";
import { computeConnectorScopeDiff } from "../../connectors/oauth-scope-diff.ts";
import { getConnector } from "../../connectors/service.ts";
import { HttpError } from "../../http/errors.ts";
import {
  findSystemAccountRoleName,
  findTenantSummary,
  findUserProfile,
  listRecentOwnedConversations,
  loadWhoamiProfile,
} from "../../identity/principal-profile.ts";
import { resolveEngineUrl } from "../../llm/runtime-context.ts";
import { logger } from "../../logging/index.ts";
import { can, connectorAccessLevel } from "../../rbac/evaluator.ts";
import { isOperatorPrincipal } from "../../rbac/operator.ts";
import { UX_GATING_PERMISSIONS, type UxGatingPermission } from "../../rbac/ux-gating.ts";
import { defineOperation, type OperationScope, reject } from "./index.ts";

const TAGS = ["identity"] as const;

function baseUrl(scope: OperationScope): string | null {
  return scope.request ? (resolveEngineUrl(scope.request) ?? null) : null;
}

const WhoamiSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["user", "system_account"]),
    tenant_id: z.string(),
    tenant_slug: z.string().nullable(),
    email: z.string().nullable(),
    role_name: z.string().nullable(),
    provider: z.string(),
    base_url: z.string().nullable(),
    scopes: z.array(z.string()).nullable(),
    product_id: z
      .string()
      .nullable()
      .describe("App the caller signed in to through an oidc_bearer provider, or null"),
    engine_operator: z
      .boolean()
      .describe("True when the caller belongs to the engine operator workspace"),
  })
  .openapi("Whoami");

type Whoami = z.infer<typeof WhoamiSchema>;

export const whoamiOperation = defineOperation<null, Whoami>({
  id: "identity.whoami",
  summary: "Return identity info about the authenticated caller",
  permission: null,
  effect: "read",
  async handler(scope) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const profile = await loadWhoamiProfile(scope.db, principal);
    return {
      id: principal.id,
      kind: principal.kind as "user" | "system_account",
      tenant_id: principal.tenant_id,
      tenant_slug: profile.tenant_slug,
      email: profile.email,
      role_name: profile.role_name,
      provider: principal.provider,
      base_url: baseUrl(scope),
      scopes: Array.isArray(principal.scopes) ? principal.scopes : null,
      product_id: principal.product_id ?? null,
      engine_operator: await isOperatorPrincipal(scope.db, principal),
    };
  },
  http: {
    method: "get",
    path: "/v1/identity/whoami",
    tags: TAGS,
    response: WhoamiSchema,
    toInput: () => null,
    toBody: (whoami) => whoami,
  },
});

const ConnectorScopeDiffSchema = z
  .object({
    partial_grant: z.union([z.boolean(), z.literal("unknown")]),
    expected: z.array(z.string()),
    granted: z.array(z.string()),
    missing: z.array(z.string()),
    note: z.string().optional(),
  })
  .nullable();

const PermissionsSchema = z
  .object({
    resource_type: z.literal("connector"),
    resource_id: z.string(),
    level: z.enum(["none", "read-only", "read-write"]),
    credential_scopes: ConnectorScopeDiffSchema,
  })
  .openapi("EffectivePermissions");

const PermissionsQuery = z.object({
  resource_type: z.literal("connector"),
  resource_id: z.string().min(1),
});

type PermissionsInput = z.infer<typeof PermissionsQuery>;
type EffectivePermissions = z.infer<typeof PermissionsSchema>;

export const effectivePermissionsOperation = defineOperation<
  PermissionsInput,
  EffectivePermissions
>({
  id: "identity.permissions.effective",
  summary: "Effective permissions of the authenticated caller on a resource",
  permission: null,
  effect: "read",
  async handler(scope, { resource_id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const level = await connectorAccessLevel(scope.db, principal, resource_id, scope.tenant_id);
    const connector = await getConnector(scope.tenant_id, resource_id, scope.db);
    const credentialScopes = connector
      ? await computeConnectorScopeDiff(scope.db, scope.tenant_id, connector)
      : null;
    return {
      resource_type: "connector" as const,
      resource_id,
      level,
      credential_scopes: credentialScopes,
    };
  },
  http: {
    method: "get",
    path: "/v1/identity/permissions",
    tags: TAGS,
    query: PermissionsQuery,
    response: PermissionsSchema,
    toInput: ({ query }) => query as PermissionsInput,
    toBody: (permissions) => permissions,
  },
});

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

type SkBootstrap = z.infer<typeof SkBootstrapResponseSchema>;
type SkBootstrapPrefs = z.infer<typeof SkBootstrapPrefsSchema>;

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

function resolvePrefs(tenantId: string): SkBootstrapPrefs {
  const cfg = getConfig();
  const overlay = cfg.tenants?.[tenantId];
  return {
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

interface RecentSession {
  readonly tenant_id: string;
  readonly id: string;
  readonly title: string | null;
  readonly updated_at: Date;
}

export const skBootstrapOperation = defineOperation<null, SkBootstrap>({
  id: "identity.sk_bootstrap",
  summary: "Composite startup payload for the sk CLI (whoami + permissions + recent sessions)",
  permission: null,
  effect: "read",
  async handler(scope) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    if (principal.product_id) return reject.notFound("bootstrap");
    const db = scope.db;

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
      const row = await findUserProfile(db, principal.tenant_id, principal.id);
      if (row) {
        email = row.email ?? email;
        roleName = row.role_name;
      }
    } else {
      roleName = await findSystemAccountRoleName(db, principal.tenant_id, principal.id);
    }

    const tenantRow = await findTenantSummary(db, principal.tenant_id);

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

    let recent: RecentSession[] = [];
    const canReadConversations = allowedPermissions.includes("conversation:read");
    if (canReadConversations && principalKind === "user") {
      try {
        const rows = await listRecentOwnedConversations(db, principal.tenant_id, principal.id);
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

    return {
      whoami: {
        id: principal.id,
        kind: principalKind,
        tenant_id: principal.tenant_id,
        tenant_slug: tenantRow?.slug ?? null,
        email,
        role_name: roleName,
        provider: principal.provider,
        base_url: baseUrl(scope),
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
    };
  },
  http: {
    method: "get",
    path: "/v1/sk/bootstrap",
    tags: TAGS,
    response: SkBootstrapResponseSchema,
    errors: {
      401: "Unauthenticated — no bearer or invalid bearer.",
      404: "Product principals have no CLI bootstrap.",
      500: "Internal — engine bug or schema regression.",
    },
    toInput: () => null,
    toBody: (bootstrap) => bootstrap,
  },
});
