// MCP catalog assembly + token-budget fitting.
//
// The MCP `tools/list` manifest must fit the token budget strict clients
// (e.g. ChatGPT) enforce, or they silently drop tools. This module assembles
// the catalog per mode and shrinks it toward the budget with non-destructive,
// search-first levers — it never drops a named tool or steps the mode, and it
// orders the result essentials-first so a client that truncates keeps the core.
// See fitCatalogToBudget for the full contract.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { listToolsViaRegistry } from "../adapter.ts";
import { MCP_CORE_TOOL_NAMES, type McpMode, modeFlags } from "../mode-resolver.ts";
import { listConversationTools } from "./conversations.ts";

export const TOOL_PREFIX = "wf_";
// Conservative budget for the COMBINED tools/list schema. Strict MCP clients
// cap total tool-schema size and silently drop tools past it (a real one we
// measured degrades around this point, surfacing a frontend storage-quota
// error). General, not tuned to any one vendor.
export const SCHEMA_TOKEN_BUDGET = 5000;
// ~4 chars/token is the standard rough estimate for English/JSON.
const CHARS_PER_TOKEN_EST = 4;
// Default size of the per-workflow `wf_` palette; matches the converse cap.
export const DEFAULT_PALETTE_LIMIT = 40;
// Floor the budget-fit cascade trims the palette to before falling back to
// schema compression. The trimmed-out workflows stay reachable via
// `find_workflow` / `run_workflow(slug)` (search-first), so this is a
// preloading bound, not a functional limit.
const MIN_PALETTE_LIMIT = 10;
// Prose caps applied only when the budget-fit cascade enables compression.
const MAX_TOOL_DESC_CHARS = 220;
const MAX_SCHEMA_DESC_CHARS = 80;
// Tool whose early position matters when a strict client truncates the
// manifest: it anchors the search-first authoring entry point right after the
// core + workflow palette.
const CONVERSATION_START_TOOL_NAME = "conversation_start";

/**
 * Fallback responder tool for MCP clients that do NOT advertise the
 * `elicitation` capability. A `confirm_before_execution` gate returns a
 * `_meta.subkit.confirm` envelope to such clients; the model then approves
 * the paused call by invoking this tool with the original `tool`,
 * `arguments`, and `confirm_id` (the envelope's `tool_call_id`).
 *
 * Reality check (verified via runtime logs + client capability research):
 * the hosted flagship clients do NOT advertise `elicitation`, so they DO see
 * this tool and confirm through it (model-driven, gated by the dispatcher's
 * APPROVAL_REQUESTED check). The in-band `elicitation/create` path is
 * reserved for clients that advertise the elicitation capability, which then
 * never see this tool.
 */
export const CONFIRM_TOOL_CALL_NAME = "confirm_tool_call";
export const CONFIRM_TOOL_CALL_TOOL: Tool = {
  name: CONFIRM_TOOL_CALL_NAME,
  description:
    "Approve a tool call that paused for confirmation (status:needs_confirm). Re-runs the " +
    "named tool with the operator's approval. Pass the same `tool` and `arguments` from the " +
    "confirm envelope and set `confirm_id` to its `tool_call_id`.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Name of the paused tool to approve and run." },
      arguments: {
        type: "object",
        description: "The original arguments from the confirm envelope.",
      },
      confirm_id: {
        type: "string",
        description: "The `tool_call_id` from the confirm envelope (joins the approval audit).",
      },
    },
    required: ["tool", "confirm_id"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/** Estimate the combined tools/list schema token cost (~4 chars/token). */
export function estimateCatalogTokens(tools: Tool[]): number {
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN_EST);
}

/** Recursively trim prose-only fields from a JSON schema without touching any
 *  structural key (`type`, `required`, `properties`, `items`, `enum`, …). Only
 *  `description` strings are capped and `examples`/`$comment` (pure prose,
 *  ignored by validators) are dropped — so a compressed schema still validates
 *  every input the original did. */
function compressSchemaProse(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compressSchemaProse);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "examples" || key === "$comment") continue;
    if (key === "description" && typeof value === "string") {
      out[key] =
        value.length > MAX_SCHEMA_DESC_CHARS
          ? `${value.slice(0, MAX_SCHEMA_DESC_CHARS - 1).trimEnd()}…`
          : value;
      continue;
    }
    out[key] = compressSchemaProse(value);
  }
  return out;
}

/** Shrink a tool's token footprint by trimming prose only — its callable
 *  contract (name, inputSchema structure, required fields) is unchanged. */
export function compressToolSchema(tool: Tool): Tool {
  const description =
    tool.description && tool.description.length > MAX_TOOL_DESC_CHARS
      ? `${tool.description.slice(0, MAX_TOOL_DESC_CHARS - 1).trimEnd()}…`
      : tool.description;
  return {
    ...tool,
    ...(description !== undefined ? { description } : {}),
    inputSchema: compressSchemaProse(tool.inputSchema) as Tool["inputSchema"],
  };
}

export interface AssembleTierParams {
  principal: ResolvedPrincipal;
  readOnly: boolean;
  mode: McpMode;
  paletteLimit: number;
  compress: boolean;
  elicitationCapable: boolean;
  /** Full `wf_` palette, fetched once; sliced to `paletteLimit` per tier. */
  fullPalette: Tool[];
}

/** Essentials-first priority. Strict clients that silently drop tools tend to
 *  truncate the tail of the manifest, so we lead with what every client needs:
 *  the search-first core, then the workflow palette, then the authoring entry
 *  point, then everything else. A stable sort preserves intra-bucket order. */
function essentialsRank(tool: Tool): number {
  if (MCP_CORE_TOOL_NAMES.has(tool.name)) return 0;
  if (tool.name.startsWith(TOOL_PREFIX)) return 1;
  if (tool.name === CONVERSATION_START_TOOL_NAME) return 2;
  return 3;
}

function orderEssentialsFirst(tools: Tool[]): Tool[] {
  return tools
    .map((tool, i) => ({ tool, i }))
    .sort((a, b) => essentialsRank(a.tool) - essentialsRank(b.tool) || a.i - b.i)
    .map((e) => e.tool);
}

/** Assemble one catalog tier (in-memory; no DB). The `wf_` palette is sliced
 *  from the pre-fetched full list, the registry + conversation tools follow the
 *  mode, and `confirm_tool_call` is appended for non-elicitation clients so it
 *  is always part of the measured floor. The result is ordered essentials-first
 *  so a strict client that truncates keeps the tools that matter. */
export function assembleTier(p: AssembleTierParams): Tool[] {
  const flags = modeFlags(p.mode, p.readOnly);
  const tools: Tool[] = [];
  tools.push(...p.fullPalette.slice(0, p.paletteLimit));
  tools.push(
    ...listToolsViaRegistry({
      principal: p.principal,
      mcpMode: p.mode,
      readOnly: !flags.showTenantWrites,
    }),
  );
  if (flags.showConversationTools) tools.push(...listConversationTools());
  if (!p.elicitationCapable) tools.push(CONFIRM_TOOL_CALL_TOOL);
  const compressed = p.compress ? tools.map(compressToolSchema) : tools;
  return orderEssentialsFirst(compressed);
}

export interface CatalogFitResult {
  tools: Tool[];
  estTokensBefore: number;
  estTokensAfter: number;
  mode: McpMode;
  paletteLimit: number;
  compressed: boolean;
}

/** Shrink the catalog toward the schema-token budget without ever dropping a
 *  named tool or stepping the mode — one general path for every client/mode.
 *
 *  Non-destructive levers, in order: shrink the `wf_` palette to its Top-N (the
 *  trimmed workflows stay reachable via find_workflow / run_workflow(slug)),
 *  then compress schema prose. We never drop a named tool (that would break
 *  list/resolve parity and the authoring surface), so a rich authoring/admin
 *  catalog can legitimately stay above the budget — capable clients (claude.ai,
 *  sk-cli) handle it, and assembleTier orders the result essentials-first so a
 *  strict client that truncates still keeps the core + palette + authoring
 *  entry point. The product surface fits under the budget outright. */
export function fitCatalogToBudget(
  base: Omit<AssembleTierParams, "mode" | "paletteLimit" | "compress"> & { initialMode: McpMode },
): CatalogFitResult {
  const mode = base.initialMode;
  let paletteLimit = DEFAULT_PALETTE_LIMIT;
  let compress = false;
  let tools = assembleTier({ ...base, mode, paletteLimit, compress });
  const estTokensBefore = estimateCatalogTokens(tools);
  let est = estTokensBefore;
  while (est > SCHEMA_TOKEN_BUDGET) {
    if (paletteLimit > MIN_PALETTE_LIMIT) paletteLimit = MIN_PALETTE_LIMIT;
    else if (!compress) compress = true;
    else break; // non-destructive levers exhausted — keep every named tool
    tools = assembleTier({ ...base, mode, paletteLimit, compress });
    est = estimateCatalogTokens(tools);
  }
  return { tools, estTokensBefore, estTokensAfter: est, mode, paletteLimit, compressed: compress };
}
