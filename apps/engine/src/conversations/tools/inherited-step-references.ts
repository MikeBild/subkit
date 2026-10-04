import { and, eq, isNull } from "drizzle-orm";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import {
  partitionStepReferences,
  type ReferenceValidationError,
  validateStepReferences,
} from "../../workflows/reference-validator.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";
import type { ToolContext } from "./index.ts";

export const INHERITED_STEP_REFERENCE_CODE = "inherited_step_reference";

export interface InheritedStepReferenceNotice {
  code: typeof INHERITED_STEP_REFERENCE_CODE;
  message: string;
  references: Array<{ step_id: string; field: string; absent_step: string }>;
}

type Ctx = Pick<ToolContext, "db" | "tenant_id" | "conversation_id">;

async function activeVersionReferences(
  ctx: Ctx,
  candidate: WorkflowDef,
): Promise<ReferenceValidationError[]> {
  try {
    const [row] = await ctx.db
      .select({ dag: workflowVersions.dag, slug: workflows.slug })
      .from(conversations)
      .innerJoin(
        workflows,
        and(
          eq(workflows.tenant_id, conversations.tenant_id),
          eq(workflows.id, conversations.target_workflow_id),
          isNull(workflows.deleted_at),
        ),
      )
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.tenant_id, workflows.tenant_id),
          eq(workflowVersions.workflow_id, workflows.id),
          eq(workflowVersions.id, workflows.current_version_id),
        ),
      )
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      )
      .limit(1);
    if (!row) return [];
    const slug = (candidate as { slug?: unknown }).slug;
    if (typeof slug === "string" && slug !== row.slug) return [];
    const parsed = WorkflowDefSchema.safeParse(row.dag);
    return parsed.success ? validateStepReferences(parsed.data) : [];
  } catch (error) {
    logger.warn({
      module: "conversations",
      action: "step_references.baseline_unavailable",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function classifyStepReferences(
  ctx: Ctx,
  tool: "edit_workflow_patch" | "dry_run_workflow",
  candidate: WorkflowDef,
): Promise<{
  introduced: ReferenceValidationError[];
  notice: InheritedStepReferenceNotice | null;
}> {
  const dangling = validateStepReferences(candidate);
  if (dangling.length === 0) return { introduced: [], notice: null };
  const { introduced, inherited } = partitionStepReferences(
    dangling,
    await activeVersionReferences(ctx, candidate),
  );
  if (inherited.length === 0) return { introduced, notice: null };
  logger.info({
    module: "conversations",
    action: "step_references.inherited",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    tool,
    count: inherited.length,
  });
  const reads = inherited
    .map((e) => `step \`${e.step_id}\`.${e.field} reads \`${e.bad_reference}\``)
    .join("; ");
  return {
    introduced,
    notice: {
      code: INHERITED_STEP_REFERENCE_CODE,
      message:
        "Informational, not an error: the active version of this workflow already reads step ids " +
        `that are not among its steps — ${reads}. This call did not introduce these reads and they ` +
        "do not block it. They are existing behaviour of the running workflow; do not change them " +
        "on account of this notice.",
      references: inherited.map((e) => ({
        step_id: e.step_id,
        field: e.field,
        absent_step: e.bad_reference,
      })),
    },
  };
}
