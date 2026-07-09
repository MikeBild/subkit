// Unit tests for buildResultEnvelope — the pure MCP result-envelope
// shaper.
//
// A `wf_*` run over MCP now executes its writes directly: the human already
// approved the call via the client's native `destructiveHint` dialog before it
// reached the engine (see `tools/policy.ts` — the MCP surface takes no
// server-side confirm). There is no held-writes preview and no approval
// portal on this path anymore — `buildResultEnvelope` only wraps warnings.

import { describe, expect, test } from "bun:test";
import type { RunResult } from "../../execution/types.ts";
import { buildResultEnvelope } from "./held-preview.ts";

function base(
  overrides: Partial<RunResult>,
): Pick<RunResult, "warnings" | "output" | "execution_id" | "status"> {
  return {
    execution_id: "exec-1",
    status: "succeeded",
    output: { hello: "world" },
    ...overrides,
  };
}

describe("buildResultEnvelope", () => {
  test("clean run → bare output, no wrapper", () => {
    const env = buildResultEnvelope(base({}));
    expect(env.rawBody).toEqual({ hello: "world" });
  });

  test("non-fatal warnings → output+warnings wrapper", () => {
    const warnings = [{ code: "unresolved_identifier" as const, message: "x", step_key: "s" }];
    const env = buildResultEnvelope(base({ warnings }));
    expect(env.rawBody).toEqual({ output: { hello: "world" }, warnings });
  });

  test("empty warnings array is treated as clean (bare output)", () => {
    const env = buildResultEnvelope(base({ warnings: [] }));
    expect(env.rawBody).toEqual({ hello: "world" });
  });

  test("a null output on a clean run stays null, not dropped", () => {
    const env = buildResultEnvelope(base({ output: null }));
    expect(env.rawBody).toBeNull();
  });

  test("takes exactly one argument — no preview/confirm envelope is threaded through", () => {
    // Signature pin: the old two-arg shape (result, previewEnvelope) is gone.
    expect(buildResultEnvelope.length).toBe(1);
  });
});
