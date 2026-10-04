import { eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { log } from "../../logging/logger.ts";
import { resolveAttachmentSlugsInText } from "../attachments.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import type { ConversationSurface } from "../lifecycle-view.ts";
import { appendMessage } from "../persist.ts";
import type { ConversationReference } from "../references.ts";
import { listBaselineSlugs, loadActivationCatalog } from "../skill-autoload.ts";
import { deriveConversationTitle } from "../title.ts";
import type { ConversationRecord } from "../types.ts";
import { normalizePermissionMode, rowToRecord } from "./shared.ts";

export interface CreateConversationParams {
  tenant_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  connector_id?: string | null;
  workflow_id?: string | null;
  initial_message?: string;
  references?: ConversationReference[] | null;
  memory?: string | null;
  model?: string | null;
  title?: string | null;
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  origin_client?: string | null;
  surface?: ConversationSurface | null;
  playground?: boolean;
}

const PLAYGROUND_PRELOADED_SKILL = "workflow-authoring";

export interface CreateConversationResult {
  conversation: ConversationRecord;
  initial_message: string | null;
  initial_message_id: string | null;
  references: ConversationReference[] | null;
  user_memory: string | null;
}

export async function createConversation(
  p: CreateConversationParams,
  exec: Db,
): Promise<CreateConversationResult> {
  const memory = typeof p.memory === "string" ? p.memory : null;
  const initialPermissionMode = normalizePermissionMode(p.permission_mode) ?? "auto";
  const initialDraft = createEmptyDraftDocument();
  const playground = p.playground === true;
  if (initialPermissionMode || playground) {
    initialDraft.session = {
      ...(initialPermissionMode ? { permission_mode: initialPermissionMode } : {}),
      ...(playground ? { playground: true } : {}),
    };
  }
  const catalog = await loadActivationCatalog(p.tenant_id, exec);
  const baselineSlugs = listBaselineSlugs(catalog);
  const seedSlugs = playground
    ? [...new Set([...baselineSlugs, PLAYGROUND_PRELOADED_SKILL])]
    : baselineSlugs;
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: p.connector_id ?? null,
      target_workflow_id: playground ? null : (p.workflow_id ?? null),
      status: "active",
      draft: initialDraft,
      owner_id: p.actor_id ?? null,
      origin_client: p.origin_client ?? null,
      surface: p.surface ?? null,
      title_locked: typeof p.title === "string" && p.title.trim().length > 0,
      loaded_skills: seedSlugs.map((slug) => ({ slug, last_turn: 0 })),
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
        workflow_id: playground ? null : (p.workflow_id ?? null),
        owner_id: p.actor_id ?? null,
        model: p.model ?? null,
        title: p.title ?? null,
        memory_included: Boolean(memory),
        playground,
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

  if (p.initial_message) {
    const msg = p.initial_message;
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

  let initialMessage: string | null = null;
  let initialMessageId: string | null = null;
  if (p.initial_message) {
    const rewrite = await resolveAttachmentSlugsInText(p.initial_message, {
      db: exec,
      tenant_id: p.tenant_id,
      conversation_id: row.id,
      ...(p.principal !== undefined ? { principal: p.principal } : {}),
    });
    initialMessage = rewrite.text;
    const references = p.references && p.references.length > 0 ? p.references : null;
    initialMessageId = await appendMessage(exec, p.tenant_id, row.id, "user", {
      text: initialMessage,
      ...(references ? { references } : {}),
    });
    if (row.title === null) {
      row.title = deriveConversationTitle({ text: initialMessage });
    }
  }

  return {
    conversation: rowToRecord(row),
    initial_message: initialMessage,
    initial_message_id: initialMessageId,
    references: p.references && p.references.length > 0 ? p.references : null,
    user_memory: memory,
  };
}
