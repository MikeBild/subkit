import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { AuditAction } from "../audit/types.ts";
import { getCredentialForConnector, upsertCredential } from "../credentials/index.ts";
import {
  auditLog,
  connectorPromotions,
  connectors,
  credentials,
  endUserCredentials,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { ConnectorPromotionError, promoteConnector } from "./promotion.ts";
import { createConnector, getConnector, listConnectors } from "./service.ts";

let ctx: TestDb;
let sequence = 0;

beforeAll(async () => {
  ctx = await createTestDb("connector_promotion");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(label: string): Promise<string> {
  sequence += 1;
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: `${label}-${sequence}`, display_name: label })
    .returning({ id: tenants.id });
  return tenant!.id;
}

function nextKey(label: string): string {
  sequence += 1;
  return `${label}-idempotency-${sequence}`;
}

async function seedConnector(tenant_id: string, slug: string, auth_type = "bearer") {
  return await createConnector(
    {
      tenant_id,
      input: {
        name: slug,
        slug,
        driver: "http",
        environment: "dev",
        base_url: `https://${slug}.example.test`,
        auth_type: auth_type as "bearer" | "oauth2",
        config: { timeout_ms: 4_000 },
      },
      actor_id: null,
    },
    ctx.db,
  );
}

function promoteInput(
  tenant_id: string,
  source_connector_id: string,
  strategy: "copy" | "move",
  idempotency_key: string,
) {
  return {
    tenant_id,
    source_connector_id,
    strategy,
    idempotency_key,
    actor_id: null,
    request_source: "test",
  } as const;
}

describe("connector promotion", () => {
  test("copy retains DEV, re-encrypts static credentials, audits, and replays idempotently", async () => {
    const tenant_id = await seedTenant("copy");
    const source = await seedConnector(tenant_id, "copy-api");
    const sourceCredential = await upsertCredential(
      {
        tenant_id,
        connector_id: source.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "copy-secret-value" },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    const key = nextKey("copy");
    const result = await promoteConnector(promoteInput(tenant_id, source.id, "copy", key), ctx.db);
    expect(result.idempotent_replay).toBe(false);
    expect(result.source_retained).toBe(true);
    expect(result.target_connector_id).not.toBe(source.id);
    expect(result.credential_mappings).toEqual([
      {
        mode: "bearer",
        source_credential_id: sourceCredential.id,
        target_credential_id: expect.any(String),
      },
    ]);

    const dev = await listConnectors(tenant_id, { environment: "dev" }, ctx.db);
    const prod = await listConnectors(tenant_id, { environment: "prod" }, ctx.db);
    expect(dev.rows.map((row) => row.id)).toContain(source.id);
    expect(prod.rows.map((row) => row.id)).toContain(result.target_connector_id);
    expect(prod.rows[0]?.template_snapshot).toEqual(source.template_snapshot);

    const copiedCredential = await getCredentialForConnector(
      tenant_id,
      result.target_connector_id,
      "prod",
      ctx.db,
    );
    expect(copiedCredential?.value).toEqual({ mode: "bearer", token: "copy-secret-value" });
    expect(copiedCredential?.row.id).not.toBe(sourceCredential.id);
    expect(copiedCredential?.row.ciphertext).not.toEqual(
      (
        await ctx.db
          .select({ ciphertext: credentials.ciphertext })
          .from(credentials)
          .where(eq(credentials.id, sourceCredential.id))
      )[0]?.ciphertext,
    );

    const promotionAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, AuditAction.CONNECTOR_ENVIRONMENT_PROMOTED),
        ),
      );
    const credentialAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, AuditAction.CREDENTIAL_ENVIRONMENT_PROMOTED),
        ),
      );
    expect(promotionAudits).toHaveLength(1);
    expect(credentialAudits).toHaveLength(1);
    expect(JSON.stringify([...promotionAudits, ...credentialAudits])).not.toContain(
      "copy-secret-value",
    );

    const replay = await promoteConnector(promoteInput(tenant_id, source.id, "copy", key), ctx.db);
    expect(replay).toEqual({ ...result, idempotent_replay: true });
    expect(
      await ctx.db
        .select()
        .from(connectorPromotions)
        .where(eq(connectorPromotions.tenant_id, tenant_id)),
    ).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(connectors)
        .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.environment, "prod"))),
    ).toHaveLength(1);
  });

  test("concurrent copies with one key create one target", async () => {
    const tenant_id = await seedTenant("race");
    const source = await seedConnector(tenant_id, "race-api");
    const input = promoteInput(tenant_id, source.id, "copy", nextKey("race"));
    const results = await Promise.all([
      promoteConnector(input, ctx.db),
      promoteConnector(input, ctx.db),
    ]);
    expect(results.map((row) => row.idempotent_replay).sort()).toEqual([false, true]);
    expect(new Set(results.map((row) => row.target_connector_id)).size).toBe(1);
  });

  test("move preserves OAuth credential ids, ciphertext, refresh state, and removes DEV", async () => {
    const tenant_id = await seedTenant("move");
    const source = await seedConnector(tenant_id, "oauth-api", "oauth2");
    const primary = await upsertCredential(
      {
        tenant_id,
        connector_id: source.id,
        environment: "dev",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "access", token_type: "Bearer" },
        oauth2_refresh_token: "refresh",
        oauth2_expires_at: new Date("2030-01-01T00:00:00.000Z"),
        actor_id: null,
        source: "oauth_callback",
      },
      ctx.db,
    );
    const client = await upsertCredential(
      {
        tenant_id,
        connector_id: source.id,
        environment: "dev",
        mode: "oauth2_client",
        value: { mode: "oauth2_client", client_id: "client", client_secret: "secret" },
        actor_id: null,
        source: "oauth_callback",
      },
      ctx.db,
    );
    const beforeRows = await ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.connector_id, source.id));

    const result = await promoteConnector(
      promoteInput(tenant_id, source.id, "move", nextKey("move")),
      ctx.db,
    );
    expect(result.target_connector_id).toBe(source.id);
    expect(result.source_retained).toBe(false);
    expect(result.credential_mappings.map((row) => row.source_credential_id).sort()).toEqual(
      [primary.id, client.id].sort(),
    );
    expect((await getConnector(tenant_id, source.id, ctx.db))?.environment).toBe("prod");
    expect((await listConnectors(tenant_id, { environment: "dev" }, ctx.db)).rows).toHaveLength(0);

    const afterRows = await ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.connector_id, source.id));
    expect(afterRows.every((row) => row.environment === "prod")).toBe(true);
    for (const before of beforeRows) {
      const after = afterRows.find((row) => row.id === before.id);
      expect(after?.ciphertext).toEqual(before.ciphertext);
      expect(after?.oauth2_refresh_ciphertext).toEqual(before.oauth2_refresh_ciphertext);
    }
    const decrypted = await getCredentialForConnector(tenant_id, source.id, "prod", ctx.db);
    expect(decrypted?.value).toMatchObject({
      mode: "oauth2",
      access_token: "access",
      refresh_token: "refresh",
    });
  });

  test("copy rejects OAuth, end-user bindings, and conflicting idempotency reuse", async () => {
    const tenant_id = await seedTenant("reject");
    const oauth = await seedConnector(tenant_id, "reject-oauth", "oauth2");
    await expect(
      promoteConnector(promoteInput(tenant_id, oauth.id, "copy", nextKey("reject")), ctx.db),
    ).rejects.toMatchObject({ code: "oauth_copy_unsupported" });

    const endUser = await seedConnector(tenant_id, "reject-end-user");
    await ctx.db.insert(endUserCredentials).values({
      tenant_id,
      connector_id: endUser.id,
      enduser_ref: "user-1",
      combine_mode: "merge",
      ciphertext: Buffer.from("ciphertext"),
      iv: Buffer.from("123456789012"),
      auth_tag: Buffer.from("1234567890123456"),
    });
    await expect(
      promoteConnector(promoteInput(tenant_id, endUser.id, "copy", nextKey("end-user")), ctx.db),
    ).rejects.toMatchObject({ code: "end_user_credential_copy_unsupported" });

    const source = await seedConnector(tenant_id, "idem-conflict");
    const key = nextKey("idem");
    await promoteConnector(promoteInput(tenant_id, source.id, "copy", key), ctx.db);
    await expect(
      promoteConnector(promoteInput(tenant_id, source.id, "move", key), ctx.db),
    ).rejects.toBeInstanceOf(ConnectorPromotionError);
    await expect(
      promoteConnector(promoteInput(tenant_id, source.id, "move", key), ctx.db),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const rawKeyRows = await ctx.db
      .select()
      .from(connectorPromotions)
      .where(eq(connectorPromotions.idempotency_key_hash, key));
    expect(rawKeyRows).toHaveLength(0);
  });

  test("tenant scoping hides a source connector from another tenant", async () => {
    const ownerTenant = await seedTenant("owner");
    const otherTenant = await seedTenant("other");
    const source = await seedConnector(ownerTenant, "tenant-api");
    await expect(
      promoteConnector(promoteInput(otherTenant, source.id, "copy", nextKey("tenant")), ctx.db),
    ).rejects.toMatchObject({ code: "source_not_found" });
  });

  test("move rolls back when credential state already occupies PROD", async () => {
    const tenant_id = await seedTenant("rollback");
    const source = await seedConnector(tenant_id, "rollback-api");
    const prodCredential = await upsertCredential(
      {
        tenant_id,
        connector_id: source.id,
        environment: "prod",
        mode: "bearer",
        value: { mode: "bearer", token: "already-prod" },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    await expect(
      promoteConnector(promoteInput(tenant_id, source.id, "move", nextKey("rollback")), ctx.db),
    ).rejects.toMatchObject({ code: "credential_slot_conflict" });
    expect((await getConnector(tenant_id, source.id, ctx.db))?.environment).toBe("dev");
    expect(
      (
        await ctx.db
          .select({ environment: credentials.environment })
          .from(credentials)
          .where(eq(credentials.id, prodCredential.id))
      )[0]?.environment,
    ).toBe("prod");
    expect(
      await ctx.db
        .select()
        .from(connectorPromotions)
        .where(eq(connectorPromotions.tenant_id, tenant_id)),
    ).toHaveLength(0);
  });
});
