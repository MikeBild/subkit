// User-driven direct tool invocation against the conversation draft.
//
//   POST /v1/conversations/{id}/preview                 — dry_run_workflow / dry_run_step
//   POST /v1/conversations/{id}/probe                   — probe_connector_draft
//   POST /v1/conversations/{id}/draft/patch             — edit_workflow_patch
//   GET  /v1/conversations/{id}/draft/snapshots         — list_draft_snapshots
//   POST /v1/conversations/{id}/draft/snapshots/restore — restore_draft_snapshot
//
// These endpoints run the SAME conversation-tool implementations the
// model dispatches — one implementation, two callers (see
// conversations/direct-invoke.ts). What used to take a full LLM turn
// ("Run dry_run_workflow …" as a prose directive, then a second
// command to read the result) is one synchronous request. The
// persisted tool-call row keeps the next model turn fully grounded in
// what the operator ran. Write safety is unchanged: previews hold
// writes by default, and no tenant_write tool is reachable here.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  DirectInvokeError,
  invokeConversationToolDirect,
  PendingElicitationBlockedError,
} from "../../../conversations/index.ts";
import { ConflictError, HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const DirectToolLogSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
    ts: z.string(),
  })
  .openapi("ConversationDirectToolLog");

const DirectToolDiffSchema = z
  .object({
    title: z.string(),
    language: z.enum(["json", "yaml", "text"]),
    hunks: z.array(z.unknown()),
  })
  .openapi("ConversationDirectToolDiff");

const DirectToolResultSchema = z
  .object({
    ok: z.boolean(),
    tool: z.string(),
    tool_call_id: z.string(),
    /** Full tool envelope — same free-form shape the model receives. */
    data: z.unknown(),
    committed_workflow_id: z.string().optional(),
    logs: z.array(DirectToolLogSchema),
    diffs: z.array(DirectToolDiffSchema),
  })
  .openapi("ConversationDirectToolResult");

const PreviewRequestSchema = z
  .object({
    /** Preview a single step instead of the whole workflow. */
    step_id: z.string().min(1).optional(),
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    execute_writes: z.boolean().optional(),
    include_step_results: z.boolean().optional(),
    budget_ms_per_step: z.number().int().min(500).max(60_000).optional(),
  })
  .openapi("ConversationPreviewRequest");

const ProbeRequestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional(),
    path: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    timeout_ms: z.number().int().min(100).max(60_000).optional(),
  })
  .openapi("ConversationProbeRequest");

const PatchOpSchema = z
  .object({
    op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
    path: z.string().min(1),
    from: z.string().optional(),
    value: z.unknown().optional(),
  })
  .openapi("ConversationDraftPatchOp");

const DraftPatchRequestSchema = z
  .object({
    patches: z.array(PatchOpSchema).min(1).max(64),
  })
  .openapi("ConversationDraftPatchRequest");

const SnapshotRestoreRequestSchema = z
  .object({
    snapshot_id: z.string().uuid().optional(),
  })
  .openapi("ConversationSnapshotRestoreRequest");

function directToolResponses() {
  return {
    200: {
      description: "Tool result envelope (ok may be false — read `data`)",
      content: { "application/json": { schema: DirectToolResultSchema } },
    },
    400: {
      description: "Invalid tool arguments",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "A pending dialog blocks direct invocation",
      content: { "application/json": { schema: ErrorSchema } },
    },
  };
}

const previewRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/preview",
  tags: ["conversations"],
  summary:
    "Dry-run the conversation's workflow draft (or a single step) directly — no model turn. Writes are held unless execute_writes is true.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: PreviewRequestSchema } } },
  },
  responses: directToolResponses(),
});

const probeRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/probe",
  tags: ["conversations"],
  summary: "Probe the conversation's connector draft directly — no model turn.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ProbeRequestSchema } } },
  },
  responses: directToolResponses(),
});

const draftPatchRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/draft/patch",
  tags: ["conversations"],
  summary:
    "Apply an RFC 6902 JSON Patch to the workflow draft directly — same validation gates as the model-driven editor; an invalid patch leaves the draft untouched.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: DraftPatchRequestSchema } } },
  },
  responses: directToolResponses(),
});

const snapshotsListRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{id}/draft/snapshots",
  tags: ["conversations"],
  summary: "List draft snapshots for this conversation, newest first.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
  },
  responses: directToolResponses(),
});

const snapshotRestoreRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/draft/snapshots/restore",
  tags: ["conversations"],
  summary:
    "Roll the conversation draft back to a captured snapshot (most recent when snapshot_id is omitted).",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: SnapshotRestoreRequestSchema } } },
  },
  responses: directToolResponses(),
});

/** Map service-layer failures onto the shared HTTP error envelope. */
function toHttpError(error: unknown): never {
  if (error instanceof DirectInvokeError) {
    throw HttpError.withEnvelope(error.status, error.error_code, error.message, {
      ...(error.error_code === "invalid_tool_args"
        ? {
            hint: "The body must satisfy the tool's input schema — see /openapi.json for the request shape.",
          }
        : {}),
    });
  }
  if (error instanceof PendingElicitationBlockedError) {
    throw new ConflictError(error.message, {
      pending_elicitation: error.pending_elicitation as unknown as Record<string, unknown>,
    });
  }
  throw error;
}

export function registerDirectToolRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(previewRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { step_id, ...rest } = body;
    const outcome = await invokeConversationToolDirect({
      db: c.get("db"),
      tenant_id: principal.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
      tool: step_id ? "dry_run_step" : "dry_run_workflow",
      args: step_id
        ? {
            step_id,
            ...(rest.input !== undefined ? { input: rest.input } : {}),
            ...(rest.environment !== undefined ? { environment: rest.environment } : {}),
            ...(rest.execute_writes !== undefined ? { execute_writes: rest.execute_writes } : {}),
          }
        : rest,
    }).catch(toHttpError);
    return c.json(outcome, 200);
  });

  app.openapi(probeRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const outcome = await invokeConversationToolDirect({
      db: c.get("db"),
      tenant_id: principal.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
      tool: "probe_connector_draft",
      args: body,
    }).catch(toHttpError);
    return c.json(outcome, 200);
  });

  app.openapi(draftPatchRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const outcome = await invokeConversationToolDirect({
      db: c.get("db"),
      tenant_id: principal.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
      tool: "edit_workflow_patch",
      args: { patches: body.patches },
    }).catch(toHttpError);
    return c.json(outcome, 200);
  });

  app.openapi(snapshotsListRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const outcome = await invokeConversationToolDirect({
      db: c.get("db"),
      tenant_id: principal.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
      tool: "list_draft_snapshots",
      args: limit !== undefined ? { limit } : {},
    }).catch(toHttpError);
    return c.json(outcome, 200);
  });

  app.openapi(snapshotRestoreRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const outcome = await invokeConversationToolDirect({
      db: c.get("db"),
      tenant_id: principal.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
      tool: "restore_draft_snapshot",
      args: body.snapshot_id !== undefined ? { snapshot_id: body.snapshot_id } : {},
    }).catch(toHttpError);
    return c.json(outcome, 200);
  });
}
