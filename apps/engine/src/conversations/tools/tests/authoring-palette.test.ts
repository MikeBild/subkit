// Locks the chat-first-repair contract for the conversation tool palette.
//
// Background — PR10/PR15 replaced state-gated visibility with a
// skill-gated palette: loading the right skill exposes a fixed tool
// set, and tools never silently disappear once exposed. Wrong-state
// calls return a structured `tool_unavailable_in_state` envelope from
// `state-gate.ts` instead of vanishing from the palette. The tests
// below pin that contract.

import { describe, expect, test } from "bun:test";
import type { AuthoringSummary, DraftDocument } from "../../types.ts";
import {
  CONNECTOR_AUTHORING_SKILL,
  filterByAuthoringPalette,
  WORKFLOW_AUTHORING_SKILL,
} from "../authoring-palette.ts";

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
      name: "GitHub Private Repos MikeBild",
      slug: "github-private-mikebild",
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
        slug: "github-private-mikebild",
        name: "GitHub Private Repos MikeBild",
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
      { name: "build_workflow" }, // workflow-only
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, ONLY_CONNECTOR);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("start_connector_from_description");
    expect(names).toContain("inspect_connector_draft");
    expect(names).toContain("save_connector_draft");
    expect(names).toContain("authenticate_oauth");
    expect(names).not.toContain("build_workflow");
  });

  test("workflow-authoring loaded ⇒ workflow + persistence + execution tools exposed", () => {
    const draft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
    };
    const tools = [
      { name: "build_workflow" },
      { name: "propose_step" },
      { name: "validate_draft" },
      { name: "dry_run_workflow" },
      { name: "save_workflow_draft" },
      { name: "run_workflow" },
      { name: "diagnose_latest_execution" },
      { name: "save_connector_draft" }, // connector-only
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, ONLY_WORKFLOW);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("build_workflow");
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
      { name: "build_workflow" }, // workflow-skill required
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft, NO_SKILLS);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("ask_user_text");
    expect(names).toContain("list_skills");
    expect(names).toContain("list_connectors");
    expect(names).toContain("delete_connector");
    expect(names).not.toContain("save_connector_draft");
    expect(names).not.toContain("build_workflow");
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
