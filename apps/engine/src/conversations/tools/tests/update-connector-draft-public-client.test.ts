import { describe, expect, it } from "bun:test";
import { McpConnectorConfigSchema } from "../../../connectors/config-schemas.ts";
import { findCredentialKeyPath } from "../../credential-shape.ts";

const publicClient = {
  mcp: {
    transport: "http",
    auth: {
      kind: "oauth2",
      issuer: "https://auth.example.test",
      client_id: "public-client-1",
      token_endpoint_auth_method: "none",
    },
  },
};

describe("update_connector_draft — a public OAuth client is plain configuration", () => {
  it("does not treat the client id or its token endpoint auth method as a secret", () => {
    expect(findCredentialKeyPath(publicClient)).toBeNull();
  });

  it("still sends a client secret through the form", () => {
    expect(
      findCredentialKeyPath({
        mcp: { auth: { ...publicClient.mcp.auth, client_secret: "shh" } },
      }),
    ).toBe("mcp.auth.client_secret");
  });

  it("the mcp auth block accepts the public client declaration", () => {
    expect(McpConnectorConfigSchema.safeParse(publicClient).success).toBe(true);
    expect(
      McpConnectorConfigSchema.safeParse({
        mcp: { auth: { kind: "oauth2", token_endpoint_auth_method: "magic" } },
      }).success,
    ).toBe(false);
  });
});
