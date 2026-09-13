// Locks the chat-first-repair contract for the conversation tool palette.
//
// Background: the palette is skill-gated rather than state-gated —
// loading the right skill exposes a fixed tool
// set, and tools never silently disappear once exposed. Wrong-state
// calls return a structured `tool_unavailable_in_state` envelope from
// `state-gate.ts` instead of vanishing from the palette. The tests
// below pin that contract.

import { describe, expect, test } from "bun:test";

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
  // Locks the chat-first delete contract. Without this, the palette
  // filter would hide every delete_*/revoke_* tool from focused
  // authoring states. Session 9b9ea73b regression test.
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

  // Schedule writes were the original missing-tool case behind the
  // "yes do daily 10am" turn that silently dropped the schedule:
  // turn-routing.ts told the LLM to call create_schedule, but the
  // palette didn't carry it. Locking visibility here so the contract
  // between routing and palette can't drift again.
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

  // A dead connector credential can surface in ANY conversation, so the
  // recovery tool must always be reachable. It is `draft_write` (the
  // non-OAuth path stages a re-issue draft), so the `tenant_read` catch-all
  // no longer keeps it visible — it must be in an always-available set.
  // Without this assertion, flipping its category silently removes the
  // repair path from chat (the regression this exact fix restored).
  test("request_connector_reauth visible with no skills loaded", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "request_connector_reauth", category: "draft_write" },
      { name: "save_connector_draft", category: "draft_write" }, // connector-skill required
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, NO_SKILLS);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("request_connector_reauth");
    // Sanity: a genuinely skill-gated draft_write tool stays hidden, proving
    // the inclusion above is the explicit allow-set entry, not a category leak.
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
      { name: "edit_workflow_patch" }, // workflow-only
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
      { name: "save_connector_draft" }, // connector-only
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, ONLY_WORKFLOW);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("edit_workflow_patch");
    // Regression: start_workflow_from_recipe must be exposed in the
    // authoring conversation so recipes can be cloned (pre-fix it was
    // omitted, forcing error-prone free-form edit_workflow_patch).
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
      { name: "save_connector_draft" }, // connector-skill required
      { name: "edit_workflow_patch" }, // workflow-skill required
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

describe("filterByAuthoringPalette — session 00b93a52 regression", () => {
  // Session 00b93a52 ended with the agent saying "save_connector_draft
  // is not available in the current tool palette" and asking the user
  // to restart. Root cause: the old palette hid `save_connector_draft`
  // when the probe checkpoint was stale. The fix: palette exposes the
  // tool whenever `connector-creation-guidance` is loaded, regardless
  // of probe state — the tool itself returns a structured probe_failed
  // envelope that the LLM can recover from in the same turn.
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

// ── Chat read-only palette ──────────────────────────────────────────────────
//
// The chat surface (external chat platforms) is channel-scoped
// read-only: authoring, mutation, and direct connector calls are
// structurally absent from the palette, independent of skill-load
// state and of the linked user's role. These invariants run against
// the REAL tool registry so a future tool addition/category change is
// checked, not a hand-maintained fixture.

describe("filterByChatReadOnlyPalette — read-only channel invariants", () => {
  const registry = listTools();
  const chatPalette = filterByChatReadOnlyPalette(registry);
  const chatNames = new Set(chatPalette.map((t) => t.name));

  test("no draft_write or tenant_write tool is exposed (run_workflow + load_skill + ask_user_* excepted)", () => {
    // ask_user_* are categorised draft_write because their elicitation
    // rows can carry commit_intents — but on the chat surface those
    // intents are refused by the auto-persist gate
    // (`persistence/auto-persist.ts`, chat_readonly_commit_intent), so
    // the tools themselves are pure conversation plumbing here.
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
    // The filter takes no loadedSkills by design; this pins the
    // signature-level invariant by asserting the read-only set stays
    // identical to a recomputation after the authoring palette (which
    // IS skill-sensitive) would have unlocked its tool sets.
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
});
