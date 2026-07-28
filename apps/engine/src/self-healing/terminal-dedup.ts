import { and, desc, eq, inArray } from "drizzle-orm";
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
  return diff?.drift_signal == null ? null : stableStringify(diff.drift_signal);
}

/** Fingerprint of a live drift signal — the same canonical form candidates
 *  store, so a candidate and a fresh signal are directly comparable. */
export function signalFingerprint(signal: DriftSignal): string {
  return stableStringify(signal);
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
    connector_id: string;
    endpoint_key: string;
    signal: DriftSignal;
  },
) {
  const rows = await exec
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, params.tenant_id),
        eq(patchCandidates.workflow_id, params.workflow_id),
        eq(patchCandidates.connector_id, params.connector_id),
        eq(patchCandidates.endpoint_key, params.endpoint_key),
        inArray(patchCandidates.status, ["rejected", "superseded"]),
      ),
    )
    .orderBy(desc(patchCandidates.created_at))
    .limit(10);
  const fingerprint = stableStringify(params.signal);
  return rows.find((r) => candidateDriftFingerprint(r) === fingerprint) ?? null;
}

/**
 * Find an already-active patch candidate (status proposed|applied) for
 * the same endpoint anchor, newest first. The proactive scan uses this
 * to refresh-or-skip instead of inserting a fresh row every cadence
 * tick — the patch_candidates flood fix. Returns null when the signal
 * has no endpoint anchor (workflow-scoped drift) or none is active.
 */
export async function findActiveEndpointCandidate(
  exec: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    connector_id: string;
    endpoint_key: string;
    signal: DriftSignal;
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
        eq(patchCandidates.connector_id, params.connector_id),
        eq(patchCandidates.endpoint_key, params.endpoint_key),
        inArray(patchCandidates.status, ["proposed", "applied"]),
      ),
    )
    .orderBy(desc(patchCandidates.created_at))
    .limit(10);
  const fingerprint = signalFingerprint(params.signal);
  const match = rows.find((r) => candidateDriftFingerprint(r) === fingerprint);
  if (match) return match;
  // No fingerprint match. A legacy candidate (created before drift_signal was
  // stored) carries no fingerprint to compare — dedup against it to preserve
  // the old endpoint-only behaviour and avoid re-proposal flood for those
  // rows. If every active candidate is fingerprinted and none match, this is
  // a NEW drift → return null so it gets a fresh proposal.
  return rows.find((r) => candidateDriftFingerprint(r) === null) ?? null;
}
