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
import {
  ContentReleaseBoundarySchema,
  contentPublicationShape,
  supportsContentPublication,
} from "./content-publication-boundary.ts";
import {
  type ContentPublicationBoundaries,
  proposeContentPublicationBoundaries,
} from "./content-publication-proposal.ts";
import { compileWorkflowEffectManifest, type ResolvedEffectBinding } from "./effect-manifest.ts";
import { readPathBoundary, readPathTarget } from "./read-path-boundary.ts";
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
  options: {
    include_review?: boolean;
    report_boundaries?: ReportDeliveryBoundaries;
    content_boundaries?: ContentPublicationBoundaries;
  } = {},
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
  const contentBoundaries =
    options.content_boundaries ??
    (await proposeContentPublicationBoundaries(
      input,
      definition.steps
        .filter((step) => step.kind === "request" && step.method === "PUT")
        .map((step) => step.id),
      db,
    ));
  const contentShapes = new Map<string, ReturnType<typeof contentPublicationShape>>();
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
    const readPath = driver === "http" ? readPathBoundary(step, connector?.base_url) : null;
    if (readPath) target = readPathTarget(readPath);
    const contentShape =
      driver === "http" ? contentPublicationShape(step, connector?.base_url ?? target) : null;
    contentShapes.set(step.id, contentShape);
    const contentBoundary = contentBoundaries[step.id];
    const supportedContent =
      contentShape &&
      contentBoundary &&
      supportsContentPublication(step, contentBoundary, contentShape.target);
    if (supportedContent) target = contentShape.target;
    if (reportBoundaries === undefined && supportsReportDelivery(step, target))
      reportBoundaries = await proposeReportDeliveryBoundaries(input, db);
    const configuration = authorityConnectorConfiguration(connector);
    bindings.push({
      tenant_id: input.tenant_id,
      step_id: step.id,
      ...(supportedContent ? { content_publication: contentBoundary } : {}),
      ...(readPath ? { read_path: readPath } : {}),
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
  // A release publishes only receipts from approved revision-producing steps
  // on this same connection. Runtime verifies the complete fixed member set.
  for (const binding of bindings) {
    const shape = contentShapes.get(binding.step_id);
    if (binding.content_publication || shape?.kind !== "content_release") continue;
    // Rechecking an existing grant must use its immutable boundary, never
    // expand it from a newer preview or silently invent a missing profile.
    if (options.content_boundaries !== undefined) continue;
    const sources = bindings.flatMap((source) =>
      source.connector_id === binding.connector_id &&
      source.content_publication?.kind === "content_revision" &&
      source.content_publication.origin === shape.origin
        ? [{ step_id: source.step_id, item_ids: source.content_publication.item_ids }]
        : [],
    );
    const publication = ContentReleaseBoundarySchema.safeParse({
      kind: "content_release",
      origin: shape.origin,
      site_id: shape.site_id,
      reason: shape.reason,
      sources: sources.sort((a, b) => (a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0)),
    });
    if (publication.success) {
      binding.content_publication = publication.data;
      binding.target = shape.target;
    }
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
    preparation_required: bindings.some(
      (binding) =>
        (contentShapes.get(binding.step_id)?.kind === "content_revision" &&
          !binding.content_publication) ||
        (binding.target === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" &&
          !binding.report_delivery),
    ),
    ...(options.include_review
      ? { execution_shape: authorityExecutionShape(definition, bindings) }
      : {}),
    unavailable_steps,
    eligible_for_repeated_runs:
      compiled.eligible_for_repeated_runs && unavailable_steps.length === 0,
  };
}
