// Tool palette registry.
//
// Every structured-intent tool is a small module with a zod input
// schema and an `execute(ctx, args)` method. The loop looks the tool
// up by name, validates the arguments, runs the tool, and feeds the
// result back to the model.

import type { z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import type { EngineClient } from "../../engine-client/index.ts";
import type { DraftDocument } from "../types.ts";
import {
  askUserChoiceTool,
  askUserConfirmTool,
  askUserFormTool,
  askUserMultiTool,
  askUserTextTool,
} from "./ask-user/index.ts";
import { commitDraftTool } from "./commit-draft.ts";
import { connectStepsTool } from "./connect-steps.ts";
import { dryRunStepTool } from "./dry-run-step.ts";
import { fetchConnectorDocsTool } from "./fetch-connector-docs.ts";
import { listSkillSuggestionsTool } from "./list-skill-suggestions.ts";
import { listSkillsTool } from "./list-skills.ts";
import { proposeConnectorTool } from "./propose-connector.ts";
import { proposeSkillTool } from "./propose-skill.ts";
import { proposeStepTool } from "./propose-step.ts";
import { searchKnowledgeTool } from "./search-knowledge.ts";
import { updateParamTool } from "./update-param.ts";
import { validateDraftTool } from "./validate-draft.ts";

/**
 * Tool execution context handed to every conversation tool. Carries the
 * tenant-scoped EngineClient so `tenant_read` / `tenant_write` tools can
 * introspect and mutate tenant state without reimplementing RBAC/audit.
 */
export interface ToolContext {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  connector_id: string | null;
  workflow_id: string | null;
  engineClient: EngineClient;
  getDraft: () => DraftDocument;
  setDraft: (next: DraftDocument) => Promise<void>;
  /**
   * Optional live-log callback. Long-running tools (run_workflow,
   * dry_run_step, refresh_connector_docs) call this to emit progress
   * updates that surface as `tool_log` TurnEvents, rendered live by sk
   * Ink and streamed via HTTP SSE / MCP notifications. Short tools
   * leave it unused.
   */
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

export interface ToolResult {
  ok: boolean;
  /** Data echoed back to the loop and fed to the model as a tool-result message. */
  data: unknown;
  /** When set, the driver pauses the loop on a pending elicitation. */
  pause?: {
    /** Which `ask_user_*` tool paused the loop. */
    tool_name:
      | "ask_user_choice"
      | "ask_user_multi"
      | "ask_user_text"
      | "ask_user_form"
      | "ask_user_confirm";
    /**
     * Optional `kind` hint for `ask_user_confirm` — lets the client
     * pick the right sub-renderer (structured diff for
     * `commit_draft`, target URL + payload for `external_write`,
     * generic JSON otherwise).
     */
    kind?: "commit_draft" | "external_write" | "generic";
    summary: string;
    /** Row id in `conversation_elicitations`. */
    elicitation_id: string;
    /**
     * Full tool input payload — options/fields/question/diff/target.
     * Surfaced verbatim on the `elicit_request` SSE frame so the CLI
     * has everything needed to render the right prompt without a
     * second fetch.
     */
    input?: unknown;
    /** Structured payload surfaced to the client. */
    diff?: unknown;
    /** Free-form target descriptor (url, workflow path, etc). */
    target?: unknown;
  };
  /** When set, a successful commit bound its new workflow id. */
  committed_workflow_id?: string;
}

/**
 * Tool category — controls parallel-read mutex and surfaces filtering.
 *   - `draft_write`: mutates the conversation's working draft (serialised).
 *   - `tenant_read`: reads tenant state via EngineClient (parallelisable).
 *   - `tenant_write`: mutates tenant state (serialised + confirmation).
 */
export type ToolCategory = "draft_write" | "tenant_read" | "tenant_write";

export interface ConversationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly category: ToolCategory;
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  /** One-sentence hint: when should the LLM reach for this tool? Rendered
   *  into the tool description as a `<use_case>` block so the model can
   *  discriminate it from siblings without exhaustive trial-and-error. */
  readonly use_case?: string;
  /** Bullet list of caveats the LLM should read before invoking — limits,
   *  side effects, failure modes. Rendered as `<important_notes>`. */
  readonly important_notes?: readonly string[];
  /** Slug of a skill that must be loaded before this tool becomes visible.
   *  Advisory mirror of the authoritative `skills.gates_tools` map — used
   *  by the description compiler to tell the model up front what skill to
   *  load. Not enforced by this field alone. */
  readonly requires_skill?: string;
  /** A realistic example argument object. Rendered as `<example>` and
   *  parsed by some clients (MCP) to prefill inputs. */
  readonly example_input?: Readonly<Record<string, unknown>>;
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
register(commitDraftTool);
register(askUserChoiceTool);
register(askUserMultiTool);
register(askUserTextTool);
register(askUserFormTool);
register(askUserConfirmTool);

// load_skill — on-demand skill injection, unlocking gated tools.
import { loadSkillTool } from "./load-skill.ts";

register(loadSkillTool);

// get_raw_result — fetch untruncated payload of a prior tool call.
import { getRawResultTool } from "./get-raw-result.ts";

register(getRawResultTool);

// web_search — Tavily escalation when search_knowledge is empty.
import { webSearchTool } from "./web-search.ts";

register(webSearchTool);

// test_rbac_expression — conversational RBAC probe.
import { testRbacExpressionTool } from "./test-rbac-expression.ts";

register(testRbacExpressionTool);

// Auto-generated read tools covering every §5.10.1 domain:
// workflows, connectors, executions, skills, skill-candidates,
// patch-candidates, knowledge-sources, audit, metrics, identity
// (whoami + users + api-keys + portal-tokens + system-accounts),
// rbac (roles + permissions), hooks, subscriptions, tunnels, status.
import { ALL_GENERATED_READ_TOOLS } from "./generated/index.ts";
import { ALL_GENERATED_WRITE_TOOLS } from "./generated/writes/index.ts";

for (const t of ALL_GENERATED_READ_TOOLS) register(t);
for (const t of ALL_GENERATED_WRITE_TOOLS) register(t);

export function getTool(name: string): ConversationTool | undefined {
  return registry.get(name);
}

export function listTools(): ConversationTool[] {
  return [...registry.values()];
}
