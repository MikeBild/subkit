import {
  bindPersistedWorkflow,
  withWorkflowExecution,
} from "../../src/conversations/authoring-state/index.ts";
import { filterByAuthoringPalette } from "../../src/conversations/tools/authoring-palette.ts";
import { cannotHelpTool } from "../../src/conversations/tools/cannot-help.ts";
import { listTools } from "../../src/conversations/tools/index.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  workflow_id: string;
  workflow_version_id: string;
  execution_id: string;
  slug: string;
  name: string;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const draft: DraftDocument = withWorkflowExecution(
    bindPersistedWorkflow(
      {
        workflow: {
          name: "draft",
          steps: [],
        },
      },
      {
        kind: "workflow",
        id: input.workflow_id,
        slug: input.slug,
        name: input.name,
        version_id: input.workflow_version_id,
        version: 1,
        environment: null,
        saved_at: "2026-04-25T00:00:00.000Z",
      },
    ),
    {
      execution_id: input.execution_id,
      workflow_id: input.workflow_id,
      workflow_version_id: input.workflow_version_id,
      status: "succeeded",
      environment: "dev",
      warnings_count: 0,
      recorded_at: "2026-04-25T00:00:00.000Z",
      diagnosis_available: false,
    },
  );

  const visible = filterByAuthoringPalette(listTools(), draft, new Set(["workflow-authoring"])).map(
    (tool) => tool.name,
  );
  if (!visible.includes("run_workflow")) {
    return {
      pass: false,
      reason:
        "saved workflow rerun regressed: run_workflow disappeared from the conversation palette after a successful execution",
    };
  }

  const notes = cannotHelpTool.important_notes?.join(" ") ?? "";
  if (!notes.includes("inside chat")) {
    return {
      pass: false,
      reason:
        "cannot_help guidance regressed: suggest_alternative is no longer forced to stay in chat",
    };
  }
  if (!notes.includes("raw HTTP calls")) {
    return {
      pass: false,
      reason:
        "cannot_help guidance regressed: off-surface HTTP fallback is no longer explicitly blocked",
    };
  }

  return { pass: true };
}
