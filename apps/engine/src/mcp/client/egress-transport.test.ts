import { afterEach, describe, expect, test } from "bun:test";
import {
  type OAuthClientProvider,
  auth as sdkAuth,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { _withDriverFetchForTests } from "../../connectors/drivers/fetch-seam.ts";
import {
  _withEgressLookupForTests,
  _withEgressTenantOriginForTests,
} from "../../connectors/egress-guard.ts";
import type { Db } from "../../db/client.ts";
import { makeMcpOAuthProvider } from "./oauth-provider.ts";
import type { McpConnectorRow } from "./registry.ts";
import { openMcpSession, setMcpSessionFactoriesForTests } from "./session.ts";
import { fetchWithMcpOAuth } from "./session-auth.ts";

const db = {} as Db;
const tenant_id = "00000000-0000-4000-8000-000000000001";
const row: McpConnectorRow = {
  id: "00000000-0000-4000-8000-000000000002",
  tenant_id,
  slug: "remote",
  display_name: "Remote",
  transport: "http",
  url: "https://remote.example.test/mcp",
  auth: { kind: "none" },
  environment: "prod",
  enabled: true,
};

function hosted<T>(run: () => Promise<T>) {
  return _withEgressTenantOriginForTests(
    async () => "self_service",
    () => _withEgressLookupForTests(async () => [{ address: "8.8.8.8", family: 4 }], run),
  );
}

function mockFetch(run: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      run(new URL(String(input)), init),
    { preconnect: () => {} },
  ) as typeof fetch;
}

afterEach(() => setMcpSessionFactoriesForTests(null));

describe("hosted MCP transport", () => {
  test("database OAuth discovery uses a pinned target with the original host", async () => {
    const seen: string[] = [];
    const provider = makeMcpOAuthProvider({
      db,
      tenant_id,
      connector_id: row.id,
      environment: "prod",
      redirect_uri: "https://engine.example.test/callback",
      state: "fixture",
      auth: { kind: "oauth2" },
      interactive: false,
      request_source: "api",
    });
    await hosted(() =>
      _withDriverFetchForTests(
        mockFetch((url, init) => {
          seen.push(url.hostname);
          expect(new Headers(init?.headers).get("host")).toBe("issuer.example.test");
          return Response.json({ issuer: "https://issuer.example.test" });
        }),
        async () => {
          const response = await provider.fetch(
            "https://issuer.example.test/.well-known/oauth-authorization-server",
          );
          expect(response.url).toBe(
            "https://issuer.example.test/.well-known/oauth-authorization-server",
          );
          expect(response.status).toBe(200);
        },
      ),
    );
    expect(seen).toEqual(["8.8.8.8"]);
  });

  test("machine OAuth fetch refuses a private metadata or token address before transport", async () => {
    let calls = 0;
    await hosted(() =>
      _withDriverFetchForTests(
        mockFetch(() => {
          calls++;
          return Response.json({});
        }),
        async () => {
          await expect(
            fetchWithMcpOAuth(
              {} as OAuthClientProvider,
              "https://127.0.0.1/token",
              { method: "POST", body: "client_secret=fixture" },
              { tenant_id, exec: db },
            ),
          ).rejects.toThrow("private_ip_blocked");
        },
      ),
    );
    expect(calls).toBe(0);
  });

  test("SDK client-credentials discovery cannot send a secret to a private token endpoint", async () => {
    const provider = new ClientCredentialsProvider({
      expectedIssuer: "https://issuer.example.test",
      clientId: "fixture-client",
      clientSecret: "secret-canary",
    });
    const paths: string[] = [];
    await hosted(() =>
      _withDriverFetchForTests(
        mockFetch((url) => {
          paths.push(url.pathname);
          if (url.pathname.includes("oauth-protected-resource"))
            return Response.json({
              resource: row.url,
              authorization_servers: ["https://issuer.example.test"],
            });
          return Response.json({
            issuer: "https://issuer.example.test",
            authorization_endpoint: "https://issuer.example.test/authorize",
            token_endpoint: "https://127.0.0.1/token",
            response_types_supported: ["code"],
            grant_types_supported: ["client_credentials"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
          });
        }),
        async () => {
          await expect(
            sdkAuth(provider, {
              serverUrl: row.url,
              fetchFn: (target, init) =>
                fetchWithMcpOAuth(provider, target, init, { tenant_id, exec: db }),
            }),
          ).rejects.toThrow("private_ip_blocked");
        },
      ),
    );
    expect(paths.some((path) => path.includes("oauth-authorization-server"))).toBe(true);
    expect(paths).not.toContain("/token");
  });

  test("a private DNS answer after preflight blocks the actual SDK dispatch", async () => {
    let lookups = 0;
    let calls = 0;
    await _withEgressTenantOriginForTests(
      async () => "self_service",
      () =>
        _withEgressLookupForTests(
          async () => [{ address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
          () =>
            _withDriverFetchForTests(
              mockFetch(() => {
                calls++;
                return Response.json({});
              }),
              async () => {
                await expect(openMcpSession(db, tenant_id, row, "prod", "api")).rejects.toThrow(
                  "private_ip_resolved",
                );
              },
            ),
        ),
    );
    expect(lookups).toBeGreaterThan(1);
    expect(calls).toBe(0);
  });

  for (const transport of ["http", "sse"] as const) {
    test(`${transport} SDK transport refuses a private redirect on its actual network callback`, async () => {
      let calls = 0;
      await hosted(() =>
        _withDriverFetchForTests(
          mockFetch((url, init) => {
            calls++;
            expect(url.hostname).toBe("8.8.8.8");
            if (transport === "sse")
              expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
            return new Response(null, {
              status: 302,
              headers: { location: "https://127.0.0.1/private" },
            });
          }),
          async () => {
            await expect(
              openMcpSession(db, tenant_id, { ...row, transport }, "prod", "api"),
            ).rejects.toThrow();
          },
        ),
      );
      expect(calls).toBe(1);
    });
  }
});
