// Product-local compilation only. This module grants no authority and performs
// no discovery, credential refresh, or network request. Its resolved bindings
// must come from the server's version/connector snapshot, never a client claim.
import { z } from "@hono/zod-openapi";
import { classifyHttpSideEffect, inferGraphqlOperation } from "@shared/index.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import {
  ContentPublicationBoundarySchema,
  supportsContentPublication,
} from "./content-publication-boundary.ts";
import { ReadPathBoundarySchema, readPathBoundary, readPathTarget } from "./read-path-boundary.ts";
import {
  hasRuntimeValue,
  ReadQueryBoundarySchema,
  ReportDeliveryBoundarySchema,
  readQueryBoundary,
  supportsReadQuery,
  supportsReportDelivery,
} from "./report-delivery-boundary.ts";
import {
  RequestBoundarySchema,
  requestBoundary,
  requestBoundaryTarget,
} from "./request-boundary.ts";
import { StorageBoundarySchema, storageBoundary, storageTarget } from "./storage-boundary.ts";
import { JsonValueSchema, type RequestStep, WorkflowDefSchema } from "./types.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const environment = z.enum(["dev", "prod"]);

/** Which call step an effect or issue came through. Exactly one element: a
 *  called workflow that itself calls one is refused, so nothing nests deeper.
 *  An array, not a joined string — step ids have no grammar, so any separator
 *  would be ambiguous in a workflow whose step id contains it. */
export const CallPathSchema = z.array(z.string().min(1)).length(1);
export type CallPath = z.infer<typeof CallPathSchema>;

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
    content_publication: ContentPublicationBoundarySchema.optional(),
    read_path: ReadPathBoundarySchema.optional(),
    storage: StorageBoundarySchema.optional(),
    boundary: RequestBoundarySchema.optional(),
  })
  .strict();
export type ResolvedEffectBinding = z.infer<typeof ResolvedEffectBindingSchema>;

/** One `call` step's target, resolved by the caller: which workflow version it
 *  starts and how that version's own requests are bound. The compiler compiles
 *  it here rather than trusting a summary, so a child's effects are reviewed on
 *  the same terms as the parent's. */
export const ResolvedCallSchema = z
  .object({
    step_id: z.string().min(1),
    workflow_id: z.string().uuid(),
    workflow_slug: z.string().min(1),
    workflow_version_id: z.string().uuid(),
    execution_options_digest: digest,
    definition: JsonValueSchema,
    bindings: z.array(ResolvedEffectBindingSchema).max(200),
  })
  .strict();
export type ResolvedCall = z.infer<typeof ResolvedCallSchema>;

/** What the approval pins about a called workflow. Slug and name are display
 *  only and stay out: renaming a workflow must not invalidate a grant, while
 *  changing what it DOES must. */
const CallPinSchema = z
  .object({
    step_id: z.string().min(1),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    workflow_digest: digest,
    execution_options_digest: digest,
  })
  .strict();

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
    calls: z.array(ResolvedCallSchema).max(50).optional(),
    // What steps of this workflow have really written, newest per step. Never
    // part of the manifest — evidence for a check, not a permission — and
    // absent unless the resolver found any, so a workflow with no history
    // compiles to the byte-identical manifest it always did.
    observed_keys: z
      .array(z.object({ step_id: z.string().min(1), key: z.string().min(1) }).strict())
      .max(200)
      .optional(),
  })
  .strict();

/** Why a `call` step was left unbound. Travels beside the manifest, never in
 *  it: a refusal is a reason for the author, not part of what was approved. */
export type CallRefusalReason =
  /** No resolvable target: archived, deleted, or another tenant's. */
  | "child_unavailable"
  /** The step does not name exactly one fixed workflow, so which workflow runs
   *  could change between the approval and the run. */
  | "target_not_static"
  /** The called workflow calls one itself. Approving it would mean approving a
   *  chain whose far end nobody reviewed. */
  | "child_calls_workflow";
export interface CallRefusal {
  step_id: string;
  reason: CallRefusalReason;
}

const ManifestIssueCodeSchema = z.enum([
  "missing_binding",
  "binding_mismatch",
  "environment_mismatch",
  "dynamic_request",
  "unknown_effect",
  "destructive_effect",
  "unbound_workflow_call",
  // A folder this workflow's own history contradicts. Not a guess: a key this
  // very step wrote, which the declared folder does not contain.
  "boundary_contradicted_by_history",
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
        call_path: CallPathSchema.optional(),
      }),
    ),
    issues: z.array(
      z.object({
        step_id: z.string(),
        code: ManifestIssueCodeSchema,
        call_path: CallPathSchema.optional(),
      }),
    ),
    // Absent when this workflow calls none. Present-but-empty would be a second
    // way to say the same thing, and the digest would tell the two apart.
    calls: z.array(CallPinSchema).min(1).optional(),
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
  call_refusals: CallRefusal[];
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
  const callIds = new Set(
    definition.steps.filter((step) => step.kind === "call").map((step) => step.id),
  );
  const calls = new Map<string, ResolvedCall>();
  for (const call of input.calls ?? []) {
    if (calls.has(call.step_id) || !callIds.has(call.step_id)) {
      throw new Error("resolved calls must identify each call step at most once");
    }
    calls.set(call.step_id, call);
  }
  const call_refusals: CallRefusal[] = [];
  const pins: z.infer<typeof CallPinSchema>[] = [];
  const observed = new Map((input.observed_keys ?? []).map((seen) => [seen.step_id, seen.key]));
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
    if (step.kind === "call") {
      const call = calls.get(step.id);
      const refusal = callRefusalFor(step, call);
      if (refusal) {
        call_refusals.push({ step_id: step.id, reason: refusal });
        manifest.issues.push({ step_id: step.id, code: "unbound_workflow_call" });
        continue;
      }
      if (!call) continue;
      // The child is compiled here, by the same code that compiles this
      // workflow — never summarised by its resolver. It is compiled WITHOUT
      // `calls`, so a child that calls a workflow fails closed a second time:
      // it would raise `unbound_workflow_call` even if the refusal above were
      // ever weakened.
      const child = compileWorkflowEffectManifest({
        tenant_id: input.tenant_id,
        workflow_id: call.workflow_id,
        workflow_version_id: call.workflow_version_id,
        execution_environment: input.execution_environment,
        execution_options_digest: call.execution_options_digest,
        definition: call.definition,
        bindings: call.bindings,
      });
      const call_path: CallPath = [step.id];
      for (const effect of child.manifest.effects) {
        // A child never receives the proposal-derived profiles, so carrying one
        // means the resolver handed it something it was not offered. Report it
        // rather than fold a permission nobody reviewed for this context.
        if (effect.report_delivery || effect.content_publication) {
          manifest.issues.push({ step_id: effect.step_id, code: "binding_mismatch", call_path });
        }
        manifest.effects.push({ ...effect, call_path });
      }
      for (const issue of child.manifest.issues) {
        manifest.issues.push({ ...issue, call_path });
      }
      pins.push({
        step_id: step.id,
        workflow_id: call.workflow_id,
        workflow_version_id: call.workflow_version_id,
        workflow_digest: child.manifest.workflow_digest,
        execution_options_digest: call.execution_options_digest,
      });
      continue;
    }
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
    const storage =
      binding.driver === "s3" && binding.storage
        ? storageBoundary(step, binding.storage.base_url)
        : null;
    const supportedStorage =
      storage &&
      workflowJsonDigest(storage) === workflowJsonDigest(binding.storage) &&
      binding.target === storageTarget(storage);
    if (binding.storage && !supportedStorage) issue("binding_mismatch");
    // A folder this step's own history contradicts. Only a key it really
    // wrote counts; a step that never ran, or ran without recording one, says
    // nothing and is left alone. The declared folder is otherwise unmeasurable
    // at review: a write is held in every preview, so the first proof it is
    // wrong would be the first scheduled run after a human approved it.
    const seenKey = binding.storage ? observed.get(step.id) : undefined;
    if (seenKey !== undefined && !seenKey.startsWith(binding.storage?.key_prefix ?? ""))
      issue("boundary_contradicted_by_history");
    // An authored boundary takes precedence over the derived read profiles. The
    // same `!step.boundary` guard sits at every place a read profile is
    // consulted, so a step's target and its dispatch assert come from exactly
    // one source. A step WITHOUT `boundary` takes the path it always took.
    const readPath =
      binding.driver === "http" && !step.boundary && binding.read_path
        ? readPathBoundary(step, binding.read_path.origin)
        : null;
    const supportedReadPath =
      readPath &&
      workflowJsonDigest(readPath) === workflowJsonDigest(binding.read_path) &&
      binding.target === readPathTarget(readPath);
    if (binding.read_path && !supportedReadPath) issue("binding_mismatch");
    // One definition, used for BOTH the `dynamic_request` exemption and the
    // `read_query` assert spread below. Deciding them separately left a gap: a
    // step whose authored boundary was refused stayed exempt as a read query
    // while its assert was suppressed — exempt, and checked by nothing.
    const readQuery = binding.driver === "http" && !step.boundary && supportsReadQuery(step);
    const recompiledBoundary =
      binding.driver === "http" && binding.boundary
        ? requestBoundary(step, binding.boundary.base_url)
        : null;
    const supportedBoundary =
      recompiledBoundary !== null &&
      workflowJsonDigest(recompiledBoundary) === workflowJsonDigest(binding.boundary) &&
      binding.target === requestBoundaryTarget(recompiledBoundary);
    if (binding.boundary && !supportedBoundary) issue("binding_mismatch");
    const supportedContent =
      binding.driver === "http" &&
      binding.content_publication &&
      supportsContentPublication(step, binding.content_publication, binding.target);
    if (binding.content_publication && !supportedContent) issue("binding_mismatch");
    if (binding.content_publication?.kind === "content_release") {
      const publication = binding.content_publication;
      for (const source of publication.sources) {
        const producer = bindings.get(source.step_id);
        if (
          producer?.connector_id !== binding.connector_id ||
          producer?.content_publication?.kind !== "content_revision" ||
          producer.content_publication.origin !== publication.origin ||
          workflowJsonDigest(producer.content_publication.item_ids) !==
            workflowJsonDigest(source.item_ids)
        )
          issue("binding_mismatch");
      }
    }
    // Conservative first version: runtime substitutions anywhere in a request
    // may change a recipient in its body, not just a hostname in its URL.
    if (
      !binding.target ||
      (hasRuntimeValue(step) &&
        !(
          supportedStorage ||
          // `supportedBoundary` belongs INSIDE the http guard. `supportedStorage`
          // sits outside it; copying that position would let an author clear an
          // S3 step's `dynamic_request` without ever declaring a folder.
          (binding.driver === "http" &&
            (supportedBoundary ||
              supportedReadPath ||
              supportedContent ||
              readQuery ||
              (binding.report_delivery && supportsReportDelivery(step, binding.target))))
        )) ||
      hasRuntimeValue(binding.target) ||
      binding.rewrites_target
    )
      issue("dynamic_request");
    if (binding.report_delivery && !supportsReportDelivery(step, binding.target))
      issue("binding_mismatch");
    const effect = effectOf(step, binding);
    if (effect === "unknown") issue("unknown_effect");
    // A removal stays classified `destructive` so the review card keeps showing
    // it as one. What a reviewed storage boundary removes is the BLOCKING issue
    // — and only when that boundary reproduces from the step and names a
    // ceiling, which is the same predicate that exempts it from
    // `dynamic_request` above.
    if (
      effect === "destructive" &&
      !(
        supportedStorage &&
        binding.storage?.operation === "DELETE" &&
        binding.storage.max_deletes !== undefined
      ) &&
      // An HTTP DELETE is grantable only when its author declared it
      // destructive and the boundary reproduces from the step.
      !(supportedBoundary && binding.boundary?.destructive === true)
    )
      issue("destructive_effect");
    manifest.effects.push({
      ...binding,
      ...(readQuery ? { read_query: readQueryBoundary(step) } : {}),
      operation: operationOf(step, binding.driver),
      effect,
    });
  }
  if (pins.length > 0) {
    manifest.calls = pins.sort((a, b) =>
      a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0,
    );
  }
  manifest.effects.sort(
    (a, b) =>
      comparePath(a.call_path, b.call_path) ||
      (a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0),
  );
  manifest.issues.sort(
    (a, b) =>
      comparePath(a.call_path, b.call_path) ||
      // The step/code key stays a concatenation for byte-identical ordering
      // with every manifest compiled before call paths existed. A step id may
      // contain `:`, so this is not a safe key in general — only an unchanged
      // one.
      (`${a.step_id}:${a.code}` < `${b.step_id}:${b.code}`
        ? -1
        : `${a.step_id}:${a.code}` > `${b.step_id}:${b.code}`
          ? 1
          : 0),
  );
  return {
    manifest,
    digest: workflowJsonDigest(manifest),
    eligible_for_repeated_runs: manifest.issues.length === 0,
    call_refusals: call_refusals.sort((a, b) =>
      a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0,
    ),
  };
}

/** Own effects before called ones, and within a call, by its step id. Element
 *  by element with the shorter path first, so the order never depends on how a
 *  path might have been flattened into a string. */
function comparePath(a: CallPath | undefined, b: CallPath | undefined): number {
  const left = a ?? [];
  const right = b ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i] ?? "";
    const y = right[i] ?? "";
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/** Why this call step cannot be folded into the approval, or null when it can.
 *  The static-target rule lives here rather than in `CallStepSchema`: adding a
 *  refinement or a default there would change every workflow's normalized
 *  definition, and with it every execution-options digest — invalidating live
 *  approvals that have nothing to do with calls. */
function callRefusalFor(
  step: { workflow_id?: string | undefined; workflow_slug?: string | undefined },
  call: ResolvedCall | undefined,
): CallRefusalReason | null {
  const byId = typeof step.workflow_id === "string" && step.workflow_id.length > 0;
  const bySlug = typeof step.workflow_slug === "string" && step.workflow_slug.length > 0;
  if (byId === bySlug) return "target_not_static";
  if (hasRuntimeValue(step.workflow_id ?? step.workflow_slug ?? "")) return "target_not_static";
  if (!call) return "child_unavailable";
  // The resolver looked the target up; this re-checks that what it returned is
  // what the step names, so a resolver bug cannot substitute another workflow.
  if (byId && call.workflow_id !== step.workflow_id) return "target_not_static";
  if (bySlug && call.workflow_slug !== step.workflow_slug) return "target_not_static";
  const childDefinition = WorkflowDefSchema.safeParse(call.definition);
  if (!childDefinition.success) return "child_unavailable";
  if (childDefinition.data.steps.some((childStep) => childStep.kind === "call"))
    return "child_calls_workflow";
  return null;
}
