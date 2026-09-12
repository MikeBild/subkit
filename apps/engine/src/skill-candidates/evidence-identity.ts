interface Evidence {
  execution_id?: string | null;
  patch_candidate_id?: string | null;
  evidence_type: string;
  summary: string;
}

export function evidenceIdentity(evidence: Evidence): string {
  return JSON.stringify([
    evidence.evidence_type,
    evidence.execution_id ?? null,
    evidence.patch_candidate_id ?? null,
    evidence.execution_id || evidence.patch_candidate_id ? null : evidence.summary,
  ]);
}

export function uniqueEvidence<T extends Evidence>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [evidenceIdentity(item), item])).values()];
}
