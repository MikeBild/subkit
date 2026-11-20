import { describe, expect, test } from "bun:test";
import { decideToolMode } from "../../tool-policies.ts";

const write = { connector_id: "mail", method: "POST", path: "/v1/messages/send", body: {} };

function decide(extra: Partial<Parameters<typeof decideToolMode>[0]>) {
  return decideToolMode({
    tool: "call_connector",
    category: "tenant_read",
    input: write,
    overrides: {},
    permission_mode: "auto",
    ...extra,
  });
}

describe("the person's words and standing rules in the mode decision", () => {
  test("a connector write asks in auto without cover", () => {
    expect(decide({}).mode).toBe("confirm_before_execution");
  });

  test("covered by the person's words it runs in auto only", () => {
    expect(decide({ instruction_covered: true })).toEqual({
      mode: "no_confirm",
      rule: "user_instruction",
    });
    for (const permission_mode of ["ask", "plan", null] as const) {
      expect(decide({ instruction_covered: true, permission_mode }).mode).toBe(
        "confirm_before_execution",
      );
    }
  });

  test("a standing rule covers ask and auto, never plan", () => {
    for (const permission_mode of ["ask", "auto"] as const) {
      expect(decide({ rule_covered: true, permission_mode })).toEqual({
        mode: "no_confirm",
        rule: "standing_rule",
      });
    }
    expect(decide({ rule_covered: true, permission_mode: "plan" }).mode).toBe(
      "confirm_before_execution",
    );
  });

  test("an unattended run is never covered", () => {
    expect(decide({ instruction_covered: true, rule_covered: true, task_run: true }).mode).toBe(
      "confirm_before_execution",
    );
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
          permission_mode: "auto",
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
        permission_mode: "auto",
        instruction_covered: true,
      }).mode,
    ).toBe("confirm_before_execution");
  });
});
