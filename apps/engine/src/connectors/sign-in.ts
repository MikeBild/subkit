// Where a person signs a connector in with their own account.
//
// Two browser sign-ins exist and they are not interchangeable. An `http`
// (or graphql) connector with `auth_type = oauth2` signs in through
// `POST /v1/connectors/{id}/oauth/start`, which reads a declared issuer and
// client out of the connector or its template. An `mcp` connector with
// `auth_type = oauth2` signs in through `POST /v1/connectors/{id}/mcp/authorize`,
// which discovers the authorization server from the remote and usually
// registers the client itself. Posting one connector to the other route fails.
//
// The connector representation states its own route, so every surface (the
// Cockpit's connector page, its attention list, the CLI) starts the same flow
// without re-deriving it from driver and auth type. A connector that signs in
// with a key, or whose OAuth runs machine to machine (`oauth2_client`,
// `oauth2_private_key`), has no browser sign-in: null.

import type { AuthType, DriverName } from "./types.ts";

export type ConnectorSignInKind = "oauth" | "mcp";

export interface ConnectorSignIn {
  kind: ConnectorSignInKind;
  /** The authenticated POST that answers `{ authorization_url }`. */
  start: string;
}

export function connectorSignIn(connector: {
  id: string;
  driver: DriverName | string;
  auth_type: AuthType | string;
}): ConnectorSignIn | null {
  if (connector.auth_type !== "oauth2") return null;
  const id = encodeURIComponent(connector.id);
  return connector.driver === "mcp"
    ? { kind: "mcp", start: `/v1/connectors/${id}/mcp/authorize` }
    : { kind: "oauth", start: `/v1/connectors/${id}/oauth/start` };
}
