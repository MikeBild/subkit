// Stop-condition predicates passed to `streamText({ stopWhen: [...] })`
// in the conversation tool-use loop. Pure functions over the
// step.toolResults array — no shared state with the surrounding
// orchestrator. Extracted so the loop's runtime semantics ("when does
// the SDK stop calling the model") can be inspected and unit-tested
// independently of the loop body.
//
// Typed `ReadonlyArray<...>` against the SDK's StopCondition generic
// because our concrete tool map and the SDK's variadic ToolSet do not
// reconcile at the type level; the runtime contract is the predicate
// shape, not the SDK's generic ToolSet parameterisation.

interface StepShapeWithToolName {
  toolResults: ReadonlyArray<{ toolName: string; output?: unknown }>;
}

interface StepShape {
  toolResults: ReadonlyArray<{ output?: unknown }>;
}

/**
 * Stop after a step that invoked `save_workflow_draft` and produced a
 * `committed_workflow_id` — the loop is done the moment the workflow
 * row is persisted.
 */
export const committedStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<StepShapeWithToolName>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((r) => {
    if (r.toolName !== "save_workflow_draft") return false;
    const output = r.output;
    return (
      !!output &&
      typeof output === "object" &&
      "committed_workflow_id" in (output as Record<string, unknown>) &&
      typeof (output as { committed_workflow_id?: unknown }).committed_workflow_id === "string"
    );
  });
};

/**
 * Stop after any tool returns a pause payload. Required for
 * policy-gated confirm-before-execution flows where the wrapper emits
 * an `ask_user_confirm` elicitation without the model explicitly
 * calling `ask_user_confirm` as a tool in the same step.
 */
export const pausedStopCondition = ({ steps }: { steps: ReadonlyArray<StepShape> }): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((result) => {
    const output = result.output;
    return !!output && typeof output === "object" && "pause" in (output as Record<string, unknown>);
  });
};
