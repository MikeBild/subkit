import { workflowSpecDigest } from "../workflows/core/spec.ts";
import type { WorkflowSpec } from "../workflows/draft-schemas.ts";
import type { WorkflowDraftDocument } from "./types.ts";

const SPEC_TEXT_MAX = 2000;
const SPEC_NAME_MAX = 200;
const SPEC_LIST_MAX = 50;

type DraftGoalSource = "conversation" | "spec";

interface DraftGoal {
  goal: string | null;
  source: DraftGoalSource | null;
  confirmed: boolean;
}

function emptyWorkflowSpec(): WorkflowSpec {
  return {
    goal: null,
    inputs: [],
    outputs: [],
    delivery: null,
    conventions_applied: [],
    evidence: [],
    open_questions: [],
    origin: "chat",
  };
}

function specText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, SPEC_TEXT_MAX).trim();
  return text.length > 0 ? text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldNames(names: Iterable<string>): WorkflowSpec["inputs"] {
  const seen = new Set<string>();
  const out: WorkflowSpec["inputs"] = [];
  for (const raw of names) {
    const name = raw.trim().slice(0, SPEC_NAME_MAX).trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
    if (out.length >= SPEC_LIST_MAX) break;
  }
  return out;
}

function schemaProperties(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.keys(schema.properties);
}

export function draftGoal(workflow: WorkflowDraftDocument | null | undefined): DraftGoal {
  const conversationGoal = specText(workflow?.goal);
  if (conversationGoal) return { goal: conversationGoal, source: "conversation", confirmed: true };
  const specGoal = specText(workflow?.spec?.goal);
  if (specGoal) {
    return { goal: specGoal, source: "spec", confirmed: workflow?.spec?.origin === "person" };
  }
  return { goal: null, source: null, confirmed: false };
}

export function authoredWorkflowSpec(params: {
  prior: WorkflowSpec | null | undefined;
  goal: string;
  definition: { input_schema?: unknown; output_schema?: unknown };
  input_example?: unknown;
}): WorkflowSpec {
  const base = params.prior ?? emptyWorkflowSpec();
  const inputs = isRecord(params.input_example)
    ? Object.keys(params.input_example)
    : schemaProperties(params.definition.input_schema);
  return {
    ...base,
    goal: specText(params.goal) ?? base.goal,
    inputs: fieldNames(inputs),
    outputs: fieldNames(schemaProperties(params.definition.output_schema)),
    origin: "chat",
  };
}

export function reconcileDraftSpec(
  prior: WorkflowDraftDocument | null | undefined,
  next: WorkflowDraftDocument,
): WorkflowDraftDocument {
  const nextGoal = specText(next.goal);
  const goalChanged = nextGoal !== specText(prior?.goal);
  let spec: WorkflowSpec | null = next.spec ?? null;
  let goal = next.goal;
  if (goalChanged && nextGoal && nextGoal !== spec?.goal) {
    spec = { ...(spec ?? emptyWorkflowSpec()), goal: nextGoal };
  } else if (
    !goalChanged &&
    goal !== undefined &&
    spec &&
    spec.goal !== (prior?.spec?.goal ?? null)
  ) {
    goal = spec.goal ?? undefined;
  }
  if (
    spec &&
    spec.origin === "person" &&
    workflowSpecDigest(spec) !== workflowSpecDigest(prior?.spec)
  ) {
    spec = { ...spec, origin: "chat" };
  }
  if (spec === (next.spec ?? null) && goal === next.goal) return next;
  const out: WorkflowDraftDocument = { ...next };
  if (goal === undefined) delete out.goal;
  else out.goal = goal;
  if (spec) out.spec = spec;
  else delete out.spec;
  return out;
}

export const SPEC_GOAL_QUESTION = "What should this workflow achieve?";

export const SPEC_GOAL_GUIDANCE =
  'Ask the user what this workflow should achieve, then record the answer with edit_workflow_patch { op: "add", path: "/goal", value: "<answer>" }. Open spec questions are a warning only; they never block saving.';

interface SpecQuestions {
  questions: string[];
  user_prompt: { tool: "ask_user_form"; args: Record<string, unknown> };
  next_action: string;
}

export function specQuestions(
  workflow: WorkflowDraftDocument | null | undefined,
): SpecQuestions | null {
  const missingGoal = draftGoal(workflow).goal === null;
  const open = workflow?.spec?.open_questions ?? [];
  if (!missingGoal && open.length === 0) return null;
  const questions = [...(missingGoal ? [SPEC_GOAL_QUESTION] : []), ...open];
  return {
    questions,
    user_prompt: {
      tool: "ask_user_form",
      args: {
        question: "Before changing this workflow, clarify its purpose and acceptance.",
        fields: [
          ...(missingGoal
            ? [{ name: "goal", label: SPEC_GOAL_QUESTION, type: "text", required: true }]
            : []),
          ...open.map((label, index) => ({
            name: `open_question_${index + 1}`,
            label,
            type: "text",
          })),
        ],
      },
    },
    next_action: SPEC_GOAL_GUIDANCE,
  };
}
