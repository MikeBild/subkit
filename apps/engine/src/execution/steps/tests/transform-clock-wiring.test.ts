// Wiring guard — the transform STEP must thread the
// execution's deterministic clock/seed into the QuickJS sandbox so that
// `sk.now()` returns the execution's fixed `started_at` and `sk.uuid()`
// derives from a stable `${execution_id}:${step.id}` seed — i.e. a run
// REPLAYED with the same (execution_id, step.id) reproduces byte-identical
// ids. The pure runtime/stdlib tests prove `runJs` honors a `clock`; this
// test proves the transform driver actually PASSES one (the gap that would
// let `sk.now()` silently read the epoch).

import { describe, expect, test } from "bun:test";
import { RunLlmBudget } from "../../../llm/accounting/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import type { StepRunContext } from "../../types.ts";
import { runTransformStep } from "../transform.ts";

const TEST_NOW_MS = getTestNow();
const EXECUTION_ID = "00000000-0000-0000-0000-000000000099";
const STEP_ID = "clock_probe";

function ctx(scope: Record<string, unknown>): StepRunContext {
  return {
    // Empty DB stub: a non-offloaded transform scope never touches the DB.
    // If this stub starts crashing at runtime, the test is correctly telling
    // you runTransformStep now needs DB access — wire a real test DB then.
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub; no DB needed for a non-offloaded scope
    db: {} as any,
    tenant_id: "t-transform",
    execution_id: EXECUTION_ID,
    workflow_id: "00000000-0000-0000-0000-0000000000aa",
    workflow_version_id: "00000000-0000-0000-0000-0000000000ab",
    request_source: "chat",
    parent_execution_id: null,
    depth: 0,
    scope,
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "test-wf",
    trace_id: null,
    execution_mode: "dev",
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    step: {} as any,
    step_index: 0,
    step_row_id: "00000000-0000-0000-0000-000000000aaa",
    signal: new AbortController().signal,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
}

const EXPRESSION = "return [sk.now(), sk.uuid()];";

async function runProbe(): Promise<[number, string]> {
  const scope = {};
  const result = await runTransformStep({
    ctx: ctx(scope),
    step: { id: STEP_ID, kind: "transform", language: "javascript", expression: EXPRESSION },
    scope,
    input: {},
  });
  expect(result.status).toBe("succeeded");
  return result.output as [number, string];
}

describe("runTransformStep · deterministic clock/id wiring", () => {
  test("sk.now() equals ctx.started_at.getTime()", async () => {
    const [now] = await runProbe();
    expect(now).toBe(TEST_NOW_MS);
    // Specifically NOT the silent-epoch fallback.
    expect(now).not.toBe(0);
  });

  test("sk.uuid() is identical across two replays of the same (execution_id, step.id)", async () => {
    const [, uuidA] = await runProbe();
    const [, uuidB] = await runProbe();
    expect(uuidA).toBe(uuidB);
    // Sanity: it is a v4-shaped uuid, not an empty/constant fallback.
    expect(uuidA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
