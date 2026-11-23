import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createWorkflow, updateWorkflow } from "../service.ts";

let ctx: TestDb;
let tenant_id: string;
let s3ConnectorId: string;
let bucketlessConnectorId: string;
let httpConnectorId: string;

beforeAll(async () => {
  ctx = await createTestDb("storage_binding_gate");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-storagegate", display_name: "T-STORAGEGATE" })
    .returning();
  tenant_id = t!.id;
  const rows = await ctx.db
    .insert(connectors)
    .values([
      {
        tenant_id,
        slug: "reports-bucket",
        display_name: "Reports bucket",
        driver: "s3",
        config: { region: "eu-central-1", bucket: "tenant-reports" },
      },
      {
        tenant_id,
        slug: "bucketless-s3",
        display_name: "S3 without a bucket",
        driver: "s3",
        config: { region: "eu-central-1" },
      },
      {
        tenant_id,
        slug: "plain-http",
        display_name: "Plain HTTP API",
        driver: "http",
        base_url: "https://api.example.com",
      },
    ])
    .returning();
  s3ConnectorId = rows[0]!.id;
  bucketlessConnectorId = rows[1]!.id;
  httpConnectorId = rows[2]!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function s3Def(slug: string, connector_id: string | undefined): unknown {
  return {
    name: slug,
    slug,
    steps: [
      {
        id: "get_object",
        kind: "request",
        protocol: "s3",
        method: "GET",
        ...(connector_id ? { connector_id } : { url: "https://placeholder.example.com" }),
        s3: { key: "reports/latest.json" },
      },
    ],
  };
}

describe("createWorkflow — s3 storage-binding gate", () => {
  test("a resolvable s3 binding (s3 driver + config.bucket) commits", async () => {
    const res = await createWorkflow(
      { tenant_id, def: s3Def("s3-ok", s3ConnectorId), actor_id: null },
      ctx.db,
    );
    expect("workflow" in res).toBe(true);
  });

  test("an s3 step whose connector does not exist is refused with a typed error", async () => {
    const res = await createWorkflow(
      {
        tenant_id,
        def: s3Def("s3-missing-connector", "3d94a1a2-6f0e-4c58-9b7a-0d1e2f3a4b5c"),
        actor_id: null,
      },
      ctx.db,
    );
    expect("errors" in res).toBe(true);
    const errors = (res as { errors: string[] }).errors;
    expect(errors[0]).toContain("steps.get_object");
    expect(errors[0]).toContain("not found");
  });

  test("an s3 step bound to a non-s3 connector is refused", async () => {
    const res = await createWorkflow(
      { tenant_id, def: s3Def("s3-wrong-driver", httpConnectorId), actor_id: null },
      ctx.db,
    );
    expect("errors" in res).toBe(true);
    const errors = (res as { errors: string[] }).errors;
    expect(errors[0]).toContain('driver "http"');
  });

  test("an s3 connector without config.bucket is refused — the runtime would fail every operation", async () => {
    const res = await createWorkflow(
      { tenant_id, def: s3Def("s3-no-bucket", bucketlessConnectorId), actor_id: null },
      ctx.db,
    );
    expect("errors" in res).toBe(true);
    const errors = (res as { errors: string[] }).errors;
    expect(errors[0]).toContain("config.bucket");
  });

  test("updateWorkflow runs the same gate — a good workflow cannot be updated onto a dangling binding", async () => {
    const created = await createWorkflow(
      { tenant_id, def: s3Def("s3-update-probe", s3ConnectorId), actor_id: null },
      ctx.db,
    );
    expect("workflow" in created).toBe(true);
    const id = (created as { workflow: { id: string } }).workflow.id;
    const res = await updateWorkflow(
      { tenant_id, id, def: s3Def("s3-update-probe", bucketlessConnectorId), actor_id: null },
      ctx.db,
    );
    expect("errors" in res).toBe(true);
    expect((res as { errors: string[] }).errors[0]).toContain("config.bucket");
  });

  test("workflows without s3 blocks are untouched by the gate", async () => {
    const res = await createWorkflow(
      {
        tenant_id,
        def: {
          name: "no-s3",
          slug: "no-s3",
          steps: [
            { id: "t", kind: "transform", language: "javascript", expression: "return input;" },
          ],
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect("workflow" in res).toBe(true);
  });
});
