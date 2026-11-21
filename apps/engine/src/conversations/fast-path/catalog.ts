import { and, asc, eq, isNull } from "drizzle-orm";
import { executionSteps, executions, workflows } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import { can } from "../../rbac/evaluator.ts";
import { listToolFor, READ_PERMISSION_BY_LIST, stepLine } from "../core/fast-path.ts";
import type { ReplyLanguage } from "../fast-path-lists.ts";
import {
  type RenderPayload,
  renderConnectorsList,
  renderExecutionsList,
  renderKnowledgeSourcesList,
  renderSchedulesList,
  renderWorkflowCategoryList,
  renderWorkflowsList,
} from "../fast-path-lists.ts";
import type { CatalogKind } from "./intents.ts";
import { answerFastPath, auditPolicyDenied } from "./persist.ts";
import type { FastPathHit, FastPathParams } from "./types.ts";

function rendererFor(kind: CatalogKind): (p: FastPathParams) => Promise<RenderPayload> {
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
  return answerFastPath(p, {
    tool,
    category: "tenant_read",
    input,
    output: { ok: false, denied: true, permission, reason, skipped_llm: true },
    reply: `Permission denied: ${permission}.`,
    outcome: "denied",
  });
}

async function answerCatalogRead(
  p: FastPathParams,
  tool: string,
  input: Record<string, unknown>,
  payload: RenderPayload,
): Promise<FastPathHit> {
  const hit = await answerFastPath(p, {
    tool,
    category: "tenant_read",
    input,
    output: { ok: payload.ok, ...payload.data, skipped_llm: true },
    reply: payload.reply,
    outcome: payload.ok ? "ok" : "error",
  });
  logger.info({
    module: "conversation",
    action: "conversation.fast_path",
    msg: "fast-path handled list intent",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    tool,
    ...input,
  });
  return hit;
}

export async function listPhase(p: FastPathParams, kind: CatalogKind): Promise<FastPathHit> {
  const tool = listToolFor(kind);
  const denied = await denyCatalogRead(p, READ_PERMISSION_BY_LIST[kind], tool, {});
  if (denied) return denied;
  return answerCatalogRead(p, tool, {}, await rendererFor(kind)(p));
}

export async function categoryPhase(
  p: FastPathParams,
  category: string,
  language: ReplyLanguage,
): Promise<FastPathHit | "fall_through"> {
  const [known] = await p.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, p.tenant_id),
        isNull(workflows.deleted_at),
        eq(workflows.category, category),
      ),
    )
    .limit(1);
  if (!known) return "fall_through";
  const input = { category };
  const denied = await denyCatalogRead(p, "workflow:read", "list_workflows", input);
  if (denied) return denied;
  const payload = await renderWorkflowCategoryList(p, category, language);
  return payload ? answerCatalogRead(p, "list_workflows", input, payload) : "fall_through";
}

export async function catalogsPhase(p: FastPathParams, kinds: CatalogKind[]): Promise<FastPathHit> {
  const sections: string[] = [];
  const dataByKind: Record<string, unknown> = {};
  let anyOk = false;
  for (const kind of kinds) {
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
  const hit = await answerFastPath(p, {
    tool: "list_catalogs",
    category: "tenant_read",
    input: { catalogs: kinds },
    output: { ok: anyOk, catalogs: dataByKind, skipped_llm: true },
    reply: sections.join("\n\n"),
    outcome: anyOk ? "ok" : "error",
  });
  logger.info({
    module: "conversation",
    action: "conversation.fast_path",
    msg: "fast-path handled multi-catalog list intent",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    catalogs: kinds,
  });
  return hit;
}

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
  return {
    ok: exec.status === "succeeded",
    reply: `Execution ${exec.id.slice(0, 8)} — ${exec.status}\n${stepRows.map(stepLine).join("\n") || "(no steps)"}`,
    data: {
      execution: exec,
      steps: stepRows,
    },
  };
}

export async function inspectPhase(p: FastPathParams, execution_id: string): Promise<FastPathHit> {
  const decision = await can(p.db, {
    tenant_id: p.tenant_id,
    principal: p.principal,
    permission: "execution:read",
    resource: { type: "execution", id: execution_id },
  });
  if (!decision.allow) {
    const reason = decision.reason ?? "permission_denied";
    await auditPolicyDenied(p, "execution:read", "inspect_execution", reason, {
      type: "execution",
      id: execution_id,
    });
    return answerFastPath(p, {
      tool: "inspect_execution",
      category: "tenant_read",
      input: { execution_id },
      output: {
        ok: false,
        denied: true,
        permission: "execution:read",
        reason,
        skipped_llm: true,
      },
      reply: "Permission denied: execution:read.",
      outcome: "denied",
    });
  }
  const payload = await renderInspectExecution(p, execution_id);
  return answerFastPath(p, {
    tool: "inspect_execution",
    category: "tenant_read",
    input: { execution_id },
    output: { ok: payload.ok, ...payload.data, skipped_llm: true },
    reply: payload.reply,
    outcome: payload.ok ? "ok" : "error",
  });
}
