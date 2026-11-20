import type { Executor } from "../../../../db/client.ts";
import { type RunCoverageSubject, readRunCoverage } from "../../../../execution/run-coverage.ts";
import { logger } from "../../../../logging/logger.ts";
import type { PermissionMode, ToolPolicies } from "../../../../tools/types.ts";
import { workflowExecutionEnvironment } from "../../../../workflows/execution-environment.ts";
import { resolveWorkflowByIdOrSlug } from "../../../../workflows/lookup.ts";
import { WORKFLOW_TOOL_PREFIX } from "../../authoring-palette.ts";
import type { ToolContext } from "../../index.ts";

export type RunTargetRef =
  | { kind: "matched"; id: string }
  | { kind: "unmatched" }
  | { kind: "absent" };

export async function runWorkflowTargetRef(
  ctx: Pick<ToolContext, "db" | "tenant_id" | "getDraft">,
  workflow: string | undefined,
): Promise<RunTargetRef> {
  if (workflow) {
    const resolved = await resolveWorkflowByIdOrSlug(ctx.db, ctx.tenant_id, workflow);
    return resolved ? { kind: "matched", id: resolved.id } : { kind: "unmatched" };
  }
  const target = ctx.getDraft().summary?.active_target ?? null;
  return target?.kind === "workflow" && target.lifecycle_state === "persisted" && target.id
    ? { kind: "matched", id: target.id }
    : { kind: "absent" };
}

export type GateCoverage =
  | { covered: true; authority_id: string; environment: "dev" | "prod" }
  | { covered: false };

const GATE_UNCOVERED: GateCoverage = { covered: false };

let reader: typeof readRunCoverage = readRunCoverage;

export function __setRunCoverageReaderForTests(next: typeof readRunCoverage | null): void {
  reader = next ?? readRunCoverage;
}

export function workflowConfirmOverride(overrides: ToolPolicies, slug: string): boolean {
  return overrides[`${WORKFLOW_TOOL_PREFIX}${slug}`] === "confirm_before_execution";
}

export async function loadRunCoverage(
  db: Executor,
  permissionMode: PermissionMode | null,
  subject: () => RunCoverageSubject | null | Promise<RunCoverageSubject | null>,
): Promise<GateCoverage> {
  if (permissionMode !== "ask") return GATE_UNCOVERED;
  try {
    const resolved = await subject();
    if (!resolved) return GATE_UNCOVERED;
    const coverage = await reader(db, resolved);
    return coverage.covered
      ? { ...coverage, environment: resolved.execution_environment }
      : GATE_UNCOVERED;
  } catch (error) {
    logger.warn({
      module: "conversation_tool",
      action: "run_coverage.unresolved",
      msg: "could not establish whether an execution authority covers the run; the question stays",
      error: error instanceof Error ? error.message : String(error),
    });
    return GATE_UNCOVERED;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function confirmsSomeWorkflow(overrides: ToolPolicies): boolean {
  return Object.entries(overrides).some(
    ([name, mode]) => name.startsWith(WORKFLOW_TOOL_PREFIX) && mode === "confirm_before_execution",
  );
}

export function runWorkflowToolCoverage(
  ctx: Pick<ToolContext, "db" | "tenant_id" | "getDraft">,
  permissionMode: PermissionMode | null,
  args: Record<string, unknown>,
  overrides: ToolPolicies,
): Promise<GateCoverage> {
  return loadRunCoverage(ctx.db, permissionMode, async () => {
    const requested =
      args.environment === "dev" || args.environment === "prod" ? args.environment : null;
    if (args.environment !== undefined && requested === null) return null;
    const target = await runWorkflowTargetRef(ctx, nonEmptyString(args.workflow));
    if (target.kind !== "matched") return null;
    if (confirmsSomeWorkflow(overrides)) {
      const workflow = await resolveWorkflowByIdOrSlug(ctx.db, ctx.tenant_id, target.id);
      if (!workflow || workflowConfirmOverride(overrides, workflow.slug)) return null;
    }
    const expected = nonEmptyString(args.expected_workflow_version_id);
    return {
      tenant_id: ctx.tenant_id,
      workflow_id: target.id,
      workflow_version_id: expected,
      expected_workflow_version_id: expected,
      execution_environment:
        requested ?? (await workflowExecutionEnvironment(ctx.db, ctx.tenant_id, target.id)),
      hold_writes: args.execute_writes !== undefined && args.execute_writes !== true,
    };
  });
}
