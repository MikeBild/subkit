import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../../src/conversations/authoring-state/index.ts";
import { inferStateDrivenFollowUpTool } from "../../src/conversations/intent-detector.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  approval_reply: string;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;

  let workflowDraft = withWorkflowDraft(createEmptyDraftDocument(), {
    name: "daily-sync",
    slug: "daily-sync",
    steps: [
      { id: "shape", kind: "transform", expression: "return input.input;", language: "javascript" },
    ],
  });
  workflowDraft = withWorkflowInspection(workflowDraft);
  workflowDraft = withWorkflowValidation(workflowDraft, true, "Workflow draft valid.");
  workflowDraft = withLatestPreview(workflowDraft, {
    ok: true,
    step_id: "shape",
    summary: "Preview ok.",
  });

  const workflowTool = inferStateDrivenFollowUpTool({
    latestUserText: input.approval_reply,
    ask_before_writing: false,
    summary: workflowDraft.summary,
  });
  if (workflowTool !== "save_workflow_draft") {
    return {
      pass: false,
      reason:
        "ready workflow drafts no longer map a short auto-mode approval onto save_workflow_draft",
    };
  }

  let connectorDraft = withConnectorDraft(createEmptyDraftDocument(), {
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
    validation: { ok: true, missing_fields: [], errors: [] },
  });
  connectorDraft = withConnectorInspection(connectorDraft);
  const connector = connectorDraft.connector;
  if (!connector) {
    return {
      pass: false,
      reason: "connector draft setup regressed before the save follow-up contract could be checked",
    };
  }
  connectorDraft = withConnectorValidation(
    connectorDraft,
    {
      ...connector,
      validation: { ok: true, missing_fields: [], errors: [] },
    },
    true,
    "Connector draft valid.",
  );
  connectorDraft = withConnectorProbe(
    connectorDraft,
    {
      ...connector,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/health",
        environment: "dev",
        status_code: 200,
        summary: "Probe ok.",
      },
    },
    true,
    "Probe ok.",
  );

  const connectorTool = inferStateDrivenFollowUpTool({
    latestUserText: input.approval_reply,
    ask_before_writing: false,
    summary: connectorDraft.summary,
  });
  if (connectorTool !== "save_connector_draft") {
    return {
      pass: false,
      reason:
        "ready connector drafts no longer map a short auto-mode approval onto save_connector_draft",
    };
  }

  return { pass: true };
}
