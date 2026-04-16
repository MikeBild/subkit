// Unit tests for GET /v1/identity/providers — auth provider discovery.
//
// The endpoint is public (no auth required) and returns available providers
// based on environment variables.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeEach(async () => {
  ctx = await createHttpTestServer("providers");
});

afterEach(async () => {
  // Clean up env vars set during tests
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_LOGIN_URL;
  delete process.env.OIDC_ISSUER_URL;
  await ctx.cleanup();
});

describe("GET /v1/identity/providers", () => {
  test("returns api-key as baseline when no providers configured", async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.OIDC_ISSUER_URL;

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { providers: { type: string; name: string }[] };
    expect(data.providers).toBeDefined();
    const types = data.providers.map((p) => p.type);
    expect(types).toContain("api-key");
  });

  test("returns firebase provider when FIREBASE_PROJECT_ID is set", async () => {
    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_LOGIN_URL = "https://test-project.web.app";

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: { type: string; name: string; login_url?: string; issuer?: string }[];
    };
    const firebase = data.providers.find((p) => p.type === "firebase");
    expect(firebase).toBeDefined();
    expect(firebase!.name).toBe("Google (via Firebase)");
    expect(firebase!.login_url).toBe("https://test-project.web.app");
    expect(firebase!.issuer).toBe("https://securetoken.google.com/test-project");
  });

  test("returns oidc provider when OIDC_ISSUER_URL is set", async () => {
    process.env.OIDC_ISSUER_URL = "https://auth.example.com";

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: { type: string; issuer?: string }[];
    };
    const oidc = data.providers.find((p) => p.type === "oidc");
    expect(oidc).toBeDefined();
    expect(oidc!.issuer).toBe("https://auth.example.com");
  });

  test("returns all providers when both Firebase and OIDC configured", async () => {
    process.env.FIREBASE_PROJECT_ID = "test-fb";
    process.env.OIDC_ISSUER_URL = "https://auth.example.com";

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    const data = (await res.json()) as { providers: { type: string }[] };
    const types = data.providers.map((p) => p.type);
    expect(types).toContain("firebase");
    expect(types).toContain("oidc");
    expect(types).toContain("api-key");
  });

  test("does not require authentication", async () => {
    // Call without any Authorization header
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`, {
      headers: {}, // explicitly no auth
    });
    expect(res.status).toBe(200);
  });

  test("firebase uses default login_url when FIREBASE_LOGIN_URL not set", async () => {
    process.env.FIREBASE_PROJECT_ID = "my-proj";
    delete process.env.FIREBASE_LOGIN_URL;

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    const data = (await res.json()) as {
      providers: { type: string; login_url?: string }[];
    };
    const firebase = data.providers.find((p) => p.type === "firebase");
    expect(firebase?.login_url).toBe("https://my-proj.web.app");
  });
});
