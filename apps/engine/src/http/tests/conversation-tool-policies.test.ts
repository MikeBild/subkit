import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { apiKeys, auditLog, conversations, tenants, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

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
  test("GET on a fresh conversation returns empty policies and the safe browser choices", async () => {
    const res = await api("GET", `/v1/conversations/${conversation_id}/tool-policies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policies: Record<string, string>;
      eligible_no_confirm_tools: string[];
    };
    expect(body.policies).toEqual({});
    expect(body.eligible_no_confirm_tools).toEqual(["save_workflow_draft", "save_connector_draft"]);
  });

  test("API keys cannot skip confirmation and unsafe tools cannot be made no-confirm", async () => {
    const put = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { save_workflow_draft: "no_confirm" },
    });
    expect(put.status).toBe(403);

    const unsafe = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { call_connector: "no_confirm" },
    });
    expect(unsafe.status).toBe(422);
  });

  test("a signed-in browser session with CSRF can set an eligible no-confirm policy", async () => {
    const headers = await browserSessionHeaders(srv, srv.userId);
    const put = await fetch(`${srv.baseUrl}/v1/conversations/${conversation_id}/tool-policies`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ policies: { save_workflow_draft: "no_confirm" } }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { policies: Record<string, string> };
    expect(body.policies.save_workflow_draft).toBe("no_confirm");
  });

  test("PUT with null clears the override", async () => {
    await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { run_workflow: "confirm_before_execution" },
    });
    const cleared = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { run_workflow: null },
    });
    const body = (await cleared.json()) as { policies: Record<string, string> };
    expect(body.policies.run_workflow).toBeUndefined();
  });

  test("PUT permits confirmation-before-execution and revocation", async () => {
    const valid = ["confirm_before_execution", null] as const;
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
    await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { audit_probe: "confirm_before_execution" },
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

    const res = await api("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { audit_probe: null },
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
    expect(meta.mode).toBeNull();
    expect(meta.prior_mode).toBe("confirm_before_execution");
    expect(meta.request_source).toBe("api");
  });
});

describe("conversation tool-policies HTTP route — cross-tenant isolation", () => {
  test("a different tenant's conversation_id returns 404 (cross-tenant isolation)", async () => {
    const slug = `tp-cross-${crypto.randomUUID().slice(0, 8)}`; // allow-random: cross-tenant fixture; uniqueness > determinism here
    const [otherTenant] = await srv.db
      .insert(tenants)
      .values({ slug, display_name: "Cross-Tenant Probe" })
      .returning();
    if (!otherTenant) throw new Error("seed other tenant failed");
    const [otherUser] = await srv.db
      .insert(users)
      .values({
        tenant_id: otherTenant.id,
        email: `${slug}@test.local`,
        role_id: await builtinRoleId(srv.db, "admin"),
      })
      .returning();
    if (!otherUser) throw new Error("seed other user failed");
    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: matches the API key minted by setup.ts
    const otherKey = `wf_live_${rand}`;
    const hash = createHash("sha256").update(otherKey).digest("hex");
    await srv.db.insert(apiKeys).values({
      tenant_id: otherTenant.id,
      user_id: otherUser.id,
      prefix: otherKey.slice(0, 12),
      token_sha256: hash,
      scopes: ["*"],
    });

    const get = await fetch(`${srv.baseUrl}/v1/conversations/${conversation_id}/tool-policies`, {
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(get.status).toBe(404);

    const put = await fetch(`${srv.baseUrl}/v1/conversations/${conversation_id}/tool-policies`, {
      method: "PUT",
      headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" },
      body: JSON.stringify({ policies: { call_connector: "confirm_after_execution" } }),
    });
    expect(put.status).toBe(404);
  });
});
