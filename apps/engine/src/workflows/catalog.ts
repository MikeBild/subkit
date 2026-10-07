import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { synthesizeInputSchema } from "./input-schema-synth.ts";
import { WorkflowDefSchema } from "./types.ts";

export interface WorkflowToolDescriptor {
  workflow_id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  effect: "read" | "reversible_write" | "irreversible_write";
  inputSchema: { type: "object"; properties?: Record<string, unknown>; [k: string]: unknown };
  outputSchema?: { type: "object"; properties?: Record<string, unknown>; [k: string]: unknown };
  last_executed_at: Date | null;
}

const EMPTY_OBJECT_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false as const,
};

function toInputSchema(raw: unknown): WorkflowToolDescriptor["inputSchema"] {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { type?: unknown }).type === "object"
  ) {
    return raw as WorkflowToolDescriptor["inputSchema"];
  }
  return EMPTY_OBJECT_SCHEMA;
}

function toOutputSchema(
  raw: unknown,
): NonNullable<WorkflowToolDescriptor["outputSchema"]> | undefined {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { type?: unknown }).type === "object"
  ) {
    return raw as NonNullable<WorkflowToolDescriptor["outputSchema"]>;
  }
  return undefined;
}

export interface ListWorkflowToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  limit?: number;
}

export async function listWorkflowToolsForTenant(
  p: ListWorkflowToolsParams,
): Promise<WorkflowToolDescriptor[]> {
  const limit = p.limit ?? 40;
  const principal = p.principal;
  const allowlistSqlFilter =
    Array.isArray(principal.allowed_workflows) && principal.allowed_workflows.length > 0
      ? inArray(workflows.id, principal.allowed_workflows)
      : undefined;
  const rows = await p.db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      category: workflows.category,
      current_version_id: workflows.current_version_id,
      last_executed_at: workflows.last_executed_at,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, principal.tenant_id),
        isNull(workflows.deleted_at),
        eq(workflows.is_tool, true),
        ...(allowlistSqlFilter ? [allowlistSqlFilter] : []),
      ),
    )
    .orderBy(sql`${workflows.last_executed_at} DESC NULLS LAST`, asc(workflows.created_at))
    .limit(limit);

  if (rows.length === limit) {
    logger.info({
      module: "workflows",
      action: "catalog.palette_truncated",
      msg: "workflow tool palette hit the LRU cap; older workflows are reachable via run_workflow(workflow=<slug>) / find_workflow",
      tenant_id: principal.tenant_id,
      limit,
    });
  }

  const visibleRows = rows.filter((row) => {
    if (!row.current_version_id) return false;
    if (
      principal.allowed_workflows &&
      principal.allowed_workflows !== "all" &&
      !principal.allowed_workflows.includes(row.id)
    ) {
      return false;
    }
    return true;
  });
  if (visibleRows.length === 0) return [];

  const versionIds = visibleRows
    .map((r) => r.current_version_id)
    .filter((id): id is string => id !== null);
  const versionRows = await p.db
    .select({ id: workflowVersions.id, dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, principal.tenant_id),
        inArray(workflowVersions.id, versionIds),
      ),
    );
  const dagByVersionId = new Map<string, unknown>();
  for (const v of versionRows) dagByVersionId.set(v.id, v.dag);

  const out: WorkflowToolDescriptor[] = [];
  for (const row of visibleRows) {
    const description = row.description?.trim() ? row.description.trim() : null;
    let effect: WorkflowToolDescriptor["effect"] = "irreversible_write";
    let inputSchema: WorkflowToolDescriptor["inputSchema"] = EMPTY_OBJECT_SCHEMA;
    let outputSchema: WorkflowToolDescriptor["outputSchema"];
    const dag = row.current_version_id ? dagByVersionId.get(row.current_version_id) : undefined;
    if (dag) {
      const parsed = WorkflowDefSchema.safeParse(dag);
      if (parsed.success) {
        effect = parsed.data.tool_effect ?? "irreversible_write";
        if (parsed.data.input_schema) {
          inputSchema = toInputSchema(parsed.data.input_schema);
        } else {
          const synth = synthesizeInputSchema(parsed.data);
          if (synth) inputSchema = synth as WorkflowToolDescriptor["inputSchema"];
        }
        if (parsed.data.output_schema) {
          outputSchema = toOutputSchema(parsed.data.output_schema);
        }
      }
    }
    out.push({
      workflow_id: row.id,
      slug: row.slug,
      name: row.name,
      description,
      category: row.category,
      effect,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      last_executed_at: row.last_executed_at,
    });
  }
  out.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
  return out;
}
