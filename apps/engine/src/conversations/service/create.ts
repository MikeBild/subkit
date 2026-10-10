import { eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConnector } from "../../connectors/service.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { getIntakeItem } from "../../knowledge/intake.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { log } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import { getWorkflow } from "../../workflows/service.ts";
import { resolveAttachmentSlugsInText } from "../attachments.ts";
import { createEmptyDraftDocument, withFocusedExecution } from "../authoring-state.ts";
import type { ConversationSurface } from "../lifecycle-view.ts";
import { appendMessage } from "../persist.ts";
import { type ConversationReference, dedupeReferences } from "../references.ts";
import { listBaselineSlugs, loadActivationCatalog } from "../skill-autoload.ts";
import { deriveConversationTitle } from "../title.ts";
import type { ConversationRecord, DraftDocument, LatestExecutionSummary } from "../types.ts";
import { normalizePermissionMode, rowToRecord } from "./shared.ts";

export interface CreateConversationParams {
  tenant_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  connector_id?: string | null;
  workflow_id?: string | null;
  focus_execution?: LatestExecutionSummary | null;
  initial_message?: string;
  references?: ConversationReference[] | null;
  memory?: string | null;
  model?: string | null;
  title?: string | null;
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  origin_client?: string | null;
  surface?: ConversationSurface | null;
  playground?: boolean;
  intake_item_ids?: string[] | null;
}

const PLAYGROUND_PRELOADED_SKILL = "workflow-authoring";

function canonicalLabel(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} _./-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return normalized || fallback;
}

async function canRead(
  p: CreateConversationParams,
  exec: Db,
  permission: string,
  resource: { type: string; id: string },
): Promise<boolean> {
  if (!p.principal) return true;
  return (
    await can(exec, {
      tenant_id: p.tenant_id,
      principal: p.principal,
      permission,
      resource,
    })
  ).allow;
}

async function canonicalReferences(
  p: CreateConversationParams,
  focus: LatestExecutionSummary | null,
  exec: Db,
): Promise<ConversationReference[]> {
  const refs = [...(p.references ?? [])];
  if (p.workflow_id) {
    const workflow = await getWorkflow(p.tenant_id, p.workflow_id, exec);
    if (
      workflow &&
      (await canRead(p, exec, "workflow:read", { type: "workflow", id: workflow.id }))
    )
      refs.push({
        type: "workflow",
        id: workflow.id,
        label: canonicalLabel(workflow.name, "Workflow"),
      });
  }
  if (p.connector_id) {
    const connector = await getConnector(p.tenant_id, p.connector_id, exec);
    if (
      connector &&
      (await canRead(p, exec, "connector:read", { type: "connector", id: connector.id }))
    )
      refs.push({
        type: "connector",
        id: connector.id,
        label: canonicalLabel(connector.display_name, "Connector"),
      });
  }
  if (
    focus &&
    (await canRead(p, exec, "execution:read", { type: "execution", id: focus.execution_id }))
  ) {
    const workflow = focus.workflow_id
      ? await getWorkflow(p.tenant_id, focus.workflow_id, exec)
      : null;
    const workflowLabel = workflow ? canonicalLabel(workflow.name, "Workflow") : "Workflow";
    refs.push({
      type: "execution",
      id: focus.execution_id,
      label: `${workflowLabel} ${focus.status}`,
    });
  }
  for (const id of p.intake_item_ids ?? []) {
    const item = await getIntakeItem(p.tenant_id, id, exec);
    if (item && (await canRead(p, exec, "intake:read", { type: "intake_item", id: item.id })))
      refs.push({
        type: "intake_item",
        id: item.id,
        label: canonicalLabel(item.title, "Collected item"),
      });
  }
  return dedupeReferences(refs);
}

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
  const focus = p.focus_execution ?? null;
  const references = await canonicalReferences(p, focus, exec);
  const initialDraft: DraftDocument = focus
    ? withFocusedExecution(createEmptyDraftDocument(), focus)
    : createEmptyDraftDocument();
  const playground = p.playground === true;
  const targetWorkflowId = playground ? null : (p.workflow_id ?? focus?.workflow_id ?? null);
  if (initialPermissionMode || playground || p.intake_item_ids?.length) {
    initialDraft.session = {
      ...(initialPermissionMode ? { permission_mode: initialPermissionMode } : {}),
      ...(playground ? { playground: true } : {}),
      ...(p.intake_item_ids?.length ? { intake_item_ids: [...new Set(p.intake_item_ids)] } : {}),
      ...(p.intake_item_ids?.length ? { intake_review_locked: true } : {}),
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
      target_workflow_id: targetWorkflowId,
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
    workflow_id: targetWorkflowId,
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
        workflow_id: targetWorkflowId,
        execution_id: focus?.execution_id ?? null,
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
    const persistedReferences = references.length > 0 ? references : null;
    initialMessageId = await appendMessage(exec, p.tenant_id, row.id, "user", {
      text: initialMessage,
      ...(persistedReferences ? { references: persistedReferences } : {}),
    });
    if (row.title === null) {
      row.title = deriveConversationTitle({ text: initialMessage });
    }
  }

  return {
    conversation: rowToRecord(row),
    initial_message: initialMessage,
    initial_message_id: initialMessageId,
    references: references.length > 0 ? references : null,
    user_memory: memory,
  };
}
