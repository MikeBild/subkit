// Public registry: build the SDK `toolSet` for one `runLoop` invocation.
//
// After the Phase 4 split (audit §4.2), the wrapping logic lives in
// `sdk-wrap/`:
//
//   - `sdk-wrap/state.ts`          — TurnSignals, WrappedToolOutput,
//                                    constants, computeValidationFingerprint
//   - `sdk-wrap/policy-helpers.ts` — confirmation / dedupe / risk helpers
//   - `sdk-wrap/invoke.ts`         — wrapOne (per-tool wrapper)
//
// External callers continue to import `wrapTools`, `TurnSignals`,
// `MAX_CONSECUTIVE_FAILURES`, and `computeValidationFingerprint` from
// this file; nothing else escapes the module boundary.
//
// Relationship to apps/engine/src/tools/ (unified palette):
//   The chat surface is the canonical home of the conversation tool
//   registry — `listTools()` here is the source of truth that the
//   unified `ConversationToolProvider` wraps for MCP. The chat loop
//   continues to wrap each tool inline (rate-limiting, abort signals,
//   live-log forwarding, draft-state diff emission, structured event
//   stream) because those concerns are loop-scoped, not surface-scoped.
//   See docs/10-tool-palette.md ("Why this exists" + "Layout") for the
//   end-to-end picture.

import type { Tool } from "ai";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { PermissionMode, ToolPolicies } from "../tool-policies.ts";
import type { TurnEvent } from "../types.ts";
import { filterByAuthoringPalette } from "./authoring-palette.ts";
import { filterBySkillGate } from "./gated.ts";
import { listTools, type ToolContext } from "./index.ts";
import { buildExternalMcpTools } from "./sdk-wrap/external-mcp-tools.ts";
import { wrapOne } from "./sdk-wrap/invoke.ts";
import type { TurnSignals, WrappedToolOutput } from "./sdk-wrap/state.ts";
import { buildSyntheticWorkflowTools } from "./sdk-wrap/synthetic-workflow-tools.ts";

export {
  computeValidationFingerprint,
  MAX_CONSECUTIVE_FAILURES,
  MAX_TURN_LOOP_WARNINGS,
  MAX_VALIDATION_FINGERPRINT_REPEAT,
  type TurnSignals,
  type WrappedToolOutput,
} from "./sdk-wrap/state.ts";

/**
 * Build the SDK `toolSet` for one `runLoop` invocation. Each wrapped
 * tool closes over `ctx`, `signals`, and `events` so side effects land
 * in the same sink the loop returns to callers. When a principal is
 * provided, the tenant's saved workflows are additionally exposed as
 * `wf_<slug>` synthetic tools, top-40 by `last_executed_at` — the same
 * catalog MCP ships via `listWorkflowToolsForTenant`. The LLM can then
 * dispatch a saved workflow in one tool call.
 */
export async function wrapTools(
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
  loadedSkills: ReadonlyArray<string> = [],
  toolPolicies: ToolPolicies = {},
  permissionMode: PermissionMode | null = null,
  principal: ResolvedPrincipal | null = null,
): Promise<Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>> {
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  // Apply skill-gate: tools whose `requires_skill` isn't in loadedSkills
  // are hidden from the model until the matching `load_skill` call.
  const loadedSkillSet = new Set(loadedSkills);
  const visibleTools = filterByAuthoringPalette(
    filterBySkillGate(listTools(), loadedSkills),
    ctx.getDraft(),
    loadedSkillSet,
  );
  for (const t of visibleTools) {
    out[t.name] = wrapOne(t, ctx, signals, events, db, toolPolicies, permissionMode, loadedSkills);
  }
  if (principal) {
    const synthetic = await buildSyntheticWorkflowTools({
      db,
      principal,
      ctx,
      signals,
      events,
    });
    for (const [name, tool] of Object.entries(synthetic)) {
      out[name] = tool;
    }
  }
  if (principal) {
    // Best-effort: external MCP tools are an enrichment, not load-bearing.
    // A DB error in `listConnectableMcpServersForTenant` or a pool failure
    // must NEVER abort the whole turn or drop the in-repo + `wf_` tools
    // already assembled above. Degrade to ZERO external tools and log.
    try {
      const mcpTools = await buildExternalMcpTools({ db, principal, ctx, signals, events });
      for (const [name, t] of Object.entries(mcpTools)) {
        out[name] = t;
      }
    } catch (err) {
      logger.warn({
        module: "conversation_tool",
        action: "external_mcp.assembly_failed",
        msg: "external MCP tool assembly failed; degrading to zero external tools for this turn",
        tenant_id: ctx.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
