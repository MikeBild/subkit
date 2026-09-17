// Product-local compilation only. This module grants no authority and performs
// no discovery, credential refresh, or network request. Its resolved bindings
// must come from the server's version/connector snapshot, never a client claim.
import { z } from "@hono/zod-openapi";
import { classifyHttpSideEffect, inferGraphqlOperation } from "@shared/index.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import { ReadPathBoundarySchema, readPathBoundary, readPathTarget } from "./read-path-boundary.ts";
import {
  hasRuntimeValue,
  ReadQueryBoundarySchema,
  ReportDeliveryBoundarySchema,
  readQueryBoundary,
  supportsReadQuery,
  supportsReportDelivery,
} from "./report-delivery-boundary.ts";
import { JsonValueSchema, type RequestStep, WorkflowDefSchema } from "./types.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const environment = z.enum(["dev", "prod"]);

export const ResolvedEffectBindingSchema = z
  .object({
    tenant_id: z.string().uuid(),
    step_id: z.string().min(1),
    connector_id: z.string().uuid().nullable(),
    driver: z.enum(["http", "graphql", "postgres", "s3", "mcp"]),
    environment,
    // Exact source binds the resolution to the request whose targets were read.
    request_digest: digest,
    target: z.string().min(1).nullable(),
    // Hash resolved configuration and stable credential identity/scopes, not
    // access-token bytes: ordinary OAuth refresh is not a new permission grant.
    configuration_digest: digest,
    credential_binding_digest: digest.nullable(),
    rewrites_target: z.boolean(),
    report_delivery: ReportDeliveryBoundarySchema.optional(),
    read_path: ReadPathBoundarySchema.optional(),
  })
  .strict();
export type ResolvedEffectBinding = z.infer<typeof ResolvedEffectBindingSchema>;

const inputSchema = z
  .object({
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    execution_environment: environment,
    // Contains all resolved execution options, including finite runtime/iteration
    // limits. Changing operator defaults must not silently widen an old grant.
    execution_options_digest: digest,
    definition: JsonValueSchema,
    bindings: z.array(ResolvedEffectBindingSchema).max(200),
  })
  .strict();

const ManifestIssueCodeSchema = z.enum([
  "missing_binding",
  "binding_mismatch",
  "environment_mismatch",
  "dynamic_request",
  "unknown_effect",
  "destructive_effect",
  "unbound_workflow_call",
]);
export type ManifestIssueCode = z.infer<typeof ManifestIssueCodeSchema>;

export const WorkflowEffectManifestSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    workflow_digest: digest,
    execution_environment: environment,
    execution_options_digest: digest,
    effects: z.array(
      ResolvedEffectBindingSchema.extend({
        read_query: ReadQueryBoundarySchema.optional(),
        operation: z.string(),
        effect: z.enum(["read", "write", "unknown", "destructive"]),
      }),
    ),
    issues: z.array(z.object({ step_id: z.string(), code: ManifestIssueCodeSchema })),
  })
  .strict()
  .openapi("WorkflowEffectManifest");
export type WorkflowEffectManifest = z.infer<typeof WorkflowEffectManifestSchema>;

function operationOf(step: RequestStep, driver: ResolvedEffectBinding["driver"]): string {
  if (driver === "mcp") {
    if (step.mcp?.operation === "call_tool") return `tools/call:${step.mcp.tool ?? "unknown"}`;
    return step.mcp?.operation ?? "unknown";
  }
  if (driver === "postgres") return "sql";
  if (driver === "graphql") return inferGraphqlOperation(step.graphql?.query ?? "") ?? "unknown";
  return step.method;
}

function effectOf(
  step: RequestStep,
  binding: ResolvedEffectBinding,
): "read" | "write" | "unknown" | "destructive" {
  // Arbitrary SQL can call externally writing functions even through SELECT;
  // MCP tool hints likewise cannot prove their effects. Keep exact-run review.
  if (
    binding.driver === "postgres" ||
    (binding.driver === "mcp" && step.mcp?.operation === "call_tool")
  )
    return "unknown";
  if (binding.driver === "graphql" && inferGraphqlOperation(step.graphql?.query ?? "") === null)
    return "unknown";
  if ((binding.driver === "http" || binding.driver === "s3") && step.method === "DELETE")
    return "destructive";
  return classifyHttpSideEffect({
    // An author may escalate, never self-authorize a POST as harmless.
    override: step.side_effects === "write" ? "write" : null,
    method: step.method,
    graphql: step.graphql
      ? { operation: step.graphql.operation ?? null, query: step.graphql.query }
      : null,
    mcp: step.mcp ?? null,
    s3: binding.driver === "s3",
  });
}

/** Compile a deterministic summary of a server-resolved version.
 * Resolvers must supply display-safe target identifiers, never credentials.
 * A digest is evidence binding, not approval. The caller may grant repeated
 * runs only if eligible_for_repeated_runs is true AND a human approves this
 * exact digest and the separate finite authority bounds. */
export function compileWorkflowEffectManifest(raw: unknown): {
  manifest: WorkflowEffectManifest;
  digest: string;
  eligible_for_repeated_runs: boolean;
} {
  const input = inputSchema.parse(raw);
  const definition = WorkflowDefSchema.parse(input.definition);
  const requests = definition.steps.filter((step) => step.kind === "request");
  const requestIds = new Set(requests.map((step) => step.id));
  if (new Set(definition.steps.map((step) => step.id)).size !== definition.steps.length) {
    throw new Error("effect manifest requires unique workflow step IDs");
  }
  const bindings = new Map<string, ResolvedEffectBinding>();
  for (const binding of input.bindings) {
    if (bindings.has(binding.step_id) || !requestIds.has(binding.step_id)) {
      throw new Error("effect bindings must identify each request step at most once");
    }
    bindings.set(binding.step_id, binding);
  }
  const manifest: WorkflowEffectManifest = {
    schema_version: 1,
    tenant_id: input.tenant_id,
    workflow_id: input.workflow_id,
    workflow_version_id: input.workflow_version_id,
    workflow_digest: workflowJsonDigest(input.definition),
    execution_environment: input.execution_environment,
    execution_options_digest: input.execution_options_digest,
    effects: [],
    issues: [],
  };
  for (const step of definition.steps) {
    if (step.kind === "call")
      manifest.issues.push({ step_id: step.id, code: "unbound_workflow_call" });
    if (step.kind !== "request") continue;
    const issue = (code: ManifestIssueCode) => manifest.issues.push({ step_id: step.id, code });
    const binding = bindings.get(step.id);
    if (!binding) {
      issue("missing_binding");
      continue;
    }
    const declaredDriver = step.mcp
      ? "mcp"
      : step.sql
        ? "postgres"
        : step.graphql
          ? "graphql"
          : step.s3
            ? "s3"
            : "http";
    if (
      binding.tenant_id !== input.tenant_id ||
      binding.connector_id !== (step.connector_id ?? null) ||
      binding.driver !== declaredDriver ||
      binding.request_digest !== workflowJsonDigest(step)
    )
      issue("binding_mismatch");
    if (binding.environment !== input.execution_environment) issue("environment_mismatch");
    const readPath =
      binding.driver === "http" && binding.read_path
        ? readPathBoundary(step, binding.read_path.origin)
        : null;
    const supportedReadPath =
      readPath &&
      workflowJsonDigest(readPath) === workflowJsonDigest(binding.read_path) &&
      binding.target === readPathTarget(readPath);
    if (binding.read_path && !supportedReadPath) issue("binding_mismatch");
    // Conservative first version: runtime substitutions anywhere in a request
    // may change a recipient in its body, not just a hostname in its URL.
    if (
      !binding.target ||
      (hasRuntimeValue(step) &&
        !(
          binding.driver === "http" &&
          (supportedReadPath ||
            supportsReadQuery(step) ||
            (binding.report_delivery && supportsReportDelivery(step, binding.target)))
        )) ||
      hasRuntimeValue(binding.target) ||
      binding.rewrites_target
    )
      issue("dynamic_request");
    if (binding.report_delivery && !supportsReportDelivery(step, binding.target))
      issue("binding_mismatch");
    const effect = effectOf(step, binding);
    if (effect === "unknown") issue("unknown_effect");
    if (effect === "destructive") issue("destructive_effect");
    manifest.effects.push({
      ...binding,
      ...(binding.driver === "http" && supportsReadQuery(step)
        ? { read_query: readQueryBoundary(step) }
        : {}),
      operation: operationOf(step, binding.driver),
      effect,
    });
  }
  manifest.effects.sort((a, b) => (a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0));
  manifest.issues.sort((a, b) =>
    `${a.step_id}:${a.code}` < `${b.step_id}:${b.code}`
      ? -1
      : `${a.step_id}:${a.code}` > `${b.step_id}:${b.code}`
        ? 1
        : 0,
  );
  return {
    manifest,
    digest: workflowJsonDigest(manifest),
    eligible_for_repeated_runs: manifest.issues.length === 0,
  };
}
