import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { runScan, type ScanCompleted } from "../../self-healing/admin-scans.ts";

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

interface SelfHealingScanArgs {
  workflow_id?: string;
  connector_id?: string;
}

type SelfHealingScanResult = Omit<ScanCompleted, "error">;

interface SelfHealingScanContext {
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

  const outcome = await runScan(db, principal, {
    source: "mcp",
    signalSource: "proactive_mcp",
    allowAutoApply: false,
    sweepUndecidable: false,
    countCreatedOnly: false,
    signalFailuresFailScan: false,
    workflow_id: args.workflow_id,
    connector_id: args.connector_id,
    idempotency_key: null,
  });
  if (outcome.kind !== "completed") {
    return {
      ok: false,
      data: { error: "failed to persist self_healing_scans row", reason: "persist_failed" },
    };
  }
  const result = outcome.result;
  if (result.error !== null) {
    return {
      ok: false,
      data: { error: `scan failed: ${result.error}`, reason: "scan_failed" },
    };
  }

  return {
    ok: true,
    data: {
      scan_id: result.scan_id,
      signals_detected: result.signals_detected,
      candidates_created: result.candidates_created,
      unanchored_detected: result.unanchored_detected,
      duration_ms: result.duration_ms,
      candidates: result.candidates,
      unanchored: result.unanchored,
    },
  };
}
