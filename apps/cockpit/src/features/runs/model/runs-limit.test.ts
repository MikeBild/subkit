import { describe, expect, test } from "bun:test";
import { type Locale, translate } from "@/lib/i18n";
import { stepLimitSentence } from "./runs-model";

const tr =
  (locale: Locale) =>
  (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);

const timedOut = {
  step_key: "fetch_orders",
  error: { code: "step_timeout", message: "request exceeded 30000ms" },
};

describe("the sentence names the limit that stopped a step", () => {
  test("names the time limit, the step and where to raise it", () => {
    expect(stepLimitSentence(timedOut, tr("en"), "en")).toBe(
      "Step “fetch_orders” stopped after its 30 s limit. To give it more time, raise timeout_ms on this step in the workflow.",
    );
    expect(stepLimitSentence(timedOut, tr("de"), "de")).toBe(
      tr("de")("runs.outcome.limit.time", { step: "fetch_orders", limit: "30 s" }),
    );
  });

  test("points to the operator when the ceiling clamped a transform", () => {
    const clamped = {
      step_key: "shape",
      error: {
        code: "transform_timeout",
        message:
          "transform exceeded 300000ms (operator ceiling sandbox.max_transform_wall_ms; timeout_ms 900000 was clamped)",
      },
    };
    expect(stepLimitSentence(clamped, tr("en"), "en")).toContain("sandbox.max_transform_wall_ms");
    expect(stepLimitSentence(clamped, tr("en"), "en")).toContain("5 min");
  });

  test("names output limits with their value", () => {
    const pages = {
      step_key: "list",
      error: {
        code: "pagination_limit_reached",
        message: "pagination reached max_pages=1000 before the endpoint terminated",
      },
    };
    expect(stepLimitSentence(pages, tr("de"), "de")).toBe(
      tr("de")("runs.outcome.limit.pages", { step: "list", limit: "1.000" }),
    );
    expect(stepLimitSentence(pages, tr("en"), "en")).toContain("raise max_pages");
    const response = {
      step_key: "download",
      error: {
        code: "request_invalid",
        message: "response too large: exceeds max_response_bytes 10485760",
      },
    };
    expect(stepLimitSentence(response, tr("en"), "en")).toContain("10 MB");
  });

  test("stays silent without a limit value", () => {
    expect(stepLimitSentence(null, tr("en"), "en")).toBeNull();
    expect(
      stepLimitSentence(
        { step_key: "x", error: { code: "auth_failed", message: "401" } },
        tr("en"),
        "en",
      ),
    ).toBeNull();
  });
});
