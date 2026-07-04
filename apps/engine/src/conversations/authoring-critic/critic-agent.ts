// Authoring-time LLM critic — second-stage verifier for workflow drafts.
//
// Runs ONLY when `shouldRunCritic` returns `run:true`, on a draft that
// has already cleared every static gate inside `runAuthoringPipeline`
// (the `author_workflow` one-shot pipeline). Returns a structured
// verdict the pipeline either:
//   - ignores when passed=true, OR
//   - on passed=false feeds its `repairs` back into the SAME bounded
//     generation-repair loop as the static findings (one more grounded
//     regenerate pass), and surfaces the rejection as an advisory
//     `critic_rejection` on the successful tool result so the next
//     conversation turn escalates via `prior_failures`.
//
// The critic does NOT patch the draft. The verdict is hints only.
//
// Routing: the critic shares the tenant's primary `llm.*` route — there
// is no per-flow model knob. Cost control happens at the gate
// (`llm.critic.{enabled,min_steps,max_consecutive_rejections}`) and at
// the prompt cap (`RENDERED_DRAFT_CAP`). Operators wanting a cheaper
// model for the critic can lower the tenant's primary model — which
// affects every flow — or leave the critic off until a per-flow knob
// lands.

import type { Executor } from "../../db/client.ts";
import { invoke } from "../../llm/core/invoke.ts";
import { logger } from "../../logging/logger.ts";
import { recordCriticRun } from "../../observability/instrumentation.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { type AuthoringCriticVerdict, AuthoringCriticVerdictSchema } from "./types.ts";

/** Hard cap on the rendered draft string. Anthropic counts ~4 chars/token,
 *  so 4 KB ≈ 1 KTok of pure draft content — enough for ~30 medium steps
 *  but small enough to keep critic calls cheap even on pathological inputs. */
const RENDERED_DRAFT_CAP = 4096;

function renderDraftForCritic(draft: WorkflowDraftDocument): string {
  const body = [
    `Workflow: ${draft.name} (slug: ${draft.slug})`,
    draft.description ? `Description: ${draft.description}` : "",
    `Steps (${draft.steps.length}):`,
    JSON.stringify(draft.steps, null, 2),
    draft.output_transform ? `output_transform: ${draft.output_transform}` : "",
    draft.output_schema ? `output_schema: ${JSON.stringify(draft.output_schema)}` : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
  if (body.length <= RENDERED_DRAFT_CAP) return body;
  return `${body.slice(0, RENDERED_DRAFT_CAP)}\n…[truncated; original ${body.length} chars]`;
}

export interface RunCriticAgentParams {
  draft: WorkflowDraftDocument;
  tenant_id: string;
  /** Optional DB executor — passed through to `invoke()`. */
  db?: Executor;
  /** Optional abort signal — the pipeline threads its shared 120s
   *  deadline here so a critic call started late in the budget fails
   *  fast (fail-open) instead of overrunning the wall-clock ceiling. */
  signal?: AbortSignal;
}

/**
 * Invoke the authoring critic. Returns the parsed verdict, or a
 * fail-open `passed:true` placeholder when:
 *   - the LLM call itself errored (transient provider failure),
 *   - the provider returned text without a structured object, OR
 *   - the structured object failed `AuthoringCriticVerdictSchema`.
 *
 * The critic is an opt-in enhancement; transient provider errors and
 * contract drift must never block the build_workflow result.
 */
export async function runCriticAgent(
  params: RunCriticAgentParams,
): Promise<AuthoringCriticVerdict> {
  const draftText = renderDraftForCritic(params.draft);
  try {
    const result = await invoke<AuthoringCriticVerdict>(
      {
        flow: "critic_authoring",
        tenant_id: params.tenant_id,
        user_turns: [
          {
            role: "user",
            content: `Review this workflow draft for semantic drift:\n\n${draftText}`,
          },
        ],
        schema: AuthoringCriticVerdictSchema,
        ...(params.signal ? { signal: params.signal } : {}),
      },
      params.db,
    );
    if (!result.object) {
      // Provider returned text without a parseable object — fail open.
      logger.warn({
        module: "conversations",
        action: "critic.no_structured_output",
        msg: "critic returned text without a structured verdict; passing",
        tenant_id: params.tenant_id,
      });
      recordCriticRun({ result: "fail_open" });
      return { passed: true, repairs: [], rationale: "critic returned no structured verdict" };
    }
    // Re-parse through `AuthoringCriticVerdictSchema` so the preprocess
    // clamp (slice repairs to 5, truncate rationale to 800 chars) runs
    // on EVERY path. `invoke()` ships the schema to the provider as JSON
    // Schema; the preprocess function never executes on that path, so a
    // provider that returns more/longer entries than the contract allows
    // would otherwise slip through with the clamp silently inactive.
    const parsed = AuthoringCriticVerdictSchema.safeParse(result.object);
    if (!parsed.success) {
      logger.warn({
        module: "conversations",
        action: "critic.verdict_invalid",
        msg: "critic returned structured output that failed schema validation; passing",
        tenant_id: params.tenant_id,
        error: parsed.error.issues.map((i) => i.path.join(".")).join(","),
      });
      recordCriticRun({ result: "fail_open" });
      return { passed: true, repairs: [], rationale: "critic verdict failed schema validation" };
    }
    const verdict = parsed.data;
    logger.info({
      module: "conversations",
      action: "critic.verdict",
      msg: `authoring critic verdict: ${verdict.passed ? "passed" : "rejected"}`,
      tenant_id: params.tenant_id,
      passed: verdict.passed,
      repair_count: verdict.repairs.length,
    });
    recordCriticRun({ result: verdict.passed ? "passed" : "rejected" });
    return verdict;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({
      module: "conversations",
      action: "critic.call_failed",
      msg: "critic LLM call failed; passing",
      tenant_id: params.tenant_id,
      error: message,
    });
    recordCriticRun({ result: "fail_open" });
    return { passed: true, repairs: [], rationale: `critic call failed: ${message}` };
  }
}
