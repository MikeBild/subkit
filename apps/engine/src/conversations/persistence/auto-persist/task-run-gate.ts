import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { logger } from "../../../logging/logger.ts";
import { resolveWorkflowByIdOrSlug } from "../../../workflows/lookup.ts";
import { readTaskRunScope } from "../../service/task-run-access.ts";
import {
  APPROVAL_HANDLE_KEY,
  type CommitIntent,
  type CommitIntentKind,
} from "../../tools/ask-user/commit-intent.ts";
import { TASK_RUN_TOOLS, WORKFLOW_TOOL_PREFIX } from "../../tools/authoring-palette.ts";
import type { TaskRunMarker } from "../../types.ts";
import { autoPersistActor, injectAndDispatch, recordGatedCallOutcome } from "./context.ts";
import { readString } from "./helpers.ts";
import type { AutoPersistDispatch, AutoPersistInput } from "./types.ts";

const APPROVAL_BACKED_KINDS: ReadonlySet<CommitIntentKind> = new Set([
  "execute_confirmed_tool_call",
  "grant_relayed_tool_call",
  "commit_held_workflow_writes",
]);

export type TaskRunIntentDecision =
  | { allowed: true; intent: CommitIntent }
  | { allowed: false; reason: string };

function approvalBackedDecision(intent: CommitIntent): TaskRunIntentDecision {
  const tool = readString(intent.payload, "tool");
  const handle = readString(intent.payload, APPROVAL_HANDLE_KEY);
  if (!tool || !handle) return { allowed: false, reason: "approval_handle_missing" };
  const known =
    TASK_RUN_TOOLS.has(tool) || tool.startsWith(WORKFLOW_TOOL_PREFIX) || tool.startsWith("mcp_");
  return known ? { allowed: true, intent } : { allowed: false, reason: "tool_not_in_task_run" };
}

export function decideTaskRunIntent(
  marker: TaskRunMarker,
  intent: CommitIntent,
  workflow_id: string | null,
): TaskRunIntentDecision {
  if (marker.sealed) return { allowed: false, reason: "task_run_sealed" };
  if (APPROVAL_BACKED_KINDS.has(intent.kind)) return approvalBackedDecision(intent);
  if (intent.kind !== "run_workflow") return { allowed: false, reason: "intent_kind_not_allowed" };
  if (!workflow_id || !marker.workflow_ids.includes(workflow_id))
    return { allowed: false, reason: "workflow_not_bound" };
  const { workflow: _reference, ...payload } = intent.payload;
  return {
    allowed: true,
    intent: {
      ...intent,
      payload: { ...payload, workflow_id, environment: marker.environment },
    },
  };
}

export async function gateTaskRunIntent(
  p: AutoPersistInput,
  intent: CommitIntent,
): Promise<{ refused: AutoPersistDispatch } | { intent: CommitIntent }> {
  const scope = await readTaskRunScope(p.db, p.tenant_id, p.conversation_id);
  if (!scope) return { intent };
  const reference =
    readString(intent.payload, "workflow_id") ?? readString(intent.payload, "workflow");
  const resolved =
    intent.kind === "run_workflow" && reference && !scope.marker.sealed
      ? await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, reference, { require_published: true })
      : null;
  const decision = decideTaskRunIntent(scope.marker, intent, resolved?.id ?? null);
  if (decision.allowed) return { intent: decision.intent };
  logger.warn({
    module: "conversation_persistence",
    action: "auto_persist.denied_task_run",
    msg: "commit_intent refused in a task run conversation; nothing was dispatched",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: p.elicitation.id,
    intent_kind: intent.kind,
    reason: decision.reason,
  });
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...autoPersistActor(p),
      action: AuditAction.POLICY_DENIED,
      resource_type: "conversation_elicitation",
      resource_id: p.elicitation.id,
      result: "denied",
      reason: "task_run_commit_intent",
      metadata: {
        conversation_id: p.conversation_id,
        intent_kind: intent.kind,
        cause: decision.reason,
      },
    },
    p.db,
  );
  await recordGatedCallOutcome(p, "error");
  return {
    refused: await injectAndDispatch(
      p,
      {
        tool: p.elicitation.tool_name,
        ok: false,
        error_code: "task_run_commit_intent_refused",
        message: `The confirmed ${intent.kind} was NOT performed: it is outside what this task run may do. Nothing was changed. Do not report success.`,
        next_best_actions: [],
        source: "harness_auto_persist",
      },
      "confirmed",
      { intent },
    ),
  };
}
