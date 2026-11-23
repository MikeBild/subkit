export interface ActivityStep {
  callId: string;
  tool: string;
  connectorId: string | null;
  method: string | null;
  resource: string | null;
  startedAt: number;
  endedAt: number | null;
  ok: boolean | null;
}

export interface ActivityRetry {
  scope: "model" | "tool";
  attempt: number;
  of: number;
}

export interface TurnActivity {
  steps: readonly ActivityStep[];
  writing: boolean;
  retry: ActivityRetry | null;
  since: number;
}

export type ActivityNow =
  | { kind: "tool"; step: ActivityStep }
  | { kind: "model" }
  | { kind: "writing" };

export interface ActivityLine {
  now: ActivityNow;
  retry: ActivityRetry | null;
  idleMinutes: number | null;
}

export const ACTIVITY_IDLE_AFTER_MS = 60_000;
export const ACTIVITY_HISTORY = 4;

type TurnEventLike = { type: string; [key: string]: unknown };

export function startActivity(now: number): TurnActivity {
  return { steps: [], writing: false, retry: null, since: now };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const SKIPPED_SEGMENT = /^(?:v\d+(?:\.\d+)*|\d+|[0-9a-f-]{16,}|api|rest)$/i;
const RESOURCE_WORD = /^[\p{L}][\p{L}_-]{1,31}$/u;

export function pathResource(path: string | null): string | null {
  if (!path) return null;
  let pathname = path;
  if (/^https?:\/\//i.test(path)) {
    try {
      pathname = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith("/")) return null;
  const segments = pathname
    .split("?")[0]
    ?.split("/")
    .filter((segment) => segment && !segment.includes("{") && !segment.startsWith(":"));
  const word = [...(segments ?? [])]
    .reverse()
    .find((segment) => !SKIPPED_SEGMENT.test(segment) && RESOURCE_WORD.test(segment));
  if (!word) return null;
  const spaced = word.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function callFacts(input: unknown): Pick<ActivityStep, "connectorId" | "method" | "resource"> {
  const args = record(input);
  return {
    connectorId: text(args?.connector_id),
    method: text(args?.method)?.toUpperCase() ?? null,
    resource: pathResource(text(args?.path)),
  };
}

export function toolOutputOk(output: unknown): boolean {
  const result = record(output);
  if (!result) return true;
  if (result.ok === false) return false;
  return !(typeof result.error === "string" || record(result.error) !== null);
}

function updateStep(
  steps: readonly ActivityStep[],
  index: number,
  change: Partial<ActivityStep>,
): ActivityStep[] {
  return steps.map((step, at) => (at === index ? { ...step, ...change } : step));
}

function openIndex(steps: readonly ActivityStep[], match: (step: ActivityStep) => boolean): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && step.endedAt === null && match(step)) return index;
  }
  return -1;
}

function retryOf(value: unknown, scope: ActivityRetry["scope"]): ActivityRetry | null {
  const retry = record(value);
  if (!retry) return null;
  const { attempt, of } = retry;
  if (typeof attempt !== "number" || typeof of !== "number" || attempt < 1 || of < attempt)
    return null;
  return { scope, attempt, of };
}

function onActivity(state: TurnActivity, event: TurnEventLike, now: number): TurnActivity {
  if (event.phase === "tool") {
    const retry = retryOf(event.retry, "tool");
    const callId = text(event.call_id);
    const owns = callId !== null && openIndex(state.steps, (step) => step.callId === callId) >= 0;
    return retry && owns ? { ...state, retry } : state;
  }
  if (event.phase === "composing") {
    const retry = retryOf(event.retry, "model");
    return retry ? { ...state, retry, writing: false, since: now } : state;
  }
  if (event.phase === "idle") {
    const last = record(event.last_completed);
    const tool = text(last?.tool_name);
    if (!tool) return state;
    const index = openIndex(state.steps, (step) => step.tool === tool);
    if (index < 0) return state;
    return {
      ...state,
      steps: updateStep(state.steps, index, { endedAt: now, ok: last?.ok !== false }),
      since: now,
    };
  }
  return state;
}

export function reduceActivity(
  state: TurnActivity,
  event: TurnEventLike,
  now: number,
): TurnActivity {
  switch (event.type) {
    case "tool_call_start": {
      const callId = text(event.call_id);
      const tool = text(event.tool) ?? text(event.tool_name);
      if (!callId || !tool || state.steps.some((step) => step.callId === callId)) return state;
      const step: ActivityStep = {
        callId,
        tool,
        ...callFacts(event.input_partial),
        startedAt: now,
        endedAt: null,
        ok: null,
      };
      return { steps: [...state.steps, step], writing: false, retry: null, since: now };
    }
    case "tool_call_end": {
      const callId = text(event.call_id);
      const index = openIndex(state.steps, (step) => step.callId === callId);
      if (index < 0 || event.input === undefined) return state;
      return { ...state, steps: updateStep(state.steps, index, callFacts(event.input)) };
    }
    case "tool_result": {
      const callId = text(event.call_id);
      const index = openIndex(state.steps, (step) => step.callId === callId);
      if (index < 0) return state;
      const ok = toolOutputOk(event.output);
      return {
        ...state,
        steps: updateStep(state.steps, index, { endedAt: now, ok }),
        retry: ok ? null : state.retry,
        since: now,
      };
    }
    case "activity":
      return onActivity(state, event, now);
    case "text_delta":
      return state.writing ? state : { ...state, writing: true, retry: null, since: now };
    default:
      return state;
  }
}

export function currentStep(state: TurnActivity): ActivityStep | null {
  const index = openIndex(state.steps, () => true);
  return index < 0 ? null : (state.steps[index] ?? null);
}

export function activityLine(
  state: TurnActivity,
  now: number,
  idleAfterMs: number = ACTIVITY_IDLE_AFTER_MS,
): ActivityLine {
  const step = currentStep(state);
  const current: ActivityNow = step
    ? { kind: "tool", step }
    : state.writing
      ? { kind: "writing" }
      : { kind: "model" };
  const waited = Math.max(0, now - (step?.startedAt ?? state.since));
  const retry =
    state.retry && (state.retry.scope === "tool") === (current.kind === "tool")
      ? state.retry
      : null;
  return {
    now: current,
    retry: current.kind === "writing" ? null : retry,
    idleMinutes: waited >= idleAfterMs ? Math.floor(waited / 60_000) || 1 : null,
  };
}

export function recentSteps(
  state: TurnActivity,
  limit: number = ACTIVITY_HISTORY,
): readonly ActivityStep[] {
  const open = currentStep(state);
  return state.steps.filter((step) => step !== open).slice(-limit);
}
