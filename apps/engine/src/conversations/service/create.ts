// Create a new conversation row + drive the optional first turn.
//
// The mock-provider plan-seeding branch handles canned tests; in
// production it is a no-op because LLM_PROVIDER isn't `mock`.

import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { log } from "../../logging/logger.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { type RunLoopResult, runLoop } from "../loop.ts";
import { listBaselineSlugs, loadActivationCatalog } from "../skill-autoload.ts";
import type { ConversationRecord } from "../types.ts";
import { getConversation } from "./get.ts";
import { type ConversationTurnOutcome, normalizePermissionMode, rowToRecord } from "./shared.ts";

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
  /**
   * Pre-registered AbortController for the initial turn's runLoop.
   *
   * Optional because the route handler does NOT know `conversation_id`
   * before this function inserts the row — there is no synchronous-
   * accept frame at the route layer that can register a controller
   * keyed on (tenant, conv) the way `messages.ts` does. When the
   * caller omits this, `createConversation` registers internally
   * directly after the row insert (still synchronous from the runLoop
   * call's perspective) and unregisters in a `finally`. When the
   * caller supplies one, lifetime ownership stays with the caller.
   *
   * Per #148: every `runLoop` call site threads a controller; the
   * fallback that previously lived inside `runLoop` was retired.
   */
  turn_abort_ctrl?: AbortController;
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
  // Seed every conversation with the baseline skills (those with a
  // `kind:"baseline"` activation rule) so the LLM has the core mental
  // model on turn one. Per-tool autoload appends domain-specific
  // skills as the conversation evolves.
  const catalog = await loadActivationCatalog(p.tenant_id, exec);
  const baselineSlugs = listBaselineSlugs(catalog);
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: p.connector_id ?? null,
      target_workflow_id: p.workflow_id ?? null,
      status: "active",
      draft: initialDraft,
      owner_id: p.actor_id ?? null,
      loaded_skills: baselineSlugs,
      ...(p.model ? { model: p.model } : {}),
      ...(p.title ? { title: p.title } : {}),
      ...(memory ? { memory } : {}),
    })
    .returning();
  assertInsertRow(row, "conversations");

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
      const { cannedOpenMeteoBerlinPlan } = await import("../../llm/mock-provider.ts");
      getMockProvider().setConversePlan(row.id, cannedOpenMeteoBerlinPlan());
    } else if (
      /subkit engine onboarding|guided connector workflow|connect the subkit engine/i.test(msg)
    ) {
      const { cannedConnectorWorkflowPlan } = await import("../../llm/mock-provider.ts");
      const { getConfig } = await import("../../config/loader.ts");
      const baseUrl = getConfig().server.public_base_url || "http://127.0.0.1:8080";
      getMockProvider().setConversePlan(row.id, cannedConnectorWorkflowPlan(baseUrl));
    } else if (/list.*users/i.test(msg)) {
      const { cannedListUsersPlan } = await import("../../llm/mock-provider.ts");
      getMockProvider().setConversePlan(row.id, cannedListUsersPlan(p.connector_id ?? undefined));
    }
  }

  // #148: every runLoop call site threads a controller. Caller may
  // supply one (rare, since they didn't have `row.id` until just now);
  // otherwise we register here, immediately after the row insert that
  // produced the conversation_id, and unregister in `finally`.
  const ownsAbortRegistration = p.turn_abort_ctrl == null;
  const turnAbortCtrl = p.turn_abort_ctrl ?? registerConversationAbort(p.tenant_id, row.id);
  let result: RunLoopResult;
  try {
    result = p.initial_message
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
          turn_abort_ctrl: turnAbortCtrl,
          ...(p.onEvent ? { onEvent: p.onEvent } : {}),
          ...(p.runtime_context ? { runtime_context: p.runtime_context } : {}),
          ...(initialPermissionMode ? { permission_mode: initialPermissionMode } : {}),
        })
      : { events: [], status: "active" as const };
  } finally {
    if (ownsAbortRegistration) {
      unregisterConversationAbort(p.tenant_id, row.id, turnAbortCtrl);
    }
  }

  // Re-load so status reflects any loop side-effects.
  const updated = await getConversation(p.tenant_id, row.id, exec);
  if (!updated) throw new Error("conversation disappeared");
  return { conversation: updated.conversation, result };
}
