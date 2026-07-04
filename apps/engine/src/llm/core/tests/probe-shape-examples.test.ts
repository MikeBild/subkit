// `loadProbeShapeExamples` — the "Recorded endpoint samples" loader
// (payload-first generation context).
//
// Verifies against a real Postgres database:
//   - latest shape per endpoint wins (newest seen_at);
//   - per-connector endpoint cap (≤ PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR);
//   - tenant isolation: tenant B's connector shapes NEVER load for
//     tenant A, even when tenant A passes tenant B's connector id;
//   - non-UUID connector ids (recipe placeholders like "${stripe}")
//     are filtered without erroring;
//   - empty result when no shapes were recorded.
// Plus pure-render assertions on `formatProbeShapeExamples` /
// `summarizeShape`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, schemaVersions, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { recordSuccessShape } from "../../../schema-versions/service.ts";
import {
  formatProbeShapeExamples,
  PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR,
  summarizeShape,
} from "../context-assembler/formatters.ts";
import { loadProbeShapeExamples } from "../context-assembler/loaders.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let connectorA: string;
let connectorB: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("probe_shape_examples");

  const [ta] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-shapes-a", display_name: "Shapes Tenant A" })
    .returning();
  const [tb] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-shapes-b", display_name: "Shapes Tenant B" })
    .returning();
  tenantA = ta!.id;
  tenantB = tb!.id;

  const [ca] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantA,
      slug: "digitalocean",
      display_name: "DigitalOcean",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.digitalocean.example",
      config: {},
    })
    .returning();
  const [cb] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantB,
      slug: "tenant-b-secret-api",
      display_name: "Tenant B Secret API",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://secret.tenant-b.example",
      config: {},
    })
    .returning();
  connectorA = ca!.id;
  connectorB = cb!.id;

  // Tenant A shapes: one endpoint with an OLD and a NEW shape (explicit
  // seen_at so "latest wins" is deterministic, never clock-dependent),
  // plus enough extra endpoints to exceed the per-connector cap.
  await ctx.db.insert(schemaVersions).values([
    {
      tenant_id: tenantA,
      connector_id: connectorA,
      endpoint_key: "GET /v2/droplets",
      schema: { type: "object", properties: { old_field: { type: "string" } } },
      seen_at: new Date("2026-06-01T00:00:00Z"),
    },
    {
      tenant_id: tenantA,
      connector_id: connectorA,
      endpoint_key: "GET /v2/droplets",
      schema: {
        type: "object",
        properties: {
          droplets: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "number" }, name: { type: "string" } },
            },
          },
        },
      },
      seen_at: new Date("2026-06-10T00:00:00Z"),
    },
    ...Array.from({ length: PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR + 2 }, (_, i) => ({
      tenant_id: tenantA,
      connector_id: connectorA,
      endpoint_key: `GET /v2/extra-${i}`,
      schema: { type: "object" as const, properties: { [`field_${i}`]: { type: "string" } } },
      seen_at: new Date(`2026-06-0${(i % 8) + 1}T12:00:00Z`),
    })),
  ]);

  // Tenant B shape — must never surface for tenant A.
  await recordSuccessShape(
    {
      tenant_id: tenantB,
      connector_id: connectorB,
      endpoint_key: "GET /v1/secrets",
      value: { secrets: [{ token: "shape-only" }] },
    },
    ctx.db,
  );
}, 60_000);

afterAll(async () => {
  if (!skip && ctx) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("loadProbeShapeExamples — latest shapes, caps", () => {
  test("returns the LATEST shape per endpoint and caps endpoints per connector", async () => {
    const examples = await loadProbeShapeExamples(tenantA, [connectorA], ctx.db);

    expect(examples.length).toBeGreaterThan(0);
    expect(examples.length).toBeLessThanOrEqual(PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR);

    const droplets = examples.find((e) => e.endpoint_key === "GET /v2/droplets");
    expect(droplets).toBeDefined();
    expect(droplets!.connector_slug).toBe("digitalocean");
    // The 2026-06-10 row wins over the 2026-06-01 row.
    const shape = droplets!.shape as { type: string; properties: Record<string, unknown> };
    expect(Object.keys(shape.properties)).toEqual(["droplets"]);
    expect(shape.properties.old_field).toBeUndefined();
  });

  test("returns [] when no shapes were recorded for the connector", async () => {
    const [bare] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenantA,
        slug: "no-shapes-yet",
        display_name: "No Shapes Yet",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://bare.example",
        config: {},
      })
      .returning();
    const examples = await loadProbeShapeExamples(tenantA, [bare!.id], ctx.db);
    expect(examples).toEqual([]);
  });

  test("non-UUID connector ids (recipe placeholders) are filtered without erroring", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder form draft steps carry.
    const examples = await loadProbeShapeExamples(tenantA, ["${stripe}", "not-a-uuid"], ctx.db);
    expect(examples).toEqual([]);
  });
});

describe.skipIf(skip)("loadProbeShapeExamples — tenant isolation", () => {
  test("tenant B's connector shapes never load for tenant A (cross-tenant leak)", async () => {
    const examples = await loadProbeShapeExamples(tenantA, [connectorB], ctx.db);
    expect(examples).toEqual([]);
  });

  test("mixed id list only yields the caller-tenant's shapes", async () => {
    const examples = await loadProbeShapeExamples(tenantA, [connectorA, connectorB], ctx.db);
    expect(examples.length).toBeGreaterThan(0);
    for (const e of examples) {
      expect(e.connector_slug).toBe("digitalocean");
      expect(e.endpoint_key).not.toBe("GET /v1/secrets");
    }
  });
});

describe("formatProbeShapeExamples / summarizeShape — pure render", () => {
  test("summarizeShape renders a compact field-name summary", () => {
    expect(
      summarizeShape({
        type: "object",
        properties: {
          droplets: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "number" }, name: { type: "string" } },
            },
          },
        },
      }),
    ).toBe("{ droplets: array<{ id: number, name: string }> }");
  });

  test("section renders `<METHOD path>: <shape summary>` grouped by connector slug", () => {
    const section = formatProbeShapeExamples([
      {
        connector_slug: "digitalocean",
        endpoint_key: "GET /v2/droplets",
        shape: {
          type: "object",
          properties: { droplets: { type: "array", items: { type: "unknown" } } },
        },
      },
    ]);
    expect(section).toContain("# Recorded endpoint samples");
    expect(section).toContain("## digitalocean");
    expect(section).toContain("- GET /v2/droplets: { droplets: array<unknown> }");
    // Shared addressing vocabulary with the scope manifest + latest preview.
    expect(section).toContain("addressable as `$scope.<step_id>.data…`");
  });

  test("returns null on empty input", () => {
    expect(formatProbeShapeExamples([])).toBeNull();
  });
});
