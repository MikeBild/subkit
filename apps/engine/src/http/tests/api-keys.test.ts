import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog } from "../../db/schema/index.ts";
import {
  createDeterministicClock,
  getTestNow,
  installClock,
  restoreClock,
} from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("apikeys");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function countAudit(action: string, resourceId?: string): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(
      resourceId
        ? and(eq(auditLog.action, action), eq(auditLog.resource_id, resourceId))
        : eq(auditLog.action, action),
    );
  return rows.length;
}

describe("/v1/identity/api-keys", () => {
  test("issue + list + rotate with 24-hour overlap + revoke", async () => {
    const headers = {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
    };

    const issueRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        scopes: ["workflows:read"],
      }),
    });
    expect(issueRes.status).toBe(201);
    const issued = (await issueRes.json()) as {
      id: string;
      prefix: string;
      plaintext_key: string;
    };
    expect(issued.plaintext_key).toMatch(/^wf_live_/);
    expect(issued.prefix).toBe(issued.plaintext_key.slice(0, 12));

    expect(await countAudit("api_key.issued", issued.id)).toBe(1);

    const listRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, { headers });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(list.items.find((k) => k.id === issued.id)).toBeDefined();
    expect(list.items.find((k) => k.id === ctx.apiKeyId)).toBeDefined();
    for (const item of list.items) {
      expect((item as Record<string, unknown>).plaintext_key).toBeUndefined();
    }

    const previousClock = installClock(createDeterministicClock(TEST_NOW_MS));
    let rotateRes: Response;
    try {
      rotateRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys/${issued.id}/rotate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ overlap_minutes: 24 * 60 }),
      });
    } finally {
      restoreClock(previousClock);
    }
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as {
      old: { id: string; expires_at: string | null; rotating_out_at: string | null };
      new: { id: string; rotated_from_id: string | null; plaintext_key: string };
    };
    expect(rotated.old.id).toBe(issued.id);
    expect(rotated.old.rotating_out_at).toBe(
      new Date(TEST_NOW_MS + 24 * 60 * 60 * 1_000).toISOString(),
    );
    expect(rotated.old.expires_at).toBeNull();
    expect(rotated.new.rotated_from_id).toBe(issued.id);
    expect(rotated.new.plaintext_key).toMatch(/^wf_live_/);

    expect(await countAudit("api_key.rotated", issued.id)).toBe(1);
    expect(await countAudit("api_key.issued", rotated.new.id)).toBe(1);

    const revokeRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys/${rotated.new.id}`, {
      method: "DELETE",
      headers,
    });
    expect(revokeRes.status).toBe(204);

    expect(await countAudit("api_key.revoked", rotated.new.id)).toBe(1);
  });

  test("rotation overlap window is honored by the api-key provider", async () => {
    const headers = {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
    };

    const issueRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        scopes: ["*"],
      }),
    });
    expect(issueRes.status).toBe(201);
    const issued = (await issueRes.json()) as { id: string; plaintext_key: string };
    const oldKey = issued.plaintext_key;
    const oldKeyHeaders = { authorization: `Bearer ${oldKey}` };

    const rotateRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys/${issued.id}/rotate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ overlap_minutes: 1 }),
    });
    expect(rotateRes.status).toBe(200);

    const insideRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      headers: oldKeyHeaders,
    });
    expect(insideRes.status).toBe(200);

    await ctx.db
      .update(apiKeys)
      .set({ rotating_out_at: new Date(TEST_NOW_MS - 1_000) })
      .where(eq(apiKeys.id, issued.id));

    const afterRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      headers: oldKeyHeaders,
    });
    expect(afterRes.status).toBe(401);
  });
});
