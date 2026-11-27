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

export interface OptionalAuthScheme {
  name: string;
  type: DiscoveredAuthScheme["type"];
  location?: DiscoveredAuthScheme["location"];
  scheme?: string;
}

export function optionalAuthSchemes(allSchemes: DiscoveredAuthScheme[]): OptionalAuthScheme[] {
  return allSchemes
    .filter((scheme) => scheme.required === false)
    .map((scheme) => ({
      name: scheme.name,
      type: scheme.type,
      ...(scheme.location ? { location: scheme.location } : {}),
      ...(scheme.scheme ? { scheme: scheme.scheme } : {}),
    }));
}

export function recognizeAuthFromSchemes(
  allSchemes: DiscoveredAuthScheme[],
): RecognizedAuth | null {
  const schemes = allSchemes.filter((scheme) => scheme.required !== false);
  if (schemes.length === 0) return null;

  for (const scheme of schemes) {
    if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
      const oauthBlock = scheme.flows ? buildOAuthBlock(scheme.flows) : undefined;
      const result: RecognizedAuth = { auth_type: "oauth2", scheme_name: scheme.name };
      if (oauthBlock !== undefined) result.oauth = oauthBlock;
      return result;
    }
  }

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
