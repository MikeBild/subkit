// The canonical interactive-MCP-OAuth redirect URI.
//
// CRITICAL invariant, and the reason this file exists: the redirect_uri the
// pool's non-interactive DCR handshake registers MUST equal the one the
// authorize route hands the operator's browser. Both go through
// `buildMcpOAuthRedirectUri`, so what has to be pinned is that the function
// yields the same value from a config-only call (the handshake, which has no
// request) as from a request-derived one (the route), and that it swaps ONLY
// the path — emitting the connector callback path instead would collide two
// flows an operator is meant to be able to allowlist separately.
//
// The literal path is asserted because it moved when the MCP surface became
// part of `/v1/connectors`: the route that serves the callback and the value
// registered with the authorization server are two different files, and
// nothing but this assertion holds them together.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { OAUTH_CALLBACK_PATH } from "../../credentials/index.ts";
import { buildMcpOAuthRedirectUri, MCP_OAUTH_CALLBACK_PATH } from "./oauth-redirect.ts";

function makeReq(url: string, headers: Record<string, string> = {}) {
  return { url, headers: new Headers(headers) };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-mcp-redirect-uri-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/mcp-redirect-uri-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
});

afterAll(() => {
  _resetConfigForTests();
});

beforeEach(async () => {
  await setConfigKey("server.public_base_url", "", { force: true });
});

afterEach(async () => {
  await setConfigKey("server.public_base_url", "", { force: true });
});

describe("buildMcpOAuthRedirectUri", () => {
  it("the MCP callback path lives under the connectors surface and is distinct from the connector callback", () => {
    // The route that serves it is registered at this exact path by
    // http/routes/connectors/mcp.ts, and `RESERVED_CONNECTOR_SEGMENTS` in
    // http/routes/connectors/index.ts keeps `mcp` from being read as a
    // connector id — both would break silently if this value drifted.
    expect(MCP_OAUTH_CALLBACK_PATH).not.toBe(OAUTH_CALLBACK_PATH);
    expect(MCP_OAUTH_CALLBACK_PATH).toBe("/v1/connectors/mcp/oauth/callback");
  });

  it("returns null when no public origin resolves", () => {
    expect(buildMcpOAuthRedirectUri()).toBeNull();
  });

  it("uses server.public_base_url + the MCP callback path (no request needed)", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    expect(buildMcpOAuthRedirectUri()).toBe(
      "https://engine.example/v1/connectors/mcp/oauth/callback",
    );
  });

  it("swaps ONLY the path — never emits the connector callback path", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    const uri = buildMcpOAuthRedirectUri();
    expect(uri).not.toContain(OAUTH_CALLBACK_PATH);
    expect(new URL(uri!).pathname).toBe(MCP_OAUTH_CALLBACK_PATH);
  });

  it("resolves origin from x-forwarded-* like the connector flow does", () => {
    const req = makeReq("http://localhost:3000/v1/connectors/abc/mcp/authorize", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "engine.public.example",
    });
    expect(buildMcpOAuthRedirectUri({ req })).toBe(
      "https://engine.public.example/v1/connectors/mcp/oauth/callback",
    );
  });

  it("config origin + request origin agree on the SAME value (DCR vs authorize parity)", async () => {
    // The pool's DCR handshake calls buildMcpOAuthRedirectUri() with no
    // request (config only); the authorize route calls it with the live
    // request. When public_base_url is set both must yield the identical URI,
    // or the IdP rejects the authorization request with redirect_uri_mismatch.
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    const fromPoolHandshake = buildMcpOAuthRedirectUri();
    const fromAuthorizeRoute = buildMcpOAuthRedirectUri({
      req: makeReq("https://engine.example/v1/connectors/abc/mcp/authorize"),
    });
    expect(fromPoolHandshake).toBe(fromAuthorizeRoute);
  });
});
