// Server-only preparation. Reading a version must not execute it, decrypt a
// credential, refresh OAuth, or invoke a connector probe.
import { z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { resolveUrl } from "../connectors/drivers/http.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { authorityConnectorConfiguration } from "./authority-configuration.ts";
import { authorityExecutionShape } from "./authority-execution-shape.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import { compileWorkflowEffectManifest, type ResolvedEffectBinding } from "./effect-manifest.ts";
import { supportsReportDelivery } from "./report-delivery-boundary.ts";

import {
  proposeReportDeliveryBoundaries,
  type ReportDeliveryBoundaries,
} from "./report-delivery-proposal.ts";
import { WorkflowDefSchema } from "./types.ts";

const inputSchema = z
  .object({
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    execution_environment: z.enum(["dev", "prod"]),
    // Computed by the admitting service from its effective runtime options,
    // never forwarded from an HTTP/MCP caller as an authority claim.
    execution_options_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Targets shown to people omit userinfo, query values and fragments. The
 * exact authored request and full connector configuration remain digest-bound.
 * Credential-bearing URLs are not eligible for a reusable authority. */
function displayTarget(url: URL): string | null {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`;
}

/** Use the caller's transaction when issuing an authority. The admitting
 * service must lock the exact version and recheck this result before effects;
 * a read-only review result is not a durable authorization. */
export async function resolveWorkflowEffectManifest(
  raw: unknown,
  db: Executor,
  options: { include_review?: boolean; report_boundaries?: ReportDeliveryBoundaries } = {},
) {
  const input = inputSchema.parse(raw);
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .innerJoin(
      workflows,
      and(
        eq(workflows.id, workflowVersions.workflow_id),
        eq(workflows.tenant_id, workflowVersions.tenant_id),
      ),
    )
    .where(
      and(
        eq(workflowVersions.tenant_id, input.tenant_id),
        eq(workflowVersions.workflow_id, input.workflow_id),
        eq(workflowVersions.id, input.workflow_version_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!version)
    throw Object.assign(new Error("workflow version unavailable"), {
      code: "workflow_version_unavailable",
    });
  const definition = WorkflowDefSchema.parse(version.dag);
  let reportBoundaries = options.report_boundaries;
  const bindings: ResolvedEffectBinding[] = [];
  const unavailable_steps: string[] = [];
  for (const step of definition.steps) {
    if (step.kind !== "request") continue;
    const system = step.connector_id
      ? await loadConnectorSystem(
          input.tenant_id,
          step.connector_id,
          input.execution_environment,
          db,
        )
      : null;
    if (step.connector_id && !system) continue;
    const connector = system?.connector;
    const credentials = await system?.getAuthorityMetadata();
    if (
      connector &&
      (!connector.enabled ||
        connector.needs_reauth ||
        (connector.auth_type !== "none" && !credentials?.available))
    )
      unavailable_steps.push(step.id);
    const driver = system?.driver ?? "http";
    let target: string | null = null;
    try {
      if (driver === "http")
        target = displayTarget(
          connector
            ? resolveUrl(connector.base_url, step.path ?? step.url ?? "/")
            : new URL(step.url ?? ""),
        );
      if (driver === "graphql" && connector?.base_url)
        target = displayTarget(new URL(connector.base_url));
      // Other drivers remain ineligible until their own target resolution is
      // shared with this path; guessing an HTTP target for S3/SQL/MCP is unsafe.
    } catch {
      // A malformed or unresolved URL is an unbound target, never a probe.
    }
    if (reportBoundaries === undefined && supportsReportDelivery(step, target))
      reportBoundaries = await proposeReportDeliveryBoundaries(input, db);
    const configuration = authorityConnectorConfiguration(connector);
    bindings.push({
      tenant_id: input.tenant_id,
      step_id: step.id,
      ...(reportBoundaries?.[step.id] && supportsReportDelivery(step, target)
        ? { report_delivery: reportBoundaries?.[step.id] }
        : {}),
      connector_id: step.connector_id ?? null,
      driver,
      environment: system?.environment ?? input.execution_environment,
      request_digest: workflowJsonDigest(step),
      target,
      configuration_digest: workflowJsonDigest(configuration),
      credential_binding_digest: credentials ? workflowJsonDigest(credentials.binding) : null,
      // Template documentation examples are digest-bound but never substituted
      // into a request; only runtime connector fields can rewrite its target.
      // A cursor can inject response data into an arbitrary body recipient or
      // query parameter. Pagination therefore needs concrete-run review until
      // target-safe parameter constraints are implemented.
      rewrites_target:
        Boolean(step.pagination) ||
        JSON.stringify({
          base_url: connector?.base_url,
          dsn: connector?.dsn,
          config: connector?.config,
        }).includes("${"),
    });
  }
  const compiled = compileWorkflowEffectManifest({
    ...input,
    execution_options_digest: workflowJsonDigest({
      runtime_options_digest: input.execution_options_digest,
      normalized_definition: definition,
    }),
    definition: version.dag,
    bindings,
  });
  unavailable_steps.sort();
  return {
    ...compiled,
    ...(options.include_review
      ? { execution_shape: authorityExecutionShape(definition, bindings) }
      : {}),
    unavailable_steps,
    eligible_for_repeated_runs:
      compiled.eligible_for_repeated_runs && unavailable_steps.length === 0,
  };
}
