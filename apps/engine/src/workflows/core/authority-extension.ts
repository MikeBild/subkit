import { type AuthorityBoundary, sameBoundary } from "./authority.ts";

type ExtensionFacts =
  | Readonly<{ stage: "review"; expected_digest: string; previous_digest: string }>
  | Readonly<{ stage: "previous"; revoked: boolean; open_ended: boolean }>
  | Readonly<{
      stage: "live";
      valid_from_ms: number;
      valid_until_ms: number | null;
      now_ms: number;
      max_runs: number | null;
      reserved_runs: number;
    }>
  | Readonly<{
      stage: "preview";
      current_digest: string;
      previous_digest: string;
      eligible_for_repeated_runs: boolean;
    }>;

type ExtensionDecision =
  | Readonly<{ kind: "proceed" | "unchanged" }>
  | Readonly<{ kind: "rejected"; code: string; message: string }>;

export function decideAuthorityExtension(facts: ExtensionFacts): ExtensionDecision {
  switch (facts.stage) {
    case "review":
      return facts.previous_digest === facts.expected_digest
        ? { kind: "proceed" }
        : {
            kind: "rejected",
            code: "authority_manifest_changed",
            message: "the reviewed approval changed; review again",
          };
    case "previous":
      if (facts.revoked)
        return {
          kind: "rejected",
          code: "authority_revoked",
          message: "this approval was revoked; review a new boundary",
        };
      return { kind: facts.open_ended ? "unchanged" : "proceed" };
    case "live":
      return facts.valid_from_ms > facts.now_ms ||
        (facts.valid_until_ms !== null && facts.valid_until_ms <= facts.now_ms) ||
        (facts.max_runs !== null && facts.reserved_runs >= facts.max_runs)
        ? {
            kind: "rejected",
            code: "authority_not_live",
            message: "only an approval that currently applies can be made open-ended",
          }
        : { kind: "proceed" };
    case "preview":
      if (facts.current_digest !== facts.previous_digest)
        return {
          kind: "rejected",
          code: "authority_manifest_changed",
          message: "what the workflow may do changed; review again",
        };
      return facts.eligible_for_repeated_runs
        ? { kind: "proceed" }
        : {
            kind: "rejected",
            code: "authority_effect_unbound",
            message:
              "the workflow requires concrete-run review for an unbound or unavailable effect",
          };
  }
}

export function reusableOpenEndedSuccessor(
  successor: (AuthorityBoundary & Readonly<{ valid_until: Date | null }>) | null,
  previous: AuthorityBoundary,
): boolean {
  return successor !== null && successor.valid_until === null && sameBoundary(successor, previous);
}
