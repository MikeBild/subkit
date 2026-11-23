import { describe, expect, test } from "bun:test";
import { decideToolMode } from "../tool-policies.ts";

describe("bounded auto authoring policy", () => {
  for (const tool of [
    "unclassified_future_write",
    "create_schedule",
    "update_workflow",
    "save_connector_draft",
    "rerun_execution",
    "analyze_knowledge_source",
  ]) {
    test(`${tool} cannot infer an execution grant from a tool preference`, () => {
      for (const override of ["no_confirm", "confirm_after_execution"] as const) {
        expect(
          decideToolMode({
            tool,
            category: "tenant_write",
            input: {},
            overrides: { [tool]: override },
          }).mode,
        ).toBe("confirm_before_execution");
      }
    });
  }
  for (const tool of [
    "save_workflow_draft",
    "create_knowledge_source",
    "export_diagnostic_context",
  ]) {
    test(`${tool} remains autonomous preparation`, () => {
      expect(
        decideToolMode({
          tool,
          category: "tenant_write",
          input: {},
          overrides: {},
        }).mode,
      ).toBe("no_confirm");
    });
  }
  test("ordinary draft edits and reads remain autonomous", () => {
    for (const category of ["draft_write", "tenant_read"] as const) {
      expect(
        decideToolMode({
          tool: "inspect_workflow_draft",
          category,
          input: {},
          overrides: {},
        }).mode,
      ).toBe("no_confirm");
    }
  });
  test("diagnostic preparation preserves explicit approval preferences", () => {
    for (const ask_before_writing of [true]) {
      expect(
        decideToolMode({
          tool: "export_diagnostic_context",
          category: "tenant_write",
          input: {},
          overrides: {},
          ask_before_writing,
        }).mode,
      ).toBe("confirm_before_execution");
    }
    expect(
      decideToolMode({
        tool: "export_diagnostic_context",
        category: "tenant_write",
        input: {},
        overrides: { export_diagnostic_context: "confirm_before_execution" },
      }).mode,
    ).toBe("confirm_before_execution");
  });
  test("generic starts delegate write authorization to durable admission, not a flag gate", () => {
    for (const execute_writes of [undefined, false, true]) {
      expect(
        decideToolMode({
          tool: "run_workflow",
          category: "tenant_write",
          input: { environment: "dev", execute_writes },
          overrides: {},
        }).mode,
      ).toBe("no_confirm");
    }
  });
  test("live writes and destructive operations cannot be downgraded by a stored tool override", () => {
    for (const [tool, input] of [
      ["call_connector", { method: "POST", path: "/publish" }],
      ["probe_connector", { environment: "dev", method: "DELETE" }],
      ["delete_workflow", {}],
      ["save_workflow_draft", { force_commit: true }],
    ] as const) {
      expect(
        decideToolMode({
          tool,
          category: "tenant_write",
          input,
          overrides: { [tool]: "no_confirm" },
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });
  test("an explicit preparation approval preference is preserved", () => {
    expect(
      decideToolMode({
        tool: "save_workflow_draft",
        category: "tenant_write",
        input: {},
        overrides: { save_workflow_draft: "confirm_before_execution" },
      }).mode,
    ).toBe("confirm_before_execution");
  });

  test("standing-authority discovery preserves stricter workflow preferences in both environments", () => {
    for (const environment of ["dev", "prod"] as const) {
      for (const ask_before_writing of [false, true]) {
        expect(
          decideToolMode({
            tool: "run_workflow",
            category: "tenant_write",
            input: { environment },
            overrides: { run_workflow: "confirm_before_execution" },
            ask_before_writing,
          }).mode,
        ).toBe("confirm_before_execution");
      }
    }
  });

  test("mislabelled GraphQL writes cannot inherit an autonomous read policy", () => {
    for (const query of [
      "mutation Remove { remove { id } }",
      "fragment F on Item { id } mutation Remove { remove { ...F } }",
      "query Read { items { id } } mutation Remove { remove { id } }",
    ]) {
      expect(
        decideToolMode({
          tool: "call_connector",
          category: "tenant_read",
          input: { body: { operation: "query", query } },
          overrides: { call_connector: "no_confirm" },
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });

  test("bounded read probes run autonomously while full responses require confirmation", () => {
    for (const tool of ["call_connector", "probe_connector", "probe_connector_draft"]) {
      expect(
        decideToolMode({
          tool,
          category: "tenant_read",
          input: { method: "GET", response_mode: "full" },
          overrides: {},
          connector_trust: true,
        }).mode,
      ).toBe("confirm_before_execution");
      for (const response_mode of ["shape", "sample"] as const) {
        expect(
          decideToolMode({
            tool,
            category: "tenant_read",
            input: { method: "GET", environment: "prod", response_mode },
            overrides: {},
          }).mode,
        ).toBe("no_confirm");
      }
      expect(
        decideToolMode({
          tool,
          category: "tenant_read",
          input: { method: "GET", environment: "prod", response_mode: "full" },
          overrides: { [tool]: "no_confirm" },
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });
});
