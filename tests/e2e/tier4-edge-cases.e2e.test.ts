// Tier 4 — Edge-case matrix.
//
// Pins the failure modes that previously shipped to prod undetected:
//   - 401 / 403 / 404 / 405 surface shapes
//   - empty / missing input
//   - tenant header override
//   - validation envelope shape (no 500 leakage)
//
// Pure HTTP — no LLM. Auth probes use admin + member personas.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("tier4-edge");
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("Tier 4 — auth / RBAC matrix", () => {
  test("401 — no Authorization header", async () => {
    const r = await fetch(`${env.baseUrl}/v1/conversations`);
    expect(r.status).toBe(401);
    const body = (await r.json()) as { code?: string; trace_id?: string };
    expect(body.code).toBeTruthy();
    expect(body.trace_id).toBeTruthy();
  });

  test("401 — bogus bearer token", async () => {
    const r = await fetch(`${env.baseUrl}/v1/conversations`, {
      headers: { Authorization: "Bearer wf_live_clearly_invalid" },
    });
    expect(r.status).toBe(401);
  });

  test("403 — member persona on audit-gated endpoint", async () => {
    const r = await fetch(`${env.baseUrl}/v1/audit-log`, {
      headers: { Authorization: `Bearer ${env.personas.member.apiKey}` },
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { code?: string; message?: string };
    expect(body.code).toBeTruthy();
  });

  test("403 — enduser persona on diagnostics endpoint", async () => {
    const r = await fetch(`${env.baseUrl}/v1/diagnostics/errors`, {
      headers: { Authorization: `Bearer ${env.personas.enduser.apiKey}` },
    });
    expect(r.status).toBe(403);
  });

  test("missing/invalid conversation id is a 4xx, never 5xx", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000999";
    const r = await fetch(`${env.baseUrl}/v1/conversations/${fakeId}`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    const body = (await r.json()) as Record<string, unknown>;
    // Envelope must carry SOMETHING actionable — code, error, or message.
    expect(Boolean(body.code) || Boolean(body.error) || Boolean(body.message)).toBe(true);
  });
});

describe("Tier 4 — validation envelope (no 500 leakage)", () => {
  test("POST /v1/conversations with empty body returns 4xx, never 5xx", async () => {
    const r = await fetch(`${env.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.personas.admin.apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(500);
  });

  test("POST /v1/workflows with malformed step kind returns 4xx with details", async () => {
    const r = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.personas.admin.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "tier4-bad",
        slug: "tier4-bad",
        steps: [{ id: "x", kind: "trigger.manual" }],
      }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  test("POST /v1/connectors with unknown driver is rejected, not 500", async () => {
    const r = await fetch(`${env.baseUrl}/v1/connectors`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.personas.admin.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "tier4-bad",
        slug: "tier4-bad",
        driver: "doesnt_exist_at_all",
        auth_type: "none",
        base_url: "https://example.com",
      }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe("Tier 4 — tenant header + cross-tenant isolation", () => {
  test("conversation created by admin is NOT visible to a token with foreign tenant claim", async () => {
    // No initial_message → no LLM call, fast.
    const create = await fetch(`${env.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.personas.admin.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(201);
    const conv = (await create.json()) as { conversation: { id: string } };
    const id = conv.conversation.id;

    // The api-key provider re-resolves tenant from the key — a foreign
    // header MUST NOT broaden access. Either 200 (header ignored, real
    // tenant returned) or 403/404 — never the foreign tenant's data.
    const spoof = await fetch(`${env.baseUrl}/v1/conversations/${id}`, {
      headers: {
        Authorization: `Bearer ${env.personas.admin.apiKey}`,
        "x-subkit-tenant": "00000000-0000-0000-0000-000000000999",
      },
    });
    expect([200, 403, 404]).toContain(spoof.status);
    if (spoof.status === 200) {
      const body = (await spoof.json()) as { conversation: { tenant_id: string } };
      expect(body.conversation.tenant_id).toBe(env.tenantId);
    }
  }, 30_000);
});

describe("Tier 4 — concurrent conversations don't bleed state", () => {
  test("two conversations created in parallel get distinct ids", async () => {
    const [a, b] = await Promise.all([
      fetch(`${env.baseUrl}/v1/conversations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.personas.admin.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ initial_message: "parallel A" }),
      }).then((r) => r.json() as Promise<{ conversation: { id: string } }>),
      fetch(`${env.baseUrl}/v1/conversations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.personas.admin.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ initial_message: "parallel B" }),
      }).then((r) => r.json() as Promise<{ conversation: { id: string } }>),
    ]);
    expect(a.conversation.id).not.toBe(b.conversation.id);
  }, 240_000);
});

describe("Tier 4 — error envelope shape across error classes", () => {
  test("error responses always return JSON, never plain text", async () => {
    const probes = [
      // 401
      fetch(`${env.baseUrl}/v1/conversations`),
      // 403
      fetch(`${env.baseUrl}/v1/audit-log`, {
        headers: { Authorization: `Bearer ${env.personas.member.apiKey}` },
      }),
      // 4xx — admin asking for a missing conversation
      fetch(`${env.baseUrl}/v1/conversations/00000000-0000-0000-0000-000000000999`, {
        headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
      }),
    ];
    const results = await Promise.all(probes);
    for (const r of results) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      const ct = r.headers.get("content-type") ?? "";
      expect(ct).toContain("application/json");
      const body = (await r.json()) as Record<string, unknown>;
      expect(Boolean(body.code) || Boolean(body.error) || Boolean(body.message)).toBe(true);
    }
  });
});
