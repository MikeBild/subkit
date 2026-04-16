import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import {
  ConnectorTemplateSchema,
  loadBuiltinTemplates,
  UnsupportedIngestionSourceError,
} from "../templates.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("connector-templates");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("connector templates", () => {
  test("loadBuiltinTemplates returns exactly 10 valid rows", () => {
    const rows = loadBuiltinTemplates();
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      const parsed = ConnectorTemplateSchema.safeParse(row);
      expect(parsed.success).toBe(true);
    }
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(10);
    expect(slugs).toContain("stripe");
    expect(slugs).toContain("github");
    expect(slugs).toContain("notion");
    const openapi = rows.filter((r) => r.ingestion_source === "openapi");
    expect(openapi.length).toBeGreaterThanOrEqual(6);
  });

  test("GET /v1/connector-templates returns built-ins + tenant override", async () => {
    // Insert a tenant override row.
    const { connectorTemplates } = await import("../../db/schema/index.ts");
    await srv.db
      .insert(connectorTemplates)
      .values({
        tenant_id: srv.tenantId,
        slug: "internal-billing",
        name: "Internal Billing",
        driver: "http",
        base_url: "https://billing.internal.test",
        auth_type: "bearer",
        oauth: null,
        default_skill: null,
        ingestion_source: "openapi",
        ingestion_url: "https://billing.internal.test/openapi.json",
        icon: "billing.svg",
        description: "Internal billing API",
      })
      .returning();

    const res = await fetch(`${srv.baseUrl}/v1/connector-templates`, {
      headers: { Authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        slug: string;
        source: "builtin" | "tenant";
        id: string | null;
      }>;
    };
    const slugs = body.items.map((i) => i.slug);
    expect(slugs).toContain("stripe");
    expect(slugs).toContain("internal-billing");
    const tenantRow = body.items.find((i) => i.slug === "internal-billing");
    expect(tenantRow?.source).toBe("tenant");
    expect(tenantRow?.id).toBeTruthy();
    const builtin = body.items.find((i) => i.slug === "stripe");
    expect(builtin?.source).toBe("builtin");
    expect(builtin?.id).toBeNull();
  });

  test("POST /v1/connectors/from-template/stripe creates a connector + audit", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/connectors/from-template/stripe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      slug: string;
      base_url: string;
      auth_type: string;
    };
    expect(body.slug).toBe("stripe");
    expect(body.base_url).toBe("https://api.stripe.com/v1");
    expect(body.auth_type).toBe("bearer");

    const cnRows = await srv.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, srv.tenantId), eq(connectors.id, body.id)))
      .limit(1);
    expect(cnRows[0]?.slug).toBe("stripe");

    const auditRows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.resource_id, body.id)));
    const provenance = auditRows.find((r) => {
      const meta = (r.metadata as { template_slug?: string }) ?? {};
      return meta.template_slug === "stripe";
    });
    expect(provenance).toBeTruthy();
  });

  test("from-template with ingest_now on unsupported template returns typed error", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/connectors/from-template/notion`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ingest_now: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("unsupported_ingestion_source");

    // Sanity-check the error class itself.
    const err = new UnsupportedIngestionSourceError("notion");
    expect(err.code).toBe("unsupported_ingestion_source");
    expect(err.slug).toBe("notion");
  });
});
