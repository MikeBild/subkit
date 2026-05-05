// Unit tests for GET /v1/identity/providers — auth provider discovery.
//
// The endpoint is public (no auth required) and returns available providers
// based on `auth.firebase.*` / `auth.oidc.*` settings (read via getConfig()).
// In v3.5 the route migrated off raw process.env reads, so these tests
// drive the loader (setConfigKey) instead of mutating env vars. Bootstrap
// of the loader is owned by createHttpTestServer (see ./setup.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeEach(async () => {
  ctx = await createHttpTestServer("providers");
  // Reset firebase/oidc leaves so each test starts from a clean slate.
  await setConfigKey("auth.firebase.project_id", "", { force: true });
  await setConfigKey("auth.firebase.login_url", "", { force: true });
  await setConfigKey("auth.oidc.issuer_url", "", { force: true });
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("GET /v1/identity/providers", () => {
  test("returns api-key as baseline when no providers configured", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { providers: { type: string; name: string }[] };
    expect(data.providers).toBeDefined();
    const types = data.providers.map((p) => p.type);
    expect(types).toContain("api-key");
  });

  test("returns firebase provider when auth.firebase.project_id is set", async () => {
    await setConfigKey("auth.firebase.project_id", "test-project", { force: true });
    await setConfigKey("auth.firebase.login_url", "https://test-project.web.app", {
      force: true,
    });

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

  test("returns oidc provider when auth.oidc.issuer_url is set", async () => {
    await setConfigKey("auth.oidc.issuer_url", "https://auth.example.com", { force: true });

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
    await setConfigKey("auth.firebase.project_id", "test-fb", { force: true });
    await setConfigKey("auth.oidc.issuer_url", "https://auth.example.com", { force: true });

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

  test("firebase uses default login_url when auth.firebase.login_url not set", async () => {
    await setConfigKey("auth.firebase.project_id", "my-proj", { force: true });
    // login_url stays empty → route falls back to "https://{project}.web.app".

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    const data = (await res.json()) as {
      providers: { type: string; login_url?: string }[];
    };
    const firebase = data.providers.find((p) => p.type === "firebase");
    expect(firebase?.login_url).toBe("https://my-proj.web.app");
  });
});
