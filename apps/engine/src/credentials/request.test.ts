import { expect, spyOn, test } from "bun:test";
import { _withDriverFetchForTests } from "../connectors/drivers/fetch-seam.ts";
import { logger } from "../logging/logger.ts";
import { postTokenEndpoint, registerClient } from "./connections/oauth-client.ts";
import {
  completeAuthorizationCode,
  dynamicallyRegisterClient,
  runClientCredentialsGrant,
  runClientCredentialsJsonGrant,
  runCognitoUserPasswordGrant,
  runRefreshTokenGrant,
} from "./oauth2/client.ts";
import { runTokenMintGrant } from "./token-mint/client.ts";

const canary =
  "https://issuer.example.test/token?private=url-canary body-canary token-canary callback-query-canary";
const context = { mode: "permissive" as const };
const cfg = {
  issuer_url: "https://issuer.example.test",
  client_id: "fixture",
  client_secret: "token-canary",
  authorization_endpoint: "https://issuer.example.test/authorize",
  token_endpoint: "https://issuer.example.test/token?secret=url-canary",
};
const tokenMint = {
  shape: "json" as const,
  mint_endpoint: cfg.token_endpoint,
  credentials: { username: "fixture", password: "token-canary" },
  token_path: "access_token",
};
const jsonGrant = {
  token_endpoint: cfg.token_endpoint,
  body_mapping: { client_secret: "token-canary" },
  response_format: "json" as const,
  token_response_ttl_ms: 1000,
};

function fakeFetch(response: () => Response): typeof fetch {
  return Object.assign(async () => response(), { preconnect: () => {} }) as typeof fetch;
}
async function expectSafe(run: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  for (const marker of ["url-canary", "body-canary", "token-canary", "callback-query-canary"]) {
    expect((caught as Error).message).not.toContain(marker);
    expect(JSON.stringify(caught)).not.toContain(marker);
  }
}

test("token-mint, JSON and Cognito errors never expose upstream bodies or destination queries", async () => {
  for (const status of [200, 401]) {
    await _withDriverFetchForTests(
      fakeFetch(() => new Response(canary, { status })),
      async () => {
        await expectSafe(() => runTokenMintGrant(tokenMint, context));
        await expectSafe(() => runClientCredentialsJsonGrant(jsonGrant, context));
        await expectSafe(() =>
          runCognitoUserPasswordGrant(
            {
              region: "fixture",
              client_id: "fixture",
              username: "fixture",
              password: "token-canary",
            },
            context,
          ),
        );
      },
    );
  }
});

test("well-formed JSON without tokens never echoes unrelated provider content", async () => {
  await _withDriverFetchForTests(
    fakeFetch(() => Response.json({ message: canary })),
    async () => {
      await expectSafe(() => runTokenMintGrant(tokenMint, context));
      await expectSafe(() => runClientCredentialsJsonGrant(jsonGrant, context));
      await expectSafe(() =>
        runCognitoUserPasswordGrant(
          {
            region: "fixture",
            client_id: "fixture",
            username: "fixture",
            password: "token-canary",
          },
          context,
        ),
      );
    },
  );
});

test("runtime network exceptions never expose their raw message through credential errors", async () => {
  await _withDriverFetchForTests(
    fakeFetch(() => {
      throw new Error(canary);
    }),
    async () => {
      await expectSafe(() => runTokenMintGrant(tokenMint, context));
      await expectSafe(() => runClientCredentialsJsonGrant(jsonGrant, context));
      await expectSafe(() =>
        postTokenEndpoint(
          cfg.token_endpoint,
          { code: "token-canary" },
          "token_exchange_failed",
          context,
        ),
      );
    },
  );
});

test("OAuth library errors and refresh logs discard arbitrary error values and callback queries", async () => {
  const logs: unknown[] = [];
  const warn = spyOn(logger, "warn").mockImplementation((...args) => {
    logs.push(args);
  });
  try {
    await _withDriverFetchForTests(
      fakeFetch(() => Response.json({ error: canary, error_description: canary }, { status: 400 })),
      async () => {
        await expectSafe(() => runClientCredentialsGrant(cfg, context));
        await expectSafe(() => runRefreshTokenGrant(cfg, "token-canary", context));
        await expectSafe(() =>
          completeAuthorizationCode(
            {
              cfg,
              state: "fixture",
              code_verifier: "a".repeat(64),
              current_url: new URL(
                "https://engine.example.test/callback?state=fixture&code=callback-query-canary",
              ),
            },
            context,
          ),
        );
      },
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("canary");
  } finally {
    warn.mockRestore();
  }
});

test("connection and dynamic registration failures retain only fixed status diagnostics", async () => {
  await _withDriverFetchForTests(
    fakeFetch(() => new Response(canary, { status: 401 })),
    async () => {
      await expectSafe(() =>
        registerClient(
          {
            metadata: {
              issuer: cfg.issuer_url,
              authorization_endpoint: cfg.authorization_endpoint,
              token_endpoint: cfg.token_endpoint,
              registration_endpoint: "https://issuer.example.test/register?secret=url-canary",
            },
            redirectUri: "https://engine.example.test/callback",
            clientUri: null,
            scopes: [],
          },
          context,
        ),
      );
    },
  );
  await _withDriverFetchForTests(
    fakeFetch(() => Response.json({ error: canary, error_description: canary }, { status: 401 })),
    async () => {
      await expect(
        postTokenEndpoint(
          cfg.token_endpoint,
          { refresh_token: "token-canary" },
          "refresh_failed",
          context,
        ),
      ).rejects.toThrow("token endpoint refused: http_401");
    },
  );
  let calls = 0;
  await _withDriverFetchForTests(
    fakeFetch(() => {
      calls++;
      return calls === 1
        ? Response.json({
            issuer: cfg.issuer_url,
            authorization_endpoint: cfg.authorization_endpoint,
            token_endpoint: cfg.token_endpoint,
            registration_endpoint: "https://issuer.example.test/register?secret=url-canary",
            response_types_supported: ["code"],
          })
        : new Response(canary, { status: 400 });
    }),
    async () => {
      await expectSafe(() =>
        dynamicallyRegisterClient(
          {
            issuerUrl: cfg.issuer_url,
            clientMetadata: { redirect_uris: ["https://engine.example.test/callback"] },
          },
          context,
        ),
      );
    },
  );
  expect(calls).toBe(2);
});
