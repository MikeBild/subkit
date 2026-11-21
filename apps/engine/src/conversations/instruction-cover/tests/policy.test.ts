import { describe, expect, test } from "bun:test";
import { decideToolMode } from "../../tool-policies.ts";

const write = { connector_id: "mail", method: "POST", path: "/v1/messages/send", body: {} };

function decide(extra: Partial<Parameters<typeof decideToolMode>[0]>) {
  return decideToolMode({
    tool: "call_connector",
    category: "tenant_read",
    input: write,
    overrides: {},
    ...extra,
  });
}

describe("the person's words and standing rules in the mode decision", () => {
  test("a connector write asks in auto without cover", () => {
    expect(decide({}).mode).toBe("confirm_before_execution");
  });

  test("covered by the person's words it runs unless the person asks before writing", () => {
    expect(decide({ instruction_covered: true })).toEqual({
      mode: "no_confirm",
      rule: "user_instruction",
    });
    expect(decide({ instruction_covered: true, ask_before_writing: true }).mode).toBe(
      "confirm_before_execution",
    );
  });

  test("a standing rule covers the step, also when the person asks before writing", () => {
    for (const ask_before_writing of [false, true]) {
      expect(decide({ rule_covered: true, ask_before_writing })).toEqual({
        mode: "no_confirm",
        rule: "standing_rule",
      });
    }
  });

  test("a task run follows the cover its owner's task gave, and asks without it", () => {
    expect(decide({ instruction_covered: true, task_run: true })).toEqual({
      mode: "no_confirm",
      rule: "user_instruction",
    });
    expect(decide({ task_run: true }).mode).toBe("confirm_before_execution");
  });

  test("a full response, a data transfer and an explicit always-ask stay asking", () => {
    expect(
      decide({ instruction_covered: true, input: { ...write, response_mode: "full" } }).mode,
    ).toBe("confirm_before_execution");
    expect(decide({ instruction_covered: true, execution_data_transfer: true }).mode).toBe(
      "confirm_before_execution",
    );
    expect(
      decide({
        rule_covered: true,
        instruction_covered: true,
        overrides: { call_connector: "confirm_before_execution" },
      }).mode,
    ).toBe("confirm_before_execution");
  });

  test("deletions, revocations and candidate approvals ask whatever the flags say", () => {
    for (const tool of ["delete_workflow", "revoke_api_key", "approve_patch_candidate"]) {
      expect(
        decideToolMode({
          tool,
          category: "tenant_write",
          input: {},
          overrides: {},
          instruction_covered: true,
          rule_covered: true,
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });

  test("a save with credentials asks even when covered", () => {
    expect(
      decideToolMode({
        tool: "save_connector_draft",
        category: "tenant_write",
        input: { credential: { mode: "api_key" } },
        overrides: {},
        instruction_covered: true,
      }).mode,
    ).toBe("confirm_before_execution");
  });
});
