import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import {
  candidateDriftFingerprint,
  candidateProposal as candidateProposalCore,
  inapplicableBoundaryMatches,
  matchesCandidateBoundary,
  signalFingerprint,
} from "./core/terminal-dedup.ts";
import { isExecutionStepId } from "./step-snapshot.ts";
import type { DriftSignal } from "./types.ts";

export { signalFingerprint } from "./core/terminal-dedup.ts";

export function candidateProposal(
  candidate: Parameters<typeof candidateProposalCore>[0],
): PatchProposal {
  return candidateProposalCore(candidate) as PatchProposal;
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
  return inapplicableBoundaryMatches(
    candidate,
    params,
    fingerprint,
    candidate.closed_reason === "no_step_anchor" && signalCarriesAnchor(params),
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
