// Authoring context block — rendered into the volatile cache segment of
// the system prompt. Gives the model a structured, up-to-date view of the
// current conversation's draft state so it can decide next actions without
// replaying every prior tool result. Secrets are masked by an allowlist of
// renderable fields — credential payloads, tokens, DSNs, and arbitrary
// config blobs never reach the rendered text.

import {
  nextQuestion as computeNextQuestion,
  nextRecommendedAction,
} from "../../conversations/onboarding-policy.ts";
import type { ConversationResumeSummary, DraftDocument } from "../../conversations/types.ts";

export interface AuthoringContextInput {
  draft: DraftDocument | null | undefined;
  resume_summary?: ConversationResumeSummary | null;
  pending_approval?: {
    tool_name: string;
    summary: string | null;
  } | null;
}

export function renderAuthoringContextBlock(input: AuthoringContextInput): string | null {
  const { draft } = input;
  if (!draft && !input.resume_summary) return null;

  const lines: string[] = [];
  lines.push("## Current authoring state");

  if (draft) {
    const mode = draft.mode ?? "onboarding";
    lines.push(...renderModeEnvelope(mode, draft));
  }

  if (input.pending_approval) {
    lines.push(
      `- Pending approval: ${input.pending_approval.tool_name}${
        input.pending_approval.summary ? ` — ${input.pending_approval.summary}` : ""
      }`,
    );
  }

  if (input.resume_summary) {
    lines.push("");
    lines.push(`## Resume`);
    lines.push(`- ${input.resume_summary.one_sentence}`);
    if (input.resume_summary.last_successful_probe) {
      lines.push(`- Last successful probe: ${input.resume_summary.last_successful_probe}`);
    }
    if (input.resume_summary.last_successful_preview) {
      lines.push(`- Last successful preview: ${input.resume_summary.last_successful_preview}`);
    }
    lines.push(`- Next best step: ${input.resume_summary.next_action}`);
  }

  const action = nextRecommendedAction({
    draft: input.draft ?? null,
    ...(input.pending_approval ? { pending_approval: input.pending_approval } : {}),
  });
  lines.push("");
  lines.push(`## Guided next step`);
  lines.push(`- Action: ${action.summary}`);
  lines.push(`- Why: ${action.rationale}`);
  const question = computeNextQuestion({
    draft: input.draft ?? null,
    ...(input.pending_approval ? { pending_approval: input.pending_approval } : {}),
  });
  if (question) {
    lines.push(`- Suggested question (${question.kind}): ${question.prompt}`);
    if (question.options && question.options.length > 0) {
      for (const opt of question.options) {
        lines.push(`  - ${opt.label}${opt.detail ? ` — ${opt.detail}` : ""}`);
      }
    }
  }

  return lines.join("\n");
}

function renderModeEnvelope(
  mode: NonNullable<DraftDocument["mode"]> | "onboarding",
  draft: DraftDocument,
): string[] {
  const lines: string[] = [`- Mode: ${mode}`];
  if (draft.summary) {
    lines.push(`- Readiness: ${draft.summary.readiness}`);
    if (draft.summary.next_action) {
      lines.push(`- Next recommended action: ${draft.summary.next_action}`);
    }
    if (draft.summary.missing_fields.length > 0) {
      lines.push(`- Missing: ${draft.summary.missing_fields.join(", ")}`);
    }
  }

  if (mode === "connector_authoring") {
    lines.push(...renderConnectorLines(draft));
    return lines;
  }
  if (mode === "workflow_authoring") {
    lines.push(...renderWorkflowLines(draft));
    return lines;
  }
  if (mode === "resume_review") {
    lines.push(...renderConnectorLines(draft));
    lines.push(...renderWorkflowLines(draft));
    return lines;
  }
  lines.push(...renderConnectorLines(draft));
  lines.push(...renderWorkflowLines(draft));
  return lines;
}

function renderConnectorLines(draft: DraftDocument): string[] {
  const connector = draft.connector;
  if (!connector) return ["- Connector draft: (none)"];
  const bits: string[] = [];
  if (connector.name) bits.push(`name="${connector.name}"`);
  if (connector.slug) bits.push(`slug=${connector.slug}`);
  if (connector.driver) bits.push(`driver=${connector.driver}`);
  if (connector.environment) bits.push(`env=${connector.environment}`);
  if (connector.auth_type) bits.push(`auth=${connector.auth_type}`);
  if (connector.base_url) bits.push(`base_url=${connector.base_url}`);
  if (typeof connector.saved_connector_id === "string") {
    bits.push(`saved_id=${connector.saved_connector_id}`);
  }
  const lines = [`- Connector draft: ${bits.length > 0 ? bits.join(" ") : "(empty)"}`];
  if (
    connector.validation &&
    !connector.validation.ok &&
    connector.validation.missing_fields.length > 0
  ) {
    lines.push(`  - Missing connector fields: ${connector.validation.missing_fields.join(", ")}`);
  }
  if (connector.latest_probe) {
    const probe = connector.latest_probe;
    lines.push(
      `  - Latest probe: ${probe.ok ? "ok" : "failed"}${
        probe.status_code !== undefined ? ` (HTTP ${probe.status_code})` : ""
      } — ${probe.summary}`,
    );
  }
  return lines;
}

function renderWorkflowLines(draft: DraftDocument): string[] {
  const workflow = draft.workflow;
  const workflowSteps = workflow.steps.length;
  if (workflowSteps === 0) {
    return ['- Workflow draft: "(empty)" with 0 steps'];
  }
  const lines = [
    `- Workflow draft: "${workflow.name}"${workflow.slug ? ` (${workflow.slug})` : ""} with ${workflowSteps} step${
      workflowSteps === 1 ? "" : "s"
    }`,
  ];
  for (const raw of workflow.steps.slice(0, 6)) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id : "(no id)";
    const kind = typeof step.kind === "string" ? step.kind : "(no kind)";
    lines.push(`  - ${id}: ${kind}`);
  }
  if (workflowSteps > 6) {
    lines.push(`  - …and ${workflowSteps - 6} more`);
  }
  if (draft.latest_preview) {
    const preview = draft.latest_preview;
    lines.push(
      `- Latest preview: ${preview.ok ? "ok" : "failed"}${preview.step_id ? ` (step=${preview.step_id})` : ""} — ${preview.summary}`,
    );
  }
  return lines;
}
