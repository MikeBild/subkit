import { describe, expect, test } from "bun:test";
import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withWorkflowDraft,
} from "../../authoring-state.ts";
import type { AuthoringSummary, DraftDocument } from "../../types.ts";
import {
  authoringSkillsForTurn,
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

describe("authoringSkillsForTurn — authoring palette only on intent or an active draft", () => {
  const AUTHORING_TOOLS = [
    { name: "author_workflow" },
    { name: "edit_workflow_patch" },
    { name: "dry_run_workflow" },
    { name: "save_workflow_draft" },
    { name: "start_connector_from_description" },
    { name: "probe_connector_draft" },
    { name: "save_connector_draft" },
  ] as const;

  function paletteFor(
    draft: DraftDocument,
    userMessage: string,
    surface = "web",
    bound: { boundConnector?: boolean; boundWorkflow?: boolean } = {},
  ): string[] {
    const skills = authoringSkillsForTurn({
      surface,
      draft,
      userMessage,
      startNewWorkflow: false,
      boundConnector: bound.boundConnector ?? false,
      boundWorkflow: bound.boundWorkflow ?? false,
    });
    return filterByAuthoringPalette(AUTHORING_TOOLS, draft, new Set(skills)).map((t) => t.name);
  }

  function workflowDraft(): DraftDocument {
    return withWorkflowDraft(createEmptyDraftDocument(), {
      name: "daily-report",
      slug: "daily-report",
      steps: [{ id: "shape", kind: "transform", language: "javascript", expression: "return 1;" }],
    } as never);
  }

  function connectorDraft(): DraftDocument {
    return withConnectorDraft(createEmptyDraftDocument(), {
      name: "Acme API",
      slug: "acme-api",
      driver: "http",
      environment: "dev",
      base_url: "https://api.example.com",
      auth_type: "none",
      config: {},
      docs: [],
      latest_probe: null,
      saved_connector_id: null,
    } as never);
  }

  test("a neutral question without a draft loads no authoring skill", () => {
    expect(paletteFor(createEmptyDraftDocument(), "what failed last night?")).toEqual([]);
  });

  test("an in-progress workflow draft keeps workflow authoring tools on a continuation", () => {
    const names = paletteFor(workflowDraft(), "yes");
    expect(names).toContain("author_workflow");
    expect(names).toContain("edit_workflow_patch");
    expect(names).toContain("dry_run_workflow");
    expect(names).toContain("save_workflow_draft");
    expect(names).not.toContain("start_connector_from_description");
  });

  test("an unsaved connector draft keeps connector authoring tools on a continuation", () => {
    const names = paletteFor(connectorDraft(), "ok");
    expect(names).toContain("probe_connector_draft");
    expect(names).toContain("save_connector_draft");
    expect(names).not.toContain("author_workflow");
  });

  test("a connector saved in this conversation hands over to workflow authoring", () => {
    const saved = withConnectorDraft(createEmptyDraftDocument(), {
      name: "Acme API",
      slug: "acme-api",
      driver: "http",
      environment: "dev",
      base_url: "https://api.example.com",
      auth_type: "none",
      config: {},
      docs: [],
      latest_probe: null,
      saved_connector_id: "00000000-0000-4000-8000-000000000001",
    } as never);
    expect(paletteFor(saved, "continue")).toContain("author_workflow");
  });

  test("workflow-authoring intent without a draft exposes workflow authoring tools", () => {
    expect(
      paletteFor(createEmptyDraftDocument(), "erstelle einen workflow für den Bericht"),
    ).toContain("author_workflow");
  });

  test("connector-creation intent without a draft exposes connector authoring tools", () => {
    for (const message of [
      "create a connector for the Stripe API",
      "Erstelle einen Connector für unser CRM",
      "add an integration for HubSpot",
      "Connect our Metabase MCP server for reporting",
      "subkit engine onboarding",
    ]) {
      expect(paletteFor(createEmptyDraftDocument(), message)).toContain(
        "start_connector_from_description",
      );
    }
    expect(paletteFor(createEmptyDraftDocument(), "list my connectors")).toEqual([]);
  });

  test("a requested new workflow loads workflow authoring", () => {
    expect(
      authoringSkillsForTurn({
        surface: "sk_interactive",
        draft: createEmptyDraftDocument(),
        userMessage: "noch einer",
        startNewWorkflow: true,
        boundConnector: false,
        boundWorkflow: false,
      }),
    ).toEqual([WORKFLOW_AUTHORING_SKILL]);
  });

  test("a conversation bound to a connector or a saved workflow loads workflow authoring", () => {
    for (const bound of [{ boundConnector: true }, { boundWorkflow: true }]) {
      const names = paletteFor(
        createEmptyDraftDocument(),
        "please list users from the api",
        "mcp",
        bound,
      );
      expect(names).toContain("edit_workflow_patch");
      expect(names).toContain("save_workflow_draft");
    }
  });

  test("repair and diagnosis wording without a draft exposes the repair tools", () => {
    for (const message of [
      "repair workflow ga4-daily-report",
      "fix the failing workflow",
      "Bitte reparier den Workflow",
      "diagnose the latest execution of ga4-daily-report",
      "Warum ist mein letzter Lauf von ga4-daily-report fehlgeschlagen?",
    ]) {
      const names = paletteFor(createEmptyDraftDocument(), message);
      expect(names).toContain("edit_workflow_patch");
      expect(names).toContain("dry_run_workflow");
      expect(names).toContain("save_workflow_draft");
    }
    expect(paletteFor(createEmptyDraftDocument(), "fix the typo in my message")).toEqual([]);
    expect(paletteFor(createEmptyDraftDocument(), "do not fix the workflow")).toEqual([]);
  });

  test("the read-only chat surface never loads authoring skills, even with a draft", () => {
    expect(paletteFor(workflowDraft(), "create a workflow", "chat")).toEqual([]);
  });
});
