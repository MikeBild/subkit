import { z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import type { ConnectorRecipe } from "./templates.ts";

export const RecipeConnectorCandidateSchema = z
  .object({ id: z.string(), slug: z.string(), name: z.string() })
  .openapi("RecipeConnectorCandidate");

export const RecipeConnectorBindingSchema = z
  .object({
    placeholder: z.string(),
    template: z.string(),
    template_name: z.string(),
    connector_id: z.string().nullable(),
    connector_name: z.string().nullable(),
    candidates: z
      .array(RecipeConnectorCandidateSchema)
      .describe(
        "Enabled connectors of this template. Bound automatically only when the template has a fixed address and exactly one candidate exists; otherwise the caller picks one.",
      ),
  })
  .openapi("RecipeConnectorBinding");
export type RecipeConnectorBinding = z.infer<typeof RecipeConnectorBindingSchema>;

export interface TemplateConnector {
  id: string;
  slug: string;
  display_name: string;
  template_slug: string;
  enabled: boolean;
}

export interface BoundRecipe {
  workflow: WorkflowDef;
  connectors: RecipeConnectorBinding[];
}

export function rebindConnectorIds(workflow: unknown, bindings: Record<string, string>): unknown {
  if (Array.isArray(workflow)) return workflow.map((v) => rebindConnectorIds(v, bindings));
  if (workflow === null || typeof workflow !== "object") return workflow;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflow as Record<string, unknown>)) {
    out[key] =
      key === "connector_id" && typeof value === "string" && value in bindings
        ? bindings[value]
        : rebindConnectorIds(value, bindings);
  }
  return out;
}

export async function listTemplateConnectors(
  tenant_id: string,
  template_slugs: readonly string[],
  exec: Executor = getDb(),
): Promise<TemplateConnector[]> {
  if (template_slugs.length === 0) return [];
  const rows = await exec
    .select({
      id: connectors.id,
      slug: connectors.slug,
      display_name: connectors.display_name,
      template_slug: connectors.template_slug,
      enabled: connectors.enabled,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        inArray(connectors.template_slug, [...template_slugs]),
        isNull(connectors.deleted_at),
      ),
    )
    .orderBy(asc(connectors.created_at), asc(connectors.id));
  return rows.flatMap((row) =>
    row.template_slug ? [{ ...row, template_slug: row.template_slug }] : [],
  );
}

export interface BindableTemplate {
  name: string;
  base_url: string | null;
}

export function bindsByTemplate(template: BindableTemplate | undefined): boolean {
  return Boolean(template?.base_url);
}

export function bindRecipe(
  recipe: ConnectorRecipe,
  available: readonly TemplateConnector[],
  templates: ReadonlyMap<string, BindableTemplate>,
): BoundRecipe {
  const bindings: Record<string, string> = {};
  const bound = recipe.required_connectors.map((required): RecipeConnectorBinding => {
    const template = templates.get(required.template);
    const candidates = available.filter((c) => c.enabled && c.template_slug === required.template);
    const connector =
      bindsByTemplate(template) && candidates.length === 1 ? (candidates[0] ?? null) : null;
    if (connector) bindings[required.placeholder] = connector.id;
    return {
      placeholder: required.placeholder,
      template: required.template,
      template_name: template?.name ?? required.template,
      connector_id: connector?.id ?? null,
      connector_name: connector?.display_name ?? null,
      candidates: candidates.map((c) => ({ id: c.id, slug: c.slug, name: c.display_name })),
    };
  });
  const workflow = rebindConnectorIds(
    JSON.parse(JSON.stringify(recipe.workflow)),
    bindings,
  ) as WorkflowDef;
  return { workflow, connectors: bound };
}
