import {
  CONNECTOR_AUTHORING_SKILL,
  filterByAuthoringPalette,
  WORKFLOW_AUTHORING_SKILL,
} from "../../src/conversations/tools/authoring-palette.ts";
import { listTools } from "../../src/conversations/tools/index.ts";
import type { AuthoringSummary, DraftDocument } from "../../src/conversations/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  active_target: AuthoringSummary["active_target"];
  stage: AuthoringSummary["stage"];
  lifecycle_state: AuthoringSummary["lifecycle_state"];
  checkpoints: AuthoringSummary["checkpoints"];
  blocked_by: AuthoringSummary["blocked_by"];
  missing_fields: AuthoringSummary["missing_fields"];
  expect_palette_includes: string[];
  expect_palette_excludes_when_validation_stale: string[];
}

function summary(over: Partial<AuthoringSummary> = {}): AuthoringSummary {
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
    persisted_resources: [],
    latest_execution: null,
    latest_diagnosis: null,
    ...over,
  };
}

const ALL_AUTHORING_SKILLS = new Set<string>([CONNECTOR_AUTHORING_SKILL, WORKFLOW_AUTHORING_SKILL]);

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;

  const ready = summary({
    active_target: input.active_target,
    stage: input.stage,
    lifecycle_state: input.lifecycle_state,
    checkpoints: input.checkpoints,
    blocked_by: input.blocked_by,
    missing_fields: input.missing_fields,
  });
  const readyDraft: DraftDocument = {
    workflow: { name: "draft", steps: [{ id: "s1", kind: "request" }] } as never,
    summary: ready,
  };
  const readyVisible = filterByAuthoringPalette(listTools(), readyDraft, ALL_AUTHORING_SKILLS).map(
    (tool) => tool.name,
  );
  if (!readyVisible.includes("save_workflow_draft")) {
    return {
      pass: false,
      reason:
        "regressed chat-first repair contract: save_workflow_draft missing from the palette even with workflow-authoring loaded",
    };
  }

  const notValidated = summary({
    active_target: input.active_target,
    lifecycle_state: input.lifecycle_state,
    blocked_by: ["validate_draft"],
    checkpoints: [],
  });
  const notValidatedDraft: DraftDocument = {
    workflow: { name: "draft", steps: [{ id: "s1", kind: "request" }] } as never,
    summary: notValidated,
  };
  const notValidatedVisible = filterByAuthoringPalette(
    listTools(),
    notValidatedDraft,
    ALL_AUTHORING_SKILLS,
  ).map((tool) => tool.name);
  if (!notValidatedVisible.includes("save_workflow_draft")) {
    return {
      pass: false,
      reason:
        "regressed skill-gated palette: save_workflow_draft must stay in the palette regardless of state — wrong-state calls are recovered via the tool's own structured envelope",
    };
  }

  return { pass: true };
}
