import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import { catalogCategories, connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { renameCategory } from "../catalog-view.ts";
import { catalogViewFixtures } from "./catalog-view-fixtures.ts";

let ctx: TestDb;

let tenant_id = "";

let apiConnectorId = "";

const { seedConnector, seedWorkflow } = catalogViewFixtures({
  get ctx() {
    return ctx;
  },
  get tenant_id() {
    return tenant_id;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("workflows_catalog_view");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-catalog-view", display_name: "Catalog" })
    .returning();
  tenant_id = t!.id;

  apiConnectorId = await seedConnector("billing-api");
  await seedConnector("unused-api");

  for (const name of ["search-pages", "append-markdown", "page-properties"]) {
    await seedWorkflow(
      `notion-${name}`,
      {
        id: "s1",
        kind: "request",
        method: "GET",
        url: "https://notion.example.test/x",
      },
      "notion",
    );
  }
  for (const name of ["by-date", "tomorrow"]) {
    await seedWorkflow(`berlin-weather-${name}`, {
      id: "s1",
      kind: "request",
      method: "GET",
      url: "https://weather.example.test/x",
    });
  }

  await seedWorkflow("billing-by-id", {
    id: "s1",
    kind: "request",
    connector_id: apiConnectorId,
    method: "GET",
    path: "/invoices",
  });
  await seedWorkflow("billing-by-placeholder", {
    id: "s1",
    kind: "request",
    method: "GET",
    url: "${connector.billing-api.base_url}/invoices",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

const describedAt = "2026-01-01T00:00:00.000Z";

const catalogMetadataWrite =
  "catalog_described_at = $2::timestamptz, catalog_input_hash = 'metadata-only'";

const catalogWriters = [
  {
    table: "connectors",
    key: "id",
    insert:
      "INSERT INTO subkit.connectors (tenant_id, slug, display_name, driver, environment, auth_type, base_url, config, category) VALUES ($1, $2, $2, 'http', 'dev', 'none', 'https://example.test', '{}', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "workflows",
    key: "id",
    insert:
      "INSERT INTO subkit.workflows (tenant_id, slug, name, lifecycle, category) VALUES ($1, $2, $2, 'active', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "skills",
    key: "id",
    insert:
      "INSERT INTO subkit.skills (tenant_id, slug, scope, title, body, lifecycle, category) VALUES ($1, $2, 'global', $2, 'Body', 'active', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "knowledge_sources",
    key: "id",
    insert:
      "INSERT INTO subkit.knowledge_sources (tenant_id, name, slug, source_type, source_uri, version, category) VALUES ($1, $2, $2, 'text', 'inline:', '1', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "files",
    key: "id",
    insert:
      "INSERT INTO subkit.files (tenant_id, filename, storage_uri, status, category) VALUES ($1, $2, 'local://' || $2, 'ready', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "intake_category_defaults",
    key: "actor_id",
    insert:
      "INSERT INTO subkit.intake_category_defaults (tenant_id, actor_type, actor_id, category) VALUES ($1, 'user', md5($2)::uuid, $3) RETURNING actor_id::text AS key",
    metadata: "updated_at = $2::timestamptz",
  },
] as const;

type CatalogWriter = (typeof catalogWriters)[number];

async function insertCatalogRow(
  writer: CatalogWriter,
  slug: string,
  category: string,
  owner = tenant_id,
) {
  const result = await ctx.pool.query<{ key: string }>(writer.insert, [owner, slug, category]);
  const key = result.rows[0]?.key;
  if (!key) throw new Error(`seed ${writer.table} ${slug} failed`);
  return key;
}

function metadataUpdate(writer: CatalogWriter) {
  return `UPDATE subkit.${writer.table} SET ${writer.metadata} WHERE tenant_id = $1 AND ${writer.key}::text = $3`;
}

async function categoryOf(writer: CatalogWriter, key: string, owner = tenant_id) {
  const result = await ctx.pool.query<{ category: string }>(
    `SELECT category FROM subkit.${writer.table} WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
    [owner, key],
  );
  return result.rows[0]?.category;
}

async function waitForLockWait(operation: { done: boolean }) {
  await waitFor(
    async () => {
      if (operation.done) return true;
      const result = await ctx.pool.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      return (result.rows[0]?.waiting ?? 0) > 0;
    },
    { label: "writer waits on the row lock", sleepMs: 5, tries: 1000 },
  );
}

function settled(operation: Promise<unknown>) {
  const tracked = { done: false, result: Promise.resolve<unknown>(null) };
  tracked.result = operation
    .then(
      () => null,
      (error: unknown) => error,
    )
    .finally(() => {
      tracked.done = true;
    });
  return tracked;
}

describe("catalog vocabulary lock scope", () => {
  for (const writer of catalogWriters) {
    const slug = writer.table.replace(/_/g, "-");

    test(`a metadata-only ${writer.table} update succeeds while the vocabulary is locked`, async () => {
      const key = await insertCatalogRow(writer, `lock-scope-${slug}`, "lock-scope");
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, tenant_id);
        const metadataOnly = await ctx.pool.query(metadataUpdate(writer), [
          tenant_id,
          describedAt,
          key,
        ]);
        expect(metadataOnly.rowCount).toBe(1);
        const sameCategory = await ctx.pool.query(
          `UPDATE subkit.${writer.table} SET category = category WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
          [tenant_id, key],
        );
        expect(sameCategory.rowCount).toBe(1);
      });
      expect(await categoryOf(writer, key)).toBe("lock-scope");
    });

    test(`a ${writer.table} category change still fails closed while the vocabulary is locked`, async () => {
      const key = await insertCatalogRow(writer, `lock-change-${slug}`, "lock-scope");
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, tenant_id);
        await expect(
          ctx.pool.query(
            `UPDATE subkit.${writer.table} SET category = 'lock-elsewhere' WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
            [tenant_id, key],
          ),
        ).rejects.toMatchObject({ code: "40001" });
      });
      expect(await categoryOf(writer, key)).toBe("lock-scope");
    });
  }

  test("a platform skill insert still fails closed while the vocabulary is locked", async () => {
    await ctx.db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, tenant_id);
      await expect(
        ctx.pool.query(
          "INSERT INTO subkit.skills (tenant_id, slug, scope, title, body, lifecycle, category) VALUES ($1, 'locked-platform', 'global', 'Locked', 'Body', 'active', 'platform')",
          [tenant_id],
        ),
      ).rejects.toMatchObject({ code: "40001" });
    });
  });

  test("moving a row to another tenant still takes that tenant's vocabulary lock", async () => {
    const [other] = await ctx.db
      .insert(tenants)
      .values({ slug: "lock-scope-destination", display_name: "Destination" })
      .returning();
    if (!other) throw new Error("Tenant missing");
    const writer = catalogWriters[0];
    const key = await insertCatalogRow(writer, "lock-tenant-move", "lock-scope");
    await ctx.db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, other.id);
      await expect(
        ctx.pool.query(
          "UPDATE subkit.connectors SET tenant_id = $2 WHERE tenant_id = $1 AND id::text = $3",
          [tenant_id, other.id, key],
        ),
      ).rejects.toMatchObject({ code: "40001" });
    });
    expect(await categoryOf(writer, key)).toBe("lock-scope");
  });

  test("a rename waits for an open metadata writer and then moves its row", async () => {
    const writer = catalogWriters[0];
    const key = await insertCatalogRow(writer, "race-writer-first", "race-a");
    const metadataWriter = await ctx.pool.connect();
    try {
      await metadataWriter.query("BEGIN");
      await metadataWriter.query(metadataUpdate(writer), [tenant_id, describedAt, key]);
      const rename = settled(
        renameCategory(
          {
            tenant_id,
            from: "race-a",
            to: "race-b",
            purpose: "Race purpose",
            aliases: [],
            expected_source_revision: 1,
            expected_target_revision: null,
          },
          ctx.db,
        ),
      );
      await waitForLockWait(rename);
      await metadataWriter.query("COMMIT");
      expect(await rename.result).toBeNull();
    } finally {
      await metadataWriter.query("ROLLBACK");
      metadataWriter.release();
    }
    const [row] = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, key)));
    expect(row?.category).toBe("race-b");
    expect(row?.catalog_input_hash).toBe("metadata-only");
    const [redirect] = await ctx.db
      .select()
      .from(catalogCategories)
      .where(and(eq(catalogCategories.tenant_id, tenant_id), eq(catalogCategories.name, "race-a")));
    expect(redirect?.redirect_to).toBe("race-b");
  });

  test("a metadata writer behind an open rename keeps the renamed category", async () => {
    const writer = catalogWriters[0];
    const key = await insertCatalogRow(writer, "race-rename-first", "race-c");
    const renamer = await ctx.pool.connect();
    try {
      await renamer.query("BEGIN");
      await renamer.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 741937))", [
        tenant_id,
      ]);
      await renamer.query(
        "UPDATE subkit.connectors SET category = 'race-d' WHERE tenant_id = $1 AND category = 'race-c'",
        [tenant_id],
      );
      await renamer.query(
        "UPDATE subkit.catalog_categories SET redirect_to = 'race-d' WHERE tenant_id = $1 AND name = 'race-c'",
        [tenant_id],
      );
      const metadataOnly = settled(
        ctx.pool.query(metadataUpdate(writer), [tenant_id, describedAt, key]),
      );
      await waitForLockWait(metadataOnly);
      await renamer.query("COMMIT");
      expect(await metadataOnly.result).toBeNull();
    } finally {
      await renamer.query("ROLLBACK");
      renamer.release();
    }
    expect(await categoryOf(writer, key)).toBe("race-d");
    await ctx.pool.query(
      "UPDATE subkit.connectors SET category = 'race-c' WHERE tenant_id = $1 AND id::text = $2",
      [tenant_id, key],
    );
    expect(await categoryOf(writer, key)).toBe("race-d");
  });
});

describe("catalog vocabulary lock scope on hosted tenants", () => {
  let hosted_tenant_id = "";

  beforeAll(async () => {
    await configureHostedPolicyForTests(ctx.db, ctx.url);
    const hosted = await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example.test",
        subject: "lock-scope-hosted",
        email: "lock-scope-hosted@example.test",
        email_verified: true,
      },
      ctx.db,
    );
    hosted_tenant_id = hosted.tenant.id;
  });

  for (const writer of catalogWriters) {
    const slug = writer.table.replace(/_/g, "-");

    test(`a byte-neutral ${writer.table} update succeeds while the hosted vocabulary is locked`, async () => {
      const key = await insertCatalogRow(
        writer,
        `hosted-neutral-${slug}`,
        "lock-scope",
        hosted_tenant_id,
      );
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, hosted_tenant_id);
        const sameCategory = await ctx.pool.query(
          `UPDATE subkit.${writer.table} SET category = category WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
          [hosted_tenant_id, key],
        );
        expect(sameCategory.rowCount).toBe(1);
      });
      expect(await categoryOf(writer, key, hosted_tenant_id)).toBe("lock-scope");
    });

    if (writer.metadata !== catalogMetadataWrite) continue;

    test(`a metered ${writer.table} metadata update fails closed through the hosted quota while the vocabulary is locked`, async () => {
      const key = await insertCatalogRow(
        writer,
        `hosted-metered-${slug}`,
        "lock-scope",
        hosted_tenant_id,
      );
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, hosted_tenant_id);
        await expect(
          ctx.pool.query(metadataUpdate(writer), [hosted_tenant_id, describedAt, key]),
        ).rejects.toMatchObject({
          code: "40001",
          message: "hosted_quota_concurrent_write",
        });
      });
      expect(await categoryOf(writer, key, hosted_tenant_id)).toBe("lock-scope");
    });
  }
});
