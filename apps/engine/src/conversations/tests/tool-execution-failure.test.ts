import { describe, expect, test } from "bun:test";
import {
  DATABASE_FAILURE_MESSAGE,
  describeToolExecutionFailure,
} from "../tool-execution-failure.ts";

describe("describeToolExecutionFailure", () => {
  test("masks a failed database query so the model never sees SQL or parameters", () => {
    const err = new Error(
      'Failed query: select "id" from "conversations" where "tenant_id" = $1\nparams: sample-tenant',
    );

    const failure = describeToolExecutionFailure(err, ["inspect_workflow_draft"]);

    expect(failure.database_failure).toBe(true);
    expect(failure.output).toEqual({
      ok: false,
      error: DATABASE_FAILURE_MESSAGE,
      error_code: "tool_execution_failed",
      message: DATABASE_FAILURE_MESSAGE,
      next_best_actions: ["inspect_workflow_draft"],
    });
    const serialized = JSON.stringify(failure.output) + failure.message;
    expect(serialized).not.toContain("Failed query");
    expect(serialized).not.toContain("sample-tenant");
    expect((failure.span_error as Error).message).toBe("database query failed");
  });

  test("masks a wrapped error whose cause is a database failure", () => {
    const cause = Object.assign(new Error("duplicate key value"), { code: "23505" });
    const err = new Error("draft snapshot could not be stored", { cause });

    const failure = describeToolExecutionFailure(err);

    expect(failure.database_failure).toBe(true);
    expect(failure.message).toBe(DATABASE_FAILURE_MESSAGE);
  });

  test("keeps an ordinary tool error readable in the same envelope", () => {
    const failure = describeToolExecutionFailure(new Error("step 'fetch' is not in the draft"));

    expect(failure.database_failure).toBe(false);
    expect(failure.output).toMatchObject({
      ok: false,
      error: "step 'fetch' is not in the draft",
      error_code: "tool_execution_failed",
      message: "step 'fetch' is not in the draft",
      next_best_actions: [],
    });
  });
});
