// Bug RR regression: per-conversation tool-policy overrides via the
// /v1/conversations/:id/tool-policies route. Mirrors reference impl's
// `setToolPolicy` API surface.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id: string;

beforeAll(async () => {
  srv = await createHttpTestServer("conv-tool-policies");
  const [c] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  conversation_id = c!.id;
});
afterAll(async () => {
  await srv.cleanup();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${srv.apiKey}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${srv.baseUrl}${path}`, init);
}

describe("conversation tool-policies HTTP route (Bug RR)", () => {
  test("GET on a fresh conversation returns empty policies", async () => {
    const res = await api("GET", `/v1/conversations/${conversation_id}/tool-policies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policies: Record<string, string> };
    expect(body.policies).toEqual({});
  });

  test("PUT one policy persists it; GET reads it back", async () => {
    const put = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { call_connector: "no_confirm" },
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { policies: Record<string, string> };
    expect(body.policies.call_connector).toBe("no_confirm");

    const get = await api("GET", `/v1/conversations/${conversation_id}/tool-policies`);
    const getBody = (await get.json()) as { policies: Record<string, string> };
    expect(getBody.policies.call_connector).toBe("no_confirm");
  });

  test("PUT with null clears the override", async () => {
    // Seed with a real policy first.
    await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { run_workflow: "confirm_before_execution" },
    });
    // Clear it.
    const cleared = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { run_workflow: null },
    });
    const body = (await cleared.json()) as { policies: Record<string, string> };
    expect(body.policies.run_workflow).toBeUndefined();
  });

  test("PUT supports the three valid mode strings + null", async () => {
    const valid = [
      "no_confirm",
      "confirm_before_execution",
      "confirm_after_execution",
      null,
    ] as const;
    for (const mode of valid) {
      const res = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
        policies: { test_tool: mode },
      });
      expect(res.status).toBe(200);
    }
  });

  test("PUT with an invalid mode returns 400", async () => {
    const res = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { call_connector: "asdf" },
    });
    expect(res.status).toBe(400);
  });

  test("non-existent conversation returns 404 on GET", async () => {
    // allow-random: the lookup must miss for a 404.
    const res = await api("GET", `/v1/conversations/${crypto.randomUUID()}/tool-policies`);
    expect(res.status).toBe(404);
  });
});
