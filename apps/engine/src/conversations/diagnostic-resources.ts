import { and, eq, inArray, or } from "drizzle-orm";
import { connectors, workflows, workflowVersions } from "../db/schema/index.ts";
import { collectWorkflowConnectorReferences } from "../execution/prepared-workflow-references.ts";
import { can } from "../rbac/index.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import type { DiagnosticContext, DiagnosticContextArtifact } from "./diagnostic-context.ts";

export async function diagnosticResources(
  ctx: DiagnosticContext,
  workflowIds: string[],
  versionIds: string[],
  connectorIds: string[],
): Promise<DiagnosticContextArtifact[]> {
  if (!ctx.principal) throw new Error("Authenticated caller required");
  const allowed: string[] = [];
  let incomplete = false;
  for (const id of [...new Set(workflowIds)]) {
    const permission = await can(ctx.db, {
      tenant_id: ctx.tenant_id,
      principal: ctx.principal,
      permission: "workflow:read",
      resource: { type: "workflow", id },
    });
    if (permission.allow) allowed.push(id);
    else incomplete = true;
  }
  const workflowRows = allowed.length
    ? await ctx.db
        .select({
          id: workflows.id,
          slug: workflows.slug,
          name: workflows.name,
          version_id: workflowVersions.id,
          definition: workflowVersions.dag,
        })
        .from(workflows)
        .innerJoin(
          workflowVersions,
          and(
            eq(workflowVersions.tenant_id, ctx.tenant_id),
            eq(workflowVersions.workflow_id, workflows.id),
            or(
              eq(workflowVersions.id, workflows.current_version_id),
              inArray(workflowVersions.id, versionIds),
            ),
          ),
        )
        .where(and(eq(workflows.tenant_id, ctx.tenant_id), inArray(workflows.id, allowed)))
    : [];
  if (allowed.some((id) => !workflowRows.some((row) => row.id === id))) incomplete = true;
  const ids = new Set(connectorIds);
  const slugs = new Set<string>();
  for (const definition of [
    ctx.getDraft().workflow,
    ...workflowRows.map((row) => row.definition),
  ]) {
    const parsed = WorkflowDefSchema.safeParse(definition);
    if (!parsed.success) {
      incomplete = true;
      continue;
    }
    const refs = collectWorkflowConnectorReferences(parsed.data);
    for (const id of refs.ids.keys()) ids.add(id);
    for (const slug of refs.slugs.keys()) slugs.add(slug);
    if (refs.refusals.length) incomplete = true;
  }
  const connectorRows =
    ids.size || slugs.size
      ? await ctx.db
          .select({
            id: connectors.id,
            slug: connectors.slug,
            name: connectors.display_name,
            environment: connectors.environment,
            driver: connectors.driver,
            auth_type: connectors.auth_type,
            base_url: connectors.base_url,
            config: connectors.config,
          })
          .from(connectors)
          .where(
            and(
              eq(connectors.tenant_id, ctx.tenant_id),
              or(inArray(connectors.id, [...ids]), inArray(connectors.slug, [...slugs])),
            ),
          )
      : [];
  const readableConnectors = [];
  if (
    [...ids].some((id) => !connectorRows.some((row) => row.id === id)) ||
    [...slugs].some((slug) => !connectorRows.some((row) => row.slug === slug))
  )
    incomplete = true;
  for (const connector of connectorRows) {
    const permission = await can(ctx.db, {
      tenant_id: ctx.tenant_id,
      principal: ctx.principal,
      permission: "connector:read",
      resource: { type: "connector", id: connector.id },
    });
    if (permission.allow) readableConnectors.push(connector);
    else incomplete = true;
  }
  const status = incomplete ? ("partial" as const) : ("complete" as const);
  const reason = incomplete
    ? {
        reason:
          "Some referenced resources could not be included with the caller's existing access or draft references.",
      }
    : {};
  return [
    { name: "workflows", status, ...reason, data: workflowRows },
    { name: "connectors", status, ...reason, data: readableConnectors },
  ];
}
