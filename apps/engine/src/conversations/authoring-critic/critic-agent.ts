// Authoring-time LLM critic — second-stage verifier for workflow drafts.
//
// Runs ONLY when `shouldRunCritic` returns `run:true`, on a draft that
// has already cleared every static gate. Returns a structured verdict
// that the build_workflow tool either:
//   - ignores when passed=true, OR
//   - turns into `ok:false {error_code:"critic_rejected", repairs}` so
//     the LLM re-authors on the next turn with the repair hints folded
//     into prior_failures.
//
// The critic does NOT patch the draft. The verdict is hints only.
//
// Routing: the critic uses the tenant's primary `llm.*` route. To pin
// a cheaper model just for critic runs, operators set `llm.model` /
// `llm.provider` at the tenant scope; the critic call shares it with
// the rest of the authoring loop.

import type { Db } from "../../db/client.ts";
import { invoke } from "../../llm/core/invoke.ts";
import { logger } from "../../logging/logger.ts";
import { recordCriticRun } from "../../observability/instrumentation.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { type AuthoringCriticVerdict, AuthoringCriticVerdictSchema } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
}

/**
 * Invoke the authoring critic. Returns the parsed verdict, or a
 * fail-open `passed:true` placeholder when the LLM call itself errored
 * (the critic is an opt-in enhancement; transient provider errors must
 * never block the build_workflow result).
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
    const verdict = result.object;
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
