import { expect, test } from "bun:test";
import {
  validateConnectorAuthType,
  validateMcpAuthConsistency,
  validateSignedJwtAuthConfig,
} from "./config-policy.ts";

test("MCP transport preserves every declared authentication mapping", () => {
  const mappings = [
    ["none", "none"],
    ["bearer", "bearer"],
    ["basic", "basic"],
    ["header", "header"],
    ["oauth2", "oauth2"],
    ["oauth2_client", "oauth2_client_credentials"],
    ["oauth2_private_key", "oauth2_private_key_jwt"],
  ] as const;
  for (const [type, kind] of mappings) {
    expect(validateConnectorAuthType("mcp", type)).toEqual([]);
    expect(validateMcpAuthConsistency("mcp", type, { mcp: { auth: { kind } } })).toEqual([]);
    expect(validateMcpAuthConsistency("mcp", type, { mcp: { auth: {} } })).toEqual([
      {
        path: "config.mcp.auth.kind",
        message: `config.mcp.auth.kind 'undefined' does not match auth_type '${type}' (expected '${kind}')`,
      },
    ]);
  }
});

test("absent and unsupported authentication retain the public diagnostics", () => {
  for (const missing of [undefined, null]) {
    expect(validateConnectorAuthType("mcp", missing)).toEqual([]);
    expect(validateMcpAuthConsistency("mcp", missing, {})).toEqual([]);
  }
  expect(validateConnectorAuthType("mcp", "query")).toEqual([
    {
      path: "auth_type",
      message:
        "auth_type 'query' is not supported by the mcp transport — use none, bearer, basic, header, oauth2, oauth2_client, or oauth2_private_key",
    },
  ]);
  expect(validateMcpAuthConsistency("mcp", "query", {})).toEqual([]);
  expect(validateConnectorAuthType("http", "bearer")).toEqual([]);
  expect(validateConnectorAuthType("graphql", "signed_jwt")).toEqual([]);
  expect(validateConnectorAuthType("s3", "signed_jwt")).toEqual([
    {
      path: "auth_type",
      message: "auth_type 'signed_jwt' is supported only by http and graphql connectors",
    },
  ]);
  for (const type of ["oauth2_client", "oauth2_private_key"] as const) {
    expect(validateConnectorAuthType("http", type)).toEqual([
      {
        path: "auth_type",
        message: `auth_type '${type}' is only declarable by an mcp connector — it identifies an OAuth2 client to a token endpoint and is never applied to a http request`,
      },
    ]);
  }
});

test("untrusted MCP configuration shapes produce actionable field errors", () => {
  for (const block of [undefined, null, false, 0, "mcp", [], () => undefined]) {
    expect(validateMcpAuthConsistency("mcp", "bearer", { mcp: block })).toEqual([
      { path: "config.mcp", message: "config.mcp is required for an mcp connector" },
    ]);
  }
  for (const auth of [undefined, null, false, 0, "bearer", [], () => undefined]) {
    expect(validateMcpAuthConsistency("mcp", "bearer", { mcp: { auth } })).toEqual([
      {
        path: "config.mcp.auth.kind",
        message: "config.mcp.auth.kind must be 'bearer' for auth_type 'bearer'",
      },
    ]);
  }
});

test("signed JWT errors distinguish missing configuration, nested claims and OAuth mixing", () => {
  for (const config of [undefined, null, {}]) {
    expect(validateSignedJwtAuthConfig("signed_jwt", config)).toEqual([
      { path: "config.signed_jwt", message: "Invalid input: expected object, received undefined" },
    ]);
  }
  const signed_jwt = { algorithm: "ES256", audience: "api" };
  expect(validateSignedJwtAuthConfig("signed_jwt", { signed_jwt })).toEqual([]);
  expect(validateSignedJwtAuthConfig("signed_jwt", { signed_jwt, oauth: null })).toEqual([
    {
      path: "config.oauth",
      message: "signed_jwt authentication does not use OAuth token exchange configuration",
    },
  ]);
  expect(
    validateSignedJwtAuthConfig("signed_jwt", {
      signed_jwt: { ...signed_jwt, claims: { iss: "unexpected" } },
    }),
  ).toEqual([
    {
      path: "config.signed_jwt.claims.iss",
      message: "claims.iss is a registered JWT claim and must be configured explicitly",
    },
  ]);
});
