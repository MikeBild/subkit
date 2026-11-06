import { describe, expect, test } from "bun:test";
import { REVIEW_DECISIONS } from "../../llm/runtime/step-router.ts";
import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withConnectorPersisted,
  withWorkflowDraft,
  withWorkflowExecution,
  withWorkflowPersisted,
} from "../authoring-state/index.ts";
import { DANGEROUS_TOOLS_SET } from "../dangerous-tools.ts";
import { TOOL_POLICIES } from "../tool-policies.ts";
import {
  CHAT_READONLY_TOOLS,
  CONNECTOR_AUTHORING_SKILL,
  filterByAuthoringPalette,
  filterByChatReadOnlyPalette,
  WORKFLOW_AUTHORING_SKILL,
} from "../tools/authoring-palette.ts";
import { listTools } from "../tools/index.ts";

const ALL_AUTHORING_SKILLS = new Set<string>([CONNECTOR_AUTHORING_SKILL, WORKFLOW_AUTHORING_SKILL]);
const ONLY_CONNECTOR_SKILL = new Set<string>([CONNECTOR_AUTHORING_SKILL]);
const ONLY_WORKFLOW_SKILL = new Set<string>([WORKFLOW_AUTHORING_SKILL]);
const NO_SKILLS = new Set<string>();

describe("authoring tool palette — skill-gated visibility", () => {
  test("with both authoring skills loaded, the canonical authoring + read tools are visible on a fresh draft", () => {
    const visible = filterByAuthoringPalette(
      listTools(),
      createEmptyDraftDocument(),
      ALL_AUTHORING_SKILLS,
    ).map((tool) => tool.name);
    expect(visible).toContain("start_connector_from_description");
    expect(visible).toContain("author_workflow");
    expect(visible).toContain("save_connector_draft");
    expect(visible).toContain("save_workflow_draft");
    expect(visible).toContain("list_connectors");
    expect(visible).toContain("list_workflows");
  });

  test("with no skills loaded, authoring tools are NOT visible (palette must be loaded explicitly)", () => {
    const visible = filterByAuthoringPalette(
      listTools(),
      createEmptyDraftDocument(),
      NO_SKILLS,
    ).map((tool) => tool.name);
    expect(visible).toContain("ask_user_text");
    expect(visible).toContain("list_skills");
    expect(visible).toContain("load_skill");
    expect(visible).toContain("list_connectors");
    expect(visible).toContain("delete_connector");
    expect(visible).not.toContain("save_connector_draft");
    expect(visible).not.toContain("save_workflow_draft");
    expect(visible).not.toContain("edit_workflow_patch");
    expect(visible).not.toContain("start_connector_from_description");
  });

  test("save_connector_draft stays visible mid-authoring even when no inspections / validations / probes have run", () => {
    const draft = withConnectorDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused API",
        slug: "focused-api",
        driver: "http",
        environment: "dev",
        base_url: "https://api.example.com",
        auth_type: "none",
        config: {},
        docs: [],
        latest_probe: null,
        saved_connector_id: null,
        validation: { ok: false, missing_fields: [], errors: [] },
      },
      "connector_started_from_description",
    );
    const visible = filterByAuthoringPalette(listTools(), draft, ONLY_CONNECTOR_SKILL).map(
      (tool) => tool.name,
    );
    expect(visible).toContain("inspect_connector_draft");
    expect(visible).toContain("probe_connector_draft");
    expect(visible).toContain("validate_connector_draft");
    expect(visible).toContain("save_connector_draft");
    expect(visible).not.toContain("edit_workflow_patch");
    expect(visible).not.toContain("create_api_key");
  });

  test("save_workflow_draft stays visible during workflow authoring even before any preview ran", () => {
    const draft = withWorkflowDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused Workflow",
        slug: "focused-workflow",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return input.input;",
          },
        ],
      },
      "workflow_seeded_from_goal",
    );
    const visible = filterByAuthoringPalette(listTools(), draft, ONLY_WORKFLOW_SKILL).map(
      (tool) => tool.name,
    );
    expect(visible).toContain("save_workflow_draft");
    expect(visible).toContain("run_workflow");
    expect(visible).toContain("diagnose_latest_execution");
    expect(visible).toContain("dry_run_workflow");
    expect(visible).not.toContain("save_connector_draft");
  });

  test("persisted connector keeps connector authoring + workflow palette visible (when both loaded)", () => {
    let draft = withConnectorDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused API",
        slug: "focused-api",
        driver: "http",
        environment: "dev",
        base_url: "https://api.example.com",
        auth_type: "none",
        config: {},
        docs: [],
        latest_probe: null,
        saved_connector_id: "connector_123",
        validation: { ok: true, missing_fields: [], errors: [] },
      },
      "connector_started_from_description",
    );
    draft = withConnectorPersisted(draft, draft.connector ?? null, {
      kind: "connector",
      id: "connector_123",
      name: "Focused API",
      slug: "focused-api",
      version_id: null,
      version: null,
      environment: "dev",
      saved_at: "2026-04-23T10:00:00.000Z",
    });
    const visible = filterByAuthoringPalette(listTools(), draft, ALL_AUTHORING_SKILLS).map(
      (tool) => tool.name,
    );
    expect(visible).toContain("author_workflow");
    expect(visible).toContain("edit_workflow_patch");
    expect(visible).toContain("inspect_workflow_draft");
    expect(visible).toContain("authenticate_oauth");
    expect(visible).toContain("save_connector_draft");
  });

  test("persisted workflow keeps every authoring tool visible (no state-gate hides them)", () => {
    let draft = withWorkflowDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused Workflow",
        slug: "focused-workflow",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return input.input;",
          },
        ],
      },
      "workflow_seeded_from_goal",
    );
    draft = withWorkflowPersisted(draft, {
      kind: "workflow",
      id: "workflow_123",
      name: "Focused Workflow",
      slug: "focused-workflow",
      version_id: "version_1",
      version: 1,
      environment: "dev",
      saved_at: "2026-04-23T10:00:00.000Z",
    });
    const visible = filterByAuthoringPalette(listTools(), draft, ALL_AUTHORING_SKILLS).map(
      (tool) => tool.name,
    );
    expect(visible).toContain("run_workflow");
    expect(visible).toContain("save_workflow_draft");
    expect(visible).toContain("edit_workflow_patch");
    expect(visible).toContain("diagnose_latest_execution");
    expect(visible).toContain("list_connectors");
  });

  test("execution-only state keeps run_workflow visible when workflow-authoring is loaded", () => {
    const draft = withWorkflowExecution(createEmptyDraftDocument(), {
      execution_id: "exec_456",
      workflow_id: "workflow_456",
      workflow_version_id: "version_456",
      status: "succeeded",
      environment: "dev",
      warnings_count: 0,
      recorded_at: "2026-04-25T10:05:00.000Z",
      diagnosis_available: false,
    });
    const visible = filterByAuthoringPalette(listTools(), draft, ONLY_WORKFLOW_SKILL).map(
      (tool) => tool.name,
    );
    expect(visible).toContain("run_workflow");
  });
});

describe("authoring tool palette — inert proposals", () => {
  const proposals = listTools().filter((t) => t.inert_proposal === true);

  test("only tools that file a review-queue proposal carry the flag", () => {
    expect(proposals.map((t) => t.name).sort()).toEqual([
      "propose_workflow_repair",
      "save_learning",
    ]);
  });

  test("each is a tenant write whose approve step is its confirmation", () => {
    for (const t of proposals) {
      expect(t.category).toBe("tenant_write");
      expect(TOOL_POLICIES[t.name]?.defaultMode).toBe("no_confirm");
      expect(TOOL_POLICIES[t.name]?.neverGate).toBe(true);
    }
  });

  test("they are offered with no skill loaded", () => {
    const visible = filterByAuthoringPalette(
      listTools(),
      createEmptyDraftDocument(),
      NO_SKILLS,
    ).map((tool) => tool.name);
    expect(visible).toContain("save_learning");
  });

  test("a decision is never flagged as a proposal", () => {
    for (const name of REVIEW_DECISIONS) {
      expect(listTools().find((t) => t.name === name)?.inert_proposal).not.toBe(true);
    }
  });
});

describe("authoring tool palette — review decisions", () => {
  test("the set is exactly the skill-candidate approval and rejection", () => {
    expect([...REVIEW_DECISIONS].sort()).toEqual([
      "approve_skill_candidate",
      "reject_skill_candidate",
    ]);
  });

  test("each is a registered tenant write behind the confirm gate", () => {
    for (const name of REVIEW_DECISIONS) {
      expect(listTools().find((t) => t.name === name)?.category).toBe("tenant_write");
      expect(DANGEROUS_TOOLS_SET.has(name)).toBe(true);
      expect(TOOL_POLICIES[name]?.defaultMode).toBe("confirm_before_execution");
      expect(TOOL_POLICIES[name]?.neverGate).not.toBe(true);
    }
  });

  test("they are offered on the authoring palette with no skill loaded", () => {
    const visible = filterByAuthoringPalette(
      listTools(),
      createEmptyDraftDocument(),
      NO_SKILLS,
    ).map((tool) => tool.name);
    for (const name of REVIEW_DECISIONS) expect(visible).toContain(name);
  });

  test("the read-only chat surface never lists them", () => {
    const chat = filterByChatReadOnlyPalette(listTools()).map((tool) => tool.name);
    for (const name of REVIEW_DECISIONS) {
      expect(CHAT_READONLY_TOOLS.has(name)).toBe(false);
      expect(chat).not.toContain(name);
    }
  });
});
