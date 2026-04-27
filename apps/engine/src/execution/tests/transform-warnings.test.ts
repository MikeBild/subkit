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
    // P3: warning details carry the actual scope shape so the LLM can
    // cite a real path next turn instead of guessing.
    const details = result.warnings?.[0]?.details as { available_paths: string[] } | undefined;
    expect(details?.available_paths).toContain("fetch_weather");
  });

  it("emits `<key>.data` paths when the scope value is a ScopeEnvelope", async () => {
    const ctx = mkCtx();
    const step = {
      kind: "transform" as const,
      id: "format_output",
      language: "jsonata" as const,
      // Reference a non-existent identifier so the warning fires; the
      // test's point is the available_paths shape, not the unresolved id.
      expression: "missing_root.foo",
    };
    const result = await runTransformStep({
      ctx,
      step,
      scope: {
        // Real-shaped envelope as the engine produces at runtime.
        fetch_projects: {
          data: { projects: [{ id: "p1", name: "Alpha" }] },
          duration_ms: 12,
          error: null,
        },
      },
      input: {},
    });
    expect(result.warnings?.length).toBe(1);
    const details = result.warnings?.[0]?.details as { available_paths: string[] } | undefined;
    expect(details?.available_paths).toContain("fetch_projects");
    expect(details?.available_paths).toContain("fetch_projects.data");
  });

  it("offers a 'did you mean' suggestion for a single-typo identifier", async () => {
    const ctx = mkCtx();
    const step = {
      kind: "transform" as const,
      id: "format_output",
      language: "jsonata" as const,
      // `fetch_weathr` is a 1-char typo for the in-scope `fetch_weather`.
      expression: "fetch_weathr.daily.time[1]",
    };
    const result = await runTransformStep({
      ctx,
      step,
      scope: { fetch_weather: { daily: { time: ["a", "b"] } } },
      input: {},
    });
    expect(result.warnings?.length).toBe(1);
    const details = result.warnings?.[0]?.details as { suggestion?: string } | undefined;
    expect(details?.suggestion).toBe("fetch_weather");
  });

  it("does not invent a suggestion when no in-scope key is close enough", async () => {
    const ctx = mkCtx();
    const step = {
      kind: "transform" as const,
      id: "format_output",
      language: "jsonata" as const,
      expression: "totally_different_name",
    };
    const result = await runTransformStep({
      ctx,
      step,
      scope: { fetch_weather: { daily: { time: ["a"] } } },
      input: {},
    });
    expect(result.warnings?.length).toBe(1);
    const details = result.warnings?.[0]?.details as { suggestion?: string } | undefined;
    expect(details?.suggestion).toBeUndefined();
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
