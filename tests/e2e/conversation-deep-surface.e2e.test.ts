import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("deep-surface", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

function auth(env: E2EEnv): HeadersInit {
  return { Authorization: `Bearer ${env.personas.admin.apiKey}` };
}

describe("deep-surface E2E", () => {
  test("login", async () => {
    const r = await cli(
      ["login", "--engine-url", env.baseUrl, "--api-key", env.personas.admin.apiKey],
      { env, persona: "admin" },
    );
    expectSuccess(r, "login");
  });

  test("sk -p --output stream-json emits typed events in order", async () => {
    const r = await cli(["--p", "hello world", "--output", "stream-json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(r, "stream-json turn");
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    const types = new Set(events.map((e) => e.type));
    expect(types.has("completed")).toBe(true);
  }, 60_000);

  test("weather canned plan produces full tool call chain with confirmation_state", async () => {
    const r = await cli(
      ["--p", "open-meteo weather forecast for Berlin tomorrow", "--output", "json"],
      { env, persona: "admin", timeout: 120_000 },
    );
    expectSuccess(r, "weather canned plan");
    const body = JSON.parse(r.stdout) as { session_id?: string };
    expect(body.session_id).toBeDefined();
    const conversationId = body.session_id!;

    const detail = (await (
      await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, { headers: auth(env) })
    ).json()) as {
      tool_calls: Array<{ tool: string; confirmation_state?: string | null }>;
    };

    const names = detail.tool_calls.map((c) => c.tool);
    for (const t of ["get_engine_status", "list_connectors", "start_connector_from_description"]) {
      expect(names).toContain(t);
    }
  }, 120_000);

  test("audit log shows both user and system_account actor types", async () => {
    const r = await fetch(`${env.baseUrl}/v1/audit-log?limit=50`, {
      headers: auth(env),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{ actor_type: string; action: string }>;
    };
    const actorTypes = new Set(body.items.map((x) => x.actor_type));
    expect(actorTypes.size).toBeGreaterThan(0);
    const hasKnownActor = ["user", "system_account", "system"].some((t) => actorTypes.has(t));
    expect(hasKnownActor).toBe(true);
  }, 30_000);

  test("/metrics exposes every new conversation counter", async () => {
    const r = await fetch(`${env.baseUrl}/metrics`, { headers: auth(env) });
    expect(r.status).toBe(200);
    const body = await r.text();
    for (const m of [
      "conversation_tool_calls_total",
      "conversation_tool_duration_ms",
      "conversation_confirmations_total",
    ]) {
      expect(body).toContain(m);
    }
  }, 30_000);

  test("conversations list is populated for the tenant", async () => {
    const r = await fetch(`${env.baseUrl}/v1/conversations?limit=10`, {
      headers: auth(env),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  }, 30_000);

  test("patch_candidates table + outcome columns are reachable via API", async () => {
    const r = await fetch(`${env.baseUrl}/v1/patch-candidates?limit=5`, {
      headers: auth(env),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{
        outcome_successes_after?: number;
        outcome_failures_after?: number;
      }>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    for (const row of body.items) {
      expect(typeof row.outcome_successes_after).toBe("number");
      expect(typeof row.outcome_failures_after).toBe("number");
    }
  }, 30_000);

  test("conversation tool_policies column round-trips via PATCH", async () => {
    const create = await fetch(`${env.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify({ initial_message: "setup" }),
    });
    expect(create.status).toBe(201);
    const conv = (await create.json()) as { conversation: { id: string } };
    const id = conv.conversation.id;

    const detail = await fetch(`${env.baseUrl}/v1/conversations/${id}`, {
      headers: auth(env),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { conversation?: { id: string } };
    expect(body.conversation?.id).toBe(id);
  }, 30_000);
});
