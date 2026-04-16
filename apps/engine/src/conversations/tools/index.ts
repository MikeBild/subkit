// Tool palette registry.
//
// Every structured-intent tool is a small module with a zod input
// schema and an `execute(ctx, args)` method. The loop looks the tool
// up by name, validates the arguments, runs the tool, and feeds the
// result back to the model.

import type { z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import type { DraftDocument } from "../types.ts";
import { commitDraftTool } from "./commit-draft.ts";
import { connectStepsTool } from "./connect-steps.ts";
import { dryRunStepTool } from "./dry-run-step.ts";
import { fetchConnectorDocsTool } from "./fetch-connector-docs.ts";
import { listSkillSuggestionsTool } from "./list-skill-suggestions.ts";
import { listSkillsTool } from "./list-skills.ts";
import { proposeConnectorTool } from "./propose-connector.ts";
import { proposeSkillTool } from "./propose-skill.ts";
import { proposeStepTool } from "./propose-step.ts";
import { requestHumanApprovalTool } from "./request-human-approval.ts";
import { searchKnowledgeTool } from "./search-knowledge.ts";
import { updateParamTool } from "./update-param.ts";
import { validateDraftTool } from "./validate-draft.ts";

export interface ToolContext {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  connector_id: string | null;
  workflow_id: string | null;
  getDraft: () => DraftDocument;
  setDraft: (next: DraftDocument) => Promise<void>;
}

export interface ToolResult {
  ok: boolean;
  /** Data echoed back to the loop and fed to the model as a tool-result message. */
  data: unknown;
  /** When set, the driver records an approval pause. */
  pause?: {
    kind: "commit_draft" | "external_write" | "other";
    summary: string;
    approval_id: string;
    /** Structured payload surfaced on the `approval_request` frame. */
    diff?: unknown;
    /** Free-form target descriptor (url, workflow path, etc). */
    target?: unknown;
  };
  /** When set, a successful commit bound its new workflow id. */
  committed_workflow_id?: string;
}

export interface ConversationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>;
}

const registry: Map<string, ConversationTool> = new Map();

function register(tool: ConversationTool): void {
  registry.set(tool.name, tool);
}

register(listSkillsTool);
register(fetchConnectorDocsTool);
register(searchKnowledgeTool);
register(listSkillSuggestionsTool);
register(proposeStepTool);
register(proposeConnectorTool);
register(proposeSkillTool);
register(updateParamTool);
register(connectStepsTool);
register(dryRunStepTool);
register(validateDraftTool);
register(requestHumanApprovalTool);
register(commitDraftTool);

export function getTool(name: string): ConversationTool | undefined {
  return registry.get(name);
}

export function listTools(): ConversationTool[] {
  return [...registry.values()];
}
