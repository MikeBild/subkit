// critic — terminal-step rubric pass.
//
// Runs after the converse loop hits any of its terminal stop
// conditions (committedStopCondition, pausedStopCondition, or
// stepCountIs with a non-paused state). Delegates to a per-kind Zod
// rubric, calls the tenant default model via `generateObject`, and
// returns a structured verdict the loop uses to decide:
//   - pass        → commit / publish proceeds
//   - fail        → push verdict back into the loop for one revision
//   - low-confidence → emit ask_user_text elicitation (Step 5 / lever 15)
//
// Step 0 ships a no-op `runCritic` so the loop can call into it
// without behavior change. Step 4 fills the rubrics.

import type { SubkitLlm } from "../core/base-types.ts";
import { chatRubric } from "./rubrics/chat.ts";
import type { CommitDraftArtifact } from "./rubrics/commit-draft.ts";
import { commitDraftRubric } from "./rubrics/commit-draft.ts";
import type { ProposeWorkflowArtifact } from "./rubrics/propose-workflow.ts";
import { proposeWorkflowRubric } from "./rubrics/propose-workflow.ts";

export type CriticKind = "commit_draft" | "propose_workflow" | "chat";

export type CriticArtifact =
  | { kind: "commit_draft"; payload: CommitDraftArtifact }
  | { kind: "propose_workflow"; payload: ProposeWorkflowArtifact }
  | { kind: "chat"; payload: string };

export interface CriticVerdict {
  verdict: "pass" | "fail";
  /** 0..1 — below 0.6 the loop should abstain via ask_user_text. */
  confidence: number;
  /** Why the verdict came out this way. Surfaced to the model on revise. */
  reason: string;
  /** Concrete fix the model should apply on the revision pass. */
  hint?: string;
}

export interface RunCriticParams {
  kind: CriticKind;
  artifact: CriticArtifact;
  /** Tenant snapshot text for grounding. Empty string when none. */
  snapshot?: string;
  /** Tenant default LLM, already initialised. */
  llm: SubkitLlm;
}

const DEFAULT_PASS: CriticVerdict = {
  verdict: "pass",
  confidence: 1,
  reason: "critic disabled (Step 0 scaffold)",
};

/**
 * Step 0 stub. Returns pass with confidence 1.0 unconditionally. The
 * rubric modules are wired but their judge prompts are filled in
 * Step 4 / lever 10.
 */
export async function runCritic(_params: RunCriticParams): Promise<CriticVerdict> {
  return DEFAULT_PASS;
}

export { chatRubric, commitDraftRubric, proposeWorkflowRubric };
