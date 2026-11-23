export type PatchInteractionEvent = "tested" | "accepted" | "accepted_partly" | "declined";

export interface PatchInteraction {
  at: string;
  event: PatchInteractionEvent;
  actor_type: string;
  actor_id: string | null;
  ok: boolean | null;
  accepted_operations: number[] | null;
  declined_operations: number[] | null;
  reason: string | null;
}

export interface PatchAuditFact {
  ts: Date;
  action: string;
  result: string;
  actor_type: string;
  actor_id: string | null;
  reason: string | null;
  metadata: unknown;
}

export const PATCH_INTERACTION_ACTIONS = [
  "patch_candidate.dry_run_requested",
  "patch_candidate.approved",
  "patch_candidate.rejected",
] as const;

function indices(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((entry) => Number.isInteger(entry))
    ? (value as number[])
    : null;
}

function eventOf(fact: PatchAuditFact, accepted: number[] | null): PatchInteractionEvent | null {
  if (fact.result !== "success") return null;
  if (fact.action === "patch_candidate.dry_run_requested") return "tested";
  if (fact.action === "patch_candidate.rejected") return "declined";
  if (fact.action === "patch_candidate.approved") return accepted ? "accepted_partly" : "accepted";
  return null;
}

export function interactionLog(facts: readonly PatchAuditFact[]): PatchInteraction[] {
  return [...facts]
    .sort((a, b) => a.ts.getTime() - b.ts.getTime())
    .flatMap((fact) => {
      const metadata =
        fact.metadata && typeof fact.metadata === "object"
          ? (fact.metadata as Record<string, unknown>)
          : {};
      const accepted = indices(metadata.accepted_operations);
      const event = eventOf(fact, accepted);
      if (!event) return [];
      return [
        {
          at: fact.ts.toISOString(),
          event,
          actor_type: fact.actor_type,
          actor_id: fact.actor_id,
          ok: event === "tested" && typeof metadata.ok === "boolean" ? metadata.ok : null,
          accepted_operations: accepted,
          declined_operations: indices(metadata.declined_operations),
          reason: fact.reason,
        },
      ];
    });
}
