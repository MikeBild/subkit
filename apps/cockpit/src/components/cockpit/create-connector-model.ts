import type { components } from "@/api/schema";

type CreateConnectorBody = components["schemas"]["CreateConnectorBody"];

/**
 * A connector by hand answers two separate questions. First what it connects:
 * a service over its web interface (the `http` driver) or an MCP server.
 */
export type ConnectorTarget = "web" | "mcp";

/**
 * Then how SubKit signs in there: with the reader's own account (OAuth — the
 * service asks them to allow it), with an access key the service hands out,
 * or not at all. Both drivers take all three.
 */
export type ConnectorSignIn = "account" | "key" | "none";

/** Only a key is typed into the form; an account is approved at the service. */
export function needsSecret(signIn: ConnectorSignIn): boolean {
  return signIn === "key";
}

const AUTH_TYPE: Record<ConnectorSignIn, CreateConnectorBody["auth_type"]> = {
  account: "oauth2",
  key: "bearer",
  none: "none",
};

/** The create request: the engine's own fields, nothing the form did not ask. */
export function connectorCreateBody(p: {
  target: ConnectorTarget;
  signIn: ConnectorSignIn;
  name: string;
  slug: string;
  address: string;
}): CreateConnectorBody {
  return {
    name: p.name.trim(),
    slug: p.slug,
    driver: p.target === "mcp" ? "mcp" : "http",
    environment: "prod",
    base_url: p.address.trim(),
    auth_type: AUTH_TYPE[p.signIn],
  };
}

/**
 * Where the reader goes once the connector exists. An account sign-in starts
 * at once — an MCP server through its own authorization discovery, a web
 * service through the connector's OAuth start; an MCP server otherwise opens
 * on its tools, a web service on its connection.
 */
export function afterCreate(
  target: ConnectorTarget,
  signIn: ConnectorSignIn,
): { signInPath: "oauth/start" | "mcp/authorize" | null; tab: "werkzeuge" | "verbindung" } {
  const tab = target === "mcp" ? "werkzeuge" : "verbindung";
  if (signIn !== "account") return { signInPath: null, tab };
  return { signInPath: target === "mcp" ? "mcp/authorize" : "oauth/start", tab };
}
