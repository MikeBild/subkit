// Validates the chat-first-repair contract: after a persisted workflow
// has been edited and re-validated, commit_draft must appear in the
// conversation tool palette. If it does not, the agent has no in-chat
// path to persist its repair and falls back to abstaining via
// cannot_help — typically with a suggest_alternative pointing at the
// `sk` CLI. That regression cost user mike@mikebild.com a turn in
// session 95ccaa35 on 2026-04-25.

import { workflowPersistedAllowsRecommit } from "../../src/conversations/tools/authoring-palette.ts";
import type { AuthoringSummary } from "../../src/conversations/types.ts";
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

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;

  // Case 1: validated repair on a persisted workflow → commit allowed
  const ready = summary({
    active_target: input.active_target,
    stage: input.stage,
    lifecycle_state: input.lifecycle_state,
    checkpoints: input.checkpoints,
    blocked_by: input.blocked_by,
    missing_fields: input.missing_fields,
  });
  if (!workflowPersistedAllowsRecommit(ready)) {
    return {
      pass: false,
      reason:
        "regressed chat-first repair contract: workflowPersistedAllowsRecommit returned false for a persisted workflow with a fresh workflow_validated checkpoint",
    };
  }

  // Case 2: same shape but validation gate not yet cleared → commit forbidden
  const notValidated = summary({
    active_target: input.active_target,
    lifecycle_state: input.lifecycle_state,
    blocked_by: ["validate_draft"],
    checkpoints: [],
  });
  if (workflowPersistedAllowsRecommit(notValidated)) {
    return {
      pass: false,
      reason:
        "guard regressed in the other direction: commit was allowed before validate_draft cleared",
    };
  }

  return { pass: true };
}
