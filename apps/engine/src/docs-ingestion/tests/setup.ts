import { authIdentities } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedConnector, seedTenant } from "../../test-helpers/seed.ts";

export interface DocsTestCtx {
  testDb: TestDb;
  tenantId: string;
  connectorId: string;
  cleanup: () => Promise<void>;
}

export async function createDocsTestCtx(
  label: string,
  options: { hosted?: boolean } = {},
): Promise<DocsTestCtx> {
  const testDb = await createTestDb(`docs-${label}`);
  let ownerId: string | undefined;
  if (options.hosted) {
    await configureHostedPolicyForTests(testDb.db, testDb.url);
    const [identity] = await testDb.db
      .insert(authIdentities)
      .values({
        issuer_url: "https://identity.example.test",
        subject: label,
        email: `${label}@example.test`,
      })
      .returning();
    if (!identity) throw new Error("identity fixture missing");
    ownerId = identity.id;
  }
  const tenant = await seedTenant(testDb.db, {
    slug: `t-${label}`,
    display_name: `Docs ${label}`,
    ...(ownerId ? { origin: "self_service" as const, owner_identity_id: ownerId } : {}),
  });
  const connector = await seedConnector(testDb.db, {
    tenant_id: tenant.id,
    slug: `cn-${label}`,
    display_name: `Connector ${label}`,
    driver: "http",
    environment: "dev",
    auth_type: "none",
    base_url: "https://example.test",
  });
  return {
    testDb,
    tenantId: tenant.id,
    connectorId: connector.id,
    cleanup: testDb.cleanup,
  };
}

export function stubFetch(
  table: Record<string, { body: string; status?: number; headers?: Record<string, string> }>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const row = table[url];
    if (!row) throw new Error(`stubFetch: no mock for ${url}`);
    const status = row.status ?? 200;
    return new Response(row.body, {
      status,
      headers: row.headers ?? { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
