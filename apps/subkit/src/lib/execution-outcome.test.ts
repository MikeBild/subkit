import { describe, expect, test } from "bun:test";
import {
  executionOutcomeLine,
  recordLinkLines,
  sensitiveDiagnosticsLine,
  stepLimitLine,
} from "./execution-outcome.ts";

describe("recordLinkLines", () => {
  test("each record link names the system, the record and its web address", () => {
    expect(
      recordLinkLines([
        {
          label: "acme/app#42",
          url: "https://github.com/acme/app/issues/42",
          connector: "github",
          connector_name: "GitHub",
          step_key: "create_issue",
        },
        {
          label: null,
          url: "https://www.notion.so/Plan-0123",
          connector: "notion",
          connector_name: "Notion",
          step_key: "page",
        },
      ]),
    ).toEqual([
      "GitHub · acme/app#42 · https://github.com/acme/app/issues/42",
      "Notion · https://www.notion.so/Plan-0123",
    ]);
  });

  test("a run without links prints nothing", () => {
    expect(recordLinkLines(undefined)).toEqual([]);
    expect(recordLinkLines([])).toEqual([]);
  });
});

const steps = { total: 3, succeeded: 1, failed: 1, held: 0, skipped: 1 };

describe("executionOutcomeLine", () => {
  test("a failed run names the step that stopped it and its cause", () => {
    expect(
      executionOutcomeLine({
        kind: "failed",
        failed_step: { step_key: "fetch", kind: "request" },
        cause_class: "auth_failed",
        error_code: "http_4xx",
        refusal_reason: null,
        connector: null,
        steps,
        output_contract: "none",
        rerun_safety: { mode: "prepare_only", reason: "fixture" },
      }),
    ).toBe(
      "failed at step fetch (request) · auth_failed, http_4xx · steps 1/3 ok, 1 failed, 1 skipped",
    );
  });

  test("a held preview is not reported as a success", () => {
    const line = executionOutcomeLine({
      kind: "held",
      failed_step: null,
      cause_class: null,
      error_code: null,
      refusal_reason: null,
      connector: null,
      steps: { total: 2, succeeded: 1, failed: 0, held: 1, skipped: 0 },
      output_contract: "none",
      rerun_safety: { mode: "prepare_only", reason: "fixture" },
    });
    expect(line).toStartWith("held — writes held, nothing written");
    expect(line).not.toContain("succeeded");
  });

  test("a held reason ends with its plain sentence", () => {
    const line = executionOutcomeLine({
      kind: "failed",
      failed_step: null,
      cause_class: null,
      error_code: "execution_authority_expired",
      refusal_reason: null,
      connector: null,
      steps: { total: 0, succeeded: 0, failed: 0, held: 0, skipped: 0 },
      output_contract: "none",
      rerun_safety: { mode: "prepare_only", reason: "fixture" },
    });
    expect(line).toEndWith(
      "— The approval for this workflow has expired. Approve it again to let it run.",
    );
  });

  test("no outcome prints nothing", () => {
    expect(executionOutcomeLine(null)).toBeNull();
  });
});

describe("stepLimitLine", () => {
  test("names the time limit of the step and where to raise it", () => {
    expect(
      stepLimitLine({
        step_key: "fetch",
        error: { code: "step_timeout", message: "request exceeded 30000ms" },
      }),
    ).toBe(
      "step fetch stopped after its 30 s limit; raise timeout_ms on this step in the workflow",
    );
  });

  test("names a paging limit with its value", () => {
    expect(
      stepLimitLine({
        step_key: "list",
        error: {
          code: "pagination_limit_reached",
          message: "pagination reached max_items=500 before the endpoint terminated",
        },
      }),
    ).toBe("step list stopped at its limit of 500 items; raise max_items in the step’s pagination");
  });

  test("stays silent when the failure carries no limit", () => {
    expect(
      stepLimitLine({ step_key: "x", error: { code: "http_4xx", message: "404" } }),
    ).toBeNull();
  });
});

describe("protected run diagnostics", () => {
  test("a failed protected step names the upstream class, body size and placeholder types", () => {
    expect(
      sensitiveDiagnosticsLine({
        request_meta: {
          driver: "sensitive",
          status_class: "5xx",
          body_size: "<10KB",
          placeholder_types: { "input.body.app.argv": "array", "input.name": "string" },
        },
      }),
    ).toBe(
      "protected run · upstream 5xx · body <10KB · placeholders input.body.app.argv: array, input.name: string",
    );
  });

  test("a protected step without diagnostics and an ordinary step print nothing", () => {
    expect(sensitiveDiagnosticsLine({ request_meta: { driver: "sensitive" } })).toBeNull();
    expect(sensitiveDiagnosticsLine({ request_meta: { driver: "http", status: 503 } })).toBeNull();
    expect(sensitiveDiagnosticsLine({ request_meta: null })).toBeNull();
    expect(sensitiveDiagnosticsLine({})).toBeNull();
  });

  test("the outcome line names the upstream class next to the cause", () => {
    expect(
      executionOutcomeLine({
        kind: "failed",
        failed_step: { step_key: "send", kind: "request" },
        cause_class: "driver_error",
        status_class: "network",
        error_code: "sensitive_execution_failure",
        refusal_reason: null,
        connector: null,
        steps,
        output_contract: "none",
        rerun_safety: { mode: "prepare_only", reason: "fixture" },
      }),
    ).toBe(
      "failed at step send (request) · driver_error, upstream network, sensitive_execution_failure · steps 1/3 ok, 1 failed, 1 skipped",
    );
  });
});
