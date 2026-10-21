import { describe, expect, test } from "bun:test";
import { PendingElicitationBlockedError } from "../conversations/service/shared.ts";
import type { ToolResultPause } from "../conversations/tools/index.ts";
import type { ConfirmEnvelope, ToolEnvelope } from "../tools/types.ts";
import { envelopeToMcpResponse } from "./adapter.ts";
import { mcpErrorCodeOf, toMcpErrorText } from "./error-adapter.ts";

const confirm: ConfirmEnvelope = {
  tool: "call_connector",
  pending_output: { connector_id: "c1", method: "DELETE" },
  policy_mode: "confirm_before_execution",
  reason: "computed_from_input",
  tool_call_id: "tc-123",
  resume: "Approve the delete to continue.",
  approval_url: "https://engine.example.test/v1/tool-approvals/decide?grant=skag_test",
};

describe("envelopeToMcpResponse — locally verifiable approval", () => {
  test("renders the pending boundary and human portal link without claiming execution", () => {
    const envelope: ToolEnvelope = { status: "needs_confirm", confirm };
    const response = envelopeToMcpResponse(envelope);
    expect(response.isError).toBe(false);
    expect(JSON.parse(response.content[0]!.text)).toEqual({ status: "needs_confirm", ...confirm });
    expect(response._meta?.subkit).toEqual({ confirm });
  });
});

describe("envelopeToMcpResponse — ok rendering", () => {
  test("status:'ok' renders isError:false with the data JSON-encoded", () => {
    const envelope: ToolEnvelope = { status: "ok", data: { hello: "world" } };
    const res = envelopeToMcpResponse(envelope);
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ hello: "world" });
    expect(res._meta).toBeUndefined();
  });

  test("status:'ok' with a pause carries _meta.subkit.paused", () => {
    const pause: ToolResultPause = {
      tool_name: "ask_user_confirm",
      summary: "Confirm the delete",
      elicitation_id: "elic-1",
    };
    const envelope: ToolEnvelope = { status: "ok", data: { hello: "world" }, pause };
    const res = envelopeToMcpResponse(envelope);
    expect(res.isError).toBe(false);
    expect(res._meta?.subkit).toEqual({ paused: pause });
  });
});

describe("envelopeToMcpResponse — error rendering", () => {
  test("status:'error' renders isError:true with a structured JSON body", () => {
    const envelope: ToolEnvelope = {
      status: "error",
      error_code: "tool_failed",
      message: "boom",
      next_best_actions: ["retry"],
    };
    const res = envelopeToMcpResponse(envelope);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(parsed.error_code).toBe("tool_failed");
    expect(parsed.message).toBe("boom");
    expect(parsed.next_best_actions).toEqual(["retry"]);
  });
});

describe("envelopeToMcpResponse — paused rendering", () => {
  test("status:'paused' renders isError:false with the pause both in content and _meta", () => {
    const pause: ToolResultPause = {
      tool_name: "ask_user_text",
      summary: "What is the workflow name?",
      elicitation_id: "elic-2",
    };
    const envelope: ToolEnvelope = { status: "paused", pause };
    const res = envelopeToMcpResponse(envelope);
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content[0]!.text)).toEqual(pause);
    expect(res._meta?.subkit).toEqual({ paused: pause });
  });
});

describe("envelopeToMcpResponse — not_available_on_surface rendering", () => {
  test("renders isError:true with the reason in both content and _meta", () => {
    const envelope: ToolEnvelope = {
      status: "not_available_on_surface",
      reason: "this tool needs a live conversation draft",
    };
    const res = envelopeToMcpResponse(envelope);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(parsed.error_code).toBe("not_available_on_surface");
    expect(parsed.reason).toBe("this tool needs a live conversation draft");
    expect(res._meta?.subkit).toEqual({
      not_available_on_surface: { reason: "this tool needs a live conversation draft" },
    });
  });
});

describe("toMcpErrorText — conversation turn errors", () => {
  test("a pending dialog renders as a coded text", () => {
    const err = new PendingElicitationBlockedError({
      id: "elicitation-1",
      tool_name: "ask_user_confirm",
      summary: "confirm proceed",
    });
    expect(toMcpErrorText(err)).toBe(
      "pending_elicitation_blocked: resolve the pending dialog before sending another prompt",
    );
    expect(mcpErrorCodeOf(err)).toBe("pending_elicitation_blocked");
  });

  test.each(["conversation_turn_superseded", "conversation_cancelled"])(
    "a bare %s abort reason renders as a stable aborted text",
    (reason) => {
      expect(toMcpErrorText(reason)).toBe(`conversation_turn_aborted: ${reason}`);
      expect(mcpErrorCodeOf(reason)).toBe(reason);
    },
  );

  test("an unknown string stays verbatim", () => {
    expect(toMcpErrorText("something else")).toBe("something else");
    expect(mcpErrorCodeOf("something else")).toBeUndefined();
  });
});
