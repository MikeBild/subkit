// Shared `wf_<slug>` workflow-tool catalog. Both MCP `tools/list` and
// the converse chat palette read from here. Single source of truth so
// the two surfaces cannot drift on inputSchema, description, or LRU
// ordering.
//
// The `wf_` prefix lives in the surface adapters (MCP `tools.ts`,
// chat `sdk-wrap.ts`), not in this module — callers tack it on when
// naming the tool. Catalog rows carry the bare slug + the materialised
// input schema, plus the workflow id needed to dispatch.
//
// COLLISION SAFETY: the `wf_` prefix guarantees no clash with the
// conversation-tool registry, which never uses that prefix. A user-
// authored workflow with slug `propose_step` becomes tool
// `wf_propose_step` (distinct from the built-in `propose_step` tool).

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { synthesizeInputSchema } from "./input-schema-synth.ts";
import { WorkflowDefSchema } from "./types.ts";

export interface WorkflowToolDescriptor {
  /** Persisted workflow id — caller dispatches via `runExecution({ source: { kind: "saved", workflow_id } })`. */
  workflow_id: string;
  /** Stable URL-safe identifier. Prefixed with `wf_` by the surface. */
  slug: string;
  /** Workflow display name; used as the LLM-facing description when the DAG carries no `description`. */
  name: string;
  /** One-paragraph description sourced from `WorkflowDef.description`, fallback to `name`. */
  description: string;
  /** Versioned effect declaration; absent declarations are materialized as irreversible. */
  effect: "read" | "reversible_write" | "irreversible_write";
  /** Materialised JSON Schema for the workflow's input. Empty-object schema when the workflow declares none. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; [k: string]: unknown };
  /** Declared `output_schema` JSON Schema, when the workflow declares a
   *  `type:"object"` contract. Undefined when none is declared — synth
   *  never fabricates an output contract. */
  outputSchema?: { type: "object"; properties?: Record<string, unknown>; [k: string]: unknown };
  /** Last `runExecution` timestamp; null when the workflow has never run. Drives LRU truncation. */
  last_executed_at: Date | null;
}

// MCP recommends the closed no-arg shape `{type:"object", additionalProperties:false}`
// so clients know a parameterless tool accepts only an empty object. Matches the
// registry/zod tools (json-schema-parity.test.ts).
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

// Mirror of `toInputSchema`'s guard for the declared `output_schema`:
// pass it through only when it is a `type:"object"` JSON Schema, else
// surface no output contract at all (the MCP Tool simply omits one).
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
  /** Hard upper bound. Defaults to 40 — matches the cap the converse palette ships to the LLM. */
  limit?: number;
}

/**
 * List every `wf_<slug>` tool visible to the principal. Filters by
 * the same product-catalog rule MCP enforces:
 *   - `is_tool = true`
 *   - `deleted_at IS NULL`
 *   - `current_version_id IS NOT NULL` (drafts hidden)
 *   - principal's `allowed_workflows` allow-list (when set)
 *
 * Ordered by `last_executed_at DESC NULLS LAST, created_at ASC` so
 * the most-recently-used workflows surface first; the LRU cap drops
 * stale ones from the LLM palette. Tenants with > limit workflows
 * still see every workflow via the always-available
 * `run_workflow(workflow=<slug>)` fallback.
 */
export async function listWorkflowToolsForTenant(
  p: ListWorkflowToolsParams,
): Promise<WorkflowToolDescriptor[]> {
  const limit = p.limit ?? 40;
  const principal = p.principal;
  // Push the allowlist filter into SQL when the principal has an array
  // allowlist — saves fetching 40 rows just to discard 35 in JS for
  // narrowly-scoped portal tokens. `"all"` and `undefined` skip the
  // narrowing (the JS-side filter below still owns those cases).
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

  // No silent cap — when the LRU limit is hit, the oldest workflows fall
  // out of the LLM tool palette. They remain reachable via
  // run_workflow(workflow=<slug>) / find_workflow, so this is an
  // observability signal, not a functional break. Emit one structured
  // line so an operator can see when the cap bites for a tenant.
  if (rows.length === limit) {
    logger.info({
      module: "workflows",
      action: "catalog.palette_truncated",
      msg: "workflow tool palette hit the LRU cap; older workflows are reachable via run_workflow(workflow=<slug>) / find_workflow",
      tenant_id: principal.tenant_id,
      limit,
    });
  }

  // First filter rows the principal can actually see — published only,
  // allowlist (when set). This shrinks the version-id batch and avoids
  // wasting a query when the principal has no visible workflows.
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

  // Single `IN (...)` batch fetch for the current-version DAGs. Previously
  // this loop ran one `select … from workflowVersions` per row, which
  // produced up to 41 round-trips per chat turn (catalog cap is 40).
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
    // Description precedence: the editable `workflows.description` column
    // wins (set via `update_workflow`), then the DAG's authoring-time
    // `description`, then the display name as a last resort. Keeps the
    // LLM-facing `wf_<slug>` description aligned with the HTTP surface
    // (serializeWorkflow) and the MCP resource view.
    const columnDescription = row.description?.trim() ? row.description.trim() : null;
    let description = columnDescription ?? row.name;
    let effect: WorkflowToolDescriptor["effect"] = "irreversible_write";
    let inputSchema: WorkflowToolDescriptor["inputSchema"] = EMPTY_OBJECT_SCHEMA;
    let outputSchema: WorkflowToolDescriptor["outputSchema"];
    const dag = row.current_version_id ? dagByVersionId.get(row.current_version_id) : undefined;
    if (dag) {
      const parsed = WorkflowDefSchema.safeParse(dag);
      if (parsed.success) {
        if (!columnDescription && parsed.data.description) description = parsed.data.description;
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
      effect,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      last_executed_at: row.last_executed_at,
    });
  }
  // Stable wire order, decided AFTER the LRU cap picked WHICH workflows.
  //
  // Recency answers "which 40 fit the palette"; it must not also decide the
  // order they are emitted in. These become synthetic `wf_<slug>` tools, and
  // the tools array is rendered in front of the only cache breakpoint — so a
  // scheduled run finishing anywhere in the tenant reordered the array and
  // invalidated the cached prefix of every conversation that followed.
  // Measured before this: 2.7 cache reads per cache write on the converse
  // flow, where a stable prefix should give ten to twenty.
  out.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
  return out;
}
