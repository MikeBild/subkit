// A connector's runtime, read back from what the engine already recorded:
// the newest successful and the newest failed call in `audit_log`, and — for
// an mcp connector — the negotiated session row. No new persistence.
//
// ONE ROW PER CALL, the same rule `GET /v1/stats/connectors` counts by: an
// mcp call is the pool's `mcp_external_tool.invoked` row (a chat call writes
// no egress row); every other driver's call is the egress row
// `connector.invoked`. Both rows carry the connector id as `resource_id`.
//
// The failure is reported as a class, never as text. The audit `reason` of an
// egress failure is the driver's error message, which can quote the remote;
// the class is the engine's own reading of it.

import { and, desc, eq } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { auditLog, connectorMcpSessions } from "../db/schema/index.ts";

/** Drivers whose every call passes an audited path (`withEgressAudit` for
 *  workflow steps, `recordConnectorInvoked` for chat calls, the MCP pool's
 *  recorder). A driver missing here has calls the log does not hold, and the
 *  page says so instead of reporting "never used". */
const RECORDED_DRIVERS: ReadonlySet<string> = new Set(["http", "graphql", "s3", "postgres", "mcp"]);

/** The failure classes a connector call can be read as — a subset of the
 *  engine's `FailureCauseClass`, so the cockpit words them with the same map. */
export type ConnectorFailureClass = "auth_failed" | "timeout" | "aborted" | "driver_error";

export interface ConnectorRuntime {
  last_success_at: string | null;
  last_failure: {
    at: string;
    /** Low-cardinality failure code: the status class (`4xx_auth`, `5xx`, …),
     *  `network_error` for a call with no status, `remote_error` for an mcp
     *  tool that answered with an error. */
    code: string;
    cause_class: ConnectorFailureClass;
  } | null;
  recorded: boolean;
  mcp_session: {
    protocol_version: string | null;
    /** The capability keys the server declared during `initialize`. */
    capabilities: string[];
    last_handshake_at: string | null;
    consecutive_failures: number;
    backoff_until: string | null;
  } | null;
}

function statusOf(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const raw = m.status_code ?? m.status;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

/** Same bands as the stats route's `STATUS_CLASS_CASE`. */
function failureCode(status: number | null, mcp: boolean): string {
  if (status === null) return mcp ? "remote_error" : "network_error";
  if (status === 401 || status === 403) return "4xx_auth";
  if (status === 429) return "4xx_rate_limited";
  if (status >= 400 && status <= 499) return "4xx_other";
  if (status >= 500 && status <= 599) return "5xx";
  return "no_status";
}

export function classifyConnectorFailure(
  status: number | null,
  reason: string | null,
): ConnectorFailureClass {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 408 || status === 504) return "timeout";
  const text = (reason ?? "").toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/.test(text)) return "auth_failed";
  if (/timeout|timed out/.test(text)) return "timeout";
  if (/abort/.test(text)) return "aborted";
  return "driver_error";
}

export async function readConnectorRuntime(
  db: Executor,
  tenant_id: string,
  connector: { id: string; driver: string },
): Promise<ConnectorRuntime> {
  const mcp = connector.driver === "mcp";
  const action = mcp ? AuditAction.MCP_EXTERNAL_TOOL_INVOKED : AuditAction.CONNECTOR_INVOKED;
  const newest = async (result: "success" | "error") =>
    (
      await db
        .select({ ts: auditLog.ts, metadata: auditLog.metadata, reason: auditLog.reason })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenant_id),
            eq(auditLog.action, action),
            eq(auditLog.resource_id, connector.id),
            eq(auditLog.result, result),
          ),
        )
        .orderBy(desc(auditLog.ts))
        .limit(1)
    )[0] ?? null;
  const [success, failure] = await Promise.all([newest("success"), newest("error")]);

  let mcp_session: ConnectorRuntime["mcp_session"] = null;
  if (mcp) {
    const row = (
      await db
        .select()
        .from(connectorMcpSessions)
        .where(
          and(
            eq(connectorMcpSessions.tenant_id, tenant_id),
            eq(connectorMcpSessions.connector_id, connector.id),
          ),
        )
        .limit(1)
    )[0];
    if (row) {
      mcp_session = {
        protocol_version: row.negotiated_protocol_version ?? null,
        capabilities: Object.keys(row.server_capabilities ?? {}).sort(),
        last_handshake_at: row.last_handshake_at?.toISOString() ?? null,
        consecutive_failures: row.consecutive_failures,
        backoff_until: row.backoff_until?.toISOString() ?? null,
      };
    }
  }

  const status = failure ? statusOf(failure.metadata) : null;
  return {
    last_success_at: success ? success.ts.toISOString() : null,
    last_failure: failure
      ? {
          at: failure.ts.toISOString(),
          code: failureCode(status, mcp),
          cause_class: classifyConnectorFailure(status, failure.reason ?? null),
        }
      : null,
    recorded: RECORDED_DRIVERS.has(connector.driver),
    mcp_session,
  };
}
