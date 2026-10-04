import type { Executor } from "../../db/client.ts";
import { invoke } from "../../llm/core/invoke.ts";
import { logger } from "../../logging/logger.ts";
import { recordCriticRun } from "../../observability/instrumentation.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { type AuthoringCriticVerdict, AuthoringCriticVerdictSchema } from "./types.ts";

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
  db?: Executor;
  signal?: AbortSignal;
}

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
      logger.warn({
        module: "conversations",
        action: "critic.no_structured_output",
        msg: "critic returned text without a structured verdict; passing",
        tenant_id: params.tenant_id,
      });
      recordCriticRun({ result: "fail_open" });
      return { passed: true, repairs: [], rationale: "critic returned no structured verdict" };
    }
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
