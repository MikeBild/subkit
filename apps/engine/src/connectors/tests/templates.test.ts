import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, connectorTemplates } from "../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import * as discoveryService from "../discovery/service.ts";
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
  test("loadBuiltinTemplates returns all valid rows", () => {
    const rows = loadBuiltinTemplates();
    expect(rows.length).toBeGreaterThanOrEqual(50);
    for (const row of rows) {
      const parsed = ConnectorTemplateSchema.safeParse(row);
      expect(parsed.success).toBe(true);
    }
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(rows.length);
    expect(slugs).toContain("stripe");
    expect(slugs).toContain("github");
    expect(slugs).toContain("notion");
    expect(slugs).toContain("jira");
    expect(slugs).toContain("salesforce");
    expect(slugs).toContain("supabase");
    expect(slugs).toContain("cloudflare");
    expect(slugs).toContain("firebase");
    const openapi = rows.filter((r) => r.ingestion_source === "openapi");
    expect(openapi.length).toBeGreaterThanOrEqual(20);
  });

  test("every template has category, setup_instructions and valid slug", () => {
    const rows = loadBuiltinTemplates();
    for (const row of rows) {
      expect(row.category).toBeTruthy();
      expect(row.setup_instructions).toBeTruthy();
      expect(row.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("every template carries the new enriched fields with valid shape", () => {
    const rows = loadBuiltinTemplates();
    for (const row of rows) {
      expect(row.version).toBeGreaterThanOrEqual(1);
      if (row.url_pattern !== null) {
        expect(() => new RegExp(row.url_pattern as string)).not.toThrow();
      }
      expect(Array.isArray(row.keywords)).toBe(true);
      expect(Array.isArray(row.credential_hints)).toBe(true);
      expect(Array.isArray(row.base_url_options)).toBe(true);
      expect(row.capabilities).toBeDefined();
      expect(typeof row.capabilities.webhooks).toBe("boolean");
      expect(Array.isArray(row.capabilities.webhook_events)).toBe(true);
      const fields = row.credential_hints.map((h) => h.field);
      expect(new Set(fields).size).toBe(fields.length);
      const envs = row.base_url_options.map((o) => o.environment);
      expect(new Set(envs).size).toBe(envs.length);
    }
  });

  test("OAuth2 blocks declare the extended control fields", () => {
    const rows = loadBuiltinTemplates();
    const withOauth = rows.filter((r) => r.oauth !== null);
    expect(withOauth.length).toBeGreaterThanOrEqual(25);
    for (const row of withOauth) {
      const o = row.oauth!;
      expect([
        "authorization_code",
        "client_credentials",
        "client_credentials_json",
        "password",
        "cognito_user_password",
      ]).toContain(o.grant_type);
      expect(["body", "basic_auth"]).toContain(o.token_auth_method);
      expect(["form", "json"]).toContain(o.token_content_type);
      expect(typeof o.use_pkce).toBe("boolean");
      expect(o.extra_headers).toBeDefined();
    }
  });

  test("curated top templates carry rich discovery metadata", () => {
    const rows = loadBuiltinTemplates();
    const bySlug = new Map(rows.map((r) => [r.slug, r] as const));
    const top = ["stripe", "hubspot", "shopify", "github", "slack"];
    for (const slug of top) {
      const t = bySlug.get(slug);
      expect(t, `expected top template ${slug}`).toBeDefined();
      expect(t!.keywords.length).toBeGreaterThanOrEqual(3);
      expect(t!.probe_endpoint).not.toBeNull();
    }
  });

  test("auth_options entries have valid auth_type and label", () => {
    const rows = loadBuiltinTemplates();
    const withOptions = rows.filter((r) => r.auth_options.length > 0);
    expect(withOptions.length).toBeGreaterThanOrEqual(20);
    for (const row of withOptions) {
      for (const opt of row.auth_options) {
        expect(opt.auth_type).toBeTruthy();
        expect(opt.label).toBeTruthy();
        expect(opt.description).toBeTruthy();
      }
    }
  });

  test("driver coverage includes all protocol types", () => {
    const rows = loadBuiltinTemplates();
    const drivers = new Set(rows.map((r) => r.driver));
    expect(drivers.has("http")).toBe(true);
    expect(drivers.has("graphql")).toBe(true);
    expect(drivers.has("postgres")).toBe(true);
    expect(drivers.has("s3")).toBe(true);
    expect(drivers.has("sftp")).toBe(true);
    expect(drivers).toEqual(new Set(["http", "graphql", "postgres", "s3", "sftp"]));
  });

  test("github-graphql ships alongside github REST", () => {
    const rows = loadBuiltinTemplates();
    const rest = rows.find((r) => r.slug === "github");
    const gql = rows.find((r) => r.slug === "github-graphql");
    expect(rest?.driver).toBe("http");
    expect(gql?.driver).toBe("graphql");
    expect(gql?.base_url).toBe("https://api.github.com/graphql");
    expect(gql?.default_skill).toBe("github-graphql-basics");
  });

  test("templates that mix auth_type with an oauth block declare auth_options", () => {
    const rows = loadBuiltinTemplates();
    const mixed = rows.filter((r) => r.oauth !== null && r.auth_type !== "oauth2");
    for (const row of mixed) {
      expect(row.auth_options.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("superRefine rejects an auth-inconsistent template", () => {
    const bad = {
      version: 1,
      slug: "bad-auth",
      name: "Bad Auth",
      driver: "http" as const,
      base_url: "https://bad.test",
      auth_type: "bearer" as const,
      oauth: {
        issuer_url: "https://bad.test",
        grant_type: "authorization_code",
        token_auth_method: "body",
        token_content_type: "form",
        use_pkce: false,
        client_id: null,
        extra_headers: {},
      },
      default_skill: null,
      ingestion_source: "openapi" as const,
      ingestion_url: null,
      icon: "bad.svg",
      description: "Bad",
      category: "test",
      tags: [],
      setup_instructions: "Set up Bad Auth by following these instructions.",
      auth_options: [],
      url_pattern: "^https://bad\\.test(/|$)",
      keywords: [],
      inline_schema: null,
      probe_endpoint: null,
      credential_hints: [],
      base_url_options: [],
      pagination_defaults: null,
      capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
    };
    const parsed = ConnectorTemplateSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const joined = parsed.error.issues.map((i) => i.message).join("; ");
      expect(joined).toContain("bad-auth");
      expect(joined).toContain("auth_options");
    }
  });

  test("GET /v1/connector-templates returns built-ins + tenant override", async () => {
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
    const discovery = spyOn(discoveryService, "runDiscoveryCached").mockRejectedValue(
      new Error("test discovery must not start when ingest_now is false"),
    );
    try {
      const res = await fetch(`${srv.baseUrl}/v1/connectors/from-template/stripe`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${srv.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ingest_now: false }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        slug: string;
        base_url: string;
        auth_type: string;
        template_slug: string | null;
        template_source: "builtin" | "tenant" | null;
      };
      expect(body.slug).toBe("stripe");
      expect(body.base_url).toBe("https://api.stripe.com/v1");
      expect(body.auth_type).toBe("bearer");
      expect(body.template_slug).toBe("stripe");
      expect(body.template_source).toBe("builtin");

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
      expect(discovery).not.toHaveBeenCalled();
      expect(tenantWorkSnapshot(srv.tenantId).in_flight).toBe(0);
    } finally {
      discovery.mockRestore();
    }
  });

  for (const { slug, body, label } of [
    {
      slug: "automatic-discovery-default",
      body: {},
      label: "uses the default ingestion decision",
    },
    {
      slug: "automatic-discovery-explicit",
      body: { ingest_now: true },
      label: "honors ingest_now:true",
    },
  ]) {
    test(`from-template keeps automatic discovery when it ${label}`, async () => {
      await srv.db.insert(connectorTemplates).values({
        tenant_id: srv.tenantId,
        slug,
        name: "Automatic Discovery",
        driver: "http",
        base_url: "https://automatic-discovery.test",
        auth_type: "none",
        ingestion_source: "openapi",
        ingestion_url: "https://automatic-discovery.test/openapi.json",
        inline_schema: {
          format: "openapi",
          content: JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Automatic Discovery", version: "1" },
            paths: {},
          }),
        },
      });
      const discovery = spyOn(discoveryService, "runDiscoveryCached").mockRejectedValue(
        new Error("controlled background discovery"),
      );
      try {
        const res = await fetch(`${srv.baseUrl}/v1/connectors/from-template/${slug}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${srv.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(201);
        expect(discovery).toHaveBeenCalledTimes(1);
      } finally {
        discovery.mockRestore();
      }
    });
  }

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

    const err = new UnsupportedIngestionSourceError("notion");
    expect(err.code).toBe("unsupported_ingestion_source");
    expect(err.slug).toBe("notion");
  });
});
