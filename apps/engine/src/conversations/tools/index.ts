import type { z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import type { EngineClient } from "../../engine-client/index.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import type { DraftDocument } from "../types.ts";
import { analyzeScrapeTargetTool } from "./analyze-scrape-target.ts";
import {
  askUserChoiceTool,
  askUserConfirmTool,
  askUserFormTool,
  askUserMultiTool,
  askUserTextTool,
} from "./ask-user/index.ts";
import { authenticateOAuthTool } from "./authenticate-oauth.ts";
import { authorWorkflowTool } from "./author-workflow.ts";
import { callConnectorTool } from "./call-connector.ts";
import { cannotHelpTool } from "./cannot-help.ts";
import { diagnoseLatestExecutionTool } from "./diagnose-latest-execution.ts";
import { discoverConnectorEndpointsTool } from "./discover-connector-endpoints.ts";
import { discoverSystemsFromFilesTool } from "./discover-systems-from-files.ts";
import { dryRunStepTool } from "./dry-run-step.ts";
import { dryRunTransformTool } from "./dry-run-transform.ts";
import { dryRunWorkflowTool } from "./dry-run-workflow.ts";
import { editRoleTool } from "./edit-role.ts";
import { editWorkflowPatchTool } from "./edit-workflow-patch.ts";
import { fetchConnectorDocsTool } from "./fetch-connector-docs.ts";
import { fetchConnectorSelfDescriptionTool } from "./fetch-connector-self-description.ts";
import { findConnectorTool } from "./find-connector.ts";
import { findRoleTool } from "./find-role.ts";
import { findSkillTool } from "./find-skill.ts";
import { findUserTool } from "./find-user.ts";
import { findWorkflowTool } from "./find-workflow.ts";
import { importConnectorFromSpecTool } from "./import-connector-from-spec.ts";
import { inspectAuthoringContextTool } from "./inspect-authoring-context.ts";
import { inspectConnectorDraftTool } from "./inspect-connector-draft.ts";
import { inspectRecipeTool } from "./inspect-recipe.ts";
import { inspectRoleTool } from "./inspect-role.ts";
import { inspectWorkflowTool } from "./inspect-workflow.ts";
import { inspectWorkflowDraftTool } from "./inspect-workflow-draft.ts";
import { listAttachmentsTool } from "./list-attachments.ts";
import { listCapabilityGapsTool } from "./list-capability-gaps.ts";
import { listSkillSuggestionsTool } from "./list-skill-suggestions.ts";
import { listSkillsTool } from "./list-skills.ts";
import { matchConnectorTemplateByUrlTool } from "./match-connector-template-by-url.ts";
import { openWorkflowDraftTool } from "./open-workflow-draft.ts";
import { previewAttachmentTool } from "./preview-attachment.ts";
import { probeConnectorTool } from "./probe-connector.ts";
import { probeConnectorDraftTool } from "./probe-connector-draft.ts";
import { proposeSchemaMigrationTool } from "./propose-schema-migration.ts";
import { requestConnectorReauthTool } from "./request-connector-reauth.ts";
import { reviewWorkflowAutomationTool } from "./review-workflow-automation.ts";
import { saveConnectorDraftTool } from "./save-connector-draft.ts";
import { saveLearningTool } from "./save-learning.ts";
import { saveWorkflowDraftTool } from "./save-workflow-draft.ts";
import { searchDocsTool } from "./search-docs.ts";
import { startConnectorFromDescriptionTool } from "./start-connector-from-description.ts";
import { startConnectorFromTemplateTool } from "./start-connector-from-template.ts";
import { startWorkflowFromRecipeTool } from "./start-workflow-from-recipe.ts";
import { suggestConnectorTemplatesTool } from "./suggest-connector-templates.ts";
import { suggestJsonataPathsTool } from "./suggest-jsonata-paths.ts";
import { testConnectorTool } from "./test-connector.ts";
import { updateConnectorDraftTool } from "./update-connector-draft.ts";
import { validateConnectorDraftTool } from "./validate-connector-draft.ts";
import { validateDraftTool } from "./validate-draft.ts";

export interface ToolContext {
  direct_connector_approval?: import("../../tools/direct-connector-binding.ts").DirectConnectorApproval;
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: import("../../auth/types.ts").ResolvedPrincipal | null;
  tool_call_id?: string;
  assistant_message_id?: string | null;
  connector_id: string | null;
  workflow_id: string | null;
  engineClient: EngineClient;
  getDraft: () => DraftDocument;
  setDraft: (next: DraftDocument) => Promise<void>;
  abortSignal?: AbortSignal;
  availableToolNames?: ReadonlySet<string>;
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  direct_mcp_invocation?: boolean;
  raw_result_scope_id?: string;
  recentUserMessage?: string | null;
  emitDiff?: (params: {
    title: string;
    language: "json" | "yaml" | "text";
    before: string;
    after: string;
  }) => void;
  elicitationBridge?: ElicitationBridge;
}

export interface ToolResultPause {
  tool_name:
    | "ask_user_choice"
    | "ask_user_multi"
    | "ask_user_text"
    | "ask_user_form"
    | "ask_user_confirm";
  kind?: "save_workflow_draft" | "external_write" | "generic";
  summary: string;
  elicitation_id: string;
  input?: unknown;
  diff?: unknown;
  target?: unknown;
}

export type ToolResult =
  | {
      ok: true;
      data: unknown;
      pause?: ToolResultPause;
      committed_workflow_id?: string;
    }
  | {
      ok: false;
      data?: unknown;
      error_code?: string;
      message?: string;
      details?: unknown;
      next_best_actions?: string[];
      pause?: ToolResultPause;
      committed_workflow_id?: string;
    };

export type ToolCategory = "draft_write" | "tenant_read" | "tenant_write";

export interface ToolEffect {
  connector: string;
  method: string;
  target: string | null;
}

export type ToolPrecheck = { ok: false; result: ToolResult } | { ok: true; effect?: ToolEffect };

export interface ConversationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly category: ToolCategory;
  readonly authoring_resource?: "connector" | "workflow";
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  precheck?(ctx: ToolContext, args: unknown): Promise<ToolPrecheck>;
  readonly use_case?: string;
  readonly important_notes?: readonly string[];
  readonly requires_skill?: string;
  readonly visible_when_readonly?: boolean;
  readonly inert_proposal?: boolean;
  readonly authoring_only?: boolean;
  readonly example_input?: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
  readonly requires_persisted_workflow?: boolean;
  readonly requires_draft?: boolean;
  readonly permission?: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceIdArg?: string;
    readonly resolveResourceId?: (
      ctx: ToolContext,
      rawArgs: Record<string, unknown>,
    ) => Promise<string | null>;
    readonly denyResult?: (permission: string, reason: string) => ToolResult;
  };
}

const registry: Map<string, ConversationTool> = new Map();

import { sealSchema } from "./seal-schema.ts";

function register(tool: ConversationTool): void {
  const sealed: ConversationTool = {
    ...tool,
    inputSchema: sealSchema(tool.inputSchema),
  };
  registry.set(sealed.name, sealed);
}

register(listSkillsTool);
register(fetchConnectorDocsTool);
register(fetchConnectorSelfDescriptionTool);
register(inspectAuthoringContextTool);
register(inspectConnectorDraftTool);
register(inspectWorkflowDraftTool);
register(inspectWorkflowTool);
register(saveLearningTool);
register(searchDocsTool);
register(analyzeScrapeTargetTool);
register(listSkillSuggestionsTool);
register(listCapabilityGapsTool);
register(listAttachmentsTool);
register(previewAttachmentTool);
register(probeConnectorTool);
register(probeConnectorDraftTool);
register(testConnectorTool);
register(callConnectorTool);
register(authorWorkflowTool);
register(saveConnectorDraftTool);
register(authenticateOAuthTool);
register(startConnectorFromDescriptionTool);
register(startConnectorFromTemplateTool);
register(startWorkflowFromRecipeTool);
register(inspectRecipeTool);
register(suggestConnectorTemplatesTool);
register(suggestJsonataPathsTool);
register(findWorkflowTool);
register(findConnectorTool);
register(requestConnectorReauthTool);
register(reviewWorkflowAutomationTool);
register(findSkillTool);
register(findRoleTool);
register(findUserTool);
register(inspectRoleTool);
register(editRoleTool);
register(matchConnectorTemplateByUrlTool);
register(importConnectorFromSpecTool);
register(editWorkflowPatchTool);
register(openWorkflowDraftTool);
register(proposeSchemaMigrationTool);
register(updateConnectorDraftTool);
register(diagnoseLatestExecutionTool);
register(discoverConnectorEndpointsTool);
register(discoverSystemsFromFilesTool);
register(dryRunStepTool);
register(dryRunTransformTool);
register(dryRunWorkflowTool);
register(validateDraftTool);
register(validateConnectorDraftTool);
register(saveWorkflowDraftTool);
register(askUserChoiceTool);
register(askUserMultiTool);
register(askUserTextTool);
register(askUserFormTool);
register(askUserConfirmTool);
register(cannotHelpTool);

import { loadSkillTool } from "./load-skill.ts";

register(loadSkillTool);

import { getRawResultTool } from "./get-raw-result.ts";

register(getRawResultTool);

import { inspectExecutionStepTool } from "./inspect-execution-step.ts";

register(inspectExecutionStepTool);

import { inspectExecutionTool } from "./inspect-execution.ts";

register(inspectExecutionTool);

import { testRbacExpressionTool } from "./test-rbac-expression.ts";

register(testRbacExpressionTool);

import { getVendorRecipeTool } from "./get-vendor-recipe.ts";

register(getVendorRecipeTool);

import { listDraftSnapshotsTool } from "./list-draft-snapshots.ts";
import { restoreDraftSnapshotTool } from "./restore-draft-snapshot.ts";
import { restoreWorkflowVersionTool } from "./restore-workflow-version.ts";

register(listDraftSnapshotsTool);
register(restoreDraftSnapshotTool);
register(restoreWorkflowVersionTool);

import { ALL_ENGINE_API_READ_TOOLS } from "./engine-api/index.ts";
import { ALL_ENGINE_API_WRITE_TOOLS } from "./engine-api/writes/index.ts";

for (const t of ALL_ENGINE_API_READ_TOOLS) register(t);
for (const t of ALL_ENGINE_API_WRITE_TOOLS) register(t);

export function getTool(name: string): ConversationTool | undefined {
  return registry.get(name);
}

export function listTools(): ConversationTool[] {
  return [...registry.values()];
}

import { diagnoseWorkflowTool, proposeWorkflowRepairTool } from "./gate-repair.ts";

register(diagnoseWorkflowTool);
register(proposeWorkflowRepairTool);
