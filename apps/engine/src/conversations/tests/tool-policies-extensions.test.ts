// Locks the four extension hooks added to ToolPolicyDefinition:
//   - credentialFields  → forces confirm_before_execution when an
//                         inline secret is detected on the input
//   - prerequisites     → declared at the policy level, surfaced via
//                         prerequisitesForTool for the dispatch gate
//   - buildPendingOutput → produces a structured preview the elicit
//                         carries on `pending_output`
//   - resolveToolMode   → the credential gate runs BEFORE the
//                         permission_mode=auto short-circuit so a
//                         pasted token cannot silently land

import { describe, expect, test } from "bun:test";
import {
  buildPendingOutputForTool,
  hasInlineCredential,
  prerequisitesForTool,
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
  test("auto mode is overridden to confirm_before when an inline credential is staged", () => {
    const mode = resolveToolMode({
      tool: "update_connector_draft",
      category: "draft_write",
      input: { config: { token: "ghp_xxx" } },
      overrides: {},
      permission_mode: "auto",
    });
    expect(mode).toBe("confirm_before_execution");
  });

  test("auto mode stays auto when no inline credential is present", () => {
    const mode = resolveToolMode({
      tool: "update_connector_draft",
      category: "draft_write",
      input: { config: {} },
      overrides: {},
      permission_mode: "auto",
    });
    expect(mode).toBe("no_confirm");
  });
});

describe("prerequisitesForTool", () => {
  // Infrastructure-level tests. Specific tool declarations are added
  // per-tool once the auto-load-skill flow ships; until then every
  // tool reports an empty list and the sdk-wrap gate is a no-op.
  test("tools without explicit prerequisites return an empty array", () => {
    expect(prerequisitesForTool("propose_step")).toEqual([]);
    expect(prerequisitesForTool("inspect_workflow_draft")).toEqual([]);
    expect(prerequisitesForTool("dry_run_step")).toEqual([]);
  });

  test("unknown tools return an empty array (no throws)", () => {
    expect(prerequisitesForTool("unknown_tool_name_xyz")).toEqual([]);
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
