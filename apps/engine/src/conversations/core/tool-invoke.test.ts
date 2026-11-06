import { describe, expect, test } from "bun:test";
import {
  argsHashOf,
  committedWorkflowIdFromResult,
  confirmQuestion,
  consecutiveFailuresBlock,
  decideArgsRepeat,
  duplicatePendingOutput,
  errorCodeRepeatBlock,
  executionModeFor,
  failureSignature,
  gateFailureData,
  isCircuitExempt,
  loopDetectedBlock,
  nextErrorCodeStreak,
  nextFingerprintStreak,
  pauseInputPayload,
  policyEnvironmentOf,
  policyPauseNote,
  REPEAT_EXEMPT_TOOLS,
  REPEAT_THRESHOLD,
  stableStringify,
  tracksExecutionSuccess,
  turnBudgetReached,
  validationErrorsOf,
} from "./tool-invoke.ts";

const write = { name: "edit_workflow_patch", category: "draft_write" };

describe("circuit exemptions and budget", () => {
  test("ask_user, inspect and diagnose_latest_execution are exempt", () => {
    expect(isCircuitExempt("ask_user_choice")).toBe(true);
    expect(isCircuitExempt("inspect_workflow")).toBe(true);
    expect(isCircuitExempt("diagnose_latest_execution")).toBe(true);
    expect(isCircuitExempt("diagnose_latest")).toBe(false);
    expect(isCircuitExempt("run_workflow")).toBe(false);
    expect(isCircuitExempt("xask_user_choice")).toBe(false);
    expect(isCircuitExempt("xinspect_workflow")).toBe(false);
  });

  test("the turn budget is reached at two loop warnings", () => {
    expect(turnBudgetReached(1)).toBe(false);
    expect(turnBudgetReached(2)).toBe(true);
    expect(turnBudgetReached(3)).toBe(true);
  });

  test("repeat constants", () => {
    expect(REPEAT_THRESHOLD).toBe(3);
    expect([...REPEAT_EXEMPT_TOOLS]).toEqual([
      "dry_run_workflow",
      "dry_run_step",
      "dry_run_transform",
      "validate_connector_draft",
      "inspect_workflow_draft",
      "inspect_workflow",
      "inspect_connector_draft",
      "inspect_authoring_context",
      "inspect_execution_step",
      "list_skills",
      "load_skill",
      "search_docs",
      "search_knowledge",
    ]);
  });
});

describe("consecutiveFailuresBlock", () => {
  test("cap below the turn budget offers recommended options", () => {
    expect(consecutiveFailuresBlock(5, 1, "\nALT")).toEqual({
      budgetReached: false,
      circuitReason: "consecutive_failures_cap",
      eventMessage:
        "tool.consecutive_failures_block: 5 failed tool calls in a row — emit ask_user_choice / ask_user_text instead of retrying.",
      data: {
        error_code: "consecutive_failures_cap",
        message:
          "5 tool calls have failed in a row — stop patching and emit ask_user_choice with the recommended_options below (or derive your own from the most recent failure). The cap resets on the first successful tool call.\nALT",
        reason: "consecutive_failures_cap",
        consecutive_failures: 5,
        recommended_options: [
          {
            value: "restart_simple",
            label: "Abandon the current draft and start over with a simpler design",
          },
          { value: "inspect_failures", label: "Show me the recent error traces before I decide" },
          { value: "abort", label: "Stop here — I'll come back to this later" },
        ],
        next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
      },
    });
  });

  test("turn budget exhausted ends the turn", () => {
    expect(consecutiveFailuresBlock(6, 2, "\nALT")).toEqual({
      budgetReached: true,
      circuitReason: "turn_loop_budget_exhausted",
      eventMessage:
        "tool.consecutive_failures_block: 6 failed tool calls in a row; turn-level loop budget exhausted (2) — ending turn",
      data: {
        error_code: "turn_loop_budget_exhausted",
        message:
          "this turn failed 6 tool calls in a row and exceeded the loop-warning budget — stop, summarise what you already know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).",
        reason: "turn_loop_budget_exhausted",
        consecutive_failures: 6,
        next_best_actions: ["ask_user_choice", "ask_user_text"],
      },
    });
  });
});

describe("errorCodeRepeatBlock", () => {
  const streak = { code: "connector_not_found", count: 4 };

  test("below the budget reports tool_error_repeat", () => {
    expect(errorCodeRepeatBlock("run_workflow", streak, 1)).toEqual({
      budgetReached: false,
      circuitReason: "error_code_repeat",
      eventMessage:
        "tool.error_code_repeat_block: run_workflow returned `connector_not_found` 4× this turn — different args, same refusal. Stop retrying; emit ask_user_choice / ask_user_text describing the blocker and offering a path forward.",
      data: {
        error_code: "tool_error_repeat",
        message:
          "run_workflow has failed with `connector_not_found` 4× in this turn — the args changed but the blocker did not. Stop retrying and ask the user via ask_user_choice / ask_user_text, or change approach entirely.",
        reason: "tool_error_repeat",
        tool: "run_workflow",
        repeated_error_code: "connector_not_found",
        repeat_count: 4,
        next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
      },
    });
  });

  test("at the budget reports turn_loop_budget_exhausted", () => {
    expect(errorCodeRepeatBlock("run_workflow", streak, 2)).toEqual({
      budgetReached: true,
      circuitReason: "turn_loop_budget_exhausted",
      eventMessage:
        "tool.error_code_repeat_block: run_workflow returned `connector_not_found` 4× this turn — different args, same refusal. Stop retrying; emit ask_user_choice / ask_user_text describing the blocker and offering a path forward.",
      data: {
        error_code: "turn_loop_budget_exhausted",
        message:
          "this turn keeps hitting the same blocker (connector_not_found) — stop, summarise what you know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).",
        reason: "turn_loop_budget_exhausted",
        tool: "run_workflow",
        repeated_error_code: "connector_not_found",
        repeat_count: 4,
        next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
      },
    });
  });
});

describe("stableStringify and argsHashOf", () => {
  test("sorts keys recursively and keeps array order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: null, c: "x" }] })).toBe(
      '{"a":[2,{"c":"x","d":null}],"b":1}',
    );
    expect(stableStringify("s")).toBe('"s"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify([])).toBe("[]");
    expect(stableStringify({})).toBe("{}");
  });

  test("argsHashOf returns an empty string when serialisation throws", () => {
    expect(argsHashOf({ a: 1 })).toBe('{"a":1}');
    expect(argsHashOf({ n: 1n })).toBe("");
  });
});

describe("decideArgsRepeat", () => {
  test("first write call counts one and does not trip", () => {
    expect(
      decideArgsRepeat({
        inner: write,
        argsHash: "h",
        toolArgsRepeat: undefined,
        lastExecutionSuccess: null,
      }),
    ).toEqual({
      isReadOnly: false,
      repeatCount: 1,
      toolArgsRepeat: { hash: "h", count: 1 },
      priorSuccess: undefined,
      repeatsSuccessfulExecution: false,
      tripped: false,
    });
  });

  test("a different hash resets the count", () => {
    const v = decideArgsRepeat({
      inner: write,
      argsHash: "h",
      toolArgsRepeat: { hash: "g", count: 5 },
      lastExecutionSuccess: null,
    });
    expect(v.repeatCount).toBe(1);
    expect(v.toolArgsRepeat).toEqual({ hash: "h", count: 1 });
  });

  test("the third identical call trips", () => {
    const v = decideArgsRepeat({
      inner: write,
      argsHash: "h",
      toolArgsRepeat: { hash: "h", count: 2 },
      lastExecutionSuccess: null,
    });
    expect(v.repeatCount).toBe(3);
    expect(v.tripped).toBe(true);
  });

  test("the second identical call trips when it repeats a successful execution", () => {
    const v = decideArgsRepeat({
      inner: { name: "run_workflow", category: "tenant_write" },
      argsHash: "h",
      toolArgsRepeat: { hash: "h", count: 1 },
      lastExecutionSuccess: { tool: "run_workflow", args_hash: "h", output: { ok: 1 } },
    });
    expect(v).toEqual({
      isReadOnly: false,
      repeatCount: 2,
      toolArgsRepeat: { hash: "h", count: 2 },
      priorSuccess: { ok: 1 },
      repeatsSuccessfulExecution: true,
      tripped: true,
    });
  });

  test("prior success of another tool or hash is ignored", () => {
    const base = {
      inner: { name: "run_workflow", category: "tenant_write" },
      argsHash: "h",
      toolArgsRepeat: { hash: "h", count: 1 },
    };
    expect(
      decideArgsRepeat({
        ...base,
        lastExecutionSuccess: { tool: "wf_x", args_hash: "h", output: 1 },
      }).priorSuccess,
    ).toBeUndefined();
    expect(
      decideArgsRepeat({
        ...base,
        lastExecutionSuccess: { tool: "run_workflow", args_hash: "x", output: 1 },
      }).priorSuccess,
    ).toBeUndefined();
  });

  test("a single call with prior success does not trip", () => {
    const v = decideArgsRepeat({
      inner: { name: "run_workflow", category: "tenant_write" },
      argsHash: "h",
      toolArgsRepeat: undefined,
      lastExecutionSuccess: { tool: "run_workflow", args_hash: "h", output: 1 },
    });
    expect(v.repeatsSuccessfulExecution).toBe(false);
    expect(v.tripped).toBe(false);
  });

  test("read-only tools and empty hashes are not tracked", () => {
    expect(
      decideArgsRepeat({
        inner: { name: "list_workflows", category: "tenant_read" },
        argsHash: "h",
        toolArgsRepeat: { hash: "h", count: 9 },
        lastExecutionSuccess: null,
      }),
    ).toEqual({
      isReadOnly: true,
      repeatCount: 0,
      toolArgsRepeat: null,
      priorSuccess: undefined,
      repeatsSuccessfulExecution: false,
      tripped: false,
    });
    const exempt = decideArgsRepeat({
      inner: { name: "dry_run_workflow", category: "draft_write" },
      argsHash: "h",
      toolArgsRepeat: { hash: "h", count: 9 },
      lastExecutionSuccess: { tool: "dry_run_workflow", args_hash: "h", output: 1 },
    });
    expect(exempt.isReadOnly).toBe(true);
    expect(exempt.tripped).toBe(false);
    const empty = decideArgsRepeat({
      inner: write,
      argsHash: "",
      toolArgsRepeat: { hash: "", count: 9 },
      lastExecutionSuccess: null,
    });
    expect(empty.repeatCount).toBe(0);
    expect(empty.toolArgsRepeat).toBeNull();
    expect(empty.tripped).toBe(false);
  });
});

describe("loopDetectedBlock", () => {
  const verdict = {
    isReadOnly: false,
    repeatCount: 3,
    toolArgsRepeat: { hash: "h", count: 3 },
    priorSuccess: undefined,
    repeatsSuccessfulExecution: false,
    tripped: true,
  };

  test("identical args below the budget", () => {
    expect(loopDetectedBlock("edit_workflow_patch", verdict, 1)).toStrictEqual({
      budgetReached: false,
      circuitReason: "tool_loop_detected",
      eventMessage:
        "tool.loop_detected: edit_workflow_patch called with identical args 3× in a row — change approach or ask the user",
      data: {
        error_code: "tool_loop_detected",
        message:
          "edit_workflow_patch has been called with identical args 3× in a row in this turn — change the args or stop and ask the user via ask_user_choice / ask_user_text. Do NOT retry with the SAME shape.",
        reason: "tool_loop_detected",
        tool: "edit_workflow_patch",
        repeat_count: 3,
        next_best_actions: ["ask_user_choice", "ask_user_text", "diagnose_latest_execution"],
      },
    });
  });

  test("identical args at the budget", () => {
    expect(loopDetectedBlock("edit_workflow_patch", verdict, 2)).toEqual({
      budgetReached: true,
      circuitReason: "turn_loop_budget_exhausted",
      eventMessage:
        "tool.loop_detected: edit_workflow_patch repeated identical args 3×; turn-level loop budget exhausted (2) — ending turn",
      data: {
        error_code: "turn_loop_budget_exhausted",
        message:
          "this turn called tools 2× past the loop-warning budget — stop, summarise what you already know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).",
        reason: "turn_loop_budget_exhausted",
        tool: "edit_workflow_patch",
        repeat_count: 3,
        next_best_actions: ["ask_user_choice", "ask_user_text", "diagnose_latest_execution"],
      },
    });
  });

  test("repeated successful execution attaches the prior output", () => {
    const success = {
      ...verdict,
      repeatCount: 2,
      priorSuccess: { rows: 1 },
      repeatsSuccessfulExecution: true,
    };
    expect(loopDetectedBlock("run_workflow", success, 1)).toEqual({
      budgetReached: false,
      circuitReason: "tool_loop_detected",
      eventMessage:
        "tool.loop_detected: run_workflow already succeeded with identical args this turn — present the prior_success_output instead of running it again",
      data: {
        error_code: "tool_loop_detected",
        message:
          "run_workflow already succeeded with these exact args this turn — its result is attached as prior_success_output. Present THAT result to the user; do NOT run it again.",
        reason: "tool_loop_detected",
        tool: "run_workflow",
        repeat_count: 2,
        prior_success_output: { rows: 1 },
        next_best_actions: ["ask_user_choice", "ask_user_text", "diagnose_latest_execution"],
      },
    });
  });

  test("a falsy prior output is attached but not quoted in the message", () => {
    const zero = { ...verdict, priorSuccess: 0, repeatsSuccessfulExecution: true };
    const out = loopDetectedBlock("run_workflow", zero, 1);
    expect(out.data.prior_success_output).toBe(0);
    expect(out.data.message).toBe(
      "run_workflow has been called with identical args 3× in a row in this turn — change the args or stop and ask the user via ask_user_choice / ask_user_text. Do NOT retry with the SAME shape.",
    );
  });
});

describe("gate envelopes", () => {
  test("policy environment and execution mode", () => {
    expect(policyEnvironmentOf({ environment: "prod" })).toBe("prod");
    expect(policyEnvironmentOf({ environment: 1 })).toBeUndefined();
    expect(policyEnvironmentOf({})).toBeUndefined();
    expect(executionModeFor("prod")).toBe("prod");
    expect(executionModeFor("dev")).toBe("dev");
    expect(executionModeFor("staging")).toBeNull();
    expect(executionModeFor(undefined)).toBeNull();
  });

  test("duplicate pending output names the existing elicitation", () => {
    expect(duplicatePendingOutput({ elicitation_id: "e1", tool_name: "ask_user_confirm" })).toEqual(
      {
        error: "duplicate_pending_elicitation_in_turn",
        error_code: "duplicate_pending_elicitation_in_turn",
        message:
          "Another tool call in this turn already staged an ask_user_confirm. Wait for the user to resolve that one, then re-issue this call after the user confirms.",
        next_best_actions: [],
        existing_elicitation_id: "e1",
        existing_tool: "ask_user_confirm",
      },
    );
    const none = duplicatePendingOutput(undefined);
    expect(none.existing_elicitation_id).toBeUndefined();
    expect(none.existing_tool).toBeUndefined();
    expect(Object.keys(none)).toContain("existing_tool");
  });

  test("gate failure data", () => {
    expect(gateFailureData({ kind: "approval_failed" }, "delete_connector")).toEqual({
      error_code: "approval_request_failed",
      message:
        "delete_connector requires the operator's confirmation, and the engine could not open one. Nothing ran. Tell the user, and retry only if they ask again.",
      reason: "approval_request_failed",
      next_best_actions: [],
    });
    expect(gateFailureData({ kind: "unavailable", reason: "not here" }, "x")).toEqual({
      error_code: "not_available_on_surface",
      message: "not here",
      reason: "not_available_on_surface",
      next_best_actions: [],
    });
  });

  test("confirm question", () => {
    expect(confirmQuestion("delete_connector", [{ slug: "a" }], "effect")).toBe(
      "Deleting this connector will break 1 live workflow (a). Proceed anyway?",
    );
    expect(confirmQuestion("delete_connector", [{ slug: "a" }, { slug: "b" }], null)).toBe(
      "Deleting this connector will break 2 live workflows (a, b). Proceed anyway?",
    );
    expect(confirmQuestion("x", [], "Send mail")).toBe("Send mail — approve this call?");
    expect(confirmQuestion("x", [], "")).toBe(" — approve this call?");
    expect(confirmQuestion("x", [], null)).toBe(
      "Policy requires confirmation before running x. Proceed?",
    );
  });

  test("policy pause note", () => {
    expect(policyPauseNote("x", false, "https://a")).toBe(
      "policy_confirm_required — nothing ran, and this turn has no way to release x: no approval handle could be opened for it. Tell the user the action must be performed from an authenticated session.",
    );
    expect(policyPauseNote("x", true, undefined)).toBe(
      "policy_confirm_required — nothing ran. The operator must answer the emitted ask_user_confirm; the engine performs x itself once they approve. You do NOT re-issue this call, and you cannot approve on their behalf.",
    );
    expect(policyPauseNote("x", true, "https://a")).toBe(
      "policy_confirm_required — nothing ran. The operator must answer the emitted ask_user_confirm; the engine performs x itself once they approve. You do NOT re-issue this call, and you cannot approve on their behalf. Present this approval link to the operator verbatim, on its own line, as a bare URL — opening it in a browser IS the authorization (single-use link, no sign-in): https://a Once they decide there, the engine resolves this pause and carries out x on its own, then reports back — so hand over the link and wait rather than asking them to repeat their answer to you.",
    );
  });
});

describe("result helpers", () => {
  test("committed workflow id", () => {
    expect(committedWorkflowIdFromResult({ ok: true, data: {} })).toBeNull();
    expect(committedWorkflowIdFromResult({ ok: true, data: {}, committed_workflow_id: "w" })).toBe(
      "w",
    );
    expect(
      committedWorkflowIdFromResult({
        ok: true,
        data: { already_persisted: true },
        committed_workflow_id: "w",
      }),
    ).toBeNull();
    expect(
      committedWorkflowIdFromResult({
        ok: true,
        data: { version_changed: false },
        committed_workflow_id: "w",
      }),
    ).toBeNull();
    expect(
      committedWorkflowIdFromResult({
        ok: true,
        data: { already_persisted: "yes", version_changed: true },
        committed_workflow_id: "w",
      }),
    ).toBe("w");
    expect(
      committedWorkflowIdFromResult({
        ok: true,
        data: [{ already_persisted: true }],
        committed_workflow_id: "w",
      }),
    ).toBe("w");
    expect(
      committedWorkflowIdFromResult({ ok: true, data: null, committed_workflow_id: "w" }),
    ).toBe("w");
    expect(committedWorkflowIdFromResult({ ok: false, committed_workflow_id: "w" })).toBe("w");
    expect(
      committedWorkflowIdFromResult({
        ok: true,
        data: Object.assign(() => {}, { already_persisted: true }),
        committed_workflow_id: "w",
      }),
    ).toBe("w");
  });

  test("failure signature", () => {
    expect(failureSignature({ reason: "r", error_code: "c", error: "e" })).toEqual({
      reason: "r",
      shape: "r|e",
    });
    expect(failureSignature({ error_code: "c", message: "m" })).toEqual({
      reason: "c",
      shape: "c|m",
    });
    expect(failureSignature({ error_code: "tool_failed", message: "m" })).toEqual({
      reason: "",
      shape: "|m",
    });
    expect(failureSignature({ errors: [{ path: "a" }] })).toEqual({
      reason: "",
      shape: '|[{"path":"a"}]',
    });
    expect(failureSignature(null)).toEqual({ reason: "", shape: "|" });
    expect(failureSignature({ reason: 1, error_code: 2, error: 3, message: 4 })).toEqual({
      reason: "",
      shape: "|",
    });
    const long = "x".repeat(300);
    expect(failureSignature({ error: long }).shape).toBe(`|${"x".repeat(120)}`);
    const errors = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}` }));
    expect(failureSignature({ errors }).shape).toBe(`|${JSON.stringify(errors).slice(0, 120)}`);
  });

  test("validation errors", () => {
    expect(validationErrorsOf({ errors: [1] })).toEqual([1]);
    expect(validationErrorsOf({ errors: "x" })).toBeNull();
    expect(validationErrorsOf(null)).toBeNull();
    expect(validationErrorsOf("x")).toBeNull();
    expect(validationErrorsOf(Object.assign(() => {}, { errors: [1] }))).toBeNull();
  });

  test("streaks", () => {
    expect(nextErrorCodeStreak(undefined, "a")).toEqual({ code: "a", count: 1 });
    expect(nextErrorCodeStreak({ code: "a", count: 2 }, "a")).toEqual({ code: "a", count: 3 });
    expect(nextErrorCodeStreak({ code: "b", count: 2 }, "a")).toEqual({ code: "a", count: 1 });
    expect(nextFingerprintStreak(undefined, "h")).toEqual({ hash: "h", count: 1 });
    expect(nextFingerprintStreak({ hash: "h", count: 2 }, "h")).toEqual({ hash: "h", count: 3 });
    expect(nextFingerprintStreak({ hash: "g", count: 2 }, "h")).toEqual({ hash: "h", count: 1 });
  });

  test("tracked execution tools", () => {
    expect(tracksExecutionSuccess("run_workflow")).toBe(true);
    expect(tracksExecutionSuccess("wf_daily")).toBe(true);
    expect(tracksExecutionSuccess("xwf_daily")).toBe(false);
    expect(tracksExecutionSuccess("dry_run_workflow")).toBe(false);
  });

  test("pause input payload", () => {
    expect(
      pauseInputPayload({
        tool_name: "ask_user_confirm",
        summary: "s",
        elicitation_id: "e",
        input: { a: 1 },
        kind: "generic",
      }),
    ).toEqual({ a: 1 });
    expect(
      pauseInputPayload({ tool_name: "ask_user_confirm", summary: "s", elicitation_id: "e" }),
    ).toStrictEqual({});
    expect(
      pauseInputPayload({
        tool_name: "ask_user_confirm",
        summary: "s",
        elicitation_id: "e",
        kind: "generic",
        diff: "d",
        target: "t",
      }),
    ).toEqual({ kind: "generic", diff: "d", target: "t" });
    expect(
      pauseInputPayload({
        tool_name: "ask_user_confirm",
        summary: "s",
        elicitation_id: "e",
        input: null,
      }),
    ).toBeNull();
  });
});
