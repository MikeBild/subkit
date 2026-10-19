import type { Tool } from "ai";
import {
  recordChatPaletteSurfaceEnforced,
  recordMcpExternalToolPaletteAssemblyFailed,
} from "../../audit/recorders/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { compatibleToolPalette } from "../../llm/core/tool-schema-compatibility.ts";
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
  const isChatSurface = ctx.surface === "chat" || principal?.provider === "chat";
  if (ctx.surface !== "chat" && principal?.provider === "chat") {
    try {
      await recordChatPaletteSurfaceEnforced({
        tenant_id: ctx.tenant_id,
        actor_id: principal.id,
        actor_type: principal.kind,
        conversation_id: ctx.conversation_id,
        request_source: "chat",
        executor: db,
      });
    } catch (auditErr) {
      logger.warn({
        module: "conversation_tool",
        action: "chat_palette.surface_enforced_audit_failed",
        msg: "failed to audit the chat palette enforcement; the read-only palette still applies",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  }
  const loadedSkillSet = new Set(loadedSkills);
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
      permissionMode,
      toolPolicies,
    });
    for (const [name, tool] of Object.entries(synthetic)) {
      out[name] = tool;
    }
  }
  if (principal && !isChatSurface) {
    try {
      const mcpTools = await buildExternalMcpTools({ db, principal, ctx, signals, events });
      for (const [name, t] of Object.entries(mcpTools)) {
        out[name] = t;
      }
    } catch (err) {
      const detail = redactUpstreamDetail(err instanceof Error ? err.message : String(err));
      logger.warn({
        module: "conversation_tool",
        action: "external_mcp.assembly_failed",
        msg: "external MCP tool assembly failed; degrading to zero external tools for this turn",
        tenant_id: ctx.tenant_id,
        error: detail,
      });
      try {
        await recordMcpExternalToolPaletteAssemblyFailed({
          tenant_id: ctx.tenant_id,
          actor_id: principal.id,
          actor_type: principal.kind,
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
  const palette = await compatibleToolPalette(out);
  for (const name of palette.omitted) {
    logger.warn({
      module: "conversation_tool",
      action: "tool.schema_incompatible",
      tenant_id: ctx.tenant_id,
      tool: name,
      msg: "Tool omitted from model palette because its root input schema is not provider-compatible",
    });
    ctx.onLog?.(
      "warn",
      `Tool ${name} has an incompatible input schema and was omitted; saved workflows remain accessible through run_workflow.`,
    );
  }
  ctx.availableToolNames = new Set(Object.keys(palette.tools));
  return palette.tools;
}
