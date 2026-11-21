import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, skills } from "../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../http/tests/setup.ts";
import { writeSetupPreferences } from "../../identity/setup-preferences.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";

let http: HttpTestServer;
let connectorId: string;

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  http = await createHttpTestServer("conv-stream");
  const [row] = await http.db
    .insert(connectors)
    .values({
      tenant_id: http.tenantId,
      slug: "api-stream",
      display_name: "API stream",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://jsonplaceholder.typicode.com",
      config: {},
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  connectorId = row.id;
  void skills;
  void eq;
});

afterAll(async () => {
  await http.cleanup();
});

describe("http/conversations streaming", () => {
  test("SSE stream replays the full event trace after an approved commit", async () => {
    await writeSetupPreferences(
      http.db,
      { tenant_id: http.tenantId, user_id: http.userId },
      { ask_before_writing: true },
    );
    const person = await browserSessionHeaders(http, http.userId);
    const createRes = await fetch(`${http.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: person,
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      conversation: { id: string; status: string };
      status: string;
      pending_elicitation_id?: string;
    };
    expect(created.status).toBe("awaiting_input");
    expect(created.pending_elicitation_id).toBeDefined();

    const respondRes = await fetch(
      `${http.baseUrl}/v1/conversations/${created.conversation.id}/elicitations/${created.pending_elicitation_id}/respond`,
      {
        method: "POST",
        headers: person,
        body: JSON.stringify({ output: { confirmed: true } }),
      },
    );
    expect(respondRes.status).toBe(200);
    const responded = (await respondRes.json()) as {
      status: string;
    };
    expect(responded.status).toBe("active");

    const streamRes = await fetch(
      `${http.baseUrl}/v1/conversations/${created.conversation.id}/stream`,
      { headers: person },
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
    const body = await streamRes.text();

    const eventLines = body.split("\n").filter((l) => l.startsWith("event:"));
    const events = eventLines.map((l) => l.slice("event:".length).trim());

    expect(events).toContain("message");
    expect(events).toContain("tool_call_start");
    expect(events).toContain("tool_call_end");
    expect(events).toContain("tool_result");
    expect(events).not.toContain("committed");
    expect(events).toContain("completed");
  });
});
