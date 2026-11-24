import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";
import { logger, scrubString } from "../logging/index.ts";

const SUBJECT_TEXT_LIMIT = 160;

const WORKFLOW_SUBJECT_FIELDS = ["name", "slug", "description", "lifecycle"] as const;

const WORKFLOW_SUBJECT_TOOLS = new Set(["update_workflow"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ApprovalSubjectSchema = z
  .object({
    resource_type: z.literal("workflow"),
    resource_id: z.string().uuid(),
    current_name: z.string().nullable(),
    current_slug: z.string().nullable(),
    changes: z
      .array(z.object({ field: z.enum(WORKFLOW_SUBJECT_FIELDS), to: z.string() }).strict())
      .max(WORKFLOW_SUBJECT_FIELDS.length),
  })
  .strict();
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;
export type ApprovalSubjectChange = ApprovalSubject["changes"][number];

const subjectText = (value: string): string => {
  const scrubbed = scrubString(value);
  return scrubbed.length > SUBJECT_TEXT_LIMIT
    ? `${scrubbed.slice(0, SUBJECT_TEXT_LIMIT)}…`
    : scrubbed;
};

export const workflowSubjectChanges = (args: Record<string, unknown>): ApprovalSubjectChange[] =>
  WORKFLOW_SUBJECT_FIELDS.flatMap((field) => {
    const proposed = args[field];
    return typeof proposed === "string" ? [{ field, to: subjectText(proposed) }] : [];
  });

export async function captureApprovalSubject(input: {
  readonly db: Executor;
  readonly tenant_id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}): Promise<ApprovalSubject | null> {
  const { db, tenant_id, tool, args } = input;
  if (!WORKFLOW_SUBJECT_TOOLS.has(tool)) return null;
  const workflowId = args.id;
  if (typeof workflowId !== "string" || !UUID_PATTERN.test(workflowId)) return null;
  const [current] = await db
    .select({ name: workflows.name, slug: workflows.slug })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflowId),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!current)
    logger.warn({
      module: "tools",
      action: "approval.subject_target_missing",
      msg: "approval subject names a workflow that is not visible in this tenant; the portal shows the id only",
      tenant_id,
      tool,
      workflow_id: workflowId,
    });
  return {
    resource_type: "workflow",
    resource_id: workflowId,
    current_name: current ? subjectText(current.name) : null,
    current_slug: current ? subjectText(current.slug) : null,
    changes: workflowSubjectChanges(args),
  };
}
