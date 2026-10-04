import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("weather", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("weather workflow (open-meteo, no API key)", () => {
  test("login", async () => {
    const r = await cli(
      ["login", "--engine-url", env.baseUrl, "--api-key", env.personas.admin.apiKey],
      { env, persona: "admin" },
    );
    expect(r.exitCode).toBe(0);
  });

  test("authoring flow runs the canned open-meteo plan end-to-end", async () => {
    const r = await cli(
      [
        "--p",
        "create a connector and a workflow to use the open-meteo weather api (no api key) for tomorrow's forecast in Berlin Germany",
        "--output",
        "json",
      ],
      { env, persona: "admin", timeout: 120_000 },
    );
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as { session_id?: string };
    expect(body.session_id).toBeDefined();
    const conversationId = body.session_id!;

    const detailResp = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(detailResp.status).toBe(200);
    const detail = (await detailResp.json()) as {
      tool_calls?: Array<{ tool: string }>;
    };
    const toolNames = (detail.tool_calls ?? []).map((x) => x.tool);
    for (const expected of [
      "get_engine_status",
      "list_connectors",
      "start_connector_from_description",
    ]) {
      expect(toolNames).toContain(expected);
    }
  }, 120_000);

  test("audit log records at least one conversation-driven entry", async () => {
    const response = await fetch(`${env.baseUrl}/v1/audit-log?limit=10`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items ?? []).length).toBeGreaterThan(0);
  }, 30_000);
});
