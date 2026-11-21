import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { DeviceAllowanceSchema } from "@shared/device/boundary.ts";
import { LocalConfirmationSchema } from "@shared/device/confirmation.ts";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Executor } from "../../db/client.ts";
import { DEVICE_STEP_VIEW_STATES } from "../../devices/core/step-view.ts";
import {
  activeAllowances,
  DEVICE_ALLOWANCES_MAX,
  DeviceRegistryError,
  enrollDeviceRunner,
  listDevices,
  mirrorDeviceAllowances,
  revokeDevice,
} from "../../devices/index.ts";
import { pendingDeviceConfirmations } from "../../devices/pending-confirmations.ts";
import { listExecutionDeviceSteps, readStepScreenshot } from "../../devices/step-view.ts";
import { can } from "../../rbac/index.ts";
import { requireHumanSession } from "../../workflows/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { AppEnv } from "../openapi.ts";

const Failure = z
  .object({ code: z.string(), message: z.string().optional() })
  .openapi("DeviceFailure");
const DeviceId = z.object({ deviceId: z.string().uuid() });
const failures = {
  401: { description: "Sign-in required", content: { "application/json": { schema: Failure } } },
  403: {
    description: "Permission, session or device refused",
    content: { "application/json": { schema: Failure } },
  },
};

const DeviceListItem = z
  .object({
    id: z.string().uuid(),
    device_label: z.string(),
    owner_user_id: z.string().uuid(),
    is_this_installation: z
      .boolean()
      .describe("True when the device is the desktop installation this session belongs to."),
    enrolled_at: z.string().datetime(),
    last_heartbeat_at: z.string().datetime().nullable(),
    online: z.boolean().describe("True when the device sent a heartbeat within the last 45 s."),
    capabilities: z.record(z.string(), z.unknown()),
    app_version: z.string().nullable(),
    allowance_counts: z.object({
      folder: z.number().int(),
      site: z.number().int(),
      app: z.number().int(),
      keep_out: z.number().int(),
    }),
  })
  .openapi("DeviceListItem");

const enrollRoute = createRoute({
  method: "post",
  path: "/v1/devices/runner/enroll",
  tags: ["devices"],
  summary: "Enroll the local step runner of the desktop device this session belongs to",
  description:
    "Needs the person's own desktop session on that device plus its CSRF proof. Re-enrolling replaces the device's previous runner key; workflows approved for the old runner must be approved again.",
  security: [{ browserSession: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              public_key: z.string().min(1).max(512).describe("Ed25519 public key, PEM (SPKI)."),
              runner_version: z.string().min(1).max(64).optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Runner enrolled",
      content: {
        "application/json": {
          schema: z.object({ device_runner_id: z.string().uuid(), device_label: z.string() }),
        },
      },
    },
    400: { description: "Unreadable key", content: { "application/json": { schema: Failure } } },
    ...failures,
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/devices",
  tags: ["devices"],
  summary: "List desktop devices enrolled for local steps",
  description:
    "Lists the caller's own devices. `scope=all` lists every device of the workspace and needs device:revoke_any. Paths of allowed folders are never listed here, only counts.",
  request: { query: z.object({ scope: z.enum(["own", "all"]).optional() }) },
  responses: {
    200: {
      description: "Devices",
      content: { "application/json": { schema: z.object({ items: z.array(DeviceListItem) }) } },
    },
    ...failures,
  },
});

const ExecutionStepParams = z.object({ executionId: z.string().uuid() });
const StepScreenshotParams = ExecutionStepParams.extend({
  commandId: z.string().regex(/^[0-9a-f]{64}$/),
});

const DeviceStepItem = z
  .object({
    command_id: z.string(),
    step_id: z.string(),
    kind: z.string(),
    state: z.enum(DEVICE_STEP_VIEW_STATES),
    target: z
      .string()
      .nullable()
      .describe("What the step worked on; only the device's person reads it, others get null."),
    screenshot: z
      .boolean()
      .describe(
        "True when the device's person can read the redacted screenshot of this step, kept for 30 days.",
      ),
  })
  .openapi("DeviceStepItem");

const PendingConfirmationItem = z
  .object({
    confirmation_id: z.string(),
    conversation_id: z.string(),
    confirmation: LocalConfirmationSchema,
  })
  .openapi("PendingDeviceConfirmation");

const pendingConfirmationsRoute = createRoute({
  method: "get",
  path: "/v1/devices/{deviceId}/confirmations",
  tags: ["devices"],
  summary: "List the steps on one of the person's devices that wait for their confirmation",
  description:
    "Only the device's person sees them. Answer one through the tool-call respond route of its conversation.",
  request: { params: DeviceId },
  responses: {
    200: {
      description: "Waiting confirmations",
      content: {
        "application/json": { schema: z.object({ items: z.array(PendingConfirmationItem) }) },
      },
    },
    404: { description: "Device not found", content: { "application/json": { schema: Failure } } },
    ...failures,
  },
});

const listStepsRoute = createRoute({
  method: "get",
  path: "/v1/executions/{executionId}/device-steps",
  tags: ["devices"],
  summary: "List the steps a run sent to a device",
  request: { params: ExecutionStepParams },
  responses: {
    200: {
      description: "Device steps of the run, oldest first",
      content: { "application/json": { schema: z.object({ items: z.array(DeviceStepItem) }) } },
    },
    404: { description: "Run not found", content: { "application/json": { schema: Failure } } },
    ...failures,
  },
});

const stepScreenshotRoute = createRoute({
  method: "get",
  path: "/v1/executions/{executionId}/device-steps/{commandId}/screenshot",
  tags: ["devices"],
  summary: "Read the redacted screenshot of one device step",
  description:
    "Only the device's person reads it. The device redacts password and sensitive fields before sending; the server keeps the image encrypted for 30 days, then answers 404. Each read is audited.",
  request: { params: StepScreenshotParams },
  responses: {
    200: { description: "Redacted PNG", content: { "image/png": { schema: z.any() } } },
    404: {
      description: "No screenshot for this person",
      content: { "application/json": { schema: Failure } },
    },
    ...failures,
  },
});

const AllowanceList = z.array(DeviceAllowanceSchema).max(DEVICE_ALLOWANCES_MAX);

const readAllowancesRoute = createRoute({
  method: "get",
  path: "/v1/devices/{deviceId}/allowances",
  tags: ["devices"],
  summary: "Read the allowances the person keeps on one of their devices",
  request: { params: DeviceId },
  responses: {
    200: {
      description: "Allowances mirrored from the device",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(
              z.object({
                kind: z.enum(["folder", "site", "app", "keep_out"]),
                item_id: z.string(),
                display: z.string(),
                digest: z.string().nullable(),
                access: z.enum(["read", "write"]).nullable(),
                private: z.boolean().nullable(),
                keep_out_target: z.enum(["folder", "app"]).nullable(),
                entered_by: z.enum(["person", "approval"]),
              }),
            ),
          }),
        },
      },
    },
    404: { description: "Device not found", content: { "application/json": { schema: Failure } } },
    ...failures,
  },
});

const mirrorAllowancesRoute = createRoute({
  method: "put",
  path: "/v1/devices/{deviceId}/allowances",
  tags: ["devices"],
  summary: "Mirror the allowances a person set on their device",
  description:
    "Replaces the server's copy with the device's full list. Only the person's own desktop session on that device, with its CSRF proof, may call this; a runner credential or another device's session is refused, so a leaked runner token cannot widen what the device allows.",
  security: [{ browserSession: [] }],
  request: {
    params: DeviceId,
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ allowances: AllowanceList }).strict() },
      },
    },
  },
  responses: {
    200: {
      description: "Allowances mirrored",
      content: {
        "application/json": {
          schema: z.object({ added: z.number().int(), removed: z.number().int() }),
        },
      },
    },
    400: {
      description: "Duplicate or too many allowances",
      content: { "application/json": { schema: Failure } },
    },
    404: { description: "Device not found", content: { "application/json": { schema: Failure } } },
    ...failures,
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/v1/devices/{deviceId}",
  tags: ["devices"],
  summary: "Revoke a device's runner",
  description:
    "The device's person may revoke their own device; anyone else needs device:revoke_any. The runner's credential stops working at once and approvals that name the device can no longer run.",
  request: { params: DeviceId },
  responses: {
    204: { description: "Device revoked" },
    404: { description: "Device not found", content: { "application/json": { schema: Failure } } },
    ...failures,
  },
});

async function allowed(db: Executor, principal: ResolvedPrincipal, permission: string) {
  return (await can(db, { tenant_id: principal.tenant_id, principal, permission })).allow;
}

async function humanSession(request: Request, principal: ResolvedPrincipal) {
  try {
    return { ok: true as const, session: await requireHumanSession({ request, principal }) };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      ok: false as const,
      code: typeof code === "string" ? code : "human_session_required",
    };
  }
}

function registryFailure(err: unknown) {
  if (err instanceof DeviceRegistryError)
    return { body: { code: err.code, message: err.message }, status: err.status };
  throw err;
}

export function registerDeviceRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(enrollRoute, async (c) => {
    const principal = requireAuth(c);
    const human = await humanSession(c.req.raw, principal);
    if (!human.ok) return c.json({ code: human.code }, 403);
    const db = c.get("db");
    if (!(await allowed(db, principal, "device:manage")))
      return c.json({ code: "forbidden", message: "device:manage permission is required" }, 403);
    try {
      const enrolled = await enrollDeviceRunner(
        db,
        {
          tenant_id: principal.tenant_id,
          user_id: principal.id,
          installation_id: human.session.installation_id ?? null,
        },
        c.req.valid("json"),
      );
      return c.json(enrolled, 201);
    } catch (err) {
      const failure = registryFailure(err);
      return c.json(failure.body, failure.status === 400 ? 400 : 403);
    }
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    if (!(await allowed(db, principal, "device:read")))
      return c.json({ code: "forbidden", message: "device:read permission is required" }, 403);
    const all = c.req.valid("query").scope === "all";
    if (all && !(await allowed(db, principal, "device:revoke_any")))
      return c.json(
        { code: "forbidden", message: "device:revoke_any permission is required" },
        403,
      );
    const items = await listDevices(db, principal.tenant_id, all ? null : principal.id);
    return c.json(
      {
        items: items.map(({ installation_id, ...item }) => ({
          ...item,
          is_this_installation:
            principal.installation_id !== undefined &&
            installation_id === principal.installation_id,
          enrolled_at: item.enrolled_at.toISOString(),
          last_heartbeat_at: item.last_heartbeat_at?.toISOString() ?? null,
        })),
      },
      200,
    );
  });

  app.openapi(readAllowancesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    if (!(await allowed(db, principal, "device:read")))
      return c.json({ code: "forbidden", message: "device:read permission is required" }, 403);
    const { deviceId } = c.req.valid("param");
    const own = await listDevices(db, principal.tenant_id, principal.id);
    if (!own.some((device) => device.id === deviceId))
      return c.json({ code: "device_not_found" }, 404);
    const items = await activeAllowances(db, principal.tenant_id, deviceId);
    return c.json({ items: items.map(({ id: _id, ...row }) => row) }, 200);
  });

  app.openapi(pendingConfirmationsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    if (!(await allowed(db, principal, "device:read")))
      return c.json({ code: "forbidden", message: "device:read permission is required" }, 403);
    const { deviceId } = c.req.valid("param");
    const own = await listDevices(db, principal.tenant_id, principal.id);
    if (!own.some((device) => device.id === deviceId))
      return c.json({ code: "device_not_found" }, 404);
    const items = await pendingDeviceConfirmations(db, {
      tenant_id: principal.tenant_id,
      device_id: deviceId,
      owner_id: principal.id,
    });
    return c.json({ items }, 200);
  });

  app.openapi(mirrorAllowancesRoute, async (c) => {
    const principal = requireAuth(c);
    const human = await humanSession(c.req.raw, principal);
    if (!human.ok) return c.json({ code: human.code }, 403);
    const db = c.get("db");
    if (!(await allowed(db, principal, "device:manage")))
      return c.json({ code: "forbidden", message: "device:manage permission is required" }, 403);
    try {
      const result = await mirrorDeviceAllowances(
        db,
        {
          tenant_id: principal.tenant_id,
          user_id: principal.id,
          installation_id: human.session.installation_id ?? null,
        },
        c.req.valid("param").deviceId,
        c.req.valid("json").allowances,
      );
      return c.json(result, 200);
    } catch (err) {
      const failure = registryFailure(err);
      return c.json(
        failure.body,
        failure.status === 404 ? 404 : failure.status === 400 ? 400 : 403,
      );
    }
  });

  app.openapi(revokeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    if (!(await allowed(db, principal, "device:manage")))
      return c.json({ code: "forbidden", message: "device:manage permission is required" }, 403);
    const revoked = await revokeDevice(
      db,
      {
        tenant_id: principal.tenant_id,
        user_id: principal.id,
        may_revoke_any: await allowed(db, principal, "device:revoke_any"),
      },
      c.req.valid("param").deviceId,
    );
    return revoked ? c.body(null, 204) : c.json({ code: "device_not_found" }, 404);
  });

  app.openapi(listStepsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    if (!(await allowed(db, principal, "execution:read")))
      return c.json({ code: "forbidden", message: "execution:read permission is required" }, 403);
    const items = await listExecutionDeviceSteps(db, principal, c.req.valid("param").executionId);
    return items ? c.json({ items }, 200) : c.json({ code: "not_found" }, 404);
  });

  app.openapi(stepScreenshotRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    if (!(await allowed(db, principal, "device:read")))
      return c.json({ code: "forbidden", message: "device:read permission is required" }, 403);
    const { executionId, commandId } = c.req.valid("param");
    const png = await readStepScreenshot(db, principal, executionId, commandId);
    if (!png) return c.json({ code: "not_found" }, 404);
    return c.body(new Uint8Array(png), 200, {
      "content-type": "image/png",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
  });
}
