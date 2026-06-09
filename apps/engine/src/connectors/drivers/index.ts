// Driver registry. `probeConnector` dispatches a health probe to the
// correct driver given a connector row. New drivers register here.

import type { Db } from "../../db/client.ts";
import type { ConnectorView } from "../types.ts";
import { probeFtpConnector } from "./ftp.ts";
import { probeGraphQLConnector } from "./graphql.ts";
import { probeHttpConnector } from "./http.ts";
import { probeMssqlConnector } from "./mssql.ts";
import { probePgConnector } from "./postgres.ts";
import { probeRedisConnector } from "./redis.ts";
import { probeS3Connector } from "./s3.ts";
import { probeSftpConnector } from "./sftp.ts";
import { probeSmbConnector } from "./smb.ts";

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
  | "unknown_upstream_error";

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  /** Typed error class — present on every ok:false result. */
  error_code?: ProbeErrorCode;
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
  "ok" | "latency_ms" | "status" | "detail" | "error_code"
>;

export async function probeConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
}): Promise<ProbeResult> {
  switch (p.connector.driver) {
    case "http":
      return probeHttpConnector(p);
    case "postgres":
      return probePgConnector(p.connector);
    case "s3":
      return probeS3Connector(p);
    case "graphql":
      return probeGraphQLConnector(p);
    case "mssql":
      return probeMssqlConnector(p.connector);
    case "redis":
      return probeRedisConnector(p.connector);
    case "ftp":
      return probeFtpConnector(p.connector);
    case "sftp":
      return probeSftpConnector(p.connector);
    case "smb":
      return probeSmbConnector(p.connector);
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
  probeFtpConnector,
  probeGraphQLConnector,
  probeHttpConnector,
  probeMssqlConnector,
  probePgConnector,
  probeRedisConnector,
  probeS3Connector,
  probeSftpConnector,
  probeSmbConnector,
};
