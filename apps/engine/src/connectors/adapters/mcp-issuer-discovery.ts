import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Executor } from "../../db/index.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
import { guardedFetch } from "../egress-fetch.ts";
import type { EgressGuardContext } from "../egress-guard.ts";
import { connectorLocalScope } from "../local-egress.ts";

export type McpIssuerDiscovery =
  | { ok: true; issuer: string }
  | { ok: false; reason: "metadata_missing" | "discovery_failed"; detail: string | null };

export async function discoverMcpOAuthIssuer(p: {
  tenant_id: string;
  exec: Executor;
  base_url: string;
  config?: unknown;
}): Promise<McpIssuerDiscovery> {
  const local_mcp = connectorLocalScope({ base_url: p.base_url, config: p.config });
  const context: EgressGuardContext = {
    tenant_id: p.tenant_id,
    exec: p.exec,
    ...(local_mcp ? { local_mcp } : {}),
  };
  try {
    const info = await discoverOAuthServerInfo(p.base_url, {
      fetchFn: guardedFetch(context, getDriverFetch()),
    });
    return info.authorizationServerMetadata
      ? { ok: true, issuer: String(info.authorizationServerUrl) }
      : { ok: false, reason: "metadata_missing", detail: null };
  } catch (err) {
    return {
      ok: false,
      reason: "discovery_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
