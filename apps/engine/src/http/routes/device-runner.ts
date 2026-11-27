import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { SecretTicketClaimSchema } from "@shared/device/browser.ts";
import {
  DeviceCommandSchema,
  DeviceResultSchema,
  DeviceStopReportSchema,
  HeartbeatSchema,
} from "@shared/device/protocol.ts";
import { RUNNER_ROUTE_PATHS } from "@shared/device/runner-wire.ts";
import {
  UPLOAD_CHUNK_MAX_BYTES,
  UploadChunkReceiptSchema,
  UploadCommitSchema,
  UploadCommittedSchema,
  UploadCreatedSchema,
  UploadCreateSchema,
} from "@shared/device/uploads.ts";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import { screenshotExpiryAt } from "../../devices/core/screenshot-retention.ts";
import {
  abortUpload,
  claimDeviceCommand,
  commitUpload,
  deviceConnectorLocale,
  exchangeRunnerAssertion,
  openUpload,
  putChunk,
  type RunnerIdentity,
  recordCommandProgress,
  recordCommandResult,
  recordHeartbeat,
  recordStop,
  runnerStanding,
  scheduleUploadExpiry,
  streamRunnerFrames,
  uploadRefusalStatus,
} from "../../devices/index.ts";
import { scheduleScreenshotExpiry } from "../../devices/screenshot-retention.ts";
import { workspaceLanguage } from "../../identity/index.ts";
import { claimSecretTicket } from "../../vault/index.ts";
import type { AppEnv } from "../openapi.ts";
import { streamShutdownSignal } from "../stream-shutdown.ts";
import { streamTenantSSE } from "../tenant-stream.ts";

const Failure = z
  .object({ code: z.string(), message: z.string().optional() })
  .openapi("DeviceRunnerFailure");
const runnerFailures = {
  401: {
    description: "Runner credential missing or invalid",
    content: { "application/json": { schema: Failure } },
  },
  403: {
    description: "Not a runner credential, or the device was revoked",
    content: { "application/json": { schema: Failure } },
  },
};
const Generation = z.object({ stop_generation: z.number().int().nonnegative() });

const tokenRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.token,
  tags: ["device-runner"],
  summary: "Exchange the runner's signed assertion for a 10-minute access token",
  description:
    "`assertion` is the canonical JSON `{aud, device_runner_id, iat, nonce}` with `aud` = `device-runner-token`, `iat` within 60 s of the server clock and a fresh 16-byte base64url `nonce`; `signature` is its Ed25519 signature in base64url with the key enrolled for the device. The token works only on the /v1/device-runner routes.",
  security: [],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              assertion: z.string().min(1).max(512),
              signature: z.string().min(1).max(128),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Runner access token",
      content: {
        "application/json": {
          schema: z
            .object({ access_token: z.string(), expires_at: z.string().datetime() })
            .openapi("DeviceRunnerToken"),
        },
      },
    },
    ...runnerFailures,
  },
});

const heartbeatRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.heartbeat,
  tags: ["device-runner"],
  summary: "Report that the runner is alive, with its capabilities and stop generation",
  description:
    "Sent every 15 s. The stored stop generation only ever rises to the reported one; every command the engine issues to this device carries a generation at least as high as the stored one.",
  request: {
    body: { required: true, content: { "application/json": { schema: HeartbeatSchema } } },
  },
  responses: {
    200: {
      description: "Heartbeat recorded",
      content: { "application/json": { schema: Generation } },
    },
    ...runnerFailures,
  },
});

const stopRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.stop,
  tags: ["device-runner"],
  summary: "Report that the person stopped local steps on this device",
  description:
    "Raises the stored stop generation (it never goes down) and records the stop once per generation; a repeated report is acknowledged without a second record.",
  request: {
    body: { required: true, content: { "application/json": { schema: DeviceStopReportSchema } } },
  },
  responses: {
    200: {
      description: "Stop recorded",
      content: {
        "application/json": { schema: Generation.extend({ recorded: z.boolean() }) },
      },
    },
    ...runnerFailures,
  },
});

const CommandParam = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .openapi({ param: { name: "id", in: "path" } }),
});

const commandFailures = {
  ...runnerFailures,
  404: {
    description: "No such command on this device",
    content: { "application/json": { schema: Failure } },
  },
  409: {
    description:
      "The command cannot be taken: already claimed, closed, past its deadline or from a stopped generation",
    content: { "application/json": { schema: Failure } },
  },
};

const claimRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.claim,
  tags: ["device-runner"],
  summary: "Take a command that is waiting for this device",
  description:
    "A command is handed out once. It carries the stop generation it was issued under (never below the stored one) and a deadline; a command past its deadline or from a stopped generation is closed and answered with 409.",
  request: { params: CommandParam },
  responses: {
    200: {
      description: "The command to run",
      content: { "application/json": { schema: DeviceCommandSchema } },
    },
    ...commandFailures,
  },
});

const progressRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.progress,
  tags: ["device-runner"],
  summary: "Report that a claimed command is still running",
  description:
    "Keeps a long command alive. A claimed command with neither progress nor a heartbeat for 45 s counts as lost.",
  request: {
    params: CommandParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ note: z.string().max(500).optional() }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Progress recorded",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    ...commandFailures,
  },
});

const resultRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.result,
  tags: ["device-runner"],
  summary: "Hand in the result of a command",
  description:
    "The first result is kept, also when it arrives after the command was counted as lost. A repeated result, for example one answered from the runner's ledger, is acknowledged and changes nothing.",
  request: {
    params: CommandParam,
    body: { required: true, content: { "application/json": { schema: DeviceResultSchema } } },
  },
  responses: {
    200: {
      description: "Result recorded",
      content: {
        "application/json": {
          schema: z
            .object({ stored: z.boolean(), state: z.string() })
            .openapi("DeviceCommandResultReceipt"),
        },
      },
    },
    ...runnerFailures,
    404: commandFailures[404],
  },
});

const UploadParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: "id", in: "path" } }),
});

const uploadFailures = {
  ...runnerFailures,
  404: {
    description: "No such command or upload on this device",
    content: { "application/json": { schema: Failure } },
  },
  409: {
    description: "The command is not a running import, or the upload is closed",
    content: { "application/json": { schema: Failure } },
  },
  410: {
    description: "The upload expired; uploads not committed within an hour are dropped",
    content: { "application/json": { schema: Failure } },
  },
  413: {
    description: "Too large for an import, a chunk or the workspace's file quota",
    content: { "application/json": { schema: Failure } },
  },
  422: {
    description: "Chunks missing or out of range, a size that does not add up, or a hash mismatch",
    content: { "application/json": { schema: Failure } },
  },
};

const uploadCreateRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.uploads,
  tags: ["device-runner"],
  summary: "Open an upload for the file a running files.import command reads",
  description:
    "Bound to one claimed `files.import` command of this device. The size is checked against the import limit and the workspace's file quota before any byte is sent. An upload that is not committed within an hour expires.",
  request: {
    body: { required: true, content: { "application/json": { schema: UploadCreateSchema } } },
  },
  responses: {
    201: {
      description: "Upload opened",
      content: { "application/json": { schema: UploadCreatedSchema } },
    },
    ...uploadFailures,
  },
});

const uploadChunkRoute = createRoute({
  method: "put",
  path: RUNNER_ROUTE_PATHS.uploadChunk,
  tags: ["device-runner"],
  summary: "Send one chunk of an upload",
  description:
    "Chunks are numbered from 0 and hold at most `chunk_bytes_max` bytes. Sending the same chunk again with the same length is acknowledged and changes nothing.",
  request: {
    params: UploadParam.extend({
      n: z.coerce
        .number()
        .int()
        .min(0)
        .openapi({ param: { name: "n", in: "path" } }),
    }),
    body: {
      required: true,
      content: {
        "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
  },
  responses: {
    200: {
      description: "Chunk stored",
      content: { "application/json": { schema: UploadChunkReceiptSchema } },
    },
    ...uploadFailures,
  },
});

const uploadCommitRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.uploadCommit,
  tags: ["device-runner"],
  summary: "Finish an upload and store it as a file",
  description:
    "The chunks must run from 0 without gaps, add up to the opened size and match the sha256. A hash mismatch closes the upload and keeps nothing. On success the file is stored like any other upload; the command's result must name the returned `file_id`.",
  request: {
    params: UploadParam,
    body: { required: true, content: { "application/json": { schema: UploadCommitSchema } } },
  },
  responses: {
    200: {
      description: "File stored",
      content: { "application/json": { schema: UploadCommittedSchema } },
    },
    ...uploadFailures,
  },
});

const uploadAbortRoute = createRoute({
  method: "delete",
  path: RUNNER_ROUTE_PATHS.upload,
  tags: ["device-runner"],
  summary: "Drop an upload that will not be committed",
  request: { params: UploadParam },
  responses: {
    200: {
      description: "Upload dropped",
      content: { "application/json": { schema: z.object({ aborted: z.boolean() }) } },
    },
    ...uploadFailures,
  },
});

const TicketParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: "id", in: "path" } }),
});

const secretTicketRoute = createRoute({
  method: "post",
  path: RUNNER_ROUTE_PATHS.secretTicket,
  tags: ["device-runner"],
  summary: "Take the vault values for one sign-in or payment command, once",
  description:
    "A ticket belongs to one device and one command and lives 60 s. It is handed out once, only while its command is claimed by this device; afterwards and after expiry it answers 410. Keep the values in memory only for this command and overwrite them when it ends.",
  request: { params: TicketParam },
  responses: {
    200: {
      description: "The values for this one command",
      content: { "application/json": { schema: SecretTicketClaimSchema } },
    },
    ...runnerFailures,
    404: {
      description: "No such ticket for this device",
      content: { "application/json": { schema: Failure } },
    },
    409: {
      description: "The ticket's command is not claimed by this device right now",
      content: { "application/json": { schema: Failure } },
    },
    410: {
      description: "The ticket was already taken or expired",
      content: { "application/json": { schema: Failure } },
    },
  },
});

async function runnerOf(
  db: Db,
  principal: ResolvedPrincipal | undefined,
): Promise<RunnerIdentity | null> {
  const source = principal?.auth_source;
  if (source?.kind !== "device_runner") return null;
  const standing = await runnerStanding(db, source.device_id);
  return standing.ok && standing.runner.tenant_id === principal?.tenant_id ? standing.runner : null;
}

const NOT_A_RUNNER = {
  code: "device_runner_required",
  message: "a device runner token is required",
};

export function registerDeviceRunnerRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(tokenRoute, async (c) => {
    const exchanged = await exchangeRunnerAssertion(c.get("db"), c.req.valid("json"), Date.now());
    if (!exchanged.ok) return c.json({ code: exchanged.code }, exchanged.status);
    return c.json({ access_token: exchanged.access_token, expires_at: exchanged.expires_at }, 200, {
      "cache-control": "no-store",
    });
  });

  app.openapi(heartbeatRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const recorded = await recordHeartbeat(c.get("db"), runner, c.req.valid("json"), async () =>
      deviceConnectorLocale({
        app: c.req.header("accept-language"),
        workspace: await workspaceLanguage(runner.tenant_id, c.get("db")),
      }),
    );
    if (!recorded) return c.json({ code: "device_revoked" }, 403);
    return c.json(recorded, 200);
  });

  app.openapi(claimRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const claimed = await claimDeviceCommand(
      c.get("db"),
      runner,
      c.req.valid("param").id,
      Date.now(),
    );
    if (!claimed.ok) return c.json({ code: claimed.code }, claimed.status);
    return c.json(claimed.command, 200, { "cache-control": "no-store" });
  });

  app.openapi(secretTicketRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const claimed = await claimSecretTicket(
      c.get("db"),
      {
        tenant_id: runner.tenant_id,
        device_id: runner.device_id,
        ticket_id: c.req.valid("param").id,
      },
      new Date(),
    );
    if (!claimed.ok) return c.json({ code: claimed.code }, claimed.status);
    return c.json({ values: claimed.values, expires_at: claimed.expires_at.toISOString() }, 200, {
      "cache-control": "no-store",
    });
  });

  app.openapi(progressRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const recorded = await recordCommandProgress(c.get("db"), runner, c.req.valid("param").id);
    if (!recorded.ok)
      return c.json(
        { code: recorded.status === 404 ? "command_not_found" : "command_not_running" },
        recorded.status,
      );
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(resultRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const recorded = await recordCommandResult(
      c.get("db"),
      runner,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!recorded.ok) return c.json({ code: "command_not_found" }, 404);
    const expiry = recorded.stored
      ? screenshotExpiryAt(recorded.kind, recorded.state, Date.now())
      : null;
    if (expiry) await scheduleScreenshotExpiry(runner.tenant_id, expiry);
    return c.json({ stored: recorded.stored, state: recorded.state }, 200);
  });

  app.openapi(uploadCreateRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const opened = await openUpload(c.get("db"), runner, c.req.valid("json"), Date.now());
    if (!opened.ok) return c.json({ code: opened.code }, uploadRefusalStatus(opened.code));
    await scheduleUploadExpiry(runner.tenant_id, opened.value.expires_at);
    return c.json(
      {
        upload_id: opened.value.upload_id,
        chunk_bytes_max: opened.value.chunk_bytes_max,
        expires_at: opened.value.expires_at.toISOString(),
      },
      201,
    );
  });

  app.openapi(uploadChunkRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > UPLOAD_CHUNK_MAX_BYTES) return c.json({ code: "chunk_too_large" }, 413);
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    const { id, n } = c.req.valid("param");
    const stored = await putChunk(c.get("db"), runner, id, n, bytes, Date.now());
    if (!stored.ok) return c.json({ code: stored.code }, uploadRefusalStatus(stored.code));
    return c.json(stored.value, 200);
  });

  app.openapi(uploadCommitRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const committed = await commitUpload(
      c.get("db"),
      runner,
      c.req.valid("param").id,
      c.req.valid("json"),
      Date.now(),
    );
    if (!committed.ok) return c.json({ code: committed.code }, uploadRefusalStatus(committed.code));
    return c.json(committed.value, 200);
  });

  app.openapi(uploadAbortRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const aborted = await abortUpload(c.get("db"), runner, c.req.valid("param").id);
    if (!aborted.ok) return c.json({ code: aborted.code }, uploadRefusalStatus(aborted.code));
    return c.json(aborted.value, 200);
  });

  app.get(RUNNER_ROUTE_PATHS.stream, async (c) => {
    const db = c.get("db");
    const runner = await runnerOf(db, c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    return streamTenantSSE(c, (stream) =>
      streamRunnerFrames(
        db,
        runner,
        AbortSignal.any([c.req.raw.signal, streamShutdownSignal()]),
        (frame) =>
          stream.writeSSE({
            event: frame.event,
            data: JSON.stringify("command_id" in frame ? { command_id: frame.command_id } : {}),
          }),
      ),
    );
  });

  app.openapi(stopRoute, async (c) => {
    const runner = await runnerOf(c.get("db"), c.get("principal"));
    if (!runner) return c.json(NOT_A_RUNNER, 403);
    const recorded = await recordStop(c.get("db"), runner, c.req.valid("json"));
    if (!recorded) return c.json({ code: "device_revoked" }, 403);
    return c.json(recorded, 200);
  });
}
