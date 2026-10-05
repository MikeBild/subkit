import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, events, tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { runEndpointContractScanForTenant } from "../endpoint-contract-scan-runner.ts";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SUNSET = "Sat, 31 Jan 2026 23:59:59 GMT";

let db: TestDb;
let tenantId: string;
let otherTenantId: string;
let mock: MockServer;
let requestedPaths: string[] = [];

beforeAll(async () => {
  db = await createTestDb("contract-scan");

  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-contract", display_name: "Contract Tenant" })
    .returning();
  tenantId = t!.id;
  const [t2] = await db.db
    .insert(tenants)
    .values({ slug: "t-contract-other", display_name: "Other Tenant" })
    .returning();
  otherTenantId = t2!.id;

  mock = await createMockServer((req, res) => {
    requestedPaths.push(req.url ?? "");
    if (req.url?.startsWith("/gone")) {
      res.statusCode = 410;
      res.setHeader("content-type", "application/json");
      res.setHeader("link", '<https://example.test/v2/replacement>; rel="successor-version"');
      res.end(JSON.stringify({ error: "gone" }));
      return;
    }
    if (req.url?.startsWith("/deprecated")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("deprecation", "true");
      res.setHeader("sunset", SUNSET);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await db.cleanup();
});

async function seedConnector(tenant: string, slug: string): Promise<string> {
  const [c] = await db.db
    .insert(connectors)
    .values({
      tenant_id: tenant,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  return c!.id;
}

async function seedCommittedWorkflow(
  tenant: string,
  slug: string,
  connectorId: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): Promise<string> {
  const [w] = await db.db
    .insert(workflows)
    .values({ tenant_id: tenant, slug, name: slug, lifecycle: "active" })
    .returning();
  const [v] = await db.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant,
      workflow_id: w!.id,
      version: 1,
      dag: {
        name: slug,
        steps: [
          {
            kind: "request",
            id: "call",
            method: "GET",
            connector_id: connectorId,
            path,
            ...(query ? { query } : {}),
          },
        ],
      },
    })
    .returning();
  await db.db.update(workflows).set({ current_version_id: v!.id }).where(eq(workflows.id, w!.id));
  return w!.id;
}

async function connectorRow(id: string) {
  const rows = await db.db.select().from(connectors).where(eq(connectors.id, id));
  return rows[0]!;
}

async function healthEvents(tenant: string) {
  return db.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, tenant), eq(events.type, "connector.health_changed")));
}

describe("endpoint-contract scan", () => {
  test("410 on a committed operation flips connector needs_update + workflow needs_attention — no execution", async () => {
    const connectorId = await seedConnector(tenantId, "contract-gone");
    const workflowId = await seedCommittedWorkflow(tenantId, "wf-gone", connectorId, "/gone");
    const before = (await healthEvents(tenantId)).length;
    requestedPaths = [];

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);

    expect(requestedPaths.some((p) => p.startsWith("/gone"))).toBe(true);

    const conn = await connectorRow(connectorId);
    expect(conn.health_state).toBe("needs_update");
    expect(conn.health_error_code).toBe("endpoint_removed");
    expect(conn.successor_uri).toBe("https://example.test/v2/replacement");

    const wf = await db.db.select().from(workflows).where(eq(workflows.id, workflowId));
    expect(wf[0]!.health_state).toBe("needs_attention");

    expect((await healthEvents(tenantId)).length - before).toBe(1);

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);
    expect((await healthEvents(tenantId)).length - before).toBe(1);
  });

  test("200 + Deprecation/Sunset flags endpoint_deprecated with sunset_at — call never failed", async () => {
    const connectorId = await seedConnector(tenantId, "contract-deprecated");
    await seedCommittedWorkflow(tenantId, "wf-deprecated", connectorId, "/deprecated");

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);

    const conn = await connectorRow(connectorId);
    expect(conn.health_state).toBe("needs_update");
    expect(conn.health_error_code).toBe("endpoint_deprecated");
    expect(conn.sunset_at).not.toBeNull();
  });

  test("200 plain keeps the connector ok", async () => {
    const connectorId = await seedConnector(tenantId, "contract-ok");
    await seedCommittedWorkflow(tenantId, "wf-ok", connectorId, "/ok");
    const before = (await healthEvents(tenantId)).length;

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);

    expect((await connectorRow(connectorId)).health_state).toBe("ok");
    expect((await healthEvents(tenantId)).length).toBe(before);
  });

  test("placeholdered paths are never probed", async () => {
    const connectorId = await seedConnector(tenantId, "contract-placeholder");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is the subject under test
    await seedCommittedWorkflow(tenantId, "wf-ph", connectorId, "/items/${input.id}");
    requestedPaths = [];

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);

    expect(requestedPaths.some((p) => p.includes("items"))).toBe(false);
    expect((await connectorRow(connectorId)).health_state).toBe("ok");
  });

  test("a committed operation is probed with its static query, never as a bare path", async () => {
    const connectorId = await seedConnector(tenantId, "contract-query");
    await seedCommittedWorkflow(tenantId, "wf-query", connectorId, "/stats", {
      bucket: "day",
      limit: 5,
    });
    requestedPaths = [];

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);

    const probes = requestedPaths.filter((p) => p.startsWith("/stats"));
    expect(probes).toHaveLength(1);
    const query = new URL(probes[0] ?? "", "http://probe.test").searchParams;
    expect(query.get("bucket")).toBe("day");
    expect(query.get("limit")).toBe("5");
  });

  test("an operation whose query is resolved at run time is never probed", async () => {
    const connectorId = await seedConnector(tenantId, "contract-query-placeholder");
    await seedCommittedWorkflow(tenantId, "wf-query-ph", connectorId, "/window", {
      bucket: "hour",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is the subject under test
      from: "${input.from}",
    });
    requestedPaths = [];

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);

    expect(requestedPaths.some((p) => p.startsWith("/window"))).toBe(false);
  });

  test("tenant isolation: another tenant's identical workflow is untouched", async () => {
    const otherConnector = await seedConnector(otherTenantId, "contract-gone-other");
    await seedCommittedWorkflow(otherTenantId, "wf-gone-other", otherConnector, "/gone");

    await runEndpointContractScanForTenant(tenantId, NOW, db.db);

    expect((await connectorRow(otherConnector)).health_state).toBe("ok");
  });
});
