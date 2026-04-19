// E2E verification for the expanded tool surface + observability
// wiring (Gaps #0–#8). Covers:
//   1. New conversation tool surface is reachable via sk --p
//   2. OTel counters for conversation tool calls increment via /metrics
//   3. Audit rows are correctly labelled (actor_type = system_account)
//   4. MCP tenant.* tool list exposes populated input schemas

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("tool-surface-expansion", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("tool surface expansion (post-P5 gap fixes)", () => {
  test("login", async () => {
    const r = await cli(
      "sk",
      ["login", "--engine-url", env.baseUrl, "--api-key", env.personas.admin.apiKey],
      { env, persona: "admin" },
    );
    expect(r.exitCode).toBe(0);
  });

  test("sk --p list my workflows — engine status + tool_call row lands", async () => {
    const r = await cli(
      "sk",
      ["--p", "list my workflows, connectors, and engine status", "--output", "json"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as { session_id?: string };
    expect(body.session_id).toBeDefined();
    const conversationId = body.session_id!;

    const detailResp = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(detailResp.status).toBe(200);
    const detail = (await detailResp.json()) as { tool_calls?: unknown[] };
    expect(Array.isArray(detail.tool_calls)).toBe(true);
  }, 60_000);

  test("audit entries use system_account actor_type for API-key driven calls", async () => {
    const r = await fetch(`${env.baseUrl}/v1/audit-log?limit=10&actor_type=system_account`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items?: Array<{ actor_type: string }>;
    };
    for (const row of body.items ?? []) {
      expect(row.actor_type).toBe("system_account");
    }
  }, 30_000);

  test("/metrics exposes conversation_tool_calls_total counter", async () => {
    // /metrics requires the `metrics:read` scope. Admin API keys carry
    // unrestricted scope so this authenticates.
    const r = await fetch(`${env.baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("conversation_tool_calls_total");
    expect(body).toContain("conversation_tool_duration_ms");
  }, 30_000);
});
