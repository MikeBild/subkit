import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineError } from "@cli-core/errors.ts";
import { z } from "zod";
import { type DebugCorrelationFields, debugLog } from "../debug.ts";
import type { EngineClient } from "../engine-client.ts";
import { isTransientSocketDrop } from "../repl/error-humanize.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function synthesizeRecoveredOutcome(detail: ConversationDetail): ConversationRunOutcome & {
  __recovered: true;
} {
  const status = detail.conversation.status;
  const completedStatus =
    status === "awaiting_input"
      ? "awaiting_input"
      : status === "completed"
        ? "completed"
        : "active";
  return {
    conversation: detail.conversation,
    events: [
      {
        type: "completed",
        status: completedStatus,
        usage: null,
      },
    ],
    status,
    __recovered: true,
  };
}

export interface ExtendedTurnUsage {
  prompt_tokens_last_call: number | null;
  turn_tokens_total: number | null;
  cache_read_tokens: number | null;
  cache_read_pct: number | null;
}

export function readExtendedTurnUsage(usage: unknown): ExtendedTurnUsage {
  if (typeof usage !== "object" || usage === null) {
    return {
      prompt_tokens_last_call: null,
      turn_tokens_total: null,
      cache_read_tokens: null,
      cache_read_pct: null,
    };
  }
  const u = usage as {
    prompt_tokens_last_call?: unknown;
    turn_tokens_total?: unknown;
    cache_read_tokens?: unknown;
    cache_read_pct?: unknown;
  };
  return {
    prompt_tokens_last_call:
      typeof u.prompt_tokens_last_call === "number" ? u.prompt_tokens_last_call : null,
    turn_tokens_total: typeof u.turn_tokens_total === "number" ? u.turn_tokens_total : null,
    cache_read_tokens: typeof u.cache_read_tokens === "number" ? u.cache_read_tokens : null,
    cache_read_pct: typeof u.cache_read_pct === "number" ? u.cache_read_pct : null,
  };
}

const ForkResponseSchema = z.object({
  conversation: z
    .object({
      id: z.string().uuid(),
      tenant_id: z.string().uuid(),
      title: z.string().nullable(),
      status: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .passthrough(),
  source_conversation_id: z.string().uuid(),
  anchor_message_id: z.string().uuid(),
  copied_message_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

type Schemas = components["schemas"];

export type ConversationSummary = Schemas["Conversation"];

export type ConversationRunOutcome = Schemas["ConversationRunOutcome"];

export type RequestCredentialFormEvent = NonNullable<
  Schemas["AppendConversationMessageBody"]["event"]
>;

export type ConversationDetail = Schemas["ConversationDetail"];

export type ResumeSummary = NonNullable<ConversationDetail["resume_summary"]>;

export type ConversationContextSnapshot = Schemas["ContextSnapshot"];

export type ToolPolicies = Schemas["ToolPoliciesResponse"];

type CreateConversationBody = ApiBody<"/v1/conversations", "post">;

type AppendConversationMessageBody = ApiBody<"/v1/conversations/{id}/messages", "post">;

type PermissionMode = NonNullable<CreateConversationBody["permission_mode"]>;

function respondElicitationBody(
  output: unknown,
  reason: string | undefined,
  permission_mode: PermissionMode | undefined,
): ApiBody<"/v1/conversations/{id}/elicitations/{elicitation_id}/respond", "post"> {
  return {
    output,
    ...(reason ? { reason } : {}),
    ...(permission_mode ? { permission_mode } : {}),
  };
}

export const conversationsMethods = {
  async listConversations(
    this: EngineClient,
    query: ApiQuery<"/v1/conversations", "get"> = {},
  ): Promise<Schemas["ConversationListResponse"]> {
    const { data } = await this.api.GET("/v1/conversations", { params: { query } });
    return data as Schemas["ConversationListResponse"];
  },
  createConversation(
    this: EngineClient,
    body: CreateConversationBody,
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", "/v1/conversations", body, undefined, debugContext);
  },
  createConversationStream(
    this: EngineClient,
    body: CreateConversationBody,
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.streamPost("/v1/conversations", body, debugContext);
  },
  async getConversation(this: EngineClient, id: string): Promise<ConversationDetail> {
    const { data } = await this.api.GET("/v1/conversations/{id}", { params: { path: { id } } });
    return data as ConversationDetail;
  },
  appendConversationMessage(
    this: EngineClient,
    id: string,
    body: AppendConversationMessageBody,
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", `/v1/conversations/${id}/messages`, body, undefined, debugContext);
  },
  async submitSuggestionFeedback(
    this: EngineClient,
    conversationId: string,
    body: ApiBody<"/v1/conversations/{id}/suggest-next/feedback", "post">,
  ): Promise<void> {
    try {
      await this.api.POST("/v1/conversations/{id}/suggest-next/feedback", {
        params: { path: { id: conversationId } },
        body,
      });
    } catch (error) {
      debugLog(
        "suggest_next.feedback_failed",
        {
          conversationId,
          source: body.source,
          accepted: body.accepted,
          error: error instanceof Error ? error.message : String(error),
        },
        {},
      );
    }
  },
  appendConversationMessageStream(
    this: EngineClient,
    id: string,
    body: AppendConversationMessageBody,
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.streamPost(`/v1/conversations/${id}/messages`, body, debugContext);
  },
  async patchConversation(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/conversations/{id}", "patch">,
  ): Promise<ConversationSummary> {
    const { data } = await this.api.PATCH("/v1/conversations/{id}", {
      params: { path: { id } },
      body,
    });
    return data as ConversationSummary;
  },
  async previewConversationDraft(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/conversations/{id}/preview", "post"> = {},
  ): Promise<Schemas["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/preview", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["ConversationDirectToolResult"];
  },
  async probeConversationConnector(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/conversations/{id}/probe", "post"> = {},
  ): Promise<Schemas["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/probe", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["ConversationDirectToolResult"];
  },
  async patchConversationDraft(
    this: EngineClient,
    id: string,
    patches: Schemas["ConversationDraftPatchOp"][],
  ): Promise<Schemas["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/draft/patch", {
      params: { path: { id } },
      body: { patches },
    });
    return data as Schemas["ConversationDirectToolResult"];
  },
  async listConversationDraftSnapshots(
    this: EngineClient,
    id: string,
    limit?: number,
  ): Promise<Schemas["ConversationDirectToolResult"]> {
    const { data } = await this.api.GET("/v1/conversations/{id}/draft/snapshots", {
      params: { path: { id }, query: limit !== undefined ? { limit } : {} },
    });
    return data as Schemas["ConversationDirectToolResult"];
  },
  async restoreConversationDraftSnapshot(
    this: EngineClient,
    id: string,
    snapshotId?: string,
  ): Promise<Schemas["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/draft/snapshots/restore", {
      params: { path: { id } },
      body: snapshotId ? { snapshot_id: snapshotId } : {},
    });
    return data as Schemas["ConversationDirectToolResult"];
  },
  async forkConversationFromMessage(
    this: EngineClient,
    id: string,
    message_id: string,
  ): Promise<Schemas["ForkFromMessageResponse"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/fork-from-message/{message_id}", {
      params: { path: { id, message_id } },
    });
    ForkResponseSchema.parse(data);
    return data as Schemas["ForkFromMessageResponse"];
  },
  async compactConversation(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/conversations/{id}/compact", "post"> = {},
  ): Promise<Schemas["CompactConversationResponse"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/compact", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["CompactConversationResponse"];
  },
  respondElicitationStream(
    this: EngineClient,
    conversationId: string,
    elicitationId: string,
    output: unknown,
    reason?: string,
    debugContext?: DebugCorrelationFields,
    permission_mode?: PermissionMode,
  ): Promise<Response> {
    return this.streamPost(
      `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
      respondElicitationBody(output, reason, permission_mode),
      debugContext,
    );
  },

  async respondElicitation(
    this: EngineClient,
    conversationId: string,
    elicitationId: string,
    output: unknown,
    reason?: string,
    debugContext?: DebugCorrelationFields,
    permission_mode?: PermissionMode,
  ): Promise<ConversationRunOutcome> {
    const path = `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`;
    const body = respondElicitationBody(output, reason, permission_mode);
    try {
      return await this.request<ConversationRunOutcome>(
        "POST",
        path,
        body,
        undefined,
        debugContext,
      );
    } catch (err) {
      if (!isTransientSocketDrop(err)) throw err;
      debugLog(
        "http.transport_recovery",
        {
          path,
          strategy: "respond_elicitation_retry",
          attempt: 1,
        },
        { ...this.debugContext(debugContext), conversation_id: conversationId },
      );
      await sleepMs(2000);
      try {
        return await this.request<ConversationRunOutcome>(
          "POST",
          path,
          body,
          undefined,
          debugContext,
        );
      } catch (retryErr) {
        if (
          retryErr instanceof Error &&
          retryErr.name === "EngineError" &&
          (retryErr as EngineError).code === "elicitation_already_resolved"
        ) {
          debugLog(
            "http.transport_recovery",
            {
              path,
              strategy: "respond_elicitation_replay_via_detail",
              elicitation_id: elicitationId,
            },
            { ...this.debugContext(debugContext), conversation_id: conversationId },
          );
          const detail = await this.getConversation(conversationId);
          return synthesizeRecoveredOutcome(detail);
        }
        throw retryErr;
      }
    }
  },
  async cancelConversation(this: EngineClient, id: string): Promise<ConversationSummary> {
    const { data } = await this.api.POST("/v1/conversations/{id}/cancel", {
      params: { path: { id } },
    });
    return data as ConversationSummary;
  },
  async getConversationContextSnapshot(
    this: EngineClient,
    id: string,
  ): Promise<ConversationContextSnapshot> {
    const { data } = await this.api.GET("/v1/conversations/{id}/context-snapshot", {
      params: { path: { id } },
    });
    return data as ConversationContextSnapshot;
  },
  streamConversation(
    this: EngineClient,
    id: string,
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.stream(`/v1/conversations/${id}/stream`, undefined, debugContext);
  },
  async getConversationToolPolicies(this: EngineClient, id: string): Promise<ToolPolicies> {
    const { data } = await this.api.GET("/v1/conversations/{id}/tool-policies", {
      params: { path: { id } },
    });
    return data as ToolPolicies;
  },
  async setConversationToolPolicies(
    this: EngineClient,
    id: string,
    policies: Schemas["ToolPoliciesPatchBody"]["policies"],
  ): Promise<ToolPolicies> {
    const { data } = await this.api.PUT("/v1/conversations/{id}/tool-policies", {
      params: { path: { id } },
      body: { policies },
    });
    return data as ToolPolicies;
  },
};
