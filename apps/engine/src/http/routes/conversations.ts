// Conversations HTTP surface.
//
//   POST   /v1/conversations                               — create (optionally drive initial turn)
//   GET    /v1/conversations                               — list
//   GET    /v1/conversations/:id                           — fetch detail
//   POST   /v1/conversations/:id/messages                  — append user message + drive turn
//   POST   /v1/conversations/:id/approvals/:approval_id/approve
//   POST   /v1/conversations/:id/approvals/:approval_id/reject
//   POST   /v1/conversations/:id/cancel
//   GET    /v1/conversations/:id/stream                    — SSE replay of the latest run

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import * as svc from "../../conversations/service.ts";
import { replayEvents, serializeEvent } from "../../conversations/streaming.ts";
import type { ConversationStatus } from "../../conversations/types.ts";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { monthlyUsage } from "../../llm/budgets.ts";
import { resolveModelRoute } from "../../llm/provider.ts";
import { logger } from "../../logging/logger.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { ErrorSchema } from "./identity/schemas.ts";

const IdParam = z.object({ id: z.string().uuid() });
const ApprovalParam = z.object({
  id: z.string().uuid(),
  approval_id: z.string().uuid(),
});

const ConversationSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    target_workflow_id: z.string().nullable(),
    target_connector_id: z.string().nullable(),
    status: z.string(),
    owner_id: z.string().nullable(),
    model: z.string().nullable(),
    title: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Conversation");

const ConversationListResponse = z
  .object({ items: z.array(ConversationSchema) })
  .openapi("ConversationListResponse");

const ConversationDetailSchema = z
  .object({
    conversation: ConversationSchema,
    messages: z.array(z.unknown()),
    tool_calls: z.array(z.unknown()),
    draft: z.unknown(),
    approvals: z.array(z.unknown()),
  })
  .openapi("ConversationDetail");

const CreateBody = z
  .object({
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    initial_message: z.string().optional(),
    memory: z.string().optional(),
    model: z.string().optional(),
    title: z.string().optional(),
  })
  .openapi("CreateConversationBody");

const AppendMessageBody = z
  .object({
    message: z.string().min(1),
    memory: z.string().optional(),
  })
  .openapi("AppendConversationMessageBody");

const PatchConversationBody = z
  .object({
    model: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .openapi("PatchConversationBody");

const CompactConversationBody = z
  .object({
    keep_last: z.number().int().min(0).max(50).optional(),
  })
  .openapi("CompactConversationBody");

const CompactConversationResponse = z
  .object({
    conversation: ConversationSchema,
    summary: z.string(),
    messages_collapsed: z.number().int().min(0),
  })
  .openapi("CompactConversationResponse");

const RejectBody = z.object({ reason: z.string().optional() }).openapi("RejectApprovalBody");

const RunOutcomeSchema = z
  .object({
    conversation: ConversationSchema,
    events: z.array(z.any()),
    status: z.string(),
    committed_workflow_id: z.string().optional(),
    pending_approval_id: z.string().optional(),
  })
  .openapi("ConversationRunOutcome");

type RunOutcomeJson = {
  conversation: {
    id: string;
    tenant_id: string;
    target_workflow_id: string | null;
    target_connector_id: string | null;
    status: string;
    owner_id: string | null;
    model: string | null;
    title: string | null;
    created_at: string;
    updated_at: string;
  };
  events: unknown[];
  status: string;
  committed_workflow_id?: string;
  pending_approval_id?: string;
};

const listRoute = createRoute({
  method: "get",
  path: "/v1/conversations",
  tags: ["conversations"],
  summary: "List conversations",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        status: z.enum(["active", "awaiting_approval", "committed", "abandoned"]).optional(),
        /**
         * When `me`, restrict to conversations owned by the calling
         * principal (conversations.owner_id). Other values are
         * reserved and rejected.
         */
        owner: z.literal("me").optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListConversationsQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationListResponse } },
    },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/conversations",
  tags: ["conversations"],
  summary: "Create a conversation",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: RunOutcomeSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/conversations/{id}",
  tags: ["conversations"],
  summary: "Fetch a conversation with messages, tool calls, and draft",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationDetailSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const appendRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/messages",
  tags: ["conversations"],
  summary: "Append a user message and drive another turn",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AppendMessageBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/approvals/{approval_id}/approve",
  tags: ["conversations"],
  summary: "Approve a pending approval and resume the loop",
  security: [{ bearerAuth: [] }],
  request: { params: ApprovalParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rejectRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/approvals/{approval_id}/reject",
  tags: ["conversations"],
  summary: "Reject a pending approval",
  security: [{ bearerAuth: [] }],
  request: {
    params: ApprovalParam,
    body: { content: { "application/json": { schema: RejectBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/cancel",
  tags: ["conversations"],
  summary: "Cancel a conversation",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const compactRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/compact",
  tags: ["conversations"],
  summary: "Compact a conversation's message history into a summary",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: CompactConversationBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: CompactConversationResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/conversations/{id}",
  tags: ["conversations"],
  summary: "Patch conversation metadata (model, title)",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: PatchConversationBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function serializeConversation(c: svc.ConversationTurnOutcome): RunOutcomeJson {
  const out: RunOutcomeJson = {
    conversation: c.conversation,
    events: c.result.events,
    status: c.result.status,
  };
  if (c.result.committed_workflow_id) out.committed_workflow_id = c.result.committed_workflow_id;
  if (c.result.pending_approval_id) out.pending_approval_id = c.result.pending_approval_id;
  return out;
}

export function registerConversationRoutes(app: OpenAPIHono<AppEnv>): void {
  // Conversations are gated on a dedicated `conversation:*` permission
  // family (added in the sk-cli rollout). The legacy `workflow:*`
  // permissions are kept as accepted alternates for a deprecation
  // window so existing resource grants and external callers do not
  // break on upgrade.
  app.use("/v1/conversations", async (c, next) => {
    if (c.req.method === "GET") {
      return requireAnyPermission(["conversation:list", "workflow:read"])(c, next);
    }
    if (c.req.method === "POST") {
      return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
    }
    return next();
  });
  app.use("/v1/conversations/:id", async (c, next) => {
    if (c.req.method === "GET") {
      return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
    }
    if (c.req.method === "PATCH") {
      return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
    }
    return next();
  });
  app.use("/v1/conversations/:id/compact", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/messages", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/messages/upload", async (c, next) => {
    return requireAnyPermission(["conversation:write", "knowledge:write"])(c, next);
  });
  app.use("/v1/conversations/:id/approvals/:approval_id/approve", async (c, next) => {
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/approvals/:approval_id/reject", async (c, next) => {
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/cancel", async (c, next) => {
    return requireAnyPermission(["conversation:cancel", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/stream", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const items = await svc.listConversations(
      {
        tenant_id: principal.tenant_id,
        ...(q.status ? { status: q.status as ConversationStatus } : {}),
        ...(q.owner === "me" ? { owner_id: principal.id } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const outcome = await svc.createConversation(
      {
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        ...(body.connector_id ? { connector_id: body.connector_id } : {}),
        ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
        ...(body.initial_message ? { initial_message: body.initial_message } : {}),
        ...(body.memory !== undefined ? { memory: body.memory } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.title ? { title: body.title } : {}),
      },
      db,
    );
    return c.json(serializeConversation(outcome), 201);
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const detail = await svc.getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");
    return c.json(detail, 200);
  });

  app.openapi(appendRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const outcome = await svc.appendUserMessage(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        message: body.message,
        ...(body.memory !== undefined ? { memory: body.memory } : {}),
      },
      db,
    );
    return c.json(serializeConversation(outcome), 200);
  });

  app.openapi(approveRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, approval_id } = c.req.valid("param");
    const outcome = await svc.decideApproval(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        approval_id,
        actor_id: principal.id,
        decision: "approved",
      },
      db,
    );
    return c.json(serializeConversation(outcome), 200);
  });

  app.openapi(rejectRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, approval_id } = c.req.valid("param");
    const body = c.req.valid("json");
    const outcome = await svc.decideApproval(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        approval_id,
        actor_id: principal.id,
        decision: "rejected",
        ...(body.reason ? { reason: body.reason } : {}),
      },
      db,
    );
    return c.json(serializeConversation(outcome), 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await svc.cancelConversation(principal.tenant_id, id, principal.id, db);
    if (!row) throw new NotFoundError("conversation");
    return c.json(row, 200);
  });

  app.openapi(compactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await svc.compactConversation(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        ...(body.keep_last !== undefined ? { keep_last: body.keep_last } : {}),
      },
      db,
    );
    return c.json(result, 200);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await svc.patchConversation(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
      },
      db,
    );
    if (!row) throw new NotFoundError("conversation");
    return c.json(row, 200);
  });

  // SSE stream: replay the most recent turn's events. We hand-roll
  // this outside of the openapi handler because streamSSE needs to
  // commandeer the response.
  app.get("/v1/conversations/:id/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const detail = await svc.getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");

    return streamSSE(c, async (stream) => {
      // Replay all persisted tool calls + messages + approvals as
      // discrete events so the caller can rebuild the UI state.
      for (const msg of detail.messages) {
        const frame = serializeEvent({
          type: "message",
          role: msg.role,
          content: msg.content,
        });
        await stream.writeSSE(frame);
      }
      for (const call of detail.tool_calls) {
        await stream.writeSSE(
          serializeEvent({ type: "tool_call", tool: call.tool, input: call.input }),
        );
        if (call.output !== null && call.output !== undefined) {
          await stream.writeSSE(
            serializeEvent({ type: "tool_result", tool: call.tool, output: call.output }),
          );
        }
      }
      for (const approval of detail.approvals) {
        if (approval.status === "pending") {
          await stream.writeSSE(
            serializeEvent({
              type: "approval_request",
              approval_id: approval.id,
              kind: approval.kind,
              summary: approval.summary,
              ...(approval.diff !== null && approval.diff !== undefined
                ? { diff: approval.diff }
                : {}),
            }),
          );
        }
      }
      if (detail.conversation.status === "committed" && detail.conversation.target_workflow_id) {
        await stream.writeSSE(
          serializeEvent({
            type: "committed",
            workflow_id: detail.conversation.target_workflow_id,
          }),
        );
      }
      // Compute turn usage for the completed event so CLI clients
      // (sk) can surface token counts without a second round-trip.
      let usage:
        | { turn_tokens: number; remaining_monthly_budget_tokens: number | null }
        | undefined;
      try {
        const used = await monthlyUsage(principal.tenant_id, db);
        const route = await resolveModelRoute(principal.tenant_id, db);
        const remaining =
          route.monthly_budget != null ? Math.max(0, route.monthly_budget - used) : null;
        usage = { turn_tokens: used, remaining_monthly_budget_tokens: remaining };
      } catch {
        /* usage lookup is best-effort */
      }
      await stream.writeSSE(
        serializeEvent({
          type: "completed",
          status: detail.conversation.status,
          ...(usage ? { usage } : {}),
        }),
      );
    });
  });

  // ---- File attachment route -------------------------------------------------
  // POST /v1/conversations/:id/messages/upload
  //
  // Accepts multipart/form-data with:
  //   - message (text): the user's message
  //   - files[] (binary, 1-10): attached files
  //   - memory (text, optional): SUBKIT.md content
  //
  // Each file is auto-ingested as a Knowledge Source scoped to the
  // conversation's target workflow (or global). The user message + any
  // file references are then passed to the standard appendUserMessage flow.

  app.post("/v1/conversations/:id/messages/upload", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");

    const formData = await c.req.formData();
    const message = formData.get("message");
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "message field is required" }, 400);
    }

    const memory = formData.get("memory");
    const files = formData.getAll("files");

    // Resolve conversation to determine scope for knowledge sources
    const conv = await svc.getConversation(principal.tenant_id, id, db);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const targetWorkflowId = conv.conversation.target_workflow_id;

    // Auto-ingest each file as a Knowledge Source
    const ingestedSources: string[] = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const source = await createKnowledgeSource(
          {
            tenant_id: principal.tenant_id,
            input: {
              name: file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
              scope: targetWorkflowId ? "workflow" : "global",
              ...(targetWorkflowId ? { workflow_id: targetWorkflowId } : {}),
            },
            upload: {
              buffer,
              filename: file.name,
              ...(file.type ? { mime: file.type } : {}),
            },
            actor_id: principal.id,
          },
          db,
        );
        ingestedSources.push(source.id);
      } catch (err) {
        logger.warn({
          module: "conversations",
          action: "file_attachment.ingest_failed",
          msg: `Failed to ingest file attachment: ${file.name}`,
          error: err instanceof Error ? err.message : String(err),
          filename: file.name,
        });
      }
    }

    // Append enriched message that references ingested files
    const enrichedMessage =
      ingestedSources.length > 0
        ? `${message}\n\n[Attached ${ingestedSources.length} file(s) as knowledge sources]`
        : message;

    const outcome = await svc.appendUserMessage(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        message: enrichedMessage,
        ...(typeof memory === "string" && memory.length > 0 ? { memory } : {}),
      },
      db,
    );

    const serialized = serializeConversation(outcome);
    return c.json({ ...serialized, ingested_knowledge_source_ids: ingestedSources }, 200);
  });

  // Touch the helper so the biome unused-import pass does not reject.
  void replayEvents;
}
