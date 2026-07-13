// Conversation surfaces of the engine client: create/append/stream
// turns, elicitation responses (with transport recovery), draft
// preview/probe/patch/snapshots, forks, compaction, and per-tool
// execution-mode overrides. Method group merged into `EngineClient` by
// `../engine-client.ts`.

import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineError } from "@cli-core/errors.ts";
import { z } from "zod";
import { type DebugCorrelationFields, debugLog } from "../debug.ts";
import type { EngineClient } from "../engine-client.ts";
import { isTransientSocketDrop } from "../repl/error-humanize.ts";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a synthetic ConversationRunOutcome from a conversation detail
 * after a transport-recovery path. Carries no events array — the UI
 * surfaces the recovery as a one-line notice and replays state from
 * the persisted conversation rows on the next render. The
 * `__recovered` marker lets the caller distinguish "real outcome" from
 * "we recovered, please re-render from getConversation" without
 * depending on a missing field.
 */
function synthesizeRecoveredOutcome(detail: ConversationDetail): ConversationRunOutcome & {
  __recovered: true;
} {
  // Emit a single synthesized `completed` event so the cli-core
  // reducer transitions the session out of "running" and the spinner
  // stops. We don't replay the lost text_deltas / tool events — the
  // engine persisted the row, but reconstructing per-step events from
  // the detail would risk drift. Forcing the user to send a prompt
  // (or pull /status) to fully resync is acceptable; what matters is
  // that the spinner stops and the UI doesn't pretend the engine is
  // still mid-turn.
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

/**
 * Honest cost telemetry on the SSE `completed` frame. The engine emits
 * two distinct figures alongside the legacy `turn_tokens`:
 *
 *   - `prompt_tokens_last_call` — the FINAL LLM call's prompt size
 *     (incl. cache reads/writes), the only number comparable to
 *     `context_cap_tokens`. Pre-fix the footer divided the
 *     turn-CUMULATIVE tokens by the per-prompt cap and showed
 *     `ctx 464k/180k (100%)` for prompts nowhere near the cap.
 *   - `turn_tokens_total` — cumulative tokens across every LLM call of
 *     the turn.
 *
 * The canonical `TurnUsage` type lives in `@cli-core/turn-event.ts`,
 * which is owned by a parallel in-flight change — the new fields ride
 * through the cli-core reducer untyped (it stores `ev.usage` wholesale
 * into `session.usage`), and this reader narrows them where the REPL
 * renders them.
 */
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

/**
 * Zod schema for the fork-from-message response so a server that
 * breaks the shape (or a future engine that adds an unknown field
 * interpreted by the wrong path) is rejected at the CLI boundary
 * instead of smuggled through as TS-shape-only.
 *
 * `conversation` is parsed loosely (the engine returns the full
 * ConversationSummary; we don't re-derive that schema here, that's
 * the OpenAPI client's job). The fields the CLI actually reads —
 * `id`, `tenant_id`, `title`, `created_at`, `updated_at`, `status` —
 * are pinned strictly so a contract drift on those is a parse error.
 */
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

// ---------- Minimal response shapes ----------

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

/**
 * Typed client event on POST /v1/conversations/{id}/messages — drives a
 * deterministic no-LLM turn on the engine. Single-variant for now;
 * mirrors `AppendConversationMessageBody.event` in the engine's Zod
 * schema. `request_credential_form` asks the engine to open the masked
 * `ask_user_form` (password/sensitive field) directly after the
 * composer's input-side secret filter fired. `credential_hint` is a
 * short kind label (e.g. "digitalocean_pat") — NEVER the secret itself.
 * Older engines strip the unknown key and fall back to the prose the
 * same request carries as `message`.
 */
export interface RequestCredentialFormEvent {
  type: "request_credential_form";
  credential_hint?: string;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: unknown[];
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
    tool_name: string;
    summary: string;
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
}

export const conversationsMethods = {
  // --------------------------- Conversations ---------------------------
  listConversations(
    this: EngineClient,
    query: { status?: string; owner?: "me"; limit?: number; offset?: number } = {},
  ): Promise<{ items: ConversationSummary[] }> {
    return this.request("GET", "/v1/conversations", undefined, query);
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
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", "/v1/conversations", body, undefined, debugContext);
  },
  /**
   * Streaming variant of createConversation. Returns the live SSE
   * response — frames must be consumed via `readSse`. The terminal
   * `outcome` event carries the conversation row + status that
   * `createConversation` returns in its JSON body; `events[]` is
   * NOT repeated in `outcome` (everything already streamed live).
   */
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
  getConversation(this: EngineClient, id: string): Promise<ConversationDetail> {
    return this.request("GET", `/v1/conversations/${id}`);
  },
  appendConversationMessage(
    this: EngineClient,
    id: string,
    body: {
      message: string;
      memory?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      step_budget?: number;
      /** Client-side opt-out for the next-message preview frame. */
      client_suppress?: boolean;
      /** Typed no-LLM turn event — see `RequestCredentialFormEvent`. */
      event?: RequestCredentialFormEvent;
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", `/v1/conversations/${id}/messages`, body, undefined, debugContext);
  },
  /**
   * Record an accept / dismiss / typed-over outcome for a suggestion.
   * Fire-and-forget — the engine increments a metric and returns
   * `{ ok: true }`. Errors are routed to the `debugLog` channel only
   * (a 5xx storm on this telemetry endpoint must not affect the
   * primary chat flow), so dev / on-call can still observe breakage
   * when `SK_DEBUG=1` without leaking it to the operator.
   */
  async submitSuggestionFeedback(
    this: EngineClient,
    conversationId: string,
    body: {
      accepted: boolean;
      source: "right-arrow" | "tab" | "typed-over" | "dismissed";
    },
  ): Promise<void> {
    try {
      await this.request("POST", `/v1/conversations/${conversationId}/suggest-next/feedback`, body);
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
  /** Streaming variant of appendConversationMessage. See
   *  `createConversationStream` for terminal-event semantics. */
  appendConversationMessageStream(
    this: EngineClient,
    id: string,
    body: {
      message: string;
      memory?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      step_budget?: number;
      /** Client-side opt-out for the next-message preview frame. */
      client_suppress?: boolean;
      /** Typed no-LLM turn event — see `RequestCredentialFormEvent`. */
      event?: RequestCredentialFormEvent;
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.streamPost(`/v1/conversations/${id}/messages`, body, debugContext);
  },
  patchConversation(
    this: EngineClient,
    id: string,
    body: { model?: string | null; title?: string | null },
  ): Promise<ConversationSummary> {
    return this.request("PATCH", `/v1/conversations/${id}`, body);
  },
  /**
   * Direct draft dry-run — one synchronous request, no model turn.
   * Runs `dry_run_workflow` (or `dry_run_step` when `step_id` is set)
   * against the conversation draft; the engine persists the tool call
   * so the next model turn sees the result. Writes stay held unless
   * `execute_writes` is true.
   */
  previewConversationDraft(
    this: EngineClient,
    id: string,
    body: {
      step_id?: string;
      input?: unknown;
      environment?: "dev" | "prod";
      execute_writes?: boolean;
      include_step_results?: boolean;
    } = {},
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    return this.request("POST", `/v1/conversations/${id}/preview`, body);
  },
  /** Direct connector-draft probe — one synchronous request, no model turn. */
  probeConversationConnector(
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
    return this.request("POST", `/v1/conversations/${id}/probe`, body);
  },
  /**
   * Direct RFC-6902 draft edit — same gates as the model-driven
   * editor; an invalid patch leaves the draft untouched.
   */
  patchConversationDraft(
    this: EngineClient,
    id: string,
    patches: Array<{
      op: "add" | "remove" | "replace" | "move" | "copy" | "test";
      path: string;
      from?: string;
      value?: unknown;
    }>,
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    return this.request("POST", `/v1/conversations/${id}/draft/patch`, { patches });
  },
  /** List the conversation's draft snapshots, newest first. */
  listConversationDraftSnapshots(
    this: EngineClient,
    id: string,
    limit?: number,
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    return this.request(
      "GET",
      `/v1/conversations/${id}/draft/snapshots`,
      undefined,
      limit !== undefined ? { limit } : undefined,
    );
  },
  /** Roll the draft back to a captured snapshot (most recent when omitted). */
  restoreConversationDraftSnapshot(
    this: EngineClient,
    id: string,
    snapshotId?: string,
  ): Promise<components["schemas"]["ConversationDirectToolResult"]> {
    return this.request(
      "POST",
      `/v1/conversations/${id}/draft/snapshots/restore`,
      snapshotId ? { snapshot_id: snapshotId } : {},
    );
  },
  /**
   * Fork a conversation at a specific message id. Creates a new
   * conversation copying messages up to and including the anchor.
   *
   * The response is parsed through a Zod schema rather than trusted
   * by TS shape alone, matching the schema-validation direction the
   * rest of the engine-client surface is moving toward.
   */
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
    const raw = await this.request<unknown>(
      "POST",
      `/v1/conversations/${encodeURIComponent(id)}/fork-from-message/${encodeURIComponent(
        message_id,
      )}`,
    );
    return ForkResponseSchema.parse(raw) as unknown as {
      conversation: ConversationSummary;
      source_conversation_id: string;
      anchor_message_id: string;
      copied_message_count: number;
      truncated: boolean;
    };
  },
  compactConversation(
    this: EngineClient,
    id: string,
    body: { keep_last?: number } = {},
  ): Promise<{
    conversation: ConversationSummary;
    summary: string;
    messages_collapsed: number;
  }> {
    return this.request("POST", `/v1/conversations/${id}/compact`, body);
  },
  /** Streaming variant of respondElicitation. Returns the raw SSE
   *  Response so the caller can read TurnEvents in real time exactly
   *  like `createConversationStream` / `appendConversationMessageStream`.
   *  Pre-fix the elicit-resume path was JSON-only — the CLI saw nothing
   *  for the entire 1–2 minute resumed turn, then everything at once. */
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
      // Long LLM turns (the engine streams text + multiple tool calls
      // server-side) can exceed bun-fetch's keep-alive window, dropping
      // the response side of the socket while the engine keeps writing.
      // The engine persists turn state at every step, so we recover by
      // (a) trying the POST once more — the engine's elicitation
      // dedup raises 409 elicitation_already_resolved if the first
      // POST landed, which is the explicit "your response was applied"
      // signal — and (b) on 409, replaying from the conversation
      // detail. This keeps the user out of the duplicate-prompt
      // workaround that session f00b8d1c walked into.
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
          // First POST already landed; the elicitation row moved on.
          // Pull the latest detail and synthesize a recovered outcome.
          // No SSE events to replay — the UI prints the recovery
          // hint and re-renders messages/tool_calls from detail.
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
  cancelConversation(this: EngineClient, id: string): Promise<unknown> {
    return this.request("POST", `/v1/conversations/${id}/cancel`);
  },
  getConversationContextSnapshot(
    this: EngineClient,
    id: string,
  ): Promise<ConversationContextSnapshot> {
    return this.request("GET", `/v1/conversations/${id}/context-snapshot`);
  },
  streamConversation(
    this: EngineClient,
    id: string,
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.stream(`/v1/conversations/${id}/stream`, undefined, debugContext);
  },
  // Per-tool execution-mode overrides (Bug RR). Empty `{policies}`
  // GETs the current map; PUT merges the supplied entries (a `null`
  // value clears that tool's override).
  getConversationToolPolicies(
    this: EngineClient,
    id: string,
  ): Promise<{
    policies: Record<string, "no_confirm" | "confirm_before_execution" | "confirm_after_execution">;
  }> {
    return this.request("GET", `/v1/conversations/${id}/tool-policies`);
  },
  setConversationToolPolicies(
    this: EngineClient,
    id: string,
    policies: Record<
      string,
      "no_confirm" | "confirm_before_execution" | "confirm_after_execution" | null
    >,
  ): Promise<{
    policies: Record<string, "no_confirm" | "confirm_before_execution" | "confirm_after_execution">;
  }> {
    return this.request("PUT", `/v1/conversations/${id}/tool-policies`, { policies });
  },
};
