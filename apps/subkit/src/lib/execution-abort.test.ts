import { describe, expect, test } from "bun:test";
import { isAbortableExecutionStatus } from "./execution-abort.ts";

describe("isAbortableExecutionStatus", () => {
  test("allows aborting uncertain executions", () => {
    expect(isAbortableExecutionStatus("uncertain")).toBe(true);
  });

  test("excludes terminal executions", () => {
    for (const status of ["succeeded", "failed", "cancelled", "aborted"]) {
      expect(isAbortableExecutionStatus(status)).toBe(false);
    }
  });
});
