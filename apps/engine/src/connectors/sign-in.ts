import { connectorOAuthGrantType } from "./template-binding.ts";
import type { ConnectorView } from "./types.ts";

type ConnectorSignInKind = "oauth" | "mcp";

export interface ConnectorSignIn {
  kind: ConnectorSignInKind;
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
