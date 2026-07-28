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
//   - authoring — the full authoring set: the `wf_` palette, every registry
//                 tool the mode publishes (tenant_read + workflow_run, no
//                 tenant_write except run_workflow), and the conversation_*
//                 session tools.
//   - admin     — the full inventory, tenant_write included when not read-only.
//
// WHERE THE TRIM ACTUALLY HAPPENS — read this before "verifying" the shape.
// `conversation.ts` gates on `filter.mcpMode === "product"` and on
// `filter.readOnly`; it does NOT gate tenant_write on the mode name. The
// authoring/admin split lives one layer up, in `modeFlags`
// (`mode-resolver.ts`), which hardcodes `showTenantWrites: false` for authoring
// and `!readOnly` for admin. `capabilities/tools.ts` turns that into the
// `readOnly` flag it passes down. So the published catalogue is
//     modeFlags(mode) -> readOnly -> listToolsViaRegistry
// and calling `conversationToolProvider.list({surface,mcpMode})` WITHOUT that
// derived flag makes authoring look identical to admin. It is not: authoring
// publishes ~80 tools with no `restore_workflow_version` / `update_workflow`,
// admin ~110 with both. A round of customer documentation was written from the
// provider-level reading and had to be withdrawn when a live `tools/list`
// against production disagreed. `tests/catalog-mode-invariants.test.ts`
// asserts the real path — extend that rather than probing the provider.
//
// `run_workflow` is the one tenant_write that survives read-only, via
// `visible_when_readonly`: it runs a workflow rather than mutating config.
//
// The boundary that is categorical across ALL modes: `draft_write` tools are
// dropped from the MCP catalogue and refused on a direct call
// (`conversation.ts`), so no external client can edit a workflow draft
// step-by-step. That is the invariant the authoring docs rest on.
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
