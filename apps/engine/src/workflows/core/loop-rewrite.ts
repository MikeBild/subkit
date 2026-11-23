export type LoopRewriteBlockReason =
  | "multi_step_body"
  | "empty_body"
  | "body_step_missing"
  | "body_step_has_for_each"
  | "no_selector"
  | "over_not_a_path"
  | "loop_output_referenced";

export interface LoopToForEachChange {
  loop_step_id: string;
  body_step_id: string;
  for_each: string;
  original_selector: string;
  selector_source: "data_selector" | "over";
}

export interface LoopRewriteBlock {
  loop_step_id: string;
  reason: LoopRewriteBlockReason;
}

export interface StoredLoopRewrite {
  changed: boolean;
  dag: unknown;
  changes: LoopToForEachChange[];
  blocked: LoopRewriteBlock[];
}

type StoredStep = Record<string, unknown> & { id: string };

interface StoredLoopStep extends StoredStep {
  kind: "loop";
}

const PLAIN_DOT_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*$/;

const ROOT_REFERENCE_FIELDS = [
  "output_transform",
  "output_transform_function",
  "validation_function",
] as const;

const BLOCK_MESSAGES: Record<LoopRewriteBlockReason, string> = {
  multi_step_body:
    "its body has more than one step. Move the body steps into their own workflow and run it once per element with a `call` step that carries `for_each`, or give each body step its own `for_each`.",
  empty_body: "its body is empty. Remove the step.",
  body_step_missing:
    "its body names a step that does not exist. Remove the loop and put `for_each` on the step that should repeat.",
  body_step_has_for_each:
    "its body step already has a `for_each`. Keep one iteration: merge both selectors into the body step's `for_each` and remove the loop.",
  no_selector:
    "it has neither `over` nor `data_selector`. Put `for_each` on the body step and remove the loop.",
  over_not_a_path:
    "its `over` is an expression, not a plain path. Write it as a JavaScript arrow function in the body step's `for_each`, for example `(sourceData) => sourceData.<step_id>.data.<array_path>`, and remove the loop.",
  loop_output_referenced:
    "another step or the workflow output reads the loop's result by its id. Put `for_each` on the body step, point those references at the body step id, and remove the loop.",
};

export function loopRewriteMessage(reason: LoopRewriteBlockReason): string {
  return `The \`loop\` step kind is retired and this loop cannot be converted automatically: ${BLOCK_MESSAGES[reason]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredStep(value: unknown): value is StoredStep {
  return isRecord(value) && typeof value.id === "string";
}

function isLoopStep(step: unknown): step is StoredLoopStep {
  return isStoredStep(step) && step.kind === "loop";
}

function storedSteps(dag: unknown): unknown[] {
  const steps = isRecord(dag) ? dag.steps : undefined;
  return Array.isArray(steps) ? steps : [];
}

export function hasStoredLoopStep(dag: unknown): boolean {
  return storedSteps(dag).some(
    (step) => isRecord(step) && (step as { kind?: unknown }).kind === "loop",
  );
}

function overToForEach(over: string): string | null {
  const trimmed = over.trim();
  if (!PLAIN_DOT_PATH_RE.test(trimmed)) return null;
  return `(sourceData) => sourceData.${trimmed}`;
}

function selectorOf(
  loop: StoredLoopStep,
):
  | { ok: true; for_each: string; source: "data_selector" | "over"; original: string }
  | { ok: false; reason: LoopRewriteBlockReason } {
  if (typeof loop.data_selector === "string" && loop.data_selector.length > 0) {
    return {
      ok: true,
      for_each: loop.data_selector,
      source: "data_selector",
      original: loop.data_selector,
    };
  }
  if (typeof loop.over === "string" && loop.over.length > 0) {
    const forEach = overToForEach(loop.over);
    if (forEach === null) return { ok: false, reason: "over_not_a_path" };
    return { ok: true, for_each: forEach, source: "over", original: loop.over };
  }
  return { ok: false, reason: "no_selector" };
}

function loopOutputReferenced(dag: unknown, loop: StoredLoopStep, bodyIds: Set<string>): boolean {
  const referencedByStep = storedSteps(dag).some(
    (step) =>
      isStoredStep(step) &&
      step.id !== loop.id &&
      !bodyIds.has(step.id) &&
      JSON.stringify(step).includes(loop.id),
  );
  if (referencedByStep) return true;
  const root = isRecord(dag) ? dag : {};
  const haystack = [
    ...ROOT_REFERENCE_FIELDS.map((field) => root[field]),
    root.output_schema === undefined ? undefined : JSON.stringify(root.output_schema),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\0");
  return haystack.includes(loop.id);
}

export function rewriteStoredLoops(dag: unknown): StoredLoopRewrite {
  const steps = storedSteps(dag);
  const changes: LoopToForEachChange[] = [];
  const blocked: LoopRewriteBlock[] = [];
  const out = steps.map((step) => (isRecord(step) ? { ...step } : step));
  const removed = new Set<string>();

  for (const loop of steps.filter(isLoopStep)) {
    const block = (reason: LoopRewriteBlockReason): void => {
      blocked.push({ loop_step_id: loop.id, reason });
    };
    const body = Array.isArray(loop.body)
      ? loop.body.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (body.length === 0) {
      block("empty_body");
      continue;
    }
    if (body.length > 1) {
      block("multi_step_body");
      continue;
    }
    const bodyStepId = body[0] as string;
    const selector = selectorOf(loop);
    if (!selector.ok) {
      block(selector.reason);
      continue;
    }
    if (loopOutputReferenced(dag, loop, new Set(body))) {
      block("loop_output_referenced");
      continue;
    }
    const bodyIndex = out.findIndex((step) => isStoredStep(step) && step.id === bodyStepId);
    const bodyStep = out[bodyIndex];
    if (!isStoredStep(bodyStep)) {
      block("body_step_missing");
      continue;
    }
    if (bodyStep.for_each !== undefined) {
      block("body_step_has_for_each");
      continue;
    }
    out[bodyIndex] = { ...bodyStep, for_each: selector.for_each };
    removed.add(loop.id);
    changes.push({
      loop_step_id: loop.id,
      body_step_id: bodyStepId,
      for_each: selector.for_each,
      original_selector: selector.original,
      selector_source: selector.source,
    });
  }

  if (changes.length === 0) return { changed: false, dag, changes, blocked };
  return {
    changed: true,
    dag: {
      ...(dag as Record<string, unknown>),
      steps: out.filter((step) => !(isStoredStep(step) && removed.has(step.id))),
    },
    changes,
    blocked,
  };
}

export interface RetiredLoopNotice {
  loop_step_id: string;
  message: string;
}

export function retiredLoopNotices(dag: unknown): RetiredLoopNotice[] {
  const rewrite = rewriteStoredLoops(dag);
  return [
    ...rewrite.blocked.map((block) => ({
      loop_step_id: block.loop_step_id,
      message: loopRewriteMessage(block.reason),
    })),
    ...rewrite.changes.map((change) => ({
      loop_step_id: change.loop_step_id,
      message: `The \`loop\` step kind is retired. Set \`for_each: ${JSON.stringify(change.for_each)}\` on step "${change.body_step_id}" and remove this step.`,
    })),
  ];
}
