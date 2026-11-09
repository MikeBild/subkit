export const LEARNING_PATTERN_KINDS = ["session_learning", "knowledge_learning"] as const;

const CONTEXT_PATTERN_KINDS: ReadonlySet<string> = new Set([
  "failure_pattern",
  "authoring_capability",
]);

export function initialCandidateStatus(kind: string): "proposed" | "context" {
  return CONTEXT_PATTERN_KINDS.has(kind) ? "context" : "proposed";
}

export type ExistingCandidateDecision =
  | Readonly<{ kind: "skip"; reason: "rejected" | "superseded" | "approved" }>
  | Readonly<{ kind: "update"; version: number }>;

export function decideExistingCandidate(
  current: Readonly<{ status: string; version: number }>,
): ExistingCandidateDecision {
  if (
    current.status === "rejected" ||
    current.status === "superseded" ||
    current.status === "approved"
  )
    return { kind: "skip", reason: current.status };
  return { kind: "update", version: current.version + 1 };
}

export type SignalUpsertDecision =
  | Readonly<{ kind: "insert"; initial_status: "proposed" | "context"; supersede_open: boolean }>
  | Readonly<{ kind: "skip"; reason: "rejected" | "superseded" | "approved" }>
  | Readonly<{ kind: "update"; version: number }>;

export function decideSignalUpsert(
  existing: Readonly<{ status: string; version: number }>,
  signal: Readonly<{ pattern_kind: string; endpoint_key?: string | null }>,
): ExistingCandidateDecision;
export function decideSignalUpsert(
  existing: null,
  signal: Readonly<{ pattern_kind: string; endpoint_key?: string | null }>,
): Extract<SignalUpsertDecision, { kind: "insert" }>;
export function decideSignalUpsert(
  existing: Readonly<{ status: string; version: number }> | null,
  signal: Readonly<{ pattern_kind: string; endpoint_key?: string | null }>,
): SignalUpsertDecision {
  if (existing) return decideExistingCandidate(existing);
  return {
    kind: "insert",
    initial_status: initialCandidateStatus(signal.pattern_kind),
    supersede_open: !signal.endpoint_key,
  };
}
