import { describe, expect, test } from "bun:test";

import { normalizeWorkflowRunInput, workflowInputObjectKeys } from "./run-input.ts";

describe("normalizeWorkflowRunInput", () => {
  test("parses a stringified object payload", () => {
    expect(normalizeWorkflowRunInput('{"date":"tomorrow +1"}')).toEqual({
      date: "tomorrow +1",
    });
  });

  test("leaves plain strings unchanged", () => {
    expect(normalizeWorkflowRunInput("tomorrow +1")).toBe("tomorrow +1");
  });

  test("leaves invalid JSON strings unchanged", () => {
    expect(normalizeWorkflowRunInput("{date: tomorrow +1}")).toBe("{date: tomorrow +1}");
  });
});

describe("workflowInputObjectKeys", () => {
  test("returns object keys for a parsed stringified payload", () => {
    expect(workflowInputObjectKeys('{"date":"tomorrow +1","city":"Berlin"}')).toEqual([
      "date",
      "city",
    ]);
  });

  test("returns an empty array for non-object payloads", () => {
    expect(workflowInputObjectKeys("tomorrow +1")).toEqual([]);
    expect(workflowInputObjectKeys("[1,2,3]")).toEqual([]);
  });
});
