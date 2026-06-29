// Unit tests for buildResultEnvelope — the pure MCP result-envelope
// shaper. Pins the honest-preview contract without a live MCP handler.

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
  test("clean run → bare output, no preview, no _meta", () => {
    const env = buildResultEnvelope(base({}));
    expect(env.isHeldPreview).toBe(false);
    expect(env.rawBody).toEqual({ hello: "world" });
    expect(env.previewMeta).toEqual({});
  });

  test("non-held warnings → output+warnings wrapper, still no preview", () => {
    const warnings = [{ code: "unresolved_identifier" as const, message: "x", step_key: "s" }];
    const env = buildResultEnvelope(base({ warnings }));
    expect(env.isHeldPreview).toBe(false);
    expect(env.rawBody).toEqual({ output: { hello: "world" }, warnings });
    expect(env.previewMeta).toEqual({});
  });

  test("held_preview_no_writes → preview envelope + _meta.subkit.execution.preview", () => {
    const warnings = [
      {
        code: "held_preview_no_writes" as const,
        message: "Preview run … execute_writes:true …",
        step_key: "$holds",
        details: {
          held_steps: ["send"],
          skipped_steps: ["confirm"],
          would_write: [{ step: "send", method: "POST", url: "https://api/send" }],
        },
      },
    ];
    const env = buildResultEnvelope(base({ warnings }));
    expect(env.isHeldPreview).toBe(true);
    expect(env.heldMessage).toContain("execute_writes:true");
    const body = env.rawBody as Record<string, unknown>;
    expect(body.preview).toBe(true);
    expect(body.writes_held).toBe(true);
    expect(body.held_steps).toEqual(["send"]);
    expect(body.would_write).toEqual([{ step: "send", method: "POST", url: "https://api/send" }]);
    expect(body.output).toEqual({ hello: "world" });
    const meta = env.previewMeta as {
      _meta?: { subkit?: { execution?: { preview?: boolean; held_steps?: unknown } } };
    };
    expect(meta._meta?.subkit?.execution?.preview).toBe(true);
    expect(meta._meta?.subkit?.execution?.held_steps).toEqual(["send"]);
  });
});
