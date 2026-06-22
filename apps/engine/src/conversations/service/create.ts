// Create a new conversation row + persist the optional first user
// message. This function STOPS before the model loop — the turn runs
// via `runConversationTurn` (see ./run-turn.ts), called either inline
// by the HTTP/SSE route or in the `conversation.run-turn` pg-boss
// worker for the MCP async-Tasks path.
//
// The mock-provider plan-seeding branch handles canned tests; in
// production it is a no-op because LLM_PROVIDER isn't `mock`.

import { eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { log } from "../../logging/logger.ts";
import { resolveAttachmentSlugsInText } from "../attachments.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { appendMessage } from "../persist.ts";
import { listBaselineSlugs, loadActivationCatalog } from "../skill-autoload.ts";
import type { ConversationRecord } from "../types.ts";
import { normalizePermissionMode, rowToRecord } from "./shared.ts";

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
  /** Client-supplied permission mode — persisted on the draft session. */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
}

export interface CreateConversationResult {
  conversation: ConversationRecord;
  /**
   * The rewritten first user message (attachment slugs resolved). The
   * `conversation_messages` row is already persisted; this value is
   * handed to `runConversationTurn` so the turn does not re-insert it.
   * `null` when the conversation was created without an opening
   * message.
   */
  initial_message: string | null;
  /**
   * The `conversation_messages` row id of the persisted first user
   * message. The MCP async-Tasks handler pins this onto the `mcp_tasks`
   * row so the worker runs the turn on THIS message rather than a
   * later concurrently-appended one. `null` when no opening message.
   */
  initial_message_id: string | null;
  /** Memory payload persisted on the row, if any. */
  user_memory: string | null;
}

/**
 * Insert a conversation row, emit the create audit, seed any canned
 * mock plan, and persist the first user-message row. Does NOT run the
 * model loop — the caller drives the turn via `runConversationTurn`.
 */
export async function createConversation(
  p: CreateConversationParams,
  exec: Db,
): Promise<CreateConversationResult> {
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
      // Seed at last_turn 0 (turn_count defaults to 0; the first turn
      // becomes 1, so baseline skills satisfy the K-turn full-body window
      // immediately).
      loaded_skills: baselineSlugs.map((slug) => ({ slug, last_turn: 0 })),
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

  // Seed the mock provider plan for known canned flows when the initial
  // message matches. In production this is a no-op because `LLM_PROVIDER`
  // isn't `mock` and the canned plan map stays empty. Tests flip the
  // provider to `mock` in setup.
  if (p.initial_message) {
    const msg = p.initial_message;
    // The propose_step-based canned plans model the legacy incremental
    // (repair-stage) flow. Since the Fix-A initial-stage gate made
    // propose_step / update_param repair-stage-only, those fixtures
    // additionally seed minimal preview evidence on the draft so the
    // gate sees a repair-stage session — production is untouched (this
    // whole branch is mock-provider-only).
    let seedRepairStageEvidence = false;
    if (/open.?meteo|berlin.*weather|tomorrow.*forecast/i.test(msg)) {
      const { cannedOpenMeteoBerlinPlan } = await import("../../llm/mock-provider.ts");
      getMockProvider().setConversePlan(row.id, cannedOpenMeteoBerlinPlan());
      seedRepairStageEvidence = true;
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
      seedRepairStageEvidence = true;
    } else if (/workflow.*(github|git\s*hub).*(private|priv)?.*repos?/i.test(msg)) {
      const { cannedListPrivateGithubReposPlan } = await import("../../llm/mock-provider.ts");
      getMockProvider().setConversePlan(
        row.id,
        cannedListPrivateGithubReposPlan(p.connector_id ?? undefined),
      );
      seedRepairStageEvidence = true;
    }
    if (seedRepairStageEvidence && getMockProvider().conversePlans.has(row.id)) {
      await exec
        .update(conversations)
        .set({
          draft: {
            ...initialDraft,
            latest_preview: {
              ok: false,
              step_id: null,
              summary: "stage evidence (canned repair-stage fixture)",
              step_traces: [],
            },
          },
        })
        .where(eq(conversations.id, row.id));
    }
  }

  // Persist the first user-message row before the turn runs. The MCP
  // async-Tasks worker reads it back from the DB; the HTTP/SSE route
  // hands the rewritten text straight to `runConversationTurn`. Both
  // pass `user_message_persisted: true` into `runLoop` so the loop
  // does not double-insert.
  let initialMessage: string | null = null;
  let initialMessageId: string | null = null;
  if (p.initial_message) {
    const rewrite = await resolveAttachmentSlugsInText(p.initial_message, {
      db: exec,
      tenant_id: p.tenant_id,
      conversation_id: row.id,
    });
    initialMessage = rewrite.text;
    initialMessageId = await appendMessage(exec, p.tenant_id, row.id, "user", {
      text: initialMessage,
    });
  }

  return {
    conversation: rowToRecord(row),
    initial_message: initialMessage,
    initial_message_id: initialMessageId,
    user_memory: memory,
  };
}
