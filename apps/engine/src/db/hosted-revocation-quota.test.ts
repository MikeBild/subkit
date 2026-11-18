import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { issueBrowserSession } from "../auth/browser-session.ts";
import { auditLog, hostedTenantUsage } from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import {
  createOrReuseCockpitInstallation,
  revokeCockpitInstallation,
} from "../identity/cockpit-installations.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { hostedControlReceiptId } from "./hosted-control-receipt.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-revocation-quota", { hosted: true, operator: false });
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
});
afterAll(async () => {
  await ctx?.cleanup();
});

test("a full hosted allowance still permits only bound installation revocation receipts", async () => {
  const { installation } = await createOrReuseCockpitInstallation(ctx.db, ctx.tenantId, ctx.userId);
  const sessions = await Promise.all(
    Array.from({ length: 2 }, () =>
      issueBrowserSession({
        db: ctx.db,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        installationId: installation.id,
        redirectTo: "/",
        via: "test",
      }),
    ),
  );
  const [before] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  if (!before) throw new Error("hosted tenant usage missing");
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${before.logical_bytes}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );

  expect(await revokeCockpitInstallation(ctx.db, installation.id, ctx.tenantId, ctx.userId)).toBe(
    true,
  );
  const [after] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  expect(after?.logical_bytes).toBe(before.logical_bytes);
  const receipts = (await ctx.db.select().from(auditLog)).filter(
    (row) =>
      row.tenant_id === ctx.tenantId &&
      (row.action === AuditAction.SESSION_REVOKED ||
        row.action === AuditAction.COCKPIT_INSTALLATION_REVOKED),
  );
  expect(receipts).toHaveLength(3);
  expect(receipts.map((row) => row.id)).toEqual(
    expect.arrayContaining([
      hostedControlReceiptId(ctx.tenantId, "cockpit_installation", installation.id),
    ]),
  );
  for (const response of sessions) {
    const rejected = await fetch(
      ctx.baseUrl + "/cockpit/i/" + installation.id + "/api/v1/cockpit/bootstrap",
      { headers: { cookie: response.headers.get("set-cookie") ?? "" } },
    );
    expect(rejected.status).toBe(401);
  }
  await expect(
    auditAwait(
      {
        id: hostedControlReceiptId(ctx.tenantId, "session", installation.id),
        tenant_id: ctx.tenantId,
        actor_type: "user",
        actor_id: ctx.userId,
        action: AuditAction.SESSION_REVOKED,
        resource_type: "session",
        resource_id: installation.id,
        result: "success",
        reason: "installation_revoked",
        metadata: { installation_id: installation.id },
      },
      ctx.db,
    ),
  ).rejects.toThrow();
  const neighbor = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "hosted-revocation-quota-neighbor",
      email: "hosted-revocation-quota-neighbor@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  expect(neighbor.tenant.id).not.toBe(ctx.tenantId);
});
