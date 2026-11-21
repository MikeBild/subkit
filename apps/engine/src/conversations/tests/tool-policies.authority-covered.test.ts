import { describe, expect, test } from "bun:test";
import { policyDecide } from "../../tools/policy.ts";
import type { ToolPolicies } from "../../tools/types.ts";
import { decideToolMode } from "../tool-policies.ts";

const ASKS = [false, true] as const;

type Special = "none" | "data_transfer" | "confirm_override";
const SPECIALS: readonly Special[] = ["none", "data_transfer", "confirm_override"];

function decide(askBeforeWriting: boolean, covered: boolean, special: Special) {
  const overrides: ToolPolicies =
    special === "confirm_override" ? { run_workflow: "confirm_before_execution" } : {};
  return decideToolMode({
    tool: "run_workflow",
    category: "tenant_write",
    input: { workflow: "report", environment: "prod" },
    overrides,
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    ...(covered ? { authority_covered: true } : {}),
    ...(special === "data_transfer" ? { execution_data_transfer: true } : {}),
  });
}

describe("run_workflow decision: ask-before-writing × covered × special case", () => {
  test("the covered flag changes exactly one cell", () => {
    const changed: string[] = [];
    for (const ask of ASKS) {
      for (const special of SPECIALS) {
        const before = decide(ask, false, special);
        const after = decide(ask, true, special);
        if (before.mode !== after.mode || before.rule !== after.rule) {
          changed.push(`${ask}/${special}`);
        }
      }
    }
    expect(changed).toEqual(["true/none"]);
  });

  test("asking before writing with coverage runs without a question and names the rule", () => {
    expect(decide(true, true, "none")).toEqual({ mode: "no_confirm", rule: "authority_covered" });
  });

  test("asking before writing without coverage asks", () => {
    expect(decide(true, false, "none")).toEqual({
      mode: "confirm_before_execution",
      rule: "ask_before_writing",
    });
  });

  test.each([...ASKS])("a data transfer asks even when covered (ask=%p)", (ask) => {
    expect(decide(ask, true, "data_transfer")).toEqual({
      mode: "confirm_before_execution",
      rule: "computed_from_input",
    });
  });

  test.each([
    [false, "confirm_before_execution", "conversation_override"],
    [true, "confirm_before_execution", "ask_before_writing"],
  ] as const)(
    "a confirm override (ask=%p) resolves the same with or without coverage",
    (ask, expected, rule) => {
      expect(decide(ask, true, "confirm_override")).toEqual({ mode: expected, rule });
      expect(decide(ask, false, "confirm_override")).toEqual({ mode: expected, rule });
    },
  );

  test("without the rule an ordinary run never asks and is not relabelled by coverage", () => {
    expect(decide(false, true, "none")).toEqual({
      mode: "no_confirm",
      rule: "computed_from_input",
    });
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
    const base = { tool, category, input, overrides: {}, ask_before_writing: true };
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
        ask_before_writing: true,
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
    ask_before_writing: true,
  } as const;

  test.each(["chat", "mcp"] as const)(
    "%s: without the flag a write needs a confirmation",
    (surface) => {
      expect(policyDecide({ ...input, surface })).toEqual({
        kind: "needs_confirm",
        mode: "confirm_before_execution",
        rule: "ask_before_writing",
      });
      expect(policyDecide({ ...input, surface, authority_covered: false })).toEqual({
        kind: "needs_confirm",
        mode: "confirm_before_execution",
        rule: "ask_before_writing",
      });
    },
  );

  test("with the flag the run proceeds under the authority_covered rule", () => {
    expect(policyDecide({ ...input, surface: "chat", authority_covered: true })).toEqual({
      kind: "proceed",
      mode: "no_confirm",
      rule: "authority_covered",
      skip_reason: "mode_not_confirm_before_execution",
    });
  });
});
