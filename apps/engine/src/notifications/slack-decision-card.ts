import {
  absoluteLink,
  heldTaskRun,
  type PendingDecisionCard,
  pendingDecisionBlocks,
  type SlackBlock,
  safeCockpitPath,
  slackDecisionText,
  tenantLanguage,
} from "../chat/index.ts";
import { getConfig } from "../config/index.ts";
import type { Db } from "../db/index.ts";
import type { SlackDecisionCopy } from "../http/index.ts";
import type { NotificationEvent } from "./matcher.ts";

const CARD_EVENTS = new Set([
  "task_run.waiting",
  "task_run.result_ready",
  "workflow.approval_expiring",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function field(payload: NotificationEvent["payload"], key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

function remedyPath(payload: NotificationEvent["payload"]): string | null {
  const remedy = payload?.remedy;
  if (!remedy || typeof remedy !== "object") return null;
  return safeCockpitPath((remedy as { href?: unknown }).href);
}

function configuredBaseUrl(): string {
  try {
    return getConfig().server.public_base_url ?? "";
  } catch {
    return "";
  }
}

type CardFacts = Omit<PendingDecisionCard, "copy" | "link">;

async function cardFacts(
  db: Db,
  event: NotificationEvent,
  copy: SlackDecisionCopy,
): Promise<CardFacts | null> {
  const payload = event.payload ?? null;
  const taskRunId = field(payload, "task_run_id");
  if (event.type === "task_run.waiting" && field(payload, "waiting_reason") === "approval") {
    if (!taskRunId || !UUID.test(taskRunId)) return null;
    const held = await heldTaskRun(db, event.tenant_id, taskRunId);
    if (!held) return null;
    const cockpit_path = `/cockpit/tasks/${held.task_id}`;
    if (!held.approval)
      return {
        title: copy.heldRunTitle(held.task_name),
        detail: null,
        kind: "task_run",
        subject_id: taskRunId,
        decidable: false,
        cockpit_path,
      };
    return {
      title: copy.heldRunTitle(held.task_name),
      detail: copy.heldRunDetail(held.approval.tool),
      kind: "tool_approval",
      subject_id: held.approval.id,
      decidable: true,
      cockpit_path,
    };
  }
  if (event.type === "task_run.result_ready" && taskRunId && UUID.test(taskRunId)) {
    const held = await heldTaskRun(db, event.tenant_id, taskRunId);
    return {
      title: copy.resultReadyTitle(held?.task_name ?? null),
      detail: null,
      kind: "task_run",
      subject_id: taskRunId,
      decidable: false,
      cockpit_path: held ? `/cockpit/tasks/${held.task_id}` : null,
    };
  }
  if (event.type === "workflow.approval_expiring") {
    const workflowId = field(payload, "workflow_id");
    if (!workflowId || !UUID.test(workflowId)) return null;
    return {
      title: copy.workflowApprovalTitle(field(payload, "workflow_name")),
      detail: null,
      kind: "workflow",
      subject_id: workflowId,
      decidable: false,
      cockpit_path: remedyPath(payload) ?? `/cockpit/workflows/${workflowId}`,
    };
  }
  return null;
}

export async function slackDecisionBlocks(
  db: Db,
  event: NotificationEvent,
  publicBaseUrl: string = configuredBaseUrl(),
): Promise<SlackBlock[] | null> {
  if (!CARD_EVENTS.has(event.type)) return null;
  const copy = await slackDecisionText(await tenantLanguage(db, event.tenant_id));
  const facts = await cardFacts(db, event, copy);
  if (!facts) return null;
  return pendingDecisionBlocks({
    ...facts,
    copy,
    link: absoluteLink(publicBaseUrl, facts.cockpit_path),
  });
}
