import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  COMMAND_ID_PATTERN,
  conversationCommandId,
  isCommandId,
  workflowCommandId,
} from "./command-id.ts";

const base = {
  execution_id: "11111111-1111-4111-8111-111111111111",
  step_id: "write-summary",
  call_path: [] as string[],
  iteration_path: "11111111-1111-4111-8111-111111111111",
  effect_index: 0,
};

describe("device command ids", () => {
  test("the same effect occurrence gives the same id on every job attempt", () => {
    expect(workflowCommandId(base)).toBe(workflowCommandId({ ...base }));
    expect(workflowCommandId(base)).toMatch(COMMAND_ID_PATTERN);
  });

  test("the id is the sha256 of the occurrence, tagged as a workflow command", () => {
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "workflow",
          base.execution_id,
          "write-summary",
          [],
          base.iteration_path,
          0,
        ]),
      )
      .digest("hex");
    expect(workflowCommandId(base)).toBe(expected);
  });

  test("every loop iteration, call and effect gets its own id", () => {
    const ids = new Set([
      workflowCommandId(base),
      workflowCommandId({ ...base, iteration_path: `${base.iteration_path}:for_each:write:0` }),
      workflowCommandId({ ...base, iteration_path: `${base.iteration_path}:for_each:write:1` }),
      workflowCommandId({ ...base, call_path: ["child"] }),
      workflowCommandId({ ...base, effect_index: 1 }),
      workflowCommandId({ ...base, step_id: "other" }),
      workflowCommandId({ ...base, execution_id: "22222222-2222-4222-8222-222222222222" }),
    ]);
    expect(ids.size).toBe(7);
  });

  test("an effect index must be a non-negative safe integer", () => {
    expect(() => workflowCommandId({ ...base, effect_index: -1 })).toThrow("invalid effect index");
    expect(() => workflowCommandId({ ...base, effect_index: 0.5 })).toThrow(RangeError);
    expect(() => workflowCommandId({ ...base, effect_index: 2 ** 53 })).toThrow(RangeError);
  });

  test("task and chat commands are keyed by their owner and the tool call", () => {
    const run = { owner_kind: "task_run" as const, owner_id: "run-1", tool_call_id: "call-1" };
    expect(conversationCommandId(run)).toBe(conversationCommandId({ ...run }));
    expect(conversationCommandId(run)).toBe(
      createHash("sha256")
        .update(JSON.stringify(["task_run", "run-1", "call-1"]))
        .digest("hex"),
    );
    expect(conversationCommandId(run)).not.toBe(
      conversationCommandId({ ...run, owner_kind: "conversation" }),
    );
    expect(conversationCommandId(run)).not.toBe(
      conversationCommandId({ ...run, tool_call_id: "call-2" }),
    );
  });

  test("only lowercase 64-digit hex is a command id", () => {
    expect(isCommandId("a".repeat(64))).toBe(true);
    expect(isCommandId("A".repeat(64))).toBe(false);
    expect(isCommandId("a".repeat(63))).toBe(false);
    expect(isCommandId(`x${"a".repeat(64)}`)).toBe(false);
    expect(isCommandId(`${"a".repeat(64)}x`)).toBe(false);
  });
});
