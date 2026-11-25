import { scrubString } from "@shared/redaction.ts";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import { isSensitiveQueryKey } from "../connectors/egress.ts";
import { RECORDED_URL_MASK } from "../connectors/recorded-url.ts";
import { type ConnectorSystem, loadConnectorSystem } from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { executionVisibilityFilter } from "../execution/execution-owner.ts";
import { contentPublicationShape } from "./content-publication-boundary.ts";
import {
  alignFromEnd,
  applyStepProposal,
  baseDepth,
  commonFolder,
  contentCeiling,
  evidenceKind,
  folderSegments,
  MAX_LISTED_LENGTH,
  observedContentBytes,
  observedKey,
  observedUrl,
  type PathPart,
  type PathRewrite,
  type ProposedRule,
  pageCeiling,
  pathTemplate,
  preferredEvidence,
  proposedRule,
  queryValue,
  rewriteObserved,
  runCeiling,
  type StepEvidence,
  type StepProposal,
  splitQueryFromPath,
  wholePathValue,
  wholePathVariable,
  wholePlaceholder,
  withoutOrigin,
} from "./core/boundary-derivation.ts";
import { onlyVaultHandles } from "./core/vault-uses.ts";
import { gateRequestBoundary } from "./effect-resolution.ts";
import { hasRuntimeValue, supportsReportDelivery } from "./report-delivery-boundary.ts";
import {
  pathValueAllowed,
  type RequestBoundary,
  type RequestBoundaryRefusal,
  requestBoundaryTarget,
  VALUE_CLASSES,
} from "./request-boundary.ts";
import {
  compileStorageBoundary,
  type StorageBoundary,
  type StorageBoundaryRefusal,
  storageBaseUrl,
} from "./storage-boundary.ts";
import type { RequestStep, WorkflowDef } from "./types.ts";

const EVIDENCE_ROWS = 2000;
const UNMEASURED_CONTENT_BYTES = 1024;

type Environment = "dev" | "prod";

type UnproposableReason =
  | "no_history"
  | "path_not_comparable"
  | "values_not_describable"
  | "body_size_unknown"
  | "not_supported"
  | "sensitive_value"
  | "still_refused";

type ProposedRequestView = Pick<
  RequestBoundary,
  | "method"
  | "origin"
  | "destination"
  | "segments"
  | "variables"
  | "query"
  | "max_body_bytes"
  | "max_calls"
  | "pagination"
  | "destructive"
>;

type ProposedStorageView = Pick<
  StorageBoundary,
  "operation" | "key_prefix" | "max_bytes" | "max_keys" | "max_deletes"
>;

interface ProposalEvidence {
  observations: number;
  sample: string;
  newest_at: string;
  kind: "sent" | "trial";
}

interface Widening {
  field: "key_prefix" | "max_bytes";
  from: string | number;
  to: string | number;
}

export interface ProposedStepBoundary extends StepProposal {
  request?: ProposedRequestView;
  storage?: ProposedStorageView;
  widens?: Widening[];
  evidence: ProposalEvidence;
}

interface UnproposableStep {
  step_id: string;
  reason: UnproposableReason;
  refusal?: RequestBoundaryRefusal | StorageBoundaryRefusal;
}

export interface BoundaryProposals {
  proposals: ProposedStepBoundary[];
  unproposable: UnproposableStep[];
}

type Derived =
  | { proposal: StepProposal; evidence: ProposalEvidence; widens?: Widening[]; reason?: never }
  | { reason: UnproposableReason; refusal?: RequestBoundaryRefusal | StorageBoundaryRefusal };

function refused(reason: UnproposableReason, refusal?: UnproposableStep["refusal"]): Derived {
  return refusal ? { reason, refusal } : { reason };
}

async function observations(
  db: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    environment: Environment;
    viewer: ResolvedPrincipal;
    step_ids: readonly string[];
  },
): Promise<Map<string, StepEvidence[]>> {
  const byStep = new Map<string, StepEvidence[]>();
  if (params.step_ids.length === 0) return byStep;
  const rows = await db
    .select({
      step_key: sql<string>`regexp_replace(${executionSteps.step_key}, '\\[[0-9]+\\]$', '')`,
      url: sql<string | null>`${executionSteps.request_meta} ->> 'url'`,
      key: sql<string | null>`${executionSteps.request_meta} ->> 'key'`,
      pages: sql<
        number | null
      >`nullif(${executionSteps.request_meta} ->> 'pages_fetched', '')::int`,
      bytes: sql<number | null>`nullif(${executionSteps.request_meta} ->> 'bytes_out', '')::int`,
      prefix: sql<string | null>`${executionSteps.request_meta} ->> 'prefix'`,
      prepared: sql<StepEvidence["prepared"]>`
        ${executionSteps.request_meta} -> 'extras' -> 'prepared_request_review'
      `,
      trial: sql<boolean>`(
        ${executionSteps.held}
        or coalesce(${executionSteps.request_meta} -> 'extras' -> 'held' = 'true'::jsonb, false)
      )`,
      held: sql<StepEvidence["held"]>`(
        select el -> ${executionSteps.step_key} -> 'held_request'
        from jsonb_array_elements(${executionSteps.output_preview}) el
        where jsonb_typeof(${executionSteps.output_preview}) = 'array'
          and jsonb_exists(el, ${executionSteps.step_key})
        limit 1
      )`,
      execution_id: executionSteps.execution_id,
      version_id: executions.workflow_version_id,
      at: executions.created_at,
    })
    .from(executionSteps)
    .innerJoin(
      executions,
      and(
        eq(executions.id, executionSteps.execution_id),
        eq(executions.tenant_id, executionSteps.tenant_id),
      ),
    )
    .where(
      and(
        eq(executionSteps.tenant_id, params.tenant_id),
        eq(executions.workflow_id, params.workflow_id),
        eq(executions.execution_mode, params.environment),
        executionVisibilityFilter(params.viewer),
        eq(executionSteps.status, "succeeded"),
        isNotNull(executionSteps.request_meta),
        sql`regexp_replace(${executionSteps.step_key}, '\\[[0-9]+\\]$', '') = ANY(${sql.param(params.step_ids as string[])}::text[])`,
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(EVIDENCE_ROWS);
  for (const { step_key, ...row } of rows) {
    if (!observedUrl(row) && !row.key && !row.prefix) continue;
    const list = byStep.get(step_key);
    if (list) list.push(row);
    else byStep.set(step_key, [row]);
  }
  return byStep;
}

async function connectorSystems(
  db: Executor,
  tenant_id: string,
  environment: Environment,
  ids: readonly string[],
): Promise<Map<string, ConnectorSystem>> {
  const systems = new Map<string, ConnectorSystem>();
  for (const id of ids) {
    const system = await loadConnectorSystem(tenant_id, id, environment, db);
    if (system) systems.set(id, system);
  }
  return systems;
}

function looksSecret(value: string): boolean {
  return scrubString(value) !== value;
}

function needsPageCeiling(step: RequestStep): boolean {
  return step.pagination !== undefined && step.pagination.max_pages === undefined;
}

function pagesSeen(seen: readonly StepEvidence[]): number[] {
  return seen.flatMap((entry) => (entry.pages === null ? [] : [entry.pages]));
}

function sizesSeen(seen: readonly StepEvidence[]): number[] {
  return seen.flatMap((entry) => {
    const bytes = observedContentBytes(entry);
    return bytes === null ? [] : [bytes];
  });
}

function methodOf(step: RequestStep): string {
  return (step.method ?? "GET").toUpperCase();
}

function derivePageCeiling(step: RequestStep, seen: readonly StepEvidence[]): Derived {
  if (!needsPageCeiling(step)) return refused("not_supported");
  const cap = pageCeiling(pagesSeen(seen));
  const newest = seen.find((entry) => observedUrl(entry)) ?? seen[0];
  if (cap === null || !newest) return refused("no_history");
  return {
    proposal: { step_id: step.id, max_pages: cap },
    evidence: {
      observations: seen.filter((entry) => entry.pages).length,
      sample: "",
      newest_at: newest.at.toISOString(),
      kind: evidenceKind(seen),
    },
  };
}

function queryVariables(
  step: RequestStep,
  rewrite: PathRewrite | null,
): Map<string, string> | null {
  const names = new Map<string, string>();
  for (const [key, value] of Object.entries({ ...step.query, ...rewrite?.query })) {
    if (!hasRuntimeValue(key) && onlyVaultHandles(value)) continue;
    const name = wholePlaceholder(value);
    if (name !== null) names.set(key, name);
    else if (hasRuntimeValue(value) || hasRuntimeValue(key)) return null;
  }
  return names;
}

function unmaskedLiterals(rewrite: PathRewrite): (url: string) => boolean {
  const literal = Object.entries(rewrite.query).flatMap(([key, value]) =>
    hasRuntimeValue(value) ? [] : [key],
  );
  return (url) => literal.every((key) => queryValue(url, key) !== RECORDED_URL_MASK);
}

function pathValues(
  parts: readonly PathPart[],
  urls: readonly string[],
  base_url: string | null,
): { aligned: string[]; values: Map<string, string[]>; whole: string | null } | UnproposableReason {
  const whole = wholePathVariable(parts);
  const values = new Map<string, string[]>();
  if (whole !== null) {
    if (baseDepth(base_url) !== 0) return "not_supported";
    const aligned = urls.filter((url) => wholePathValue(url) !== null);
    if (aligned.length === 0) return "path_not_comparable";
    if (!aligned.every((url) => pathValueAllowed(wholePathValue(url) ?? "")))
      return "values_not_describable";
    return { aligned, values, whole };
  }
  for (const part of parts) if (typeof part !== "string") values.set(part.var, []);
  const aligned: string[] = [];
  for (const url of urls) {
    const found = alignFromEnd(parts, url);
    if (!found) continue;
    aligned.push(url);
    for (const [name, value] of found) values.get(name)?.push(value);
  }
  return aligned.length === 0 ? "path_not_comparable" : { aligned, values, whole };
}

function deriveRequest(
  step: RequestStep,
  seen: readonly StepEvidence[],
  base_url: string | null,
): Derived {
  if (step.boundary !== undefined) return derivePageCeiling(step, seen);
  const authored = step.path ?? step.url;
  if (!authored || (step.path !== undefined && step.url !== undefined))
    return refused("not_supported");
  const rewrite = pathTemplate(authored) ? null : splitQueryFromPath(authored);
  const parts = pathTemplate(withoutOrigin(rewrite?.path ?? authored));
  if (!parts) return refused("path_not_comparable");
  const queried = queryVariables(step, rewrite);
  if (!queried) return refused("still_refused", "query_placeholder_unsupported");
  if ([...queried.keys()].some(isSensitiveQueryKey)) return refused("sensitive_value");
  const located = seen.flatMap((entry) => {
    const url = observedUrl(entry);
    return url ? [{ url, at: entry.at }] : [];
  });
  const newest = located[0];
  if (!newest) return refused("no_history");
  const urls = located.map((entry) => entry.url);
  if (rewrite && !rewriteObserved(rewrite, parts, urls.filter(unmaskedLiterals(rewrite))))
    return refused("path_not_comparable");
  const path = pathValues(parts, urls, base_url);
  if (typeof path === "string") return refused(path);
  for (const [key, name] of queried) {
    const list = path.values.get(name) ?? [];
    path.values.set(name, list);
    for (const url of path.aligned) {
      const value = queryValue(url, key);
      if (value === RECORDED_URL_MASK) return refused("values_not_describable");
      if (value !== null) list.push(value);
    }
  }
  const method = methodOf(step);
  const removes = method === "DELETE";
  const variables: Record<string, ProposedRule> = {};
  if (path.whole !== null) variables[path.whole] = { class: "path" };
  for (const [name, values] of path.values) {
    const rule = name.startsWith("caller.")
      ? { caller_bound: true as const }
      : proposedRule(values, VALUE_CLASSES, removes, looksSecret);
    if (!rule) return refused("values_not_describable");
    variables[name] = rule;
  }
  const sendsContent = step.body !== undefined && method !== "GET" && method !== "HEAD";
  const sizes = sizesSeen(seen);
  if (sendsContent && sizes.length === 0) return refused("body_size_unknown");
  const cap = needsPageCeiling(step) ? pageCeiling(pagesSeen(seen)) : undefined;
  if (cap === null) return refused("no_history");
  return {
    proposal: {
      step_id: step.id,
      ...(cap === undefined ? {} : { max_pages: cap }),
      ...(rewrite ? { path_rewrite: rewrite } : {}),
      boundary: {
        variables,
        max_body_bytes: sendsContent ? contentCeiling(Math.max(...sizes)) : 0,
        max_calls: runCeiling(seen.map((entry) => entry.execution_id)),
        ...(removes ? { destructive: true as const } : {}),
      },
    },
    evidence: {
      observations: path.aligned.length,
      sample: "",
      newest_at: newest.at.toISOString(),
      kind: evidenceKind(seen),
    },
  };
}

function deriveStorage(step: RequestStep, seen: readonly StepEvidence[]): Derived | null {
  const keyed = seen.flatMap((entry) => {
    const key = observedKey(entry);
    return key ? [{ key, entry }] : [];
  });
  const keys = keyed.map((entry) => entry.key);
  const prefixes = seen.flatMap((entry) => (entry.prefix ? [entry.prefix] : []));
  const newest = seen.find((entry) => observedKey(entry) || entry.prefix);
  const declared = step.s3?.scope;
  if (!newest) return declared === undefined ? refused("no_history") : null;
  const folder =
    keys.length > 0 ? commonFolder(keys) : commonFolder(prefixes.map((prefix) => `${prefix}x`));
  if (!folder) return refused("values_not_describable");
  const method = methodOf(step);
  const removes = method === "DELETE";
  const written = sizesSeen(seen);
  const folderFits =
    declared === undefined ||
    [...keys, ...prefixes].every((value) => value.startsWith(declared.key_prefix));
  const ceilingFits =
    declared === undefined || written.length === 0 || Math.max(...written) <= declared.max_bytes;
  const deletesFit = !removes || declared?.max_deletes !== undefined;
  if (declared !== undefined && folderFits && ceilingFits && deletesFit) return null;
  if (method === "PUT" && written.length === 0) return refused("body_size_unknown");
  const key_prefix = folderFits && declared ? declared.key_prefix : folder;
  if (
    key_prefix !== declared?.key_prefix &&
    folderSegments(key_prefix).some(
      (segment) => segment.length > MAX_LISTED_LENGTH || looksSecret(segment),
    )
  )
    return refused("sensitive_value");
  const max_bytes =
    written.length > 0
      ? contentCeiling(Math.max(...written))
      : (declared?.max_bytes ?? contentCeiling(UNMEASURED_CONTENT_BYTES));
  const widens: Widening[] = declared
    ? [
        ...(key_prefix === declared.key_prefix
          ? []
          : [{ field: "key_prefix" as const, from: declared.key_prefix, to: key_prefix }]),
        ...(max_bytes > declared.max_bytes
          ? [{ field: "max_bytes" as const, from: declared.max_bytes, to: max_bytes }]
          : []),
      ]
    : [];
  return {
    proposal: {
      step_id: step.id,
      s3_scope: {
        key_prefix,
        max_bytes: declared && max_bytes < declared.max_bytes ? declared.max_bytes : max_bytes,
        ...(removes
          ? {
              max_deletes:
                declared?.max_deletes ?? runCeiling(keyed.map((entry) => entry.entry.execution_id)),
            }
          : {}),
      },
    },
    ...(widens.length > 0 ? { widens } : {}),
    evidence: {
      observations: keys.length + prefixes.length,
      sample: "",
      newest_at: newest.at.toISOString(),
      kind: evidenceKind(seen),
    },
  };
}

function resolvedTarget(step: RequestStep, base_url: string | null): string | null {
  try {
    const url = resolveUrl(base_url, step.path ?? step.url ?? "/");
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

async function gateRequest(step: RequestStep, system: ConnectorSystem | undefined) {
  const base_url = system?.connector.base_url ?? null;
  const target = resolvedTarget(step, base_url);
  const stricter =
    supportsReportDelivery(step, target) ||
    contentPublicationShape(step, base_url ?? target) !== null;
  return gateRequestBoundary({
    step,
    system: system ?? null,
    credentials: await system?.getAuthorityMetadata(),
    stricter_profile: stricter ? "stricter_profile_applies" : null,
    read_path: false,
  });
}

async function settle(
  step: RequestStep,
  derived: Derived,
  connector: ConnectorSystem | undefined,
): Promise<{ proposal: ProposedStepBoundary } | { unproposable: UnproposableStep }> {
  if (derived.reason !== undefined) return { unproposable: { step_id: step.id, ...derived } };
  const applied = applyStepProposal(step, derived.proposal);
  if (step.s3) {
    const compiled = compileStorageBoundary(applied, storageBaseUrl(connector?.connector.config));
    if (compiled.refusal)
      return {
        unproposable: { step_id: step.id, reason: "still_refused", refusal: compiled.refusal },
      };
    const { operation, key_prefix, max_bytes, max_keys, max_deletes } = compiled.boundary;
    return {
      proposal: {
        ...derived.proposal,
        storage: {
          operation,
          key_prefix,
          max_bytes,
          max_keys,
          ...(max_deletes === undefined ? {} : { max_deletes }),
        },
        ...(derived.widens ? { widens: derived.widens } : {}),
        evidence: { ...derived.evidence, sample: key_prefix },
      },
    };
  }
  const compiled = await gateRequest(applied, connector);
  if (compiled.refusal)
    return {
      unproposable: { step_id: step.id, reason: "still_refused", refusal: compiled.refusal },
    };
  if (!compiled.boundary) return { unproposable: { step_id: step.id, reason: "not_supported" } };
  const { method, origin, destination, segments, variables, query, max_body_bytes, max_calls } =
    compiled.boundary;
  return {
    proposal: {
      ...derived.proposal,
      request: {
        method,
        ...(origin !== undefined ? { origin } : {}),
        ...(destination ? { destination } : {}),
        ...(segments ? { segments } : {}),
        variables,
        query,
        max_body_bytes,
        max_calls,
        ...(compiled.boundary.pagination ? { pagination: compiled.boundary.pagination } : {}),
        ...(compiled.boundary.destructive ? { destructive: true as const } : {}),
      },
      evidence: { ...derived.evidence, sample: requestBoundaryTarget(compiled.boundary) },
    },
  };
}

function isOpen(step: RequestStep): boolean {
  return (
    (step.boundary === undefined && step.s3?.scope === undefined) ||
    step.s3?.scope !== undefined ||
    needsPageCeiling(step)
  );
}

export async function proposeBoundaries(
  db: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    definition: WorkflowDef;
    version_id?: string | null;
    environment: Environment;
    viewer: ResolvedPrincipal;
  },
): Promise<BoundaryProposals> {
  const open = params.definition.steps.flatMap((step) =>
    step.kind === "request" && isOpen(step) ? [step] : [],
  );
  const seen = await observations(db, {
    tenant_id: params.tenant_id,
    workflow_id: params.workflow_id,
    environment: params.environment,
    viewer: params.viewer,
    step_ids: open.map((step) => step.id),
  });
  const connectorIds = [
    ...new Set(open.flatMap((step) => (step.connector_id ? [step.connector_id] : []))),
  ];
  const known = await connectorSystems(db, params.tenant_id, params.environment, connectorIds);
  const proposals: ProposedStepBoundary[] = [];
  const unproposable: UnproposableStep[] = [];
  for (const step of open) {
    const connector = step.connector_id ? known.get(step.connector_id) : undefined;
    const rows = seen.get(step.id) ?? [];
    const history = params.version_id ? preferredEvidence(rows, params.version_id) : rows;
    const derived = step.s3
      ? deriveStorage(step, history)
      : step.sql || step.mcp || step.graphql || step.xml || step.multipart
        ? refused("not_supported")
        : deriveRequest(step, history, connector?.connector.base_url ?? null);
    if (derived === null) continue;
    const settled = await settle(step, derived, connector);
    if ("proposal" in settled) proposals.push(settled.proposal);
    else unproposable.push(settled.unproposable);
  }
  return { proposals, unproposable };
}
