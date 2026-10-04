import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  EngineRestartRefusedError,
  getRestartStatus,
  requestEngineRestart,
  scheduleProcessRestart,
} from "../../runtime-config/restart.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const RevisionStatusSchema = z.enum(["saved", "preparing", "active", "failed", "restart_required"]);

const RestartStatusSchema = z
  .object({
    boot_id: z.string().uuid().describe("Random per engine process; changes with every start"),
    started_at: z.string().datetime(),
    saved_revision: z.number().int().positive(),
    active_revision: z.number().int().positive(),
    activation_status: RevisionStatusSchema,
    restart_supervised: z
      .boolean()
      .describe(
        "server.restart_supervised of the saved revision: a supervisor restarts the engine",
      ),
    pending_restart_fields: z.array(z.string()),
  })
  .openapi("EngineRestartStatus");

const RestartAcceptedSchema = z
  .object({
    request_id: z.string().uuid(),
    audit_id: z.string().uuid().describe("The engine.restart.requested audit entry"),
    boot_id: z.string().uuid().describe("The process that accepted the request and now ends"),
    expected_revision: z.number().int().positive(),
  })
  .openapi("EngineRestartAccepted");

const MANUAL_RESTART_HINT =
  "Restart it where it runs: `systemctl restart subkit-engine` or `docker compose restart engine`.";

const restartRoute = createRoute({
  method: "post",
  path: "/v1/system/restart",
  tags: ["system"],
  summary: "Restart the engine so a saved restart-sensitive setting takes effect",
  description:
    "Accepted only when server.restart_supervised is on, a restart-required revision waits, and exactly one engine instance is live. The engine then drains like on SIGTERM and exits with code 75; the supervisor starts it again. Follow GET /v1/system/restart-status until boot_id changes and active_revision equals saved_revision.",
  responses: {
    202: {
      description: "Restart accepted; the engine drains and ends shortly after this response",
      content: { "application/json": { schema: RestartAcceptedSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description:
        "Refused: not_supervised, nothing_pending, multiple_replicas, restart_in_progress or not_ready",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const restartStatusRoute = createRoute({
  method: "get",
  path: "/v1/system/restart-status",
  tags: ["system"],
  summary: "Which engine process runs, and whether a saved setting still waits for a restart",
  responses: {
    200: {
      description: "Restart status",
      content: { "application/json": { schema: RestartStatusSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSystemRestartRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/system/restart", requirePermission("system:restart"));
  app.use("/v1/system/restart-status", requirePermission("settings:read"));

  app.openapi(restartStatusRoute, async (c) => c.json(await getRestartStatus(c.get("db")), 200));

  app.openapi(restartRoute, async (c) => {
    const principal = requireAuth(c);
    try {
      const accepted = await requestEngineRestart(c.get("db"), {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind === "system_account" ? "system_account" : "user",
        actor_id: principal.id,
      });
      scheduleProcessRestart();
      return c.json(accepted, 202);
    } catch (error) {
      if (error instanceof EngineRestartRefusedError) {
        return c.json(
          {
            code: error.code,
            message: error.message,
            ...(error.code === "not_supervised" || error.code === "multiple_replicas"
              ? { hint: MANUAL_RESTART_HINT }
              : {}),
          },
          409,
        );
      }
      throw error;
    }
  });
}
