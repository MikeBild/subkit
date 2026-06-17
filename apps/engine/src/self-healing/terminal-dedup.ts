import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import type { DriftSignal } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

function candidateDriftFingerprint(candidate: typeof patchCandidates.$inferSelect): string | null {
  const diff = candidate.diff as { drift_signal?: unknown } | null;
  return diff?.drift_signal == null ? null : stableStringify(diff.drift_signal);
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
