import { describe, expect, test } from "bun:test";
import type { ToolResult, ToolResultPause } from "./index.ts";
import {
  GENERIC_TOOL_FAILURE_CODE,
  normalizeToolResultPayload,
  toolCallOutcome,
  toolFailureEnvelope,
} from "./result-payload.ts";

describe("a failure without its own error fields", () => {
  const failed: ToolResult = { ok: false, data: { rows: [] } };
  const succeeded: ToolResult = { ok: true, data: { rows: [] } };

  test("the persisted payload carries the canonical failure envelope", () => {
    expect(normalizeToolResultPayload(failed)).toEqual({
      rows: [],
      error_code: GENERIC_TOOL_FAILURE_CODE,
      message: "the tool reported a failure without details",
      next_best_actions: [],
    });
    expect(normalizeToolResultPayload(succeeded)).toEqual({ rows: [] });
  });

  test("toolCallOutcome still reports error for ok:false with no error_code and no message", () => {
    expect(toolCallOutcome(failed)).toBe("error");
    expect(toolCallOutcome(succeeded)).toBe("ok");
  });
});

describe("canonical failure envelope", () => {
  const cases: Array<{
    name: string;
    result: Extract<ToolResult, { ok: false }>;
    expected: unknown;
  }> = [
    {
      name: "top-level fields",
      result: {
        ok: false,
        error_code: "invalid_id",
        message: "not a uuid",
        next_best_actions: ["find_workflow"],
      },
      expected: {
        ok: false,
        error_code: "invalid_id",
        message: "not a uuid",
        next_best_actions: ["find_workflow"],
      },
    },
    {
      name: "fields nested in data",
      result: {
        ok: false,
        data: {
          error_code: "connector_scope_required",
          error: "no connector in scope",
          next_best_actions: ["find_connector"],
          resolvable_connectors: ["crm"],
        },
      },
      expected: {
        error_code: "connector_scope_required",
        error: "no connector in scope",
        message: "no connector in scope",
        next_best_actions: ["find_connector"],
        resolvable_connectors: ["crm"],
      },
    },
    {
      name: "bare prose error",
      result: { ok: false, data: { error: "connector_id is required" } },
      expected: {
        error: "connector_id is required",
        error_code: GENERIC_TOOL_FAILURE_CODE,
        message: "connector_id is required",
        next_best_actions: [],
      },
    },
    {
      name: "bare code error with a prose reason",
      result: {
        ok: false,
        data: { error: "permission_denied", permission: "workflow:run", reason: "no role" },
      },
      expected: {
        error: "permission_denied",
        permission: "workflow:run",
        reason: "no role",
        error_code: "permission_denied",
        message: "no role",
        next_best_actions: [],
      },
    },
    {
      name: "nested error object",
      result: { ok: false, data: { error: { code: "http_4xx", message: "not found" } } },
      expected: {
        error: { code: "http_4xx", message: "not found" },
        error_code: "http_4xx",
        message: "not found",
        next_best_actions: [],
      },
    },
    {
      name: "validation errors list",
      result: { ok: false, data: { errors: [{ path: "steps.0", message: "missing id" }] } },
      expected: {
        errors: [{ path: "steps.0", message: "missing id" }],
        error_code: GENERIC_TOOL_FAILURE_CODE,
        message: "missing id",
        next_best_actions: [],
      },
    },
    {
      name: "plain string data",
      result: { ok: false, data: "plain string failure" },
      expected: {
        ok: false,
        error_code: GENERIC_TOOL_FAILURE_CODE,
        message: "plain string failure",
        next_best_actions: [],
      },
    },
  ];

  for (const { name, result, expected } of cases) {
    test(`chat payload: ${name}`, () => {
      expect(normalizeToolResultPayload(result)).toEqual(expected);
    });

    test(`envelope fields: ${name}`, () => {
      const envelope = toolFailureEnvelope(result);
      const payload = normalizeToolResultPayload(result) as Record<string, unknown>;
      expect(envelope).toEqual({
        error_code: payload.error_code as string,
        message: payload.message as string,
        next_best_actions: payload.next_best_actions as string[],
      });
    });
  }

  test("a paused result keeps its pending payload untouched", () => {
    const pause: ToolResultPause = {
      tool_name: "ask_user_confirm",
      summary: "confirm?",
      elicitation_id: "el-1",
    };
    expect(
      normalizeToolResultPayload({ ok: false, data: { status: "awaiting_confirmation" }, pause }),
    ).toEqual({ status: "awaiting_confirmation" });
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
