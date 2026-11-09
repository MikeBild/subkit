import type { PatchProposal } from "../llm/flows/repair.ts";
import { log } from "../logging/logger.ts";
import { classifyPatch as classifyPatchDecision } from "./core/classifier.ts";
import type { DriftSignal, PatchDecision } from "./types.ts";

export { classifyRateLimitFromTemplate, type RateLimitPatchCandidate } from "./core/classifier.ts";

export function classifyPatch(proposal: PatchProposal, signal: DriftSignal | null): PatchDecision {
  const decision = classifyPatchDecision(proposal, signal);
  log.selfHealing.patch.classified({
    patch_kind: proposal.kind,
    classification: decision.classification,
    reasons: decision.reasons,
  });
  return decision;
}
