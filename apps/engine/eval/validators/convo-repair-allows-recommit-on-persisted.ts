// Validates the chat-first-repair contract: after a persisted workflow
// has been edited and re-validated, commit_draft must appear in the
// conversation tool palette. PR10/PR15 made this guarantee
// unconditional — once `workflow-authoring` is loaded, `commit_draft`
// stays in the palette regardless of state, and wrong-state calls
// return a structured `tool_unavailable_in_state` envelope from
// `state-gate.ts` rather than disappearing from the palette.
//
// Session 95ccaa35 (2026-04-25, mike@mikebild.com) — the original bug
// where the repair flow ended up with the agent suggesting a CLI
// fallback because commit_draft was hidden by a stale checkpoint.

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
      name: "GitHub Private Repos MikeBild",
      slug: "github-private-mikebild",
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

  // Case 1: validated repair on a persisted workflow → commit_draft must
  // be in the palette so the LLM can take the repair-and-save path.
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
  if (!readyVisible.includes("commit_draft")) {
    return {
      pass: false,
      reason:
        "regressed chat-first repair contract: commit_draft missing from the palette even with workflow-authoring loaded",
    };
  }

  // Case 2: tools never silently disappear — commit_draft stays in the
  // palette even when validation is still pending. The wrong-state
  // recovery happens via the structured envelope returned by
  // commit_draft itself, not by hiding the tool.
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
  if (!notValidatedVisible.includes("commit_draft")) {
    return {
      pass: false,
      reason:
        "regressed skill-gated palette: commit_draft must stay in the palette regardless of state — wrong-state calls are recovered via the tool's own structured envelope",
    };
  }
  // The state-gate envelope is enforced by the unit tests in
  // `tools/state-gate.test.ts`; this eval test only pins palette
  // visibility.

  return { pass: true };
}
