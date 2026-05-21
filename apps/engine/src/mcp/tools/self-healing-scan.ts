// MCP `self_healing.scan` admin tool.
//
// Triggers a proactive drift scan from the chat-driven surface so an
// operator can ask "scan our connectors for drift now" inside a
// conversation. Wraps the same `scanForDrift` + `processDriftSignal`
// pipeline the admin HTTP endpoint uses, with `allowAutoApply: false`
// hard-wired so the tool never silently mutates a workflow — every
// proposed candidate still lands in the existing patch-candidate
// review flow.
//
// Visibility is gated in two layers:
//   * tools/list — only includes this tool in MCP admin mode
//     (principal carries `mcp:admin` scope OR `SK_MCP_MODE=admin`).
//     See `mcp/capabilities/tools.ts` for the registration filter.
//   * tools/call — the handler below additionally enforces the
//     `admin` role on the principal so a misconfigured catalog can't
//     leak the tool to a non-admin invoker.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { selfHealingScans } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import {
  recordProactiveDriftCandidate,
  recordProactiveDriftScan,
  recordProactiveDriftSignal,
  recordProactiveDriftUnanchored,
} from "../../observability/instrumentation.ts";
import { processDriftSignal, scanForDrift } from "../../self-healing/index.ts";

export const SELF_HEALING_SCAN_TOOL_NAME = "self_healing_scan";

export const selfHealingScanMcpTool: Tool = {
  name: SELF_HEALING_SCAN_TOOL_NAME,
  description:
    "Trigger a proactive self-healing drift scan. Detects stdlib version drift, schema shape drift, and validation-expression drift across the tenant. Always parks proposals as 'proposed' for operator review — never auto-applies.",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: {
        type: "string",
        description: "Optional: restrict the scan to a single workflow's validation drift.",
      },
      connector_id: {
        type: "string",
        description: "Optional: restrict the scan to a single connector's schema drift.",
      },
    },
    additionalProperties: false,
  },
};

export interface SelfHealingScanArgs {
  workflow_id?: string;
  connector_id?: string;
}

export interface SelfHealingScanResult {
  scan_id: string;
  signals_detected: number;
  candidates_created: number;
  /** Count of drift signals not promoted to a Patch Candidate
   *  (hook surfaces / orphan connectors). Matches `unanchored.length`. */
  unanchored_detected: number;
  duration_ms: number;
  candidates: Array<{
    id: string;
    signal_type: string;
    classification: "safe" | "unsafe";
    status: "proposed";
  }>;
  unanchored: Array<{
    signal_type: string;
    reason: "hook_surface_not_supported" | "no_workflow_anchor";
    resource_id: string;
  }>;
}

export interface SelfHealingScanContext {
  db: Db;
  principal: ResolvedPrincipal;
}

export async function handleSelfHealingScan(
  ctx: SelfHealingScanContext,
  args: SelfHealingScanArgs,
): Promise<
  { ok: true; data: SelfHealingScanResult } | { ok: false; data: { error: string; reason: string } }
> {
  const { db, principal } = ctx;
  if (!principal.roles.includes("admin")) {
    return {
      ok: false,
      data: {
        error: "admin role required to trigger a self-healing scan",
        reason: "admin_required",
      },
    };
  }

  const filters = {
    tenant_id: principal.tenant_id,
    ...(args.workflow_id ? { workflow_id: args.workflow_id } : {}),
    ...(args.connector_id ? { connector_id: args.connector_id } : {}),
  };

  const started = new Date();
  const [scanRow] = await db
    .insert(selfHealingScans)
    .values({
      tenant_id: principal.tenant_id,
      source: "mcp",
      filters,
      actor_id: principal.id,
      status: "running",
    })
    .returning();
  if (!scanRow) {
    return {
      ok: false,
      data: { error: "failed to persist self_healing_scans row", reason: "persist_failed" },
    };
  }
  const scan_id = scanRow.id;

  let signals_detected = 0;
  let candidates_created = 0;
  let errorText: string | null = null;
  const candidates: SelfHealingScanResult["candidates"] = [];
  const unanchored: SelfHealingScanResult["unanchored"] = [];

  try {
    // TRIGGERED audit lives inside the try block so audit-insert
    // failures still flow through the same row-finalisation path —
    // no orphan `status='running'` rows on any failure mode.
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.SELF_HEALING_SCAN_TRIGGERED,
        resource_type: "self_healing_scan",
        resource_id: scan_id,
        result: "success",
        metadata: { source: "mcp", filters },
      },
      db,
    );
    const scan = await scanForDrift(filters, db);
    signals_detected = scan.signals.length + scan.unanchored.length;
    for (const u of scan.unanchored) {
      unanchored.push({
        signal_type: u.signal.kind,
        reason: u.reason,
        resource_id: u.resource_id,
      });
      recordProactiveDriftUnanchored({
        tenant_id: principal.tenant_id,
        signal_type: u.signal.kind,
        reason: u.reason,
      });
    }
    for (const { signal, ctx: signalCtx } of scan.signals) {
      recordProactiveDriftSignal({
        tenant_id: principal.tenant_id,
        signal_type: signal.kind,
      });
      try {
        const result = await processDriftSignal(
          signal,
          {
            tenant_id: signalCtx.tenant_id,
            workflow_id: signalCtx.workflow_id,
            execution_id: signalCtx.execution_id,
            step_id: signalCtx.step_id,
            ...(signalCtx.connector_id ? { connector_id: signalCtx.connector_id } : {}),
            ...(signalCtx.endpoint_key ? { endpoint_key: signalCtx.endpoint_key } : {}),
            actor_id: principal.id,
            source: "proactive_mcp",
            scan_id,
            repair_input: signalCtx.repair_input,
          },
          { allowAutoApply: false },
          db,
        );
        candidates_created += 1;
        recordProactiveDriftCandidate({
          tenant_id: principal.tenant_id,
          classification: result.classification,
        });
        candidates.push({
          id: result.candidate_id,
          signal_type: signal.kind,
          classification: result.classification,
          status: "proposed",
        });
      } catch (err) {
        logger.error({
          module: "mcp",
          action: "self_healing.scan.signal_failed",
          msg: "failed to process drift signal in MCP scan — continuing",
          scan_id,
          tenant_id: principal.tenant_id,
          drift_kind: signal.kind,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "mcp",
      action: "self_healing.scan.failed",
      msg: "MCP-triggered scan failed mid-pass",
      scan_id,
      tenant_id: principal.tenant_id,
      err: errorText,
    });
  }

  const duration_ms = Date.now() - started.getTime();
  await db
    .update(selfHealingScans)
    .set({
      signals_detected,
      candidates_created,
      unanchored_detected: unanchored.length,
      duration_ms,
      status: errorText === null ? "succeeded" : "failed",
      error: errorText,
      updated_at: new Date(),
    })
    .where(eq(selfHealingScans.id, scan_id));

  recordProactiveDriftScan({
    tenant_id: principal.tenant_id,
    source: "mcp",
    status: errorText === null ? "succeeded" : "failed",
    duration_ms,
  });

  await auditAwait(
    {
      tenant_id: principal.tenant_id,
      actor_type: "user",
      actor_id: principal.id,
      action: AuditAction.SELF_HEALING_SCAN_COMPLETED,
      resource_type: "self_healing_scan",
      resource_id: scan_id,
      result: errorText === null ? "success" : "error",
      metadata: {
        source: "mcp",
        signals_detected,
        candidates_created,
        unanchored_detected: unanchored.length,
        duration_ms,
        ...(errorText ? { error: errorText } : {}),
      },
    },
    db,
  );

  if (errorText !== null) {
    return {
      ok: false,
      data: { error: `scan failed: ${errorText}`, reason: "scan_failed" },
    };
  }

  return {
    ok: true,
    data: {
      scan_id,
      signals_detected,
      candidates_created,
      unanchored_detected: unanchored.length,
      duration_ms,
      candidates,
      unanchored,
    },
  };
}
