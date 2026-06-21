// Unit tests for summarizeToolFailure — the log-enrichment that lifts a
// structured ok:false rejection reason (top-level error_code/message) into
// the conversation.tool.failed log line. Regression guard for the production
// symptom where ask_user_form / probe_connector_draft credential_form_mismatch
// failures logged a bare ok:false carrying only data_keys (no WHY).

import { describe, expect, test } from "bun:test";
import { summarizeToolFailure } from "./policy-helpers.ts";

describe("summarizeToolFailure", () => {
  test("ok:true → {} (success lines stay clean)", () => {
    expect(summarizeToolFailure({ ok: true })).toEqual({});
  });

  test("ok:false with error_code + message → both surfaced (message as `error`)", () => {
    expect(
      summarizeToolFailure({
        ok: false,
        error_code: "credential_form_mismatch",
        message: "Form fields do not match the connector's auth shape.",
      }),
    ).toEqual({
      error_code: "credential_form_mismatch",
      error: "Form fields do not match the connector's auth shape.",
    });
  });

  test("transport failure code is surfaced", () => {
    expect(
      summarizeToolFailure({
        ok: false,
        error_code: "elicitation_transport_failed",
        message: "The MCP elicitation request failed in transit.",
      }),
    ).toEqual({
      error_code: "elicitation_transport_failed",
      error: "The MCP elicitation request failed in transit.",
    });
  });

  test("ok:false with only error_code → just the code", () => {
    expect(summarizeToolFailure({ ok: false, error_code: "connector_auth_unset" })).toEqual({
      error_code: "connector_auth_unset",
    });
  });

  test("ok:false with neither field → {} (nothing to add)", () => {
    expect(summarizeToolFailure({ ok: false })).toEqual({});
  });
});
