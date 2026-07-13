// Onboarding policy — deterministic state machine that decides the single
// best next action and, when useful, the single best next clarifying
// question. Consumed by the authoring context block renderer so the model
// sees a concrete "ask this now" hint instead of re-deriving one from the
// free-form system prompt every turn.

import { extractTemplatePlaceholders } from "./connector-template-intelligence.ts";
import type { DraftDocument } from "./types.ts";

export type ExpertiseHint = "novice" | "intermediate" | "expert";

export type NextActionKind =
  | "intent_classification"
  | "connector_template_or_describe"
  | "connector_auth_method"
  | "connector_base_url"
  | "connector_docs"
  | "connector_environment"
  | "connector_probe"
  | "connector_save"
  | "workflow_goal"
  | "workflow_connector_selection"
  | "workflow_trigger_and_output"
  | "workflow_first_step"
  | "workflow_preview"
  | "workflow_commit"
  | "resolve_pending_approval"
  | "continue";

export interface NextAction {
  kind: NextActionKind;
  summary: string;
  rationale: string;
  /** Advisory tool names the LLM should consider first. */
  tool_hints?: string[];
}

export type QuestionKind = "choice" | "text" | "confirm";

export interface NextQuestion {
  kind: QuestionKind;
  subject: NextActionKind;
  prompt: string;
  options?: Array<{ id: string; label: string; detail?: string }>;
}

export interface PolicyInput {
  draft: DraftDocument | null | undefined;
  pending_approval?: {
    tool_name: string;
    summary: string | null;
  } | null;
  expertise?: ExpertiseHint;
  /** Current user message — used for URL/spec detection hints at classification time. */
  user_message?: string | null;
}

/** Derive tool hints from a raw user message at intent-classification time. */
function intentClassificationToolHints(msg: string): string[] {
  const hints: string[] = [];
  if (/\bhttps?:\/\/\S+/.test(msg)) hints.push("match_connector_template_by_url");
  if (msg.trimStart().startsWith("curl ") || /^openapi:/m.test(msg) || /^swagger:/m.test(msg)) {
    hints.push("import_connector_from_spec");
  }
  return hints;
}

export function nextRecommendedAction(input: PolicyInput): NextAction {
  if (input.pending_approval) {
    return {
      kind: "resolve_pending_approval",
      summary: "Resolve the pending approval (approve or reject) before proceeding.",
      rationale:
        "An authoring action paused the loop on an elicitation. Nothing else progresses until the user answers.",
    };
  }
  const d = input.draft;
  if (!d) {
    const msg = input.user_message ?? "";
    const toolHints = intentClassificationToolHints(msg);
    return {
      kind: "intent_classification",
      summary: "Acknowledge the goal and classify the user's intent.",
      rationale: "No draft exists yet — this is either onboarding or an informational turn.",
      ...(toolHints.length > 0 ? { tool_hints: toolHints } : {}),
    };
  }
  const mode = d.mode ?? "onboarding";
  const connector = d.connector ?? null;
  const connectorSaved = typeof connector?.saved_connector_id === "string";
  const workflowSteps = d.workflow.steps.length;
  const probe = connector?.latest_probe ?? null;
  const preview = d.latest_preview ?? null;
  const endpointPlaceholders = extractTemplatePlaceholders(connector?.base_url);

  if (mode === "connector_authoring" || (connector && !connectorSaved)) {
    if (!connector?.name || !connector.driver) {
      return {
        kind: "connector_template_or_describe",
        summary: "Decide whether to use a template or describe the connector from scratch.",
        rationale: "The connector draft is still missing its identity (name + driver).",
      };
    }
    if (!connector.auth_type) {
      return {
        kind: "connector_auth_method",
        summary: "Collect the authentication method.",
        rationale: "The driver is known but the auth mode has not been selected yet.",
      };
    }
    if ((!connector.base_url && !connector.dsn) || endpointPlaceholders.length > 0) {
      return {
        kind: "connector_base_url",
        summary:
          endpointPlaceholders.length > 0
            ? `Collect the remaining endpoint values: ${endpointPlaceholders.join(", ")}.`
            : "Collect the base URL or DSN.",
        rationale:
          endpointPlaceholders.length > 0
            ? "The selected template still has unresolved endpoint placeholders."
            : "The connector cannot reach the upstream without an endpoint.",
      };
    }
    if (probe?.ok !== true) {
      return {
        kind: "connector_probe",
        summary: "Run probe_connector_draft to verify auth and response shape.",
        rationale:
          "Probe-before-save is the default quality gate; a successful probe unblocks save_connector_draft.",
      };
    }
    return {
      kind: "connector_save",
      summary: "Save the connector draft now that the probe succeeded.",
      rationale: "The connector is valid and probed — the save gate will accept it.",
    };
  }

  if (mode === "workflow_authoring" || connectorSaved || workflowSteps > 0) {
    if (workflowSteps === 0) {
      return {
        kind: "workflow_goal",
        summary: "Ask for the workflow goal and which connectors are involved.",
        rationale: "A workflow draft exists but has no steps yet.",
      };
    }
    if (preview?.ok !== true) {
      return {
        kind: "workflow_preview",
        summary: "Run dry_run_step or dry_run_workflow before committing.",
        rationale:
          "Preview-before-commit is the default quality gate; save_workflow_draft refuses without a successful preview.",
      };
    }
    return {
      kind: "workflow_commit",
      summary:
        "Commit the workflow via ask_user_confirm with commit_intent { kind: 'save_workflow_draft' } — the harness auto-persists on confirm; do NOT chain a separate save_workflow_draft call.",
      rationale: "Validation passed and the last preview succeeded.",
    };
  }

  return {
    kind: "intent_classification",
    summary: "Clarify whether the user wants a connector, a workflow, or to resume prior work.",
    rationale: "Mode is onboarding with no draft state yet.",
  };
}

export function nextQuestion(input: PolicyInput): NextQuestion | null {
  const action = nextRecommendedAction(input);
  switch (action.kind) {
    case "intent_classification":
      return {
        kind: "choice",
        subject: action.kind,
        prompt: "What would you like to do next?",
        options: [
          {
            id: "connect_system",
            label: "Create a connector",
            detail: "Start a new connector draft",
          },
          {
            id: "author_workflow",
            label: "Build a workflow",
            detail: "Author a multi-step workflow",
          },
          { id: "import_spec", label: "Import a spec or docs", detail: "Start from OpenAPI/notes" },
          {
            id: "resume_prior",
            label: "Resume prior work",
            detail: "Pick from recent conversations",
          },
        ],
      };
    case "connector_template_or_describe":
      return {
        kind: "choice",
        subject: action.kind,
        prompt: "Start the connector from a template, or describe it from scratch?",
        options: [
          { id: "template", label: "Pick a template", detail: "Faster when a close match exists" },
          {
            id: "describe",
            label: "Describe it in your own words",
            detail: "Works for any connector target",
          },
        ],
      };
    case "connector_auth_method":
      return {
        kind: "choice",
        subject: action.kind,
        prompt: "How should this connector authenticate?",
        options: [
          { id: "none", label: "None (public)" },
          { id: "bearer", label: "Bearer / API token" },
          { id: "basic", label: "Basic auth" },
          { id: "oauth2", label: "OAuth 2" },
          { id: "custom", label: "Custom — describe it" },
        ],
      };
    case "connector_base_url":
      return {
        kind: "text",
        subject: action.kind,
        prompt: "Paste the base URL (or DSN for Postgres, bucket + region for S3).",
      };
    case "connector_environment":
      return {
        kind: "choice",
        subject: action.kind,
        prompt: "Which environment are we testing first?",
        options: [
          { id: "dev", label: "Dev" },
          { id: "prod", label: "Prod" },
        ],
      };
    case "connector_probe":
      return {
        kind: "confirm",
        subject: action.kind,
        prompt: "I have enough to probe this connector safely in dev. Probe it now before saving?",
      };
    case "connector_save":
      return {
        kind: "confirm",
        subject: action.kind,
        prompt: "Probe succeeded. Save this connector draft as a real connector?",
      };
    case "workflow_goal":
      return {
        kind: "text",
        subject: action.kind,
        prompt:
          "What should the workflow do? Include the input that triggers it and the shape of the successful result.",
      };
    case "workflow_preview":
      return {
        kind: "confirm",
        subject: action.kind,
        prompt: "Preview the workflow now so we can verify the output shape before committing?",
      };
    case "workflow_commit":
      return {
        kind: "confirm",
        subject: action.kind,
        prompt: "Preview succeeded. Commit this workflow as a new version?",
      };
    case "resolve_pending_approval":
      return null;
    default:
      return null;
  }
}
