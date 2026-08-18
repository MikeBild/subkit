// Shared Zod schemas, types, and SSE-frame helpers for the
// conversations REST surface. Every per-sub-resource module imports
// from here.

import { z } from "@hono/zod-openapi";
import { SUGGEST_NEXT_KINDS, SUGGEST_NEXT_REASONS } from "@shared/suggest-next-reasons.ts";
import type * as svc from "../../../conversations/index.ts";
import { resolveEngineUrl } from "../../../llm/index.ts";

/**
 * Build the per-turn `runtime_context` block from the inbound HTTP
 * request and the resolved principal. Threaded through to runLoop ↣
 * assembleEnhancedPrompt ↣ the system prompt, so the model quotes the
 * real engine_url + actor instead of inventing placeholders.
 */
export function buildRuntimeContextFromRequest(
  c: { req: { raw: Request } },
  principal: { email?: string; roles: string[] },
): { engine_url?: string; actor_email?: string; actor_role?: string } {
  const engineUrl = resolveEngineUrl(c.req.raw);
  return {
    ...(engineUrl ? { engine_url: engineUrl } : {}),
    ...(principal.email ? { actor_email: principal.email } : {}),
    ...(principal.roles?.[0] ? { actor_role: principal.roles[0] } : {}),
  };
}

export const ElicitationParam = z.object({
  id: z.string().uuid(),
  elicitation_id: z.string().uuid(),
});

export const ToolCallRespondParam = z.object({
  id: z.string().uuid(),
  tool_call_id: z.string().uuid(),
});

export const PermissionModeSchema = z.enum(["auto", "ask", "plan", "yolo"]);

export const RespondElicitationBody = z
  .object({
    output: z.unknown(),
    reason: z.string().optional(),
    permission_mode: PermissionModeSchema.optional(),
  })
  .openapi("RespondElicitationBody");

export const ConversationSchema = z
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
    last_message_role: z.string().nullable().optional(),
    last_message_excerpt: z.string().nullable().optional(),
    // The pending prompt: when it lapses, what it asks, and which tool raised
    // it. Populated by the list path only — like the two excerpt fields above —
    // because the single-conversation responses that share this schema have no
    // use for them and must not be forced to compute them.
    pending_elicitation_expires_at: z.string().nullable().optional(),
    pending_elicitation_summary: z.string().nullable().optional(),
    pending_elicitation_tool: z.string().nullable().optional(),
  })
  .openapi("Conversation");

export const ConversationListResponse = z
  .object({ items: z.array(ConversationSchema), total: z.number().int().nonnegative() })
  .openapi("ConversationListResponse");

export const UIMessageSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    parts: z.array(z.unknown()),
    created_at: z.string(),
  })
  .openapi("UIMessage");

/**
 * One persisted conversation tool call, as projected to clients.
 * `approved_by_user_id`, `confirmation_data` and `interaction_log` are
 * deliberately absent — a bare uuid, engine-internal bookkeeping, and a
 * field with no consumer respectively.
 */
export const ConversationToolCallSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    tool: z.string(),
    input: z.unknown(),
    output: z.unknown(),
    approval_required: z.boolean(),
    created_at: z.string(),
    parent_message_id: z.string().nullable().optional(),
    confirmation_state: z.string().nullable(),
    approved_at: z.string().nullable(),
    // Null means "not recorded" (a row written before the engine persisted
    // an outcome), never "succeeded".
    outcome: z.enum(["ok", "error", "denied", "pending"]).nullable(),
  })
  .openapi("ConversationToolCall");

export const ConversationDetailSchema = z
  .object({
    conversation: ConversationSchema,
    /**
     * Parts-based `UIMessage` array — mirrors Vercel AI SDK UI's message
     * shape. Built by `buildMessagesV2` over the persisted message +
     * tool-call rows.
     */
    messages: z.array(UIMessageSchema),
    tool_calls: z.array(ConversationToolCallSchema),
    draft: z.unknown(),
    resume_summary: z
      .object({
        active_target: z.object({
          kind: z.enum(["connector", "workflow", "none"]),
          name: z.string().nullable(),
          slug: z.string().nullable(),
          id: z.string().nullable(),
          environment: z.string().nullable(),
        }),
        stage: z.string(),
        last_successful_probe: z.string().nullable(),
        last_successful_preview: z.string().nullable(),
        unsaved: z.boolean(),
        pending_approval: z
          .object({
            id: z.string(),
            tool_name: z.string(),
            summary: z.string(),
            /** When this approval lapses. Non-null: the column is NOT NULL and
             *  `elicitationExpiry` stamps every row. */
            expires_at: z.string(),
          })
          .nullable(),
        next_action: z.string(),
        one_sentence: z.string(),
      })
      .nullable()
      .optional(),
  })
  .openapi("ConversationDetail");

export const CreateBody = z
  .object({
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    initial_message: z.string().optional(),
    memory: z.string().optional(),
    model: z.string().optional(),
    title: z.string().optional(),
    permission_mode: PermissionModeSchema.optional(),
    step_budget: z.number().int().min(1).max(64).optional(),
    // Additive optional: start this conversation as a playground/sandbox
    // authoring surface (scratch draft, workflow-authoring preloaded,
    // commit persists nothing). Durable on the draft row, never an env flag.
    playground: z.boolean().optional(),
  })
  .openapi("CreateConversationBody");

export const AppendMessageBody = z
  .object({
    message: z.string().min(1),
    memory: z.string().optional(),
    permission_mode: PermissionModeSchema.optional(),
    step_budget: z.number().int().min(1).max(64).optional(),
    /**
     * Per-conversation opt-out for the next-message suggestion that
     * normally rides on the SSE response. Sk-cli sets this to `true`
     * after the user dismisses N suggestions in a row, and clears it
     * the next time they accept one. Engine honors it by emitting a
     * `next_suggestion` frame with `suggestion: null, reason:
     * "client-suppress"` so the client still gets a deterministic
     * close marker.
     */
    client_suppress: z.boolean().optional(),
    /**
     * Typed client event driving a deterministic, no-LLM turn.
     * Single-variant object for now — promote to a
     * `z.discriminatedUnion("type", …)` when a second event type lands.
     *
     * `request_credential_form`: the sk composer detected a pasted
     * secret and asks the engine to open the masked `ask_user_form`
     * (password/sensitive field) directly instead of relaying prose for
     * the model to re-derive. `credential_hint` is a short kind label
     * (e.g. "digitalocean_pat") — NEVER the secret itself. Older
     * clients that keep sending only the prose fallback stay on the
     * LLM path unchanged; older engines strip the unknown key and fall
     * back to the prose the same request carries as `message`.
     */
    event: z
      .object({
        type: z.literal("request_credential_form"),
        credential_hint: z.string().max(120).optional(),
      })
      .optional(),
  })
  .openapi("AppendConversationMessageBody");

/**
 * Wire schema for the `next_suggestion` SSE frame. The frame is
 * additive — clients that don't recognize it ignore it. New consumers
 * import this schema to type the parsed payload. The `reason` and
 * `kind` enums come from `@shared/suggest-next-reasons` so a new
 * value lands here automatically (no drift between Zod, the TurnEvent
 * union, the service return type, and the client mirror).
 */
export const NextSuggestionEventSchema = z
  .object({
    type: z.literal("next_suggestion"),
    suggestion: z.string().nullable(),
    reason: z.enum(SUGGEST_NEXT_REASONS),
    kind: z.enum(SUGGEST_NEXT_KINDS).nullable(),
  })
  .openapi("NextSuggestionEvent");

/** A source ref attached to an answer (the "prove-after" grounding half).
 *  `RunOutcomeSchema.events` is `z.array(z.any())`, so these named
 *  component schemas are what document + type the citations frame. */
export const CitationSchema = z
  .object({
    source_type: z.enum(["knowledge_chunk", "connector_doc"]),
    id: z.string(),
    source_name: z.string().optional(),
    excerpt: z.string().optional(),
  })
  .openapi("Citation");

export const CitationsEventSchema = z
  .object({
    type: z.literal("citations"),
    citations: z.array(CitationSchema),
    parent_message_id: z.string().optional(),
  })
  .openapi("CitationsEvent");

/**
 * Body for the lightweight feedback route the client posts after the
 * user accepts, dismisses, or types over a suggestion. Stored as a
 * counter only — never persisted with the suggestion text.
 */
export const SuggestNextFeedbackBody = z
  .object({
    accepted: z.boolean(),
    source: z.enum(["right-arrow", "tab", "typed-over", "dismissed"]),
  })
  .openapi("SuggestNextFeedbackBody");

export const PatchConversationBody = z
  .object({
    model: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .openapi("PatchConversationBody");

export const CompactConversationBody = z
  .object({
    keep_last: z.number().int().min(0).max(50).optional(),
  })
  .openapi("CompactConversationBody");

export const CompactConversationResponse = z
  .object({
    conversation: ConversationSchema,
    summary: z.string(),
    messages_collapsed: z.number().int().min(0),
  })
  .openapi("CompactConversationResponse");

export const RunOutcomeSchema = z
  .object({
    conversation: ConversationSchema,
    events: z.array(z.any()),
    status: z.string(),
    committed_workflow_id: z.string().optional(),
    pending_elicitation_id: z.string().optional(),
  })
  .openapi("ConversationRunOutcome");

export type RunOutcomeJson = {
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
  pending_elicitation_id?: string;
};

export const ContextSnapshotSchema = z
  .object({
    conversation_id: z.string(),
    connector_id: z.string().nullable(),
    workflow_id: z.string().nullable(),
    draft_mode: z.string(),
    authoring_mode: z.string().nullable(),
    authoring_stage: z.string().nullable(),
    draft_summary: z
      .object({
        readiness: z.string(),
        next_action: z.string().nullable(),
        next_required_action: z.string().nullable(),
        next_suggested_tool: z.string().nullable(),
        missing_fields: z.array(z.string()),
        progress_label: z.string().nullable(),
        lifecycle_state: z.string(),
        blocked_by: z.array(z.string()),
      })
      .nullable(),
    active_target: z
      .object({
        kind: z.enum(["connector", "workflow", "none"]),
        name: z.string().nullable(),
        slug: z.string().nullable(),
        id: z.string().nullable(),
        environment: z.string().nullable(),
        lifecycle_state: z.string(),
      })
      .nullable(),
    checkpoint_statuses: z.array(
      z.object({
        key: z.string(),
        status: z.string(),
        verified_at: z.string().nullable(),
        verified_by_tool: z.string().nullable(),
        ok: z.boolean().nullable(),
        summary: z.string().nullable(),
      }),
    ),
    stale_checkpoints: z.array(z.string()),
    next_required_action: z.string().nullable(),
    persisted_resources: z.array(
      z.object({
        kind: z.string(),
        id: z.string(),
        slug: z.string().nullable(),
        name: z.string().nullable(),
        version_id: z.string().nullable(),
        version: z.number().nullable(),
        environment: z.string().nullable(),
        saved_at: z.string(),
      }),
    ),
    latest_execution: z
      .object({
        execution_id: z.string(),
        workflow_id: z.string().nullable(),
        workflow_version_id: z.string().nullable(),
        status: z.string(),
        environment: z.string(),
        warnings_count: z.number(),
        recorded_at: z.string(),
        diagnosis_available: z.boolean(),
      })
      .nullable(),
    latest_diagnosis: z
      .object({
        execution_id: z.string(),
        recorded_at: z.string(),
        reason: z.string(),
        warning_sources: z.array(
          z.object({
            step_key: z.string(),
            code: z.string(),
            identifier: z.string().nullable(),
          }),
        ),
        steps: z.array(
          z.object({
            step_key: z.string(),
            kind: z.string(),
            status: z.string(),
            duration_ms: z.number().nullable(),
            output_preview: z.unknown().optional(),
            error: z.unknown().optional(),
            request_meta: z.unknown().optional(),
          }),
        ),
      })
      .nullable(),
    skills: z.object({
      global: z.array(z.object({ id: z.string(), title: z.string() })),
      connector: z.array(z.object({ id: z.string(), title: z.string() })),
      workflow: z.array(z.object({ id: z.string(), title: z.string() })),
      total: z.number(),
    }),
    messages: z.object({
      total: z.number(),
      last_role: z.string().nullable(),
    }),
    tool_calls_total: z.number(),
    pending_elicitations: z.number(),
    attachments: z.object({
      total: z.number(),
      items: z.array(
        z.object({
          slug: z.string(),
          filename: z.string().nullable(),
          bytes: z.number().nullable(),
        }),
      ),
    }),
    latest_probe: z
      .object({
        ok: z.boolean(),
        summary: z.string().nullable(),
        failure_code: z.string().nullable(),
        probed_at: z.string().nullable(),
      })
      .nullable(),
    latest_preview: z
      .object({
        ok: z.boolean(),
        summary: z.string().nullable(),
        step_id: z.string().nullable(),
      })
      .nullable(),
    workflow_version: z
      .object({
        workflow_id: z.string(),
        current_version: z.number().nullable(),
      })
      .nullable(),
    // What the LAST assembled turn dropped to fit the model context —
    // null when no turn ran since engine start (in-process cache).
    last_context_budget: z
      .object({
        cap_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
        dropped_sections: z.array(z.string()),
        assembled_at: z.string(),
      })
      .nullable(),
    // Whether the draft's grounding (the connector schema/knowledge it was
    // built on) is still current, checked at resume. Advisory only — never
    // blocks. `null` when the draft carries no grounding checkpoint.
    grounding_status: z
      .object({
        state: z.enum(["fresh", "stale", "unknown"]),
        advisory: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("ContextSnapshot");

export const ToolPolicyModeSchema = z.enum([
  "no_confirm",
  "confirm_before_execution",
  "confirm_after_execution",
]);
export const ToolPoliciesSchema = z
  .object({
    policies: z.record(z.string(), ToolPolicyModeSchema.nullable()),
  })
  .openapi("ToolPoliciesPatchBody");
export const ToolPoliciesResponse = z
  .object({
    policies: z.record(z.string(), ToolPolicyModeSchema),
  })
  .openapi("ToolPoliciesResponse");

export function serializeConversation(c: svc.ConversationTurnOutcome): RunOutcomeJson {
  const out: RunOutcomeJson = {
    conversation: c.conversation,
    events: c.result.events,
    status: c.result.status,
  };
  if (c.result.committed_workflow_id) out.committed_workflow_id = c.result.committed_workflow_id;
  if (c.result.pending_elicitation_id) out.pending_elicitation_id = c.result.pending_elicitation_id;
  return out;
}

/**
 * True when the client asked for live SSE on a turn-driving POST.
 * We content-negotiate on `Accept: text/event-stream` so existing
 * JSON callers (web, MCP bridge, test suites) keep their current
 * single-response shape, while sk-cli opts in to live frames.
 */
export function wantsSSE(accept: string | null | undefined): boolean {
  if (!accept) return false;
  return accept.toLowerCase().includes("text/event-stream");
}

/**
 * Terminal SSE event carrying the conversation row + final status that
 * JSON callers receive in the response body. Live consumers read this
 * to learn the conversation_id (on create) and to know the loop has
 * fully unwound. Distinct from the in-loop `completed` frame, which
 * carries the per-turn token usage.
 */
export function outcomeFrame(c: svc.ConversationTurnOutcome): { event: string; data: string } {
  const json = serializeConversation(c);
  // events[] is omitted from the SSE outcome — every event already
  // streamed live, repeating them here would double-render.
  const { events: _drop, ...rest } = json;
  void _drop;
  return { event: "outcome", data: JSON.stringify(rest) };
}

export function errorFrame(payload: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): { event: string; data: string } {
  return { event: "error", data: JSON.stringify(payload) };
}
