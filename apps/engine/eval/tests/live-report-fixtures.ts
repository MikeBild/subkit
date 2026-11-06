import type {
  LiveScenarioSpec,
  ObservedToolCall,
  ObservedTurn,
  ScenarioObservation,
} from "../live-report.ts";

export const CLARIFY_SPEC: LiveScenarioSpec = {
  slug: "underspecified-asks-first",
  kind: "clarification",
  goal: "Author a workflow that emails the report. Preview it and save it.",
  connectors: [],
  content_checks: [
    {
      name: "asks for the recipient",
      pattern: "recipient|address|e-?mail|to whom|empf",
      flags: "i",
    },
    {
      name: "asks for the source",
      pattern: "source|data|which report|from|quelle|woher",
      flags: "i",
    },
  ],
};

export const NEGATIVE_SPEC: LiveScenarioSpec = {
  ...CLARIFY_SPEC,
  slug: "underspecified-placeholder-rejected",
  answer_turns: [
    "Send it to test@example.com by a plain HTTP POST to https://hooks.example.com/report with a JSON body {to, subject, rows}. The data is the first 5 posts from https://jsonplaceholder.typicode.com/posts (id and title). Subject: Post report. No schedule, I run it on demand. That is everything, build and preview it now.",
  ],
};

let callSeq = 0;

export function call(
  tool: string,
  input: unknown = {},
  output: unknown = { ok: true },
): ObservedToolCall {
  callSeq += 1;
  return { tool, input, output, call_id: `call_${callSeq}` };
}

export function turn(
  tool_calls: ObservedToolCall[],
  status: string,
  assistant_text = "",
  pending_elicitation_id: string | null = status === "awaiting_input" ? "elic_1" : null,
): ObservedTurn {
  return { tool_calls, assistant_text, status, pending_elicitation_id };
}

export function observation(
  spec: LiveScenarioSpec,
  turns: ObservedTurn[],
  extra: Partial<ScenarioObservation> = {},
): ScenarioObservation {
  const results = turns.flatMap((t) => t.tool_calls);
  return {
    scenario: spec.slug,
    tool_calls: results.length,
    results,
    turns,
    committed_workflow_id: null,
    created_artifacts: [{ kind: "conversation", id: "conv_1" }],
    status: turns[turns.length - 1]?.status ?? "unknown",
    wall_ms: 1,
    ...extra,
  };
}

export const ASK_RECIPIENT_AND_SOURCE = {
  question:
    "Who should receive the report (e-mail address), and which data is the report built from?",
};
