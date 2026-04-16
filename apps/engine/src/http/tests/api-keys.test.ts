import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

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
  test("issue + list + rotate + revoke", async () => {
    const headers = {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
    };

    // 1. Issue a fresh key for the seeded system account.
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

    // 2. List should now include both the seed key and the new one.
    const listRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, { headers });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(list.items.find((k) => k.id === issued.id)).toBeDefined();
    expect(list.items.find((k) => k.id === ctx.apiKeyId)).toBeDefined();
    // List response must not include plaintext.
    for (const item of list.items) {
      expect((item as Record<string, unknown>).plaintext_key).toBeUndefined();
    }

    // 3. Rotate the new key with a 5-minute overlap.
    const rotateRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys/${issued.id}/rotate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ overlap_minutes: 5 }),
    });
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as {
      old: { id: string; expires_at: string | null; rotating_out_at: string | null };
      new: { id: string; rotated_from_id: string | null; plaintext_key: string };
    };
    expect(rotated.old.id).toBe(issued.id);
    expect(rotated.old.rotating_out_at).not.toBeNull();
    // expires_at is preserved untouched — null because the issue call did
    // not supply one. Rotation must not repurpose it.
    expect(rotated.old.expires_at).toBeNull();
    expect(rotated.new.rotated_from_id).toBe(issued.id);
    expect(rotated.new.plaintext_key).toMatch(/^wf_live_/);

    expect(await countAudit("api_key.rotated", issued.id)).toBe(1);
    expect(await countAudit("api_key.issued", rotated.new.id)).toBe(1);

    // 4. Revoke the new (rotated-in) key.
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

    // Issue a fresh key for the seeded system account.
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

    // Rotate with a 1-minute overlap. The old key must continue to
    // resolve while inside the overlap window.
    const rotateRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys/${issued.id}/rotate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ overlap_minutes: 1 }),
    });
    expect(rotateRes.status).toBe(200);

    // Inside the overlap window the old key should still authenticate.
    // Hit the authenticated `list api keys` route as a smoke check.
    const insideRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      headers: oldKeyHeaders,
    });
    expect(insideRes.status).toBe(200);

    // Force the rotating_out_at into the past — the provider must now
    // reject the old key as `rotated_out`.
    await ctx.db
      .update(apiKeys)
      .set({ rotating_out_at: new Date(Date.now() - 1_000) })
      .where(eq(apiKeys.id, issued.id));

    const afterRes = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      headers: oldKeyHeaders,
    });
    expect(afterRes.status).toBe(401);
  });
});
