// Bug E regression: when run_workflow output ran through
// describeToolOutput, the fallback "fields: mode, stage,
// lifecycle_state, resource_kind, resource_id" rendered with no
// status, no warning text, no actual workflow output (session
// 86de186b continuation: the user saw "(called 5×)" but no
// human-readable result). Post-fix describeToolOutput recognises
// the run_workflow lifecycle payload and surfaces status + warnings
// + output shape.

import { describe, expect, test } from "bun:test";
import { synthesizeFallbackMessage } from "../turn-helpers.ts";
import type { TurnEvent } from "../types.ts";

function toolResultEvent(tool: string, output: Record<string, unknown>): TurnEvent {
  return {
    type: "tool_result",
    call_id: `tc-${tool}`,
    tool,
    output,
  };
}

describe("synthesizeFallbackMessage · run_workflow describe (bug E / 86de186b)", () => {
  test("surfaces status + warnings + output shape, not just the field list", () => {
    const events: TurnEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(
        toolResultEvent("run_workflow", {
          mode: "execution",
          stage: "post-run",
          lifecycle_state: "ran",
          resource_kind: "workflow",
          resource_id: "wf-x",
          status: "partial_success",
          requires_repair: true,
          warnings: [{ code: "loop_body_empty", message: "no rows" }],
          output: [],
        }),
      );
    }
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 1 });
    expect(msg).toBeTruthy();
    // No more "fields: mode, stage, lifecycle_state, …" — that was the bug.
    expect(msg).not.toMatch(/fields: mode, stage/);
    // Concrete signal the user can act on.
    expect(msg).toContain("status=partial_success");
    expect(msg).toContain("requires_repair");
    expect(msg).toContain("1 warning");
    expect(msg).toContain("output: 0 rows");
  });

  test("renders error_code when present and no status", () => {
    const events: TurnEvent[] = [
      toolResultEvent("save_connector_draft", { error_code: "slug_already_in_use" }),
      toolResultEvent("save_connector_draft", { error_code: "slug_already_in_use" }),
      toolResultEvent("save_connector_draft", { error_code: "slug_already_in_use" }),
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 1 });
    expect(msg).toContain("slug_already_in_use");
  });

  test("falls back to message string when no other shape matches", () => {
    const events: TurnEvent[] = [];
    for (let i = 0; i < 4; i++) {
      events.push(
        toolResultEvent("random_tool", { message: "the connector hit a transient timeout" }),
      );
    }
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 1 });
    expect(msg).toContain("transient timeout");
  });

  test("legacy 'fields:' fallback is preserved for tools without recognised structure", () => {
    const events: TurnEvent[] = [
      toolResultEvent("unknown_tool", { foo: 1, bar: 2 }),
      toolResultEvent("unknown_tool", { foo: 1, bar: 2 }),
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 1 });
    expect(msg).toMatch(/fields: foo, bar/);
  });

  test("succeeded run_workflow renders 'output: N rows' when output is an array", () => {
    const events: TurnEvent[] = [
      toolResultEvent("run_workflow", {
        status: "succeeded",
        output: [{ project_id: "p1" }, { project_id: "p2" }, { project_id: "p3" }],
      }),
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).toContain("status=succeeded");
    expect(msg).toContain("output: 3 rows");
  });
});
