import { expect, test } from "bun:test";
import { _withDriverFetchForTests } from "../../connectors/drivers/fetch-seam.ts";
import { withMcpCredentialObserver } from "./credential-observation.ts";
import {
  FAKE_ISSUER,
  FAKE_SERVER_URL,
  makeInteractiveProvider,
  makeNonInteractiveProvider,
  observeSubject,
  saveRefreshResponse,
  seedOAuth2Server,
  setupOauthProvider,
  tenantA,
} from "./tests/oauth-provider-fixtures.ts";

setupOauthProvider();

test("wire identity accepts only the discovered configured issuer token endpoint", async () => {
  for (const rejection of [
    "issuer",
    "authorization-server",
    "endpoint",
    "method",
    "failed",
    "oversized",
  ] as const) {
    const serverId = await seedOAuth2Server(tenantA, `wire-identity-${rejection}`);
    const provider = makeInteractiveProvider(tenantA, serverId, `state-${rejection}`);
    provider.saveDiscoveryState({
      authorizationServerUrl:
        rejection === "authorization-server" ? "https://other.example.test" : FAKE_ISSUER,
      authorizationServerMetadata: {
        issuer: rejection === "issuer" ? "https://other.example.test" : FAKE_ISSUER,
        authorization_endpoint: `${FAKE_ISSUER}/authorize`,
        token_endpoint: `${FAKE_ISSUER}/token`,
        response_types_supported: ["code"],
      },
    });
    await provider.observeTokenResponse(
      rejection === "endpoint" ? FAKE_SERVER_URL : `${FAKE_ISSUER}/token`,
      { method: rejection === "method" ? "GET" : "POST" },
      Response.json(
        {
          access_token: `wire-${rejection}`,
          sub: "untrusted-subject",
          ...(rejection === "oversized" ? { padding: "x".repeat(65_536) } : {}),
        },
        { status: rejection === "failed" ? 400 : 200 },
      ),
      undefined,
    );
    await provider.saveTokens({
      issuer: FAKE_ISSUER,
      access_token: `wire-${rejection}`,
      token_type: "Bearer",
      ...{ sub: "untrusted-subject" },
    });
    await provider.tokens();
    expect(provider.credentialSnapshot(`wire-${rejection}`)?.identity).toBeNull();
  }
});

test("conflicting token endpoint subjects for identical token material remain unknown", async () => {
  const serverId = await seedOAuth2Server(tenantA, "wire-identity-conflict");
  const provider = makeInteractiveProvider(tenantA, serverId, "state-wire-conflict");
  provider.saveDiscoveryState({
    authorizationServerUrl: FAKE_ISSUER,
    authorizationServerMetadata: {
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      response_types_supported: ["code"],
    },
  });
  for (const subject of ["first-account", "second-account", "first-account"]) {
    await provider.observeTokenResponse(
      `${FAKE_ISSUER}/token`,
      { method: "POST" },
      Response.json({ access_token: "conflicting-wire-token", sub: subject }),
      undefined,
    );
  }
  await provider.saveTokens({
    issuer: FAKE_ISSUER,
    access_token: "conflicting-wire-token",
    token_type: "Bearer",
  });
  await provider.tokens();
  expect(provider.credentialSnapshot("conflicting-wire-token")?.identity).toBeNull();
});

test("a refresh response cannot acquire the identity of an intervening authorization", async () => {
  const serverId = await seedOAuth2Server(tenantA, "wire-identity-replacement");
  const interactive = makeInteractiveProvider(tenantA, serverId, "state-wire-replacement");
  await observeSubject(interactive, "old-access", "old-account");
  await interactive.saveTokens({
    issuer: FAKE_ISSUER,
    access_token: "old-access",
    refresh_token: "old-refresh",
    token_type: "Bearer",
  });
  const automatic = makeNonInteractiveProvider(tenantA, serverId);
  automatic.saveDiscoveryState({
    authorizationServerUrl: FAKE_ISSUER,
    authorizationServerMetadata: {
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      response_types_supported: ["code"],
    },
  });
  await withMcpCredentialObserver(undefined, async () => {
    await automatic.tokens();
    const responseFetch: typeof fetch = Object.assign(
      async () => {
        await observeSubject(interactive, "replacement-access", "replacement-account", 1);
        await interactive.saveTokens({
          issuer: FAKE_ISSUER,
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          token_type: "Bearer",
        });
        await automatic.tokens();
        return Response.json({ access_token: "late-refresh-token", sub: "old-account" });
      },
      { preconnect() {} },
    );
    await _withDriverFetchForTests(responseFetch, async () => {
      const response = await automatic.fetch(`${FAKE_ISSUER}/token`, { method: "POST" });
      await response.json();
    });
    await expect(
      automatic.saveTokens({
        issuer: FAKE_ISSUER,
        access_token: "late-refresh-token",
        token_type: "Bearer",
      }),
    ).rejects.toMatchObject({ code: "credential_generation_changed" });
  });
  const tokens = await interactive.tokens();
  expect(tokens?.access_token).toBe("replacement-access");
  expect(interactive.credentialSnapshot("replacement-access")?.identity?.subject).toBe(
    "replacement-account",
  );
});

test("a rejected response cannot reuse an earlier identity for the same token bytes", async () => {
  for (const rejection of ["redirect", "oversized", "changed-discovery"] as const) {
    const serverId = await seedOAuth2Server(tenantA, `wire-reused-${rejection}`);
    const provider = makeInteractiveProvider(tenantA, serverId, `state-reused-${rejection}`);
    await observeSubject(provider, "reused-access", "old-account");
    if (rejection === "changed-discovery") {
      provider.saveDiscoveryState({ authorizationServerUrl: "https://other.example.test" });
    } else {
      const response = Response.json({
        access_token: "reused-access",
        sub: "new-account",
        ...(rejection === "oversized" ? { padding: "x".repeat(65_536) } : {}),
      });
      if (rejection === "redirect")
        Object.defineProperty(response, "url", { value: "https://other.example.test/token" });
      await provider.observeTokenResponse(
        `${FAKE_ISSUER}/token`,
        { method: "POST" },
        response,
        undefined,
      );
    }
    await provider.saveTokens({
      issuer: FAKE_ISSUER,
      access_token: "reused-access",
      token_type: "Bearer",
    });
    await provider.tokens();
    expect(provider.credentialSnapshot("reused-access")?.identity).toBeNull();
  }
});

test("identical token material across generations loses ambiguous session attribution", async () => {
  const serverId = await seedOAuth2Server(tenantA, "identity-collision");
  const interactive = makeInteractiveProvider(tenantA, serverId, "identity-collision-state");
  await observeSubject(interactive, "same-token", "first-account");
  await interactive.saveTokens({
    issuer: FAKE_ISSUER,
    access_token: "same-token",
    refresh_token: "refresh",
    token_type: "Bearer",
  });
  const automatic = makeNonInteractiveProvider(tenantA, serverId);
  await automatic.tokens();
  expect(automatic.credentialSnapshot("same-token")?.credential_generation).toBe(1);
  expect(automatic.credentialSnapshot("same-token")?.identity?.subject).toBe("first-account");
  await observeSubject(automatic, "same-token", "second-account");
  await saveRefreshResponse(automatic, { access_token: "same-token", token_type: "Bearer" });
  await automatic.tokens();
  expect(automatic.credentialSnapshot("same-token")).toBeNull();
  await automatic.tokens();
  expect(automatic.credentialSnapshot("same-token")).toBeNull();
});

test("refresh without consumed response evidence and conflicting token generations never use the current row as fallback", async () => {
  const serverId = await seedOAuth2Server(tenantA, "response-generation-binding");
  const interactive = makeInteractiveProvider(tenantA, serverId, "response-generation-state");
  await interactive.saveTokens({
    issuer: FAKE_ISSUER,
    access_token: "initial-response-token",
    refresh_token: "initial-refresh",
    token_type: "Bearer",
  });
  const automatic = makeNonInteractiveProvider(tenantA, serverId);
  await expect(
    automatic.saveTokens({
      issuer: FAKE_ISSUER,
      access_token: "unobserved-token",
      token_type: "Bearer",
    }),
  ).rejects.toMatchObject({ code: "credential_generation_changed" });
  await saveRefreshResponse(automatic, {
    access_token: "repeated-response-token",
    token_type: "Bearer",
  });
  await interactive.saveTokens({
    issuer: FAKE_ISSUER,
    access_token: "new-interactive-token",
    refresh_token: "new-interactive-refresh",
    token_type: "Bearer",
  });
  await expect(
    saveRefreshResponse(automatic, {
      access_token: "repeated-response-token",
      token_type: "Bearer",
    }),
  ).rejects.toMatchObject({ code: "credential_generation_changed" });
  expect((await automatic.tokens())?.access_token).toBe("new-interactive-token");
  await expect(
    saveRefreshResponse(automatic, {
      access_token: "repeated-response-token",
      token_type: "Bearer",
    }),
  ).rejects.toMatchObject({ code: "credential_generation_changed" });
});
