import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, schemaVersions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { recordSuccessShape } from "../../../schema-versions/service.ts";
import type { SchemaShape } from "../../../self-healing/types.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import {
  fitShapeSummary,
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

  const ta = await seedTenant(ctx.db, { slug: "t-shapes-a", display_name: "Shapes Tenant A" });
  const tb = await seedTenant(ctx.db, { slug: "t-shapes-b", display_name: "Shapes Tenant B" });
  tenantA = ta.id;
  tenantB = tb.id;

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
  test("a probed field survives in a wide response regardless of key order", () => {
    const names = [
      "apparent_temperature_max",
      "apparent_temperature_min",
      "precipitation_sum",
      "rain_sum",
      "showers_sum",
      "snowfall_sum",
      "sunrise",
      "sunset",
      "temperature_2m_max",
      "temperature_2m_min",
      "time",
      "weather_code",
      "wind_speed_10m_max",
    ];
    const series = { type: "array", items: { type: "number" } } as const;
    const daily = {
      type: "object",
      properties: Object.fromEntries(names.map((n) => [n, series])),
    } as const;
    const section = formatProbeShapeExamples([
      {
        connector_slug: "open-meteo",
        endpoint_key: "GET /v1/forecast",
        shape: {
          type: "object",
          properties: {
            daily,
            daily_units: daily,
            elevation: { type: "number" },
            latitude: { type: "number" },
            timezone: { type: "string" },
          },
        },
      },
    ]);
    expect(section).toContain("temperature_2m_min: array<number>");
    expect(section).toContain("wind_speed_10m_max: array<number>");
    expect(section).toContain("timezone: string");
  });

  test("a probed field survives when a wide response exceeds the summary cap", () => {
    const names = Array.from(
      { length: 40 },
      (_, i) => `variable_${String(i).padStart(2, "0")}_long_name`,
    );
    const series = { type: "array", items: { type: "number" } } as const;
    const block = {
      type: "object",
      properties: Object.fromEntries(names.map((n) => [n, series])),
    } as const;
    const shape = {
      type: "object",
      properties: { hourly: block, hourly_units: block, timezone: { type: "string" } },
    } as const;
    expect(summarizeShape(shape).length).toBeGreaterThan(2400);
    const summary = fitShapeSummary(shape, 2400);
    expect(summary.length).toBeLessThanOrEqual(2400);
    expect(summary).toContain("variable_39_long_name");
    expect(summary).toContain("timezone: string");
  });

  test("the section stays within a fixed budget however many wide endpoints were probed", () => {
    const names = Array.from({ length: 48 }, (_, i) => `field_${i}_with_long_name`);
    const shape: SchemaShape = {
      type: "object",
      properties: Object.fromEntries(
        names.map((n) => [
          n,
          { type: "object", properties: { value: { type: "number" }, unit: { type: "string" } } },
        ]),
      ),
    };
    const examples = Array.from({ length: 5 }, (_, c) =>
      Array.from({ length: 4 }, (_, e) => ({
        connector_slug: `conn-${c}`,
        endpoint_key: `GET /route-${e}`,
        shape,
      })),
    ).flat();
    const section = formatProbeShapeExamples(examples) ?? "";
    expect(section.length).toBeLessThanOrEqual(8000 + 1500);
  });

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
    expect(section).toContain("addressable as `$scope.<step_id>.data…`");
  });

  test("returns null on empty input", () => {
    expect(formatProbeShapeExamples([])).toBeNull();
  });
});
