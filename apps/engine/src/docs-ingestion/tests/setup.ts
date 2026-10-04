import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";

export interface DocsTestCtx {
  testDb: TestDb;
  tenantId: string;
  connectorId: string;
  cleanup: () => Promise<void>;
}

export async function createDocsTestCtx(label: string): Promise<DocsTestCtx> {
  const testDb = await createTestDb(`docs-${label}`);
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Docs ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug: `cn-${label}`,
      display_name: `Connector ${label}`,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    })
    .returning();
  if (!connector) throw new Error("seed connector failed");
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
