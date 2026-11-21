import { expect, test } from "bun:test";
import { describeRunWorkflowError } from "./run-workflow-error.ts";

test("preserves sensitive conversation refusal and gives a safe repair path", () => {
  const error = Object.assign(
    new Error("Sensitive execution is unavailable on conversation surfaces."),
    {
      code: "sensitive_execution_unsupported",
    },
  );
  const result = describeRunWorkflowError(error);
  expect(result.error_code).toBe("sensitive_execution_unsupported");
  expect(result.message).toContain("authenticated non-chat run");
  expect(result.message).toContain("execution_privacy=sensitive");
  expect(result.recoverable).toBe(false);
});

test("keeps version failures distinct from other run failures", () => {
  const version = describeRunWorkflowError(
    Object.assign(new Error("version changed"), { code: "workflow_version_invalid" }),
  );
  expect(version.error_code).toBe("workflow_version_invalid");
  expect(version.recommended_mode).toBe("workflow");
  expect(describeRunWorkflowError(new Error("network failure")).error_code).toBe("run_failed");
});

test("an archived workflow keeps its refusal code so the person sees why it did not run", () => {
  const archived = describeRunWorkflowError(
    Object.assign(new Error("this workflow is archived and cannot run until it is restored"), {
      code: "workflow_archived",
    }),
  );
  expect(archived.error_code).toBe("workflow_archived");
  expect(archived.message).toBe("this workflow is archived and cannot run until it is restored");
  expect(archived.recommended_mode).toBe("workflow");
  expect(archived.recoverable).toBe(true);
});
