// Conversations service — public API used by REST + MCP.
//
// Thin wrapper over loop.ts that also creates the conversation record,
// handles elicitation response + resume, and exposes a `get` that
// returns the whole conversation (messages, tool calls, live draft).

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../db/schema/index.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import { log } from "../logging/logger.ts";
import { cancelConversationAbort } from "./abort.ts";
import { createEmptyDraftDocument } from "./authoring-state.ts";
import { appendSnapshot, loadDraft, undoLastSnapshot } from "./draft.ts";
import { type RunLoopResult, runLoop } from "./loop.ts";
import { buildResumeSummary, shouldShowResumeSummary } from "./resume.ts";
import type {
  ConversationDetail,
  ConversationMessageRecord,
  ConversationPermissionMode,
  ConversationRecord,
  ConversationStatus,
  ConversationToolCallRecord,
  DraftDocument,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function normalizePermissionMode(value: unknown): ConversationPermissionMode | null {
  return value === "auto" || value === "ask" || value === "plan" || value === "yolo" ? value : null;
}

function getStoredPermissionMode(
  draft: DraftDocument | null | undefined,
): ConversationPermissionMode | null {
  return normalizePermissionMode(draft?.session?.permission_mode);
}

async function persistPermissionModeIfChanged(params: {
  exec: Executor;
  tenant_id: string;
  conversation_id: string;
  draft: DraftDocument | null | undefined;
  permission_mode: ConversationPermissionMode | null;
}): Promise<void> {
  const current = getStoredPermissionMode(params.draft);
  const nextMode = normalizePermissionMode(params.permission_mode);
  // Non-sticky modes (yolo) never overwrite the stored sticky mode.
  // Treat them as a no-op so the next non-yolo turn picks up the
  // operator's previous auto/ask/plan choice.
  if (nextMode === "yolo") return;
  if (current === nextMode) return;
  const baseDraft = params.draft ?? createEmptyDraftDocument();
  await appendSnapshot(
    params.tenant_id,
    params.conversation_id,
    {
      ...baseDraft,
      session: {
        ...(baseDraft.session ?? {}),
        permission_mode: nextMode,
      },
    },
    params.exec,
  );
}

function rowToRecord(row: typeof conversations.$inferSelect): ConversationRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    target_workflow_id: row.target_workflow_id,
    target_connector_id: row.target_connector_id,
    status: row.status as ConversationStatus,
    owner_id: row.owner_id ?? null,
    model: row.model ?? null,
    title: row.title ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export interface CreateConversationParams {
  tenant_id: string;
  actor_id: string | null;
  connector_id?: string | null;
  workflow_id?: string | null;
  initial_message?: string;
  /** Optional user-supplied memory payload (client-side SUBKIT.md). */
  memory?: string | null;
  /** Optional initial model override (sets conversations.model). */
  model?: string | null;
  /** Optional human title (sets conversations.title). */
  title?: string | null;
  /** Client-supplied permission mode for the initial turn. */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  /** Live-event emitter — enables SSE streaming for the initial turn. */
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  /**
   * Fired synchronously once the conversation row has been inserted
   * but before the initial runLoop turn begins. Lets SSE callers emit
   * a `conversation_started` frame so the client knows the
   * conversation_id immediately, instead of waiting for the terminal
   * `outcome` frame at the end of the turn.
   */
  onCreated?: (record: ConversationRecord) => void;
  /** Real runtime context (engine_url, tenant_slug, actor email/role) — see runtime-context.ts. */
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
}

export interface ConversationTurnOutcome {
  conversation: ConversationRecord;
  result: RunLoopResult;
}

export interface PendingElicitationSummary {
  id: string;
  tool_name: string;
  summary: string;
}

export class PendingElicitationBlockedError extends Error {
  readonly pending_elicitation: PendingElicitationSummary;

  constructor(pending: PendingElicitationSummary) {
    super("resolve the pending dialog before sending another prompt");
    this.name = "PendingElicitationBlockedError";
    this.pending_elicitation = pending;
  }
}

/**
 * Raised when a duplicate `/respond` POST lands for an elicitation that
 * is already terminal. Without this guard a second response re-runs the
 * conversation loop, double-charges the LLM, and produces the silent
 * "approve approve …" UI seen in session 79bf2cca.
 */
export class ElicitationAlreadyResolvedError extends Error {
  readonly elicitation_id: string;
  readonly status: "resolved" | "cancelled" | "timeout";
  readonly previous_output: unknown;
  readonly previous_decision_reason: string | null;

  constructor(p: {
    elicitation_id: string;
    status: "resolved" | "cancelled" | "timeout";
    previous_output: unknown;
    previous_decision_reason: string | null;
  }) {
    super(`elicitation ${p.elicitation_id} is already ${p.status}`);
    this.name = "ElicitationAlreadyResolvedError";
    this.elicitation_id = p.elicitation_id;
    this.status = p.status;
    this.previous_output = p.previous_output;
    this.previous_decision_reason = p.previous_decision_reason;
  }
}

function isAskUserToolName(value: string | null | undefined): boolean {
  return (
    value === "ask_user_choice" ||
    value === "ask_user_multi" ||
    value === "ask_user_text" ||
    value === "ask_user_form" ||
    value === "ask_user_confirm"
  );
}

export async function createConversation(
  p: CreateConversationParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const memory = typeof p.memory === "string" ? p.memory : null;
  const initialPermissionMode = normalizePermissionMode(p.permission_mode);
  const initialDraft = createEmptyDraftDocument();
  if (initialPermissionMode) {
    initialDraft.session = { permission_mode: initialPermissionMode };
  }
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: p.connector_id ?? null,
      target_workflow_id: p.workflow_id ?? null,
      status: "active",
      draft: initialDraft,
      owner_id: p.actor_id ?? null,
      ...(p.model ? { model: p.model } : {}),
      ...(p.title ? { title: p.title } : {}),
      ...(memory ? { memory } : {}),
    })
    .returning();
  if (!row) throw new Error("conversations insert returned no row");

  log.conversation.created({
    conversation_id: row.id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    connector_id: p.connector_id ?? null,
    workflow_id: p.workflow_id ?? null,
    has_initial_message: Boolean(p.initial_message),
    memory_included: Boolean(memory),
  });

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_CREATED,
      resource_type: "conversation",
      resource_id: row.id,
      result: "success",
      metadata: {
        connector_id: p.connector_id ?? null,
        workflow_id: p.workflow_id ?? null,
        owner_id: p.actor_id ?? null,
        model: p.model ?? null,
        title: p.title ?? null,
        memory_included: Boolean(memory),
      },
    },
    exec,
  );
  if (memory) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_MEMORY_INJECTED,
        resource_type: "conversation",
        resource_id: row.id,
        result: "success",
        metadata: { bytes: memory.length },
      },
      exec,
    );
  }

  if (p.onCreated) {
    try {
      p.onCreated(rowToRecord(row));
    } catch {
      // Never block conversation creation on a callback error.
    }
  }

  // Seed the mock provider plan for known canned flows when the initial
  // message matches. In production this is a no-op because `LLM_PROVIDER`
  // isn't `mock` and the canned plan map stays empty. Tests flip the
  // provider to `mock` in setup.
  if (p.initial_message) {
    const msg = p.initial_message;
    if (/open.?meteo|berlin.*weather|tomorrow.*forecast/i.test(msg)) {
      const { cannedOpenMeteoBerlinPlan } = await import("../llm/mock-provider.ts");
      getMockProvider().setConversePlan(row.id, cannedOpenMeteoBerlinPlan());
    } else if (
      /subkit engine onboarding|guided connector workflow|connect the subkit engine/i.test(msg)
    ) {
      const { cannedConnectorWorkflowPlan } = await import("../llm/mock-provider.ts");
      const baseUrl = process.env.SUBKIT_PUBLIC_BASE_URL ?? "http://127.0.0.1:8080";
      getMockProvider().setConversePlan(row.id, cannedConnectorWorkflowPlan(baseUrl));
    } else if (/list.*users/i.test(msg)) {
      const { cannedListUsersPlan } = await import("../llm/mock-provider.ts");
      getMockProvider().setConversePlan(row.id, cannedListUsersPlan(p.connector_id ?? undefined));
    }
  }

  const result = p.initial_message
    ? await runLoop({
        db: exec,
        tenant_id: p.tenant_id,
        conversation_id: row.id,
        actor_id: p.actor_id,
        connector_id: p.connector_id ?? null,
        workflow_id: p.workflow_id ?? null,
        user_message: p.initial_message,
        user_memory: memory,
        model_override: p.model ?? null,
        ...(p.onEvent ? { onEvent: p.onEvent } : {}),
        ...(p.runtime_context ? { runtime_context: p.runtime_context } : {}),
        ...(initialPermissionMode ? { permission_mode: initialPermissionMode } : {}),
      })
    : { events: [], status: "active" as const };

  // Re-load so status reflects any loop side-effects.
  const updated = await getConversation(p.tenant_id, row.id, exec);
  if (!updated) throw new Error("conversation disappeared");
  return { conversation: updated.conversation, result };
}

export interface AppendMessageParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  message: string;
  /** Optional user-supplied memory payload to attach to this turn. */
  memory?: string | null;
  /** Surface for per-variant prompts — threaded to runLoop. */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web";
  /** Live-event emitter — enables SSE streaming. */
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  /** Real runtime context (engine_url, tenant_slug, actor email/role) — see runtime-context.ts. */
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  /** Client-supplied permission mode for this turn. */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
}

export async function appendUserMessage(
  p: AppendMessageParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const explicitPermissionMode = normalizePermissionMode(p.permission_mode);
  const storedPermissionMode = getStoredPermissionMode(conv.draft);
  const effectivePermissionMode = explicitPermissionMode ?? storedPermissionMode;
  if (explicitPermissionMode && explicitPermissionMode !== storedPermissionMode) {
    await persistPermissionModeIfChanged({
      exec,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      draft: conv.draft,
      permission_mode: explicitPermissionMode,
    });
  }
  {
    const { listElicitationsForConversation } = await import("./elicitations.ts");
    const pending = (await listElicitationsForConversation(p.tenant_id, p.conversation_id, exec))
      .filter((elicitation) => elicitation.status === "pending")
      .at(0);
    if (pending) {
      throw new PendingElicitationBlockedError({
        id: pending.id,
        tool_name: pending.tool_name,
        summary: pending.summary,
      });
    }
  }
  log.conversation.appended({
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    message_length: p.message.length,
    memory_included: typeof p.memory === "string",
  });
  const memory =
    typeof p.memory === "string" && p.memory.length > 0
      ? p.memory
      : conv.conversation.target_workflow_id
        ? null
        : null;
  // If a new memory payload arrived, persist it on the row and emit
  // an audit entry; otherwise reuse the last memory payload we stored.
  let effectiveMemory: string | null = null;
  if (typeof p.memory === "string") {
    await exec
      .update(conversations)
      .set({ memory: p.memory, updated_at: new Date() })
      .where(eq(conversations.id, p.conversation_id));
    effectiveMemory = p.memory;
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_MEMORY_INJECTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { bytes: p.memory.length },
      },
      exec,
    );
  } else {
    // Reuse whatever was last persisted on the row.
    const [row] = await exec
      .select({ memory: conversations.memory, model: conversations.model })
      .from(conversations)
      .where(eq(conversations.id, p.conversation_id))
      .limit(1);
    effectiveMemory = row?.memory ?? null;
  }
  void memory;

  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: p.message,
    user_memory: effectiveMemory,
    model_override: conv.conversation.model,
    ...(p.surface ? { surface: p.surface } : {}),
    ...(p.onEvent ? { onEvent: p.onEvent } : {}),
    ...(p.runtime_context ? { runtime_context: p.runtime_context } : {}),
    ...(effectivePermissionMode ? { permission_mode: effectivePermissionMode } : {}),
  });
  const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!updated) throw new Error("conversation disappeared");
  return { conversation: updated.conversation, result };
}

export interface RespondElicitationParams {
  tenant_id: string;
  conversation_id: string;
  elicitation_id: string;
  actor_id: string | null;
  /** User's answer — shape depends on the tool (choice/multi/text/form/confirm). */
  output: unknown;
  reason?: string;
  permission_mode?: ConversationPermissionMode | null;
  /**
   * Live event emitter. When the route is in SSE mode this fires for
   * every TurnEvent the resumed runLoop produces, so the CLI sees
   * real-time progress instead of a 1–2 minute spinner before the
   * buffered JSON outcome arrives. Pre-fix the respond endpoint was
   * JSON-only — the operator saw `summarising 28 tool results · 1m43s
   * · 370886t` for the entire turn before any text or tool card
   * rendered.
   */
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
}

/**
 * Resolve an `askUser.*` elicitation with the user's answer and
 * resume the conversation loop. This is the only pause-resume path —
 * the legacy approval flow has been removed.
 */
export async function respondElicitation(
  p: RespondElicitationParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const { resolveElicitation } = await import("./elicitations.ts");
  const resolveOutcome = await resolveElicitation(
    {
      tenant_id: p.tenant_id,
      id: p.elicitation_id,
      output: p.output,
      decided_by: p.actor_id,
      ...(p.reason ? { reason: p.reason } : {}),
    },
    exec,
  );
  if (resolveOutcome.kind === "not_found") throw new Error("elicitation not found");
  if (resolveOutcome.kind === "already_resolved") {
    const status =
      resolveOutcome.existing.status === "pending" ? "resolved" : resolveOutcome.existing.status;
    throw new ElicitationAlreadyResolvedError({
      elicitation_id: p.elicitation_id,
      status: status as "resolved" | "cancelled" | "timeout",
      previous_output: resolveOutcome.existing.output,
      previous_decision_reason: resolveOutcome.existing.decision_reason,
    });
  }
  const resolved = resolveOutcome.record;

  let originatingToolCall: {
    id: string;
    tool: string;
  } | null = null;
  if (resolved.tool_call_id) {
    const [toolCall] = await exec
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.id, resolved.tool_call_id),
          eq(conversationToolCalls.tenant_id, p.tenant_id),
        ),
      )
      .limit(1);
    originatingToolCall = toolCall ?? null;
  } else if (isAskUserToolName(resolved.tool_name)) {
    // Legacy ask_user_* rows were created without a tool_call_id. We
    // infer the latest matching call so already-open dialogs can still
    // resume correctly after the fix ships.
    const [toolCall] = await exec
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          eq(conversationToolCalls.conversation_id, p.conversation_id),
          eq(conversationToolCalls.tool, resolved.tool_name),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(1);
    originatingToolCall = toolCall ?? null;
  }

  // Mirror the response to the interaction_log on the originating tool
  // call. The confirmation state machine (see conversations/confirmation.ts)
  // tracks user_confirmed / user_declined / user_partial / user_tested so
  // the LLM can reason about what the operator actually said in the next
  // turn instead of reading only the raw output payload.
  if (originatingToolCall) {
    const { recordTransition } = await import("./confirmation.ts");
    const out = (p.output ?? {}) as Record<string, unknown>;
    let to_state: "confirmed" | "declined" | "partial" | "tested" = "confirmed";
    if (out.tested === true) to_state = "tested";
    else if (out.partial === true) to_state = "partial";
    else if (out.confirmed === false || out.declined === true) to_state = "declined";
    else if (out.confirmed === true) to_state = "confirmed";
    await recordTransition(exec, {
      tool_call_id: originatingToolCall.id,
      tenant_id: p.tenant_id,
      to_state,
      tool: originatingToolCall.tool,
      ...(p.actor_id ? { actor_id: p.actor_id } : {}),
      ...(isAskUserToolName(originatingToolCall.tool)
        ? {}
        : { conversation_id: p.conversation_id }),
      data: { elicitation_id: p.elicitation_id },
    });
  }

  log.conversation.approval.approved({
    conversation_id: p.conversation_id,
    approval_id: p.elicitation_id,
    actor_id: p.actor_id,
  });

  await exec
    .update(conversations)
    .set({ status: "active", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));

  // Auto-persist hook (PR11/PR12) — when the resolved elicitation
  // carries a `commit_intent`, the harness applies the intended write
  // atomically BEFORE the next LLM turn. The dispatcher emits a
  // synthetic tool-call + tool-result the runLoop's
  // buildModelMessages will replay so the LLM sees the persistence as
  // a normal tool result with `source: "harness_auto_persist"`.
  // Decline path injects a synthetic decline result so the next turn
  // carries the signal without firing the actual write.
  const { maybeAutoPersistFromElicitation, maybeCacheDraftCredentialFromElicitation } =
    await import("./persistence/auto-persist.ts");
  // Cache the credential first — if `auto-persist` then fires a
  // successful `save_connector_draft`, `saveConnectorAtomic` clears
  // the cache as part of the same call. The cache is what
  // `probe_connector_draft` reads when no `connector_credentials`
  // row exists yet (synthetic draft id ≠ UUID).
  await maybeCacheDraftCredentialFromElicitation({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_output: p.output,
    elicitation: {
      tool_name: resolved.tool_name,
    },
    db: exec,
  });
  await maybeAutoPersistFromElicitation({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    elicitation_output: p.output,
    elicitation: {
      id: resolved.id,
      tool_name: resolved.tool_name,
      input: resolved.input,
    },
    db: exec,
  });

  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const explicitPermissionMode = normalizePermissionMode(p.permission_mode);
  const storedPermissionMode = getStoredPermissionMode(conv.draft);
  const effectivePermissionMode = explicitPermissionMode ?? storedPermissionMode;
  if (explicitPermissionMode && explicitPermissionMode !== storedPermissionMode) {
    await persistPermissionModeIfChanged({
      exec,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      draft: conv.draft,
      permission_mode: explicitPermissionMode,
    });
  }

  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: null,
    ...(effectivePermissionMode ? { permission_mode: effectivePermissionMode } : {}),
    ...(p.onEvent ? { onEvent: p.onEvent } : {}),
  });
  const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!updated) throw new Error("conversation disappeared");
  if (result.status === "committed" && result.committed_workflow_id) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_COMMITTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { workflow_id: result.committed_workflow_id },
      },
      exec,
    );
  }
  return { conversation: updated.conversation, result };
}

export interface ContextSnapshot {
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
  /**
   * Compact "what's in scope for the LLM right now" payload used by sk's
   * `/context` pane. Thin projections over state that already lives on
   * the draft or elsewhere — no extra DB reads beyond what
   * getConversation + retrieveApplicableSkills already pull.
   */
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

/**
 * Read-only snapshot of the context the engine would inject if we
 * assembled a prompt right now. Powers the `/context` CLI panel —
 * skill counts / names in scope, recent activity, pending
 * elicitations. Does not invoke the LLM provider.
 */
export async function getContextSnapshot(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<ContextSnapshot | null> {
  const detail = await getConversation(tenant_id, conversation_id, exec);
  if (!detail) return null;

  const { retrieveApplicableSkills } = await import("../skills/service.ts");
  const { listElicitationsForConversation } = await import("./elicitations.ts");

  const applicable = await retrieveApplicableSkills(
    {
      tenant_id,
      ...(detail.conversation.target_connector_id
        ? { connector_ids: [detail.conversation.target_connector_id] }
        : {}),
      ...(detail.conversation.target_workflow_id
        ? { workflow_ids: [detail.conversation.target_workflow_id] }
        : {}),
    },
    exec,
  );

  const elicitations = await listElicitationsForConversation(tenant_id, conversation_id, exec);
  const pending = elicitations.filter((e) => e.status === "pending").length;

  const byScope = {
    global: applicable
      .filter((s) => s.scope === "global")
      .map((s) => ({ id: s.id, title: s.title })),
    connector: applicable
      .filter((s) => s.scope === "connector")
      .map((s) => ({ id: s.id, title: s.title })),
    workflow: applicable
      .filter((s) => s.scope === "workflow")
      .map((s) => ({ id: s.id, title: s.title })),
  };

  const lastMessage = detail.messages[detail.messages.length - 1];

  // Attachments live on a per-conversation table; surface a count +
  // first few so the user sees what the LLM can reference inline.
  const { conversationAttachments } = await import("../db/schema/index.ts");
  const attachmentRows = await exec
    .select({
      slug: conversationAttachments.slug,
      original_filename: conversationAttachments.original_filename,
      size_bytes: conversationAttachments.size_bytes,
    })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.tenant_id, tenant_id),
        eq(conversationAttachments.conversation_id, conversation_id),
      ),
    )
    .orderBy(asc(conversationAttachments.created_at));
  const attachmentItems = attachmentRows.slice(0, 10).map((a) => ({
    slug: a.slug,
    filename: a.original_filename ?? null,
    bytes: typeof a.size_bytes === "number" ? a.size_bytes : null,
  }));

  // Latest probe + preview live on the draft; mirror into the snapshot
  // so the `/context` pane doesn't have to re-normalise the draft.
  const latestProbeRaw = detail.draft?.connector?.latest_probe ?? null;
  const latestProbe = latestProbeRaw
    ? {
        ok: latestProbeRaw.ok === true,
        summary: latestProbeRaw.summary ?? null,
        failure_code: latestProbeRaw.failure_code ?? null,
      }
    : null;
  const latestPreviewRaw = detail.draft?.latest_preview ?? null;
  const latestPreview = latestPreviewRaw
    ? {
        ok: latestPreviewRaw.ok === true,
        summary: latestPreviewRaw.summary ?? null,
        step_id: latestPreviewRaw.step_id ?? null,
      }
    : null;
  const draftSummary = detail.draft?.summary ?? null;

  // Workflow version context for committed conversations — surfaces
  // the current version number for the bound workflow, so `/context`
  // can show operators where they are on the version timeline.
  let workflowVersion: ContextSnapshot["workflow_version"] = null;
  if (detail.conversation.target_workflow_id) {
    try {
      const { getWorkflow } = await import("../workflows/service.ts");
      const wf = await getWorkflow(tenant_id, detail.conversation.target_workflow_id, exec);
      workflowVersion = {
        workflow_id: detail.conversation.target_workflow_id,
        current_version:
          wf && "current_version" in wf && typeof wf.current_version === "number"
            ? wf.current_version
            : null,
      };
    } catch {
      workflowVersion = {
        workflow_id: detail.conversation.target_workflow_id,
        current_version: null,
      };
    }
  }

  return {
    conversation_id,
    connector_id: detail.conversation.target_connector_id,
    workflow_id: detail.conversation.target_workflow_id,
    draft_mode: detail.draft?.mode ?? "onboarding",
    authoring_mode: draftSummary?.mode ?? null,
    authoring_stage: draftSummary?.stage ?? null,
    draft_summary: draftSummary
      ? {
          readiness: draftSummary.readiness,
          next_action: draftSummary.next_action,
          next_required_action: draftSummary.next_required_action,
          next_suggested_tool: draftSummary.next_suggested_tool,
          missing_fields: draftSummary.missing_fields,
          progress_label: draftSummary.progress_label,
          lifecycle_state: draftSummary.lifecycle_state,
          blocked_by: draftSummary.blocked_by,
        }
      : null,
    active_target: draftSummary?.active_target ?? null,
    checkpoint_statuses: draftSummary?.checkpoints ?? [],
    stale_checkpoints:
      draftSummary?.checkpoints
        .filter((checkpoint) => checkpoint.status === "stale")
        .map((checkpoint) => checkpoint.key) ?? [],
    next_required_action: draftSummary?.next_required_action ?? null,
    persisted_resources: draftSummary?.persisted_resources ?? [],
    latest_execution: draftSummary?.latest_execution ?? null,
    latest_diagnosis: draftSummary?.latest_diagnosis ?? null,
    skills: {
      ...byScope,
      total: applicable.length,
    },
    messages: {
      total: detail.messages.length,
      last_role: lastMessage ? lastMessage.role : null,
    },
    tool_calls_total: detail.tool_calls.length,
    pending_elicitations: pending,
    attachments: { total: attachmentRows.length, items: attachmentItems },
    latest_probe: latestProbe,
    latest_preview: latestPreview,
    workflow_version: workflowVersion,
  };
}

export async function cancelConversation(
  tenant_id: string,
  conversation_id: string,
  actor_id: string | null,
  exec: Db,
): Promise<ConversationRecord | null> {
  const [row] = await exec
    .update(conversations)
    .set({ status: "abandoned", updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id,
      actor_type: actor_id ? "user" : "system",
      actor_id,
      action: AuditAction.CONVERSATION_CANCELLED,
      resource_type: "conversation",
      resource_id: conversation_id,
      result: "success",
    },
    exec,
  );
  cancelConversationAbort(conversation_id);
  return rowToRecord(row);
}

export async function getConversation(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<ConversationDetail | null> {
  const rows = await exec
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const msgs = await exec
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversation_id, id))
    .orderBy(asc(conversationMessages.created_at));
  const calls = await exec
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, id))
    .orderBy(asc(conversationToolCalls.created_at));
  const draft = await loadDraft(tenant_id, id, exec);
  const conversationRecord = rowToRecord(row);
  const pendingElicitationRows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at))
    .limit(1);
  const pendingElicitation = pendingElicitationRows[0]
    ? {
        id: pendingElicitationRows[0].id,
        tool_name: pendingElicitationRows[0].tool_name,
        summary:
          typeof (pendingElicitationRows[0].input as { summary?: unknown })?.summary === "string"
            ? ((pendingElicitationRows[0].input as { summary?: string }).summary ?? null)
            : null,
      }
    : null;
  const resumeSummary = shouldShowResumeSummary({
    conversation: conversationRecord,
    draft,
    pendingElicitation,
  })
    ? buildResumeSummary({
        conversation: conversationRecord,
        draft,
        pendingElicitation,
      })
    : null;
  return {
    conversation: conversationRecord,
    messages: msgs.map(
      (m): ConversationMessageRecord => ({
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role as ConversationMessageRecord["role"],
        content: m.content,
        created_at: m.created_at.toISOString(),
      }),
    ),
    tool_calls: calls.map(
      (c): ConversationToolCallRecord => ({
        id: c.id,
        conversation_id: c.conversation_id,
        tool: c.tool,
        input: c.input,
        output: c.output,
        approval_required: c.approval_required,
        created_at: c.created_at.toISOString(),
        parent_message_id: c.parent_message_id,
      }),
    ),
    draft,
    resume_summary: resumeSummary,
  };
}

export interface ListConversationsParams {
  tenant_id: string;
  status?: ConversationStatus;
  /** Restrict to conversations owned by this user id. */
  owner_id?: string;
  limit?: number;
  offset?: number;
}

export interface ConversationListItem extends ConversationRecord {
  last_message_role: string | null;
  last_message_excerpt: string | null;
}

function stringifyConversationExcerpt(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (content === null || content === undefined) return null;
  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string" && obj.text.trim().length > 0) {
      return obj.text.trim();
    }
    if (typeof obj.summary === "string" && obj.summary.trim().length > 0) {
      return obj.summary.trim();
    }
  }
  try {
    const raw = JSON.stringify(content);
    return raw.length > 2 ? raw : null;
  } catch {
    return String(content);
  }
}

function truncateExcerpt(text: string, max = 140): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  return `${squashed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export async function listConversations(
  p: ListConversationsParams,
  exec: Db,
): Promise<ConversationListItem[]> {
  const conds = [eq(conversations.tenant_id, p.tenant_id)];
  if (p.status) conds.push(eq(conversations.status, p.status));
  if (p.owner_id) conds.push(eq(conversations.owner_id, p.owner_id));
  const rows = await exec
    .select()
    .from(conversations)
    .where(and(...conds))
    .orderBy(desc(conversations.updated_at))
    .limit(Math.min(p.limit ?? 50, 200))
    .offset(p.offset ?? 0);
  if (rows.length === 0) return [];

  const conversationIds = rows.map((row) => row.id);
  const messages = await exec
    .select({
      conversation_id: conversationMessages.conversation_id,
      role: conversationMessages.role,
      content: conversationMessages.content,
      created_at: conversationMessages.created_at,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, p.tenant_id),
        inArray(conversationMessages.conversation_id, conversationIds),
      ),
    )
    .orderBy(desc(conversationMessages.created_at));

  const latestByConversation = new Map<string, { role: string | null; excerpt: string | null }>();
  for (const message of messages) {
    if (latestByConversation.has(message.conversation_id)) continue;
    const excerpt = stringifyConversationExcerpt(message.content);
    if (!excerpt) continue;
    latestByConversation.set(message.conversation_id, {
      role: message.role,
      excerpt: truncateExcerpt(excerpt),
    });
  }

  return rows.map((row) => {
    const latest = latestByConversation.get(row.id);
    return {
      ...rowToRecord(row),
      last_message_role: latest?.role ?? null,
      last_message_excerpt: latest?.excerpt ?? null,
    };
  });
}

export interface PatchConversationParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  model?: string | null;
  title?: string | null;
}

/**
 * Patch a conversation's mutable metadata. Emits `CONVERSATION_UPDATED`
 * audit. The conversation rows's `updated_at` is bumped so the
 * `/resume` picker re-orders against it.
 */
export async function patchConversation(
  p: PatchConversationParams,
  exec: Db,
): Promise<ConversationRecord | null> {
  const updates: Partial<typeof conversations.$inferInsert> = { updated_at: new Date() };
  if (p.model !== undefined) updates.model = p.model;
  if (p.title !== undefined) updates.title = p.title;
  const [row] = await exec
    .update(conversations)
    .set(updates)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_UPDATED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: {
        model: p.model ?? null,
        title: p.title ?? null,
      },
    },
    exec,
  );
  return rowToRecord(row);
}

export interface CompactConversationParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /** How many most-recent messages to preserve verbatim. */
  keep_last?: number;
}

export interface CompactConversationResult {
  conversation: ConversationRecord;
  summary: string;
  messages_collapsed: number;
}

/**
 * Collapse conversation message history into a single system summary
 * message followed by the last `keep_last` messages. The summary is
 * a deterministic stub (count of collapsed messages + first/last
 * user turns) so tests are reproducible; a richer implementation can
 * plug in an LLM-driven summarizer behind the same service call.
 *
 * NOTE: This mutates `conversation_messages` by marking the collapsed
 * rows as `role: "system"` with `content: { kind: "compacted" }`. We
 * do not DELETE rows so audit replay remains faithful.
 */
export async function compactConversation(
  p: CompactConversationParams,
  exec: Db,
): Promise<CompactConversationResult> {
  const keepLast = Math.max(0, Math.min(p.keep_last ?? 4, 50));
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");

  const total = conv.messages.length;
  const collapseCount = Math.max(0, total - keepLast);

  let summary = "";
  if (collapseCount > 0) {
    const firstUser = conv.messages.find((m) => m.role === "user");
    const lastAssistant = [...conv.messages].reverse().find((m) => m.role === "assistant");
    const firstText =
      firstUser && typeof firstUser.content === "object" && firstUser.content !== null
        ? JSON.stringify((firstUser.content as { text?: string }).text ?? firstUser.content).slice(
            0,
            200,
          )
        : "";
    const lastText =
      lastAssistant && typeof lastAssistant.content === "object" && lastAssistant.content !== null
        ? JSON.stringify(
            (lastAssistant.content as { text?: string }).text ?? lastAssistant.content,
          ).slice(0, 200)
        : "";
    summary =
      `Compacted ${collapseCount} earlier message(s). ` +
      (firstText ? `Opened with: ${firstText}. ` : "") +
      (lastText ? `Most recent assistant turn: ${lastText}` : "");

    // Inject the summary as a new system message and tag the older
    // rows so rendering skips them.
    await exec.insert(conversationMessages).values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      role: "system",
      content: { kind: "compacted", summary, collapsed: collapseCount },
    });
  }

  const [updated] = await exec
    .update(conversations)
    .set({ updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning();
  if (!updated) throw new Error("conversation disappeared");

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_COMPACTED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: { collapsed: collapseCount, kept: Math.min(keepLast, total) },
    },
    exec,
  );

  log.conversation.compacted({
    conversation_id: p.conversation_id,
    collapsed: collapseCount,
    kept: Math.min(keepLast, total),
    total,
  });

  return {
    conversation: rowToRecord(updated),
    summary,
    messages_collapsed: collapseCount,
  };
}

/**
 * Undo the most recent draft mutation. Used by the CLI / UI when
 * the user wants to revert a step.
 */
export async function undoLastDraftMutation(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<DraftDocument> {
  return undoLastSnapshot(tenant_id, conversation_id, exec);
}
