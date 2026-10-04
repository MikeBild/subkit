import { describe, expect, test } from "bun:test";
import { deriveExecutionOutcome, type OutcomeStepRow, pickStoppingStep } from "./outcome.ts";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const row = (over: Partial<OutcomeStepRow> & { step_key: string }): OutcomeStepRow => ({
  kind: "request",
  status: "succeeded",
  error: null,
  held: false,
  started_at: at(0),
  ...over,
});
const authError = { code: "http_4xx", message: "HTTP 401 Unauthorized" };
const notFound = { code: "http_4xx", message: "HTTP 404 Not Found" };

describe("pickStoppingStep", () => {
  const rows = [
    row({ step_key: "optional", status: "failed", error: notFound, started_at: at(1) }),
    row({ step_key: "load", started_at: at(2) }),
    row({ step_key: "send", status: "failed", error: authError, started_at: at(3) }),
  ];

  test("a tolerated failure earlier in the run is not the step that stopped it", () => {
    expect(pickStoppingStep(rows, null)?.step_key).toBe("send");
    expect(pickStoppingStep([...rows].reverse(), null)?.step_key).toBe("send");
  });

  test("the step the engine named wins, including a loop iteration row", () => {
    expect(pickStoppingStep(rows, "optional")?.step_key).toBe("optional");
    const iter = [row({ step_key: "each[2]", status: "failed", error: authError })];
    expect(pickStoppingStep(iter, "each")?.step_key).toBe("each[2]");
  });
});

describe("deriveExecutionOutcome", () => {
  const def = [
    { id: "load", kind: "request" },
    { id: "send", kind: "request" },
    { id: "notify", kind: "request" },
  ];

  test("failed: the stopping step, its cause class, and the unrun tail as skipped", () => {
    const outcome = deriveExecutionOutcome(
      {
        status: "failed",
        failure: { step_id: "send", error_code: "http_4xx", error_message: "HTTP 401" },
        output_contract: "none",
      },
      [
        row({ step_key: "load", started_at: at(1) }),
        row({ step_key: "send", status: "failed", error: authError, started_at: at(2) }),
      ],
      def,
    );
    expect(outcome).toEqual({
      kind: "failed",
      failed_step: { step_key: "send", kind: "request" },
      cause_class: "auth_failed",
      error_code: "http_4xx",
      refusal_reason: null,
      connector: null,
      steps: { total: 3, succeeded: 1, failed: 1, held: 0, skipped: 1 },
      output_contract: "none",
    });
  });

  test("a changed approval names the report rule the stopping step broke", () => {
    const refused = (error: unknown) =>
      deriveExecutionOutcome(
        {
          status: "failed",
          failure: {
            step_id: "send",
            error_code: "execution_authority_changed",
            error_message: "refused",
          },
          output_contract: "none",
        },
        [row({ step_key: "send", status: "failed", error, started_at: at(1) })],
        def,
      ).refusal_reason;
    expect(refused({ code: "execution_authority_changed", reason: "not_utf8" })).toBe("not_utf8");
    expect(refused({ code: "execution_authority_changed", reason: "recipient_differs" })).toBe(
      "recipient_differs",
    );
    expect(refused({ code: "execution_authority_changed", reason: "made_up" })).toBeNull();
    expect(refused({ code: "http_4xx", reason: "not_utf8" })).toBeNull();
    expect(refused({ code: "execution_authority_changed" })).toBeNull();
  });

  test("refused: a run refused for its connector names the connector and reads connector_unavailable", () => {
    const outcome = deriveExecutionOutcome(
      {
        status: "failed",
        failure: {
          step_id: "send",
          error_code: "prepared_credential_unavailable",
          error_message:
            'Connector "auth0-crm" in dev must be reconnected before this workflow can run.',
          connector: { connector_id: "c-dev", reason: "needs_reauth" },
        },
        output_contract: "none",
      },
      [],
      def,
    );
    expect(outcome.cause_class).toBe("connector_unavailable");
    expect(outcome.connector).toEqual({ connector_id: "c-dev", reason: "needs_reauth" });
  });

  test("refused: a preparation closed before it ran reads refused_before_start", () => {
    const outcome = deriveExecutionOutcome(
      {
        status: "failed",
        failure: {
          step_id: null,
          error_code: "orphaned_preparation",
          error_message: "The preparation was refused before it started and never ran.",
        },
        output_contract: "none",
      },
      [],
      def,
    );
    expect(outcome.cause_class).toBe("refused_before_start");
    expect(outcome.connector).toBeNull();
  });

  test("held: a succeeded status with a held write is held, and held is not succeeded", () => {
    const outcome = deriveExecutionOutcome(
      { status: "succeeded", failure: null, output_contract: "none" },
      [row({ step_key: "load" }), row({ step_key: "send", held: true })],
      def,
    );
    expect(outcome.kind).toBe("held");
    expect(outcome.steps).toEqual({ total: 3, succeeded: 1, failed: 0, held: 1, skipped: 1 });
    expect(outcome.failed_step).toBeNull();
  });

  test("a row written before the held column is still held by its driver marker", () => {
    const outcome = deriveExecutionOutcome(
      { status: "succeeded", failure: null, output_contract: "none" },
      [row({ step_key: "send", request_meta: { driver: "http", extras: { held: true } } })],
    );
    expect(outcome.kind).toBe("held");
    expect(outcome.steps.succeeded).toBe(0);
  });

  test("partial: a succeeded status with a tolerated failure", () => {
    const outcome = deriveExecutionOutcome(
      { status: "succeeded", failure: null, output_contract: "passed" },
      [row({ step_key: "load", status: "failed", error: notFound }), row({ step_key: "send" })],
    );
    expect(outcome.kind).toBe("partial");
    expect(outcome.failed_step?.step_key).toBe("load");
    expect(outcome.output_contract).toBe("passed");
  });

  test("succeeded: no failed step, no cause", () => {
    const outcome = deriveExecutionOutcome(
      { status: "succeeded", failure: null, output_contract: null },
      [row({ step_key: "load" })],
    );
    expect(outcome.kind).toBe("succeeded");
    expect(outcome.failed_step).toBeNull();
    expect(outcome.cause_class).toBeNull();
    expect(outcome.output_contract).toBe("none");
  });

  test("a workflow-level failure without a step keeps its code", () => {
    const outcome = deriveExecutionOutcome(
      {
        status: "failed",
        failure: {
          step_id: null,
          error_code: "validation_failed",
          error_message: "returned false",
        },
        output_contract: "none",
      },
      [row({ step_key: "load" })],
    );
    expect(outcome.failed_step).toBeNull();
    expect(outcome.error_code).toBe("validation_failed");
  });

  test("running: nothing is skipped yet", () => {
    const outcome = deriveExecutionOutcome(
      { status: "running", failure: null, output_contract: null },
      [row({ step_key: "load" })],
      def,
    );
    expect(outcome.kind).toBe("running");
    expect(outcome.steps.skipped).toBe(0);
  });
});
