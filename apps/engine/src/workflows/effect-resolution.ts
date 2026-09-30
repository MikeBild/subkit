// Server-only preparation. Reading a version must not execute it, decrypt a
// credential, refresh OAuth, or invoke a connector probe.
import { z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import {
  connectorUnavailability,
  type FoundConnectorUnavailability,
} from "../execution/connector-availability.ts";
import { authorityConnectorConfiguration } from "./authority-configuration.ts";
import { authorityExecutionShape, type ResolvedCallShape } from "./authority-execution-shape.ts";
import { contradictedStorageBoundaries } from "./boundary-evidence.ts";
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
import {
  compileWorkflowEffectManifest,
  type ResolvedCall,
  type ResolvedEffectBinding,
} from "./effect-manifest.ts";
import { readPathBoundary, readPathTarget } from "./read-path-boundary.ts";
import { hasRuntimeValue, supportsReportDelivery } from "./report-delivery-boundary.ts";
import {
  proposeReportDeliveryBoundaries,
  type ReportDeliveryBoundaries,
  type ReportDeliveryEvidence,
} from "./report-delivery-proposal.ts";
import {
  compileRequestBoundary,
  type RequestBoundary,
  type RequestBoundaryRefusal,
  requestBoundaryTarget,
} from "./request-boundary.ts";
import {
  compileStorageBoundary,
  type StorageBoundaryRefusal,
  storageBaseUrl,
  storageTarget,
} from "./storage-boundary.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

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

/** A connector that cannot serve one of this workflow's own steps in the
 *  previewed environment. Reported beside the manifest, never inside it. */
export interface UnavailableConnector {
  step_id: string;
  connector_id: string;
  connector_slug: string;
  connector_name: string;
  reason: FoundConnectorUnavailability;
}

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
/**
 * Which refusal a step under a stricter profile actually earned.
 *
 * A content publication has its own review and is unchanged. For a report
 * e-mail the honest answer depends on what the evidence shows, and saying so is
 * the whole point: "no preparation run exists" is fixed by letting one run,
 * "the run reached the step and observed nothing usable" is fixed by looking at
 * that step, and "the run never reached the step" cannot be fixed by running
 * another one — the step sits behind a branch whose condition depends on the
 * writes a preparation holds back. A person told to run a preparation for that
 * third case is being sent in a circle.
 *
 * `null` when the profile already produced a boundary: there is nothing
 * refused, and reporting one made every healthy report step carry a refusal on
 * every single preview.
 */
function profileRefusal(
  step_id: string,
  isContent: boolean,
  evidence: ReportDeliveryEvidence | undefined,
): RequestBoundaryRefusal | null {
  if (isContent) return "stricter_profile_applies";
  if (evidence?.boundaries[step_id]) return null;
  if (evidence?.prepared === false) return "report_delivery_unprepared";
  if (evidence?.reached && !evidence.reached.has(step_id)) return "report_delivery_unreachable";
  return "report_delivery_unobserved";
}

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
  const own = await resolveBindings(input, definition, db, options);
  const bindings = own.bindings;
  const unavailable_steps = own.unavailable_steps;
  // The root's own steps only: a run's admission resolves this workflow's
  // connectors, not those of a workflow it calls, and a connector listed here
  // blocks an environment in the run dialog.
  const unavailable_connectors = own.unavailable_connectors;
  const storage_refusals = own.storage_refusals;
  const request_refusals = own.request_refusals;
  const contentShapes = own.contentShapes;
  // Each workflow this one starts is resolved by the same code, one level
  // deep. A child never receives the proposal-derived profiles: those were
  // reviewed for THIS workflow's context, and handing them down would grant a
  // permission in a place nobody looked at. Passing EMPTY maps rather than
  // omitting them also stops the child from proposing its own.
  const calls: ResolvedCall[] = [];
  const callShapes: ResolvedCallShape[] = [];
  for (const step of definition.steps) {
    if (step.kind !== "call") continue;
    const resolved = await resolveCall(step, input, db);
    if (!resolved) continue;
    calls.push(resolved.call);
    callShapes.push(resolved.shape);
    // A child step whose connector is unavailable makes the CALLING step
    // unavailable: that is the step this workflow's reader can act on.
    if (resolved.unavailable_steps.length > 0) unavailable_steps.push(step.id);
    for (const refusal of resolved.storage_refusals)
      storage_refusals.push({ ...refusal, call_path: [step.id] });
    for (const refusal of resolved.request_refusals)
      request_refusals.push({ ...refusal, call_path: [step.id] });
  }
  // What this workflow's own steps have really written. Looked up once, for
  // the storage steps that declare a folder, and passed as evidence — the
  // compiler decides, this only supplies the facts.
  const declaredFolders = bindings.flatMap((binding) =>
    binding.storage ? [{ step_id: binding.step_id, key_prefix: binding.storage.key_prefix }] : [],
  );
  const contradictions = await contradictedStorageBoundaries(db, {
    tenant_id: input.tenant_id,
    workflow_id: input.workflow_id,
    declared: declaredFolders,
  });
  const compiled = compileWorkflowEffectManifest({
    ...input,
    ...(contradictions.length > 0
      ? {
          observed_keys: contradictions.map((entry) => ({
            step_id: entry.step_id,
            key: entry.observed_key,
          })),
        }
      : {}),
    execution_options_digest: workflowJsonDigest({
      runtime_options_digest: input.execution_options_digest,
      normalized_definition: definition,
    }),
    definition: version.dag,
    bindings,
    ...(calls.length > 0 ? { calls } : {}),
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
      ? { execution_shape: authorityExecutionShape(definition, bindings, callShapes) }
      : {}),
    unavailable_steps,
    unavailable_connectors,
    storage_refusals,
    request_refusals,
    ...(contradictions.length > 0 ? { boundary_contradictions: contradictions } : {}),
    eligible_for_repeated_runs:
      compiled.eligible_for_repeated_runs && unavailable_steps.length === 0,
  };
}

/** Everything a workflow's own steps resolve to: which connector and
 *  credential each request binds, which boundary profile it earned, and why a
 *  step earned none. Called once for this workflow and once per workflow it
 *  starts, so a child is resolved by exactly the code that resolves a parent.
 */
async function resolveBindings(
  input: z.infer<typeof inputSchema>,
  definition: WorkflowDef,
  db: Executor,
  options: {
    report_boundaries?: ReportDeliveryBoundaries;
    content_boundaries?: ContentPublicationBoundaries;
  },
) {
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
  let reportEvidence: ReportDeliveryEvidence | undefined =
    options.report_boundaries === undefined ? undefined : { boundaries: options.report_boundaries };
  const bindings: ResolvedEffectBinding[] = [];
  const unavailable_steps: string[] = [];
  // Which connector keeps a step from running, and why — decided by the same
  // predicate the run admission refuses with, so the run dialog can say
  // beforehand what the run would be refused for.
  const unavailable_connectors: UnavailableConnector[] = [];
  // Why an s3 step compiled no boundary. Reported beside the manifest, never
  // inside it: this is repair evidence, and the digest must not depend on it.
  const storage_refusals: Array<{
    step_id: string;
    reason: StorageBoundaryRefusal;
    call_path?: string[];
  }> = [];
  // The same for an HTTP request boundary: why it was refused, beside the
  // manifest and never inside it.
  const request_refusals: Array<{
    step_id: string;
    reason: RequestBoundaryRefusal;
    call_path?: string[];
  }> = [];
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
    const unavailability = connector
      ? connectorUnavailability(connector, credentials, connector.auth_type !== "none")
      : null;
    if (connector && unavailability) {
      unavailable_steps.push(step.id);
      unavailable_connectors.push({
        step_id: step.id,
        connector_id: connector.id,
        connector_slug: connector.slug,
        connector_name: connector.display_name,
        reason: unavailability,
      });
    }
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
    const compiledStorage =
      driver === "s3" ? compileStorageBoundary(step, storageBaseUrl(connector?.config)) : null;
    const storage = compiledStorage?.boundary ?? null;
    if (compiledStorage?.refusal)
      storage_refusals.push({ step_id: step.id, reason: compiledStorage.refusal });
    if (storage) target = storageTarget(storage);
    // An authored boundary takes precedence over the derived read profiles, so a
    // step's target comes from exactly one place. Steps without `boundary` take
    // bit-for-bit the path they took before — that is what keeps live grants valid.
    const authoredBoundary = driver === "http" && step.boundary !== undefined;
    const readPath =
      driver === "http" && !authoredBoundary ? readPathBoundary(step, connector?.base_url) : null;
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
    if (reportEvidence === undefined && supportsReportDelivery(step, target))
      reportEvidence = await proposeReportDeliveryBoundaries(input, db);
    // An author who states the recipient is believed here and held to it at
    // dispatch, where the real message is decoded and compared byte for byte.
    // It takes precedence over an observation because it is the more specific
    // statement: an observation says what one run happened to do, this says
    // what every run may do. Only for a step the profile actually covers —
    // elsewhere it would be a field with no meaning that a reviewer still reads.
    const declaredDelivery =
      step.report_delivery && supportsReportDelivery(step, target) ? step.report_delivery : null;
    let boundary: RequestBoundary | null = null;
    if (driver === "http" && (authoredBoundary || hasRuntimeValue(step))) {
      // A report e-mail or a content publication has its own stricter review
      // (the recipient, the receipts). `boundary` must not be a way around it.
      const stricter = supportsReportDelivery(step, target) || contentShape !== null;
      const profile = stricter
        ? declaredDelivery
          ? null
          : profileRefusal(step.id, contentShape !== null, reportEvidence)
        : undefined;
      // The profile produced a boundary, so nothing is refused. Reporting one
      // anyway made every healthy report step carry a refusal on every preview
      // — noise that buries the steps a person actually has to act on.
      if (!stricter || profile !== null) {
        const compiled = stricter
          ? ({ refusal: profile as RequestBoundaryRefusal } as const)
          : // The connector itself appends query parameters (query-mode auth or
            // `static_query`), so dispatch would never match a reviewed query.
            connector?.auth_type === "query" ||
              Object.keys(
                (connector?.config as { static_query?: Record<string, unknown> } | undefined)
                  ?.static_query ?? {},
              ).length > 0
            ? ({ refusal: "connector_adds_query" } as const)
            : compileRequestBoundary(step, connector?.base_url ?? null);
        if (compiled.refusal) request_refusals.push({ step_id: step.id, reason: compiled.refusal });
        else {
          boundary = compiled.boundary;
          target = requestBoundaryTarget(compiled.boundary);
        }
      }
    }
    const configuration = authorityConnectorConfiguration(connector);
    bindings.push({
      tenant_id: input.tenant_id,
      step_id: step.id,
      ...(supportedContent ? { content_publication: contentBoundary } : {}),
      ...(readPath ? { read_path: readPath } : {}),
      ...(storage ? { storage } : {}),
      ...(boundary ? { boundary } : {}),
      ...(declaredDelivery
        ? { report_delivery: declaredDelivery }
        : reportEvidence?.boundaries[step.id] && supportsReportDelivery(step, target)
          ? { report_delivery: reportEvidence.boundaries[step.id] }
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
      //
      // A cursor injects response data into the next request, which is why
      // pagination counted as rewriting the target. A boundary that NAMES the
      // paging keys is exactly the constraint that was missing: origin and path
      // stay fixed, every other key stays exact, and the step's page cap bounds
      // how many requests there can be. Without such a boundary a paginating
      // step still rewrites its target and still needs concrete-run review.
      rewrites_target:
        (Boolean(step.pagination) && !boundary?.pagination) ||
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
  return {
    bindings,
    unavailable_steps,
    unavailable_connectors,
    storage_refusals,
    request_refusals,
    contentShapes,
  };
}

/** One `call` step's target, resolved one level deep.
 *
 * Returns nothing when the step does not name exactly one workflow or the
 * target cannot be loaded — the compiler turns that into the refusal the
 * author reads, so the reason is decided in one place rather than two. A child
 * that itself calls a workflow IS returned, with no bindings: the compiler
 * refuses it as `child_calls_workflow`, and resolving its grandchildren here
 * would be work whose result is thrown away.
 */
async function resolveCall(
  step: { id: string; workflow_id?: string | undefined; workflow_slug?: string | undefined },
  input: z.infer<typeof inputSchema>,
  db: Executor,
): Promise<{
  call: ResolvedCall;
  shape: ResolvedCallShape;
  unavailable_steps: string[];
  storage_refusals: Array<{ step_id: string; reason: StorageBoundaryRefusal }>;
  request_refusals: Array<{ step_id: string; reason: RequestBoundaryRefusal }>;
} | null> {
  const byId = typeof step.workflow_id === "string" && step.workflow_id.length > 0;
  const bySlug = typeof step.workflow_slug === "string" && step.workflow_slug.length > 0;
  if (byId === bySlug) return null;
  const [row] = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      version_id: workflows.current_version_id,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, input.tenant_id),
        byId
          ? eq(workflows.id, step.workflow_id as string)
          : eq(workflows.slug, step.workflow_slug as string),
        eq(workflows.lifecycle, "active"),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!row?.version_id) return null;
  const [version] = await db
    .select({ dag: workflowVersions.dag, version: workflowVersions.version })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, input.tenant_id),
        eq(workflowVersions.workflow_id, row.id),
        eq(workflowVersions.id, row.version_id),
      ),
    )
    .limit(1);
  const parsed = WorkflowDefSchema.safeParse(version?.dag);
  if (!version || !parsed.success) return null;
  const childInput = {
    ...input,
    workflow_id: row.id,
    workflow_version_id: row.version_id,
  };
  // The options digest uses the ROOT's formula over the CHILD's normalized
  // definition, so a child whose step schema normalizes differently moves the
  // parent's digest and the approval is re-asked for.
  const execution_options_digest = workflowJsonDigest({
    runtime_options_digest: input.execution_options_digest,
    normalized_definition: parsed.data,
  });
  const callsItself = parsed.data.steps.some((childStep) => childStep.kind === "call");
  const resolved = callsItself
    ? {
        bindings: [],
        unavailable_steps: [] as string[],
        storage_refusals: [] as Array<{ step_id: string; reason: StorageBoundaryRefusal }>,
        request_refusals: [] as Array<{ step_id: string; reason: RequestBoundaryRefusal }>,
      }
    : await resolveBindings(childInput, parsed.data, db, {
        report_boundaries: {},
        content_boundaries: {},
      });
  return {
    call: {
      step_id: step.id,
      workflow_id: row.id,
      workflow_slug: row.slug,
      workflow_version_id: row.version_id,
      execution_options_digest,
      definition: version.dag as never,
      bindings: resolved.bindings,
    },
    shape: {
      step_id: step.id,
      workflow_id: row.id,
      workflow_slug: row.slug,
      workflow_name: row.name,
      version: version.version,
      definition: parsed.data,
      bindings: resolved.bindings,
    },
    unavailable_steps: resolved.unavailable_steps,
    storage_refusals: resolved.storage_refusals,
    request_refusals: resolved.request_refusals,
  };
}
