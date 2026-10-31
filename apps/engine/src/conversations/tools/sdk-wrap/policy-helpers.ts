import { normalizeWorkflowInput } from "../workflow-input-normalize.ts";

export function confirmationMetadataForTool(
  toolName: string,
  input: unknown,
): {
  risk_level: "low" | "medium" | "high" | "critical";
  target_label?: string;
  reversible: boolean;
} {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const slug = typeof obj.slug === "string" ? obj.slug : null;
  const workflow = typeof obj.workflow === "string" ? obj.workflow : null;
  const workflowId = typeof obj.workflow_id === "string" ? obj.workflow_id : null;
  const connectorId = typeof obj.connector_id === "string" ? obj.connector_id : null;
  const environment = typeof obj.environment === "string" ? obj.environment : null;
  const target = slug ?? workflow ?? workflowId ?? connectorId ?? null;
  const isDelete = toolName.startsWith("delete_") || toolName.startsWith("revoke_");
  const isProd = environment === "prod";
  const riskLevel = isDelete ? "critical" : isProd ? "high" : "medium";
  return {
    risk_level: riskLevel,
    ...(target ? { target_label: `${toolName}: ${target}` } : {}),
    reversible: !isDelete,
  };
}

export function mapToolToCommitIntentKind(tool: string): string | null {
  switch (tool) {
    case "save_workflow_draft":
      return "save_workflow_draft";
    case "save_connector_draft":
      return "save_connector_draft";
    case "run_workflow":
      return "run_workflow";
    case "update_connector":
      return "update_connector";
    case "update_workflow":
      return "update_workflow";
    case "delete_connector":
      return "delete_connector";
    case "delete_workflow":
      return "delete_workflow";
    case "create_api_key":
      return "create_api_key";
    default:
      return null;
  }
}

export function topLevelElicitationKindForTool(
  tool: string,
): "save_workflow_draft" | "external_write" | "generic" {
  if (tool === "save_workflow_draft") return "save_workflow_draft";
  return "external_write";
}

export const REVIEW_AFTER_EXECUTION_KIND = "review_after_execution" as const;

export function buildConfirmedToolCallIntent(
  tool: string,
  approvalId: string,
): Record<string, unknown> {
  return {
    kind: "execute_confirmed_tool_call",
    payload: { tool, approval_id: approvalId },
    description: `Run ${tool} with the arguments the operator is approving.`,
  };
}

export function buildPolicyGateCommitIntent(
  tool: string,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> | null {
  const intentKind = mapToolToCommitIntentKind(tool);
  if (!intentKind) return null;
  if (intentKind === "save_workflow_draft") {
    const targetId =
      typeof rawArgs.target_workflow_id === "string" ? rawArgs.target_workflow_id : undefined;
    const forceCommit = rawArgs.force_commit === true;
    return {
      kind: "save_workflow_draft",
      payload: {
        ...(targetId ? { target_workflow_id: targetId } : {}),
        ...(forceCommit ? { force_commit: true } : {}),
      },
      description: "Save the current workflow draft.",
    };
  }
  if (intentKind === "save_connector_draft") {
    const env = typeof rawArgs.environment === "string" ? rawArgs.environment : "dev";
    return {
      kind: "save_connector_draft",
      payload: { environment: env },
      description: "Save the current connector draft.",
    };
  }
  if (intentKind === "delete_connector") {
    const id = typeof rawArgs.id === "string" ? rawArgs.id : null;
    if (!id) return null;
    return {
      kind: "delete_connector",
      payload: { id },
      description: "Permanently delete this connector.",
    };
  }
  if (intentKind === "delete_workflow") {
    const id = typeof rawArgs.id === "string" ? rawArgs.id : null;
    if (!id) return null;
    return {
      kind: "delete_workflow",
      payload: { id },
      description: "Permanently delete this workflow.",
    };
  }
  if (intentKind === "create_api_key") {
    const { _meta, ...payload } = rawArgs as Record<string, unknown>;
    return {
      kind: "create_api_key",
      payload,
      description: "Create a new API key.",
    };
  }
  if (intentKind === "run_workflow") {
    const workflow = typeof rawArgs.workflow === "string" ? rawArgs.workflow : null;
    const workflowId =
      typeof rawArgs.workflow_id === "string" ? rawArgs.workflow_id : (workflow ?? null);
    if (!workflowId) return null;
    const environment = typeof rawArgs.environment === "string" ? rawArgs.environment : "dev";
    return {
      kind: "run_workflow",
      payload: {
        workflow_id: workflowId,
        ...(workflow ? { workflow_slug: workflow, workflow } : {}),
        environment,
        ...(rawArgs.input !== undefined
          ? { input_partial: normalizeWorkflowInput(rawArgs.input) }
          : {}),
        ...(rawArgs.input_file !== undefined ? { input_file: rawArgs.input_file } : {}),
        ...(rawArgs.execute_writes === true ? { execute_writes: true } : {}),
        ...(rawArgs.include_step_trace === true ? { include_step_trace: true } : {}),
      },
      description: `Run workflow ${workflow ?? workflowId} in ${environment}.`,
    };
  }
  return null;
}

export function summarizeToolData(data: unknown): Record<string, number | string | boolean> {
  if (data === null || data === undefined) return {};
  if (Array.isArray(data)) return { data_length: data.length };
  if (typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const out: Record<string, number | string | boolean> = {};
  if (Array.isArray(obj.errors)) out.error_count = (obj.errors as unknown[]).length;
  if (Array.isArray(obj.hits)) out.hit_count = (obj.hits as unknown[]).length;
  if (Array.isArray(obj.skills)) out.skill_count = (obj.skills as unknown[]).length;
  if (Array.isArray(obj.items)) out.item_count = (obj.items as unknown[]).length;
  if (typeof obj.steps === "number") out.steps = obj.steps;
  if (typeof obj.step_count === "number") out.step_count = obj.step_count;
  if (typeof obj.workflow_id === "string") out.workflow_id = obj.workflow_id;
  if (typeof obj.connector_id === "string") out.connector_id = obj.connector_id;
  if (typeof obj.skill_id === "string") out.skill_id = obj.skill_id;
  if (typeof obj.step_id === "string") out.step_id = obj.step_id;
  if (typeof obj.last_step_id === "string") out.last_step_id = obj.last_step_id;
  if (typeof obj.step_type === "string") out.step_type = obj.step_type;
  if (typeof obj.slug === "string") out.slug = obj.slug;
  if (typeof obj.approval_id === "string") out.approval_id = obj.approval_id;
  if (typeof obj.reason === "string") out.reason = obj.reason;
  if (typeof obj.error === "string") out.error = obj.error;
  if (typeof obj.replaced === "boolean") out.replaced = obj.replaced;
  out.data_keys = Object.keys(obj).length;
  return out;
}

export function summarizeToolFailure(result: {
  ok: boolean;
  error_code?: string;
  message?: string;
  data?: unknown;
}): Record<string, string> {
  if (result.ok) return {};
  const out: Record<string, string> = {};
  const data = (result.data ?? {}) as {
    error_code?: unknown;
    reason?: unknown;
    message?: unknown;
    summary?: unknown;
    error?: unknown;
  };
  const code =
    result.error_code ??
    (typeof data.error_code === "string" ? data.error_code : undefined) ??
    (typeof data.reason === "string" ? data.reason : undefined);
  const message =
    result.message ??
    (typeof data.message === "string" ? data.message : undefined) ??
    (typeof data.summary === "string" ? data.summary : undefined) ??
    (typeof data.error === "string" ? data.error : undefined);
  if (typeof code === "string") out.error_code = code.slice(0, 80);
  if (typeof message === "string") out.error = message.slice(0, 500);
  return out;
}
