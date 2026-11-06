import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import {
  conversationToolCalls,
  executionSteps,
  executions,
  workflows,
} from "../db/schema/index.ts";
import type { ExecutionMode } from "../execution/types.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../execution/types.ts";
import {
  authorizeWorkflowRun,
  completedRun,
  createRunWorkflow,
  type RunGrant,
} from "../execution/use-cases/run-workflow.ts";
import { logger } from "../logging/logger.ts";
import { recordConversationToolCall } from "../observability/instrumentation.ts";
import { can } from "../rbac/evaluator.ts";
import {
  approvalAuditResource,
  consumeApproval,
  grantApproval,
  recordApprovalApproved,
  recordApprovalUnfulfilled,
} from "../tools/approval.ts";
import { confirmEnvelopeFor } from "../tools/policy.ts";
import type { ToolSurface } from "../tools/types.ts";
import { workflowExecutionEnvironment } from "../workflows/execution-environment.ts";
import { resolveWorkflowInputContract } from "../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../workflows/lookup.ts";
import { getWorkflow } from "../workflows/service.ts";
import type { AnswerActor } from "./answer-actor.ts";
import { runConfirmGate } from "./confirmation.ts";
import {
  type RenderPayload,
  type ReplyLanguage,
  renderConnectorsList,
  renderExecutionsList,
  renderKnowledgeSourcesList,
  renderSchedulesList,
  renderWorkflowCategoryList,
  renderWorkflowsList,
} from "./fast-path-lists.ts";
import { renderRunOutput } from "./fast-path-render.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "./persistence/index.ts";
import type { ToolCallOutcome } from "./tools/result-payload.ts";
import { prepareGate } from "./tools/sdk-wrap/gate-subjects.ts";
import type { ConversationStatus, TurnEvent } from "./types.ts";

export type FastPathStatus = "active" | "awaiting_input";

export interface FastPathHit {
  status: ConversationStatus;
  events: TurnEvent[];
  pending_elicitation_id?: string;
  fast_path_tool: string;
  assistant_text: string | null;
}

export interface FastPathParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal: ResolvedPrincipal;
  user_message: string;
  answer_actor: AnswerActor;
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
}

const AFFIRM_RESUME_WINDOW_MS = 5 * 60 * 1000;

import { AFFIRM_RE, INSPECT_EXEC_RE, RUN_VERB_RE } from "./intent-patterns.ts";

export { RUN_VERB_RE };

const LIST_RES = {
  workflows: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:saved\s+|gespeicherte[nr]?\s+)?workflows?\s*\??$/i,
  ],
  connectors: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?connectors?\s*\??$/i,
  ],
  executions: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:die\s+|recent\s+|letzte[nr]?\s+|my\s+|meine\s+)?executions?\s*\??$/i,
  ],
  schedules: [
    /^(?:list|show|display|zeige|welche|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:active\s+|aktive[nr]?\s+)?schedules?\s*\??$/i,
  ],
  knowledge_sources: [
    /^(?:list|show|display|zeige|welche|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:knowledge[\s-]?sources?|wissensquellen)\s*\??$/i,
  ],
} as const;

export function matchListIntent(text: string): keyof typeof LIST_RES | null {
  for (const kind of Object.keys(LIST_RES) as Array<keyof typeof LIST_RES>) {
    if (LIST_RES[kind].some((re) => re.test(text))) return kind;
  }
  return null;
}

const CATALOG_NOUN_RES: Array<[keyof typeof LIST_RES, RegExp]> = [
  ["workflows", /\bworkflows?\b/i],
  ["connectors", /\bconnectors?\b/i],
  ["executions", /\b(?:executions?|runs?)\b/i],
  ["schedules", /\bschedules?\b/i],
  ["knowledge_sources", /\b(?:knowledge[\s-]?sources?|knowledges?|wissensquellen)\b/i],
];

const MULTI_CATALOG_RE =
  /^(?:list|show|display|view|get|zeige|liste|welche)\s+(?:my|all|the|our|meine|alle|unsere|and|und|sowie|plus|also|,|&|\+|\s|workflows?|connectors?|executions?|runs?|schedules?|knowledge[\s-]?sources?|knowledges?|wissensquellen)+\s*\??$/i;

function matchMultiCatalog(text: string): Array<keyof typeof LIST_RES> | null {
  if (!MULTI_CATALOG_RE.test(text)) return null;
  const kinds: Array<keyof typeof LIST_RES> = [];
  for (const [kind, re] of CATALOG_NOUN_RES) {
    if (re.test(text) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length >= 2 ? kinds : null;
}

function rendererFor(kind: keyof typeof LIST_RES): (p: FastPathParams) => Promise<RenderPayload> {
  switch (kind) {
    case "workflows":
      return renderWorkflowsList;
    case "connectors":
      return renderConnectorsList;
    case "executions":
      return renderExecutionsList;
    case "schedules":
      return renderSchedulesList;
    case "knowledge_sources":
      return renderKnowledgeSourcesList;
  }
}

const CATEGORY_TOKEN = String.raw`(?:@(?:kategorie|category)\/)?([a-z0-9][a-z0-9_-]*?)`;
const WHAT_THEY_DO = String.raw`(?:\s*,?\s+(?:und\s+was\s+sie\s+tun|and\s+what\s+they\s+do))?`;
const END = String.raw`\s*[?.!]?$`;
const CATEGORY_LIST_RES = [
  new RegExp(
    String.raw`^(?:zeige?|show|list)\s+(?:mir\s+|me\s+)?(?:die\s+|alle\s+|the\s+|all\s+)?${CATEGORY_TOKEN}[-\s]workflows?${WHAT_THEY_DO}${END}`,
    "i",
  ),
  new RegExp(
    String.raw`^(?:(?:zeige?|show|list)\s+(?:mir\s+|me\s+)?)?(?:die\s+|alle\s+|the\s+|all\s+)?workflows?\s+(?:in|aus)\s+(?:der\s+kategorie\s+|the\s+category\s+|category\s+)?${CATEGORY_TOKEN}${WHAT_THEY_DO}${END}`,
    "i",
  ),
];

const GERMAN_CATEGORY_LIST_RE =
  /(?:^|\s)(?:zeige?|mir|die|alle|aus|der\s+kategorie|und\s+was\s+sie\s+tun)(?=\s|$)|@kategorie\//i;

export function categoryListLanguage(text: string): ReplyLanguage {
  return GERMAN_CATEGORY_LIST_RE.test(text) ? "de" : "en";
}

export function matchCategoryListIntent(text: string): string | null {
  for (const re of CATEGORY_LIST_RES) {
    const m = text.match(re);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}

function listToolFor(kind: keyof typeof LIST_RES): string {
  return kind === "knowledge_sources" ? "list_knowledge_sources" : `list_${kind}`;
}

const READ_PERMISSION_BY_LIST: Record<keyof typeof LIST_RES, string> = {
  workflows: "workflow:read",
  connectors: "connector:read",
  executions: "execution:read",
  schedules: "schedule:read",
  knowledge_sources: "knowledge:read",
};

async function renderInspectExecution(
  p: FastPathParams,
  execution_id: string,
): Promise<RenderPayload> {
  const execRows = await p.db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      status: executions.status,
      started_at: executions.started_at,
      finished_at: executions.finished_at,
      source_kind: executions.source_kind,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, p.tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  const exec = execRows[0];
  if (!exec) {
    return {
      ok: false,
      reply: `No execution found with id ${execution_id}.`,
      data: { error: "execution_not_found", execution_id },
    };
  }
  const stepRows = await p.db
    .select({
      step_key: executionSteps.step_key,
      kind: executionSteps.kind,
      status: executionSteps.status,
      duration_ms: executionSteps.duration_ms,
    })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, p.tenant_id), eq(executionSteps.execution_id, execution_id)),
    )
    .orderBy(asc(executionSteps.started_at));
  const stepLines = stepRows.map(
    (s) =>
      `- ${s.step_key} (${s.kind}) ${s.status}${s.duration_ms != null ? ` · ${s.duration_ms}ms` : ""}`,
  );
  return {
    ok: exec.status === "succeeded",
    reply: `Execution ${exec.id.slice(0, 8)} — ${exec.status}\n${stepLines.join("\n") || "(no steps)"}`,
    data: {
      execution: exec,
      steps: stepRows,
    },
  };
}

async function persistFastPathTurn(
  p: FastPathParams,
  tool: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  reply: string,
  outcome: ToolCallOutcome,
  confirmation_data?: Record<string, unknown>,
): Promise<{ events: TurnEvent[]; assistant_message_id: string; tool_call_id: string }> {
  await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", { tool, output });
  const assistantMessageId = await appendMessage(
    p.db,
    p.tenant_id,
    p.conversation_id,
    "assistant",
    { text: reply, fast_path: true },
  );
  const toolCallId = await insertToolCall(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    parent_message_id: assistantMessageId,
    tool,
    input,
    approval_required: false,
    ...(confirmation_data ? { confirmation_data } : {}),
  });
  await updateToolCallOutput(p.db, toolCallId, output, outcome);
  const events: TurnEvent[] = [
    {
      type: "tool_call_start",
      call_id: toolCallId,
      tool,
      input_partial: input,
      parent_message_id: assistantMessageId,
    },
    {
      type: "tool_call_end",
      call_id: toolCallId,
      input,
      parent_message_id: assistantMessageId,
    },
    {
      type: "tool_result",
      call_id: toolCallId,
      tool,
      output,
      parent_message_id: assistantMessageId,
    },
    {
      type: "message",
      role: "assistant",
      content: reply,
      id: assistantMessageId,
    },
  ];
  return { events, assistant_message_id: assistantMessageId, tool_call_id: toolCallId };
}

async function auditPolicyDenied(
  p: FastPathParams,
  permission: string,
  tool: string,
  reason: string,
  resource?: { type: string; id: string },
): Promise<void> {
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.principal.kind,
      actor_id: p.principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: resource?.type ?? "conversation",
      resource_id: resource?.id ?? p.conversation_id,
      result: "denied",
      reason,
      metadata: {
        tool,
        via: "fast_path",
        provider: p.principal.provider,
        permission,
      },
    },
    p.db,
  );
}

async function fastPathEnvironment(
  p: FastPathParams,
  workflow_id: string,
): Promise<ExecutionMode | null> {
  try {
    return await workflowExecutionEnvironment(p.db, p.tenant_id, workflow_id);
  } catch (error) {
    if ((error as { code?: unknown }).code === "workflow_environment_ambiguous") return null;
    throw error;
  }
}

interface RunFastPathResolution {
  workflow: { id: string; slug: string; name: string; current_version_id: string | null };
}

async function executeRunWorkflow(
  p: FastPathParams,
  resolution: RunFastPathResolution,
  input: unknown,
  grant: RunGrant,
  environment: ExecutionMode,
): Promise<RenderPayload & { outcome: ToolCallOutcome }> {
  if (p.actor_id === null) {
    logger.warn({
      module: "conversation",
      action: "fast_path.actor_id_missing",
      msg: "fast-path executeRunWorkflow invoked with actor_id=null — audit row will fall back to actor_type=system",
      tenant_id: p.tenant_id,
      principal_id: p.principal.id,
    });
  }
  const wf = resolution.workflow;
  try {
    const { admitted, result } = completedRun(
      await createRunWorkflow({ db: p.db }).runWorkflow({
        principal: p.principal,
        workflow_id: wf.id,
        workflow_version_id: wf.current_version_id ?? undefined,
        execution_environment: environment,
        request_source: "chat",
        input: input ?? null,
        authorization: { kind: "granted", workflow_permission: grant.workflow_permission },
        audit_extra: { via: "fast_path" },
        dispatch: { mode: "inline", trace_id: null },
      }),
    );
    const heldPreview = result.warnings?.find(
      (warning) => warning.code === HELD_PREVIEW_WARNING_CODE,
    );
    const ok = result.status === "succeeded" && !heldPreview;
    const warningCount = result.warnings?.length ?? 0;
    const warningLine =
      warningCount > 0
        ? `${warningCount} warning(s): ${Array.from(
            new Set((result.warnings ?? []).map((w) => w.code)),
          )
            .sort()
            .join(", ")}`
        : null;

    let reply: string;
    if (heldPreview) {
      const german = /^(?:starte|f[uü]hre|ja|jo|los|bestätigt)\b/i.test(p.user_message.trim());
      reply = german
        ? `Vorschau für ${wf.slug}: Es wurde nichts geschrieben. Prüfe vor einem Live-Lauf die Ausführungsfreigabe des Workflows.`
        : `Preview of ${wf.slug}: Nothing was written. Review the workflow's execution authority before a live run.`;
    } else if (ok) {
      const rendered = renderRunOutput(result.output);
      reply = rendered ?? `Ran ${wf.slug}: succeeded`;
      if (warningLine) reply += `\n\n${warningLine}`;
    } else {
      const stepLines = result.steps.map(
        (s) =>
          `- ${s.step_key} (${s.kind}) ${s.status}${s.duration_ms != null ? ` · ${s.duration_ms}ms` : ""}`,
      );
      const parts = [`Ran ${wf.slug}: ${result.status}`, ...stepLines];
      if (warningLine) parts.push(warningLine);
      reply = parts.join("\n");
    }
    return {
      ok,
      outcome: result.status === "succeeded" ? "ok" : "error",
      reply,
      data: {
        status: result.status,
        execution_id: result.execution_id,
        workflow_id: wf.id,
        workflow_slug: wf.slug,
        workflow_version_id: admitted.workflow_version_id,
        execution_authority_id: admitted.execution_authority_id,
        hold_writes: admitted.hold_writes,
        ...(heldPreview ? { preview: true, writes_held: true } : {}),
        output: result.output,
        warnings: result.warnings ?? [],
        suggested_command: `/workflows run ${wf.slug}`,
        next_best_actions:
          result.status === "succeeded"
            ? ["inspect_execution_step", "run_workflow"]
            : ["diagnose_latest_execution", "inspect_workflow"],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      outcome: "error",
      reply: `Run of ${wf.slug} failed: ${msg}`,
      data: { status: "failed", workflow_id: wf.id, error: msg },
    };
  }
}

async function denyCatalogRead(
  p: FastPathParams,
  permission: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<FastPathHit | null> {
  const decision = await can(p.db, { tenant_id: p.tenant_id, principal: p.principal, permission });
  if (decision.allow) return null;
  const reason = decision.reason ?? "permission_denied";
  await auditPolicyDenied(p, permission, tool, reason);
  const reply = `Permission denied: ${permission}.`;
  const persisted = await persistFastPathTurn(
    p,
    tool,
    input,
    { ok: false, denied: true, permission, reason, skipped_llm: true },
    reply,
    "denied",
  );
  recordConversationToolCall({ category: "tenant_read", tool, outcome: "denied", duration_ms: 0 });
  return {
    status: "active",
    events: persisted.events,
    fast_path_tool: tool,
    assistant_text: reply,
  };
}

async function answerCatalogRead(
  p: FastPathParams,
  tool: string,
  input: Record<string, unknown>,
  payload: RenderPayload,
): Promise<FastPathHit> {
  const outcome = payload.ok ? "ok" : "error";
  const persisted = await persistFastPathTurn(
    p,
    tool,
    input,
    { ok: payload.ok, ...payload.data, skipped_llm: true },
    payload.reply,
    outcome,
  );
  recordConversationToolCall({ category: "tenant_read", tool, outcome, duration_ms: 0 });
  logger.info({
    module: "conversation",
    action: "conversation.fast_path",
    msg: "fast-path handled list intent",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    tool,
    ...input,
  });
  return {
    status: "active",
    events: persisted.events,
    fast_path_tool: tool,
    assistant_text: payload.reply,
  };
}

export async function tryFastPath(p: FastPathParams): Promise<FastPathHit | null> {
  const text = p.user_message.trim();
  if (text.length === 0) return null;
  const gateSurface: ToolSurface = p.surface === "mcp" ? "mcp" : "chat";

  const listKind = matchListIntent(text);
  if (listKind) {
    const tool = listToolFor(listKind);
    const denied = await denyCatalogRead(p, READ_PERMISSION_BY_LIST[listKind], tool, {});
    if (denied) return denied;
    return answerCatalogRead(p, tool, {}, await rendererFor(listKind)(p));
  }

  const categoryCandidate = matchCategoryListIntent(text);
  if (categoryCandidate) {
    const [known] = await p.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, p.tenant_id),
          isNull(workflows.deleted_at),
          eq(workflows.category, categoryCandidate),
        ),
      )
      .limit(1);
    if (known) {
      const input = { category: categoryCandidate };
      const denied = await denyCatalogRead(p, "workflow:read", "list_workflows", input);
      if (denied) return denied;
      const payload = await renderWorkflowCategoryList(
        p,
        categoryCandidate,
        categoryListLanguage(text),
      );
      if (payload) return answerCatalogRead(p, "list_workflows", input, payload);
    }
  }

  const multiKinds = matchMultiCatalog(text);
  if (multiKinds) {
    const sections: string[] = [];
    const dataByKind: Record<string, unknown> = {};
    let anyOk = false;
    for (const kind of multiKinds) {
      const permission = READ_PERMISSION_BY_LIST[kind];
      const decision = await can(p.db, {
        tenant_id: p.tenant_id,
        principal: p.principal,
        permission,
      });
      if (!decision.allow) {
        const reason = decision.reason ?? "permission_denied";
        await auditPolicyDenied(p, permission, listToolFor(kind), reason);
        sections.push(`Permission denied: ${permission}.`);
        dataByKind[kind] = { ok: false, denied: true, permission, reason };
        continue;
      }
      const payload = await rendererFor(kind)(p);
      sections.push(payload.reply);
      dataByKind[kind] = { ok: payload.ok, ...payload.data };
      anyOk = anyOk || payload.ok;
    }
    const reply = sections.join("\n\n");
    const persisted = await persistFastPathTurn(
      p,
      "list_catalogs",
      { catalogs: multiKinds },
      { ok: anyOk, catalogs: dataByKind, skipped_llm: true },
      reply,
      anyOk ? "ok" : "error",
    );
    recordConversationToolCall({
      category: "tenant_read",
      tool: "list_catalogs",
      outcome: anyOk ? "ok" : "error",
      duration_ms: 0,
    });
    logger.info({
      module: "conversation",
      action: "conversation.fast_path",
      msg: "fast-path handled multi-catalog list intent",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      catalogs: multiKinds,
    });
    return {
      status: "active",
      events: persisted.events,
      fast_path_tool: "list_catalogs",
      assistant_text: reply,
    };
  }

  const inspectMatch = text.match(INSPECT_EXEC_RE);
  if (inspectMatch) {
    const execId = inspectMatch[2];
    if (execId) {
      {
        const decision = await can(p.db, {
          tenant_id: p.tenant_id,
          principal: p.principal,
          permission: "execution:read",
          resource: { type: "execution", id: execId },
        });
        if (!decision.allow) {
          const reason = decision.reason ?? "permission_denied";
          await auditPolicyDenied(p, "execution:read", "inspect_execution", reason, {
            type: "execution",
            id: execId,
          });
          const reply = `Permission denied: execution:read.`;
          const persisted = await persistFastPathTurn(
            p,
            "inspect_execution",
            { execution_id: execId },
            {
              ok: false,
              denied: true,
              permission: "execution:read",
              reason,
              skipped_llm: true,
            },
            reply,
            "denied",
          );
          recordConversationToolCall({
            category: "tenant_read",
            tool: "inspect_execution",
            outcome: "denied",
            duration_ms: 0,
          });
          return {
            status: "active",
            events: persisted.events,
            fast_path_tool: "inspect_execution",
            assistant_text: reply,
          };
        }
      }
      const payload = await renderInspectExecution(p, execId);
      const persisted = await persistFastPathTurn(
        p,
        "inspect_execution",
        { execution_id: execId },
        { ok: payload.ok, ...payload.data, skipped_llm: true },
        payload.reply,
        payload.ok ? "ok" : "error",
      );
      recordConversationToolCall({
        category: "tenant_read",
        tool: "inspect_execution",
        outcome: payload.ok ? "ok" : "error",
        duration_ms: 0,
      });
      return {
        status: "active",
        events: persisted.events,
        fast_path_tool: "inspect_execution",
        assistant_text: payload.reply,
      };
    }
  }

  const runMatch = text.match(RUN_VERB_RE);
  if (runMatch) {
    const slugOrId = runMatch[2];
    if (slugOrId) {
      const resolved = await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, slugOrId, {
        require_published: true,
      });
      if (!resolved?.current_version_id) {
        return null;
      }
      const wfView = await getWorkflow(p.tenant_id, resolved.id, p.db);
      if (wfView && resolveWorkflowInputContract(wfView.definition) !== null) {
        logger.info({
          module: "conversation",
          action: "fast_path.deferred_input_required",
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          workflow_id: resolved.id,
        });
        return null;
      }
      const environment = await fastPathEnvironment(p, resolved.id);
      if (!environment) return null;
      const grant = await authorizeWorkflowRun(
        {
          principal: p.principal,
          workflow_id: resolved.id,
          workflow_slug: resolved.slug,
          via: "fast_path",
          tool: "run_workflow",
        },
        { db: p.db },
      );
      if (grant.kind === "rejected") {
        const reply = `Permission denied: ${grant.message}.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          { workflow: resolved.slug, environment },
          {
            ok: false,
            denied: true,
            permission: "workflow:run",
            reason: grant.reason,
            error: grant.message,
            skipped_llm: true,
          },
          reply,
          "denied",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "denied",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      const runArgs = { workflow: resolved.slug, environment };
      const gate = await runConfirmGate({
        tool: "run_workflow",
        category: "tenant_write",
        surface: gateSurface,
        args: runArgs,
        db: p.db,
        tenant_id: p.tenant_id,
        principal: p.principal,
        approval_tool: "run_workflow",
        via: "fast_path",
        record_surface: p.surface ?? "api",
        conversation_id: p.conversation_id,
        actor_id: p.actor_id,
        execution_mode: environment,
        precheck: null,
        pause_blocked: false,
        confirmation_kind: null,
        environment,
      });
      if (gate.kind === "approval_failed") throw gate.error;
      if (gate.kind === "needs_confirm") {
        if (gate.approval_id === null) {
          throw new Error(
            "fast path paused a run without an approval although its principal is known",
          );
        }
        const confirm_id = gate.approval_id;
        const prepared = await prepareGate("run_workflow", runArgs, p.tenant_id, p.db);
        const envelope = confirmEnvelopeFor({
          tool: "run_workflow",
          pending_output: prepared.pending_output,
          rule: gate.rule,
          approval_id: confirm_id,
          approval_url: gate.approval_url,
          surface: gateSurface,
        });
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          runArgs,
          {
            ok: false,
            pending: true,
            status: "awaiting_confirmation",
            policy_mode: "confirm_before_execution",
            confirm_required: true,
            pending_output: envelope.pending_output,
            resume: `A person must approve this by replying "yes" here — the engine replays the arguments it already holds. Nothing runs until they do; you cannot approve on their behalf.`,
            skipped_llm: true,
            suggested_command: `/workflows run ${resolved.slug}`,
          },
          `Confirm: run ${resolved.slug} in ${environment}?`,
          "pending",
          { approval_id: confirm_id },
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "pending",
          duration_ms: 0,
        });
        return {
          status: "awaiting_input",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: `Confirm: run ${resolved.slug} in ${environment}?`,
        };
      }
      if (gate.kind !== "proceed") {
        throw new Error(`fast path cannot shape a ${gate.kind} confirm gate outcome`);
      }
      const payload = await executeRunWorkflow(p, { workflow: resolved }, null, grant, environment);
      const persisted = await persistFastPathTurn(
        p,
        "run_workflow",
        { workflow: resolved.slug, environment },
        { ok: payload.ok, ...payload.data, skipped_llm: true },
        payload.reply,
        payload.outcome,
      );
      recordConversationToolCall({
        category: "tenant_write",
        tool: "run_workflow",
        outcome: payload.outcome,
        duration_ms: 0,
      });
      logger.info({
        module: "conversation",
        action: "conversation.fast_path",
        msg: "fast-path executed run_workflow",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        workflow_id: resolved.id,
        slug: resolved.slug,
      });
      return {
        status: "active",
        events: persisted.events,
        fast_path_tool: "run_workflow",
        assistant_text: payload.reply,
      };
    }
  }

  if (AFFIRM_RE.test(text)) {
    const recent = await p.db
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
        output: conversationToolCalls.output,
        confirmation_data: conversationToolCalls.confirmation_data,
        created_at: conversationToolCalls.created_at,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          eq(conversationToolCalls.conversation_id, p.conversation_id),
          eq(conversationToolCalls.tool, "run_workflow"),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(1);
    const head = recent[0];
    const headOutput = head?.output as { pending?: unknown } | null;
    const headConfirmation = head?.confirmation_data as { approval_id?: unknown } | null;
    const approvalId =
      typeof headConfirmation?.approval_id === "string" ? headConfirmation.approval_id : null;
    if (
      head &&
      headOutput?.pending === true &&
      approvalId !== null &&
      Date.now() - (head.created_at?.getTime() ?? 0) < AFFIRM_RESUME_WINDOW_MS
    ) {
      if (p.answer_actor.kind === "human") {
        const granted = await grantApproval({
          db: p.db,
          approval_id: approvalId,
          tenant_id: p.tenant_id,
          granted_by_user_id: p.answer_actor.user_id,
          via: p.answer_actor.via,
        });
        if (!granted.ok) {
          logger.warn({
            module: "conversation",
            action: "fast_path.approval_grant_missed",
            msg: "a person affirmed the fast-path run but the grant did not land; the claim decides the outcome",
            tenant_id: p.tenant_id,
            conversation_id: p.conversation_id,
            approval_id: approvalId,
            user_id: p.answer_actor.user_id,
            error_code: granted.code,
          });
        }
      } else {
        logger.warn({
          module: "conversation",
          action: "fast_path.affirmation_not_human",
          msg: "a non-human actor affirmed a held fast-path run; nothing was granted and the claim will refuse unless a person granted it in the approval portal",
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          relay_reason: p.answer_actor.reason,
        });
      }
      const claim = await consumeApproval({
        db: p.db,
        principal: p.principal,
        approval_id: approvalId,
        tool: "run_workflow",
        surface: gateSurface,
        via: "fast_path",
      });
      if (!claim.ok) {
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          {},
          { ok: false, error_code: claim.code, message: claim.message, skipped_llm: true },
          claim.message,
          "error",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "error",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: claim.message,
        };
      }
      const replayArgs = claim.args;
      const slug = typeof replayArgs.workflow === "string" ? replayArgs.workflow : null;
      const resolved = slug
        ? await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, slug, { require_published: true })
        : null;
      const replayEnvironment = claim.execution_mode;
      if (!resolved?.current_version_id || !replayEnvironment) {
        const unavailable = resolved?.current_version_id
          ? "approval_environment_missing"
          : "workflow_not_found";
        await recordApprovalUnfulfilled({
          db: p.db,
          principal: p.principal,
          claim,
          tool: "run_workflow",
          via: "fast_path",
          reason: unavailable,
        });
        const reply = resolved?.current_version_id
          ? "The confirmation names no environment; nothing was run. Ask again to obtain a fresh confirmation."
          : `The workflow ${slug ?? "(unknown)"} is no longer available; nothing was run.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          replayArgs,
          { ok: false, error: unavailable, skipped_llm: true },
          reply,
          "error",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "error",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      const grant = await authorizeWorkflowRun(
        {
          principal: p.principal,
          workflow_id: resolved.id,
          workflow_slug: resolved.slug,
          via: "fast_path",
          tool: "run_workflow",
          approval: approvalAuditResource(claim),
        },
        { db: p.db },
      );
      if (grant.kind === "rejected") {
        const reply = `Permission denied: ${grant.message}.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          replayArgs,
          {
            ok: false,
            denied: true,
            permission: "workflow:run",
            reason: grant.reason,
            error: grant.message,
            skipped_llm: true,
          },
          reply,
          "denied",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "denied",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      const approvalRecorded = await recordApprovalApproved({
        db: p.db,
        principal: p.principal,
        claim,
        tool: "run_workflow",
        via: "fast_path",
      });
      if (!approvalRecorded) {
        const reply = `The confirmation could not be recorded in the audit log; ${resolved.slug} was not run. Ask again to obtain a fresh confirmation.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          replayArgs,
          { ok: false, error_code: "approval_audit_failed", skipped_llm: true },
          reply,
          "error",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "error",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      const payload = await executeRunWorkflow(
        p,
        { workflow: resolved },
        null,
        grant,
        replayEnvironment,
      );
      const persisted = await persistFastPathTurn(
        p,
        "run_workflow",
        replayArgs,
        { ok: payload.ok, ...payload.data, skipped_llm: true },
        payload.reply,
        payload.outcome,
      );
      recordConversationToolCall({
        category: "tenant_write",
        tool: "run_workflow",
        outcome: payload.outcome,
        duration_ms: 0,
      });
      logger.info({
        module: "conversation",
        action: "conversation.fast_path",
        msg: "fast-path resumed run_workflow after confirmation",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        workflow_id: resolved.id,
      });
      return {
        status: "active",
        events: persisted.events,
        fast_path_tool: "run_workflow",
        assistant_text: payload.reply,
      };
    }
  }
  return null;
}
