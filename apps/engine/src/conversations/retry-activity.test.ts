import { describe, expect, test } from "bun:test";
import { fallbackRetryActivity, toolRetry } from "./retry-activity.ts";
import { MAX_CONSECUTIVE_FAILURES } from "./tools/sdk-wrap/state.ts";

const signals = (consecutiveFailures: number, failed: string[] = []) => ({
  consecutiveFailures,
  toolLastErrorHash: new Map(failed.map((tool) => [tool, "shape"])),
});

describe("toolRetry", () => {
  test("a first call carries no retry", () => {
    expect(toolRetry(signals(0), "call_connector")).toEqual({});
  });

  test("calling a tool again after it failed counts the retry against the cap", () => {
    expect(toolRetry(signals(1, ["call_connector"]), "call_connector")).toEqual({
      retry: { attempt: 1, of: MAX_CONSECUTIVE_FAILURES - 1 },
    });
    expect(toolRetry(signals(3, ["call_connector"]), "call_connector")).toEqual({
      retry: { attempt: 3, of: MAX_CONSECUTIVE_FAILURES - 1 },
    });
  });

  test("a different tool after a failure is not a retry", () => {
    expect(toolRetry(signals(2, ["call_connector"]), "search_knowledge")).toEqual({});
  });

  test("no retry is announced once the cap blocks further calls", () => {
    expect(
      toolRetry(signals(MAX_CONSECUTIVE_FAILURES, ["call_connector"]), "call_connector"),
    ).toEqual({});
  });
});

describe("fallbackRetryActivity", () => {
  test("announces the single fallback attempt as an activity frame", () => {
    expect(fallbackRetryActivity()).toMatchObject({
      type: "activity",
      phase: "composing",
      retry: { attempt: 1, of: 1 },
    });
  });
});
