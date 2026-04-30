// Agent system-prompt generator — composes the literal persona + the
// preloaded skill bodies + per-surface verbosity + per-turn authoring
// focus block into a single system message. The conversation loop
// passes the result straight to the LLM.
//
// Live-data injection (TENANT SNAPSHOT, RUNTIME CONTEXT, included
// docs/knowledge, user memory, prior failures) still lives in
// `context-assembler.ts`; this module owns only the structural
// behaviour body, which is identical across turns for a given agent.

import type { AuthoringPromptHint } from "../../llm/types.ts";
import type { AuthoringSurfaceMode } from "../types.ts";
import {
  AUTHORING_PERSONA,
  CLI_HEADLESS_PERSONA,
  DIAGNOSIS_PERSONA,
  EXECUTION_PERSONA,
  GENERAL_RULES,
  RBAC_EDITING_PERSONA,
  SKILL_LOADING_INSTRUCTIONS,
  verbosityFor,
} from "./prompts.ts";
import { loadAgentSkills, resolveAgentSkillsForMode } from "./skills/index.ts";
import type { AgentSystemPromptInput, AgentSystemPromptResult } from "./types.ts";

/**
 * Pick the persona variant for the current turn. Headless surface wins
 * over mode (the user is parsing output programmatically, regardless
 * of what authoring stage we're in). Otherwise the authoring mode
 * decides: workflow/connector → AUTHORING, execution → EXECUTION,
 * diagnosis → DIAGNOSIS. Default falls back to AUTHORING (the historical
 * shape — no behaviour change for chats without a mode hint).
 */
function personaFor(
  surface: AgentSystemPromptInput["surface"],
  mode: AuthoringSurfaceMode | null | undefined,
  scope?: "rbac" | undefined,
): string {
  // RBAC sub-mode wins over the primary mode — when the operator is
  // editing a role policy the persona must emphasise propose-don't-
  // apply and the test_rbac_expression preview loop, regardless of
  // whether the conversation is otherwise in workflow / connector
  // / execution mode.
  if (scope === "rbac") return RBAC_EDITING_PERSONA;
  if (surface === "sk_headless") return CLI_HEADLESS_PERSONA;
  switch (mode) {
    case "execution":
      return EXECUTION_PERSONA;
    case "diagnosis":
      return DIAGNOSIS_PERSONA;
    default:
      return AUTHORING_PERSONA;
  }
}

function summarizeCheckpoints(hint: AuthoringPromptHint, keys: string[]): string {
  const parts = keys.map((key) => {
    const checkpoint = hint.checkpoints.find((item) => item.key === key);
    return `${key}=${checkpoint?.status ?? "missing"}`;
  });
  return `- Relevant checkpoints: ${parts.join(", ")}`;
}

function summarizeBlockedBy(hint: AuthoringPromptHint): string {
  if (hint.blocked_by.length === 0) return "- Current blockers: none.";
  return `- Current blockers: ${hint.blocked_by.join(", ")}`;
}

function summarizeNextRequiredAction(hint: AuthoringPromptHint): string {
  if (!hint.next_required_action) return "- Next required action: continue the conversation.";
  return `- Next required action: ${hint.next_required_action}`;
}

function summarizeNextSuggestedTool(hint: AuthoringPromptHint): string {
  if (!hint.next_suggested_tool) return "- Next suggested tool: none.";
  return `- Next suggested tool: ${hint.next_suggested_tool}`;
}

function connectorFocusPrompt(hint: AuthoringPromptHint): string {
  return [
    "AUTHORING FOCUS: CONNECTOR",
    "- Stay in connector authoring until the connector is persisted.",
    "- Do not start workflow drafting while the active target is a draft-only connector.",
    "- Treat inspect -> validate -> probe -> save as the only valid connector progression.",
    "- Hide premature save behaviour from yourself: if inspection, validation, or probing is stale or missing, repair that checkpoint instead of narrating around it.",
    `Current connector stage: ${hint.stage}.`,
    summarizeCheckpoints(hint, [
      "connector_inspected",
      "connector_validated",
      "connector_probed",
      "connector_persisted",
    ]),
    summarizeBlockedBy(hint),
    summarizeNextRequiredAction(hint),
    summarizeNextSuggestedTool(hint),
  ].join("\n");
}

function workflowFocusPrompt(hint: AuthoringPromptHint): string {
  return [
    "AUTHORING FOCUS: WORKFLOW",
    "- Stay in workflow authoring until the workflow is persisted.",
    "- Treat inspect -> validate -> preview -> commit as the only valid workflow progression.",
    "- Do not run a draft-only workflow. Commit first, then run the persisted version.",
    "- Use dry_run_transform only against real captured JSON from dry_run_step, dry_run_workflow, or inspect_authoring_context.",
    `Current workflow stage: ${hint.stage}.`,
    summarizeCheckpoints(hint, [
      "workflow_inspected",
      "workflow_validated",
      "workflow_previewed",
      "workflow_persisted",
    ]),
    summarizeBlockedBy(hint),
    summarizeNextRequiredAction(hint),
    summarizeNextSuggestedTool(hint),
  ].join("\n");
}

function executionFocusPrompt(hint: AuthoringPromptHint): string {
  const diagnosisLine =
    hint.latest_execution?.diagnosis_available === true
      ? "- Diagnosis is available for the latest execution. Prefer diagnose_latest_execution before making blind workflow edits."
      : "- No diagnosis gate is currently pending. Ground any next edit in the latest execution result.";
  return [
    "AUTHORING FOCUS: EXECUTION",
    "- The workflow is already persisted. Treat runs as verification of the saved version, not as draft previews.",
    "- Prefer inspecting the latest execution outcome before deciding whether to re-run or edit the workflow.",
    diagnosisLine,
    `Current execution stage: ${hint.stage}.`,
    summarizeBlockedBy(hint),
    summarizeNextRequiredAction(hint),
    summarizeNextSuggestedTool(hint),
  ].join("\n");
}

function diagnosisFocusPrompt(hint: AuthoringPromptHint): string {
  const reasonLine = hint.latest_diagnosis
    ? `- Latest diagnosis reason: ${hint.latest_diagnosis.reason}`
    : "- Diagnosis mode is active because the latest execution requires repair.";
  return [
    "AUTHORING FOCUS: DIAGNOSIS",
    "- Diagnose first, then edit the workflow, preview it again, commit the repaired version, and only then run it.",
    "- Keep the latest diagnosis as the source of truth for what to repair. Do not discard it in favour of generic guesses.",
    "- Do not re-run the same persisted workflow while diagnosis is still the active mode.",
    reasonLine,
    `Current diagnosis stage: ${hint.stage}.`,
    summarizeBlockedBy(hint),
    summarizeNextRequiredAction(hint),
    summarizeNextSuggestedTool(hint),
  ].join("\n");
}

function authoringFocusPrompt(hint?: AuthoringPromptHint): string {
  if (!hint) return "";
  switch (hint.mode) {
    case "connector":
      return connectorFocusPrompt(hint);
    case "workflow":
      return workflowFocusPrompt(hint);
    case "execution":
      return executionFocusPrompt(hint);
    case "diagnosis":
      return diagnosisFocusPrompt(hint);
    default:
      return "";
  }
}

/**
 * Compose the MAIN agent's system prompt: persona + general rules +
 * skill-loading directive + verbosity + authoring focus + every
 * preloaded behaviour skill body.
 */
export async function generateMainAgentSystemPrompt(
  input: AgentSystemPromptInput,
): Promise<AgentSystemPromptResult> {
  const mode = input.authoring_hint?.mode ?? null;
  const scope = input.authoring_hint?.scope;
  const sections: string[] = [
    personaFor(input.surface, mode, scope),
    GENERAL_RULES,
    SKILL_LOADING_INSTRUCTIONS,
    `VERBOSITY:\n- ${verbosityFor(input.surface)}`,
  ];
  const focusBlock = authoringFocusPrompt(input.authoring_hint);
  if (focusBlock) sections.push(focusBlock);
  // Mode-aware behaviour skill loading: always-load core + the
  // mode-specific bodies for the current authoring mode (workflow /
  // connector / execution / diagnosis). conversational-authoring is
  // the only body large enough to be worth gating; everything else
  // is universal.
  sections.push(loadAgentSkills(resolveAgentSkillsForMode(mode)));
  return { content: sections.join("\n\n") };
}
