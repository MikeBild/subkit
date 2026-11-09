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

export function newCandidateEvidence<T extends Evidence>(
  existing: readonly Evidence[],
  incoming: readonly T[],
  limit: number,
): T[] {
  const remaining = limit - existing.length;
  if (remaining <= 0) return [];
  const keys = new Set(existing.map(evidenceIdentity));
  return uniqueEvidence(incoming)
    .filter((item) => !keys.has(evidenceIdentity(item)))
    .slice(0, remaining);
}

export function mergeCandidateEvidence<T extends Evidence>(
  existing: readonly Evidence[],
  incoming: readonly T[],
  capacity: number,
): Readonly<{ additions: readonly T[]; retained: readonly Evidence[] }> {
  const additions = newCandidateEvidence(existing, incoming, capacity);
  return { additions, retained: [...existing, ...additions].slice(0, capacity) };
}
