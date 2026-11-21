import type { Tool } from "ai";
import {
  recordChatPaletteSurfaceEnforced,
  recordMcpExternalToolPaletteAssemblyFailed,
} from "../../audit/recorders/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { compatibleToolPalette } from "../../llm/runtime/tool-schema-compatibility.ts";
import { logger } from "../../logging/index.ts";
import { redactUpstreamDetail } from "../../mcp/client/registry.ts";
import type { ToolPolicies } from "../../tools/types.ts";
import { taskRunPrincipal } from "../service/task-run-marker.ts";
import { taskRunToolPolicies } from "../tool-policies.ts";
import type { TaskRunMarker, TurnEvent } from "../types.ts";
import {
  filterByAuthoringPalette,
  filterByChatReadOnlyPalette,
  filterByTaskRunPalette,
  withoutTaskRunOnlyTools,
} from "./authoring-palette.ts";
import { buildDeviceTools } from "./device-tools/index.ts";
import { filterBySkillGate } from "./gated.ts";
import { listTools, type ToolContext } from "./index.ts";
import { buildExternalMcpTools } from "./sdk-wrap/external-mcp-tools.ts";
import {
  INTAKE_ITEM_DEPENDENT_TOOLS,
  intakeReviewInProgress,
} from "./sdk-wrap/intake-review-guard.ts";
import { wrapOne } from "./sdk-wrap/invoke.ts";
import type { TurnSignals, WrappedToolOutput } from "./sdk-wrap/state.ts";
import { buildSyntheticWorkflowTools } from "./sdk-wrap/synthetic-workflow-tools.ts";
import {
  guardTaskRunTool,
  taskRunMarkerOf,
  withTaskRunEnvironment,
} from "./sdk-wrap/task-run-guard.ts";

export {
  computeValidationFingerprint,
  MAX_CONSECUTIVE_FAILURES,
  MAX_TURN_LOOP_WARNINGS,
  MAX_VALIDATION_FINGERPRINT_REPEAT,
  type TurnSignals,
  type WrappedToolOutput,
} from "./sdk-wrap/state.ts";

type WrappedPalette = Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>;

async function compatiblePalette(ctx: ToolContext, out: WrappedPalette): Promise<WrappedPalette> {
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

async function wrapTaskRunTools(
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
  toolPolicies: ToolPolicies,
  taskRun: TaskRunMarker,
  callerPrincipal: ResolvedPrincipal | null,
): Promise<WrappedPalette> {
  const out: WrappedPalette = {};
  const principal = callerPrincipal ? taskRunPrincipal(callerPrincipal, taskRun) : null;
  const marker: TaskRunMarker = principal ? taskRun : { ...taskRun, sealed: true };
  ctx.task_run = marker;
  ctx.principal = principal;
  ctx.ask_before_writing = false;
  const policies = taskRunToolPolicies(toolPolicies);
  for (const t of filterByTaskRunPalette(listTools())) {
    if (
      ctx.playbook_mode === "off" &&
      (t.name === "inspect_playbook" || t.name === "update_playbook")
    )
      continue;
    const wrapped = wrapOne(guardTaskRunTool(t, marker), ctx, signals, events, db, policies);
    out[t.name] = t.name === "run_workflow" ? withTaskRunEnvironment(wrapped, marker) : wrapped;
  }
  if (principal && !marker.sealed) {
    Object.assign(
      out,
      await buildSyntheticWorkflowTools({
        db,
        principal,
        ctx,
        signals,
        events,
        toolPolicies: policies,
        taskRun: marker,
      }),
    );
    Object.assign(
      out,
      await buildDeviceTools({
        db,
        ctx,
        principal,
        taskRun: marker,
        signals,
        events,
        toolPolicies: policies,
      }),
    );
    if (marker.connector_ids.length > 0) {
      try {
        Object.assign(
          out,
          await buildExternalMcpTools({ db, principal, ctx, signals, events, taskRun: marker }),
        );
      } catch (err) {
        logger.warn({
          module: "conversation_tool",
          action: "external_mcp.assembly_failed",
          msg: "external MCP tool assembly failed; a task run continues without external tools",
          tenant_id: ctx.tenant_id,
          error: redactUpstreamDetail(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }
  return compatiblePalette(ctx, out);
}

export async function wrapTools(
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
  loadedSkills: ReadonlyArray<string> = [],
  toolPolicies: ToolPolicies = {},
  principal: ResolvedPrincipal | null = null,
): Promise<WrappedPalette> {
  const taskRun = taskRunMarkerOf(ctx);
  if (taskRun) return wrapTaskRunTools(ctx, signals, events, db, toolPolicies, taskRun, principal);
  const out: WrappedPalette = {};
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
  const visibleTools = withoutTaskRunOnlyTools(
    isChatSurface
      ? filterByChatReadOnlyPalette(listTools())
      : filterByAuthoringPalette(
          filterBySkillGate(listTools(), loadedSkills),
          ctx.getDraft(),
          loadedSkillSet,
        ),
  );
  const intakeItemRead = intakeReviewInProgress(ctx.getDraft());
  for (const t of visibleTools) {
    if (
      ctx.playbook_mode === "off" &&
      (t.name === "inspect_playbook" || t.name === "update_playbook")
    )
      continue;
    if (!intakeItemRead && INTAKE_ITEM_DEPENDENT_TOOLS.has(t.name)) continue;
    out[t.name] = wrapOne(t, ctx, signals, events, db, toolPolicies);
  }
  if (principal) {
    const synthetic = await buildSyntheticWorkflowTools({
      db,
      principal,
      ctx,
      signals,
      events,
      toolPolicies,
    });
    for (const [name, tool] of Object.entries(synthetic)) {
      out[name] = tool;
    }
  }
  if (principal && !isChatSurface) {
    Object.assign(
      out,
      await buildDeviceTools({
        db,
        ctx,
        principal,
        taskRun: null,
        signals,
        events,
        toolPolicies,
      }),
    );
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
  return compatiblePalette(ctx, out);
}
