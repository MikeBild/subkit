// MCP catalog assembly.
//
// The MCP `tools/list` manifest publishes the FULL authoring catalog for the
// resolved mode — no server-side trimming, compression, or budget loop. We
// empirically verified that the strict clients (claude.ai, ChatGPT) defer-load
// large catalogs natively: an 80-tool probe with a deep canary was both
// discovered and called, so the client's own native tool-search handles size.
// SubKit therefore advertises everything the mode publishes and lets the client
// page it.
//
// Per-mode set:
//   - product   — the minimal end-user run-surface (registry's
//                 PRODUCT_MODE_ALLOW_LIST, applied inside listToolsViaRegistry
//                 for mcpMode:"product").
//   - authoring — the `wf_` palette, every registry tool the provider
//                 publishes, and the conversation_* session tools.
//   - admin     — the same catalogue as authoring.
//
// PRODUCT IS THE ONLY MODE THAT TRIMS. `conversation.ts` gates on
// `filter.mcpMode === "product"` and nothing else, so authoring and admin
// resolve to an identical list — verified by listing all three. An earlier
// version of this comment claimed authoring published "no tenant_write except
// run_workflow"; it does publish tenant writes (`restore_workflow_version`,
// `update_workflow`, …), and the docs built on that claim were wrong until
// corrected. What actually bounds a caller is the per-tool RBAC the dispatcher
// enforces, NOT the mode. Do not infer reachability from the mode name.
//
// The one boundary that IS categorical: `draft_write` tools are dropped from
// the MCP catalogue in every mode and refused on a direct call
// (`conversation.ts` `shouldDropFromCatalog`), so no external client can edit a
// workflow draft step-by-step. That is the invariant worth protecting here.
//
// The ONE remaining bound is DEFAULT_PALETTE_LIMIT: a cap on how many `wf_`
// per-workflow tools we preload. Workflows past it stay reachable via
// `find_workflow` / `run_workflow(slug)` — a preloading bound, not a functional
// limit.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { listToolsViaRegistry } from "../adapter.ts";
import { type McpMode, modeFlags } from "../mode-resolver.ts";
import { listConversationTools } from "./conversations.ts";

export const TOOL_PREFIX = "wf_";
// Default size of the per-workflow `wf_` palette; matches the converse cap. The
// only bound left on the catalog — trimmed-out workflows stay reachable via
// `find_workflow` / `run_workflow(slug)`.
export const DEFAULT_PALETTE_LIMIT = 40;

export interface AssembleCatalogParams {
  principal: ResolvedPrincipal;
  readOnly: boolean;
  mode: McpMode;
  /** Full `wf_` palette, fetched once; capped to DEFAULT_PALETTE_LIMIT here. */
  fullPalette: Tool[];
}

/** Assemble the full `tools/list` catalog for a mode (in-memory; no DB).
 *
 *  Composition, in a DELIBERATE order — entry points and named tools first, the
 *  per-workflow `wf_` palette last:
 *    1. `conversation_*` session tools (the authoring entry point) when the mode
 *       shows them,
 *    2. every registry tool the mode publishes UNFILTERED — `listToolsViaRegistry`
 *       already applies the correct per-mode set (product's allow-list,
 *       authoring's full tenant_read + workflow_run, admin's full inventory),
 *    3. the `wf_` palette (capped to DEFAULT_PALETTE_LIMIT).
 *
 *  Why this order: some clients render or fetch only the first page of
 *  `tools/list` (see the caller's page size). Authoring's named tools + the
 *  conversation cluster total well under a page, so ordering them first keeps
 *  every operator tool (call_connector, list_skills, …) reachable even for a
 *  client that caps the list; only excess `wf_` palette entries can spill past
 *  the page, and those stay reachable via `find_workflow` / `run_workflow(slug)`.
 *  No compression, no budget loop: the client's native tool-search handles size. */
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
