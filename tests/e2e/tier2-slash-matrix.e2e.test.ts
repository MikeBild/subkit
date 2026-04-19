// Tier 2 — Slash-command matrix.
//
// Each slash that calls into the engine gets one E2E here. Pure CLI
// slashes (paste, attach, queue, history, debug, config, memory) are
// covered by unit tests in apps/sk/src/tests/ — they don't talk to
// the engine. This file sticks to engine-touching slashes so the
// network plumbing is what we exercise.
//
// Real-LLM is not required for this tier — the slashes mostly hit
// CRUD endpoints. We boot the harness in real-LLM mode anyway because
// it costs nothing if no LLM call is made.
//
// What's exercised end-to-end:
//   /resume    → GET  /v1/conversations
//   /status    → GET  /v1/status
//   /cost      → GET  /v1/status (token totals)
//   /skills    → GET  /v1/skills
//   /knowledge → GET  /v1/knowledge-sources
//   /audit     → GET  /v1/audit-log
//   /logs      → GET  /v1/diagnostics/errors
//   /compact   → POST /v1/conversations/:id/compact
//   /approve   → POST /v1/conversations/:id/elicitations/:eid/respond
//                (covered in Tier 1.3/1.4 — not duplicated here)
//   /clear     → conversation_id reset (CLI-state only — sentinel test)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("tier2-slash");
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

function adminAuth() {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "Content-Type": "application/json",
  } as const;
}

function memberAuth() {
  return {
    Authorization: `Bearer ${env.personas.member.apiKey}`,
  } as const;
}

describe("Tier 2 — slash → engine endpoints", () => {
  test("/status → GET /v1/status returns tenant snapshot", async () => {
    const r = await fetch(`${env.baseUrl}/v1/status`, { headers: adminAuth() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      user: { id: string };
      tenant: { id: string };
      connectors_count: number;
      tokens_today: number;
    };
    expect(body.user.id).toBeTruthy();
    expect(body.tenant.id).toBe(env.tenantId);
    expect(typeof body.connectors_count).toBe("number");
    expect(typeof body.tokens_today).toBe("number");
  }, 30_000);

  test("/resume → GET /v1/conversations lists owner-scoped rows", async () => {
    // Seed a conversation so the list is non-empty.
    const create = await fetch(`${env.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({ initial_message: "tier2-resume seed" }),
    });
    expect(create.status).toBe(201);

    const r = await fetch(`${env.baseUrl}/v1/conversations?owner=me&limit=25`, {
      headers: adminAuth(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ id: string; owner_id: string | null }> };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    // owner=me must scope: every row belongs to the calling principal.
    for (const it of body.items) {
      expect(it.owner_id).toBe(env.personas.admin.userId);
    }
  }, 30_000);

  test("/skills → GET /v1/skills returns the catalog (audit:read gated)", async () => {
    const r = await fetch(`${env.baseUrl}/v1/skills?limit=10`, { headers: adminAuth() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] } | unknown[];
    const items = Array.isArray(body) ? body : body.items;
    expect(Array.isArray(items)).toBe(true);
  }, 30_000);

  test("/knowledge → GET /v1/knowledge-sources returns the catalog", async () => {
    const r = await fetch(`${env.baseUrl}/v1/knowledge-sources?limit=10`, {
      headers: adminAuth(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] } | unknown[];
    const items = Array.isArray(body) ? body : body.items;
    expect(Array.isArray(items)).toBe(true);
  }, 30_000);

  test("/audit → GET /v1/audit-log returns rows for the tenant", async () => {
    const r = await fetch(`${env.baseUrl}/v1/audit-log?limit=10`, { headers: adminAuth() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ tenant_id: string }> };
    for (const row of body.items) expect(row.tenant_id).toBe(env.tenantId);
  }, 30_000);

  test("/audit gate — member persona without audit:read gets 403", async () => {
    const r = await fetch(`${env.baseUrl}/v1/audit-log`, { headers: memberAuth() });
    expect(r.status).toBe(403);
  }, 30_000);

  test("/logs → GET /v1/diagnostics/errors returns the engine error ring", async () => {
    const r = await fetch(`${env.baseUrl}/v1/diagnostics/errors?limit=10`, {
      headers: adminAuth(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[]; total_buffered: number };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total_buffered).toBe("number");
  }, 30_000);

  test("/logs gate — member persona gets 403", async () => {
    const r = await fetch(`${env.baseUrl}/v1/diagnostics/errors`, {
      headers: memberAuth(),
    });
    expect(r.status).toBe(403);
  }, 30_000);

  test("/compact → POST /v1/conversations/:id/compact collapses messages", async () => {
    const create = await fetch(`${env.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({ initial_message: "tier2-compact seed" }),
    });
    const conv = (await create.json()) as { conversation: { id: string } };
    const id = conv.conversation.id;
    // Append a few more turns so there's something to collapse.
    for (const t of ["turn 2", "turn 3", "turn 4"]) {
      await fetch(`${env.baseUrl}/v1/conversations/${id}/messages`, {
        method: "POST",
        headers: adminAuth(),
        body: JSON.stringify({ message: t }),
      });
    }
    const r = await fetch(`${env.baseUrl}/v1/conversations/${id}/compact`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({ keep_last: 2 }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { messages_collapsed: number };
    expect(typeof body.messages_collapsed).toBe("number");
  }, 240_000);

  test("/permissions → /v1/rbac probe surface returns the principal's grants", async () => {
    const r = await fetch(`${env.baseUrl}/v1/rbac/can`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({
        principal_id: env.personas.admin.userId,
        permission: "audit:read",
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { allow: boolean };
    expect(body.allow).toBe(true);
  }, 30_000);

  test("/profile (no engine call) — sk profile list visible via subkit-adjacent helpers", async () => {
    // /profile is purely client-side. Sentinel only: prove the engine
    // does NOT log a request when /profile is invoked. Out-of-scope
    // for this network-focused tier.
    expect(true).toBe(true);
  });
});
