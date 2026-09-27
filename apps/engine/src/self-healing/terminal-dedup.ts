import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
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

/** Fingerprint of the drift a candidate was created to heal — read from the
 *  `drift_signal` the candidate stored at creation. `null` for candidates
 *  with no recorded signal (legacy rows, workflow-scoped signals). */
export function candidateDriftFingerprint(
  candidate: typeof patchCandidates.$inferSelect,
): string | null {
  const diff = candidate.diff as { drift_signal?: unknown } | null;
  return diff?.drift_signal == null ? null : signalFingerprint(diff.drift_signal as DriftSignal);
}

/** Fingerprint of a live drift signal — the same canonical form candidates
 *  store, so a candidate and a fresh signal are directly comparable. */
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

/**
 * An `inapplicable` candidate was proven undecidable against ONE workflow
 * version. It suppresses re-proposal only while the workflow still sits on
 * that version — strictly, never the lenient either-side-null boundary: a new
 * version is exactly what can make a repair possible again, so it re-opens
 * evaluation. Without the strict match the sweep would close, the next scan
 * re-propose, and the pair would loop on every cadence tick.
 */
function matchesInapplicableBoundary(
  candidate: typeof patchCandidates.$inferSelect,
  params: {
    connector_id: string | null;
    endpoint_key: string | null;
    base_version_id?: string | null;
    workflow_step_id?: string | null;
  },
  fingerprint: string,
): boolean {
  const diff = candidate.diff as Record<string, unknown>;
  const candidateFingerprint = candidateDriftFingerprint(candidate);
  return (
    !!candidate.closed_against_version_id &&
    candidate.closed_against_version_id === params.base_version_id &&
    (!params.workflow_step_id ||
      !diff.workflow_step_id ||
      diff.workflow_step_id === params.workflow_step_id) &&
    // Same legacy fallback as the active lookup: a row with no stored signal
    // on an anchored endpoint dedups by endpoint alone.
    (candidateFingerprint === fingerprint ||
      (candidateFingerprint === null && !!params.connector_id && !!params.endpoint_key))
  );
}

/**
 * Find an already-active patch candidate (status proposed|applied) for
 * the same endpoint anchor, newest first. The proactive scan uses this
 * to refresh-or-skip instead of inserting a fresh row every cadence
 * tick — including workflow-scoped signals whose endpoint fields are null.
 */
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
  // return the active candidate that heals THIS drift's fingerprint,
  // not merely the most-recent candidate on the endpoint. The pre-fix
  // single-row lookup masked new breakage: when an endpoint had an applied
  // candidate for drift A and a genuinely different drift B appeared, the
  // lookup returned A and the `status==="applied"` short-circuit skipped B —
  // so B was never proposed or healed. Matching by fingerprint (the same
  // canonical form findMatchingTerminalEndpointCandidate uses) lets a new
  // drift fall through to a fresh proposal while the same drift still dedups.
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
  // No fingerprint match. A legacy candidate (created before drift_signal was
  // stored) carries no fingerprint to compare — dedup against it to preserve
  // the old endpoint-only behaviour and avoid re-proposal flood for those
  // rows. If every active candidate is fingerprinted and none match, this is
  // a NEW drift → return null so it gets a fresh proposal.
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
