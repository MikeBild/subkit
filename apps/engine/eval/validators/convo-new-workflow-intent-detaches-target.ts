import {
  bindPersistedWorkflow,
  startNewWorkflowDraft,
} from "../../src/conversations/authoring-state.ts";
import { detectUserIntent } from "../../src/conversations/intent-detector.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  user_message: string;
  workflow_id: string;
  workflow_version_id: string;
  slug: string;
  name: string;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const detected = detectUserIntent(input.user_message);
  if (detected.startNewWorkflow !== true) {
    return {
      pass: false,
      reason:
        "explicit new-workflow phrasing no longer triggers the conversation reset path for a previously selected saved workflow",
    };
  }

  const draft = startNewWorkflowDraft(
    bindPersistedWorkflow(
      {
        workflow: {
          name: "old-workflow",
          steps: [],
        },
      },
      {
        kind: "workflow",
        id: input.workflow_id,
        slug: input.slug,
        name: input.name,
        version_id: input.workflow_version_id,
        version: 4,
        environment: null,
        saved_at: "2026-04-26T00:00:00.000Z",
      },
    ),
  );

  if (draft.summary?.active_target.kind !== "none") {
    return {
      pass: false,
      reason:
        "fresh workflow authoring still carries a saved workflow target after the reset contract was applied",
    };
  }

  if ((draft.summary?.persisted_resources.length ?? 0) > 0) {
    return {
      pass: false,
      reason:
        "fresh workflow authoring still exposes persisted workflow refs after the reset contract was applied",
    };
  }

  return { pass: true };
}
