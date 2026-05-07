import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { bootstrapCachePath, loadBootstrap } from "../lib/bootstrap.ts";

const PROFILE: ResolvedProfile = {
  name: "default",
  engine_url: "http://localhost:5050",
  api_key: "wf_live_test123",
  active_tenant_id: "t-test",
  persona_hint: "operator",
  portal_locked: false,
};

interface BootstrapResp {
  whoami: {
    id: string;
    kind: "user" | "system_account";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
    base_url: string | null;
    scopes: string[] | null;
  };
  permissions: string[];
  permissions_checked: string[];
  tenant: { id: string; slug: string | null; display_name: string | null };
  recent_sessions: Array<{ id: string; title: string | null; updated_at: string }>;
  flags: Record<string, boolean>;
  server_time: string;
}

class FakeClient {
  bootstrapCalls = 0;
  whoamiCalls = 0;
  rbacCalls = 0;
  bootstrapResponse: BootstrapResp | Error;
  constructor(resp: BootstrapResp | Error) {
    this.bootstrapResponse = resp;
  }
  skBootstrap(): Promise<BootstrapResp> {
    this.bootstrapCalls++;
    if (this.bootstrapResponse instanceof Error) return Promise.reject(this.bootstrapResponse);
    return Promise.resolve(this.bootstrapResponse);
  }
  whoami(): Promise<{
    id: string;
    kind: "user" | "system_account";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
  }> {
    this.whoamiCalls++;
    return Promise.resolve({
      id: "u-1",
      kind: "user",
      tenant_id: "t-test",
      tenant_slug: "t-test",
      email: "fb@example.com",
      role_name: "operator",
      provider: "api_key",
    });
  }
  rbacCan(): Promise<{ allow: boolean; source: string | null; reason: string | null }> {
    this.rbacCalls++;
    return Promise.resolve({ allow: false, source: null, reason: null });
  }
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "sk-bootstrap-test-"));
});
afterEach(() => {
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const successResp: BootstrapResp = {
  whoami: {
    id: "u-1",
    kind: "user",
    tenant_id: "t-test",
    tenant_slug: "t-test",
    email: "alice@example.com",
    role_name: "operator",
    provider: "api_key",
    base_url: "http://localhost:5050",
    scopes: ["*"],
  },
  permissions: ["conversation:read", "workflow:read"],
  permissions_checked: ["conversation:read", "workflow:read", "audit:read"],
  tenant: { id: "t-test", slug: "t-test", display_name: "Test" },
  recent_sessions: [],
  flags: {},
  server_time: "2024-11-14T22:13:20.000Z", // FROZEN_NOW (1_700_000_000_000)
};

describe("loadBootstrap", () => {
  test("uses /v1/sk/bootstrap on success and exposes the allow-set", async () => {
    const client = new FakeClient(successResp);
    const snap = await loadBootstrap(client as unknown as EngineClient, PROFILE, { cacheDir });
    expect(client.bootstrapCalls).toBe(1);
    expect(snap.source).toBe("network");
    expect(snap.label).toBe("operator");
    expect(snap.email).toBe("alice@example.com");
    expect(snap.allowed.has("conversation:read")).toBe(true);
    expect(snap.allowed.has("audit:read")).toBe(false);
    expect(snap.probe.allows("conversation:read")).toBe(true);
    expect(snap.probe.allows("audit:read")).toBe(false);
  });

  test("writes a cache file that subsequent calls re-use", async () => {
    const client = new FakeClient(successResp);
    const path = bootstrapCachePath(PROFILE, cacheDir);
    await loadBootstrap(client as unknown as EngineClient, PROFILE, { cacheDir });
    expect(client.bootstrapCalls).toBe(1);
    const cached = JSON.parse(readFileSync(path, "utf8")) as { v: number; allowed: string[] };
    expect(cached.v).toBe(1);
    expect(cached.allowed).toEqual(["conversation:read", "workflow:read"]);

    const snap2 = await loadBootstrap(client as unknown as EngineClient, PROFILE, { cacheDir });
    expect(client.bootstrapCalls).toBe(1); // hit cache, no new call
    expect(snap2.source).toBe("cache");
    expect(snap2.allowed.has("conversation:read")).toBe(true);
  });

  test("forceRefresh re-fetches even when cache is fresh", async () => {
    const client = new FakeClient(successResp);
    await loadBootstrap(client as unknown as EngineClient, PROFILE, { cacheDir });
    await loadBootstrap(client as unknown as EngineClient, PROFILE, {
      cacheDir,
      forceRefresh: true,
    });
    expect(client.bootstrapCalls).toBe(2);
  });

  test("expired cache triggers a refresh", async () => {
    const client = new FakeClient(successResp);
    const t0 = 1_000_000;
    await loadBootstrap(client as unknown as EngineClient, PROFILE, {
      cacheDir,
      now: () => t0,
    });
    expect(client.bootstrapCalls).toBe(1);

    // Walk the clock past the TTL.
    const ttl = 6 * 60 * 60 * 1000;
    await loadBootstrap(client as unknown as EngineClient, PROFILE, {
      cacheDir,
      now: () => t0 + ttl + 1,
    });
    expect(client.bootstrapCalls).toBe(2);
  });

  test("falls back to legacy persona-probe when /v1/sk/bootstrap 404s", async () => {
    const client = new FakeClient(new Error("HTTP 404"));
    const snap = await loadBootstrap(client as unknown as EngineClient, PROFILE, { cacheDir });
    expect(client.bootstrapCalls).toBe(1);
    expect(client.whoamiCalls).toBeGreaterThan(0);
    expect(snap.source).toBe("fallback");
  });

  test("ttl=0 disables disk cache entirely", async () => {
    const client = new FakeClient(successResp);
    await loadBootstrap(client as unknown as EngineClient, PROFILE, { cacheDir, cacheTtlMs: 0 });
    await loadBootstrap(client as unknown as EngineClient, PROFILE, { cacheDir, cacheTtlMs: 0 });
    expect(client.bootstrapCalls).toBe(2);
  });
});

describe("bootstrapCachePath", () => {
  test("includes both engine + tenant slugs", () => {
    const p = bootstrapCachePath(PROFILE, "/tmp/x");
    expect(p).toContain("/tmp/x");
    expect(p).toContain("t-test");
    expect(p).toMatch(/\.json$/);
  });

  test("falls back to 'global' when no tenant is set", () => {
    const p = bootstrapCachePath({ ...PROFILE, active_tenant_id: null }, "/tmp/x");
    expect(p).toContain("global");
  });

  // W11 review fix: cache key must include a token fingerprint so two
  // different api_keys against the same (engine, tenant) don't share a
  // cache file (and thus permission allow-set).
  test("two different api_keys against the same (engine, tenant) get distinct cache files", () => {
    const a = bootstrapCachePath({ ...PROFILE, api_key: "wf_live_admin1234" }, "/tmp/x");
    const b = bootstrapCachePath({ ...PROFILE, api_key: "wf_portal_other987" }, "/tmp/x");
    expect(a).not.toBe(b);
  });

  test("same api_key produces the same cache file (deterministic)", () => {
    const a = bootstrapCachePath({ ...PROFILE, api_key: "wf_live_same" }, "/tmp/x");
    const b = bootstrapCachePath({ ...PROFILE, api_key: "wf_live_same" }, "/tmp/x");
    expect(a).toBe(b);
  });

  test("cache file does not embed the raw api_key in its name", () => {
    const p = bootstrapCachePath({ ...PROFILE, api_key: "wf_live_supersecretkey123" }, "/tmp/x");
    expect(p).not.toContain("supersecretkey123");
    expect(p).not.toContain("wf_live_supersecretkey123");
  });
});
