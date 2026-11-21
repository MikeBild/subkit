import { describe, expect, test } from "bun:test";
import {
  buildPendingOutputForTool,
  decideToolMode,
  hasInlineCredential,
  resolveToolMode,
} from "../tool-policies.ts";

describe("hasInlineCredential", () => {
  test("returns true when a declared credential path holds a non-empty string", () => {
    expect(hasInlineCredential({ config: { token: "ghp_xxx" } }, ["config.token"])).toBe(true);
  });

  test("returns false for an empty string at the path", () => {
    expect(hasInlineCredential({ config: { token: "" } }, ["config.token"])).toBe(false);
  });

  test("returns false when the path is missing", () => {
    expect(hasInlineCredential({ config: {} }, ["config.token"])).toBe(false);
  });

  test("returns true when ANY of multiple paths matches", () => {
    expect(
      hasInlineCredential({ config: { auth_value: "k_123" } }, [
        "config.api_key",
        "config.auth_value",
      ]),
    ).toBe(true);
  });
});

describe("resolveToolMode — credentialFields gate", () => {
  test("an inline credential forces confirm_before", () => {
    const mode = resolveToolMode({
      tool: "update_connector_draft",
      category: "draft_write",
      input: { config: { token: "ghp_xxx" } },
      overrides: {},
    });
    expect(mode).toBe("confirm_before_execution");
  });

  test("no inline credential keeps no_confirm", () => {
    const mode = resolveToolMode({
      tool: "update_connector_draft",
      category: "draft_write",
      input: { config: {} },
      overrides: {},
    });
    expect(mode).toBe("no_confirm");
  });
});

describe("buildPendingOutputForTool", () => {
  test("save_workflow_draft preview carries the kind plus optional slug", () => {
    expect(
      buildPendingOutputForTool("save_workflow_draft", { workflow_slug: "github-private" }),
    ).toEqual({
      kind: "save_workflow_draft",
      workflow_slug: "github-private",
    });
  });

  test("delete_workflow preview carries id+slug for the confirm card", () => {
    expect(
      buildPendingOutputForTool("delete_workflow", {
        workflow_id: "wf-abc",
        slug: "github-private",
      }),
    ).toEqual({ workflow_id: "wf-abc", slug: "github-private" });
  });

  test("run_workflow preview carries env + input_keys (not values)", () => {
    const preview = buildPendingOutputForTool("run_workflow", {
      workflow: "wf-1",
      environment: "prod",
      input: { token: "secret", limit: 5 },
    });
    expect(preview).toEqual({
      workflow: "wf-1",
      version_id: null,
      environment: "prod",
      input_keys: ["token", "limit"],
    });
  });

  test("run_workflow preview derives input_keys from a stringified object payload", () => {
    const preview = buildPendingOutputForTool("run_workflow", {
      workflow: "wf-1",
      environment: "dev",
      input: '{"date":"tomorrow +1","city":"Berlin"}',
    });
    expect(preview).toEqual({
      workflow: "wf-1",
      version_id: null,
      environment: "dev",
      input_keys: ["date", "city"],
    });
  });

  test("returns null for tools without a buildPendingOutput hook", () => {
    expect(buildPendingOutputForTool("inspect_connector_draft", {})).toBeNull();
  });
});

describe("execution data transfer", () => {
  test("sending collected execution data requires confirmation in every permission mode", () => {
    for (const ask_before_writing of [false, true]) {
      for (const connector_trust of [false, true]) {
        expect(
          decideToolMode({
            tool: "run_workflow",
            category: "tenant_write",
            input: { workflow: "subkit-support-send" },
            overrides: { run_workflow: "no_confirm" },
            ask_before_writing,
            connector_trust,
            execution_data_transfer: true,
          }).mode,
        ).toBe("confirm_before_execution");
      }
    }
  });

  test("an ordinary workflow run keeps its existing mode", () => {
    expect(
      decideToolMode({
        tool: "run_workflow",
        category: "tenant_write",
        input: { workflow: "subkit-support-list" },
        overrides: {},
      }).mode,
    ).toBe("no_confirm");
  });
});
