import { getConfig } from "../../../config/loader.ts";
import type { CredentialUseSnapshot } from "../../../credentials/index.ts";
import type { DecryptedCredential } from "../../../credentials/types.ts";
import type { Db } from "../../../db/client.ts";
import { log } from "../../../logging/logger.ts";
import {
  type AppliedAuthMethod,
  applyAuthMaterial,
  deriveAppliedAuthMethod,
  resolveRespectRobots,
} from "../../core/http-request.ts";
import { assertEgressAllowedResolved, assertRobotsAllowed } from "../../egress-guard.ts";
import { requestUsedStoredCredential } from "../../reauth.ts";
import { connectorMaskedQueryKeys, recordedUrl } from "../../recorded-url.ts";
import { connectorHeaderPolicy, requestHeaderViolations } from "../../request-header-policy.ts";
import { scraperUserAgent } from "../../scraper-user-agent.ts";
import type { ConnectorView } from "../../types.ts";
import { resolveUrl } from "../resolve-url.ts";
import { HttpRequestInvalidError } from "../response-body.ts";
import { resolveConnectorCredential } from "./auth.ts";
import type { ResolvedConnectorCredential } from "./types.ts";

export interface ResolveConnectorRequestParams {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  credential_override?: DecryptedCredential | null;
  idempotency_key?: string;
  redact_log_url?: (url: string) => string;
}

export interface ResolvedRequestPlan {
  credential_snapshot?: CredentialUseSnapshot;
  credential_revision: number | null;
  connection_authority: ResolvedConnectorCredential["connection_authority"];
  url: URL;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  credential: DecryptedCredential | null;
  credential_id: string | null;
  auth_method: AppliedAuthMethod;
  stored_credential_used: boolean;
}

export async function buildRequestPlan(
  p: ResolveConnectorRequestParams,
): Promise<ResolvedRequestPlan> {
  const headers = { ...(p.headers ?? {}) };
  const query = { ...(p.query ?? {}) };
  const resolveOpts: Parameters<typeof resolveConnectorCredential>[0] = {
    db: p.db,
    tenant_id: p.tenant_id,
    connector: p.connector,
  };
  if (p.credential_override !== undefined) {
    resolveOpts.override = p.credential_override;
  }
  const {
    credential,
    credential_id: credentialId,
    credential_revision: credentialRevision,
    connection_authority: connectionAuthority,
    credential_snapshot,
    oauth2_refreshed: oauth2Refreshed,
  } = await resolveConnectorCredential(resolveOpts);
  const violations = requestHeaderViolations(
    headers,
    connectorHeaderPolicy(p.connector, credential),
  );
  if (violations.length > 0)
    throw new HttpRequestInvalidError(
      "request headers conflict with connector authentication",
      "headers",
    );
  applyAuthMaterial(p.connector, credential, headers, query);
  if (p.idempotency_key) {
    headers["Idempotency-Key"] = p.idempotency_key;
  }
  const url = resolveUrl(p.connector.base_url, p.path_or_url);
  const callerQuery = {
    ...Object.fromEntries(url.searchParams),
    ...(p.query ?? {}),
  };
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  const plan: ResolvedRequestPlan = {
    url,
    headers,
    query,
    credential,
    credential_id: credentialId,
    credential_revision: credentialRevision,
    connection_authority: connectionAuthority,
    ...(credential_snapshot ? { credential_snapshot } : {}),
    auth_method: deriveAppliedAuthMethod(credential, oauth2Refreshed),
    stored_credential_used:
      p.credential_override === undefined &&
      requestUsedStoredCredential({
        credential,
        home: p.connector.base_url,
        url,
        caller_headers: p.headers,
        caller_query: callerQuery,
      }),
  };
  await assertEgressAllowedResolved(url, { tenant_id: p.tenant_id, exec: p.db });
  const snapshot = (p.connector.template_snapshot as { respects_robots?: unknown } | null) ?? null;
  if (snapshot?.respects_robots === true) {
    const cfg = getConfig(p.tenant_id).connectors.web_scraper.runtime;
    if (resolveRespectRobots(p.connector.config.respect_robots, cfg.respect_robots)) {
      const userAgent = scraperUserAgent(p.tenant_id, p.connector.config.user_agent);
      headers["User-Agent"] = userAgent;
      await assertRobotsAllowed(url, { tenant_id: p.tenant_id, exec: p.db, userAgent });
    }
  }
  const loggedUrl = recordedUrl(url, connectorMaskedQueryKeys(p.connector.config, credential));
  log.connector.request.planned({
    connector_id: p.connector.id,
    auth_type: p.connector.auth_type,
    url_host: url.host,
    url: p.redact_log_url ? p.redact_log_url(loggedUrl) : loggedUrl,
    has_credential: credential !== null,
    oauth2_refreshed: oauth2Refreshed,
  });
  return plan;
}
