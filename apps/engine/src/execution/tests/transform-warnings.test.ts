// Regression test for the April 21 Codex session: a jsonata transform
// referencing identifiers not in scope silently drops them. The engine
// now surfaces `unresolved_identifier` warnings next to the output.

import { describe, expect, it } from "bun:test";
import { runTransformStep } from "../steps/transform.ts";
import type { StepRunContext } from "../types.ts";

function mkCtx(): StepRunContext {
  return {
    db: undefined as unknown as StepRunContext["db"],
    tenant_id: "t",
    execution_id: "e",
    workflow_id: "w",
    workflow_version_id: "v",
    request_source: "mcp",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope: {},
    started_at: new Date(),
    workflow_slug: "s",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step: {
      kind: "transform",
      id: "format_output",
      language: "jsonata",
      expression: "dummy",
    },
    step_index: 0,
    step_row_id: "r",
  };
}

describe("runTransformStep warnings", () => {
  it("flags unresolved identifiers but still returns the partial output (Berlin bug)", async () => {
    const ctx = mkCtx();
    const step = {
      kind: "transform" as const,
      id: "format_output",
      language: "jsonata" as const,
      expression: '{ "city": "Berlin, Germany", "date": data.daily.time[1] }',
    };
    const result = await runTransformStep({
      ctx,
      step,
      scope: { fetch_weather: { daily: { time: ["2026-04-21", "2026-04-22"] } } },
      input: {},
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ city: "Berlin, Germany" });
    expect(result.warnings?.length).toBe(1);
    expect(result.warnings?.[0]?.code).toBe("unresolved_identifier");
    expect(result.warnings?.[0]?.identifier).toBe("data");
  });

  it("emits no warnings when every referenced identifier is in scope", async () => {
    const ctx = mkCtx();
    const step = {
      kind: "transform" as const,
      id: "ok",
      language: "jsonata" as const,
      expression: '{ "d": fetch_weather.daily.time[1] }',
    };
    const result = await runTransformStep({
      ctx,
      step,
      scope: { fetch_weather: { daily: { time: ["a", "b"] } } },
      input: {},
    });
    expect(result.status).toBe("succeeded");
    expect(result.warnings).toBeUndefined();
  });

  it("recognises $input as a binding and does not flag it", async () => {
    const ctx = mkCtx();
    const step = {
      kind: "transform" as const,
      id: "t",
      language: "jsonata" as const,
      expression: '{ "echo": $input.city }',
    };
    const result = await runTransformStep({
      ctx,
      step,
      scope: {},
      input: { city: "Berlin" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ echo: "Berlin" });
    expect(result.warnings).toBeUndefined();
  });

  it("does not flag jsonata built-ins like $sum / $map", async () => {
    const ctx = mkCtx();
    const step = {
      kind: "transform" as const,
      id: "t",
      language: "jsonata" as const,
      expression: '{ "total": $sum(numbers) }',
    };
    const result = await runTransformStep({
      ctx,
      step,
      scope: { numbers: [1, 2, 3] },
      input: {},
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ total: 6 });
    expect(result.warnings).toBeUndefined();
  });
});
