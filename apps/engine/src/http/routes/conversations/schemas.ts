import { z } from "@hono/zod-openapi";
import { SUGGEST_NEXT_KINDS, SUGGEST_NEXT_REASONS } from "@shared/suggest-next-reasons.ts";
import type * as svc from "../../../conversations/index.ts";
import { ResumeFormFieldSchema } from "../../../conversations/index.ts";
import { resolveEngineUrl } from "../../../llm/index.ts";

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

export const ConversationOwnerSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["user", "system_account"]),
    name: z.string(),
  })
  .openapi("ConversationOwner");

export const ConversationTargetRefSchema = z
  .object({ id: z.string(), slug: z.string().nullable(), name: z.string().nullable() })
  .openapi("ConversationTargetRef");

export const ConversationCreatedResourceSchema = z
  .object({
    kind: z.enum(["workflow", "connector", "execution"]),
    id: z.string(),
    slug: z.string().nullable(),
    name: z.string().nullable(),
    at: z.string(),
  })
  .openapi("ConversationCreatedResource");

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
    title_locked: z.boolean().optional(),
    origin_client: z.string().nullable().optional(),
    surface: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    outcome: z
      .enum([
        "answered",
        "in_progress",
        "failed",
        "awaiting_you",
        "committed",
        "abandoned",
        "stale",
      ])
      .optional(),
    last_activity_at: z.string().nullable().optional(),
    message_count: z.number().int().optional(),
    owner: ConversationOwnerSchema.nullable().optional(),
    target_workflow: ConversationTargetRefSchema.nullable().optional(),
    target_connector: ConversationTargetRefSchema.nullable().optional(),
    hidden: z.boolean().optional(),
    last_message_role: z.string().nullable().optional(),
    last_message_excerpt: z.string().nullable().optional(),
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
    model: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("UIMessage");

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
    outcome: z.enum(["ok", "error", "denied", "pending"]).nullable(),
  })
  .openapi("ConversationToolCall");

export const ConversationUsageSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    by_model: z.array(z.object({ model: z.string(), tokens: z.number().int().nonnegative() })),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string(),
        unpriced_models: z.array(z.string()),
      })
      .nullable(),
  })
  .openapi("ConversationUsage");

export const ConversationDetailSchema = z
  .object({
    conversation: ConversationSchema,
    owner: ConversationOwnerSchema.nullable(),
    created_resources: z.array(ConversationCreatedResourceSchema),
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
            tool_call_id: z.string().nullable().optional(),
            tool_name: z.string(),
            summary: z.string(),
            prompt: z
              .object({
                question: z.string(),
                intent_kind: z.string().optional(),
                authorization_url: z.string().optional(),
                fields: z.array(ResumeFormFieldSchema).optional(),
                external_tool: z
                  .object({
                    connector: z.string(),
                    tool: z.string(),
                    server_claim: z.string().optional(),
                  })
                  .optional(),
              })
              .optional(),
            expires_at: z.string(),
          })
          .nullable(),
        next_action: z.string(),
        one_sentence: z.string(),
      })
      .nullable()
      .optional(),
    usage: ConversationUsageSchema,
  })
  .openapi("ConversationDetail");

const REFERENCE_LABEL = /^[\p{L}\p{N} _./-]{1,200}$/u;

export const ConversationReferenceSchema = z
  .object({
    type: z.enum(["workflow", "connector", "skill", "knowledge_source"]),
    id: z.string().uuid(),
    label: z
      .string()
      .min(1)
      .max(200)
      .refine((v) => REFERENCE_LABEL.test(v), "label: slug or display-name characters only"),
  })
  .openapi("ConversationReference");

const ReferencesField = z.array(ConversationReferenceSchema).max(20).optional();

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
    playground: z.boolean().optional(),
    references: ReferencesField,
  })
  .openapi("CreateConversationBody");

export const AppendMessageBody = z
  .object({
    message: z.string().min(1),
    memory: z.string().optional(),
    permission_mode: PermissionModeSchema.optional(),
    step_budget: z.number().int().min(1).max(64).optional(),
    references: ReferencesField,
    client_suppress: z.boolean().optional(),
    event: z
      .object({
        type: z.literal("request_credential_form"),
        credential_hint: z.string().max(120).optional(),
      })
      .optional(),
  })
  .openapi("AppendConversationMessageBody");

export const NextSuggestionEventSchema = z
  .object({
    type: z.literal("next_suggestion"),
    suggestion: z.string().nullable(),
    reason: z.enum(SUGGEST_NEXT_REASONS),
    kind: z.enum(SUGGEST_NEXT_KINDS).nullable(),
  })
  .openapi("NextSuggestionEvent");

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
        draft_version_id: z.string().nullable().optional(),
        current_version_id: z.string().nullable().optional(),
        persistence_kind: z.enum(["draft", "active"]).optional(),
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
    last_context_budget: z
      .object({
        cap_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
        dropped_sections: z.array(z.string()),
        assembled_at: z.string(),
      })
      .nullable(),
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

export function wantsSSE(accept: string | null | undefined): boolean {
  if (!accept) return false;
  return accept.toLowerCase().includes("text/event-stream");
}

export function outcomeFrame(c: svc.ConversationTurnOutcome): { event: string; data: string } {
  const json = serializeConversation(c);
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
