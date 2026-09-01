import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import {
  activateRuntimeRevision,
  createSecretVersion,
  getActivationReplicas,
  getRuntimeConfigState,
  getRuntimeRevision,
  listRuntimeRevisions,
  listSecretVersions,
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigValidationError,
  RuntimeSecretInUseError,
  revokeSecretVersion,
  saveRuntimeConfigPatch,
} from "../../runtime-config/service.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const RevisionNumber = z.coerce.number().int().positive();
const RevisionParam = z.object({
  revision: RevisionNumber.openapi({ param: { name: "revision", in: "path" } }),
});
const SecretParam = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/)
    .openapi({ param: { name: "name", in: "path" } }),
});
const SecretVersionParam = SecretParam.extend({
  version: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: "version", in: "path" } }),
});

const RevisionStatusSchema = z.enum(["saved", "preparing", "active", "failed", "restart_required"]);

const ConfigStateSchema = z
  .object({
    saved_revision: z.number().int().positive(),
    active_revision: z.number().int().positive(),
    activation_status: RevisionStatusSchema,
    pending_restart_fields: z.array(z.string()),
  })
  .openapi("RuntimeConfigState");

const RevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    document: z.record(z.string(), z.unknown()),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    status: RevisionStatusSchema,
    pending_restart_fields: z.array(z.string()),
    failure_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    activated_at: z.string().datetime().nullable(),
  })
  .openapi("RuntimeConfigRevision");

const PatchSettingsBody = z
  .object({
    expected_revision: z.number().int().positive(),
    changes: z.record(z.string().min(1), z.unknown()),
    scope: z.enum(["global", "tenant"]),
    tenant_id: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "tenant" && !value.tenant_id) {
      ctx.addIssue({ code: "custom", path: ["tenant_id"], message: "required for tenant scope" });
    }
    if (value.scope === "global" && value.tenant_id) {
      ctx.addIssue({
        code: "custom",
        path: ["tenant_id"],
        message: "not allowed for global scope",
      });
    }
  })
  .openapi("RuntimeConfigPatch");

const SecretCreateBody = z.object({ value: z.string().min(1).max(65_536) }).openapi("SecretValue");

function revisionWire(revision: Awaited<ReturnType<typeof getRuntimeRevision>>) {
  return {
    ...revision,
    created_at: revision.created_at.toISOString(),
    activated_at: revision.activated_at?.toISOString() ?? null,
  };
}

function mayManageTenant(
  principal: ReturnType<typeof requireAuth>,
  tenantId: string | undefined,
): boolean {
  if (!tenantId || tenantId === principal.tenant_id) return true;
  return (
    (principal.tenant_id === SYSTEM_TENANT_ID && principal.roles.includes("admin")) ||
    (principal.scopes?.includes("settings:write:global") ?? false)
  );
}

function mapRuntimeConfigError(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["onError"]>[0]>[1],
  error: unknown,
) {
  if (error instanceof RuntimeConfigConflictError || error instanceof RuntimeSecretInUseError) {
    return c.json({ code: error.code, message: error.message }, 409);
  }
  if (error instanceof RuntimeConfigValidationError) {
    return c.json({ code: error.code, message: error.message }, 422);
  }
  if (error instanceof RuntimeConfigNotFoundError) {
    return c.json({ code: error.code, message: error.message }, 404);
  }
  throw error;
}

const getSettingsRoute = createRoute({
  method: "get",
  path: "/v1/settings/runtime",
  tags: ["settings"],
  summary: "Read the canonical saved and active runtime configuration",
  responses: {
    200: {
      description: "Current runtime configuration state",
      content: {
        "application/json": {
          schema: ConfigStateSchema.extend({ settings: z.record(z.string(), z.unknown()) }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchSettingsRoute = createRoute({
  method: "patch",
  path: "/v1/settings",
  tags: ["settings"],
  summary: "Save an immutable runtime configuration revision",
  request: { body: { content: { "application/json": { schema: PatchSettingsBody } } } },
  responses: {
    200: {
      description: "Revision saved; activate it explicitly when restart is not required",
      content: { "application/json": { schema: ConfigStateSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: {
      description: "Not initialized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Revision conflict",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: { description: "Invalid patch", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listRevisionsRoute = createRoute({
  method: "get",
  path: "/v1/settings/revisions",
  tags: ["settings"],
  summary: "List immutable runtime configuration revisions",
  responses: {
    200: {
      description: "Revision history",
      content: { "application/json": { schema: z.object({ items: z.array(RevisionSchema) }) } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRevisionRoute = createRoute({
  method: "get",
  path: "/v1/settings/revisions/{revision}",
  tags: ["settings"],
  summary: "Read one immutable runtime configuration revision",
  request: { params: RevisionParam },
  responses: {
    200: {
      description: "Revision",
      content: { "application/json": { schema: RevisionSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "Invalid revision",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const activateRevisionRoute = createRoute({
  method: "post",
  path: "/v1/settings/revisions/{revision}/activate",
  tags: ["settings"],
  summary: "Prepare and activate a revision after every healthy replica ACKs its digest",
  request: { params: RevisionParam },
  responses: {
    200: {
      description: "Activation result",
      content: {
        "application/json": {
          schema: ConfigStateSchema.extend({
            replicas: z.array(
              z.object({
                instance_id: z.string(),
                status: z.enum(["preparing", "ack", "nack"]),
                digest: z.string().nullable(),
                reason: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "Revision conflict",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Invalid revision",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const activationRoute = createRoute({
  method: "get",
  path: "/v1/settings/activations/{revision}",
  tags: ["settings"],
  summary: "Inspect replica leases and ACK/NACK state for a revision",
  request: { params: RevisionParam },
  responses: {
    200: {
      description: "Replica activation state",
      content: {
        "application/json": {
          schema: z.object({
            revision: z.number().int().positive(),
            replicas: z.array(
              z.object({
                instance_id: z.string(),
                healthy: z.boolean(),
                status: z.string(),
                digest: z.string().nullable(),
                reason: z.string().nullable(),
                last_seen_at: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listSecretsRoute = createRoute({
  method: "get",
  path: "/v1/secrets",
  tags: ["secrets"],
  summary: "List secret-version metadata; plaintext and ciphertext are never returned",
  responses: {
    200: {
      description: "Secret registry",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(
              z.object({
                name: z.string(),
                versions: z.array(
                  z.object({
                    version: z.number().int().positive(),
                    reference: z.string(),
                    created_at: z.string().datetime(),
                    revoked_at: z.string().datetime().nullable(),
                  }),
                ),
              }),
            ),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createSecretRoute = createRoute({
  method: "post",
  path: "/v1/secrets/{name}/versions",
  tags: ["secrets"],
  summary: "Create an immutable encrypted secret version",
  request: {
    params: SecretParam,
    body: { content: { "application/json": { schema: SecretCreateBody } } },
  },
  responses: {
    201: {
      description: "Secret version created",
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            version: z.number().int().positive(),
            reference: z.string(),
            created_at: z.string().datetime(),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "Invalid secret",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const revokeSecretRoute = createRoute({
  method: "post",
  path: "/v1/secrets/{name}/versions/{version}/revoke",
  tags: ["secrets"],
  summary: "Revoke an unreferenced secret version",
  request: { params: SecretVersionParam },
  responses: {
    200: {
      description: "Secret version revoked",
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            version: z.number().int().positive(),
            revoked_at: z.string().datetime(),
          }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "Secret is referenced",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Invalid secret",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerRuntimeConfigRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/settings", (c, next) =>
    c.req.method === "GET"
      ? requirePermission("settings:read")(c, next)
      : requirePermission("settings:write")(c, next),
  );
  app.use("/v1/settings/runtime", requirePermission("settings:read"));
  app.use("/v1/settings/revisions", requirePermission("settings:read"));
  app.use("/v1/settings/revisions/*", (c, next) =>
    c.req.method === "GET"
      ? requirePermission("settings:read")(c, next)
      : requirePermission("settings:write")(c, next),
  );
  app.use("/v1/settings/activations/*", requirePermission("settings:read"));
  app.use("/v1/secrets", requirePermission("settings:read"));
  app.use("/v1/secrets/*", (c, next) =>
    c.req.method === "GET"
      ? requirePermission("settings:read")(c, next)
      : requirePermission("settings:write")(c, next),
  );

  app.openapi(getSettingsRoute, async (c) => {
    const db = c.get("db");
    const state = await getRuntimeConfigState(db);
    const saved = await getRuntimeRevision(db, state.saved_revision);
    return c.json({ ...state, settings: saved.document }, 200);
  });

  app.openapi(patchSettingsRoute, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    if (!mayManageTenant(principal, body.tenant_id)) {
      return c.json({ code: "forbidden", message: "cross-tenant settings write denied" }, 403);
    }
    try {
      const patchArgs = {
        expected_revision: body.expected_revision,
        changes: body.changes,
        scope: body.scope,
        created_by: principal.id,
        ...(body.tenant_id ? { tenant_id: body.tenant_id } : {}),
      };
      const state = await saveRuntimeConfigPatch(c.get("db"), patchArgs);
      await auditAwait(
        {
          tenant_id: body.tenant_id ?? principal.tenant_id,
          actor_type: principal.kind === "system_account" ? "system_account" : "user",
          actor_id: principal.id,
          action: AuditAction.SETTINGS_REVISION_SAVED,
          resource_type: "runtime_config_revision",
          resource_id: String(state.saved_revision),
          metadata: {
            scope: body.scope,
            changed_paths: Object.keys(body.changes).sort(),
            active_revision: state.active_revision,
            pending_restart_fields: state.pending_restart_fields,
          },
        },
        c.get("db"),
      );
      return c.json(state, 200);
    } catch (error) {
      return mapRuntimeConfigError(c, error);
    }
  });

  app.openapi(listRevisionsRoute, async (c) => {
    const revisions = await listRuntimeRevisions(c.get("db"));
    return c.json({ items: revisions.map(revisionWire) }, 200);
  });

  app.openapi(getRevisionRoute, async (c) => {
    try {
      return c.json(
        revisionWire(await getRuntimeRevision(c.get("db"), c.req.valid("param").revision)),
        200,
      );
    } catch (error) {
      return mapRuntimeConfigError(c, error);
    }
  });

  app.openapi(activateRevisionRoute, async (c) => {
    const principal = requireAuth(c);
    const revision = c.req.valid("param").revision;
    try {
      const result = await activateRuntimeRevision(c.get("db"), revision);
      const success = result.activation_status === "active";
      const restartRequired = result.activation_status === "restart_required";
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind === "system_account" ? "system_account" : "user",
          actor_id: principal.id,
          action: success
            ? AuditAction.SETTINGS_REVISION_ACTIVATED
            : restartRequired
              ? AuditAction.SETTINGS_REVISION_RESTART_REQUIRED
              : AuditAction.SETTINGS_REVISION_ACTIVATION_FAILED,
          resource_type: "runtime_config_revision",
          resource_id: String(revision),
          result: success || restartRequired ? "success" : "error",
          metadata: {
            activation_status: result.activation_status,
            replicas: result.replicas.map((replica) => ({
              instance_id: replica.instance_id,
              status: replica.status,
            })),
            pending_restart_fields: result.pending_restart_fields,
          },
        },
        c.get("db"),
      );
      return c.json(result, 200);
    } catch (error) {
      return mapRuntimeConfigError(c, error);
    }
  });

  app.openapi(activationRoute, async (c) => {
    const revision = c.req.valid("param").revision;
    const replicas = await getActivationReplicas(c.get("db"), revision);
    return c.json(
      {
        revision,
        replicas: replicas.map((replica) => ({
          ...replica,
          last_seen_at: replica.last_seen_at.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(listSecretsRoute, async (c) => {
    const items = await listSecretVersions(c.get("db"));
    return c.json(
      {
        items: items.map((item) => ({
          ...item,
          versions: item.versions.map((version) => ({
            ...version,
            created_at: version.created_at.toISOString(),
            revoked_at: version.revoked_at?.toISOString() ?? null,
          })),
        })),
      },
      200,
    );
  });

  app.openapi(createSecretRoute, async (c) => {
    const principal = requireAuth(c);
    const { name } = c.req.valid("param");
    try {
      const created = await createSecretVersion(c.get("db"), {
        name,
        value: c.req.valid("json").value,
        created_by: principal.id,
      });
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind === "system_account" ? "system_account" : "user",
          actor_id: principal.id,
          action: AuditAction.SECRET_VERSION_CREATED,
          resource_type: "runtime_secret",
          resource_id: created.reference,
          metadata: { name, version: created.version },
        },
        c.get("db"),
      );
      return c.json({ ...created, created_at: created.created_at.toISOString() }, 201);
    } catch (error) {
      return mapRuntimeConfigError(c, error);
    }
  });

  app.openapi(revokeSecretRoute, async (c) => {
    const principal = requireAuth(c);
    const params = c.req.valid("param");
    try {
      const revoked = await revokeSecretVersion(c.get("db"), params);
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind === "system_account" ? "system_account" : "user",
          actor_id: principal.id,
          action: AuditAction.SECRET_VERSION_REVOKED,
          resource_type: "runtime_secret",
          resource_id: `secret://${params.name}/${params.version}`,
          metadata: { name: params.name, version: params.version },
        },
        c.get("db"),
      );
      return c.json({ ...revoked, revoked_at: revoked.revoked_at.toISOString() }, 200);
    } catch (error) {
      return mapRuntimeConfigError(c, error);
    }
  });
}
