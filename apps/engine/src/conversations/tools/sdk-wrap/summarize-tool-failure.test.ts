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
        error_code: "oauth_elicitation_transport_failed",
        message: "The MCP elicitation request failed in transit.",
      }),
    ).toEqual({
      error_code: "oauth_elicitation_transport_failed",
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

  // Most authoring tools pack the reason INTO `data` (run_workflow's
  // data.error_code, dry_run_workflow's data.summary). Without a data fallback
  // these logged `undefined` — the exact gap the keyed benchmark surfaced
  // (tool.failed [dry_run_workflow] — undefined).
  test("ok:false with error_code in data → surfaced via fallback", () => {
    expect(
      summarizeToolFailure({
        ok: false,
        data: { error_code: "workflow_not_persisted", message: "commit the draft first" },
      }),
    ).toEqual({ error_code: "workflow_not_persisted", error: "commit the draft first" });
  });

  test("ok:false dry-run-shaped data (reason + summary) → reason as code, summary as error", () => {
    expect(
      summarizeToolFailure({
        ok: false,
        data: {
          reason: "draft_step_failed",
          summary: "Run stopped at step `scrape`: http 400",
          classification: "needs_repair",
        },
      }),
    ).toEqual({ error_code: "draft_step_failed", error: "Run stopped at step `scrape`: http 400" });
  });

  test("top-level error_code wins over data when both present", () => {
    expect(
      summarizeToolFailure({
        ok: false,
        error_code: "preview_judge_failed",
        message: "judge blocked",
        data: { error_code: "ignored", summary: "ignored too" },
      }),
    ).toEqual({ error_code: "preview_judge_failed", error: "judge blocked" });
  });
});
