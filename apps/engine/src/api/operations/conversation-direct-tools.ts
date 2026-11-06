import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

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
    data: z.unknown(),
    committed_workflow_id: z.string().optional(),
    logs: z.array(DirectToolLogSchema),
    diffs: z.array(DirectToolDiffSchema),
  })
  .openapi("ConversationDirectToolResult");

const PreviewRequestSchema = z
  .object({
    step_id: z.string().min(1).optional(),
    mode: z
      .enum(["schema_only"])
      .optional()
      .describe(
        "Sensitive drafts only, without step_id. `schema_only` validates the definition and compiles its expressions without running any step or returning any value. Structure is checked, content is not; live verification happens in the Cockpit by the signed-in person.",
      ),
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
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

const SnapshotsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });

const INVALID_ARGS_HINT =
  "The body must satisfy the tool's input schema — see /openapi.json for the request shape.";

export interface DirectToolOutcome {
  ok: boolean;
  tool: string;
  tool_call_id: string;
  data: unknown;
  committed_workflow_id?: string;
  logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; ts: string }>;
  diffs: Array<{ title: string; language: "json" | "yaml" | "text"; hunks: unknown[] }>;
}

export interface ConversationDirectToolServices {
  readonly DirectInvokeError: abstract new (
    ...args: never[]
  ) => Error & { readonly error_code: string; readonly status: 400 | 404 | 409 };
  readonly PendingElicitationBlockedError: abstract new (
    ...args: never[]
  ) => Error & { readonly pending_elicitation: unknown };
  invokeConversationToolDirect(p: {
    db: Db;
    tenant_id: string;
    conversation_id: string;
    actor_id: string | null;
    principal?: ResolvedPrincipal | null;
    tool: string;
    args: Record<string, unknown>;
  }): Promise<DirectToolOutcome>;
}

type PreviewBody = z.infer<typeof PreviewRequestSchema>;

interface PreviewInput {
  readonly id: string;
  readonly body: PreviewBody;
}

interface ToolInput {
  readonly id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

const RESPONSE = {
  success: { status: 200, description: "Tool result envelope (ok may be false — read `data`)" },
  errors: {
    400: "Invalid tool arguments",
    404: "Not found",
    409: "A pending dialog blocks direct invocation",
  },
} as const;

function idOf(param: unknown): string {
  return (param as { id: string }).id;
}

function same<T>(result: T): T {
  return result;
}

export function conversationDirectToolOperations(svc: ConversationDirectToolServices) {
  function toRejection(error: unknown): Rejection {
    if (error instanceof svc.DirectInvokeError) {
      return reject.status(
        error.status,
        error.error_code,
        error.message,
        undefined,
        error.error_code === "invalid_tool_args" ? INVALID_ARGS_HINT : undefined,
      );
    }
    if (error instanceof svc.PendingElicitationBlockedError) {
      return reject.conflict(error.message, {
        pending_elicitation: error.pending_elicitation as Record<string, unknown>,
      });
    }
    throw error;
  }

  async function invoke(
    scope: { db: Db; tenant_id: string; principal: ResolvedPrincipal | null },
    input: ToolInput,
  ): Promise<DirectToolOutcome | Rejection> {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    return svc
      .invokeConversationToolDirect({
        db: scope.db,
        tenant_id: scope.tenant_id,
        conversation_id: input.id,
        actor_id: principal.id,
        principal,
        tool: input.tool,
        args: input.args,
      })
      .catch(toRejection);
  }

  const preview = defineOperation<PreviewInput, DirectToolOutcome>({
    id: "conversation.preview",
    summary:
      "Dry-run the conversation's workflow draft (or a single step) directly — no model turn. Writes are always held.",
    permission: "conversation:write",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: AuditAction.CONVERSATION_DRY_RUN_TRANSFORM,
    async handler(scope, { id, body }) {
      const { step_id, ...rest } = body;
      if (step_id && rest.mode !== undefined) {
        return reject.status(
          400,
          "invalid_tool_args",
          "mode applies to the whole draft, not to step_id.",
          undefined,
          "Omit step_id to run the schema_only check of a sensitive draft.",
        );
      }
      return invoke(scope, {
        id,
        tool: step_id ? "dry_run_step" : "dry_run_workflow",
        args: step_id
          ? {
              step_id,
              ...(rest.input !== undefined ? { input: rest.input } : {}),
              ...(rest.environment !== undefined ? { environment: rest.environment } : {}),
            }
          : rest,
      });
    },
    http: {
      method: "post",
      path: "/v1/conversations/{id}/preview",
      tags: ["conversations"],
      params: IdParam,
      body: PreviewRequestSchema,
      response: DirectToolResultSchema,
      ...RESPONSE,
      toInput: ({ param, json }) => ({ id: idOf(param), body: json as PreviewBody }),
      toBody: same,
    },
  });

  const probe = defineOperation<ToolInput, DirectToolOutcome>({
    id: "conversation.probe",
    summary: "Probe the conversation's connector draft directly — no model turn.",
    permission: "conversation:write",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: AuditAction.CONVERSATION_PROBE_CONNECTOR,
    handler: invoke,
    http: {
      method: "post",
      path: "/v1/conversations/{id}/probe",
      tags: ["conversations"],
      params: IdParam,
      body: ProbeRequestSchema,
      response: DirectToolResultSchema,
      ...RESPONSE,
      toInput: ({ param, json }) => ({
        id: idOf(param),
        tool: "probe_connector_draft",
        args: json as Record<string, unknown>,
      }),
      toBody: same,
    },
  });

  const draftPatch = defineOperation<ToolInput, DirectToolOutcome>({
    id: "conversation.draft_patch",
    summary:
      "Apply an RFC 6902 JSON Patch to the workflow draft directly — same validation gates as the model-driven editor; an invalid patch leaves the draft untouched.",
    permission: "conversation:write",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: AuditAction.DRAFT_SPEC_UPDATED,
    handler: invoke,
    http: {
      method: "post",
      path: "/v1/conversations/{id}/draft/patch",
      tags: ["conversations"],
      params: IdParam,
      body: DraftPatchRequestSchema,
      response: DirectToolResultSchema,
      ...RESPONSE,
      toInput: ({ param, json }) => ({
        id: idOf(param),
        tool: "edit_workflow_patch",
        args: { patches: (json as z.infer<typeof DraftPatchRequestSchema>).patches },
      }),
      toBody: same,
    },
  });

  const snapshots = defineOperation<ToolInput, DirectToolOutcome>({
    id: "conversation.draft_snapshots",
    summary: "List draft snapshots for this conversation, newest first.",
    permission: "conversation:read",
    alternatePermissions: ["workflow:read"],
    effect: "read",
    handler: invoke,
    http: {
      method: "get",
      path: "/v1/conversations/{id}/draft/snapshots",
      tags: ["conversations"],
      params: IdParam,
      query: SnapshotsQuery,
      response: DirectToolResultSchema,
      ...RESPONSE,
      toInput: ({ param, query }) => {
        const { limit } = query as z.infer<typeof SnapshotsQuery>;
        return {
          id: idOf(param),
          tool: "list_draft_snapshots",
          args: limit !== undefined ? { limit } : {},
        };
      },
      toBody: same,
    },
  });

  const restore = defineOperation<ToolInput, DirectToolOutcome>({
    id: "conversation.draft_snapshot_restore",
    summary:
      "Roll the conversation draft back to a captured snapshot (most recent when snapshot_id is omitted).",
    permission: "conversation:write",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: AuditAction.DRAFT_SPEC_UPDATED,
    handler: invoke,
    http: {
      method: "post",
      path: "/v1/conversations/{id}/draft/snapshots/restore",
      tags: ["conversations"],
      params: IdParam,
      body: SnapshotRestoreRequestSchema,
      response: DirectToolResultSchema,
      ...RESPONSE,
      toInput: ({ param, json }) => {
        const { snapshot_id } = json as z.infer<typeof SnapshotRestoreRequestSchema>;
        return {
          id: idOf(param),
          tool: "restore_draft_snapshot",
          args: snapshot_id !== undefined ? { snapshot_id } : {},
        };
      },
      toBody: same,
    },
  });

  return { preview, probe, draftPatch, snapshots, restore };
}
