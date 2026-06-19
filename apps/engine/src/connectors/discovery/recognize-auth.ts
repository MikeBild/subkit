// Pure, deterministic auth-method recognition from a DiscoveryResult's
// auth_schemes array. No DB, no LLM, no network — just structural
// inspection of what the spec declared in its securitySchemes section.
//
// Preference order (highest wins):
//   1. oauth2 / openIdConnect — most specific; carries endpoint metadata.
//   2. http bearer / basic — common REST patterns.
//   3. apiKey — header vs. query distinguished by `location`.
//   4. null — no usable scheme found.
//
// The returned `oauth` block is intentionally minimal: only the fields
// OAuthEnrichmentSchema recognises (issuer_url, authorization_endpoint,
// token_endpoint, scope, grant_type). Callers seed `config.oauth` from
// this; the OAuth2 client reads the rest from the template snapshot at
// mint time.

import type { AuthType } from "../types.ts";
import type { DiscoveredAuthScheme, DiscoveredAuthSchemeOAuth2Flow } from "./types.ts";

export interface RecognizedAuth {
  auth_type: AuthType;
  scheme_name: string;
  oauth?: {
    authorization_endpoint?: string;
    token_endpoint?: string;
    scope?: string;
    grant_type: "authorization_code" | "client_credentials";
  };
}

// Flow preference: authorizationCode > clientCredentials > implicit > password.
// grant_type mapping follows the OAuth2 spec — implicit is authorization_code
// because it doesn't use the token endpoint directly but the same interactive
// user-consent pattern (the browser dance) as auth-code flows.
const FLOW_ORDER = ["authorizationCode", "clientCredentials", "implicit", "password"] as const;

type FlowName = (typeof FLOW_ORDER)[number];

function grantTypeForFlow(flow: FlowName): "authorization_code" | "client_credentials" {
  if (flow === "clientCredentials") return "client_credentials";
  return "authorization_code";
}

function pickBestFlow(
  flows: Record<string, DiscoveredAuthSchemeOAuth2Flow>,
): { name: FlowName; flow: DiscoveredAuthSchemeOAuth2Flow } | null {
  for (const name of FLOW_ORDER) {
    if (Object.hasOwn(flows, name)) {
      const flow = flows[name];
      if (flow !== undefined) return { name, flow };
    }
  }
  return null;
}

function buildOAuthBlock(
  flows: Record<string, DiscoveredAuthSchemeOAuth2Flow> | undefined,
): RecognizedAuth["oauth"] | undefined {
  if (!flows) return undefined;
  const picked = pickBestFlow(flows);
  if (!picked) return undefined;
  const { name, flow } = picked;
  const scope =
    flow.scopes && Object.keys(flow.scopes).length > 0
      ? Object.keys(flow.scopes).join(" ")
      : undefined;
  return {
    ...(flow.authorization_url ? { authorization_endpoint: flow.authorization_url } : {}),
    ...(flow.token_url ? { token_endpoint: flow.token_url } : {}),
    ...(scope ? { scope } : {}),
    grant_type: grantTypeForFlow(name),
  };
}

/**
 * Map a list of discovered security schemes to a single authoritative
 * auth type. Returns `null` when no scheme is usable.
 *
 * Preference: oauth2/openIdConnect > http > apiKey. When multiple
 * schemes of equal priority exist, the first in the array wins.
 */
export function recognizeAuthFromSchemes(schemes: DiscoveredAuthScheme[]): RecognizedAuth | null {
  if (schemes.length === 0) return null;

  // Pass 1: prefer oauth2 / openIdConnect — they carry the richest metadata.
  for (const scheme of schemes) {
    if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
      // openIdConnect may carry flows if the spec is generous; otherwise
      // we know it's OAuth2 but have no endpoint metadata.
      const oauthBlock = scheme.flows ? buildOAuthBlock(scheme.flows) : undefined;
      const result: RecognizedAuth = { auth_type: "oauth2", scheme_name: scheme.name };
      if (oauthBlock !== undefined) result.oauth = oauthBlock;
      return result;
    }
  }

  // Pass 2: http bearer / basic.
  for (const scheme of schemes) {
    if (scheme.type === "http") {
      const lower = (scheme.scheme ?? "").toLowerCase();
      if (lower === "bearer") {
        return { auth_type: "bearer", scheme_name: scheme.name };
      }
      if (lower === "basic") {
        return { auth_type: "basic", scheme_name: scheme.name };
      }
    }
  }

  // Pass 3: apiKey — location determines header vs. query.
  for (const scheme of schemes) {
    if (scheme.type === "apiKey") {
      if (scheme.location === "header") {
        return { auth_type: "header", scheme_name: scheme.name };
      }
      if (scheme.location === "query") {
        return { auth_type: "query", scheme_name: scheme.name };
      }
    }
  }

  return null;
}
