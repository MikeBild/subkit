import { describe, expect, test } from "bun:test";
import { policyDecide } from "../../tools/policy.ts";
import type { PermissionMode, ToolPolicies } from "../../tools/types.ts";
import { decideToolMode } from "../tool-policies.ts";

const MODES: readonly (PermissionMode | null)[] = ["auto", "ask", "plan", "yolo", null];

type Special = "none" | "data_transfer" | "confirm_override";
const SPECIALS: readonly Special[] = ["none", "data_transfer", "confirm_override"];

function decide(mode: PermissionMode | null, covered: boolean, special: Special) {
  const overrides: ToolPolicies =
    special === "confirm_override" ? { run_workflow: "confirm_before_execution" } : {};
  return decideToolMode({
    tool: "run_workflow",
    category: "tenant_write",
    input: { workflow: "report", environment: "prod" },
    overrides,
    permission_mode: mode,
    ...(covered ? { authority_covered: true } : {}),
    ...(special === "data_transfer" ? { execution_data_transfer: true } : {}),
  });
}

describe("run_workflow decision: mode × covered × special case", () => {
  test("the covered flag changes exactly one cell", () => {
    const changed: string[] = [];
    for (const mode of MODES) {
      for (const special of SPECIALS) {
        const before = decide(mode, false, special);
        const after = decide(mode, true, special);
        if (before.mode !== after.mode || before.rule !== after.rule) {
          changed.push(`${mode}/${special}`);
        }
      }
    }
    expect(changed).toEqual(["ask/none"]);
  });

  test("ask with coverage runs without a question and names the rule", () => {
    expect(decide("ask", true, "none")).toEqual({ mode: "no_confirm", rule: "authority_covered" });
  });

  test("ask without coverage asks as before", () => {
    expect(decide("ask", false, "none")).toEqual({
      mode: "confirm_before_execution",
      rule: "permission_mode",
    });
  });

  test.each([true, false])("plan asks whether covered or not (covered=%p)", (covered) => {
    expect(decide("plan", covered, "none")).toEqual({
      mode: "confirm_before_execution",
      rule: "permission_mode",
    });
  });

  test.each(["auto", "ask", "plan", "yolo", null] as const)(
    "a data transfer asks in mode %p even when covered",
    (mode) => {
      expect(decide(mode, true, "data_transfer")).toEqual({
        mode: "confirm_before_execution",
        rule: "computed_from_input",
      });
    },
  );

  test("a confirm override keeps asking in ask mode even when covered", () => {
    expect(decide("ask", true, "confirm_override")).toEqual({
      mode: "confirm_before_execution",
      rule: "permission_mode",
    });
  });

  test.each([
    ["auto", "confirm_before_execution", "conversation_override"],
    ["plan", "confirm_before_execution", "permission_mode"],
    ["yolo", "no_confirm", "permission_mode"],
    [null, "confirm_before_execution", "conversation_override"],
  ] as const)(
    "a confirm override in mode %p resolves as before when covered",
    (mode, expected, rule) => {
      expect(decide(mode, true, "confirm_override")).toEqual({ mode: expected, rule });
      expect(decide(mode, false, "confirm_override")).toEqual({ mode: expected, rule });
    },
  );

  test.each([
    ["auto", "computed_from_input"],
    ["yolo", "permission_mode"],
    [null, "computed_from_input"],
  ] as const)("mode %p never asked and is not relabelled by coverage", (mode, rule) => {
    expect(decide(mode, true, "none")).toEqual({ mode: "no_confirm", rule });
  });
});

describe("the covered flag does not reach other tools", () => {
  test.each([
    ["create_knowledge_source", "tenant_write"],
    ["delete_workflow", "tenant_write"],
    ["call_connector", "tenant_write"],
    ["web_search", "tenant_read"],
    ["wf_report", "tenant_write"],
  ] as const)("%s keeps its ask decision", (tool, category) => {
    const input = tool === "call_connector" ? { method: "POST" } : {};
    const base = { tool, category, input, overrides: {}, permission_mode: "ask" as const };
    expect(decideToolMode({ ...base, authority_covered: true })).toEqual(decideToolMode(base));
    expect(decideToolMode({ ...base, authority_covered: true }).mode).toBe(
      "confirm_before_execution",
    );
  });

  test("an inline credential asks even with the flag set", () => {
    expect(
      decideToolMode({
        tool: "update_connector_draft",
        category: "draft_write",
        input: { config: { api_key: "pasted-secret" } },
        overrides: {},
        permission_mode: "ask",
        authority_covered: true,
      }),
    ).toEqual({ mode: "confirm_before_execution", rule: "inline_credential" });
  });
});

describe("policyDecide threads the covered flag", () => {
  const input = {
    tool: "run_workflow",
    category: "tenant_write",
    args: { workflow: "report" },
    permission_mode: "ask",
  } as const;

  test.each(["chat", "mcp"] as const)(
    "%s: without the flag ask needs a confirmation",
    (surface) => {
      expect(policyDecide({ ...input, surface })).toEqual({
        kind: "needs_confirm",
        mode: "confirm_before_execution",
        rule: "permission_mode",
      });
      expect(policyDecide({ ...input, surface, authority_covered: false })).toEqual({
        kind: "needs_confirm",
        mode: "confirm_before_execution",
        rule: "permission_mode",
      });
    },
  );

  test("with the flag ask proceeds under the authority_covered rule", () => {
    expect(policyDecide({ ...input, surface: "chat", authority_covered: true })).toEqual({
      kind: "proceed",
      mode: "no_confirm",
      rule: "authority_covered",
      skip_reason: "mode_not_confirm_before_execution",
    });
  });

  test("with the flag plan still needs a confirmation", () => {
    expect(
      policyDecide({ ...input, surface: "chat", permission_mode: "plan", authority_covered: true }),
    ).toEqual({
      kind: "needs_confirm",
      mode: "confirm_before_execution",
      rule: "permission_mode",
    });
  });
});
