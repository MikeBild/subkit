import { afterAll, beforeAll, beforeEach } from "bun:test";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

export const uuid = createDeterministicUuidFactory(0x0a_07_0e);

export let ctx: ConversationTestCtx;

export const FORECAST = {
  daily: {
    time: ["2026-06-22", "2026-06-23", "2026-06-24"],
    temperature_2m_max: [24.1, 31.2, 27.4],
  },
};

export const FORECAST_STEP = {
  id: "forecast",
  kind: "transform",
  language: "javascript",
  expression: `return ${JSON.stringify(FORECAST)};`,
};

export const ARGMAX =
  '($t := daily.temperature_2m_max; $m := $max($t); $idx := ($t#$i[$ = $m].$i)[0]; { "hottest_day": daily.time[$idx], "max_temp": $m })';

export const THROWING_OUTPUT_TRANSFORM = "$number(daily.time)";

export const OUTPUT_SCHEMA = {
  type: "object",
  required: ["hottest_day", "max_temp"],
  properties: { hottest_day: { type: "string" }, max_temp: { type: "number" } },
};

export const LOOP_STEPS = [
  { id: "list", kind: "transform", language: "javascript", expression: "return [{x:1},{x:2}];" },
  { id: "each", kind: "loop", over: "$scope.list.data", body: ["detail"] },
  {
    id: "detail",
    kind: "transform",
    language: "javascript",
    expression: "return { x: input.scope.$item.x * 10 };",
  },
];

export const BRANCH_STEPS = [
  { id: "probe", kind: "transform", language: "javascript", expression: "return { flag: true };" },
  {
    id: "route",
    kind: "branch",
    when: "$scope.probe.data.flag",
    then_steps: ["taken"],
    else_steps: ["untaken"],
  },
  {
    id: "taken",
    kind: "transform",
    language: "javascript",
    expression: 'return { picked: "then" };',
  },
  {
    id: "untaken",
    kind: "transform",
    language: "javascript",
    expression: 'return { picked: "else" };',
  },
];

export function usePreviewAutoRepairSetup(): void {
  beforeAll(async () => {
    ctx = await createConversationTestCtx("preview-auto-repair");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    resetMockProvider();
  });
}
