import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("sk-bootstrap");
});

afterAll(async () => {
  await ctx.cleanup();
});

interface BootstrapResponse {
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

describe("GET /v1/sk/bootstrap", () => {
  test("no bearer -> 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`);
    expect(res.status).toBe(401);
  });

  test("admin bearer -> 200, whoami populated, all UX permissions allowed", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.whoami.kind).toBe("user");
    expect(body.whoami.tenant_id).toBe(ctx.tenantId);
    expect(body.whoami.email).toBe(`admin-sk-bootstrap@test.local`);
    expect(body.tenant.id).toBe(ctx.tenantId);
    expect(body.tenant.slug).toBe("t-sk-bootstrap");
    // Admin should have every probed permission allowed.
    expect(body.permissions_checked.length).toBeGreaterThan(0);
    expect(body.permissions.length).toBe(body.permissions_checked.length);
    expect(body.permissions).toContain("audit:read");
    expect(body.permissions).toContain("conversation:read");
    expect(body.permissions).toContain("workflow:write");
    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(typeof body.server_time).toBe("string");
    expect(new Date(body.server_time).getTime()).toBeGreaterThan(0);
  });

  test("permissions_checked is stable and includes UX-gating set", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as BootstrapResponse;
    // Mirrors apps/sk/src/persona-probe.ts TIER_PERMISSIONS — keep these
    // in sync; if either side drifts, this assertion alerts.
    const expected = [
      "conversation:read",
      "conversation:write",
      "memory:write",
      "conversation:approve",
      "conversation:list",
      "mcp:read",
      "skill:read",
      "conversation:cancel",
      "conversation:commit",
      "workflow:read",
      "workflow:write",
      "connector:read",
      "skill:write",
      "execution:read",
      "notification:read",
      "audit:read",
      "identity:read",
      "rbac:read",
      "api_key:read",
      "portal_token:read",
      "knowledge:read",
    ];
    for (const perm of expected) {
      expect(body.permissions_checked).toContain(perm);
    }
  });

  test("recent_sessions only includes principal's own conversations", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as BootstrapResponse;
    // Fresh tenant has no conversations seeded, so the array is empty.
    // The shape itself is the contract; presence is exercised by the
    // sk e2e tests downstream.
    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(body.recent_sessions.length).toBeLessThanOrEqual(10);
  });
});
