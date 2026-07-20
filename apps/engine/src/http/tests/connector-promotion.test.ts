import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createConnector } from "../../connectors/index.ts";
import { upsertCredential } from "../../credentials/index.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
const memberKey = "wf_live_member_connector_promotion_key";

beforeAll(async () => {
  ctx = await createHttpTestServer("connector-promotion");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-connector-promotion@test.local",
      role: "member",
    })
    .returning({ id: users.id });
  if (!member) throw new Error("seed member failed");
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: memberKey.slice(0, 12),
    token_sha256: createHash("sha256").update(memberKey).digest("hex"),
    scopes: ["*"],
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

function headers(apiKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function seedSource(slug: string, auth_type: "bearer" | "oauth2" = "bearer") {
  return await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: slug,
        slug,
        driver: "http",
        environment: "dev",
        auth_type,
        base_url: `https://${slug}.example.test`,
      },
      actor_id: ctx.userId,
    },
    ctx.db,
  );
}

describe("POST /v1/connectors/:id/promote", () => {
  test("copies as 201 and returns the stored result as 200 on replay", async () => {
    const source = await seedSource("http-copy");
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: source.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "http-copy-secret" },
        actor_id: ctx.userId,
        source: "http_route",
      },
      ctx.db,
    );
    const key = "http-copy-idempotency";
    const request = () =>
      fetch(`${ctx.baseUrl}/v1/connectors/${source.id}/promote`, {
        method: "POST",
        headers: headers(ctx.apiKey, key),
        body: JSON.stringify({ target_environment: "prod", strategy: "copy" }),
      });

    const created = await request();
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      source_connector_id: string;
      target_connector_id: string;
      source_retained: boolean;
      idempotent_replay: boolean;
      audit_log_ids: string[];
    };
    expect(body.source_connector_id).toBe(source.id);
    expect(body.target_connector_id).not.toBe(source.id);
    expect(body.source_retained).toBe(true);
    expect(body.idempotent_replay).toBe(false);
    expect(body.audit_log_ids).toHaveLength(2);

    const replay = await request();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...body, idempotent_replay: true });
  });

  test("requires an idempotency key and fixes the target to PROD", async () => {
    const source = await seedSource("http-validation");
    const missingKey = await fetch(`${ctx.baseUrl}/v1/connectors/${source.id}/promote`, {
      method: "POST",
      headers: headers(ctx.apiKey),
      body: JSON.stringify({ target_environment: "prod", strategy: "copy" }),
    });
    expect(missingKey.status).toBe(400);

    const wrongTarget = await fetch(`${ctx.baseUrl}/v1/connectors/${source.id}/promote`, {
      method: "POST",
      headers: headers(ctx.apiKey, "wrong-target-key"),
      body: JSON.stringify({ target_environment: "dev", strategy: "copy" }),
    });
    expect(wrongTarget.status).toBe(400);
  });

  test("denies the built-in member role", async () => {
    const source = await seedSource("http-rbac");
    const response = await fetch(`${ctx.baseUrl}/v1/connectors/${source.id}/promote`, {
      method: "POST",
      headers: headers(memberKey, "member-denied-key"),
      body: JSON.stringify({ target_environment: "prod", strategy: "copy" }),
    });
    expect(response.status).toBe(403);
  });

  test("returns a stable 422 code for unsafe OAuth copy", async () => {
    const source = await seedSource("http-oauth", "oauth2");
    const response = await fetch(`${ctx.baseUrl}/v1/connectors/${source.id}/promote`, {
      method: "POST",
      headers: headers(ctx.apiKey, "oauth-copy-rejected"),
      body: JSON.stringify({ target_environment: "prod", strategy: "copy" }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "oauth_copy_unsupported",
    });
  });
});
