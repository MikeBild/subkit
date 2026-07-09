// MCP `find_tool` catalog meta-tool.
//
// `tools/list` is fitted to a strict token budget (see
// mcp/capabilities/catalog-budget.ts), so the long tail of the callable
// registry — connector probes, transform dry-runs, the inventory reads —
// stays callable via `tools/call` but is no longer advertised. This tool
// is the search-first bridge for that tail: it searches the FULL registry
// for the caller's own MCP mode by keyword and every hit is directly
// callable by name. Each hit carries only { name, category, summary } —
// never a tool's inputSchema — so the meta-tool's own footprint stays
// tiny and the budget problem it solves cannot reappear inside it.
//
// Pure read over tool METADATA the caller can already see: the registry
// filter scopes results to the caller's mode and read-only flag, so it
// widens nothing and leaks no tenant data. No state change — no audit
// row beyond the standard `tool.dispatch.invoke` log (same stance as
// list_recipes).

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import type { ToolDescriptor } from "../../tools/types.ts";
import { zodToJsonSchema7 } from "../json-schema.ts";
import { type McpMode, modeFlags, resolveMcpMode } from "../mode-resolver.ts";

export const FIND_TOOL_TOOL_NAME = "find_tool";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 40;
const SUMMARY_MAX_CHARS = 140;
// A hit in the tool's NAME is a far stronger relevance signal than one in
// its description prose.
const NAME_MATCH_WEIGHT = 4;

const FindToolInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(128)
    .describe("Keywords matched against tool names and descriptions (e.g. `probe connector`)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum matches to return (default ${DEFAULT_LIMIT}).`),
});

export const findToolMcpTool: Tool = {
  name: FIND_TOOL_TOOL_NAME,
  description:
    "Search sk's full callable tool catalog by keyword. `tools/list` is trimmed to a token " +
    "budget, so tools you can call may not be listed — this is how you discover them " +
    "(connector probes, transform dry-runs, inventory reads, and more). Each hit carries " +
    "`name`, `category`, and a one-line `summary`; call any hit directly by name via " +
    "`tools/call` — no separate dispatch step. For workflows use `find_workflow`; for " +
    "connectors use `find_connector`.",
  inputSchema: zodToJsonSchema7(FindToolInputSchema) as Tool["inputSchema"],
};

export interface FindToolCtx {
  readonly principal: ResolvedPrincipal;
  readonly registry: ToolRegistry;
  /** Threaded by the dispatcher on an MCP dispatch; resolved from the
   *  principal's scopes when absent. Never hardcoded. */
  readonly mcpMode?: McpMode;
  readonly readOnly?: boolean;
}

export interface FindToolHit {
  name: string;
  category: string;
  summary: string;
}

export interface FindToolResult {
  query: string;
  total_matches: number;
  note: string;
  tools: FindToolHit[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Exact token match, plus a two-way prefix match (≥3 chars) so
 *  `connector` ↔ `connectors` and `probe` ↔ `probes` pair up without a
 *  stemming dependency. */
function termMatches(term: string, token: string): boolean {
  if (term === token) return true;
  if (term.length >= 3 && token.startsWith(term)) return true;
  if (token.length >= 3 && term.startsWith(token)) return true;
  return false;
}

interface ScoredDescriptor {
  readonly descriptor: ToolDescriptor;
  readonly matchedTerms: number;
  readonly score: number;
}

/** Term-frequency ranking over name + description (BM25-flavored, no
 *  dependency): distinct matched terms dominate, then weighted frequency. */
function scoreDescriptor(d: ToolDescriptor, terms: readonly string[]): ScoredDescriptor | null {
  const nameTokens = tokenize(d.name);
  const descTokens = tokenize(d.description);
  let matchedTerms = 0;
  let score = 0;
  for (const term of terms) {
    let nameHits = 0;
    for (const token of nameTokens) if (termMatches(term, token)) nameHits += 1;
    let descHits = 0;
    for (const token of descTokens) if (termMatches(term, token)) descHits += 1;
    if (nameHits === 0 && descHits === 0) continue;
    matchedTerms += 1;
    score += nameHits * NAME_MATCH_WEIGHT + descHits;
  }
  if (matchedTerms === 0) return null;
  return { descriptor: d, matchedTerms, score };
}

/** First sentence of the description, capped at ~140 chars. */
function summarize(description: string): string {
  const sentenceEnd = description.indexOf(". ");
  const first = (sentenceEnd >= 0 ? description.slice(0, sentenceEnd + 1) : description).trim();
  if (first.length <= SUMMARY_MAX_CHARS) return first;
  return `${first.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

export function handleFindTool(
  ctx: FindToolCtx,
  args: Record<string, unknown>,
): { ok: true; data: FindToolResult } | { ok: false; data: { error: string } } {
  const parsed = FindToolInputSchema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.map(String).join(".")}: ` : "";
    return { ok: false, data: { error: first ? `${where}${first.message}` : "invalid arguments" } };
  }
  const { query } = parsed.data;
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) {
    return { ok: false, data: { error: "query contains no searchable terms" } };
  }
  const mode = ctx.mcpMode ?? resolveMcpMode(ctx.principal);
  // Mirror the tools/call resolution flag (`capabilities/tools.ts`): what this
  // returns is exactly what the caller can dispatch, no more.
  const readOnly = ctx.readOnly ?? !modeFlags(mode, false).showTenantWrites;
  const descriptors = ctx.registry.list({ surface: "mcp", mcpMode: mode, readOnly });
  const scored: ScoredDescriptor[] = [];
  for (const d of descriptors) {
    // Returning the search tool from itself is noise; a disabled descriptor
    // is advertised-but-not-callable, and every hit here must be callable.
    if (d.name === FIND_TOOL_TOOL_NAME || d.disabled) continue;
    const s = scoreDescriptor(d, terms);
    if (s) scored.push(s);
  }
  scored.sort(
    (a, b) =>
      b.matchedTerms - a.matchedTerms ||
      b.score - a.score ||
      (a.descriptor.name < b.descriptor.name ? -1 : a.descriptor.name > b.descriptor.name ? 1 : 0),
  );
  return {
    ok: true,
    data: {
      query,
      total_matches: scored.length,
      note:
        "Call any of these tools directly by name via tools/call — they are callable even when " +
        "they do not appear in tools/list. Workflows are separate: use find_workflow / " +
        "run_workflow(slug).",
      tools: scored.slice(0, limit).map((s) => ({
        name: s.descriptor.name,
        category: s.descriptor.category,
        summary: summarize(s.descriptor.description),
      })),
    },
  };
}
