// Driver registry. `probeConnector` dispatches a health probe to the
// correct driver given a connector row.
//
// A new driver registers in MORE PLACES THAN THIS FILE, and only one of
// them is checked by the compiler. `CONNECTOR_CONFIG_SCHEMAS`
// (connectors/config-schemas.ts) is typed `Record<DriverName, …>`, so a
// missing entry is a typecheck failure. The rest fail at runtime or narrow
// silently: the branch chain in execution/steps/request/dispatch.ts,
// `EgressKind` in connectors/egress.ts, the `RequestMeta` union in
// execution/types.ts and its mirror in execution/request-meta-schema.ts,
// and the hand-copied driver literal unions in connectors/templates.ts,
// discovery/types.ts, http/routes/connector-templates/schemas.ts and the
// three authoring tools. Widen `DriverEnum` first and follow the
// typecheck failure; then walk that list, because the compiler will not.

import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import type { ConnectorView } from "../types.ts";
import { probeGraphQLConnector } from "./graphql.ts";
import { probeHttpConnector } from "./http.ts";
import { probeMcpConnector } from "./mcp.ts";
import { probePgConnector } from "./postgres.ts";
import { probeS3Connector } from "./s3.ts";

/**
 * G10 (runtime-logs review plan): typed enumeration of probe-failure
 * shapes so the LLM has a deterministic next-action mapping instead of
 * having to interpret a free-text `detail` string.
 *
 * Pre-fix a Google Drive 404 looked identical to a "credentials
 * invalid" 401 looked identical to "Drive API not enabled in Google
 * Cloud" — the model spent ~10 minutes of session ed20f48d chasing
 * the wrong hypotheses (HTTPS vs HTTP, callback URL allowlist, OAuth
 * scopes) before the user volunteered the Gmail-works comparison
 * that unlocked the answer.
 *
 * Classification is per-driver: HTTP can populate `credential_invalid`
 * (401) / `scope_insufficient` (403) / `remote_resource_not_found`
 * (404 from an explicit probe endpoint) / `unknown_upstream_error`
 * (5xx). Provider-aware mapping (e.g. Google `accessNotConfigured`
 * body → `remote_api_disabled`) is layered on top in
 * `classifyHttpProbeError` once the response body is in scope.
 */
export type ProbeErrorCode =
  | "credential_missing"
  | "credential_invalid"
  | "credential_expired"
  | "scope_insufficient"
  | "remote_api_disabled"
  | "remote_resource_not_found"
  /**
   * The engine never asked. An operator switched this connector off
   * (`connectors.enabled = false`), so the probe stopped before any
   * outbound request.
   *
   * It is deliberately NOT `unknown_upstream_error`: that code sends the
   * reader to investigate a remote which was never contacted and may be
   * perfectly healthy. This is the only member that describes OUR state
   * rather than the upstream's, and the operator's next action is a
   * one-click enable rather than a support ticket.
   */
  | "connector_disabled"
  | "unknown_upstream_error";

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  /** Typed error class — present on every ok:false result. */
  error_code?: ProbeErrorCode;
  /** Scrubbed, truncated (≤500 chars) upstream response body on ok:false. */
  body_snippet?: string;
  /**
   * Allowlisted diagnostic response headers (www-authenticate,
   * content-type, x-*auth/error/reason/login/deny/request-id*), values
   * scrubbed. Present on ok:false when the upstream sent any.
   */
  response_headers?: Record<string, string>;
  /**
   * Optional deep link to the provider console page that resolves
   * the failure (e.g. Google Cloud "Enable API" page when
   * `error_code === "remote_api_disabled"`). The LLM surfaces this
   * verbatim so the user can click rather than search.
   */
  provider_action_url?: string;
}

/** Shared return type for every per-driver probe function. */
export type DriverProbeResult = Pick<
  ProbeResult,
  "ok" | "latency_ms" | "status" | "detail" | "error_code" | "body_snippet" | "response_headers"
>;

export async function probeConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  /**
   * Credential to use instead of the persisted row, for probing a connector
   * that is not saved yet. `undefined` keeps the normal lookup; an explicit
   * `null` means "no credential", which an `auth_type !== "none"` connector
   * reports as `credential_missing` rather than sending an unauthenticated
   * request that would 401 indistinguishably from a real connectivity failure.
   *
   * Never persisted: it is handed to the driver for this one request and
   * dropped. Two drivers do not consume it, for different reasons:
   * postgres authenticates through `dsn`, and mcp REFUSES an override
   * outright — the pool resolves credentials from the vault by owner id
   * and has no seam to accept one, so honouring it silently would
   * authenticate the probe as an identity the author did not supply.
   */
  credential_override?: DecryptedCredential | null;
}): Promise<ProbeResult> {
  // A switch that still sends the request switches nothing off. `enabled`
  // is a connector-level fact, so the refusal lives at the registry rather
  // than in five driver bodies — a sixth driver inherits it by existing.
  // Re-checking a disabled connector costs the operator one explicit enable.
  if (!p.connector.enabled) {
    return {
      ok: false,
      latency_ms: 0,
      detail: "this connector is disabled — enable it before probing; nothing was sent",
      error_code: "connector_disabled",
    };
  }
  switch (p.connector.driver) {
    case "http":
      return probeHttpConnector(p);
    case "postgres":
      return probePgConnector(p.connector);
    case "s3":
      return probeS3Connector(p);
    case "graphql":
      return probeGraphQLConnector(p);
    case "mcp":
      return probeMcpConnector(p);
    default: {
      return {
        ok: false,
        latency_ms: 0,
        detail: `unknown driver: ${p.connector.driver}`,
      };
    }
  }
}

export {
  probeGraphQLConnector,
  probeHttpConnector,
  probeMcpConnector,
  probePgConnector,
  probeS3Connector,
};
