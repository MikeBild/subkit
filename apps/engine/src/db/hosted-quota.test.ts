import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { errorMiddleware, mapKnownErrorResponse } from "../http/middleware/error.ts";
import type { AppEnv } from "../http/openapi.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { errorFields } from "../logging/logger.ts";
import { logRing } from "../observability/log-ring.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { createDbFromUrl } from "./client.ts";
import { assertHostedQuotaCatalog, hostedColumnBytes } from "./hosted-quota-catalog.ts";
import { hostedQuotaError } from "./hosted-quota-errors.ts";
import { renderHostedQuotaSql } from "./hosted-quota-sql.ts";
import { catalogCategories, hostedTenantUsage, tenants } from "./schema/index.ts";

let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-quota", { operator: false });
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
});
afterAll(async () => {
  await ctx?.cleanup();
});
beforeEach(async () => {
  await policy("50000000");
});

async function owned(subject: string) {
  return provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    ctx.db,
  );
}

async function policy(bytes: string, rows = 1000) {
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${bytes}::text)),'{storage,hosted,retained_rows_per_resource}',to_jsonb(${rows}::int)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
}

test("quota catalog covers every current column", () => {
  expect(() => assertHostedQuotaCatalog()).not.toThrow();
});

test("retained content shares logical bytes and failed growth rolls back", async () => {
  await policy("50000000");
  const result = await owned("quota-content");
  const tenantId = result.tenant.id;
  const [baseline] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  expect(baseline).toBeDefined();
  await policy((baseline!.logical_bytes + 100n).toString());
  let failure: unknown;
  try {
    await ctx.db
      .insert(catalogCategories)
      .values({ tenant_id: tenantId, name: "quota-canary-secret", purpose: "x".repeat(200) });
  } catch (error) {
    failure = error;
  }
  expect(hostedQuotaError(failure)?.code).toBe("hosted_storage_quota_exhausted");
  expect(
    await ctx.db.select().from(catalogCategories).where(eq(catalogCategories.tenant_id, tenantId)),
  ).toHaveLength(0);
  const [after] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  expect(after?.logical_bytes).toBe(baseline!.logical_bytes);
  await policy("50000000");
});

test("operator resource ceilings fail closed and selfhost remains unaffected", async () => {
  await policy("50000000");
  const result = await owned("quota-count");
  await policy("50000000", 0);
  await expect(
    (async () => {
      await ctx.db.execute(
        sql`INSERT INTO subkit.catalog_categories(tenant_id,name) VALUES(${result.tenant.id},'denied')`,
      );
    })(),
  ).rejects.toThrow();
  await ctx.db
    .update(tenants)
    .set({ display_name: "selfhost changed" })
    .where(eq(tenants.id, ctx.tenantId));
  await policy("50000000");
});

test("concurrent raw inserts cannot exceed retained row cap and deduplication is free", async () => {
  await policy("50000000");
  const result = await owned("quota-parallel");
  await policy("50000000", 1);
  const outcomes = await Promise.allSettled(
    ["first", "second"].map(async (name) => {
      await ctx.db.insert(catalogCategories).values({ tenant_id: result.tenant.id, name });
    }),
  );
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const rows = await ctx.db
    .select()
    .from(catalogCategories)
    .where(eq(catalogCategories.tenant_id, result.tenant.id));
  const [before] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, result.tenant.id));
  await ctx.db
    .insert(catalogCategories)
    .values({ tenant_id: result.tenant.id, name: rows[0]!.name })
    .onConflictDoNothing();
  const [after] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, result.tenant.id));
  expect(after?.logical_bytes).toBe(before?.logical_bytes);
  expect(after?.resource_counts.catalog_categories).toBe("1");
  await policy("50000000");
});

test("physical deletion releases exact content while tenant reassignment is denied", async () => {
  const first = await owned("quota-transfer-first");
  const second = await owned("quota-transfer-second");
  const [baseline] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, first.tenant.id));
  await ctx.db
    .insert(catalogCategories)
    .values({ tenant_id: first.tenant.id, name: "retained", purpose: "saved bytes" });
  let transfer: unknown;
  try {
    await ctx.db
      .update(catalogCategories)
      .set({ tenant_id: second.tenant.id })
      .where(eq(catalogCategories.tenant_id, first.tenant.id));
  } catch (error) {
    transfer = error;
  }
  expect(transfer).toBeDefined();
  await ctx.db.delete(catalogCategories).where(eq(catalogCategories.tenant_id, first.tenant.id));
  const [after] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, first.tenant.id));
  expect(after?.logical_bytes).toBe(baseline?.logical_bytes);
  expect(after?.resource_counts.catalog_categories).toBe("0");
});

test("content-bearing audit cannot bypass quota and fixed lifecycle audit survives a full allowance", async () => {
  const result = await owned("quota-audit");
  const [baseline] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, result.tenant.id));
  await policy(baseline!.logical_bytes.toString());
  await ctx.db.execute(
    sql`INSERT INTO subkit.audit_log(id,tenant_id,actor_type,action,resource_type,resource_id,result,metadata) VALUES(gen_random_uuid(),${result.tenant.id},'system','tenant.restored','tenant',${result.tenant.id},'success','{"via":"verified_identity_recovery"}'::jsonb)`,
  );
  let failure: unknown;
  try {
    await ctx.db.execute(
      sql`INSERT INTO subkit.audit_log(id,tenant_id,actor_type,action,resource_type,resource_id,result,metadata) VALUES(gen_random_uuid(),${result.tenant.id},'system','tenant.restored','tenant',${result.tenant.id},'success','{"via":"verified_identity_recovery","content":"audit-private-canary"}'::jsonb)`,
    );
  } catch (error) {
    failure = error;
  }
  expect(hostedQuotaError(failure)?.code).toBe("hosted_storage_quota_exhausted");
  const clean = hostedQuotaError(failure)!;
  expect(JSON.stringify(clean)).not.toContain("audit-private-canary");
  await policy("50000000");
});

test("generated quota migration matches the reviewed catalog renderer", () => {
  const journal = JSON.parse(
    readFileSync(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: { tag: string }[] };
  const entry = journal.entries.find((value) => value.tag.endsWith("_hosted_resource_quota"));
  expect(entry).toBeDefined();
  expect(readFileSync(new URL(`./migrations/${entry!.tag}.sql`, import.meta.url), "utf8")).toBe(
    renderHostedQuotaSql({ cockpitControls: false }),
  );
});

test("current generated quota SQL retains cockpit revocation receipt controls", () => {
  const current = renderHostedQuotaSql();
  expect(current).toContain("IF kind='session' THEN");
  expect(current).toContain("IF kind='cockpit_installation' THEN");
});

test("trusted transaction and HTTP quota boundaries never expose private query parameters", async () => {
  const result = await owned("quota-boundary");
  const [baseline] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, result.tenant.id));
  await policy(baseline!.logical_bytes.toString());
  const connection = createDbFromUrl(ctx.testDb.url);
  const canary = "private-knowledge-sensitive-auth-canary";
  let failure: unknown;
  try {
    await connection.db.transaction(async (tx) => {
      await tx.insert(catalogCategories).values({ tenant_id: result.tenant.id, name: canary });
    });
  } catch (error) {
    failure = error;
  }
  await connection.pool.end();
  expect(hostedQuotaError(failure) === failure).toBe(true);
  expect(String(failure)).not.toContain(canary);
  expect(JSON.stringify(errorFields(failure))).not.toContain(canary);
  const app = new Hono<AppEnv>();
  app.use("*", errorMiddleware());
  app.onError(
    (error, context) =>
      mapKnownErrorResponse(context, error) ?? new Response("unexpected", { status: 500 }),
  );
  app.get("/quota", async () => {
    await ctx.db.insert(catalogCategories).values({ tenant_id: result.tenant.id, name: canary });
    return new Response("unreachable");
  });
  const response = await app.request("http://fixture.test/quota");
  expect(response.status).toBe(429);
  expect(await response.text()).not.toContain(canary);
  expect(JSON.stringify(logRing.tail({ limit: 1000 }))).not.toContain(canary);
});

test("active policy lowering waits for admitted writers and governs the next commit", async () => {
  const result = await owned("quota-policy-linearization");
  let releaseWriter!: () => void;
  const writerRelease = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  let markWritten!: () => void;
  const written = new Promise<void>((resolve) => {
    markWritten = resolve;
  });
  let writerPid = 0;
  let activationPid = 0;
  const writer = ctx.db.transaction(async (tx) => {
    writerPid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!
      .pid;
    await tx
      .insert(catalogCategories)
      .values({ tenant_id: result.tenant.id, name: "old-policy-write" });
    markWritten();
    await writerRelease;
  });
  await written;
  const activation = ctx.db.transaction(async (tx) => {
    activationPid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))
      .rows[0]!.pid;
    await tx.execute(sql`SELECT 1 FROM subkit.runtime_config_state WHERE key='runtime' FOR UPDATE`);
    await tx.execute(
      sql`WITH next_revision AS (INSERT INTO subkit.runtime_config_revisions(document,digest,status) SELECT jsonb_set(r.document,'{storage,hosted,tenant_bytes}','"1"'::jsonb),'quota-policy-fixture','active' FROM subkit.runtime_config_revisions r JOIN subkit.runtime_config_state s ON s.active_revision=r.revision WHERE s.key='runtime' RETURNING revision) UPDATE subkit.runtime_config_state SET active_revision=next_revision.revision,desired_revision=next_revision.revision FROM next_revision WHERE key='runtime'`,
    );
  });
  try {
    await waitFor(
      async () => {
        if (!activationPid) return false;
        const blockers = await ctx.db.execute<{ blocked: boolean }>(
          sql`SELECT ${writerPid} = ANY(pg_blocking_pids(${activationPid})) AS blocked`,
        );
        return blockers.rows[0]?.blocked;
      },
      { label: "active revision waits for writer share lock", tries: 500, sleepMs: 1 },
    );
  } finally {
    releaseWriter();
  }
  await writer;
  await activation;
  let denied: unknown;
  try {
    await ctx.db
      .insert(catalogCategories)
      .values({ tenant_id: result.tenant.id, name: "after-lowering" });
  } catch (error) {
    denied = error;
  }
  expect(hostedQuotaError(denied)?.code).toBe("hosted_storage_quota_exhausted");
  const rows = await ctx.db
    .select()
    .from(catalogCategories)
    .where(eq(catalogCategories.tenant_id, result.tenant.id));
  expect(rows.map((row) => row.name)).toEqual(["old-policy-write"]);
});

test("negative file sizes cannot mint quota credit through insert or update", async () => {
  const result = await owned("quota-negative-file");
  const [baseline] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, result.tenant.id));
  let denied: unknown;
  try {
    await ctx.db.execute(
      sql`INSERT INTO subkit.files(tenant_id,filename,storage_uri,size_bytes) VALUES(${result.tenant.id},'negative','negative',-5)`,
    );
  } catch (error) {
    denied = error;
  }
  expect(hostedQuotaError(denied)?.code).toBe("hosted_resource_write_rejected");
  const [after] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, result.tenant.id));
  expect(after?.logical_bytes).toBe(baseline?.logical_bytes);
  await ctx.db.execute(
    sql`INSERT INTO subkit.files(tenant_id,filename,storage_uri,size_bytes) VALUES(${result.tenant.id},'positive','positive',5)`,
  );
  let updateDenied: unknown;
  try {
    await ctx.db.execute(
      sql`UPDATE subkit.files SET size_bytes=-5 WHERE tenant_id=${result.tenant.id}`,
    );
  } catch (error) {
    updateDenied = error;
  }
  expect(hostedQuotaError(updateDenied)?.code).toBe("hosted_resource_write_rejected");
  const rows = await ctx.db.execute<{ size_bytes: string }>(
    sql`SELECT size_bytes::text FROM subkit.files WHERE tenant_id=${result.tenant.id}`,
  );
  expect(rows.rows[0]?.size_bytes).toBe("5");
});

test("unknown persisted content column types fail closed", () => {
  expect(() => hostedColumnBytes("unclassified_payload", "payload")).toThrow(
    "hosted_quota_column_type_unclassified",
  );
  expect(hostedColumnBytes("tsvector", "payload")).toContain("octet_length");
});

test("missing or zero canonical policy cannot be replaced by a positive live config cache", async () => {
  const result = await owned("quota-canonical-policy");
  const original = await ctx.db.execute<{ active_revision: string | null }>(
    sql`SELECT active_revision::text FROM subkit.runtime_config_state WHERE key='runtime'`,
  );
  try {
    for (const revision of [original.rows[0]!.active_revision, null]) {
      await policy("0");
      await ctx.db.execute(
        sql`UPDATE subkit.runtime_config_state SET active_revision=${revision}::bigint WHERE key='runtime'`,
      );
      let failure: unknown;
      try {
        await ctx.db
          .insert(catalogCategories)
          .values({ tenant_id: result.tenant.id, name: "must-not-use-live-cache" });
      } catch (error) {
        failure = error;
      }
      expect(hostedQuotaError(failure)?.code).toBe("hosted_storage_quota_exhausted");
    }
  } finally {
    await ctx.db.execute(
      sql`UPDATE subkit.runtime_config_state SET active_revision=${original.rows[0]!.active_revision}::bigint WHERE key='runtime'`,
    );
    await policy("50000000");
  }
});
