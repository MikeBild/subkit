import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants, users } from "../../apps/engine/src/db/schema/index.ts";
import { createTestDb, type TestDb } from "../../apps/engine/src/db/tests/setup.ts";
import { builtinRoleId } from "../../apps/engine/src/rbac/roles.ts";
import {
  cockpitDemoId,
  cockpitDemoOwnerEmail,
  cockpitDemoOwnerName,
  cockpitDemoOwnerSql,
  cockpitDemoSetupTenantName,
  cockpitDemoTenantName,
  cockpitDemoTenantSlug,
  createCockpitDemoSeedSql,
} from "./cockpit-demo-seed.ts";

let context: TestDb;
let tenantId: string;
let adminId: string;
type ArchiveRow = {
  after: { status?: string } | null;
  actor_type: string;
  actor_exists: boolean;
  current_status: string;
  source_created_at: Date;
  source_updated_at: Date;
  ts: Date;
  metadata: {
    origin_source?: string;
    request_source?: string;
    audit_credential_origin?: string;
    audit_trace_id?: string;
    execution_id?: string;
  };
  credential_exists: boolean;
  credential_owner_id: string | null;
  conversation_exists: boolean;
  conversation_owner_id: string | null;
  actor_id: string | null;
};

beforeAll(async () => {
  context = await createTestDb("cockpit_demo_seed");
  const [tenant] = await context.db
    .insert(tenants)
    .values({
      slug: cockpitDemoTenantSlug,
      display_name: cockpitDemoSetupTenantName,
    })
    .returning();
  if (!tenant) throw new Error("missing test tenant");
  tenantId = tenant.id;
  const [admin] = await context.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: "demo-owner@localhost.test",
      role_id: await builtinRoleId(context.db, "admin"),
    })
    .returning();
  if (!admin) throw new Error("missing test admin");
  adminId = admin.id;
}, 60_000);

afterAll(async () => {
  if (context) await context.cleanup();
}, 30_000);

test("archive audit story has valid persisted status, actor, credential, conversation and time relations", async () => {
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const sourceId = cockpitDemoId(tenantId, "knowledge-0");
  const result = await context.pool.query(
    `SELECT a.id::text, a.action, a.result, a.actor_type, a.actor_id::text,
            a.ts, a.before, a.after, a.metadata,
            k.status::text AS current_status, k.created_at AS source_created_at,
            k.updated_at AS source_updated_at,
            u.id IS NOT NULL AS actor_exists,
            key.id IS NOT NULL AS credential_exists,
            key.user_id::text AS credential_owner_id,
            c.id IS NOT NULL AS conversation_exists,
            c.owner_id::text AS conversation_owner_id
       FROM audit_log a
       JOIN knowledge_sources k ON k.id::text=a.resource_id AND k.tenant_id=a.tenant_id
       LEFT JOIN users u ON u.id=a.actor_id AND u.tenant_id=a.tenant_id
       LEFT JOIN api_keys key ON key.id::text=a.metadata->>'audit_used_api_key_id'
                             AND key.tenant_id=a.tenant_id
       LEFT JOIN conversations c ON c.id::text=a.metadata->>'conversation_id'
                                AND c.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 AND a.resource_type='knowledge_source' AND a.resource_id=$2
      ORDER BY a.ts`,
    [tenantId, sourceId],
  );
  expect(result.rows).toHaveLength(7);
  const rows = result.rows as ArchiveRow[];
  expect(rows.map((row) => row.after?.status ?? null)).toEqual([
    "processing",
    "active",
    "inactive",
    null,
    "active",
    null,
    null,
  ]);
  expect(rows.every((row) => row.current_status === "active")).toBe(true);
  expect(rows.filter((row) => row.actor_type === "user").every((row) => row.actor_exists)).toBe(
    true,
  );
  expect(rows[0]?.source_created_at.getTime()).toBe(rows[0]?.ts.getTime());
  expect(rows[0]?.source_updated_at.getTime()).toBe(rows[4]?.ts.getTime());
  expect(rows[2]?.metadata.origin_source).toBe("api");
  expect(rows[2]?.metadata.request_source).toBe("api");
  expect(rows[2]?.metadata.audit_credential_origin).toBe("cli_oauth_session");
  expect(rows[2]?.credential_exists).toBe(true);
  expect(rows[2]?.credential_owner_id).toBe(rows[2]?.actor_id);
  expect(rows[3]?.credential_exists).toBe(true);
  expect(rows[0]?.metadata.audit_trace_id).toBe(rows[1]?.metadata.audit_trace_id);
  expect(rows[2]?.metadata.audit_trace_id).toBe(rows[3]?.metadata.audit_trace_id);
  expect(rows[4]?.conversation_exists).toBe(true);
  expect(rows[4]?.conversation_owner_id).toBe(rows[4]?.actor_id);
  expect(rows[5]?.conversation_exists).toBe(true);
  expect(rows[4]?.metadata.audit_trace_id).toBe(rows[5]?.metadata.audit_trace_id);
  expect(rows.every((row) => row.metadata.execution_id === undefined)).toBe(true);
  const versions = await context.pool.query(
    "SELECT version, author_user_id::text, created_at FROM knowledge_source_versions WHERE tenant_id=$1 AND knowledge_source_id=$2",
    [tenantId, sourceId],
  );
  expect(versions.rows).toHaveLength(1);
  expect(versions.rows[0]?.author_user_id).toBe(adminId);
  expect(versions.rows[0]?.author_user_id).toBe(rows[0]?.actor_id);
  expect(versions.rows[0]?.created_at.getTime()).toBe(rows[1]?.ts.getTime());
}, 60_000);

test("seed presents the demo tenant and owner as a fictional customer and keeps the owner lookup", async () => {
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const tenant = await context.pool.query("SELECT display_name FROM tenants WHERE id=$1", [
    tenantId,
  ]);
  expect(tenant.rows[0]?.display_name).toBe(cockpitDemoTenantName);
  const owner = await context.pool.query("SELECT email, display_name FROM users WHERE id=$1", [
    adminId,
  ]);
  expect(owner.rows[0]).toEqual({
    email: cockpitDemoOwnerEmail,
    display_name: cockpitDemoOwnerName,
  });
  const lookup = await context.pool.query(
    `SELECT t.id::text AS tenant_id, u.id::text AS user_id FROM tenants t JOIN users u ON u.tenant_id=t.id ${cockpitDemoOwnerSql} LIMIT 1`,
  );
  expect(lookup.rows).toEqual([{ tenant_id: tenantId, user_id: adminId }]);
  const people = await context.pool.query(
    "SELECT email FROM users WHERE tenant_id=$1 ORDER BY email",
    [tenantId],
  );
  expect(people.rows.every((row) => /@brennwerk\.(example|test)$/.test(String(row.email)))).toBe(
    true,
  );
}, 60_000);

test("demo brand assets satisfy the branding image rules and apply once per content", async () => {
  const { normalizeBrandingAppIcon, normalizeBrandingImage } = await import(
    "../../apps/engine/src/files/branding-image.ts"
  );
  const { applyCockpitDemoBranding, cockpitDemoBrandingUpdate, cockpitDemoBrandingDigest } =
    await import("./cockpit-demo-branding.ts");
  const update = cockpitDemoBrandingUpdate(3);
  expect(update.display_name).toBe("Brennwerk");
  expect(update.subtitle).toBe("Logistik");
  expect(update.palette).toBe("teal");
  for (const logo of [update.logos.light, update.logos.dark]) {
    expect(Buffer.from(logo.content_base64, "base64").length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((await normalizeBrandingImage(logo)).length).toBeGreaterThan(0);
  }
  expect(Buffer.from(update.app_icon.content_base64, "base64").length).toBeLessThanOrEqual(
    2 * 1024 * 1024,
  );
  const icons = await normalizeBrandingAppIcon(update.app_icon);
  expect(icons.icon_512.length).toBeGreaterThan(0);

  const calls: string[][] = [];
  const request = async (path: string, method = "GET") => {
    calls.push([method, path]);
    return { revision: 3 };
  };
  const digest = await applyCockpitDemoBranding(request, undefined);
  expect(digest).toBe(cockpitDemoBrandingDigest());
  expect(calls).toEqual([
    ["GET", "/v1/tenant/branding"],
    ["PUT", "/v1/tenant/branding"],
  ]);
  expect(await applyCockpitDemoBranding(request, digest)).toBe(digest);
  expect(calls).toHaveLength(2);
});
