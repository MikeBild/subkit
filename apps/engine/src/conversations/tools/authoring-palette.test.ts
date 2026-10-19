import { describe, expect, test } from "bun:test";
import {
  applyExecutionToolGate,
  collectSyntheticWorkflowSlugs,
  filterByAuthoringPalette,
  isExecutionToolName,
  resolveExecutionToolGate,
  resolveNamedWorkflowSlug,
} from "./authoring-palette.ts";

describe("intake processing palette", () => {
  test("exposes discard and restore for an interactive authoring conversation only", () => {
    const tools = [
      { name: "discard_intake_items" },
      { name: "restore_intake_item" },
      { name: "move_intake_item" },
      { name: "set_default_intake_category" },
      { name: "create_intake_proposal" },
      { name: "get_intake_item" },
    ];
    const names = filterByAuthoringPalette(tools, {} as never, new Set()).map((tool) => tool.name);
    expect(names).toEqual([
      "discard_intake_items",
      "restore_intake_item",
      "move_intake_item",
      "set_default_intake_category",
      "create_intake_proposal",
    ]);
  });
});

describe("existing workflow authoring palette", () => {
  test("can open a saved workflow before the workflow skill is loaded", () => {
    const tools = [
      { name: "open_workflow_draft" },
      { name: "edit_workflow_patch" },
      { name: "save_workflow_draft" },
    ];
    const names = filterByAuthoringPalette(tools, {} as never, new Set()).map((tool) => tool.name);
    expect(names).toEqual(["open_workflow_draft"]);
  });
});

describe("resolveExecutionToolGate", () => {
  test("default-deny: no bound target and no named slug hides execution", () => {
    const d = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: null,
    });
    expect(d.exposeExecution).toBe(false);
    expect(d.reason).toBe("authoring_no_target");
  });

  test("a bound saved workflow exposes execution", () => {
    const d = resolveExecutionToolGate({
      hasBoundSavedWorkflow: true,
      explicitlyNamedWorkflowSlug: null,
    });
    expect(d.exposeExecution).toBe(true);
    expect(d.reason).toBe("bound_saved_workflow");
  });

  test("a named saved-workflow slug exposes execution even when unbound", () => {
    const d = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: "notion-essay-to-markdown",
    });
    expect(d.exposeExecution).toBe(true);
    expect(d.reason).toBe("named_workflow_slug");
  });

  test("no bound / named evidence still default-denies (authoring surface)", () => {
    const d = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: null,
    });
    expect(d.exposeExecution).toBe(false);
    expect(d.reason).toBe("authoring_no_target");
  });
});

describe("isExecutionToolName", () => {
  const catalog = new Set(["notion-essay-to-markdown", "my-jira-tickets"]);

  test("the literal run_workflow tool is an execution tool", () => {
    expect(isExecutionToolName("run_workflow", catalog)).toBe(true);
  });

  test("a wf_<slug> peer in the catalog is an execution tool", () => {
    expect(isExecutionToolName("wf_notion-essay-to-markdown", catalog)).toBe(true);
    expect(isExecutionToolName("wf_my-jira-tickets", catalog)).toBe(true);
  });

  test("a wf_<slug> not in the catalog is NOT matched", () => {
    expect(isExecutionToolName("wf_unknown-flow", catalog)).toBe(false);
  });

  test("authoring tools are not execution tools", () => {
    expect(isExecutionToolName("edit_workflow_patch", catalog)).toBe(false);
    expect(isExecutionToolName("author_workflow", catalog)).toBe(false);
    expect(isExecutionToolName("dry_run_workflow", catalog)).toBe(false);
  });
});

describe("resolveNamedWorkflowSlug", () => {
  const catalog = new Set(["notion-essay-to-markdown", "my-jira-tickets", "leaderboard", "run"]);

  test("returns a multi-segment slug named verbatim in the message", () => {
    expect(resolveNamedWorkflowSlug("run notion-essay-to-markdown for page 123", catalog)).toBe(
      "notion-essay-to-markdown",
    );
  });

  test("matches case-insensitively on a whole-word boundary", () => {
    expect(resolveNamedWorkflowSlug("please run My-Jira-Tickets now", catalog)).toBe(
      "my-jira-tickets",
    );
  });

  test("a long single-token slug is matched", () => {
    expect(resolveNamedWorkflowSlug("show me the leaderboard please", catalog)).toBe("leaderboard");
  });

  test("a short common-word slug ('run') never self-matches incidental prose", () => {
    expect(resolveNamedWorkflowSlug("run a brand new workflow from scratch", catalog)).toBeNull();
  });

  test("a slug embedded inside a longer token does not match", () => {
    expect(resolveNamedWorkflowSlug("the leaderboards page is unrelated", catalog)).toBeNull();
  });

  test("no slug present → null", () => {
    expect(resolveNamedWorkflowSlug("build something that reads notion", catalog)).toBeNull();
    expect(resolveNamedWorkflowSlug(null, catalog)).toBeNull();
    expect(resolveNamedWorkflowSlug("", catalog)).toBeNull();
  });
});

describe("collectSyntheticWorkflowSlugs", () => {
  test("extracts bare slugs from wf_<slug> tool names, ignoring others", () => {
    const slugs = collectSyntheticWorkflowSlugs([
      "run_workflow",
      "wf_notion-essay-to-markdown",
      "edit_workflow_patch",
      "wf_my-jira-tickets",
      "list_workflows",
    ]);
    expect([...slugs].sort()).toEqual(["my-jira-tickets", "notion-essay-to-markdown"]);
  });
});

describe("applyExecutionToolGate", () => {
  const slugs = new Set(["notion-essay-to-markdown"]);

  function palette(): Record<string, unknown> {
    return {
      run_workflow: {},
      "wf_notion-essay-to-markdown": {},
      edit_workflow_patch: {},
      list_workflows: {},
    };
  }

  test("removes run_workflow + wf_<slug> peers when execution is not exposed", () => {
    const tools = palette();
    const removed = applyExecutionToolGate(
      tools,
      { exposeExecution: false, reason: "authoring_no_target" },
      slugs,
    );
    expect(removed).toBe(2);
    expect(tools.run_workflow).toBeUndefined();
    expect(tools["wf_notion-essay-to-markdown"]).toBeUndefined();
    expect(tools.edit_workflow_patch).toBeDefined();
    expect(tools.list_workflows).toBeDefined();
  });

  test("removes nothing when execution is exposed", () => {
    const tools = palette();
    const removed = applyExecutionToolGate(
      tools,
      { exposeExecution: true, reason: "bound_saved_workflow" },
      slugs,
    );
    expect(removed).toBe(0);
    expect(tools.run_workflow).toBeDefined();
    expect(tools["wf_notion-essay-to-markdown"]).toBeDefined();
  });

  test("chat_surface decision keeps execution tools even with no bound/named target", () => {
    const tools = palette();
    const removed = applyExecutionToolGate(
      tools,
      { exposeExecution: true, reason: "chat_surface" },
      slugs,
    );
    expect(removed).toBe(0);
    expect(tools.run_workflow).toBeDefined();
    expect(tools["wf_notion-essay-to-markdown"]).toBeDefined();
  });
});
