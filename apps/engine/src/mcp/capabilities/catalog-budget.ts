// MCP catalog assembly + token-budget fitting.
//
// The MCP `tools/list` manifest must fit the token budget strict clients
// enforce, or they silently drop the tail of it. This module assembles the
// catalog per mode — product and authoring publish a bounded, explicit set of
// named tools, admin publishes the full inventory — and then shrinks the result
// toward the budget with non-destructive levers. Deciding server-side WHICH
// tools ship beats letting a client truncate whichever ones landed last.
// See authoringPublishedTools and fitCatalogToBudget for the contract; the mode
// hierarchy is monotone — authoring publishes everything product publishes.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { logger } from "../../logging/logger.ts";
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
// Size the budget-fit cascade trims the palette to before falling back to
// schema compression. The trimmed-out workflows stay reachable via
// `find_workflow` / `run_workflow(slug)` (search-first), so this is a
// preloading bound, not a functional limit.
const MIN_PALETTE_LIMIT = 10;
// Step for the LAST lever: once compression has fired and the catalog is still
// over budget, keep giving back preloading depth. The palette is the only part
// of the manifest with a complete fallback, so it yields before any named tool
// does. The lever only engages when surrendering the WHOLE palette would fit
// the budget — see `fitCatalogToBudget`.
const PALETTE_TRIM_STEP = 2;
// Prose caps applied only when the budget-fit cascade enables compression.
const MAX_TOOL_DESC_CHARS = 220;
const MAX_SCHEMA_DESC_CHARS = 80;

/** The authoring SESSION cluster, exactly as `listConversationTools` publishes
 *  it (`capabilities/conversations.ts`). `conversation_start` opens a session;
 *  the other four are the only way to drive one to a commit — poll it, answer
 *  its elicitations, and read back what was persisted.
 *
 *  They share one essentials rank on purpose. A client that truncates the
 *  manifest tail must never keep the entry point while losing the continuation:
 *  that leaves it able to START a session it can never finish, which is exactly
 *  the failure a strict client reported. Entry point and continuation ship
 *  together or not at all. `suggest_related_conversations` is advisory, not
 *  load-bearing, so it stays in the tail. */
const AUTHORING_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "conversation_start",
  "conversation_append",
  "conversation_get",
  "conversation_respond_elicitation",
  "conversation_commit",
]);

/** Read tools published to an EXTERNAL MCP client in authoring mode, on top of
 *  the search-first core. Each earns its slot:
 *
 *  - `get_workflow`      — fetch a workflow by exact id after `find_workflow`
 *                          matched it. (`inspect_workflow` is deliberately
 *                          absent: it reads the CONVERSATION DRAFT, which a
 *                          stateless MCP call does not have.)
 *  - `get_execution`     — a `wf_<slug>` / `run_workflow` call that outruns the
 *                          inline window hands back an `execution_id` polling
 *                          handle (`capabilities/tools.ts`). Without this tool
 *                          that handle is unresolvable.
 *  - `inspect_execution` — step-level diagnosis of a finished run. The chat
 *                          loop's `diagnose_latest_execution` is `draft_write`
 *                          and unreachable here; this is its MCP sibling.
 *  - `find_connector`    — "do we have a Stripe connector?" before authoring.
 *  - `get_connector`     — read one by id, including its re-auth health, so the
 *                          client can route the user to `authenticate`.
 *  - `get_engine_status` — the designated low-sensitivity self-status surface.
 *  - `whoami`            — the caller's own identity and rights; ungated
 *                          self-introspection, so it can never mislead.
 *  - `search_docs`       — grounds answers about the engine in shipped docs
 *                          instead of the model's priors.
 *
 *  Everything else the registry exposes in authoring mode — `call_connector`,
 *  `dry_run_transform`, `suggest_jsonata_paths`, `probe_connector`, the rest of
 *  the inventory reads — is driven by the ENGINE'S OWN conversation loop, not by
 *  an external client, and stays fully reachable through `conversation_start`.
 *  Omitting them from `tools/list` does not remove them: `tools/call` still
 *  resolves them through the unified dispatcher, and `find_tool` (core floor,
 *  mode-resolver.ts) keeps them DISCOVERABLE — a client searches the full
 *  registry by keyword and calls any hit directly by name. */
const AUTHORING_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_workflow",
  "get_execution",
  "inspect_execution",
  "find_connector",
  "get_connector",
  "get_engine_status",
  "whoami",
  "search_docs",
]);

/** Registry tools published in `authoring` mode ON TOP OF everything product
 *  mode publishes. Admin keeps the full inventory. Together with the six
 *  `conversation_*` session tools, the appended `confirm_tool_call`, and the
 *  `wf_` palette this lands at ~24 named tools — a catalog `fitCatalogToBudget`
 *  can actually fit, rather than one whose `over_budget` flag was true by
 *  construction.
 *
 *  This is an ADDITIVE set, not the whole authoring allow-list: `assembleTier`
 *  unions it with the tools the registry publishes in `product` mode. Naming
 *  the product tools a second time here would let the two lists drift, and the
 *  drift already happened once — authoring shipped `list_recipes` without
 *  `inspect_recipe` to read a recipe, while a product client on the same engine
 *  held both. A mode above product must never see less than product. */
const AUTHORING_EXTRA_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MCP_CORE_TOOL_NAMES,
  ...AUTHORING_READ_TOOL_NAMES,
]);

/** The registry tools `product` mode publishes, read from the registry itself
 *  rather than copied from `tools/providers/conversation.ts` — the allow-list
 *  there is one of several providers (the static provider contributes
 *  `authenticate` / `list_recipes`), so only the assembled list is authoritative.
 *  `modeFlags("product", …).showTenantWrites` is always false, hence the fixed
 *  `readOnly: true`. */
function productPublishedToolNames(principal: ResolvedPrincipal): ReadonlySet<string> {
  return new Set(
    listToolsViaRegistry({ principal, mcpMode: "product", readOnly: true }).map((t) => t.name),
  );
}

/** Authoring's published registry tools: everything product publishes, plus the
 *  authoring extras. Superset by construction. The residual way to invert it is
 *  for the REGISTRY to hide from `authoring` something it shows to `product`
 *  (a per-mode visibility predicate no filter here can undo) — so that case is
 *  reported rather than silently shipped. */
function authoringPublishedTools(registryTools: Tool[], productNames: ReadonlySet<string>): Tool[] {
  const published = registryTools.filter(
    (t) => AUTHORING_EXTRA_TOOL_NAMES.has(t.name) || productNames.has(t.name),
  );
  const publishedNames = new Set(published.map((t) => t.name));
  const missing = [...productNames].filter((n) => !publishedNames.has(n));
  if (missing.length > 0) {
    logger.error({
      module: "mcp",
      action: "mcp.catalog.mode_hierarchy_inverted",
      msg: "authoring catalog is missing tools the product catalog publishes",
      missing,
    });
  }
  return published;
}

/**
 * Guaranteed approval TRIGGER, present in every client's catalog. A
 * `confirm_before_execution` gate returns a `_meta.subkit.confirm` envelope —
 * and a `wf_<slug>` run that held its writes returns the equivalent
 * `confirm_id` inside its preview envelope. Either way the approval is minted
 * UNGRANTED. A HUMAN grants it out of band at the envelope's `approval_url`;
 * only then does this tool claim the single-use handle and perform the call,
 * replaying the args the engine persisted when it paused.
 *
 * It approves nothing, so it needs no capability-based refusal: every client may
 * call it, and an ungranted approval answers `approval_not_granted`.
 *
 * The approval is a capability handle, not a re-transmission challenge, so the
 * published schema carries NO `arguments` property: there is nothing for the
 * model to echo (and nothing for it to swap). A ~50 KB payload is as
 * approvable as a one-liner.
 *
 * In-band elicitation (`capabilities/tools.ts`) is an OPTIMIZATION over that
 * round-trip, never a replacement. A client whose operator ACCEPTS the in-band
 * prompt never sees a `confirm_id` — the call already ran. A client that
 * advertises the capability and then never answers the prompt DOES get the
 * envelope: advertising is not fulfilment, and a paused call must keep a
 * reachable approval path or the gate is one no caller can satisfy.
 *
 * The annotations describe what happens after the human says yes. This tool is
 * the sole executor of every approved call — `delete_*` included, and live
 * `wf_<slug>` runs that reach external systems. Asserting `destructiveHint:false`
 * would let a strict client file it under "always allow", the same defect
 * `buildToolAnnotations` refuses for every other write.
 */
export const CONFIRM_TOOL_CALL_NAME = "confirm_tool_call";
export const CONFIRM_TOOL_CALL_TOOL: Tool = {
  name: CONFIRM_TOOL_CALL_NAME,
  title: "Confirm tool call",
  description:
    "Perform a paused tool call a person has ALREADY approved — a `status:needs_confirm` " +
    "envelope, or a `wf_<slug>` run that came back `preview:true` with its writes held. This " +
    "cannot approve anything: a human grants the approval out of band at the envelope's " +
    "`approval_url`, and until they do this answers `approval_not_granted`. Set `confirm_id` to " +
    "the envelope's `tool_call_id` and `tool` to the tool it names. The server replays the " +
    "arguments it already holds for that approval — never re-send them.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Name of the paused tool the person approved." },
      confirm_id: {
        type: "string",
        description: "The `tool_call_id` from the confirm envelope (joins the approval audit).",
      },
    },
    required: ["tool", "confirm_id"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  execution: { taskSupport: "forbidden" },
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
  /** Full `wf_` palette, fetched once; sliced to `paletteLimit` per tier. */
  fullPalette: Tool[];
}

/** Essentials-first priority. Strict clients that silently drop tools truncate
 *  the tail of the manifest, so we lead with what every client needs: the
 *  search-first core, then the workflow palette, then the WHOLE authoring
 *  session cluster (entry point and continuation are one indivisible unit —
 *  see AUTHORING_SESSION_TOOL_NAMES), then everything else. A stable sort
 *  preserves intra-bucket order. */
function essentialsRank(tool: Tool): number {
  if (MCP_CORE_TOOL_NAMES.has(tool.name)) return 0;
  if (tool.name.startsWith(TOOL_PREFIX)) return 1;
  if (AUTHORING_SESSION_TOOL_NAMES.has(tool.name)) return 2;
  return 3;
}

function orderEssentialsFirst(tools: Tool[]): Tool[] {
  return tools
    .map((tool, i) => ({ tool, i }))
    .sort((a, b) => essentialsRank(a.tool) - essentialsRank(b.tool) || a.i - b.i)
    .map((e) => e.tool);
}

/** Assemble one catalog tier (in-memory; no DB). The `wf_` palette is sliced
 *  from the pre-fetched full list; the registry tools follow the mode and, in
 *  `authoring`, are narrowed to product's set plus AUTHORING_EXTRA_TOOL_NAMES;
 *  the `conversation_*` session tools ship whole; and `confirm_tool_call` is
 *  always appended as the guaranteed confirm fallback so it is part of the
 *  measured floor for every client. The result is ordered essentials-first so a
 *  strict client that truncates anyway keeps the tools that matter. */
export function assembleTier(p: AssembleTierParams): Tool[] {
  const flags = modeFlags(p.mode, p.readOnly);
  const tools: Tool[] = [];
  tools.push(...p.fullPalette.slice(0, p.paletteLimit));
  const registryTools = listToolsViaRegistry({
    principal: p.principal,
    mcpMode: p.mode,
    readOnly: !flags.showTenantWrites,
  });
  tools.push(
    ...(p.mode === "authoring"
      ? authoringPublishedTools(registryTools, productPublishedToolNames(p.principal))
      : registryTools),
  );
  if (flags.showConversationTools) tools.push(...listConversationTools());
  tools.push(CONFIRM_TOOL_CALL_TOOL);
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

/** Shrink the catalog toward the schema-token budget without stepping the mode.
 *
 *  Contract. WHICH named tools ship is decided before this runs, by mode:
 *  product and authoring publish bounded allow-lists (authoring a superset of
 *  product), admin publishes the full inventory. Given that, the three levers
 *  here — shrink the `wf_` palette to its Top-N, compress schema prose, then
 *  keep giving back palette depth — are enough for product and authoring to land
 *  under SCHEMA_TOKEN_BUDGET. No lever removes a capability: trimmed workflows
 *  stay reachable via find_workflow / run_workflow(slug), and compression touches
 *  prose only. The palette yields before any named tool does, because it is the
 *  only part of the manifest with a complete fallback.
 *
 *  Admin is the one mode that can legitimately finish over budget: it publishes
 *  every tool by definition, and its principals are deliberately-minted
 *  operator keys. Its NAMED tools alone exceed the budget, so the third lever
 *  never engages there — spending the palette on a budget it cannot reach would
 *  cost an admin every preloaded workflow and buy nothing. The final `break` is
 *  the backstop for exactly that case, and the `over_budget` field of
 *  `mcp.catalog.fitted` reports it. Do not raise the budget to silence it;
 *  shrink the allow-list. */
export function fitCatalogToBudget(
  base: Omit<AssembleTierParams, "mode" | "paletteLimit" | "compress"> & { initialMode: McpMode },
): CatalogFitResult {
  const mode = base.initialMode;
  let paletteLimit = DEFAULT_PALETTE_LIMIT;
  let compress = false;
  let tools = assembleTier({ ...base, mode, paletteLimit, compress });
  const estTokensBefore = estimateCatalogTokens(tools);
  let est = estTokensBefore;
  // "Would surrendering the WHOLE palette fit?" — answered at most once, and
  // only if the first two levers were not enough. When the named tools alone
  // exceed the budget the palette is not what is over-spending, so trimming it
  // is pure loss; keep it and let `over_budget` report the truth.
  let paletteCanClose: boolean | null = null;
  while (est > SCHEMA_TOKEN_BUDGET) {
    if (paletteLimit > MIN_PALETTE_LIMIT) paletteLimit = MIN_PALETTE_LIMIT;
    else if (!compress) compress = true;
    else {
      if (paletteCanClose === null) {
        const floor = assembleTier({ ...base, mode, paletteLimit: 0, compress: true });
        paletteCanClose = estimateCatalogTokens(floor) <= SCHEMA_TOKEN_BUDGET;
      }
      // Levers exhausted — keep every named tool, and keep the palette when
      // giving it up could not have fit the budget anyway.
      if (!paletteCanClose || paletteLimit === 0) break;
      paletteLimit = Math.max(0, paletteLimit - PALETTE_TRIM_STEP);
    }
    tools = assembleTier({ ...base, mode, paletteLimit, compress });
    est = estimateCatalogTokens(tools);
  }
  return { tools, estTokensBefore, estTokensAfter: est, mode, paletteLimit, compressed: compress };
}
