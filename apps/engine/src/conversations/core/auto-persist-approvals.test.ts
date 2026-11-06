import { describe, expect, test } from "bun:test";
import {
  completionAudit,
  connectorEnvironment,
  credentialFlowResult,
  dispatchErrorSynthetic,
  findBlockedCallToRetry,
  gatedCallOutcome,
  heldTargetMissing,
  heldWorkflowSlug,
  isAuthFailureOutput,
  pgErrorFields,
  relayGrantResult,
  replayInput,
  stringOrNull,
  usesDirectConnectorApproval,
} from "./auto-persist.ts";

describe("held workflow writes", () => {
  test("the slug follows the workflow tool prefix", () => {
    expect(heldWorkflowSlug("wf_orders", "wf_")).toBe("orders");
    expect(heldWorkflowSlug("call_connector", "wf_")).toBeNull();
  });

  test("a missing saved workflow asks for a fresh preview", () => {
    expect(heldTargetMissing("orders", "ap", "wf_orders")).toStrictEqual({
      reason: "workflow_not_found",
      result: {
        ok: false,
        error_code: "workflow_not_found",
        message:
          'No saved workflow matches "orders" — it may have been renamed or deleted since the preview, so nothing was written. Re-run it to obtain a fresh preview.',
        data: { workflow_slug: "orders" },
        next_best_actions: ["find_workflow", "list_workflows"],
      },
    });
  });

  test("a non-workflow tool is an invalid approval target", () => {
    expect(heldTargetMissing(null, "ap", "call_connector")).toStrictEqual({
      reason: "not_a_workflow_tool",
      result: {
        ok: false,
        error_code: "invalid_approval_target",
        message:
          "Approval ap was granted for call_connector, which is not a saved-workflow tool — nothing was written.",
        data: {},
        next_best_actions: ["find_workflow", "list_workflows"],
      },
    });
  });

  test("empty approved args replay as no input", () => {
    expect(replayInput({})).toBeNull();
    const args = { a: 1 };
    expect(replayInput(args)).toBe(args);
  });
});

describe("relayed and confirmed tool calls", () => {
  test("a granted relay tells the model to re-issue", () => {
    expect(relayGrantResult(true, "mcp_x")).toStrictEqual({
      ok: true,
      data: {
        status: "approved",
        granted: true,
        tool: "mcp_x",
        note: "The operator approved mcp_x. It has NOT run yet — the engine cannot perform an external MCP call for you. Re-issue mcp_x with __policy_confirmed: true and __policy_confirm_id set to the confirm_id you were given; the engine replays the arguments it already holds.",
      },
    });
  });

  test("an ungranted relay says nothing will run", () => {
    expect(relayGrantResult(false, "mcp_x")).toStrictEqual({
      ok: false,
      error_code: "approval_not_granted",
      message:
        "mcp_x was not granted (the answer did not come from a person, or the approval expired). Nothing ran and nothing will — a person must approve it before mcp_x can be re-issued.",
      data: { status: "not_granted", granted: false, tool: "mcp_x" },
    });
  });

  test("only direct connector tools carry the connector approval", () => {
    expect(usesDirectConnectorApproval("call_connector")).toBe(true);
    expect(usesDirectConnectorApproval("probe_connector")).toBe(true);
    expect(usesDirectConnectorApproval("test_connector")).toBe(false);
  });
});

describe("credential flows", () => {
  test("reads only string payload fields", () => {
    expect(stringOrNull("")).toBe("");
    expect(stringOrNull("c")).toBe("c");
    expect(stringOrNull(1)).toBeNull();
  });

  test("auth failures are matched exactly", () => {
    for (const code of [
      "auth_failed",
      "credential_missing",
      "credential_invalid",
      "credential_expired",
    ]) {
      expect(isAuthFailureOutput({ error_code: code })).toBe(true);
    }
    for (const code of [
      "xauth_failed",
      "auth_failedx",
      "credential_other",
      "credential_missingx",
    ]) {
      expect(isAuthFailureOutput({ error_code: code })).toBe(false);
    }
    expect(isAuthFailureOutput({ error_code: 1 })).toBe(false);
    expect(isAuthFailureOutput({ error_code: ["auth_failed"] })).toBe(false);
    expect(isAuthFailureOutput({ status: "auth_failed" })).toBe(true);
    expect(isAuthFailureOutput({ status: "failed" })).toBe(false);
    expect(isAuthFailureOutput(null)).toBe(false);
  });

  test("the newest retryable auth failure on the same connector is retried", () => {
    const failed = { error_code: "auth_failed" };
    const rows = [
      { tool: "ask_user_confirm", input: { connector_id: "c" }, output: failed },
      { tool: "call_connector", input: { connector_id: "other" }, output: failed },
      { tool: "call_connector", input: { connector_id: "c" }, output: { ok: true } },
      { tool: "call_connector", input: null, output: failed },
      { tool: "dry_run_workflow", input: { connector_id: "c", n: 1 }, output: failed },
      { tool: "run_workflow", input: { connector_id: "c", n: 2 }, output: failed },
    ];
    expect(findBlockedCallToRetry(rows, "c")).toStrictEqual({
      tool: "dry_run_workflow",
      input: { connector_id: "c", n: 1 },
    });
    for (const tool of ["run_workflow", "probe_connector", "test_connector", "call_connector"]) {
      expect(
        findBlockedCallToRetry([{ tool, input: { connector_id: "c" }, output: failed }], "c"),
      ).toStrictEqual({
        tool,
        input: { connector_id: "c" },
      });
    }
    expect(findBlockedCallToRetry(rows.slice(0, 4), "c")).toBeNull();
  });

  test("a completed oauth flow with a blocked call names it", () => {
    expect(
      credentialFlowResult({
        oauthFlow: true,
        credentialPresent: true,
        connectorId: "c",
        connectorSlug: "slug",
        blockedCallToRetry: { tool: "call_connector", input: { a: 1 } },
      }),
    ).toStrictEqual({
      ok: true,
      data: {
        authenticated: true,
        connector_id: "c",
        connector_slug: "slug",
        blocked_call_to_retry: { tool: "call_connector", input: { a: 1 } },
        note: "OAuth flow completed. The saved credential is now active. Retry the call that was blocked on this connector: call_connector(...). The same input shape is in blocked_call_to_retry.input — re-issue verbatim.",
      },
    });
  });

  test("a completed re-issue without a blocked call gives the generic note", () => {
    expect(
      credentialFlowResult({
        oauthFlow: false,
        credentialPresent: true,
        connectorId: null,
        connectorSlug: null,
        blockedCallToRetry: null,
      }),
    ).toStrictEqual({
      ok: true,
      data: {
        reconnected: true,
        note: "Credential re-issue completed. The saved credential is now active; retry the call_connector / dry_run_workflow / run_workflow that was blocked on this connector.",
      },
    });
  });

  test("an oauth flow without a credential is not authenticated", () => {
    expect(
      credentialFlowResult({
        oauthFlow: true,
        credentialPresent: false,
        connectorId: "c",
        connectorSlug: "slug",
        blockedCallToRetry: null,
      }),
    ).toStrictEqual({
      ok: false,
      error_code: "oauth_not_completed",
      message:
        "No OAuth credential was minted for this connector — the provider never completed the authorization callback, so the connector is NOT authenticated. Do NOT retry the connector or report success. Causes: the authorization URL was not actually completed in the browser, or the provider rejected it (the redirect URI is not registered in the provider app, or a requested scope is not approved). Have the operator open the authorization URL, finish the consent so the provider redirects back to the engine callback, THEN call authenticate_oauth again to resume waiting for the token.",
      data: { authenticated: false, connector_id: "c", connector_slug: "slug" },
      next_best_actions: ["authenticate_oauth"],
    });
  });

  test("a re-issue without a credential is not reconnected", () => {
    expect(
      credentialFlowResult({
        oauthFlow: false,
        credentialPresent: false,
        connectorId: null,
        connectorSlug: null,
        blockedCallToRetry: null,
      }),
    ).toStrictEqual({
      ok: false,
      error_code: "credential_reissue_not_completed",
      message:
        "No replacement credential is stored for this connector. The credential-setup flow was not completed, so the connector is NOT reconnected. Do not retry the connector or report success; run request_connector_reauth again and complete the URL elicitation.",
      data: { reconnected: false },
      next_best_actions: ["request_connector_reauth"],
    });
  });

  test("only prod connectors read the prod credential", () => {
    expect(connectorEnvironment("prod")).toBe("prod");
    expect(connectorEnvironment("dev")).toBe("dev");
    expect(connectorEnvironment(undefined)).toBe("dev");
  });
});

describe("finishing a dispatch", () => {
  test("reads postgres error fields or null", () => {
    expect(pgErrorFields({ code: "23505", constraint: "uq", detail: "dup" })).toStrictEqual({
      pg_code: "23505",
      pg_constraint: "uq",
      pg_detail: "dup",
    });
    expect(pgErrorFields(null)).toStrictEqual({
      pg_code: null,
      pg_constraint: null,
      pg_detail: null,
    });
    expect(pgErrorFields(new Error("x"))).toStrictEqual({
      pg_code: null,
      pg_constraint: null,
      pg_detail: null,
    });
  });

  test("a thrown dispatch becomes a synthetic failure", () => {
    expect(
      dispatchErrorSynthetic("save_connector_draft", {
        error_code: "e",
        message: "m",
        next_best_actions: ["a"],
      }),
    ).toStrictEqual({
      tool: "save_connector_draft",
      ok: false,
      error_code: "e",
      message: "m",
      next_best_actions: ["a"],
      source: "harness_auto_persist",
    });
  });

  test("a prepared or ok result marks the gated call ok", () => {
    expect(gatedCallOutcome({ ok: true, data: null }, false)).toBe("ok");
    expect(gatedCallOutcome({ ok: false }, true)).toBe("ok");
    expect(gatedCallOutcome({ ok: false }, false)).toBe("error");
  });

  test("a submitted run input resumes the conversation", () => {
    expect(
      completionAudit({
        kind: "run_workflow",
        toolName: "run_workflow",
        result: { ok: false, error_code: "held" },
        prepared: true,
        conversationId: "conv",
      }),
    ).toStrictEqual({
      resumed: true,
      reason: "workflow_input_submitted",
      result: "success",
      metadata: {
        commit_intent_kind: "run_workflow",
        tool: "run_workflow",
        ok: false,
        preparation: true,
        conversation_id: "conv",
      },
    });
  });

  test("a failed confirmation records its error code", () => {
    expect(
      completionAudit({
        kind: "save_connector_draft",
        toolName: "save_connector_draft",
        result: { ok: false, error_code: "bad" },
        prepared: false,
        conversationId: "conv",
      }),
    ).toStrictEqual({
      resumed: false,
      reason: "auto_persist_on_confirmation",
      result: "error",
      metadata: {
        commit_intent_kind: "save_connector_draft",
        tool: "save_connector_draft",
        ok: false,
        conversation_id: "conv",
        error_code: "bad",
      },
    });
    expect(
      completionAudit({
        kind: "delete_workflow",
        toolName: "delete_workflow",
        result: { ok: false },
        prepared: false,
        conversationId: "conv",
      }).metadata.error_code,
    ).toBeNull();
  });

  test("a follow-up pause is linked in the audit metadata", () => {
    expect(
      completionAudit({
        kind: "save_workflow_draft",
        toolName: "save_workflow_draft",
        result: {
          ok: true,
          data: null,
          pause: { tool_name: "ask_user_confirm", summary: "s", elicitation_id: "el" },
        },
        prepared: false,
        conversationId: "conv",
      }),
    ).toStrictEqual({
      resumed: false,
      reason: "auto_persist_on_confirmation",
      result: "success",
      metadata: {
        commit_intent_kind: "save_workflow_draft",
        tool: "save_workflow_draft",
        ok: true,
        follow_up_elicitation_id: "el",
        conversation_id: "conv",
      },
    });
  });
});
