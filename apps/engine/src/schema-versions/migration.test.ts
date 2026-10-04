import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  applyMigration,
  diffShapesDeep,
  listShapeHistory,
  proposeSchemaMigration,
  recordSuccessShape,
} from "./service.ts";

let ctx: TestDb;
let tenantId: string;
let connectorId: string;

beforeAll(async () => {
  ctx = await createTestDb("schema_migration");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-mig", display_name: "T mig" })
    .returning();
  tenantId = t!.id;
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "api",
      display_name: "API",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("schema-versions · listShapeHistory", () => {
  test("returns recorded shapes newest-first", async () => {
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: "GET /v1/items",
        value: { id: 1 },
      },
      ctx.db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: "GET /v1/items",
        value: { id: 1, name: "x" },
      },
      ctx.db,
    );
    const history = await listShapeHistory(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: "GET /v1/items" },
      ctx.db,
    );
    expect(history.length).toBe(2);
    const latest = history[0]!;
    expect(latest.schema.type).toBe("object");
  });
});

describe("schema-versions · proposeSchemaMigration", () => {
  test("rename detection: removed key + same-type added key pair as rename", async () => {
    const ek = "GET /v1/users";
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { user_id: 1, name: "x" },
      },
      ctx.db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { id: 1, name: "x" },
      },
      ctx.db,
    );
    const plan = await proposeSchemaMigration(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: ek },
      ctx.db,
    );
    expect(plan).not.toBeNull();
    const renames = plan!.steps.filter((s) => s.kind === "rename");
    expect(renames).toHaveLength(1);
    expect(renames[0]!.from).toBe("user_id");
    expect(renames[0]!.path).toBe("id");
    expect(plan!.fully_safe).toBe(true);
  });

  test("absence alone does not become a removal migration", async () => {
    const ek = "GET /v1/orders";
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { id: 1, deprecated_field: "x" },
      },
      ctx.db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { id: 1 },
      },
      ctx.db,
    );
    const plan = await proposeSchemaMigration(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: ek },
      ctx.db,
    );
    expect(plan!.steps).toEqual([]);
    expect(plan!.fully_safe).toBe(true);
  });

  test("widen detection captures type change", async () => {
    const ek = "GET /v1/products";
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { price: "10.50" },
      },
      ctx.db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { price: 10.5 },
      },
      ctx.db,
    );
    const plan = await proposeSchemaMigration(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: ek },
      ctx.db,
    );
    const widen = plan!.steps.find((s) => s.kind === "widen");
    expect(widen?.path).toBe("price");
    expect(widen?.to_type).toBe("number");
    expect(plan!.fully_safe).toBe(true);
  });

  test("returns null for endpoints with no recorded history", async () => {
    const plan = await proposeSchemaMigration(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: "GET /v1/never-seen",
      },
      ctx.db,
    );
    expect(plan).toBeNull();
  });

  test("name-similarity drives rename pairing over coincidental same-type", async () => {
    const ek = "GET /v1/leads";
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { customer_id: 1, score: 0.9 },
      },
      ctx.db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { id: 1, score: 0.9 },
      },
      ctx.db,
    );
    const plan = await proposeSchemaMigration(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: ek },
      ctx.db,
    );
    const renames = plan!.steps.filter((s) => s.kind === "rename");
    expect(renames).toHaveLength(1);
    expect(renames[0]!.from).toBe("customer_id");
    expect(renames[0]!.path).toBe("id");
  });

  test("deep diff captures nested rename path", async () => {
    const ek = "GET /v1/users-deep";
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { user: { user_id: 1, name: "x" } },
      },
      ctx.db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { user: { id: 1, name: "x" } },
      },
      ctx.db,
    );
    const plan = await proposeSchemaMigration(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: ek },
      ctx.db,
    );
    const rename = plan!.steps.find((s) => s.kind === "rename");
    expect(rename?.from).toBe("user.user_id");
    expect(rename?.path).toBe("user.id");
  });

  test("applyMigration renames, removes, and adds null on a sample", () => {
    const sample = { user_id: 7, score: 0.5, deprecated: "x" };
    const plan = {
      before: {
        type: "object" as const,
        properties: {
          user_id: { type: "number" as const },
          score: { type: "number" as const },
          deprecated: { type: "string" as const },
        },
      },
      after: {
        type: "object" as const,
        properties: {
          id: { type: "number" as const },
          score: { type: "number" as const },
          new_field: { type: "string" as const },
        },
      },
      fully_safe: false,
      steps: [
        { kind: "rename" as const, path: "id", from: "user_id", safe: true },
        { kind: "remove" as const, path: "deprecated", safe: false },
        { kind: "add" as const, path: "new_field", safe: true },
      ],
    };
    const out = applyMigration(plan, sample) as Record<string, unknown>;
    expect(out).toEqual({ id: 7, score: 0.5, new_field: null });
  });

  test("diffShapesDeep walks nested objects and array element shapes", () => {
    const before = {
      type: "object" as const,
      properties: {
        items: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "number" as const },
              old_label: { type: "string" as const },
            },
          },
        },
      },
    };
    const after = {
      type: "object" as const,
      properties: {
        items: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "number" as const },
              label: { type: "string" as const },
            },
          },
        },
      },
    };
    const d = diffShapesDeep(before, after);
    expect(d.added).toEqual(["items[].label"]);
    expect(d.removed).toEqual(["items[].old_label"]);
  });

  test("shape-stable history → empty steps array, fully_safe stays true", async () => {
    const ek = "GET /v1/stable";
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { id: 1, name: "x" },
      },
      ctx.db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: ek,
        value: { id: 2, name: "y" },
      },
      ctx.db,
    );
    const plan = await proposeSchemaMigration(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: ek },
      ctx.db,
    );
    expect(plan!.steps).toEqual([]);
    expect(plan!.fully_safe).toBe(true);
  });
});
