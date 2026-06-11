// Bug E regression: when run_workflow output ran through
// describeToolOutput, the fallback "fields: mode, stage,
// lifecycle_state, resource_kind, resource_id" rendered with no
// status, no warning text, no actual workflow output (session
// 86de186b continuation: the user saw "(called 5×)" but no
// human-readable result). Post-fix describeToolOutput recognises
// the run_workflow lifecycle payload and surfaces status + warnings
// + output shape.

import { describe, expect, test } from "bun:test";
import { classifyFallbackSynthesis, synthesizeFallbackMessage } from "../turn-helpers.ts";
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

  test("error_code-only envelope renders as humanised prose, never the raw token", () => {
    const events: TurnEvent[] = [
      toolResultEvent("save_connector_draft", { error_code: "slug_already_in_use" }),
      toolResultEvent("save_connector_draft", { error_code: "slug_already_in_use" }),
      toolResultEvent("save_connector_draft", { error_code: "slug_already_in_use" }),
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 1 });
    // The fallback is operator-facing prose — the machine token must not
    // leak (RC3 of conversation 68b5c87e), and three failures must not
    // be summarised under an "all succeeded" header.
    expect(msg).toContain("slug already in use");
    expect(msg).not.toContain("error_code:");
    expect(msg).not.toContain("all succeeded");
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

  test("lifecycle envelope (probe success) renders humanised line, not envelope keys (session 0ac7593c)", () => {
    // Reproduces the "what's now? nothing happens!" symptom: the
    // probe_connector_draft success envelope used to fall through to
    // `fields: mode, stage, lifecycle_state, resource_kind, resource_id`,
    // leaving the user with no idea what to do next. Post-fix the
    // lifecycle payload renders as a humane summary anchored on the
    // resource and the recommended next action.
    const events: TurnEvent[] = [
      toolResultEvent("probe_connector_draft", {
        mode: "connector",
        stage: "probed",
        lifecycle_state: "connector_probed",
        resource_kind: "connector",
        resource_id: null,
        latest_probe: { ok: true, status_code: 200 },
        next_best_actions: ["save_connector_draft"],
        next_prompt: "Saving si-emobility-jira connector",
      }),
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).toBeTruthy();
    expect(msg).not.toMatch(/fields: mode, stage/);
    // Never-silent guard surfaces `next_prompt` directly as the
    // assistant text when the model emits nothing — that's the
    // actionable one-liner the user actually needs.
    expect(msg).toBe("Saving si-emobility-jira connector");
  });

  test("lifecycle envelope (workflow committed) renders verb + next action", () => {
    const events: TurnEvent[] = [
      toolResultEvent("save_workflow_draft", {
        mode: "workflow",
        stage: "persisted",
        lifecycle_state: "workflow_persisted",
        resource_kind: "workflow",
        resource_id: "wf-jira-tickets",
        next_best_actions: ["run_workflow"],
      }),
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).toContain("workflow wf-jira-tickets: committed");
    expect(msg).toContain("next: run_workflow");
  });

  test("classifyFallbackSynthesis tags the synthesis source for ops triage", () => {
    // next_prompt_from_tool — benign, expected continuity hint.
    const withNextPrompt: TurnEvent[] = [
      toolResultEvent("any_tool", {
        ok: true,
        next_prompt: "Run the workflow",
      }),
    ];
    expect(classifyFallbackSynthesis({ events: withNextPrompt, loopWarnings: 0 })).toEqual({
      text: "Run the workflow",
      reason: "next_prompt_from_tool",
    });
    // tool_results_summary — model went silent after a tool fired but
    // the tool had no next_prompt; worth growing a hint.
    const summaryShape: TurnEvent[] = [
      toolResultEvent("any_tool", {
        ok: true,
        status: "succeeded",
        output: [{ id: 1 }, { id: 2 }],
      }),
    ];
    expect(classifyFallbackSynthesis({ events: summaryShape, loopWarnings: 0 })?.reason).toBe(
      "tool_results_summary",
    );
    // loop_warnings_no_signal — emergency apology line, no tool ran
    // but the loop guard still tripped.
    expect(classifyFallbackSynthesis({ events: [], loopWarnings: 2 })?.reason).toBe(
      "loop_warnings_no_signal",
    );
    // No signal at all → null (caller should leave the turn silent).
    expect(classifyFallbackSynthesis({ events: [], loopWarnings: 0 })).toBeNull();
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
