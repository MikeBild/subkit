import type { DecryptedCredential } from "../credentials/types.ts";
import type { ConnectorView } from "./types.ts";

export interface ConnectorHeaderPolicy {
  allowAuthorization: boolean;
  ownedHeaders: ReadonlySet<string>;
}

export function connectorHeaderPolicy(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
): ConnectorHeaderPolicy {
  const ownedHeaders = new Set<string>();
  for (const field of ["static_headers", "default_headers"]) {
    const headers = connector.config?.[field];
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      for (const name of Object.keys(headers)) ownedHeaders.add(name.toLowerCase());
    }
  }
  if (credential?.mode === "header") {
    for (const name of Object.keys(credential.headers)) ownedHeaders.add(name.toLowerCase());
  }
  const compatible =
    (connector.auth_type === "none" && (!credential || credential.mode === "none")) ||
    (connector.auth_type === "header" && credential?.mode === "header") ||
    (connector.auth_type === "query" && credential?.mode === "query");
  if (!compatible) ownedHeaders.add("authorization");
  return {
    allowAuthorization:
      (connector.driver === "http" || connector.driver === "graphql") &&
      compatible &&
      !ownedHeaders.has("authorization"),
    ownedHeaders,
  };
}

export function requestHeaderViolations(
  headers: Record<string, unknown>,
  policy?: ConnectorHeaderPolicy,
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (
      seen.has(lower) ||
      lower === "cookie" ||
      lower === "proxy-authorization" ||
      policy?.ownedHeaders.has(lower) ||
      (lower === "authorization" && !policy?.allowAuthorization)
    )
      violations.push(name);
    seen.add(lower);
  }
  return violations;
}
