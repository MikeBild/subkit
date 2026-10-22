import { z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { resolveGraphqlStepEndpoint } from "../connectors/drivers/graphql-endpoint.ts";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import {
  connectorUnavailability,
  type FoundConnectorUnavailability,
} from "../execution/connector-availability.ts";
import { transactionalWebhookAvailable } from "../execution/transactional-mail.ts";
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
import { factConnector, factVersion, type WorkflowReadFacts } from "./read-facts.ts";
import { readPathBoundary, readPathTarget } from "./read-path-boundary.ts";
import {
  hasRuntimeValue,
  reportDeliveryDiscrepancy,
  supportsReadQuery,
  supportsReportDelivery,
} from "./report-delivery-boundary.ts";
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
import { executableDefinition } from "./stored-definition.ts";
import { supportsTransactionalDelivery } from "./transactional-delivery-boundary.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

const inputSchema = z
  .object({
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    execution_environment: z.enum(["dev", "prod"]),
    execution_options_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export interface UnavailableConnector {
  step_id: string;
  connector_id: string;
  connector_slug: string;
  connector_name: string;
  reason: FoundConnectorUnavailability;
}

function displayTarget(url: URL): string | null {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`;
}

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
    facts?: WorkflowReadFacts | undefined;
    report_boundaries?: ReportDeliveryBoundaries;
    content_boundaries?: ContentPublicationBoundaries;
  } = {},
) {
  const input = inputSchema.parse(raw);
  if (options.facts && options.facts.tenant_id !== input.tenant_id)
    throw new Error("workflow facts tenant mismatch");
  const version = options.facts
    ? factVersion(options.facts, input.workflow_id, input.workflow_version_id)
    : (
        await db
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
          .limit(1)
      )[0];
  if (!version)
    throw Object.assign(new Error("workflow version unavailable"), {
      code: "workflow_version_unavailable",
    });
  const definition = executableDefinition(version.dag);
  const own = await resolveBindings(input, definition, db, options);
  const bindings = own.bindings;
  const unavailable_steps = own.unavailable_steps;
  const unavailable_connectors = own.unavailable_connectors;
  const storage_refusals = own.storage_refusals;
  const request_refusals = own.request_refusals;
  const contentShapes = own.contentShapes;
  const calls: ResolvedCall[] = [];
  const callShapes: ResolvedCallShape[] = [];
  for (const step of definition.steps) {
    if (step.kind !== "call") continue;
    const resolved = await resolveCall(step, input, db, options.facts);
    if (!resolved) continue;
    calls.push(resolved.call);
    callShapes.push(resolved.shape);
    if (resolved.unavailable_steps.length > 0) unavailable_steps.push(step.id);
    for (const refusal of resolved.storage_refusals)
      storage_refusals.push({ ...refusal, call_path: [step.id] });
    for (const refusal of resolved.request_refusals)
      request_refusals.push({ ...refusal, call_path: [step.id] });
  }
  const declaredFolders = bindings.flatMap((binding) =>
    binding.storage ? [{ step_id: binding.step_id, key_prefix: binding.storage.key_prefix }] : [],
  );
  const contradictions = await contradictedStorageBoundaries(
    db,
    {
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      declared: declaredFolders,
    },
    options.facts?.history,
  );
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
          !binding.report_delivery &&
          !binding.transactional_delivery),
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

async function resolveBindings(
  input: z.infer<typeof inputSchema>,
  definition: WorkflowDef,
  db: Executor,
  options: {
    facts?: WorkflowReadFacts | undefined;
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
      options.facts?.history,
    ));
  const contentShapes = new Map<string, ReturnType<typeof contentPublicationShape>>();
  let reportEvidence: ReportDeliveryEvidence | undefined =
    options.report_boundaries === undefined ? undefined : { boundaries: options.report_boundaries };
  const bindings: ResolvedEffectBinding[] = [];
  const unavailable_steps: string[] = [];
  const unavailable_connectors: UnavailableConnector[] = [];
  const storage_refusals: Array<{
    step_id: string;
    reason: StorageBoundaryRefusal;
    call_path?: string[];
  }> = [];
  const request_refusals: Array<{
    step_id: string;
    reason: RequestBoundaryRefusal;
    call_path?: string[];
  }> = [];
  for (const step of definition.steps) {
    if (step.kind !== "request") continue;
    const system = step.connector_id
      ? options.facts
        ? factConnector(options.facts, step.connector_id, input.execution_environment)
        : await loadConnectorSystem(
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
    const graphqlOnHttp = driver === "http" && step.graphql !== undefined;
    const restDriver = driver === "http" && !graphqlOnHttp;
    let target: string | null = null;
    try {
      if (graphqlOnHttp) {
        const endpoint = resolveGraphqlStepEndpoint({
          driver,
          base_url: connector?.base_url,
          auth_type: connector?.auth_type,
          path: step.path,
          url: step.url,
        });
        target = endpoint.ok && endpoint.url ? displayTarget(new URL(endpoint.url)) : null;
      }
      if (restDriver)
        target = displayTarget(
          connector
            ? resolveUrl(connector.base_url, step.path ?? step.url ?? "/")
            : new URL(step.url ?? ""),
        );
      if (driver === "graphql" && connector?.base_url)
        target = displayTarget(new URL(connector.base_url));
    } catch {}
    const compiledStorage =
      driver === "s3" ? compileStorageBoundary(step, storageBaseUrl(connector?.config)) : null;
    const storage = compiledStorage?.boundary ?? null;
    if (compiledStorage?.refusal)
      storage_refusals.push({ step_id: step.id, reason: compiledStorage.refusal });
    if (storage) target = storageTarget(storage);
    const authoredBoundary = restDriver && step.boundary !== undefined;
    const readPath =
      restDriver && !authoredBoundary ? readPathBoundary(step, connector?.base_url) : null;
    if (readPath) target = readPathTarget(readPath);
    const contentShape = restDriver
      ? contentPublicationShape(step, connector?.base_url ?? target)
      : null;
    contentShapes.set(step.id, contentShape);
    const contentBoundary = contentBoundaries[step.id];
    const supportedContent =
      contentShape &&
      contentBoundary &&
      supportsContentPublication(step, contentBoundary, contentShape.target);
    if (supportedContent) target = contentShape.target;
    const transactional =
      restDriver && supportsTransactionalDelivery(step, target)
        ? step.transactional_delivery
        : undefined;
    if (reportEvidence === undefined && supportsReportDelivery(step, target) && !transactional)
      reportEvidence = await proposeReportDeliveryBoundaries(input, db, options.facts?.history);
    const statedDelivery =
      step.report_delivery && supportsReportDelivery(step, target) ? step.report_delivery : null;
    const contradicted =
      statedDelivery !== null &&
      (reportEvidence?.inspections?.get(step.id) ?? []).some(
        (observation) =>
          !observation.ok || reportDeliveryDiscrepancy(statedDelivery, observation.boundary),
      );
    if (
      transactional &&
      (definition.execution_privacy !== "sensitive" ||
        !(await transactionalWebhookAvailable(
          db,
          input.tenant_id,
          input.workflow_id,
          transactional,
        )))
    )
      unavailable_steps.push(step.id);
    const declaredDelivery = contradicted ? null : statedDelivery;
    let boundary: RequestBoundary | null = null;
    if (restDriver && (authoredBoundary || hasRuntimeValue(step))) {
      const stricter = supportsReportDelivery(step, target) || contentShape !== null;
      const profile = stricter
        ? contradicted
          ? "report_delivery_contradicted"
          : declaredDelivery || transactional
            ? null
            : profileRefusal(step.id, contentShape !== null, reportEvidence)
        : undefined;
      if (!stricter || profile !== null) {
        const compiled = stricter
          ? ({ refusal: profile as RequestBoundaryRefusal } as const)
          : connector?.auth_type === "query" ||
              Object.keys(
                (connector?.config as { static_query?: Record<string, unknown> } | undefined)
                  ?.static_query ?? {},
              ).length > 0
            ? ({ refusal: "connector_adds_query" } as const)
            : compileRequestBoundary(step, connector?.base_url ?? null);
        const admittedAsRead =
          compiled.refusal === "no_boundary" &&
          !authoredBoundary &&
          (readPath !== null || supportsReadQuery(step));
        if (compiled.refusal) {
          if (!admittedAsRead)
            request_refusals.push({ step_id: step.id, reason: compiled.refusal });
        } else {
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
      ...(transactional ? { transactional_delivery: transactional } : {}),
      ...(declaredDelivery
        ? { report_delivery: declaredDelivery }
        : !transactional &&
            !contradicted &&
            reportEvidence?.boundaries[step.id] &&
            supportsReportDelivery(step, target)
          ? { report_delivery: reportEvidence.boundaries[step.id] }
          : {}),
      connector_id: step.connector_id ?? null,
      driver,
      environment: system?.environment ?? input.execution_environment,
      request_digest: workflowJsonDigest(step),
      target,
      configuration_digest: workflowJsonDigest(configuration),
      credential_binding_digest: credentials ? workflowJsonDigest(credentials.binding) : null,
      rewrites_target:
        (Boolean(step.pagination) && !boundary?.pagination) ||
        JSON.stringify({
          base_url: connector?.base_url,
          dsn: connector?.dsn,
          config: connector?.config,
        }).includes("${"),
    });
  }
  for (const binding of bindings) {
    const shape = contentShapes.get(binding.step_id);
    if (binding.content_publication || shape?.kind !== "content_release") continue;
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

async function resolveCall(
  step: { id: string; workflow_id?: string | undefined; workflow_slug?: string | undefined },
  input: z.infer<typeof inputSchema>,
  db: Executor,
  facts?: WorkflowReadFacts,
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
  const found = facts
    ? [...facts.workflows.values()].find(
        (workflow) =>
          workflow.lifecycle === "active" &&
          (byId ? workflow.id === step.workflow_id : workflow.slug === step.workflow_slug),
      )
    : undefined;
  const row = facts
    ? found
      ? { ...found, version_id: found.current_version_id }
      : undefined
    : (
        await db
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
          .limit(1)
      )[0];
  if (!row?.version_id) return null;
  const version = facts
    ? factVersion(facts, row.id, row.version_id)
    : (
        await db
          .select({ dag: workflowVersions.dag, version: workflowVersions.version })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.tenant_id, input.tenant_id),
              eq(workflowVersions.workflow_id, row.id),
              eq(workflowVersions.id, row.version_id),
            ),
          )
          .limit(1)
      )[0];
  const parsed = WorkflowDefSchema.safeParse(version?.dag);
  if (!version || !parsed.success) return null;
  const childInput = {
    ...input,
    workflow_id: row.id,
    workflow_version_id: row.version_id,
  };
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
        facts,
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
