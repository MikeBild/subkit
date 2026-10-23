import type { Executor } from "../../db/client.ts";
import { invoke } from "../../llm/core/invoke.ts";
import { logger } from "../../logging/logger.ts";
import { recordCriticRun } from "../../observability/instrumentation.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { type GatingDecision, resolveCriticGate } from "./gating.ts";
import { type AuthoringCriticVerdict, AuthoringCriticVerdictSchema } from "./types.ts";

export const RENDERED_STEPS_CAP = 4096;
export const RENDERED_GOAL_CAP = 2000;
export const RENDERED_SCHEMA_CAP = 2000;
const RENDERED_TRANSFORM_CAP = 1000;

export type CriticRunResult =
  | "pass"
  | "reject"
  | "fail_open"
  | "skipped_min_steps"
  | "skipped_disabled"
  | "skipped_streak";

export type CriticTool = "author_workflow" | "edit_workflow_patch";

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated; original ${text.length} chars]`;
}

export function renderDraftForCritic(draft: WorkflowDraftDocument, goal?: string | null): string {
  const trimmedGoal = typeof goal === "string" ? goal.trim() : "";
  return [
    trimmedGoal.length > 0
      ? `Goal (verbatim from the user):\n${cap(trimmedGoal, RENDERED_GOAL_CAP)}`
      : "Goal: not recorded on this draft; judge internal consistency only.",
    `Workflow: ${draft.name} (slug: ${draft.slug})`,
    draft.description ? `Description: ${draft.description}` : "",
    draft.output_schema
      ? `Declared output_schema:\n${cap(JSON.stringify(draft.output_schema), RENDERED_SCHEMA_CAP)}`
      : "Declared output_schema: none",
    draft.output_transform
      ? `output_transform: ${cap(draft.output_transform, RENDERED_TRANSFORM_CAP)}`
      : "",
    draft.output_transform_function
      ? `output_transform_function: ${cap(draft.output_transform_function, RENDERED_TRANSFORM_CAP)}`
      : "",
    `Steps (${draft.steps.length}):\n${cap(JSON.stringify(draft.steps, null, 2), RENDERED_STEPS_CAP)}`,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export type CriticAgentOutcome =
  | { outcome: "pass"; verdict: AuthoringCriticVerdict }
  | { outcome: "reject"; verdict: AuthoringCriticVerdict }
  | { outcome: "fail_open"; reason: string };

export interface RunCriticAgentParams {
  draft: WorkflowDraftDocument;
  goal?: string | null;
  tenant_id: string;
  db?: Executor;
  signal?: AbortSignal;
}

export function classifyCriticVerdict(object: unknown): CriticAgentOutcome {
  if (object === undefined || object === null) {
    return { outcome: "fail_open", reason: "no_structured_output" };
  }
  const parsed = AuthoringCriticVerdictSchema.safeParse(object);
  if (!parsed.success) {
    return {
      outcome: "fail_open",
      reason: `verdict_invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(",")}`,
    };
  }
  const verdict = parsed.data;
  if (verdict.passed) return { outcome: "pass", verdict };
  if (verdict.repairs.length === 0) {
    return { outcome: "fail_open", reason: "rejected_without_repairs" };
  }
  return { outcome: "reject", verdict };
}

export async function runCriticAgent(params: RunCriticAgentParams): Promise<CriticAgentOutcome> {
  const draftText = renderDraftForCritic(params.draft, params.goal);
  try {
    const result = await invoke<AuthoringCriticVerdict>(
      {
        flow: "critic_authoring",
        tenant_id: params.tenant_id,
        user_turns: [
          {
            role: "user",
            content: `Review this workflow draft against its goal for semantic drift:\n\n${draftText}`,
          },
        ],
        schema: AuthoringCriticVerdictSchema,
        ...(params.signal ? { signal: params.signal } : {}),
      },
      params.db,
    );
    return classifyCriticVerdict(result.object);
  } catch (err) {
    return {
      outcome: "fail_open",
      reason: `call_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface CriticOutcome {
  result: CriticRunResult;
  gating_reason: GatingDecision["reason"];
  repairs: string[];
  rationale: string | null;
  fail_open_reason?: string;
}

export interface ReviewDraftWithCriticParams {
  tool: CriticTool;
  draft: WorkflowDraftDocument;
  goal?: string | null;
  tenant_id: string;
  conversation_id: string;
  recentDriftCount: number;
  loadConsecutiveRejections: () => Promise<number>;
  db?: Executor;
  signal?: AbortSignal;
  runAgent?: (params: RunCriticAgentParams) => Promise<CriticAgentOutcome>;
}

const SKIPPED_RESULT: Record<GatingDecision["reason"], CriticRunResult> = {
  disabled: "skipped_disabled",
  anti_loop: "skipped_streak",
  below_threshold: "skipped_min_steps",
  step_count: "skipped_min_steps",
  recent_drift: "skipped_min_steps",
};

function emit(params: ReviewDraftWithCriticParams, outcome: CriticOutcome): CriticOutcome {
  recordCriticRun({ result: outcome.result, tool: params.tool });
  const fields = {
    module: "conversations",
    action: "authoring_critic.run",
    msg: `authoring critic ${outcome.result} on ${params.tool}`,
    tenant_id: params.tenant_id,
    conversation_id: params.conversation_id,
    tool: params.tool,
    result: outcome.result,
    gating_reason: outcome.gating_reason,
    step_count: params.draft.steps.length,
    has_goal: typeof params.goal === "string" && params.goal.trim().length > 0,
    repair_count: outcome.repairs.length,
    ...(outcome.fail_open_reason ? { fail_open_reason: outcome.fail_open_reason } : {}),
  };
  if (outcome.result === "fail_open") logger.warn(fields);
  else logger.info(fields);
  return outcome;
}

export async function reviewDraftWithCritic(
  params: ReviewDraftWithCriticParams,
): Promise<CriticOutcome> {
  let gate: GatingDecision;
  try {
    gate = await resolveCriticGate({
      stepCount: params.draft.steps.length,
      recentDriftCount: params.recentDriftCount,
      tenantId: params.tenant_id,
      loadConsecutiveRejections: params.loadConsecutiveRejections,
    });
  } catch (err) {
    return emit(params, {
      result: "fail_open",
      gating_reason: "step_count",
      repairs: [],
      rationale: null,
      fail_open_reason: `gate_failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!gate.run) {
    return emit(params, {
      result: SKIPPED_RESULT[gate.reason],
      gating_reason: gate.reason,
      repairs: [],
      rationale: null,
    });
  }
  const agent = await (params.runAgent ?? runCriticAgent)({
    draft: params.draft,
    ...(params.goal !== undefined ? { goal: params.goal } : {}),
    tenant_id: params.tenant_id,
    ...(params.db ? { db: params.db } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (agent.outcome === "fail_open") {
    return emit(params, {
      result: "fail_open",
      gating_reason: gate.reason,
      repairs: [],
      rationale: null,
      fail_open_reason: agent.reason,
    });
  }
  return emit(params, {
    result: agent.outcome,
    gating_reason: gate.reason,
    repairs: agent.outcome === "reject" ? agent.verdict.repairs : [],
    rationale: agent.verdict.rationale,
  });
}
