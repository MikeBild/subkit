// Bug RR regression: per-conversation tool-policy overrides via the
// /v1/conversations/:id/tool-policies route. Mirrors reference impl's
// `setToolPolicy` API surface.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { auditLog, conversations } from "../../db/schema/index.ts";
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

  test("PUT writes one tool_policy.changed audit row per tool with prior+new mode metadata", async () => {
    // Seed a baseline so the next PUT records a non-null prior_mode.
    await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { audit_probe: "no_confirm" },
    });
    const before = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "tool_policy.changed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    const baselineId = before[0]?.id ?? null;

    // Real change: relax `audit_probe` from no_confirm → confirm_before_execution.
    const res = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { audit_probe: "confirm_before_execution" },
    });
    expect(res.status).toBe(200);

    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "tool_policy.changed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(rows.length).toBe(1);
    const latest = rows[0]!;
    expect(latest.id).not.toBe(baselineId);
    expect(latest.resource_type).toBe("conversation");
    expect(latest.result).toBe("success");
    const meta = latest.metadata as Record<string, unknown>;
    expect(meta.tool).toBe("audit_probe");
    expect(meta.mode).toBe("confirm_before_execution");
    expect(meta.prior_mode).toBe("no_confirm");
    expect(meta.request_source).toBe("api");
  });
});

describe("conversation tool-policies HTTP route — RBAC + cross-tenant", () => {
  test("a different tenant's conversation_id returns 404 (cross-tenant isolation)", async () => {
    // Spin up a second server (its own tenant + API key). Use that
    // tenant's API key against tenant A's conversation_id; the route
    // must return 404 because `getConversation(B.tenant_id, A.conv_id)`
    // returns null.
    const other = await createHttpTestServer("conv-tool-policies-other");
    try {
      const res = await fetch(
        `${other.baseUrl}/v1/conversations/${conversation_id}/tool-policies`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${other.apiKey}` },
        },
      );
      expect(res.status).toBe(404);
      const put = await fetch(
        `${other.baseUrl}/v1/conversations/${conversation_id}/tool-policies`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${other.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ policies: { call_connector: "confirm_after_execution" } }),
        },
      );
      expect(put.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});
