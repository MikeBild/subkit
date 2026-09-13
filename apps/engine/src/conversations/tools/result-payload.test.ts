// The write shape and its discriminator, tested together.
//
// `normalizeToolResultPayload` produces what lands on
// `conversation_tool_calls.output`; `toolCallOutcome` produces what lands on
// `conversation_tool_calls.outcome`. The first test below is the reason the
// second function has to exist at all.

import { describe, expect, test } from "bun:test";

import type { ToolResult, ToolResultPause } from "./index.ts";
import { normalizeToolResultPayload, toolCallOutcome } from "./result-payload.ts";

describe("a failure that is indistinguishable in the payload", () => {
  // `ToolResult`'s failure branch makes `error_code` AND `message` optional,
  // and the legacy `data` object is spread through without an `ok:false`
  // marker. This is the case a read-time sniff over `output` gets wrong.
  const failed: ToolResult = { ok: false, data: { rows: [] } };
  const succeeded: ToolResult = { ok: true, data: { rows: [] } };

  test("the persisted payload is byte-identical to a success payload", () => {
    expect(JSON.stringify(normalizeToolResultPayload(failed))).toBe(
      JSON.stringify(normalizeToolResultPayload(succeeded)),
    );
  });

  test("toolCallOutcome still reports error for ok:false with no error_code and no message", () => {
    expect(toolCallOutcome(failed)).toBe("error");
    expect(toolCallOutcome(succeeded)).toBe("ok");
  });
});

describe("toolCallOutcome", () => {
  test("ok", () => {
    expect(toolCallOutcome({ ok: true, data: { workflows: [] } })).toBe("ok");
    expect(toolCallOutcome({ ok: true, data: null })).toBe("ok");
  });

  test("error — structured rejection with an error_code that is not a refusal", () => {
    expect(toolCallOutcome({ ok: false, error_code: "invalid_arguments", message: "no" })).toBe(
      "error",
    );
    expect(toolCallOutcome({ ok: false })).toBe("error");
    expect(toolCallOutcome({ ok: false, data: "plain string failure" })).toBe("error");
  });

  test("denied — the RBAC gate's default envelope", () => {
    expect(
      toolCallOutcome({
        ok: false,
        data: { error: "permission_denied", permission: "workflow:run", reason: "no role" },
      }),
    ).toBe("denied");
  });

  test("denied — a tool's nested error-code envelope (call_connector shape)", () => {
    expect(
      toolCallOutcome({
        ok: false,
        data: {
          error: { code: "permission_denied", message: "nope" },
          permission: "connector:read",
        },
      }),
    ).toBe("denied");
  });

  test("denied — a top-level error_code envelope (request_connector_reauth shape)", () => {
    expect(toolCallOutcome({ ok: false, error_code: "permission_denied", message: "nope" })).toBe(
      "denied",
    );
  });

  test("denied — the evaluator's permission_denied:<permission> reason form", () => {
    expect(toolCallOutcome({ ok: false, error_code: "permission_denied:workflow:run" })).toBe(
      "denied",
    );
  });

  test("denied — the `denied: true` marker the fast path writes", () => {
    expect(
      toolCallOutcome({ ok: false, data: { ok: false, denied: true, reason: "no role" } }),
    ).toBe("denied");
  });

  test("denied — the palette's policy refusals", () => {
    expect(toolCallOutcome({ ok: false, error_code: "policy_confirm_required" })).toBe("denied");
    expect(toolCallOutcome({ ok: false, error_code: "not_available_on_surface" })).toBe("denied");
  });

  test("pending — a paused result, whichever ok flag the tool used to halt the loop", () => {
    const pause: ToolResultPause = {
      tool_name: "ask_user_confirm",
      summary: "confirm?",
      elicitation_id: "el-1",
    };
    expect(toolCallOutcome({ ok: false, data: { status: "awaiting_confirmation" }, pause })).toBe(
      "pending",
    );
    expect(toolCallOutcome({ ok: true, data: null, pause })).toBe("pending");
  });

  test("pending wins over a denial marker on the same paused result", () => {
    expect(
      toolCallOutcome({
        ok: false,
        error_code: "permission_denied",
        pause: { tool_name: "ask_user_confirm", summary: "s", elicitation_id: "el-2" } as const,
      }),
    ).toBe("pending");
  });
});
