// Tests for the canonical interactive-MCP-OAuth redirect URI synthesizer.
//
// CRITICAL invariant (fix #1): the redirect_uri the pool's DCR handshake
// registers MUST equal the one the authorize route hands the browser. Both
// paths call `buildMcpOAuthRedirectUri`, so these tests pin that the value
// is the connector origin resolution with the MCP callback path swapped in —
// never the connector callback path.

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
  it("the MCP callback path is distinct from the connector callback path", () => {
    expect(MCP_OAUTH_CALLBACK_PATH).not.toBe(OAUTH_CALLBACK_PATH);
    expect(MCP_OAUTH_CALLBACK_PATH).toBe("/v1/mcp-servers/oauth/callback");
  });

  it("returns null when no public origin resolves", () => {
    expect(buildMcpOAuthRedirectUri()).toBeNull();
  });

  it("uses server.public_base_url + the MCP callback path (no request needed)", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    expect(buildMcpOAuthRedirectUri()).toBe("https://engine.example/v1/mcp-servers/oauth/callback");
  });

  it("swaps ONLY the path — never emits the connector callback path", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    const uri = buildMcpOAuthRedirectUri();
    expect(uri).not.toContain(OAUTH_CALLBACK_PATH);
    expect(new URL(uri!).pathname).toBe(MCP_OAUTH_CALLBACK_PATH);
  });

  it("resolves origin from x-forwarded-* like the connector flow does", () => {
    const req = makeReq("http://localhost:3000/v1/mcp-servers/abc/authorize", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "engine.public.example",
    });
    expect(buildMcpOAuthRedirectUri({ req })).toBe(
      "https://engine.public.example/v1/mcp-servers/oauth/callback",
    );
  });

  it("config origin + request origin agree on the SAME value (DCR vs authorize parity)", async () => {
    // The pool's DCR handshake calls buildMcpOAuthRedirectUri() with no
    // request (config only); the authorize route calls it with the live
    // request. When public_base_url is set both must yield the identical URI.
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    const fromPoolHandshake = buildMcpOAuthRedirectUri();
    const fromAuthorizeRoute = buildMcpOAuthRedirectUri({
      req: makeReq("https://engine.example/v1/mcp-servers/abc/authorize"),
    });
    expect(fromPoolHandshake).toBe(fromAuthorizeRoute);
  });
});
