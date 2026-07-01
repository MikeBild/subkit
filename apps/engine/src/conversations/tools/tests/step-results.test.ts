// buildRawStepResults — the OPTIONAL raw per-step input/output surface
// dry_run_workflow / run_workflow attach under `include_step_results` (D6).
// The default tool envelope stays compact (truncated step_trace); this
// builder is what the opt-in flag returns.

import { describe, expect, test } from "bun:test";
import { buildRawStepResults, type RawStepResultSource } from "../step-results.ts";

describe("buildRawStepResults", () => {
  test("pairs each step's resolved request (input) with its output", () => {
    const steps: RawStepResultSource[] = [
      {
        step_key: "fetch",
        kind: "request",
        status: "succeeded",
        duration_ms: 12,
        request_meta: { method: "GET", url: "https://api.test/v2/projects", status: 200 },
        output_preview: { projects: [{ id: "p1", name: "Acme" }] },
      },
      {
        step_key: "shape",
        kind: "transform",
        status: "succeeded",
        duration_ms: 1,
        // A transform issues no request → input is null, not fabricated.
        output_preview: [{ id: "p1" }],
      },
    ];
    const results = buildRawStepResults(steps);
    expect(results).toHaveLength(2);
    // The request step exposes the resolved request as `input`.
    expect(results[0]).toMatchObject({
      step_id: "fetch",
      kind: "request",
      status: "succeeded",
      duration_ms: 12,
      input: { method: "GET", url: "https://api.test/v2/projects", status: 200 },
    });
    expect(results[0]?.output).toEqual({ projects: [{ id: "p1", name: "Acme" }] });
    // The transform step has no request → input null but keeps its output.
    expect(results[1]?.input).toBeNull();
    expect(results[1]?.output).toEqual([{ id: "p1" }]);
  });

  test("uses the held request as input for a write held during a preview", () => {
    const steps: RawStepResultSource[] = [
      {
        step_key: "send",
        kind: "request",
        status: "succeeded",
        held: true,
        held_request: { method: "POST", url: "https://api.test/send", body: { to: "x@y.z" } },
      },
    ];
    const [result] = buildRawStepResults(steps);
    expect(result?.input).toEqual({
      method: "POST",
      url: "https://api.test/send",
      body: { to: "x@y.z" },
    });
  });

  test("surfaces the pre-selector raw envelope + step error when present", () => {
    const steps: RawStepResultSource[] = [
      {
        step_key: "fetch",
        kind: "request",
        status: "failed",
        output_preview: { picked: 1 },
        raw_preview: { full: { picked: 1, dropped: 2 } },
        error: { code: "http_4xx", message: "bad request" },
      },
    ];
    const [result] = buildRawStepResults(steps);
    expect(result?.raw_output).toEqual({ full: { picked: 1, dropped: 2 } });
    expect(result?.error).toEqual({ code: "http_4xx", message: "bad request" });
  });
});
