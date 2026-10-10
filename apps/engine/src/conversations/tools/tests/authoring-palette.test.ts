import { describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { AuthoringSummary, DraftDocument } from "../../types.ts";
import {
  CHAT_READONLY_TOOLS,
  CONNECTOR_AUTHORING_SKILL,
  filterByAuthoringPalette,
  filterByChatReadOnlyPalette,
  WORKFLOW_AUTHORING_SKILL,
} from "../authoring-palette.ts";
import { listTools } from "../index.ts";

const ALL_SKILLS = new Set<string>([CONNECTOR_AUTHORING_SKILL, WORKFLOW_AUTHORING_SKILL]);
const ONLY_CONNECTOR = new Set<string>([CONNECTOR_AUTHORING_SKILL]);
const ONLY_WORKFLOW = new Set<string>([WORKFLOW_AUTHORING_SKILL]);
const NO_SKILLS = new Set<string>();

function summary(over: Partial<AuthoringSummary>): AuthoringSummary {
  return {
    readiness: "drafting",
    next_action: null,
    next_required_action: null,
    next_suggested_tool: null,
    missing_fields: [],
    last_action: null,
    progress_label: null,
    mode: "workflow",
    stage: "diagnosing",
    lifecycle_state: "persisted",
    active_target: {
      kind: "workflow",
      name: "GitHub Private Repos octocat",
      slug: "github-private-octocat",
      id: "wf-abc",
      environment: "dev",
      lifecycle_state: "persisted",
    },
    blocked_by: [],
    checkpoints: [],
    persisted_resources: [
      {
        kind: "workflow",
        id: "wf-abc",
        slug: "github-private-octocat",
        name: "GitHub Private Repos octocat",
        version_id: "wfv-1",
        version: 1,
        environment: "dev",
        saved_at: "2026-04-25T05:00:00Z",
      },
    ],
    latest_execution: null,
    latest_diagnosis: null,
    ...over,
  };
}

describe("filterByAuthoringPalette — cleanup tools always reachable", () => {
  test("delete_connector / delete_workflow visible in workflow-persisted state", () => {
    const persisted: AuthoringSummary = summary({
      stage: "workflow_persisted",
      readiness: "saved",
    });
    const draft: DraftDocument = {
      workflow: { name: "demo", steps: [{ id: "s1", kind: "request" }] } as never,
      summary: persisted,
    };
    const tools = [
      { name: "delete_connector" },
      { name: "delete_workflow" },
      { name: "revoke_api_key" },
      { name: "delete_knowledge_source" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, ALL_SKILLS);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("delete_connector");
    expect(names).toContain("delete_workflow");
    expect(names).toContain("revoke_api_key");
    expect(names).toContain("delete_knowledge_source");
  });

  test("cleanup tools visible even with no skills loaded", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "delete_connector" },
      { name: "delete_workflow" },
      { name: "revoke_api_key" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, NO_SKILLS);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("delete_connector");
    expect(names).toContain("delete_workflow");
    expect(names).toContain("revoke_api_key");
  });

  test("schedule writes visible in any state with no skills loaded", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "create_schedule" },
      { name: "update_schedule" },
      { name: "delete_schedule" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, NO_SKILLS);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("create_schedule");
    expect(names).toContain("update_schedule");
    expect(names).toContain("delete_schedule");
  });

  test("request_connector_reauth visible with no skills loaded", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "request_connector_reauth", category: "draft_write" },
      { name: "save_connector_draft", category: "draft_write" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, NO_SKILLS);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("request_connector_reauth");
    expect(names).not.toContain("save_connector_draft");
  });
});

describe("filterByAuthoringPalette — skill-gated authoring tools", () => {
  test("connector-creation-guidance loaded ⇒ connector authoring tools exposed", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "start_connector_from_description" },
      { name: "start_connector_from_template" },
      { name: "inspect_connector_draft" },
      { name: "validate_connector_draft" },
      { name: "probe_connector_draft" },
      { name: "save_connector_draft" },
      { name: "authenticate_oauth" },
      { name: "edit_workflow_patch" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, ONLY_CONNECTOR);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("start_connector_from_description");
    expect(names).toContain("inspect_connector_draft");
    expect(names).toContain("save_connector_draft");
    expect(names).toContain("authenticate_oauth");
    expect(names).not.toContain("edit_workflow_patch");
  });

  test("workflow-authoring loaded ⇒ workflow + persistence + execution tools exposed", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "edit_workflow_patch" },
      { name: "start_workflow_from_recipe" },
      { name: "author_workflow" },
      { name: "validate_draft" },
      { name: "dry_run_workflow" },
      { name: "save_workflow_draft" },
      { name: "run_workflow" },
      { name: "diagnose_latest_execution" },
      { name: "save_connector_draft" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, ONLY_WORKFLOW);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("edit_workflow_patch");
    expect(names).toContain("start_workflow_from_recipe");
    expect(names).toContain("save_workflow_draft");
    expect(names).toContain("run_workflow");
    expect(names).toContain("diagnose_latest_execution");
    expect(names).not.toContain("save_connector_draft");
  });

  test("no skills loaded ⇒ only meta + reads + cleanup", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "ask_user_text" },
      { name: "list_skills" },
      { name: "load_skill" },
      { name: "list_connectors" },
      { name: "delete_connector" },
      { name: "save_connector_draft" },
      { name: "edit_workflow_patch" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, NO_SKILLS);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("ask_user_text");
    expect(names).toContain("list_skills");
    expect(names).toContain("list_connectors");
    expect(names).toContain("delete_connector");
    expect(names).not.toContain("save_connector_draft");
    expect(names).not.toContain("edit_workflow_patch");
  });
});

describe("filterByAuthoringPalette — discovery stays reachable", () => {
  test("save_connector_draft stays in palette when probe failed", () => {
    const probedFailed: AuthoringSummary = summary({
      mode: "connector",
      stage: "connector_probed",
      lifecycle_state: "draft_only",
      active_target: {
        kind: "connector",
        name: "GitHub API",
        slug: "github-api",
        id: null,
        environment: "dev",
        lifecycle_state: "draft_only",
      },
      blocked_by: ["probe_connector_draft"],
      persisted_resources: [],
    });
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
      connector: {
        name: "GitHub API",
        slug: "github-api",
        driver: "http",
        environment: "dev",
        base_url: "https://api.github.com",
        auth_type: "bearer",
        config: {},
        docs: [],
        latest_probe: {
          ok: false,
          method: "GET",
          path: "/user",
          environment: "dev",
          status_code: 401,
          summary: "401 Unauthorized",
          failure_code: "http_4xx",
        },
        saved_connector_id: null,
      },
      summary: probedFailed,
    };
    const tools = [
      { name: "save_connector_draft" },
      { name: "probe_connector_draft" },
      { name: "ask_user_form" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, ONLY_CONNECTOR);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("save_connector_draft");
    expect(names).toContain("probe_connector_draft");
    expect(names).toContain("ask_user_form");
  });
});

describe("filterByChatReadOnlyPalette — read-only channel invariants", () => {
  const registry = listTools();
  const chatPalette = filterByChatReadOnlyPalette(registry);
  const chatNames = new Set(chatPalette.map((t) => t.name));

  test("no draft_write or tenant_write tool is exposed (run_workflow + load_skill + ask_user_* excepted)", () => {
    const allowedWriteish = new Set([
      "run_workflow",
      "load_skill",
      "ask_user_choice",
      "ask_user_confirm",
      "ask_user_form",
      "ask_user_multi",
      "ask_user_text",
    ]);
    const offenders = chatPalette.filter(
      (t) =>
        (t.category === "draft_write" || t.category === "tenant_write") &&
        !allowedWriteish.has(t.name),
    );
    expect(offenders.map((t) => t.name)).toEqual([]);
  });

  test("call_connector and every authoring/mutation tool are absent", () => {
    const forbidden = [
      "call_connector",
      "probe_connector",
      "test_connector",
      "discover_connector_endpoints",
      "discover_systems_from_files",
      "fetch_connector_docs",
      "authenticate_oauth",
      "request_connector_reauth",
      "author_workflow",
      "edit_workflow_patch",
      "save_workflow_draft",
      "save_connector_draft",
      "start_connector_from_template",
      "update_connector",
      "delete_connector",
      "update_workflow",
      "delete_workflow",
      "create_knowledge_source",
      "delete_knowledge_source",
      "create_intake_proposal",
      "revise_intake_proposal",
      "create_schedule",
      "update_schedule",
      "delete_schedule",
      "revoke_api_key",
      "revoke_portal_token",
      "dry_run_workflow",
      "dry_run_step",
      "dry_run_transform",
      "diagnose_latest_execution",
      "inspect_authoring_context",
    ];
    for (const name of forbidden) {
      expect(chatNames.has(name), `${name} must not be in the chat palette`).toBe(false);
    }
  });

  test("every allow-list entry resolves to a registered tool (no dead names)", () => {
    const registered = new Set(registry.map((t) => t.name));
    for (const name of CHAT_READONLY_TOOLS) {
      expect(registered.has(name), `${name} is allow-listed but not in listTools()`).toBe(true);
    }
  });

  test("palette ignores skill-load state — loading authoring skills unlocks nothing", () => {
    const again = filterByChatReadOnlyPalette(registry).map((t) => t.name);
    expect(again.sort()).toEqual([...chatNames].sort());
  });

  test("the channel's one action (run_workflow) and core reads stay present", () => {
    for (const name of [
      "run_workflow",
      "list_workflows",
      "find_workflow",
      "get_workflow",
      "search_knowledge",
      "search_docs",
      "list_executions",
      "get_execution",
      "get_skill",
      "find_skill",
      "list_connectors",
      "get_connector",
      "ask_user_confirm",
      "cannot_help",
    ]) {
      expect(chatNames.has(name), `${name} missing from the chat palette`).toBe(true);
    }
  });

  test("intake proposals remain available on the regular authoring palette", () => {
    const visible = filterByAuthoringPalette(registry, createEmptyDraftDocument(), NO_SKILLS).map(
      (tool) => tool.name,
    );
    expect(visible).toContain("create_intake_proposal");
    expect(visible).toContain("revise_intake_proposal");
  });
});
