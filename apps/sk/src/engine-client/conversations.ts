import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineError } from "@cli-core/errors.ts";
import type { ConversationReferenceType } from "@shared/conversation-reference.ts";
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

export interface ConversationSummary {
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
  last_message_role?: string | null;
  last_message_excerpt?: string | null;
}

export interface ConversationRunOutcome {
  conversation: ConversationSummary;
  events: unknown[];
  status: string;
  committed_workflow_id?: string;
  pending_approval_id?: string;
}

export interface RequestCredentialFormEvent {
  type: "request_credential_form";
  credential_hint?: string;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: Array<{
    id: string;
    role: string;
    parts: unknown[];
    created_at: string;
  }>;
  tool_calls: unknown[];
  draft: unknown;
  approvals?: unknown[];
  resume_summary?: ResumeSummary | null;
}

export interface ResumeSummary {
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    slug: string | null;
    id: string | null;
    environment: string | null;
  };
  stage: string;
  last_successful_probe: string | null;
  last_successful_preview: string | null;
  unsaved: boolean;
  pending_approval: {
    id: string;
    tool_call_id?: string | null;
    tool_name: string;
    summary: string;
    prompt?: {
      question: string;
      kind?: string;
      summary?: string;
      destructive?: boolean;
      risk_level?: string;
      target_label?: string;
      reversible?: boolean;
      default?: string;
      options?: unknown[];
      fields?: unknown[];
      diffs?: unknown[];
    };
  } | null;
  next_action: string;
  one_sentence: string;
}

export interface ConversationContextSnapshot {
  conversation_id: string;
  connector_id: string | null;
  workflow_id: string | null;
  draft_mode: string;
  authoring_mode: string | null;
  authoring_stage: string | null;
  draft_summary: {
    readiness: string;
    next_action: string | null;
    next_required_action: string | null;
    next_suggested_tool: string | null;
    missing_fields: string[];
    progress_label: string | null;
    lifecycle_state: string;
    blocked_by: string[];
  } | null;
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    slug: string | null;
    id: string | null;
    environment: string | null;
    lifecycle_state: string;
  } | null;
  checkpoint_statuses: Array<{
    key: string;
    status: string;
    verified_at: string | null;
    verified_by_tool: string | null;
    ok: boolean | null;
    summary: string | null;
  }>;
  stale_checkpoints: string[];
  next_required_action: string | null;
  persisted_resources: Array<{
    kind: string;
    id: string;
    slug: string | null;
    name: string | null;
    version_id: string | null;
    version: number | null;
    environment: string | null;
    saved_at: string;
  }>;
  latest_execution: {
    execution_id: string;
    workflow_id: string | null;
    workflow_version_id: string | null;
    status: string;
    environment: string;
    warnings_count: number;
    recorded_at: string;
    diagnosis_available: boolean;
  } | null;
  latest_diagnosis: {
    execution_id: string;
    recorded_at: string;
    reason: string;
    warning_sources: Array<{ step_key: string; code: string; identifier: string | null }>;
    steps: Array<{
      step_key: string;
      kind: string;
      status: string;
      duration_ms: number | null;
      output_preview?: unknown;
      error?: unknown;
      request_meta?: unknown;
    }>;
  } | null;
  skills: {
    global: Array<{ id: string; title: string }>;
    connector: Array<{ id: string; title: string }>;
    workflow: Array<{ id: string; title: string }>;
    total: number;
  };
  messages: {
    total: number;
    last_role: string | null;
  };
  tool_calls_total: number;
  pending_elicitations: number;
  attachments: {
    total: number;
    items: Array<{ slug: string; filename: string | null; bytes: number | null }>;
  };
  latest_probe: {
    ok: boolean;
    summary: string | null;
    failure_code: string | null;
  } | null;
  latest_preview: {
    ok: boolean;
    summary: string | null;
    step_id: string | null;
  } | null;
  workflow_version: {
    workflow_id: string;
    current_version: number | null;
  } | null;
  last_context_budget: {
    cap_tokens: number;
    total_tokens: number;
    dropped_sections: string[];
    assembled_at: string;
  } | null;
  grounding_status: {
    state: "fresh" | "stale" | "unknown";
    advisory: string | null;
  } | null;
}

export const conversationsMethods = {
  async listConversations(
    this: EngineClient,
    query: { status?: string; owner?: "me"; limit?: number; offset?: number } = {},
  ): Promise<{ items: ConversationSummary[] }> {
    const { data } = await this.api.GET("/v1/conversations", {
      params: { query: query as ApiQuery<"/v1/conversations", "get"> },
    });
    return data as { items: ConversationSummary[] };
  },
  createConversation(
    this: EngineClient,
    body: {
      initial_message?: string;
      connector_id?: string;
      workflow_id?: string;
      memory?: string;
      model?: string;
      title?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      step_budget?: number;
      references?: Array<{ type: ConversationReferenceType; id: string; label: string }>;
      intake_item_ids?: string[];
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", "/v1/conversations", body, undefined, debugContext);
  },
  createConversationStream(
    this: EngineClient,
    body: {
      initial_message?: string;
      connector_id?: string;
      workflow_id?: string;
      memory?: string;
      model?: string;
      title?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      step_budget?: number;
    },
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
    body: {
      message: string;
      memory?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      step_budget?: number;
      client_suppress?: boolean;
      event?: RequestCredentialFormEvent;
      references?: Array<{ type: ConversationReferenceType; id: string; label: string }>;
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", `/v1/conversations/${id}/messages`, body, undefined, debugContext);
  },
  async submitSuggestionFeedback(
    this: EngineClient,
    conversationId: string,
    body: {
      accepted: boolean;
      source: "right-arrow" | "tab" | "typed-over" | "dismissed";
    },
  ): Promise<void> {
    try {
      await this.api.POST("/v1/conversations/{id}/suggest-next/feedback", {
        params: { path: { id: conversationId } },
        body: body as ApiBody<"/v1/conversations/{id}/suggest-next/feedback", "post">,
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
    body: {
      message: string;
      memory?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      step_budget?: number;
      client_suppress?: boolean;
      event?: RequestCredentialFormEvent;
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.streamPost(`/v1/conversations/${id}/messages`, body, debugContext);
  },
  async patchConversation(
    this: EngineClient,
    id: string,
    body: { model?: string | null; title?: string | null },
  ): Promise<ConversationSummary> {
    const { data } = await this.api.PATCH("/v1/conversations/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/conversations/{id}", "patch">,
    });
    return data as ConversationSummary;
  },
  async previewConversationDraft(
    this: EngineClient,
    id: string,
    body: {
      step_id?: string;
      input?: unknown;
      environment?: "dev" | "prod";
      include_step_results?: boolean;
    } = {},
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/preview", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/conversations/{id}/preview", "post">,
    });
    return data as components["schemas"]["ConversationDirectToolResult"];
  },
  async probeConversationConnector(
    this: EngineClient,
    id: string,
    body: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
      path?: string;
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean>;
      body?: unknown;
      environment?: "dev" | "prod";
      timeout_ms?: number;
    } = {},
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/probe", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/conversations/{id}/probe", "post">,
    });
    return data as components["schemas"]["ConversationDirectToolResult"];
  },
  async patchConversationDraft(
    this: EngineClient,
    id: string,
    patches: Array<{
      op: "add" | "remove" | "replace" | "move" | "copy" | "test";
      path: string;
      from?: string;
      value?: unknown;
    }>,
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/draft/patch", {
      params: { path: { id } },
      body: { patches } as ApiBody<"/v1/conversations/{id}/draft/patch", "post">,
    });
    return data as components["schemas"]["ConversationDirectToolResult"];
  },
  async listConversationDraftSnapshots(
    this: EngineClient,
    id: string,
    limit?: number,
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    const { data } = await this.api.GET("/v1/conversations/{id}/draft/snapshots", {
      params: {
        path: { id },
        query: (limit !== undefined ? { limit } : undefined) as ApiQuery<
          "/v1/conversations/{id}/draft/snapshots",
          "get"
        >,
      },
    });
    return data as components["schemas"]["ConversationDirectToolResult"];
  },
  async restoreConversationDraftSnapshot(
    this: EngineClient,
    id: string,
    snapshotId?: string,
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    const { data } = await this.api.POST("/v1/conversations/{id}/draft/snapshots/restore", {
      params: { path: { id } },
      body: (snapshotId ? { snapshot_id: snapshotId } : {}) as ApiBody<
        "/v1/conversations/{id}/draft/snapshots/restore",
        "post"
      >,
    });
    return data as components["schemas"]["ConversationDirectToolResult"];
  },
  async forkConversationFromMessage(
    this: EngineClient,
    id: string,
    message_id: string,
  ): Promise<{
    conversation: ConversationSummary;
    source_conversation_id: string;
    anchor_message_id: string;
    copied_message_count: number;
    truncated: boolean;
  }> {
    const { data: raw } = await this.api.POST(
      "/v1/conversations/{id}/fork-from-message/{message_id}",
      { params: { path: { id, message_id } } },
    );
    return ForkResponseSchema.parse(raw) as unknown as {
      conversation: ConversationSummary;
      source_conversation_id: string;
      anchor_message_id: string;
      copied_message_count: number;
      truncated: boolean;
    };
  },
  async compactConversation(
    this: EngineClient,
    id: string,
    body: { keep_last?: number } = {},
  ): Promise<{
    conversation: ConversationSummary;
    summary: string;
    messages_collapsed: number;
  }> {
    const { data } = await this.api.POST("/v1/conversations/{id}/compact", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/conversations/{id}/compact", "post">,
    });
    return data as {
      conversation: ConversationSummary;
      summary: string;
      messages_collapsed: number;
    };
  },
  respondElicitationStream(
    this: EngineClient,
    conversationId: string,
    elicitationId: string,
    output: unknown,
    reason?: string,
    debugContext?: DebugCorrelationFields,
    permission_mode?: "auto" | "ask" | "plan" | "yolo",
  ): Promise<Response> {
    const body: Record<string, unknown> = { output };
    if (reason) body.reason = reason;
    if (permission_mode) body.permission_mode = permission_mode;
    return this.streamPost(
      `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
      body,
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
    permission_mode?: "auto" | "ask" | "plan" | "yolo",
  ): Promise<ConversationRunOutcome> {
    const path = `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`;
    const body: Record<string, unknown> = { output };
    if (reason) body.reason = reason;
    if (permission_mode) body.permission_mode = permission_mode;
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
  async cancelConversation(this: EngineClient, id: string): Promise<unknown> {
    const { data } = await this.api.POST("/v1/conversations/{id}/cancel", {
      params: { path: { id } },
    });
    return data;
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
  async getConversationToolPolicies(
    this: EngineClient,
    id: string,
  ): Promise<{
    policies: Record<string, "no_confirm" | "confirm_before_execution" | "confirm_after_execution">;
  }> {
    const { data } = await this.api.GET("/v1/conversations/{id}/tool-policies", {
      params: { path: { id } },
    });
    return data as {
      policies: Record<
        string,
        "no_confirm" | "confirm_before_execution" | "confirm_after_execution"
      >;
    };
  },
  async setConversationToolPolicies(
    this: EngineClient,
    id: string,
    policies: Record<
      string,
      "no_confirm" | "confirm_before_execution" | "confirm_after_execution" | null
    >,
  ): Promise<{
    policies: Record<string, "no_confirm" | "confirm_before_execution" | "confirm_after_execution">;
  }> {
    const { data } = await this.api.PUT("/v1/conversations/{id}/tool-policies", {
      params: { path: { id } },
      body: { policies } as ApiBody<"/v1/conversations/{id}/tool-policies", "put">,
    });
    return data as {
      policies: Record<
        string,
        "no_confirm" | "confirm_before_execution" | "confirm_after_execution"
      >;
    };
  },
};
