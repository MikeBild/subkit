// SSE streaming test.
//
// Drives a full list-users conversation through the REST create
// endpoint, approves the pending approval, and then opens
// /v1/conversations/:id/stream to read back the replayed event frames.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, skills } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";

let http: HttpTestServer;
let connectorId: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
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
  // Touch skills import so the barrel is still referenced elsewhere.
  void skills;
  void eq;
});

afterAll(async () => {
  await http.cleanup();
});

describe("http/conversations streaming", () => {
  test("SSE stream replays the full event trace after an approved commit", async () => {
    // 1. Create + drive first turn — pauses at approval.
    const createRes = await fetch(`${http.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${http.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      conversation: { id: string; status: string };
      status: string;
      pending_approval_id?: string;
    };
    expect(created.status).toBe("awaiting_approval");
    expect(created.pending_approval_id).toBeDefined();

    // 2. Approve → loop resumes and commits.
    const approveRes = await fetch(
      `${http.baseUrl}/v1/conversations/${created.conversation.id}/approvals/${created.pending_approval_id}/approve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${http.apiKey}` },
      },
    );
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as {
      status: string;
      committed_workflow_id?: string;
    };
    expect(approved.status).toBe("committed");
    expect(approved.committed_workflow_id).toBeDefined();

    // 3. Read the SSE stream.
    const streamRes = await fetch(
      `${http.baseUrl}/v1/conversations/${created.conversation.id}/stream`,
      { headers: { authorization: `Bearer ${http.apiKey}` } },
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
    const body = await streamRes.text();

    // Parse SSE frames — we care about event names.
    const eventLines = body.split("\n").filter((l) => l.startsWith("event:"));
    const events = eventLines.map((l) => l.slice("event:".length).trim());

    expect(events).toContain("message"); // user + tool messages
    expect(events).toContain("tool_call");
    expect(events).toContain("tool_result");
    expect(events).toContain("committed");
    expect(events).toContain("completed");
  });
});
