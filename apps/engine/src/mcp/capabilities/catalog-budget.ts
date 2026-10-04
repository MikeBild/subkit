import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { listToolsViaRegistry } from "../adapter.ts";
import { type McpMode, modeFlags } from "../mode-resolver.ts";
import { listConversationTools } from "./conversations.ts";

export const TOOL_PREFIX = "wf_";

export function workflowToolName(slug: string): string {
  return `${TOOL_PREFIX}${slug}`;
}

export const RUN_WORKFLOW_TOOL = "run_workflow";
export const DEFAULT_PALETTE_LIMIT = 40;

export interface AssembleCatalogParams {
  principal: ResolvedPrincipal;
  readOnly: boolean;
  mode: McpMode;
  fullPalette: Tool[];
}

export function assembleCatalog(p: AssembleCatalogParams): Tool[] {
  const flags = modeFlags(p.mode, p.readOnly);
  const tools: Tool[] = [];
  if (flags.showConversationTools) tools.push(...listConversationTools());
  tools.push(
    ...listToolsViaRegistry({
      principal: p.principal,
      mcpMode: p.mode,
      readOnly: !flags.showTenantWrites,
    }),
  );
  tools.push(...p.fullPalette.slice(0, DEFAULT_PALETTE_LIMIT));
  return tools;
}
