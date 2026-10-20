import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { setConfigKey } from "../config/loader.ts";
import { hostedTenantUsage, tenantBranding, tenants } from "../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../http/tests/setup.ts";
import type { TenantErasureQueue } from "../queue/tenant-erasure.ts";
import { MemoryObjectStore } from "../storage/object-store.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { eraseExpiredTenant } from "./tenant-erasure.ts";

let ctx: HttpTestServer;
let headers: Record<string, string>;
let logoBase64: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("tenant-branding-hosted-quota", {
    operator: false,
    hosted: true,
  });
  for (const dimension of ["peer", "principal", "tenant", "global"] as const)
    await setConfigKey(`server.hosted_rate_limit.${dimension}_per_minute`, 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10_000);
  headers = await browserSessionHeaders(ctx, ctx.userId);
  logoBase64 = (
    await sharp({ create: { width: 512, height: 512, channels: 4, background: "#2563eb" } })
      .png()
      .toBuffer()
  ).toString("base64");
});

afterAll(async () => {
  await ctx.cleanup();
});

function update(revision: number) {
  return {
    revision,
    display_name: "Acme Research",
    subtitle: "Governed work",
    palette: "indigo",
    logos: {
      light: {
        operation: "replace",
        mime_type: "image/png",
        content_base64: logoBase64,
      },
      dark: { operation: "keep" },
    },
  };
}

test("hosted branding is quota-metered and reset releases normalized logo bytes", async () => {
  const [before] = await ctx.db
    .select({ logical_bytes: hostedTenantUsage.logical_bytes })
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  if (!before) throw new Error("hosted tenant usage missing");
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${before.logical_bytes.toString()}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );

  const denied = await fetch(`${ctx.baseUrl}/v1/tenant/branding`, {
    method: "PUT",
    headers,
    body: JSON.stringify(update(0)),
  });
  expect(denied.status).toBe(429);
  expect(await denied.json()).toMatchObject({ code: "hosted_storage_quota_exhausted" });

  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}','"50000000"'::jsonb) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  const saved = await fetch(`${ctx.baseUrl}/v1/tenant/branding`, {
    method: "PUT",
    headers,
    body: JSON.stringify(update(0)),
  });
  expect(saved.status).toBe(200);
  const [afterSave] = await ctx.db
    .select({ logical_bytes: hostedTenantUsage.logical_bytes })
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  expect(afterSave?.logical_bytes).toBeGreaterThan(before.logical_bytes);

  const reset = await fetch(`${ctx.baseUrl}/v1/tenant/branding`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ revision: 1 }),
  });
  expect(reset.status).toBe(200);
  const [afterReset] = await ctx.db
    .select({ logical_bytes: hostedTenantUsage.logical_bytes })
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  expect(afterReset?.logical_bytes).toBeLessThan(afterSave?.logical_bytes ?? 0n);
});

function erasureQueue(): TenantErasureQueue {
  return {
    async getQueues() {
      return [];
    },
    async getSchedules() {
      return [];
    },
    async findJobs() {
      return [];
    },
    async cancel() {},
    async deleteJob() {},
    async unschedule() {},
  };
}

test("full hosted tenant erasure removes persisted branding bytes", async () => {
  const saved = await fetch(`${ctx.baseUrl}/v1/tenant/branding`, {
    method: "PUT",
    headers,
    body: JSON.stringify(update(2)),
  });
  expect(saved.status).toBe(200);
  expect(
    await ctx.db
      .select({ tenant_id: tenantBranding.tenant_id })
      .from(tenantBranding)
      .where(eq(tenantBranding.tenant_id, ctx.tenantId)),
  ).toHaveLength(1);
  await ctx.db
    .update(tenants)
    .set({
      status: "pending_deletion",
      deletion_requested_at: new Date(getTestNow() - 8 * 86_400_000),
      deletion_scheduled_for: new Date(getTestNow() - 1),
    })
    .where(eq(tenants.id, ctx.tenantId));

  expect(
    await eraseExpiredTenant(
      ctx.tenantId,
      { queue: erasureQueue(), objects: new MemoryObjectStore() },
      ctx.db,
    ),
  ).toEqual({
    status: "completed",
  });
  expect(
    await ctx.db
      .select({ tenant_id: tenantBranding.tenant_id })
      .from(tenantBranding)
      .where(eq(tenantBranding.tenant_id, ctx.tenantId)),
  ).toHaveLength(0);
});
