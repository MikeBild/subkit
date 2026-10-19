import { expect, test } from "bun:test";
import { _withDriverFetchForTests } from "../connectors/drivers/fetch-seam.ts";
import {
  _withEgressLookupForTests,
  _withEgressTenantOriginForTests,
} from "../connectors/egress-guard.ts";
import type { Db } from "../db/client.ts";
import { discoverService } from "./connections/discovery.ts";
import { postTokenEndpoint, registerClient } from "./connections/oauth-client.ts";
import {
  dynamicallyRegisterClient,
  runClientCredentialsGrant,
  runClientCredentialsJsonGrant,
} from "./oauth2/client.ts";
import { runTokenMintGrant } from "./token-mint/client.ts";

const exec = {} as Db;
const hostedContext = { tenant_id: "hosted-fixture", exec, mode: "permissive" as const };
function boundary<T>(fetchImpl: typeof fetch, run: () => Promise<T>) {
  return _withEgressTenantOriginForTests(
    async (tenant) => (tenant === "selfhost-fixture" ? "self_hosted" : "self_service"),
    () =>
      _withEgressLookupForTests(
        async () => [{ address: "8.8.8.8", family: 4 }],
        () => _withDriverFetchForTests(fetchImpl, run),
      ),
  );
}
function fakeFetch(run: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      run(new URL(String(input)), init),
    { preconnect: () => {} },
  ) as typeof fetch;
}

test("OAuth configuration cache cannot reuse a selfhost transport context for hosted grants", async () => {
  let calls = 0;
  const cfg = {
    issuer_url: "https://issuer.example.test",
    authorization_endpoint: "https://issuer.example.test/authorize",
    token_endpoint: "https://127.0.0.1/token",
    client_id: "shared-client",
    client_secret: "secret-canary",
  };
  await boundary(
    fakeFetch(() => {
      calls++;
      return Response.json({ access_token: "fixture-token", token_type: "Bearer" });
    }),
    async () => {
      expect(
        (
          await runClientCredentialsGrant(cfg, {
            tenant_id: "selfhost-fixture",
            exec,
            mode: "permissive",
          })
        ).access_token,
      ).toBe("fixture-token");
      await expect(runClientCredentialsGrant(cfg, hostedContext)).rejects.toThrow(
        "credential_egress_blocked",
      );
    },
  );
  expect(calls).toBe(1);
});

test("JSON grants and token-mint secrets cannot reach private addresses", async () => {
  let calls = 0;
  await boundary(
    fakeFetch(() => {
      calls++;
      return Response.json({});
    }),
    async () => {
      await expect(
        runClientCredentialsJsonGrant(
          {
            token_endpoint: "https://127.0.0.1/token",
            body_mapping: { client_secret: "secret-canary" },
            response_format: "raw",
            token_response_ttl_ms: 1000,
          },
          hostedContext,
        ),
      ).rejects.toThrow("credential_egress_blocked");
      await expect(
        runTokenMintGrant(
          {
            shape: "json",
            mint_endpoint: "https://127.0.0.1/mint",
            credentials: {
              username: "fixture",
              password: "fixture",
              client_secret: "secret-canary",
            },
            token_path: "access_token",
          },
          hostedContext,
        ),
      ).rejects.toThrow("credential_egress_blocked");
    },
  );
  expect(calls).toBe(0);
});

test("connection discovery and registration refuse private destinations before transport", async () => {
  let calls = 0;
  await boundary(
    fakeFetch(() => {
      calls++;
      return Response.json({});
    }),
    async () => {
      await expect(discoverService("https://127.0.0.1", hostedContext)).rejects.toThrow(
        "credential_egress_blocked",
      );
      await expect(
        registerClient(
          {
            metadata: {
              issuer: "https://issuer.example.test",
              authorization_endpoint: "https://issuer.example.test/authorize",
              token_endpoint: "https://issuer.example.test/token",
              registration_endpoint: "https://127.0.0.1/register",
              response_types_supported: ["code"],
            },
            redirectUri: "https://engine.example.test/callback",
            clientUri: null,
            scopes: [],
          },
          hostedContext,
        ),
      ).rejects.toThrow("credential_egress_blocked");
    },
  );
  expect(calls).toBe(0);
});

test("discovered OAuth registration addresses receive the same strict policy", async () => {
  const paths: string[] = [];
  await boundary(
    fakeFetch((url) => {
      paths.push(url.pathname);
      return Response.json({
        issuer: "https://issuer.example.test",
        authorization_endpoint: "https://issuer.example.test/authorize",
        token_endpoint: "https://issuer.example.test/token",
        registration_endpoint: "https://127.0.0.1/register",
        response_types_supported: ["code"],
      });
    }),
    async () => {
      await expect(
        dynamicallyRegisterClient(
          {
            issuerUrl: "https://issuer.example.test",
            clientMetadata: { redirect_uris: ["https://engine.example.test/callback"] },
          },
          hostedContext,
        ),
      ).rejects.toThrow("oauth_registration_request_failed");
    },
  );
  expect(paths.length).toBeGreaterThan(0);
  expect(paths).not.toContain("/register");
});

for (const failure of ["token_exchange_failed", "refresh_failed"] as const) {
  test(`${failure} never replays a secret body through a private redirect`, async () => {
    let calls = 0;
    await boundary(
      fakeFetch((url, init) => {
        calls++;
        expect(url.hostname).toBe("8.8.8.8");
        expect(new Headers(init?.headers).get("host")).toBe("issuer.example.test");
        expect(String(init?.body)).toContain("secret-canary");
        return new Response(null, {
          status: 307,
          headers: { location: "https://127.0.0.1/token" },
        });
      }),
      async () => {
        await expect(
          postTokenEndpoint(
            "https://issuer.example.test/token",
            { refresh_token: "secret-canary" },
            failure,
            hostedContext,
          ),
        ).rejects.toThrow();
      },
    );
    expect(calls).toBe(1);
  });
}

test("rotating a cached OAuth client secret never reuses the earlier authentication material", async () => {
  const secrets: string[] = [];
  const cfg = {
    issuer_url: "https://rotation.example.test",
    authorization_endpoint: "https://rotation.example.test/authorize",
    token_endpoint: "https://rotation.example.test/token",
    client_id: "rotating-client",
    client_secret: "first-fixture",
  };
  await boundary(
    fakeFetch((_url, init) => {
      secrets.push(new URLSearchParams(String(init?.body)).get("client_secret") ?? "");
      return Response.json({ access_token: "fixture", token_type: "Bearer" });
    }),
    async () => {
      await runClientCredentialsGrant(cfg, hostedContext);
      cfg.client_secret = "second-fixture";
      await runClientCredentialsGrant(cfg, hostedContext);
    },
  );
  expect(secrets).toEqual(["first-fixture", "second-fixture"]);
});
