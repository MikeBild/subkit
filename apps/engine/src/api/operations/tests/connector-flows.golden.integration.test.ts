import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../../credentials/oauth2/tests/mock-server.ts";
import { __setSdkAuthForTests } from "../../../mcp/client/sdk-auth.ts";
import { seedConnector, seedTimestamp, seedUuid } from "../../../test-helpers/seed.ts";
import {
  type ConnectorWorld,
  call,
  connectorAuditTrail,
  GoldenRecorder,
  seedConnectorWorld,
} from "./connector-golden-world.ts";

const GOLDEN_PATH = new URL("./fixtures/connector-flows.golden.json", import.meta.url).pathname;
const AS_AUTHORIZE = "https://as.golden.example.test/authorize?client_id=golden-client";
let w: ConnectorWorld;
let broken: Server;
let brokenBaseUrl = "http://127.0.0.1:0";
let oauthMock: MockOAuthServer;
let publicBaseUrlBefore = "";
const encoded = (url: string) => encodeURIComponent(url);
const golden = new GoldenRecorder(
  GOLDEN_PATH,
  () => w,
  (text) =>
    text
      .replaceAll(encoded(w.ctx.baseUrl), "<base-encoded>")
      .replaceAll(brokenBaseUrl, "<broken>")
      .replaceAll(brokenBaseUrl.replace("http://", ""), "<broken-host>")
      .replaceAll(oauthMock.baseUrl, "<oauth>")
      .replace(/state=[^&"\\]+/g, "state=<state>")
      .replace(/"state":"[^"<]+"/g, '"state":"<state>"'),
);
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const PLAIN = seedUuid("connector", 501);
const WEB_OAUTH = seedUuid("connector", 502);
const WEB_BROKEN = seedUuid("connector", 503);
const MCP_PLAIN = seedUuid("connector", 504);
const MCP_DISABLED = seedUuid("connector", 505);
const MCP_OAUTH = seedUuid("connector", 506);
const MCP_BROKEN = seedUuid("connector", 507);

function mcpConfig(kind: "none" | "oauth2") {
  return { mcp: { transport: "http", ...(kind === "oauth2" ? { auth: { kind } } : {}) } };
}

beforeAll(async () => {
  w = await seedConnectorWorld("operations_connector_flows_golden");
  publicBaseUrlBefore = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", w.ctx.baseUrl, { force: true });
  oauthMock = await startMockOAuthServer();
  broken = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream broken");
    });
  });
  await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", () => resolve()));
  const address = broken.address();
  brokenBaseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const seeds = [
    { id: PLAIN, slug: "flows-plain", driver: "http", auth_type: "none", config: {} },
    {
      id: WEB_OAUTH,
      slug: "flows-web-oauth",
      driver: "http",
      auth_type: "oauth2",
      config: {
        oauth: {
          issuer_url: oauthMock.baseUrl,
          authorization_endpoint: `${oauthMock.baseUrl}/authorize`,
          token_endpoint: `${oauthMock.baseUrl}/token`,
          client_id: "golden-client",
          client_secret: "golden-secret",
          scope: "read",
          use_pkce: false,
        },
      },
    },
    {
      id: WEB_BROKEN,
      slug: "flows-web-broken",
      driver: "http",
      auth_type: "oauth2",
      config: { oauth: { issuer_url: brokenBaseUrl, client_id: "golden-client" } },
    },
    {
      id: MCP_PLAIN,
      slug: "flows-mcp-plain",
      driver: "mcp",
      auth_type: "none",
      base_url: `${brokenBaseUrl}/mcp`,
      config: mcpConfig("none"),
    },
    {
      id: MCP_DISABLED,
      slug: "flows-mcp-disabled",
      driver: "mcp",
      auth_type: "none",
      base_url: `${brokenBaseUrl}/mcp`,
      config: mcpConfig("none"),
      enabled: false,
    },
    {
      id: MCP_OAUTH,
      slug: "flows-mcp-oauth",
      driver: "mcp",
      auth_type: "oauth2",
      base_url: "https://flows-mcp.example.test/mcp",
      config: mcpConfig("oauth2"),
    },
    {
      id: MCP_BROKEN,
      slug: "flows-mcp-broken",
      driver: "mcp",
      auth_type: "oauth2",
      base_url: `${brokenBaseUrl}/mcp`,
      config: mcpConfig("oauth2"),
    },
  ] as const;
  for (const [index, seed] of seeds.entries()) {
    await seedConnector(w.ctx.db, {
      tenant_id: w.ctx.tenantId,
      display_name: seed.slug,
      base_url: "https://flows.example.test",
      ...seed,
      created_at: seedTimestamp(501 + index),
      updated_at: seedTimestamp(501 + index),
    });
  }
});

afterAll(async () => {
  __setSdkAuthForTests(null);
  await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
  broken.close();
  await oauthMock.close();
  await w.ctx.cleanup();
});

describe("connector flow routes keep their HTTP responses byte for byte", () => {
  test("validate a definition", async () => {
    const path = "/v1/connectors/validate";
    golden.record(
      "http.validate.ok",
      await call(w, "POST", path, {
        name: "Widgets",
        driver: "http",
        base_url: "https://widgets.example.test",
      }),
    );
    golden.record(
      "http.validate.issues",
      await call(w, "POST", path, {
        name: "Remote tools",
        driver: "mcp",
        base_url: "https://tools.example.test/mcp",
        auth_type: "signed_jwt",
        config: { mcp: { transport: "carrier-pigeon" } },
      }),
    );
    golden.record(
      "http.validate.malformed",
      await call(w, "POST", path, { driver: "telepathy", base_url: "not a url" }),
    );
    golden.record("http.validate.not-an-object", await call(w, "POST", path, ["x"]));
    golden.record(
      "http.validate.writer",
      await call(w, "POST", path, { name: "Widgets", driver: "http" }, w.writerKey),
    );
    golden.record(
      "http.validate.denied",
      await call(w, "POST", path, { name: "Widgets", driver: "http" }, w.deniedKey),
    );
    golden.record(
      "http.validate.unauthenticated",
      await call(w, "POST", path, { name: "Widgets", driver: "http" }, "wf_live_unknown"),
    );
  });

  test("inspect an mcp connector", async () => {
    const inspect = (id: string, key?: string) =>
      call(w, "POST", `/v1/connectors/${id}/mcp/inspect`, undefined, key);
    golden.record("http.inspect.upstream-broken", await inspect(MCP_PLAIN));
    golden.record("http.inspect.disabled", await inspect(MCP_DISABLED));
    golden.record("http.inspect.not-mcp", await inspect(PLAIN));
    golden.record("http.inspect.missing", await inspect(MISSING));
    golden.record("http.inspect.invalid-id", await inspect("not-a-uuid"));
    golden.record("http.inspect.denied", await inspect(MCP_PLAIN, w.deniedKey));
  });

  test("begin an mcp authorization", async () => {
    const authorize = (id: string, key?: string) =>
      call(w, "POST", `/v1/connectors/${id}/mcp/authorize`, undefined, key);
    __setSdkAuthForTests((async (provider: OAuthClientProvider) => {
      await provider.saveCodeVerifier("verifier-from-golden");
      await provider.redirectToAuthorization(new URL(AS_AUTHORIZE));
      return "REDIRECT";
    }) as unknown as Parameters<typeof __setSdkAuthForTests>[0]);
    golden.record("http.authorize.started", await authorize(MCP_OAUTH));
    __setSdkAuthForTests(null);
    golden.record("http.authorize.upstream-broken", await authorize(MCP_BROKEN));
    golden.record("http.authorize.no-sign-in", await authorize(MCP_PLAIN));
    golden.record("http.authorize.web-route", await authorize(WEB_OAUTH));
    golden.record("http.authorize.plain", await authorize(PLAIN));
    golden.record("http.authorize.missing", await authorize(MISSING));
    golden.record("http.authorize.denied", await authorize(MCP_OAUTH, w.deniedKey));
    golden.record("http.authorize.writer", await authorize(MCP_BROKEN, w.writerKey));
  });

  test("begin an oauth sign-in", async () => {
    const start = (id: string, key?: string) =>
      call(w, "POST", `/v1/connectors/${id}/oauth/start`, undefined, key);
    golden.record("http.oauth-start.started", await start(WEB_OAUTH));
    golden.record("http.oauth-start.upstream-broken", await start(WEB_BROKEN));
    golden.record("http.oauth-start.mcp-route", await start(MCP_OAUTH));
    golden.record("http.oauth-start.no-sign-in", await start(PLAIN));
    golden.record("http.oauth-start.missing", await start(MISSING));
    golden.record("http.oauth-start.denied", await start(WEB_OAUTH, w.deniedKey));
  });

  test("import a connector draft from a specification", async () => {
    const path = "/v1/connector-templates/import";
    golden.record(
      "http.template-import.curl",
      await call(w, "POST", path, {
        source: "curl",
        content: "curl -H 'Authorization: Bearer abc' https://widgets.example.test/v1/widgets",
      }),
    );
    golden.record(
      "http.template-import.upstream-broken",
      await call(w, "POST", path, { source: "openapi", content: `${brokenBaseUrl}/openapi.json` }),
    );
    golden.record(
      "http.template-import.unparseable",
      await call(w, "POST", path, { source: "openapi", content: "{ not json" }),
    );
    golden.record(
      "http.template-import.invalid",
      await call(w, "POST", path, { source: "telepathy", content: "x" }),
    );
    golden.record(
      "http.template-import.denied",
      await call(w, "POST", path, { source: "curl", content: "curl https://x.test" }, w.deniedKey),
    );
  });

  test("audit trail", async () => {
    golden.record("http.audit", await connectorAuditTrail(w));
  });

  test("the golden file has no stale entries", () => {
    const { actual, golden: expected } = golden.keys();
    expect(actual).toEqual(expected);
  });
});
