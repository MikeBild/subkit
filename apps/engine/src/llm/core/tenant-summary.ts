// Tenant summary block — the concise "here is what exists in this
// tenant right now" manifest injected into the converse system prompt.
//
// Rationale: without a summary, the model has to call `list_workflows`
// and `list_connectors` just to answer "what do I have?". That's the
// exact loop observed in session 4e6696e3: three list_workflows calls
// (no filter, status=draft, status=archived) before the loop-guard
// fired and the turn collapsed to an empty response. A few hundred
// bytes of summaries here replace multiple round-trips of tool calls.
//
// Only the `converse` flow uses this. Generate / repair / extract keep
// their prior one-shot behaviour.

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { connectors, workflows } from "../../db/schema/index.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TenantSummary {
  workflows: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    lifecycle: string;
    is_tool: boolean;
  }>;
  connectors: ReadonlyArray<{
    id: string;
    slug: string;
    display_name: string;
    driver: string;
    environment: string;
  }>;
}

/** Hard cap — if a tenant has more rows than this, the block trims. */
const MAX_WORKFLOWS_IN_SUMMARY = 40;
const MAX_CONNECTORS_IN_SUMMARY = 40;

export async function loadTenantSummary(tenant_id: string, exec: Executor): Promise<TenantSummary> {
  const [workflowRows, connectorRows] = await Promise.all([
    exec
      .select({
        id: workflows.id,
        slug: workflows.slug,
        name: workflows.name,
        lifecycle: workflows.lifecycle,
        is_tool: workflows.is_tool,
      })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)))
      .limit(MAX_WORKFLOWS_IN_SUMMARY + 1),
    exec
      .select({
        id: connectors.id,
        slug: connectors.slug,
        display_name: connectors.display_name,
        driver: connectors.driver,
        environment: connectors.environment,
      })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)))
      .limit(MAX_CONNECTORS_IN_SUMMARY + 1),
  ]);
  return { workflows: workflowRows, connectors: connectorRows };
}

/**
 * Render the tenant-summary block. Returns null when both lists are
 * empty so the assembler skips emitting a dead header.
 *
 * Shape: compact one-line-per-row entries. Keep each line short — the
 * model uses this only to know *what* exists and pick an id; details
 * are fetched on demand via `get_workflow(id)` / `get_connector(id)`.
 */
export function renderTenantSummaryBlock(summary: TenantSummary): string | null {
  const lines: string[] = [];
  const workflowsTotal = summary.workflows.length;
  const workflowsShown = summary.workflows.slice(0, MAX_WORKFLOWS_IN_SUMMARY);
  if (workflowsShown.length > 0) {
    lines.push("Workflows:");
    for (const w of workflowsShown) {
      const toolFlag = w.is_tool ? "" : " [authoring-only]";
      lines.push(`- ${w.slug} (${w.lifecycle})${toolFlag} — ${w.name} [id=${w.id}]`);
    }
    if (workflowsTotal > MAX_WORKFLOWS_IN_SUMMARY) {
      lines.push(
        `- … and ${workflowsTotal - MAX_WORKFLOWS_IN_SUMMARY} more — call list_workflows to page.`,
      );
    }
  }
  const connectorsTotal = summary.connectors.length;
  const connectorsShown = summary.connectors.slice(0, MAX_CONNECTORS_IN_SUMMARY);
  if (connectorsShown.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Connectors:");
    for (const c of connectorsShown) {
      lines.push(`- ${c.slug} (${c.driver}/${c.environment}) — ${c.display_name} [id=${c.id}]`);
    }
    if (connectorsTotal > MAX_CONNECTORS_IN_SUMMARY) {
      lines.push(
        `- … and ${connectorsTotal - MAX_CONNECTORS_IN_SUMMARY} more — call list_connectors to page.`,
      );
    }
  }
  if (lines.length === 0) return null;
  return [
    "=== TENANT SNAPSHOT — THIS IS THE AUTHORITATIVE LIVE LIST ===",
    "The following lines enumerate every workflow and connector that currently exists for this tenant (live DB state at turn start). Treat this block as ground truth; the user sees it implicitly. Call list_workflows / list_connectors ONLY when you need more rows than are shown (the block trims at 40 per kind) OR a lifecycle filter the block does not expose.",
    "",
    ...lines,
    "",
    "HARD RULES:",
    "- If the user asks to 'list', 'show', 'display', 'zeige', 'welche', 'wieviele' workflows or connectors, answer from the lines above. DO NOT call list_workflows or list_connectors to re-verify — you already have the answer.",
    "- Use the ids and slugs above verbatim in tool calls. Never invent new ids. Never repeat a list_* call to 'double-check'.",
    "- Call get_workflow(id) / get_connector(id) only when you need fields beyond slug, name, lifecycle, driver, environment.",
    "- A plain enumeration reply is one short sentence plus bullet list of slug + name. No preamble, no follow-up questions.",
    "=== END TENANT SNAPSHOT ===",
  ].join("\n");
}
