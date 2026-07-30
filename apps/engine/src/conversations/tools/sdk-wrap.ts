// Public registry: build the SDK `toolSet` for one `runLoop` invocation.
//
// The wrapping logic lives in `sdk-wrap/`:
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
//   See docs/developers/tool-palette.md ("Why this exists" + "Layout") for the
//   end-to-end picture.

import type { Tool } from "ai";
import { recordMcpExternalToolPaletteAssemblyFailed } from "../../audit/recorders/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { redactUpstreamDetail } from "../../mcp/client/registry.ts";
import type { PermissionMode, ToolPolicies } from "../tool-policies.ts";
import type { TurnEvent } from "../types.ts";
import { filterByAuthoringPalette, filterByChatReadOnlyPalette } from "./authoring-palette.ts";
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
 * dispatch a saved workflow in one tool call. Those synthetic peers are keyed
 * by their prefixed name (`wf_<slug>`) in the returned map, so the loop derives
 * the saved-workflow slug catalog from the keys themselves — no second query.
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
  const isChatSurface = ctx.surface === "chat";
  // Tripwire against the fail-open direction of the optional `surface`
  // threading: a chat-linked principal running WITHOUT the chat surface
  // would silently get the full authoring palette. Loud log, no throw —
  // the palette below still assembles so the turn survives, but the
  // divergence is visible in structured logs.
  if (!isChatSurface && principal?.provider === "chat") {
    logger.warn({
      module: "conversation_tool",
      action: "palette.chat_surface_missing",
      msg: "chat-provider principal is running a turn without surface=chat — palette restriction not applied; check the caller's surface threading",
      tenant_id: ctx.tenant_id,
    });
  }
  // Apply skill-gate: tools whose `requires_skill` isn't in loadedSkills
  // are hidden from the model until the matching `load_skill` call.
  const loadedSkillSet = new Set(loadedSkills);
  // Chat surface: channel-scoped read-only palette. A pure name
  // allow-list independent of skill-load state — see
  // `authoring-palette.ts#CHAT_READONLY_TOOLS` for the contract.
  const visibleTools = isChatSurface
    ? filterByChatReadOnlyPalette(listTools())
    : filterByAuthoringPalette(
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
  // External MCP tools are write-capable (arbitrary remote servers) —
  // the read-only chat channel never exposes them, same posture as
  // `call_connector`.
  if (principal && !isChatSurface) {
    // Best-effort: external MCP tools are an enrichment, not load-bearing.
    // A DB error in `listConnectableMcpConnectorsForTenant` or a pool failure
    // must NEVER abort the whole turn or drop the in-repo + `wf_` tools
    // already assembled above. Degrade to ZERO external tools and log.
    try {
      const mcpTools = await buildExternalMcpTools({ db, principal, ctx, signals, events });
      for (const [name, t] of Object.entries(mcpTools)) {
        out[name] = t;
      }
    } catch (err) {
      // Reduce any URL embedded in the raw pool/DB error to host-only and
      // length-cap it BEFORE it reaches the log line or the audit row — a
      // transport error can echo a server URL with its query string.
      const detail = redactUpstreamDetail(err instanceof Error ? err.message : String(err));
      logger.warn({
        module: "conversation_tool",
        action: "external_mcp.assembly_failed",
        msg: "external MCP tool assembly failed; degrading to zero external tools for this turn",
        tenant_id: ctx.tenant_id,
        error: detail,
      });
      // Land a queryable audit row so the degradation isn't only a transient
      // log line. Best-effort: the audit write must NEVER throw out of the
      // turn (that would defeat the whole degrade-gracefully contract), so
      // wrap it and swallow any failure into the same logger sink.
      // `pool_fault` is the catch-all class here: at this layer a drizzle
      // enumeration error and an SDK pool fault both surface as one thrown
      // Error from `buildExternalMcpTools`, so a reliable db_error /
      // pool_fault split is not possible — the redacted message lands in
      // metadata.detail for the operator to tell them apart.
      try {
        await recordMcpExternalToolPaletteAssemblyFailed({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          reason: "pool_fault",
          detail,
          request_source: "chat",
          executor: db,
        });
      } catch (auditErr) {
        logger.warn({
          module: "conversation_tool",
          action: "external_mcp.assembly_failed_audit_failed",
          msg: "failed to audit external MCP palette-assembly failure; continuing the turn",
          tenant_id: ctx.tenant_id,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
    }
  }
  // Publish the resolved palette on the context the wrapped tools close
  // over, so a tool can check a claim about the palette against the
  // palette. Assigned once here, AFTER every source has contributed
  // (in-repo, synthetic `wf_`, external MCP) — a partial set would be
  // worse than none, because the check it feeds is only sound when the
  // set is complete. Property lookup happens at call time, so the
  // closures created above see it.
  ctx.availableToolNames = new Set(Object.keys(out));
  return out;
}
