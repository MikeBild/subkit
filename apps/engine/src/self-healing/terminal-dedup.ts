import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { isExecutionStepId } from "./step-snapshot.ts";
import type { DriftSignal } from "./types.ts";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function candidateDriftFingerprint(
  candidate: typeof patchCandidates.$inferSelect,
): string | null {
  const diff = candidate.diff as { drift_signal?: unknown } | null;
  return diff?.drift_signal == null ? null : signalFingerprint(diff.drift_signal as DriftSignal);
}

export function signalFingerprint(signal: DriftSignal): string {
  switch (signal.kind) {
    case "http_status_new_shape":
    case "endpoint_contract":
      return stableStringify({ ...signal, request: driftRequestIdentity(signal.request) });
    case "jsonata_path_miss":
      return stableStringify({
        kind: signal.kind,
        expression: signal.expression,
        missing_path: signal.missing_path,
      });
    case "validation_failed":
      return stableStringify({ kind: signal.kind, expression: signal.expression });
    case "gate_block":
      return stableStringify({
        kind: signal.kind,
        code: signal.code,
        reason: signal.reason,
        fixer: signal.fixer,
        step_id: signal.step_id,
      });
    case "schema_diff":
      return stableStringify({
        ...signal,
        added: [...signal.added].sort(),
        removed: [...signal.removed].sort(),
        widened: [...signal.widened].sort(),
      });
    default:
      return stableStringify(signal);
  }
}

function driftRequestIdentity(
  request: Extract<DriftSignal, { kind: "http_status_new_shape" }>["request"],
) {
  let origin: string | null = null;
  let path = request.path ?? null;
  if (request.url) {
    try {
      const url = new URL(request.url);
      origin = url.origin;
      path ??= url.pathname;
    } catch {
      path ??= request.url;
    }
  }
  return {
    method: request.method?.toUpperCase() ?? null,
    origin,
    path: path?.split(/[?#]/)[0] ?? null,
  };
}

export function candidateProposal(candidate: typeof patchCandidates.$inferSelect): PatchProposal {
  const diff = candidate.diff as { proposal?: PatchProposal } | null;
  return (
    diff?.proposal ?? {
      classification: candidate.classification,
      kind: "other",
      description: "terminal candidate skipped without re-running repair",
      patch: {},
      reasoning: "A terminal candidate already covers the same proactive drift fingerprint.",
    }
  );
}

export async function findMatchingTerminalEndpointCandidate(
  exec: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    connector_id: string | null;
    endpoint_key: string | null;
    signal: DriftSignal;
    base_version_id?: string | null;
    workflow_step_id?: string | null;
    step_id?: string | null;
  },
) {
  const rows = await exec
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, params.tenant_id),
        eq(patchCandidates.workflow_id, params.workflow_id),
        params.connector_id
          ? eq(patchCandidates.connector_id, params.connector_id)
          : isNull(patchCandidates.connector_id),
        params.endpoint_key
          ? eq(patchCandidates.endpoint_key, params.endpoint_key)
          : isNull(patchCandidates.endpoint_key),
        inArray(patchCandidates.status, ["rejected", "superseded", "inapplicable"]),
      ),
    )
    .orderBy(desc(patchCandidates.created_at));
  const fingerprint = signalFingerprint(params.signal);
  return (
    rows.find((r) =>
      r.status === "inapplicable"
        ? matchesInapplicableBoundary(r, params, fingerprint)
        : matchesCandidateBoundary(r, params) && candidateDriftFingerprint(r) === fingerprint,
    ) ?? null
  );
}

function signalCarriesAnchor(params: {
  workflow_step_id?: string | null;
  step_id?: string | null;
}): boolean {
  return !!params.workflow_step_id || isExecutionStepId(params.step_id);
}

function matchesInapplicableBoundary(
  candidate: typeof patchCandidates.$inferSelect,
  params: {
    connector_id: string | null;
    endpoint_key: string | null;
    base_version_id?: string | null;
    workflow_step_id?: string | null;
    step_id?: string | null;
  },
  fingerprint: string,
): boolean {
  const diff = candidate.diff as Record<string, unknown>;
  const candidateFingerprint = candidateDriftFingerprint(candidate);
  if (candidate.closed_reason === "no_step_anchor" && signalCarriesAnchor(params)) return false;
  return (
    !!candidate.closed_against_version_id &&
    candidate.closed_against_version_id === params.base_version_id &&
    (!params.workflow_step_id ||
      !diff.workflow_step_id ||
      diff.workflow_step_id === params.workflow_step_id) &&
    (candidateFingerprint === fingerprint ||
      (candidateFingerprint === null && !!params.connector_id && !!params.endpoint_key))
  );
}

export async function findActiveEndpointCandidate(
  exec: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    connector_id: string | null;
    endpoint_key: string | null;
    signal: DriftSignal;
    base_version_id?: string | null;
    workflow_step_id?: string | null;
  },
) {
  const rows = await exec
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, params.tenant_id),
        eq(patchCandidates.workflow_id, params.workflow_id),
        params.connector_id
          ? eq(patchCandidates.connector_id, params.connector_id)
          : isNull(patchCandidates.connector_id),
        params.endpoint_key
          ? eq(patchCandidates.endpoint_key, params.endpoint_key)
          : isNull(patchCandidates.endpoint_key),
        inArray(patchCandidates.status, ["proposed", "applied"]),
      ),
    )
    .orderBy(desc(patchCandidates.created_at));
  const fingerprint = signalFingerprint(params.signal);
  const match = rows.find(
    (r) => matchesCandidateBoundary(r, params) && candidateDriftFingerprint(r) === fingerprint,
  );
  if (match) return match;
  if (!params.connector_id || !params.endpoint_key) return null;
  return (
    rows.find(
      (r) => matchesCandidateBoundary(r, params) && candidateDriftFingerprint(r) === null,
    ) ?? null
  );
}

function matchesCandidateBoundary(
  candidate: typeof patchCandidates.$inferSelect,
  params: { base_version_id?: string | null; workflow_step_id?: string | null },
): boolean {
  const diff = candidate.diff as Record<string, unknown>;
  return (
    (!params.base_version_id ||
      !diff.base_version_id ||
      diff.base_version_id === params.base_version_id ||
      (candidate.status === "applied" && diff.applied_version_id === params.base_version_id)) &&
    (!params.workflow_step_id ||
      !diff.workflow_step_id ||
      diff.workflow_step_id === params.workflow_step_id)
  );
}
