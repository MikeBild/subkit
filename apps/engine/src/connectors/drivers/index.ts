import type { AuditActorType } from "../../audit/types.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { clearConnectorReauth } from "../reauth.ts";
import type { ConnectorView } from "../types.ts";
import { probeGraphQLConnector } from "./graphql.ts";
import { probeHttpConnector } from "./http.ts";
import { probeMcpConnector } from "./mcp.ts";
import { probePgConnector } from "./postgres.ts";
import { probeS3Connector } from "./s3.ts";

export type ProbeErrorCode =
  | "credential_missing"
  | "credential_invalid"
  | "credential_expired"
  | "credential_unverified"
  | "scope_insufficient"
  | "remote_api_disabled"
  | "remote_resource_not_found"
  | "connector_disabled"
  | "unknown_upstream_error";

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  error_code?: ProbeErrorCode;
  body_snippet?: string;
  response_headers?: Record<string, string>;
  provider_action_url?: string;
  warning_only?: boolean;
  warnings?: Array<{ code: string; message: string }>;
}

export type DriverProbeResult = Pick<
  ProbeResult,
  "ok" | "latency_ms" | "status" | "detail" | "error_code" | "body_snippet" | "response_headers"
>;

export async function probeConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
  actor_id?: string | null;
  actor_type?: AuditActorType;
}): Promise<ProbeResult> {
  if (!p.connector.enabled) {
    return {
      ok: false,
      latency_ms: 0,
      detail: "this connector is disabled — enable it before probing; nothing was sent",
      error_code: "connector_disabled",
    };
  }
  const result = await probeWithDriver(p);
  if (
    result.ok &&
    p.credential_override === undefined &&
    p.connector.needs_reauth &&
    p.connector.auth_type !== "none"
  ) {
    await clearConnectorReauth(p.db, p.tenant_id, p.connector.id);
  }
  return result;
}

async function probeWithDriver(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
  actor_id?: string | null;
  actor_type?: AuditActorType;
}): Promise<ProbeResult> {
  switch (p.connector.driver) {
    case "http":
      return probeHttpConnector(p);
    case "postgres":
      return probePgConnector(p.connector, p.db);
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
