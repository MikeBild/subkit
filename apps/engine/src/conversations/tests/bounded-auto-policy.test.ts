import { describe, expect, test } from "bun:test";
import { decideToolMode } from "../tool-policies.ts";

describe("bounded auto authoring policy", () => {
  for (const tool of [
    "unclassified_future_write",
    "create_schedule",
    "update_workflow",
    "save_connector_draft",
    "rerun_execution",
  ]) {
    test(`${tool} cannot infer an execution grant from a tool preference`, () => {
      for (const override of ["no_confirm", "confirm_after_execution"] as const) {
        expect(
          decideToolMode({
            tool,
            category: "tenant_write",
            input: {},
            overrides: { [tool]: override },
            permission_mode: "auto",
          }).mode,
        ).toBe("confirm_before_execution");
      }
    });
  }
  for (const tool of [
    "save_workflow_draft",
    "create_knowledge_source",
    "analyze_knowledge_source",
  ]) {
    test(`${tool} remains autonomous preparation`, () => {
      expect(
        decideToolMode({
          tool,
          category: "tenant_write",
          input: {},
          overrides: {},
          permission_mode: "auto",
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
          permission_mode: "auto",
        }).mode,
      ).toBe("no_confirm");
    }
  });
  test("a held development run uses its dynamic preparation policy", () => {
    expect(
      decideToolMode({
        tool: "run_workflow",
        category: "tenant_write",
        input: { environment: "dev" },
        overrides: {},
        permission_mode: "auto",
      }).mode,
    ).toBe("no_confirm");
  });
  test("live writes and destructive operations cannot be downgraded by a stored tool override", () => {
    for (const [tool, input] of [
      ["run_workflow", { environment: "dev", execute_writes: true }],
      ["delete_workflow", {}],
      ["save_workflow_draft", { force_commit: true }],
    ] as const) {
      expect(
        decideToolMode({
          tool,
          category: "tenant_write",
          input,
          overrides: { [tool]: "no_confirm" },
          permission_mode: "auto",
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
        permission_mode: "auto",
      }).mode,
    ).toBe("confirm_before_execution");
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
          permission_mode: "auto",
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });
});
