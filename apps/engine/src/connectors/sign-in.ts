// Where a person signs a connector in with their own account.
//
// Two browser sign-ins exist and they are not interchangeable. An `http`
// (or graphql) connector with `auth_type = oauth2` signs in through
// `/v1/connectors/{id}/oauth/start`, which reads a declared issuer and client
// out of the connector or its template. An `mcp` connector with
// `auth_type = oauth2` signs in through `/v1/connectors/{id}/mcp/authorize`,
// which discovers the authorization server from the remote and usually
// registers the client itself. Each route has two doors: an authenticated
// POST that answers `{ authorization_url }`, and a GET that a browser opens
// with a single-use `?grant=skog_…` link minted in a conversation.
//
// This function is THE answer to "can this connector be signed in, and where".
// The connector representation states it (`sign_in`), every surface starts the
// flow it names (the Cockpit, the CLI, the re-sign-in link a conversation
// hands out), and both start routes refuse a connector it does not send to
// them. One predicate, so a route a representation names is never one that
// then refuses the connector.
//
// No browser sign-in (null):
//   - a connector that signs in with a key, or none at all;
//   - OAuth that runs machine to machine (`oauth2_client`,
//     `oauth2_private_key`);
//   - an `oauth2` web service whose grant is Cognito USER_PASSWORD_AUTH
//     (`cognito_user_password`): the engine keeps only the refresh token and
//     the username, so there is no authorization endpoint to send a browser
//     to — its credential is re-issued instead.
// A `client_credentials_json` web service keeps its route: starting it
// exchanges the client credentials at once and answers an empty
// `authorization_url`, because nothing is left for a browser to do.

import { connectorOAuthGrantType } from "./template-binding.ts";
import type { ConnectorView } from "./types.ts";

export type ConnectorSignInKind = "oauth" | "mcp";

export interface ConnectorSignIn {
  kind: ConnectorSignInKind;
  /** The route path. POST it authenticated for `{ authorization_url }`; a
   *  browser GETs it with a single-use `?grant=`. */
  start: string;
}

export function connectorSignIn(
  connector: Pick<ConnectorView, "id" | "driver" | "auth_type" | "config" | "template_snapshot">,
): ConnectorSignIn | null {
  if (connector.auth_type !== "oauth2") return null;
  const id = encodeURIComponent(connector.id);
  if (connector.driver === "mcp") {
    return { kind: "mcp", start: `/v1/connectors/${id}/mcp/authorize` };
  }
  if (connectorOAuthGrantType(connector) === "cognito_user_password") return null;
  return { kind: "oauth", start: `/v1/connectors/${id}/oauth/start` };
}
