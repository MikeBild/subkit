import type { Executor } from "../../db/client.ts";
import { invoke } from "../../llm/core/invoke.ts";
import { logger } from "../../logging/logger.ts";
import { recordCriticRubricItems, recordCriticRun } from "../../observability/instrumentation.ts";
import {
  type AppliedConvention,
  type ConventionScope,
  loadActiveConventions,
} from "../../skills/conventions.ts";
import { collectConnectorIds } from "../scope-facts.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { type GatingDecision, resolveCriticGate } from "./gating.ts";
import {
  type AuthoringCriticVerdict,
  AuthoringCriticVerdictSchema,
  type CriticRubricItem,
  RUBRIC_CAP,
} from "./types.ts";

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

export const CRITIC_RUBRIC_HEADING =
  "Convention rubric (confirmed tenant conventions). Check each rule against the draft and report every rule_id in rubric[] with status pass, fail or n_a (the draft does not touch it) and a short note. A failed rule is a warning; it does not decide passed:";

function rubricConventions(conventions: readonly AppliedConvention[]): AppliedConvention[] {
  const seen = new Set<string>();
  return conventions
    .filter((entry) => {
      if (seen.has(entry.rule.rule_id)) return false;
      seen.add(entry.rule.rule_id);
      return true;
    })
    .slice(0, RUBRIC_CAP);
}

export function renderDraftForCritic(
  draft: WorkflowDraftDocument,
  goal?: string | null,
  conventions: readonly AppliedConvention[] = [],
): string {
  const trimmedGoal = typeof goal === "string" ? goal.trim() : "";
  const rubric = rubricConventions(conventions);
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
    draft.trigger ? `Trigger: ${cap(JSON.stringify(draft.trigger), RENDERED_SCHEMA_CAP)}` : "",
    rubric.length > 0
      ? [
          CRITIC_RUBRIC_HEADING,
          ...rubric.map(
            (entry) =>
              `- ${entry.rule.rule_id} [${entry.rule.type}] ${entry.rule.statement} ${JSON.stringify(entry.rule.payload)}`,
          ),
        ].join("\n")
      : "",
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
  conventions?: readonly AppliedConvention[];
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

export function rubricFromVerdict(
  conventions: readonly AppliedConvention[],
  verdict: AuthoringCriticVerdict | null,
): CriticRubricItem[] {
  const reported = new Map((verdict?.rubric ?? []).map((item) => [item.rule_id, item]));
  return rubricConventions(conventions).map((entry) => {
    const item = reported.get(entry.rule.rule_id);
    return item
      ? { rule_id: item.rule_id, status: item.status, note: item.note }
      : { rule_id: entry.rule.rule_id, status: "unchecked", note: "" };
  });
}

export async function runCriticAgent(params: RunCriticAgentParams): Promise<CriticAgentOutcome> {
  const draftText = renderDraftForCritic(params.draft, params.goal, params.conventions);
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
  rubric: CriticRubricItem[];
  rubric_warnings: CriticRubricItem[];
  fail_open_reason?: string;
}

export interface ReviewDraftWithCriticParams {
  tool: CriticTool;
  draft: WorkflowDraftDocument;
  goal?: string | null;
  convention_scope?: ConventionScope;
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
  recordCriticRubricItems(outcome.rubric.map((item) => item.status));
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
    rubric_count: outcome.rubric.length,
    rubric_warning_rule_ids: outcome.rubric_warnings.map((item) => item.rule_id),
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
      rubric: [],
      rubric_warnings: [],
      fail_open_reason: `gate_failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!gate.run) {
    return emit(params, {
      result: SKIPPED_RESULT[gate.reason],
      gating_reason: gate.reason,
      repairs: [],
      rationale: null,
      rubric: [],
      rubric_warnings: [],
    });
  }
  const conventions = await draftConventions(params);
  const agent = await (params.runAgent ?? runCriticAgent)({
    draft: params.draft,
    ...(params.goal !== undefined ? { goal: params.goal } : {}),
    ...(conventions.length > 0 ? { conventions } : {}),
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
      rubric: rubricFromVerdict(conventions, null),
      rubric_warnings: [],
      fail_open_reason: agent.reason,
    });
  }
  const rubric = rubricFromVerdict(conventions, agent.verdict);
  return emit(params, {
    result: agent.outcome,
    gating_reason: gate.reason,
    repairs: agent.outcome === "reject" ? agent.verdict.repairs : [],
    rationale: agent.verdict.rationale,
    rubric,
    rubric_warnings: rubric.filter((item) => item.status === "fail"),
  });
}

async function draftConventions(params: ReviewDraftWithCriticParams): Promise<AppliedConvention[]> {
  const scope = params.convention_scope;
  if (!scope) return [];
  try {
    const active = await loadActiveConventions(
      params.tenant_id,
      {
        ...scope,
        connector_ids: [...(scope.connector_ids ?? []), ...collectConnectorIds(params.draft.steps)],
      },
      params.db,
    );
    return active.conventions;
  } catch (err) {
    logger.warn({
      module: "conversations",
      action: "authoring_critic.conventions_skipped",
      msg: "convention rubric could not be loaded; the critic runs without it",
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
